// 情绪与关系状态层单测（src/core/mood.mjs + socialv2-store 的持久化 + 控制台只读端点）。
//
// 验收对应关系：
//   事件→状态变化        → 「被夸」「冷落」「哄」等用例
//   衰减                  → 「半衰期衰减」「重启恢复：持久化的 since 接着衰减」
//   边界值                → 「连续事件钳制」「tension 下界」「脏数据归一化」
//   未知会话默认状态      → 「未知会话」「未知 QQ」「只读端点不创建会话」
//   持久化重启可恢复      → 「serialize → hydrate」
//   控制台能查到状态与来源 → 「控制台只读端点」
//
// 全部用假时钟，不依赖真实时间，跑起来是毫秒级。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMoodLayer,
  decayMood,
  normalizeMood,
  normalizeRelationship,
  normalizeRelationships,
  canonicalUid,
  EMOTION_EVENTS,
  RELATIONSHIP_EVENTS,
  MOOD_BASELINE,
  DEFAULT_DECAY_HALF_LIFE_MS,
  DEFAULT_INTIMACY,
  MAX_MOOD_EVENTS,
  MAX_RELATIONSHIP_EVENTS,
  MAX_RELATIONSHIP_UIDS,
} from '../src/core/mood.mjs';
import {
  canonicalV2Key,
  createConversationStateV2,
  hydrateConversationStateV2,
  serializeSocialV2,
  PERSISTED_FIELDS,
} from '../src/core/socialv2-store.mjs';
import { handleSocialV2StateApi } from '../src/routes/socialv2-state-api.mjs';

const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** 造一个假世界：内存 conversations Map + 可推进的时钟 + 落盘计数。 */
function makeWorld() {
  const conversations = new Map();
  let clock = T0;
  const saves = [];
  const getState = (key) => {
    const k = canonicalV2Key(key);
    if (!k) throw new Error(`非法 key：${key}`);
    let st = conversations.get(k);
    if (!st) {
      st = createConversationStateV2({ cfg: {}, token: `tok-${k}` });
      conversations.set(k, st);
    }
    return st;
  };
  const layer = createMoodLayer({
    getState,
    peekState: (k) => conversations.get(k) ?? null,
    conversations,
    save: () => saves.push(clock),
    now: () => clock,
  });
  return {
    conversations,
    layer,
    getState,
    saves,
    tick(ms) { clock += ms; return clock; },
    now() { return clock; },
  };
}

/** 把某一刻的会话状态序列化再 hydrate，模拟「重启」。 */
function reboot(conversations) {
  const saved = serializeSocialV2({ paused: false, conversations, seenForwardIds: new Map() });
  const rebuilt = new Map();
  for (const [key, val] of Object.entries(saved.conversations)) {
    rebuilt.set(key, hydrateConversationStateV2({ key, val, cfg: {}, token: `tok-${key}` }));
  }
  return rebuilt;
}

/** 在重启后的内存里重新造一个层（时钟可推进到任意时刻）。 */
function layerOver(conversations, clock) {
  return createMoodLayer({
    peekState: (k) => conversations.get(k) ?? null,
    conversations,
    now: () => clock,
  });
}

// ── 情绪：默认值与事件 ────────────────────────────────────────────────────

test('未知会话：返回默认中性状态，且只读查询不创建会话', () => {
  const w = makeWorld();
  const m = w.layer.getMood('private:123456');
  assert.equal(m.valid, true);
  assert.equal(m.known, false);
  assert.equal(m.valence, MOOD_BASELINE.valence);
  assert.equal(m.arousal, MOOD_BASELINE.arousal);
  assert.equal(m.energy, MOOD_BASELINE.energy);
  assert.equal(m.cause, '');
  assert.equal(m.causeType, '');
  assert.equal(m.since, 0);
  assert.deepEqual(m.events, []);
  assert.equal(w.conversations.size, 0, '只读查询不能凭空创建会话');
});

test('非法 key / uid：valid:false，写操作被拒绝且不落盘', () => {
  const w = makeWorld();
  const bad = w.layer.getMood('user:1');
  assert.equal(bad.valid, false);
  assert.equal(bad.known, false);
  assert.equal(w.layer.applyEmotionEvent('user:1', { type: 'praised' }).ok, false);
  assert.equal(w.layer.applyEmotionEvent('private:0', { type: 'praised' }).ok, false);
  assert.equal(w.layer.getRelationship('abc').valid, false);
  assert.equal(w.layer.applyRelationshipEvent('abc', { type: 'ignored' }).ok, false);
  assert.equal(w.conversations.size, 0);
  assert.equal(w.saves.length, 0);

  // 显式传了非法 key 时必须报错，而不是悄悄改写到私聊
  const res = w.layer.applyRelationshipEvent('12345', { type: 'ignored', key: 'user:9' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid_key');
});

test('显式非法 uid：拒绝而不是静默退化成「无调制」（审查 P2-1）', () => {
  const w = makeWorld();
  // 群聊里已有张力
  w.layer.applyRelationshipEvent('88888', { type: 'quarrel', key: 'group:1' });
  const before = w.layer.getMood('group:1');
  const savesBefore = w.saves.length;

  const res = w.layer.applyEmotionEvent('group:1', { type: 'praised', uid: 'not-a-qq' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid_uid');
  assert.deepEqual(w.layer.getMood('group:1').raw, before.raw, '拒绝时不能写状态');
  assert.equal(w.saves.length, savesBefore);

  // 不传 uid 的群聊事件仍然允许（只是没有关系调制）
  const ok = w.layer.applyEmotionEvent('group:1', { type: 'praised' });
  assert.equal(ok.ok, true);
});

test('被夸：情绪上升，状态可追溯到来源事件（cause / causeType / since）', () => {
  const w = makeWorld();
  const res = w.layer.applyEmotionEvent('private:10001', {
    type: 'praised',
    cause: '群友说「你今天好温柔」',
  });
  assert.equal(res.ok, true);
  assert.equal(res.type, 'praised');
  assert.equal(res.at, T0);

  const m = w.layer.getMood('private:10001');
  assert.equal(m.known, true);
  assert.ok(m.valence > 0, '被夸后愉悦度应上升');
  assert.ok(m.arousal > MOOD_BASELINE.arousal, '唤醒度应上升');
  assert.equal(m.cause, '群友说「你今天好温柔」');
  assert.equal(m.causeType, 'praised');
  assert.equal(m.since, T0);
  assert.equal(m.events.length, 1);
  assert.equal(m.events[0].type, 'praised');
  assert.equal(m.events[0].at, T0);
  assert.ok(m.events[0].deltas.valence > 0);
  assert.equal(w.saves.length, 1, '写事件后应触发落盘');
});

test('未知事件类型：明确拒绝，状态一个字节都不变（不随机贴标签）', () => {
  const w = makeWorld();
  w.layer.applyEmotionEvent('group:9', { type: 'praised', cause: '好人' });
  const before = w.layer.getMood('group:9');
  const beforeSaveCount = w.saves.length;

  for (const type of ['突然开心', 'happy', '', null, undefined]) {
    const res = w.layer.applyEmotionEvent('group:9', { type, cause: '随机' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'unknown_event_type');
  }
  const after = w.layer.getMood('group:9');
  assert.deepEqual(after.raw, before.raw);
  assert.equal(after.cause, before.cause);
  assert.equal(after.events.length, before.events.length);
  assert.equal(w.saves.length, beforeSaveCount, '被拒绝的事件不应落盘');

  // 关系事件同理
  assert.equal(w.layer.applyRelationshipEvent('10001', { type: '想他了' }).ok, false);
});

test('事件表自检：每个已知情绪事件都能改变状态，且都有中文标签', () => {
  for (const [type, def] of Object.entries(EMOTION_EVENTS)) {
    assert.ok(def.label, `${type} 缺少可读标签`);
    const w = makeWorld();
    const res = w.layer.applyEmotionEvent('private:1', { type });
    assert.equal(res.ok, true, `${type} 应被接受`);
    const m = w.layer.getMood('private:1');
    assert.notEqual(m.causeType, '', 'causeType 必须写明是哪种事件');
    assert.equal(m.cause, def.label, '没传 cause 时用事件标签兜底，保证可追溯');
  }
  // 关系事件表也要覆盖情绪表的每一个 type（表达层可以用同一个事件同时喂两边）
  for (const type of Object.keys(EMOTION_EVENTS)) {
    assert.ok(RELATIONSHIP_EVENTS[type], `情绪事件 ${type} 在关系事件表里缺失`);
  }
});

// ── 情绪：衰减与边界 ──────────────────────────────────────────────────────

test('半衰期衰减：过 n 个半衰期，偏离量变为 1/2^n', () => {
  const w = makeWorld();
  w.layer.applyEmotionEvent('private:1', { type: 'praised' });
  const v0 = w.layer.getMood('private:1').valence;
  const a0 = w.layer.getMood('private:1').arousal;
  assert.ok(v0 > 0);

  w.tick(DEFAULT_DECAY_HALF_LIFE_MS);
  const m1 = w.layer.getMood('private:1');
  assert.ok(Math.abs(m1.valence - v0 / 2) < 1e-9, `一个半衰期后应为一半，实际 ${m1.valence}`);
  assert.equal(m1.ageMs, DEFAULT_DECAY_HALF_LIFE_MS);
  // arousal 向基线回落（事件把 arousal 抬到基线之上）
  assert.ok(m1.arousal < a0 && m1.arousal > MOOD_BASELINE.arousal);

  w.tick(DEFAULT_DECAY_HALF_LIFE_MS);
  const m2 = w.layer.getMood('private:1');
  assert.ok(Math.abs(m2.valence - v0 / 4) < 1e-9, `两个半衰期后应为四分之一，实际 ${m2.valence}`);
});

test('衰减不写状态：重复读取不会改变原始值（只读端点刷新多少次都一样）', () => {
  const w = makeWorld();
  w.layer.applyEmotionEvent('private:1', { type: 'praised' });
  const rawBefore = { ...w.layer.getMood('private:1').raw };
  w.tick(3 * HOUR);
  const a = w.layer.getMood('private:1');
  const b = w.layer.getMood('private:1');
  assert.deepEqual(a.raw, rawBefore);
  assert.deepEqual(b.raw, rawBefore);
  assert.equal(a.valence, b.valence);
  assert.equal(w.saves.length, 1, '读取不应触发落盘');
});

test('事件叠加：先把旧值衰减到事件时刻再叠加，不重复计算旧状态', () => {
  const w = makeWorld();
  w.layer.applyEmotionEvent('private:1', { type: 'praised' });
  const v0 = w.layer.getMood('private:1').valence;
  w.tick(DEFAULT_DECAY_HALF_LIFE_MS);
  w.layer.applyEmotionEvent('private:1', { type: 'praised' });
  const expected = v0 / 2 + EMOTION_EVENTS.praised.valence;
  const m = w.layer.getMood('private:1');
  assert.ok(Math.abs(m.valence - expected) < 1e-9, `期望 ${expected}，实际 ${m.valence}`);
  assert.equal(m.since, T0 + DEFAULT_DECAY_HALF_LIFE_MS);
  assert.equal(m.events.length, 2);
});

test('边界值：连续同向事件都钳在 [-1,1] / [0,1]', () => {
  const w = makeWorld();
  for (let i = 0; i < 12; i += 1) w.layer.applyEmotionEvent('private:2', { type: 'praised' });
  const max = w.layer.getMood('private:2');
  assert.equal(max.valence, 1, '愉悦度上界是 1');
  assert.ok(max.arousal <= 1 && max.energy <= 1);

  for (let i = 0; i < 25; i += 1) w.layer.applyEmotionEvent('private:2', { type: 'quarrel' });
  const min = w.layer.getMood('private:2');
  assert.equal(min.valence, -1, '愉悦度下界是 -1');
  assert.ok(min.arousal >= 0, '唤醒度下界是 0');
  assert.ok(min.energy >= 0, '精力下界是 0');
});

test('历史事件晚到：拒绝 stale_event，不污染当前状态（审查 P1-1）', () => {
  const w = makeWorld();
  w.layer.applyEmotionEvent('private:1', { type: 'praised', at: T0 });
  w.tick(DEFAULT_DECAY_HALF_LIFE_MS);
  w.layer.applyEmotionEvent('private:1', { type: 'praised', at: T0 + DEFAULT_DECAY_HALF_LIFE_MS });
  const before = w.layer.getMood('private:1');
  const savesBefore = w.saves.length;

  // 补报一条 T0 的冷落：应被拒绝，当前状态一个字节都不变
  const res = w.layer.applyEmotionEvent('private:1', { type: 'ignored', at: T0 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'stale_event');
  const after = w.layer.getMood('private:1');
  assert.deepEqual(after.raw, before.raw);
  assert.equal(after.cause, before.cause);
  assert.equal(after.since, before.since);
  assert.equal(after.events.length, before.events.length);
  assert.equal(w.saves.length, savesBefore, '被拒绝的历史事件不应落盘');

  // 同一时刻（at === since）是允许的，不算晚到
  const same = w.layer.applyEmotionEvent('private:1', { type: 'thanked', at: before.since });
  assert.equal(same.ok, true);
});

test('关系历史事件晚到：不让旧争吵覆盖后来的和好（审查 P1-1）', () => {
  const w = makeWorld();
  w.layer.applyRelationshipEvent('123', { type: 'quarrel', at: T0 });
  w.tick(1000);
  w.layer.applyRelationshipEvent('123', { type: 'makeup', at: T0 + 1000 });
  const before = w.layer.getRelationship('123');
  assert.equal(before.tension, 0);

  const res = w.layer.applyRelationshipEvent('123', { type: 'quarrel', at: T0 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'stale_event');
  const after = w.layer.getRelationship('123');
  assert.equal(after.tension, before.tension, '旧争吵不能覆盖后来的和好');
  assert.equal(after.events.length, before.events.length);
});

test('事件时刻在未来：钳到 now，不会让衰减倒退', () => {
  const w = makeWorld();
  w.layer.applyEmotionEvent('private:3', { type: 'praised', at: T0 + 10 * 24 * HOUR });
  const m = w.layer.getMood('private:3');
  assert.equal(m.since, T0);
  assert.equal(m.events[0].at, T0);
});

test('decayMood：没有事件时返回基线，半衰期非法时不衰减', () => {
  const untouched = decayMood(normalizeMood(null), T0 + 5 * HOUR);
  assert.equal(untouched.valence, 0);
  assert.equal(untouched.ageMs, 0);
  // 半衰期 0/负数会被归一化成默认值，而不是让衰减停摆或爆炸
  const m = normalizeMood({ valence: 0.8, since: T0, decayHalfLifeMs: 0 });
  assert.equal(m.decayHalfLifeMs, DEFAULT_DECAY_HALF_LIFE_MS);
  assert.ok(decayMood(m, T0).valence === 0.8);

  // 非法时刻不能把情绪翻到极端值（审查 P2-3）：回落成当前时刻，age 有限
  const extreme = decayMood(m, Number.NaN);
  assert.ok(Number.isFinite(extreme.ageMs), 'NaN 时刻不能让 ageMs 变 NaN');
  assert.ok(extreme.valence >= 0 && extreme.valence <= 1, `NaN 时刻不应把 valence 翻成 -1，实际 ${extreme.valence}`);
  const infinite = decayMood(m, Number.POSITIVE_INFINITY);
  assert.ok(Number.isFinite(infinite.ageMs));
  assert.ok(infinite.valence >= 0 && infinite.valence <= 1);
});

// ── 关系：事件与聚合 ──────────────────────────────────────────────────────

test('未知 QQ：默认关系状态（生疏、无张力、没有未了结的事），不创建会话', () => {
  const w = makeWorld();
  const r = w.layer.getRelationship('20002');
  assert.equal(r.valid, true);
  assert.equal(r.known, false);
  assert.equal(r.intimacy, DEFAULT_INTIMACY);
  assert.equal(r.tension, 0);
  assert.equal(r.lastInteraction, 0);
  assert.deepEqual(r.openLoops, []);
  assert.deepEqual(r.events, []);
  assert.equal(w.conversations.size, 0);
});

test('冷落：tension 上升、intimacy 下降、记录来源事件（默认落在私聊）', () => {
  const w = makeWorld();
  const res = w.layer.applyRelationshipEvent('30003', {
    type: 'ignored',
    cause: '他三个小时没回我',
  });
  assert.equal(res.ok, true);
  assert.equal(res.key, 'private:30003', '不传 key 时默认落到这个人的私聊');

  const r = w.layer.getRelationship('30003');
  assert.equal(r.known, true);
  assert.ok(r.tension > 0, '被冷落应增加张力');
  assert.ok(r.intimacy < DEFAULT_INTIMACY, '被冷落应降低亲密');
  assert.equal(r.lastInteraction, T0);
  assert.equal(r.sources.length, 1);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, 'ignored');
  assert.equal(r.events[0].cause, '他三个小时没回我');
  assert.equal(r.events[0].key, 'private:30003');
});

test('哄 / 和好：tension 下降，且不会降到负数（边界）', () => {
  const w = makeWorld();
  w.layer.applyRelationshipEvent('30003', { type: 'quarrel' });
  const t1 = w.layer.getRelationship('30003').tension;
  assert.ok(t1 > 0);

  w.layer.applyRelationshipEvent('30003', { type: 'comforted', cause: '他哄了我半天' });
  const t2 = w.layer.getRelationship('30003').tension;
  assert.ok(t2 < t1, '被哄应降低张力');

  w.layer.applyRelationshipEvent('30003', { type: 'makeup' });
  w.layer.applyRelationshipEvent('30003', { type: 'makeup' });
  assert.equal(w.layer.getRelationship('30003').tension, 0, 'tension 下界是 0');

  // intimacy 上界是 1
  for (let i = 0; i < 100; i += 1) w.layer.applyRelationshipEvent('30003', { type: 'praised' });
  assert.equal(w.layer.getRelationship('30003').intimacy, 1);
});

test('关系 → 情绪：tension 高时正面事件被削弱、负面事件被放大', () => {
  const w = makeWorld();
  // 对照：无张力的会话
  w.layer.applyEmotionEvent('private:41000', { type: 'praised' });
  const calm = w.layer.getMood('private:41000').valence;

  // 有张力：先争吵把 tension 拉起来，同一会话再被夸
  w.layer.applyRelationshipEvent('42000', { type: 'quarrel' });
  assert.ok(w.layer.getRelationship('42000').tension > 0);
  w.layer.applyEmotionEvent('private:42000', { type: 'praised' });
  const tense = w.layer.getMood('private:42000').valence;
  assert.ok(tense < calm, `紧张时被夸的愉悦应更小：calm=${calm} tense=${tense}`);

  // 负面事件同理被放大
  w.layer.applyEmotionEvent('private:43000', { type: 'ignored' });
  const calmNeg = w.layer.getMood('private:43000').valence;
  w.layer.applyRelationshipEvent('44000', { type: 'quarrel' });
  w.layer.applyEmotionEvent('private:44000', { type: 'ignored' });
  const tenseNeg = w.layer.getMood('private:44000').valence;
  assert.ok(tenseNeg < calmNeg, `紧张时被冷落应更难受：calm=${calmNeg} tense=${tenseNeg}`);
});

test('情绪 → 关系：心情越差，同样的事让 tension 涨得越多', () => {
  const w = makeWorld();
  // 中性心情
  w.layer.applyRelationshipEvent('50001', { type: 'ignored' });
  const neutral = w.layer.getRelationship('50001').tension;
  // 心情很糟（先争吵，valence 负）再被冷落
  w.layer.applyEmotionEvent('private:50002', { type: 'quarrel' });
  assert.ok(w.layer.getMood('private:50002').valence < 0);
  w.layer.applyRelationshipEvent('50002', { type: 'ignored' });
  const upset = w.layer.getRelationship('50002').tension;
  assert.ok(upset > neutral, `心情差时被冷落应更紧张：neutral=${neutral} upset=${upset}`);
});

test('群聊情绪事件：显式传 uid 才读该成员的关系张力', () => {
  const w = makeWorld();
  w.layer.applyRelationshipEvent('88888', { type: 'quarrel', key: 'group:1' });
  assert.ok(w.layer.getRelationship('88888').tension > 0);

  w.layer.applyEmotionEvent('group:1', { type: 'praised', uid: '88888' });
  const withUid = w.layer.getMood('group:1').valence;
  w.layer.applyEmotionEvent('group:2', { type: 'praised' });
  const noUid = w.layer.getMood('group:2').valence;
  assert.ok(withUid < noUid, '群聊事件带 uid 时应被该成员的关系张力调制');

  // 关系主记录在私聊（单主记录）、情绪事件发生在群里：调制也必须生效（用聚合张力）
  w.layer.applyRelationshipEvent('99999', { type: 'quarrel' });
  w.tick(1000);
  w.layer.applyEmotionEvent('group:3', { type: 'praised', uid: '99999' });
  const crossSession = w.layer.getMood('group:3').valence;
  w.layer.applyEmotionEvent('group:4', { type: 'praised' });
  const plain = w.layer.getMood('group:4').valence;
  assert.ok(crossSession < plain, '主记录在私聊时，群聊事件也要按聚合张力调制');
});

test('openLoops：记下未了结的事、了结、同一件事不重复添加', () => {
  const w = makeWorld();
  w.layer.applyRelationshipEvent('60001', { type: 'openLoop', cause: '答应给他唱歌' });
  w.layer.applyRelationshipEvent('60001', { type: 'openLoop', cause: '答应给他唱歌' });
  const r1 = w.layer.getRelationship('60001');
  assert.equal(r1.openLoops.length, 1, '同一件事不重复开');
  assert.equal(r1.openLoops[0].text, '答应给他唱歌');
  assert.equal(r1.openLoops[0].openedAt, T0);

  w.layer.applyRelationshipEvent('60001', { type: 'closeLoop', cause: '答应给他唱歌' });
  assert.equal(w.layer.getRelationship('60001').openLoops.length, 0, '按文字了结');

  w.layer.applyRelationshipEvent('60001', { type: 'openLoop', text: '欠他一张图', id: 'loop-1' });
  const r2 = w.layer.getRelationship('60001');
  assert.equal(r2.openLoops.length, 1);
  assert.equal(r2.openLoops[0].id, 'loop-1');
  w.layer.applyRelationshipEvent('60001', { type: 'closeLoop', loopId: 'loop-1' });
  assert.equal(w.layer.getRelationship('60001').openLoops.length, 0, '按 id 了结');
});

test('关系单主记录：群聊互动不会覆盖私聊累计的 intimacy（审查 P1-2）', () => {
  const w = makeWorld();
  // 私聊里多次正反馈，intimacy 累积到高值
  for (let i = 0; i < 20; i += 1) w.layer.applyRelationshipEvent('70001', { type: 'praised' });
  const before = w.layer.getRelationship('70001');
  assert.ok(before.intimacy > 0.8, `私聊累计 intimacy 应很高，实际 ${before.intimacy}`);

  w.tick(1000);
  w.layer.applyRelationshipEvent('70001', { type: 'interaction', key: 'group:88' });

  const after = w.layer.getRelationship('70001');
  assert.ok(after.intimacy >= before.intimacy, `群聊互动不能让亲密倒退：${before.intimacy} → ${after.intimacy}`);
  assert.equal(after.sources.length, 1, '每个 uid 只有一份逻辑主记录');
  assert.equal(after.sources[0], 'private:70001', '主记录留在首次记录的会话（私聊）');
  assert.equal(w.conversations.get('group:88')?.relationships?.['70001'], undefined, '群聊会话里不应再建第二份');
});

test('主记录位置：私聊会话已存在时，群聊事件也写进私聊（reset 群不丢关系）', () => {
  const w = makeWorld();
  w.getState('private:74000'); // 私聊会话存在（比如聊过天）
  w.layer.applyRelationshipEvent('74000', { type: 'praised', key: 'group:74' });
  assert.deepEqual(w.layer.getRelationship('74000').sources, ['private:74000']);
  assert.equal(w.conversations.get('group:74')?.relationships?.['74000'], undefined, '群会话里不建第二份');
  // 来源 key 仍保留群聊语境，便于追溯
  assert.equal(w.layer.getRelationship('74000').events[0].key, 'group:74');
});

test('旧多分片兼容：读取时 intimacy 取最高累计、tension 取最高', () => {
  const w = makeWorld();
  // 模拟升级前的数据：私聊一份、群聊一份
  const privateSt = w.getState('private:71000');
  const groupSt = w.getState('group:71');
  privateSt.relationships = {
    71000: { intimacy: 0.9, tension: 0.1, lastInteraction: T0, openLoops: [], events: [] },
  };
  groupSt.relationships = {
    71000: {
      intimacy: 0.4,
      tension: 0.5,
      lastInteraction: T0 + 1000,
      openLoops: [{ id: 'loop-g', text: '群里答应的事', openedAt: T0 + 1000 }],
      events: [],
    },
  };
  const agg = w.layer.getRelationship('71000');
  assert.deepEqual([...agg.sources].sort(), ['group:71', 'private:71000']);
  assert.equal(agg.tension, 0.5, 'tension 取所有场合最高');
  assert.equal(agg.intimacy, 0.9, 'intimacy 取最高累计，不被较新的低值分片压住（审查 P2-1）');
  assert.equal(agg.openLoops.length, 1);

  // 首次新事件把旧多分片真正合并成一份主记录
  w.tick(2000);
  const closed = w.layer.applyRelationshipEvent('71000', { type: 'closeLoop', loopId: 'loop-g' });
  assert.equal(closed.ok, true);
  const merged = w.layer.getRelationship('71000');
  assert.equal(merged.openLoops.length, 0);
  assert.equal(merged.sources.length, 1, '合并后只剩一份主记录');
  assert.ok(merged.intimacy >= 0.9, '高累计值进入主记录');
  assert.equal(w.layer.getRelationship('71000').tension, 0.47, '合并后 tension 0.5，再应用 closeLoop 的 -0.03');
});

test('旧多分片在首次新事件时收敛成一份（审查 P2-1）', () => {
  const w = makeWorld();
  const privateSt = w.getState('private:75000');
  const groupSt = w.getState('group:75');
  privateSt.relationships = {
    75000: {
      intimacy: 0.9,
      tension: 0.1,
      lastInteraction: T0,
      openLoops: [{ id: 'l1', text: '旧约定', openedAt: T0 }],
      events: [{ at: T0, type: 'praised', cause: '旧事', key: 'private:75000', deltas: { intimacy: 0.03, tension: 0 } }],
    },
  };
  groupSt.relationships = {
    75000: {
      intimacy: 0.4,
      tension: 0.5,
      lastInteraction: T0 + 1000,
      openLoops: [{ id: 'l2', text: '群约定', openedAt: T0 + 1000 }],
      events: [],
    },
  };
  w.tick(2000);
  const res = w.layer.applyRelationshipEvent('75000', { type: 'interaction' });
  assert.equal(res.ok, true);
  const agg = w.layer.getRelationship('75000');
  assert.equal(agg.sources.length, 1, '首次新事件后只剩一份主记录');
  assert.ok(agg.intimacy >= 0.9, '高累计值进入主记录并继续累加');
  assert.equal(agg.tension, 0.499, 'tension 取最高后再应用 interaction 的 -0.001');
  assert.equal(agg.openLoops.length, 2, 'openLoops 按 id 合并');
  // 旧分片被真正删除，不是只读时虚拟合并
  const remaining = [...w.conversations.entries()]
    .filter(([, st]) => st.relationships && st.relationships['75000'])
    .map(([key]) => key);
  assert.deepEqual(remaining, ['group:75'], '只保留主记录所在的会话');
});

test('closeLoop 未命中：返回 loop_not_found，且不奖励关系（审查 P1-4）', () => {
  const w = makeWorld();
  w.layer.applyRelationshipEvent('72000', { type: 'quarrel' });
  w.layer.applyRelationshipEvent('72000', { type: 'openLoop', text: '真正存在的约定' });
  const before = w.layer.getRelationship('72000');
  const savesBefore = w.saves.length;

  for (let i = 0; i < 10; i += 1) {
    const res = w.layer.applyRelationshipEvent('72000', { type: 'closeLoop', text: '并不存在的约定' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'loop_not_found');
  }
  const after = w.layer.getRelationship('72000');
  assert.equal(after.intimacy, before.intimacy, '未命中不能提高亲密');
  assert.equal(after.tension, before.tension, '未命中不能降低张力');
  assert.equal(after.openLoops.length, before.openLoops.length);
  assert.equal(w.saves.length, savesBefore, '未命中不应落盘');

  // 只有真正关掉才应用增量
  const closed = w.layer.applyRelationshipEvent('72000', { type: 'closeLoop', text: '真正存在的约定' });
  assert.equal(closed.ok, true);
  assert.ok(w.layer.getRelationship('72000').tension < after.tension);
});

// ── 持久化：serialize / hydrate ───────────────────────────────────────────

test('持久化：情绪、关系、来源事件都能 round-trip，且新增字段在白名单里', () => {
  assert.ok(PERSISTED_FIELDS.includes('mood'), 'mood 必须在落盘白名单里');
  assert.ok(PERSISTED_FIELDS.includes('relationships'), 'relationships 必须在落盘白名单里');

  const w = makeWorld();
  w.layer.applyEmotionEvent('private:80001', { type: 'praised', cause: '他说我可爱' });
  w.layer.applyRelationshipEvent('80001', { type: 'openLoop', cause: '欠他一张图' });

  const saved = serializeSocialV2({ paused: false, conversations: w.conversations, seenForwardIds: new Map() });
  const val = saved.conversations['private:80001'];
  assert.equal(val.mood.cause, '他说我可爱');
  assert.ok(val.mood.valence > 0);
  assert.equal(val.mood.events.length, 1);
  assert.equal(val.relationships['80001'].openLoops.length, 1);

  const rebuilt = reboot(w.conversations).get('private:80001');
  assert.equal(rebuilt.mood.cause, '他说我可爱');
  assert.equal(rebuilt.mood.causeType, 'praised');
  assert.equal(rebuilt.mood.since, T0);
  assert.equal(rebuilt.mood.events.length, 1);
  assert.equal(rebuilt.mood.valence, val.mood.valence);
  assert.equal(rebuilt.relationships['80001'].openLoops[0].text, '欠他一张图');
});

test('重启恢复：持久化的 since 让衰减接着走（不是从头开始）', () => {
  const w = makeWorld();
  w.layer.applyEmotionEvent('private:80002', { type: 'praised' });
  const v0 = w.layer.getMood('private:80002').valence;

  const rebuilt = reboot(w.conversations);
  const later = T0 + DEFAULT_DECAY_HALF_LIFE_MS;
  const layer2 = layerOver(rebuilt, later);
  const m = layer2.getMood('private:80002');
  assert.ok(Math.abs(m.valence - v0 / 2) < 1e-9, `重启后应继续衰减到一半，实际 ${m.valence}`);
  assert.equal(m.ageMs, DEFAULT_DECAY_HALF_LIFE_MS);
  // 来源事件也还在，控制台重启后仍能看懂「为什么是这个情绪」
  assert.equal(m.events[0].type, 'praised');
  assert.equal(m.events[0].cause, '被夸');
});

test('旧数据兼容：没有 mood / relationships 字段的会话能正常加载成默认状态', () => {
  const st = hydrateConversationStateV2({ key: 'group:5', val: { recentMessages: [] }, cfg: {}, token: 't' });
  assert.equal(st.mood.valence, 0);
  assert.equal(st.mood.decayHalfLifeMs, DEFAULT_DECAY_HALF_LIFE_MS);
  assert.deepEqual(st.relationships, {});
});

test('上限：事件有界、关系表有人数上限，不会无限膨胀', () => {
  const w = makeWorld();
  for (let i = 0; i < 40; i += 1) {
    w.tick(1000);
    w.layer.applyEmotionEvent('private:90001', { type: 'praised', cause: `第 ${i} 次` });
  }
  assert.equal(w.layer.getMood('private:90001').events.length, MAX_MOOD_EVENTS);
  const saved = serializeSocialV2({ paused: false, conversations: w.conversations, seenForwardIds: new Map() });
  assert.equal(saved.conversations['private:90001'].mood.events.length, MAX_MOOD_EVENTS);

  // 同一个群里 60 个人 → 只保留最近互动的 50 个
  for (let i = 0; i < 60; i += 1) {
    w.tick(1000);
    w.layer.applyRelationshipEvent(String(200000 + i), { type: 'interaction', key: 'group:99' });
  }
  assert.equal(Object.keys(w.conversations.get('group:99').relationships).length, MAX_RELATIONSHIP_UIDS);
  // 最近互动的那个一定还在
  assert.ok(w.layer.getRelationship(String(200000 + 59)).known);
  // 最早被淘汰的 uid：known:false；再次互动会从默认值重建（审查 r5 P2 的产品契约）
  assert.equal(w.layer.getRelationship(String(200000)).known, false, '最早的 uid 被淘汰');
  w.tick(1000);
  w.layer.applyRelationshipEvent(String(200000), { type: 'interaction', key: 'group:99' });
  assert.ok(w.layer.getRelationship(String(200000)).known, '再次互动会重建关系记录');
});

test('脏数据归一化：越界值钳制、非法事件丢弃、原型污染键被过滤', () => {
  const w = makeWorld();
  const st = w.getState('group:66');
  st.mood = {
    valence: 99,
    arousal: -5,
    energy: 'not-a-number',
    since: -3,
    decayHalfLifeMs: 0,
    events: [null, { at: -1, type: 'praised' }, { at: T0, type: 'praised', cause: '', deltas: { valence: 'x' } }],
  };
  st.relationships = {
    __proto__: { polluted: true }, // 字面量里 __proto__ 会改原型；normalize 时也要防解析出来的同类键
    constructor: { intimacy: 1 },
    55555: {
      intimacy: 9,
      tension: -1,
      lastInteraction: -1,
      openLoops: [null, { text: '' }, { text: 'ok' }],
      events: [],
    },
    notAQQ: { intimacy: 1 },
  };

  const m = w.layer.getMood('group:66');
  assert.equal(m.valence, 1, '越界 valence 钳到 1');
  assert.equal(m.arousal, 0, '负数 arousal 钳到 0');
  assert.equal(m.energy, MOOD_BASELINE.energy, '非法 energy 回落到基线');
  assert.equal(m.since, 0, '负时间戳归一化成 0');
  assert.equal(m.decayHalfLifeMs, DEFAULT_DECAY_HALF_LIFE_MS);
  assert.equal(m.events.length, 1, '没有时刻的事件被丢弃');
  assert.equal(m.events[0].cause, '被夸', '空 cause 用事件标签兜底');

  const r = w.layer.getRelationship('55555');
  assert.equal(r.intimacy, 1);
  assert.equal(r.tension, 0);
  assert.equal(r.openLoops.length, 1, '空文本的未了结事被丢弃');
  assert.equal(r.openLoops[0].text, 'ok');

  assert.equal(w.layer.getRelationship('notAQQ').valid, false);
  assert.equal(Object.prototype.polluted, undefined, '不能污染全局原型');

  // normalizeRelationships 直接吃 JSON.parse 出来的 __proto__ 键也不报错
  const parsed = JSON.parse('{"__proto__":{"x":1},"123":{"intimacy":0.5}}');
  const clean = normalizeRelationships(parsed);
  assert.deepEqual(Object.keys(clean), ['123']);
  assert.equal(clean['123'].intimacy, 0.5);
});

test('normalizeRelationship：缺字段补默认、非法值钳制', () => {
  const r = normalizeRelationship({ intimacy: 1.5, tension: -2, lastInteraction: 12, openLoops: 'x' });
  assert.equal(r.intimacy, 1);
  assert.equal(r.tension, 0);
  assert.equal(r.lastInteraction, 12);
  assert.deepEqual(r.openLoops, []);
  assert.deepEqual(normalizeRelationship(null), {
    intimacy: DEFAULT_INTIMACY,
    tension: 0,
    lastInteraction: 0,
    openLoops: [],
    events: [],
  });
  assert.equal(canonicalUid('0012'), '12');
  assert.equal(canonicalUid(0), null);
});

test('关系事件上限：只保留最近 MAX_RELATIONSHIP_EVENTS(12) 条', () => {
  const w = makeWorld();
  for (let i = 0; i < 20; i += 1) {
    w.tick(1000);
    w.layer.applyRelationshipEvent('73000', { type: 'interaction', cause: `第 ${i} 次` });
  }
  const events = w.layer.getRelationship('73000').events;
  assert.equal(events.length, MAX_RELATIONSHIP_EVENTS);
  assert.equal(MAX_RELATIONSHIP_EVENTS, 12);
  // 关系事件按时间倒序（最新在前）；20 次里只保留最近 12 次
  assert.equal(events[0].cause, '第 19 次', '最新一条在最前');
  assert.equal(events[events.length - 1].cause, '第 8 次', '最旧一条是第 8 次，更早的被裁掉');
  const saved = serializeSocialV2({ paused: false, conversations: w.conversations, seenForwardIds: new Map() });
  assert.equal(saved.conversations['private:73000'].relationships['73000'].events.length, MAX_RELATIONSHIP_EVENTS);
});

// ── 控制台只读端点 ────────────────────────────────────────────────────────

function fakeApi(w, { headers = {}, socialV2 = null } = {}) {
  const responses = [];
  const deps = {
    getSocialV2State: (key) => w.getState(key),
    socialV2: socialV2 ?? { conversations: w.conversations, paused: false, lastSaveError: null },
    sendJson: (body, status = 200) => responses.push({ body, status }),
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    computeWakeSafetyV2: () => ({ hard: true, timed: false, soft: false, guaranteed: true, stale: false }),
    cfg: {},
    log: () => {},
  };
  const call = (pathname, params = {}) => handleSocialV2StateApi({
    ...deps,
    req: { method: 'GET', headers },
    url: { pathname, searchParams: new URLSearchParams(params) },
  });
  return { responses, call };
}

test('控制台只读端点：/api/socialV2/mood 返回当前状态与最近来源事件', async () => {
  const w = makeWorld();
  w.layer.applyEmotionEvent('private:123456', { type: 'praised', cause: '他说我好看' });
  w.tick(60 * 1000);
  w.layer.applyEmotionEvent('private:123456', { type: 'comforted', cause: '他哄了我' });

  const api = fakeApi(w);
  const handled = await api.call('/api/socialV2/mood', { key: 'private:123456' });
  assert.equal(handled, true);
  assert.equal(api.responses.length, 1);
  const body = api.responses[0].body;
  assert.equal(body.ok, true);
  assert.equal(body.key, 'private:123456');
  assert.equal(body.known, true);
  assert.equal(body.mood.causeType, 'comforted');
  assert.equal(body.mood.cause, '他哄了我');
  assert.equal(body.mood.since, T0 + 60 * 1000);
  assert.equal(body.events.length, 2);
  assert.equal(body.events[0].type, 'praised');
  assert.equal(body.events[1].type, 'comforted');
  assert.ok(body.mood.valence !== undefined && body.mood.raw !== undefined);
});

test('控制台只读端点：未知会话返回默认状态，不创建会话', async () => {
  const w = makeWorld();
  const api = fakeApi(w);
  await api.call('/api/socialV2/mood', { key: 'private:999999' });
  const body = api.responses[0].body;
  assert.equal(body.ok, true);
  assert.equal(body.known, false);
  assert.equal(body.mood.valence, 0);
  assert.deepEqual(body.events, []);
  assert.equal(w.conversations.size, 0, '控制台刷新不能凭空造会话');
});

test('控制台只读端点：/api/socialV2/relationship 返回关系与来源事件', async () => {
  const w = makeWorld();
  w.layer.applyRelationshipEvent('654321', { type: 'ignored', cause: '他很久没理我' });
  w.layer.applyRelationshipEvent('654321', { type: 'openLoop', cause: '还欠着一句晚安' });

  const api = fakeApi(w);
  const handled = await api.call('/api/socialV2/relationship', { uid: '654321' });
  assert.equal(handled, true);
  const body = api.responses[0].body;
  assert.equal(body.ok, true);
  assert.equal(body.uid, '654321');
  assert.equal(body.known, true);
  assert.ok(body.relationship.tension > 0);
  assert.equal(body.relationship.openLoops.length, 1);
  assert.deepEqual(body.relationship.sources, ['private:654321']);
  assert.equal(body.events.length, 2);
  assert.equal(body.events[0].type, 'ignored');
});

test('控制台只读端点：/api/socialV2/moods 给出全部会话概览', async () => {
  const w = makeWorld();
  w.layer.applyEmotionEvent('private:1', { type: 'praised' });
  w.layer.applyEmotionEvent('group:2', { type: 'quarrel' });
  const api = fakeApi(w);
  const handled = await api.call('/api/socialV2/moods');
  assert.equal(handled, true);
  const body = api.responses[0].body;
  assert.equal(body.ok, true);
  assert.equal(body.count, 2);
  const byKey = Object.fromEntries(body.conversations.map((c) => [c.key, c]));
  assert.ok(byKey['private:1'].valence > 0);
  assert.ok(byKey['group:2'].valence < 0);
  assert.equal(byKey['private:1'].causeType, 'praised');
});

test('控制台只读端点：/api/socialV2/state 与 /api/socialV2/states 带上情绪摘要', async () => {
  const w = makeWorld();
  w.layer.applyEmotionEvent('private:1', { type: 'praised', cause: '夸夸' });
  w.layer.applyRelationshipEvent('1', { type: 'praised' });

  const api = fakeApi(w);
  await api.call('/api/socialV2/state', { key: 'private:1' });
  const stateBody = api.responses[0].body;
  assert.equal(stateBody.ok, true);
  assert.equal(stateBody.mood.cause, '夸夸');
  assert.ok(stateBody.relationship.intimacy > DEFAULT_INTIMACY);
  assert.equal(stateBody.lastSaveError, null, '保存健康：最近一次落盘成功时为空');

  api.responses.length = 0;
  await api.call('/api/socialV2/states');
  assert.equal(api.responses[0].body.conversations[0].mood.causeType, 'praised');
});

test('控制台可解释：/state 返回最近一次表达计划（expression）', async () => {
  const w = makeWorld();
  const plan = {
    moodBand: '低落',
    maxReplyChars: 80,
    stickerProbability: 0.3,
    proactiveMultiplier: 0.7,
    reasons: [{ field: 'moodBand', value: '低落', rule: 'valence<=-0.15' }],
  };
  const lastExpression = new Map([['private:1', { at: T0, reason: 'replyCheck', plan }]]);
  const api = fakeApi(w, {
    socialV2: { conversations: w.conversations, paused: false, lastSaveError: null, lastExpression },
  });
  await api.call('/api/socialV2/state', { key: 'private:1' });
  const body = api.responses[0].body;
  assert.equal(body.expression.reason, 'replyCheck');
  assert.equal(body.expression.plan.moodBand, '低落');
  assert.equal(body.expression.plan.maxReplyChars, 80);
});

test('控制台可解释：/state 返回当前 key 的 lastProactive（审查 expression P2-3）', async () => {
  const w = makeWorld();
  const lastProactiveByKey = new Map([['private:1', {
    at: T0,
    reason: 'proactiveCheck',
    moodBand: '低落',
    baseProb: 0.6,
    finalProb: 0.2,
    fired: false,
    suppressed: null,
  }]]);
  const api = fakeApi(w, {
    socialV2: { conversations: w.conversations, paused: false, lastSaveError: null, lastProactiveByKey },
  });
  await api.call('/api/socialV2/state', { key: 'private:1' });
  const body = api.responses[0].body;
  assert.equal(body.lastProactive.reason, 'proactiveCheck');
  assert.equal(body.lastProactive.finalProb, 0.2);
  assert.equal(body.lastProactive.fired, false);
});

test('控制台只读端点：保存失败时 /state 暴露 lastSaveError（审查 r5 P2）', async () => {
  const w = makeWorld();
  w.layer.applyEmotionEvent('private:1', { type: 'praised' });
  const saveError = { at: T0, message: 'ENOSPC: no space left on device' };
  const api = fakeApi(w, {
    socialV2: { conversations: w.conversations, paused: false, lastSaveError: saveError },
  });
  await api.call('/api/socialV2/state', { key: 'private:1' });
  const body = api.responses[0].body;
  assert.deepEqual(body.lastSaveError, saveError, '保存失败必须能从状态接口看出来（区分内存态和已落盘态）');
});

test('控制台只读端点：参数缺失 / 非法返回 400，不静默成功', async () => {
  const w = makeWorld();
  const api = fakeApi(w);
  await api.call('/api/socialV2/mood');
  assert.equal(api.responses[0].status, 400);
  await api.call('/api/socialV2/mood', { key: 'user:1' });
  assert.equal(api.responses[0].status, 400);
  await api.call('/api/socialV2/relationship');
  assert.equal(api.responses[0].status, 400);
  await api.call('/api/socialV2/relationship', { uid: 'abc' });
  assert.equal(api.responses[0].status, 400);
  assert.equal(w.conversations.size, 0);
});

test('控制台只读端点：跨会话视图拒绝 agent token（审查 P0-1 越权）', async () => {
  const w = makeWorld();
  // 模拟某个会话（private:1）持有有效 token 的智能体
  const api = fakeApi(w, { headers: { 'x-agent-token': 'tok-of-private:1' } });

  await api.call('/api/socialV2/moods');
  assert.equal(api.responses[0].status, 403, '/moods 是跨会话视图，必须拒绝会话级 token');

  await api.call('/api/socialV2/relationship', { uid: '2' });
  assert.equal(api.responses[0].status, 403, '/relationship 是他人关系，必须拒绝会话级 token');

  // /mood 只查自己：token 会走 key 绑定校验（mock 里 key 校验通过 → 200），不是 403
  await api.call('/api/socialV2/mood', { key: 'private:1' });
  assert.equal(api.responses[2].status, 200);

  // 无 token 的控制台请求仍然可以查全部（本机管理端）
  const consoleApi = fakeApi(w);
  await consoleApi.call('/api/socialV2/moods');
  assert.equal(consoleApi.responses[0].status, 200);
  await consoleApi.call('/api/socialV2/relationship', { uid: '2' });
  assert.equal(consoleApi.responses[1].status, 200);
});

// ── 表达层接入前的语义约定（防止将来接线时想当然） ────────────────────────

test('事件链完整：同一件事同时喂情绪和关系，两边都能追溯到同一个 cause', () => {
  const w = makeWorld();
  const cause = '他说「你今天怎么这么凶」';
  const emo = w.layer.applyEmotionEvent('private:24680', { type: 'teased', cause });
  const rel = w.layer.applyRelationshipEvent('24680', { type: 'teased', cause });
  assert.equal(emo.ok, true);
  assert.equal(rel.ok, true);
  assert.equal(w.layer.getMood('private:24680').cause, cause);
  assert.equal(w.layer.getRelationship('24680').events[0].cause, cause);
});

test('半衰期覆盖：作用在整份 mood 上，之后所有贡献都按新半衰期衰减（审查 P2-2 语义）', () => {
  const w = makeWorld();
  const shortHalf = 2 * HOUR;
  // 先在旧半衰期（6h）下攒一点情绪
  w.layer.applyEmotionEvent('private:1', { type: 'praised' });
  w.tick(10 * 60 * 1000); // 10 分钟
  // 新事件覆盖整份 mood 的半衰期为 2h：此前被夸的贡献也一起按 2h 衰减
  w.layer.applyEmotionEvent('private:1', { type: 'quarrel', decayHalfLifeMs: shortHalf });
  const afterEvent = w.layer.getMood('private:1');
  assert.equal(afterEvent.decayHalfLifeMs, shortHalf);

  w.tick(shortHalf);
  const decayed = w.layer.getMood('private:1');
  assert.ok(Number.isFinite(decayed.valence));
  // 半衰期是「整份」的：读出来的 raw 在三元值里，age 按新半衰期算
  assert.equal(decayed.ageMs, shortHalf);
  assert.ok(Math.abs(decayed.valence - afterEvent.raw.valence / 2) < 1e-9);
});
