// 记忆库：情绪检索通道（会话 D）。
//
// 覆盖：
//   1. 情绪事件类型 → 记忆标注（valence/arousal，字段名与 mood 模块约定一致）；
//   2. store.appendEvent 自动标注（显式值优先、未知类型不标注、旧事件无字段）；
//   3. 情绪通道召回（同类情绪场景，关键词未命中也能想起）与默认行为不变；
//   4. 向后兼容：无标注的旧事件不报错、不参与情绪通道。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EMOTION_ANNOTATION,
  emotionAnnotation,
  emotionSimilarity,
  normalizeEmotionQuery,
  rankByEmotion,
  rankDocuments,
} from '../src/core/memory-lib.mjs';
import { createMemoryStore } from '../src/core/memory-store.mjs';
import { handleSocialV2MemoryApi } from '../src/routes/socialv2-memory-api.mjs';

const NOW = new Date('2026-10-25T12:00:00').getTime();
const DAY = 86400000;

function makeTempStore(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-emotion-'));
  const store = createMemoryStore({ dir, config: { searchDays: 90, ...config } });
  return { dir, store };
}

function eventAt(day, hour, rest) {
  const [y, m, d] = day.split('-').map(Number);
  return { t: new Date(y, m - 1, d, hour, 0, 0).getTime(), ...rest };
}

// ── 标注映射（纯函数）──────────────────────────────────────────────────────


test('emotionAnnotation：情绪事件类型 → {emotionType, valence, arousal}', () => {
  const praised = emotionAnnotation('praised');
  assert.equal(praised.emotionType, 'praised');
  assert.ok(praised.valence > 0.5 && praised.valence <= 1, '被夸应明显正向');
  assert.ok(praised.arousal >= 0 && praised.arousal <= 1);

  const ignored = emotionAnnotation('ignored');
  assert.ok(ignored.valence < 0, '被冷落应负向');
  assert.ok(ignored.arousal >= 0 && ignored.arousal <= 1);

  const quarrel = emotionAnnotation('quarrel');
  assert.ok(quarrel.valence <= ignored.valence, '争吵比冷落更负');

  // 未知/空类型不标注（旧数据不受影响）
  assert.equal(emotionAnnotation('not-a-real-type'), null);
  assert.equal(emotionAnnotation(''), null);
  assert.equal(emotionAnnotation(undefined), null);
  assert.equal(emotionAnnotation(null), null);
  // 映射参数集中在 EMOTION_ANNOTATION（与 mood 基线对齐）
  assert.equal(EMOTION_ANNOTATION.arousalBase, 0.3);
});

test('emotionSimilarity：同向相似度高、反向低、缺字段为 0、越界先钳制', () => {
  assert.equal(emotionSimilarity({ valence: 0.7, arousal: 0.45 }, { valence: 0.7, arousal: 0.45 }), 1);
  const close = emotionSimilarity({ valence: 0.7, arousal: 0.45 }, { valence: 0.6, arousal: 0.5 });
  assert.ok(close > 0.9, `接近的情绪应高度相似，实际 ${close}`);
  const opposite = emotionSimilarity({ valence: 0.7, arousal: 0.45 }, { valence: -0.6, arousal: 0.4 });
  assert.ok(opposite < 0.6, `相反情绪不应算同类，实际 ${opposite}`);
  assert.equal(emotionSimilarity({ valence: 0.1 }, { valence: 0.1, arousal: 0.4 }), 0, '缺 arousal 不相似');
  // 越界值先钳制：两个都在边界外但钳制后相同 → 相似度 1
  assert.equal(emotionSimilarity({ valence: 5, arousal: 2 }, { valence: 5, arousal: 2 }), 1);
});

test('rankByEmotion：只对标注文档打分、相似度阈值过滤、时间衰减', () => {
  const docs = [
    { id: 'a', text: '上次被冷落时对方说的话', valence: -0.6, arousal: 0.4, salience: 2, ts: NOW - DAY, weight: 1 },
    { id: 'b', text: '被夸', valence: 0.7, arousal: 0.45, salience: 2, ts: NOW - DAY, weight: 1 },
    { id: 'c', text: '旧事件（无标注）', salience: 2, ts: NOW - DAY, weight: 1 },
  ];
  const hits = rankByEmotion({ valence: -0.6, arousal: 0.4 }, docs, { now: NOW });
  assert.equal(hits[0].id, 'a', '同类负向情绪应排最前');
  assert.equal(hits.some((h) => h.id === 'c'), false, '旧事件不参与情绪通道');
  assert.equal(hits.some((h) => h.id === 'b'), false, '相反情绪不应被召回');
  assert.equal(hits[0].emotionChannel, true);
  assert.ok(hits[0].emotionSimilarity >= 0.9);

  // 空/非法 mood：返回空数组，不报错
  assert.deepEqual(rankByEmotion({}, docs, { now: NOW }), []);
  assert.deepEqual(rankByEmotion(null, docs, { now: NOW }), []);

  // 时间越久分数越低（分档衰减）
  const fresh = rankByEmotion({ valence: -0.6, arousal: 0.4 }, [
    { id: 'f', valence: -0.6, arousal: 0.4, salience: 1, ts: NOW - DAY },
  ], { now: NOW });
  const old = rankByEmotion({ valence: -0.6, arousal: 0.4 }, [
    { id: 'o', valence: -0.6, arousal: 0.4, salience: 1, ts: NOW - 200 * DAY },
  ], { now: NOW });
  assert.ok(fresh.length && old.length);
  assert.ok(fresh[0].score > old[0].score, '旧事件分数应更低');
});

// ── 写入侧：appendEvent 自动标注 ─────────────────────────────────────────

test('store：appendEvent 传 emotionType 自动标注，显式值优先，未知类型不标注', () => {
  const { store } = makeTempStore();
  store.appendEvent(eventAt('2026-10-24', 9, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '你好可爱', emotionType: 'praised',
  }));
  store.appendEvent(eventAt('2026-10-24', 10, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '你都不理我', emotionType: 'ignored',
  }));
  store.appendEvent(eventAt('2026-10-24', 11, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '普通消息',
  }));
  store.appendEvent(eventAt('2026-10-24', 12, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '显式覆盖', emotionType: 'praised', valence: -1, arousal: 0,
  }));
  store.appendEvent(eventAt('2026-10-24', 13, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '未知情绪类型', emotionType: 'not-a-real-type',
  }));

  const rows = store.readDayEvents('2026-10-24');
  const praised = rows.find((r) => r.text === '你好可爱');
  assert.equal(praised.emotionType, 'praised');
  assert.ok(praised.valence > 0 && praised.valence <= 1);
  assert.ok(praised.arousal >= 0 && praised.arousal <= 1);

  const ignored = rows.find((r) => r.text === '你都不理我');
  assert.ok(ignored.valence < 0);

  const plain = rows.find((r) => r.text === '普通消息');
  assert.equal(plain.valence, undefined, '没传类型不写标注字段（旧数据形状不变）');
  assert.equal(plain.arousal, undefined);

  const explicit = rows.find((r) => r.text === '显式覆盖');
  assert.equal(explicit.valence, -1, '显式值必须优先于映射');
  assert.equal(explicit.arousal, 0);

  const unknown = rows.find((r) => r.text === '未知情绪类型');
  assert.equal(unknown.valence, undefined, '未知类型不标注，也不能报错');
});

// ── 读取侧：默认行为不变 + 情绪通道召回 ──────────────────────────────────

function seedEmotionLibrary(store) {
  // 关键词命中（无标注）
  store.appendEvent(eventAt('2026-10-20', 9, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '周末去吃火锅吧',
  }));
  // 情绪相似但关键词不命中（上次被冷落时对方说的话）
  store.appendEvent(eventAt('2026-10-21', 9, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '你都不理我，我有点难过', emotionType: 'ignored',
  }));
  // 相反情绪（被夸）
  store.appendEvent(eventAt('2026-10-22', 9, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '你今天好厉害', emotionType: 'praised',
  }));
}

test('store.search：不传 emotion 时默认行为不变（加标注不改变结果）', () => {
  const { store } = makeTempStore();
  seedEmotionLibrary(store);
  const first = store.search('火锅', { now: NOW, topK: 5, days: 90 });
  const second = store.search('火锅', { now: NOW, topK: 5, days: 90 });
  assert.ok(first.length > 0);
  assert.ok(first[0].text.includes('火锅'));
  assert.deepEqual(first.map((h) => h.id), second.map((h) => h.id), '默认检索必须可复现');
  // 默认检索不因为事件带情绪标注而额外召回「难过」那条
  assert.equal(first.some((h) => h.text.includes('难过')), false);
});

test('store.search：传 emotion 时并行召回同类情绪场景，且不挤掉关键词命中', () => {
  const { store } = makeTempStore();
  seedEmotionLibrary(store);
  const mood = { valence: -0.6, arousal: 0.4 }; // 她此刻难过/被冷落
  const hits = store.search('火锅', { now: NOW, topK: 5, days: 90, emotion: mood });
  assert.ok(hits.some((h) => h.text.includes('火锅')), '关键词命中不能被情绪通道挤掉');
  const recalled = hits.find((h) => h.text.includes('难过'));
  assert.ok(recalled, '情绪通道应召回「上次难过时对方说的话」');
  assert.equal(recalled.emotionChannel, true, '召回项应带情绪通道标记');
  assert.equal(hits.some((h) => h.text.includes('好厉害')), false, '相反情绪的旧事不应被召回');
});

test('store.search：情绪通道对旧数据（无标注）不报错，只召回带标注的事件', () => {
  const { store } = makeTempStore();
  // 全是旧事件（无 valence/arousal）
  store.appendEvent(eventAt('2026-10-20', 9, { k: 'private:2', kind: 'msg', who: '爸爸', text: '周末去吃火锅吧' }));
  store.appendEvent(eventAt('2026-10-21', 9, { k: 'private:2', kind: 'msg', who: '爸爸', text: '今天好累' }));
  const hits = store.search('火锅', { now: NOW, topK: 5, days: 90, emotion: { valence: -0.5, arousal: 0.3 } });
  assert.ok(hits.some((h) => h.text.includes('火锅')), '旧数据仍能走关键词通道');
  assert.equal(hits.some((h) => h.emotionChannel), false, '没有标注就不该有情绪通道结果');
});

test('store.search：emotion 参数非法/缺字段时安全回退为默认检索', () => {
  const { store } = makeTempStore();
  seedEmotionLibrary(store);
  for (const bad of [null, {}, { valence: 'x' }, { arousal: 0.3 }, 123]) {
    const hits = store.search('火锅', { now: NOW, topK: 5, days: 90, emotion: bad });
    assert.ok(hits.length > 0, `emotion=${JSON.stringify(bad)} 应回退默认检索`);
    assert.ok(hits.some((h) => h.text.includes('火锅')));
  }
});

// ── bridge 接线：真实路径见 test-mood-bridge（这里只做 store 侧严格校验）────

test('严格标注：显式 null/空串/布尔/数组/越界被丢弃或钳制，非法原值不落盘', () => {
  const { store } = makeTempStore();
  store.appendEvent(eventAt('2026-10-24', 8, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: 'null 标注', valence: null, arousal: null,
  }));
  store.appendEvent(eventAt('2026-10-24', 9, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '空串标注', valence: '', arousal: ' ',
  }));
  store.appendEvent(eventAt('2026-10-24', 10, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '布尔标注', valence: true, arousal: false,
  }));
  store.appendEvent(eventAt('2026-10-24', 11, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '数组标注', valence: [0.5], arousal: [0.2],
  }));
  store.appendEvent(eventAt('2026-10-24', 12, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '越界标注', valence: 8, arousal: -3,
  }));
  store.appendEvent(eventAt('2026-10-24', 13, {
    k: 'private:2', kind: 'msg', who: '爸爸', text: '单边显式', valence: 0.4,
  }));
  const rows = store.readDayEvents('2026-10-24');
  for (const text of ['null 标注', '空串标注', '布尔标注', '数组标注']) {
    const row = rows.find((r) => r.text === text);
    assert.equal(row.valence, undefined, `${text} 的非法显式值不能落盘`);
    assert.equal(row.arousal, undefined);
  }
  const clamped = rows.find((r) => r.text === '越界标注');
  assert.equal(clamped.valence, 1, '越界 valence 应钳制到 1');
  assert.equal(clamped.arousal, 0, '越界 arousal 应钳制到 0');
  const single = rows.find((r) => r.text === '单边显式');
  assert.equal(single.valence, undefined, '只有单边显式值时不能凑出完整标注');
  assert.equal(single.arousal, undefined);
});

test('严格标注：无事件/未知类型不写任何情绪字段（与旧数据形状一致）', () => {
  const { store } = makeTempStore();
  store.appendEvent(eventAt('2026-10-24', 9, { k: 'private:2', kind: 'msg', who: '爸爸', text: '普通消息' }));
  store.appendEvent(eventAt('2026-10-24', 10, { k: 'private:2', kind: 'msg', who: '爸爸', text: '未知类型', emotionType: 'not-a-real-type' }));
  const rows = store.readDayEvents('2026-10-24');
  for (const text of ['普通消息', '未知类型']) {
    const row = rows.find((r) => r.text === text);
    assert.equal(row.emotionType, undefined, `${text} 不能保留 emotionType`);
    assert.equal(row.valence, undefined);
    assert.equal(row.arousal, undefined);
  }
});

test('emotionAnnotation：原型键（constructor/toString）不能被当成合法类型', () => {
  assert.equal(emotionAnnotation('constructor'), null);
  assert.equal(emotionAnnotation('toString'), null);
  assert.equal(emotionAnnotation('hasOwnProperty'), null);
  assert.equal(emotionAnnotation('__proto__'), null);
});

test('normalizeEmotionQuery：只接受有限 number，其余回退 null', () => {
  assert.deepEqual(normalizeEmotionQuery({ valence: -0.6, arousal: 0.4 }), { valence: -0.6, arousal: 0.4 });
  assert.deepEqual(normalizeEmotionQuery({ valence: -5, arousal: 3 }), { valence: -1, arousal: 1 }, '越界钳制');
  for (const bad of [null, undefined, {}, { valence: null, arousal: null }, { valence: '-0.6', arousal: '0.4' },
    { valence: true, arousal: false }, { valence: [0.1], arousal: 0.2 }, { valence: 0.1 }, { arousal: 0.2 }]) {
    assert.equal(normalizeEmotionQuery(bad), null, `${JSON.stringify(bad)} 应判非法`);
  }
});

test('rankByEmotion 与 rankDocuments 默认档一致（无 salience 都按 S1）', () => {
  const ts = NOW - 90 * DAY;
  const doc = { id: 'x', text: '火锅', valence: -0.6, arousal: 0.4, weight: 1, ts };
  const emotion = rankByEmotion({ valence: -0.6, arousal: 0.4 }, [doc], { now: NOW });
  const keyword = rankDocuments('火锅', [doc], { now: NOW });
  assert.ok(emotion.length && keyword.length);
  // 两条通道的衰减因子应一致：score / (相似度或 rawScore × weight)
  const emotionDecay = emotion[0].score / (emotion[0].emotionSimilarity * 1);
  const keywordDecay = keyword[0].score / (keyword[0].rawScore * 1);
  assert.ok(Math.abs(emotionDecay - keywordDecay) < 1e-9, `默认档位应一致：${emotionDecay} vs ${keywordDecay}`);
});

// ── 补位语义：不挤掉关键词命中、受多样性约束、计数正确 ─────────────────────

function seedKeywordAndEmotion(store) {
  // 两条低分关键词命中（分数按 topK 场景压低）
  store.appendEvent(eventAt('2026-10-20', 9, { k: 'private:2', kind: 'msg', who: '阿明', text: '周末去吃火锅吧' }));
  store.appendEvent(eventAt('2026-10-20', 10, { k: 'private:2', kind: 'msg', who: '阿明', text: '火锅要排队吗' }));
  // 两条情绪相似但关键词不命中（被冷落场景）
  store.appendEvent(eventAt('2026-10-21', 9, { k: 'private:2', kind: 'msg', who: '阿明', text: '你都不理我', emotionType: 'ignored' }));
  store.appendEvent(eventAt('2026-10-21', 10, { k: 'private:2', kind: 'msg', who: '阿明', text: '我也很难过', emotionType: 'ignored' }));
}

test('store.search：topK 已满时不补位——绝不挤掉关键词命中（P1）', () => {
  const { store } = makeTempStore();
  seedKeywordAndEmotion(store);
  const hits = store.search('火锅', { now: NOW, topK: 2, days: 90, emotion: { valence: -0.6, arousal: 0.4 } });
  assert.equal(hits.length, 2);
  assert.equal(hits.every((h) => h.text.includes('火锅')), true, '结果已满时不能有情绪补位');
  assert.equal(hits.some((h) => h.emotionChannel), false);
});

test('store.search：有空位时补位追加在末尾，既有命中顺序完整保留', () => {
  const { store } = makeTempStore();
  // 1 条关键词命中 + 2 条情绪补位（不同人，避开 perWho 上限）
  store.appendEvent(eventAt('2026-10-20', 9, { k: 'private:2', kind: 'msg', who: '阿明', text: '周末去吃火锅吧' }));
  store.appendEvent(eventAt('2026-10-21', 9, { k: 'private:2', kind: 'msg', who: '小林', text: '你都不理我', emotionType: 'ignored' }));
  store.appendEvent(eventAt('2026-10-21', 10, { k: 'private:2', kind: 'msg', who: '小林', text: '我也很难过', emotionType: 'ignored' }));
  const baseline = store.search('火锅', { now: NOW, topK: 5, days: 90 });
  const hits = store.search('火锅', { now: NOW, topK: 5, days: 90, emotion: { valence: -0.6, arousal: 0.4 } });
  assert.ok(hits.length > baseline.length, '有空位时应补位');
  // 既有命中（baseline 的 id 序列）必须原样出现在结果前部
  const ids = hits.map((h) => h.id);
  assert.deepEqual(ids.slice(0, baseline.length), baseline.map((h) => h.id), '既有命中顺序不能被重排');
  assert.ok(hits.slice(baseline.length).every((h) => h.emotionChannel === true), '补位项排在末尾');
  assert.ok(hits.length <= 5, '总数不能超过 topK');
});

test('store.search：补位受 perWho/perDay 多样性上限约束', () => {
  const { store } = makeTempStore({ perWhoMax: 2, perDayMax: 2 });
  seedKeywordAndEmotion(store);
  // 关键词命中 2 条（同人阿明、同一天），补位同人同天 → 受 perWho/perDay 限制
  const hits = store.search('火锅', { now: NOW, topK: 5, days: 90, emotion: { valence: -0.6, arousal: 0.4 } });
  const sameWho = hits.filter((h) => h.kind === 'event' && h.who === '阿明').length;
  assert.ok(sameWho <= 2, `同一人最多 2 条，实际 ${sameWho}`);
});

test('store.search：emotionAdded 按实际保留的补位数量记录（日志）', () => {
  const { store } = makeTempStore();
  // 1 条关键词命中 + 2 条可补位（不同人）
  store.appendEvent(eventAt('2026-10-20', 9, { k: 'private:2', kind: 'msg', who: '阿明', text: '周末去吃火锅吧' }));
  store.appendEvent(eventAt('2026-10-21', 9, { k: 'private:2', kind: 'msg', who: '小林', text: '你都不理我', emotionType: 'ignored' }));
  store.appendEvent(eventAt('2026-10-21', 10, { k: 'private:2', kind: 'msg', who: '小林', text: '我也很难过', emotionType: 'ignored' }));
  const hits = store.search('火锅', { now: NOW, topK: 5, days: 90, emotion: { valence: -0.6, arousal: 0.4 } });
  const actualAdded = hits.filter((h) => h.emotionChannel).length;
  assert.equal(actualAdded, 2, '前置：应补进 2 条');
  const last = store.readRecallLog({ limit: 1 })[0];
  assert.equal(last.emotion, true);
  assert.equal(last.emotionAdded, actualAdded, 'emotionAdded 必须是实际保留的补位数');
});

// ── routes 接线：memory-search / inspect 必须把当前 mood 传给检索 ─────────────

test('routes：memory-search 与 memory-inspect 都向 memoryStore.search 传当前 mood', async () => {
  const { dir, store } = makeTempStore();
  const captured = [];
  const orig = store.search;
  store.search = (q, opts) => {
    captured.push(opts || {});
    return orig(q, opts);
  };
  const makeDeps = (pathname) => ({
    req: { method: 'GET', headers: {} },
    url: new URL(`http://127.0.0.1${pathname}`),
    sendJson: () => {},
    readBody: async () => ({}),
    getSocialV2State: () => ({ unread: [{ text: '火锅' }], recentMessages: [], activeTopics: [], pendingThoughts: [] }),
    saveSocialV2State: () => {},
    appendMemoryV2: () => {}, formatMemoryV2: () => '', archiveMemoryEventV3: () => {},
    agentTokenOk: () => true, v2SessionAllowed: () => true, v2ToolEnabled: () => true,
    memoryStore: store, redactKnownTokensOnly: (s) => s,
    mergePersonFact: () => ({}), mergeThread: () => ({}), mergeSelfNote: () => ({}),
    verifyMemoryClaim: () => ({ ok: true }), buildWriteScope: () => ({}), eventsVisibleToSession: () => [],
    auditProfile: () => ({}), groupSelfNotes: () => [], memoryQueryV3: () => '火锅',
    formatMemoryInjectionV3: () => '', filterProfileBySource: (p) => p,
    getMoodFor: () => ({ valence: -0.6, arousal: 0.4 }),
  });
  try {
    await handleSocialV2MemoryApi(makeDeps('/api/socialV2/memory-search?key=private:1&q=火锅'));
    assert.ok(captured.length > 0, 'memory-search 应调用检索');
    assert.deepEqual(captured[0].emotion, { valence: -0.6, arousal: 0.4 }, 'memory-search 必须带当前 mood');
    captured.length = 0;
    await handleSocialV2MemoryApi(makeDeps('/api/socialV2/memory-inspect?key=private:1'));
    assert.ok(captured.some((o) => o.emotion && o.emotion.valence === -0.6), 'inspect 预览也必须带当前 mood');
  } finally {
    store.search = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('routes：getMoodFor 缺失/非法时回退默认检索（不带 emotion）', async () => {
  const { dir, store } = makeTempStore();
  const captured = [];
  const orig = store.search;
  store.search = (q, opts) => {
    captured.push(opts || {});
    return orig(q, opts);
  };
  const deps = {
    req: { method: 'GET', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/memory-search?key=private:1&q=火锅'),
    sendJson: () => {}, readBody: async () => ({}),
    getSocialV2State: () => ({ unread: [], recentMessages: [], activeTopics: [], pendingThoughts: [] }),
    saveSocialV2State: () => {}, appendMemoryV2: () => {}, formatMemoryV2: () => '', archiveMemoryEventV3: () => {},
    agentTokenOk: () => true, v2SessionAllowed: () => true, v2ToolEnabled: () => true,
    memoryStore: store, redactKnownTokensOnly: (s) => s,
    mergePersonFact: () => ({}), mergeThread: () => ({}), mergeSelfNote: () => ({}),
    verifyMemoryClaim: () => ({ ok: true }), buildWriteScope: () => ({}), eventsVisibleToSession: () => [],
    auditProfile: () => ({}), groupSelfNotes: () => [], memoryQueryV3: () => '火锅',
    formatMemoryInjectionV3: () => '', filterProfileBySource: (p) => p,
    // getMoodFor 未注入
  };
  try {
    await handleSocialV2MemoryApi(deps);
    assert.ok(captured.length > 0);
    assert.equal(captured[0].emotion, undefined, '取不到 mood 时不能带 emotion');
  } finally {
    store.search = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('routes：getMoodFor 抛异常时也回退默认检索（catch 分支）', async () => {
  const { dir, store } = makeTempStore();
  const captured = [];
  const orig = store.search;
  store.search = (q, opts) => {
    captured.push(opts || {});
    return orig(q, opts);
  };
  const deps = {
    req: { method: 'GET', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/memory-search?key=private:1&q=火锅'),
    sendJson: () => {}, readBody: async () => ({}),
    getSocialV2State: () => ({ unread: [], recentMessages: [], activeTopics: [], pendingThoughts: [] }),
    saveSocialV2State: () => {}, appendMemoryV2: () => {}, formatMemoryV2: () => '', archiveMemoryEventV3: () => {},
    agentTokenOk: () => true, v2SessionAllowed: () => true, v2ToolEnabled: () => true,
    memoryStore: store, redactKnownTokensOnly: (s) => s,
    mergePersonFact: () => ({}), mergeThread: () => ({}), mergeSelfNote: () => ({}),
    verifyMemoryClaim: () => ({ ok: true }), buildWriteScope: () => ({}), eventsVisibleToSession: () => [],
    auditProfile: () => ({}), groupSelfNotes: () => [], memoryQueryV3: () => '火锅',
    formatMemoryInjectionV3: () => '', filterProfileBySource: (p) => p,
    getMoodFor: () => { throw new Error('mood layer exploded'); },
  };
  try {
    await handleSocialV2MemoryApi(deps);
    assert.ok(captured.length > 0);
    assert.equal(captured[0].emotion, undefined, 'getMoodFor 抛异常时不能把异常带到检索');
  } finally {
    store.search = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 读取侧：历史/外部 JSONL 的越界标注必须规范化 ───────────────────────────

test('读取侧：旧 JSONL 越界标注被钳制后保留（与写入侧同一契约）', () => {
  const { dir, store } = makeTempStore();
  const day = '2026-10-20';
  const dirEvents = path.join(dir, 'events');
  fs.mkdirSync(dirEvents, { recursive: true });
  const ts = new Date(2026, 9, 20, 9).getTime();
  fs.writeFileSync(
    path.join(dirEvents, `${day}.jsonl`),
    JSON.stringify({ t: ts, k: 'private:2', kind: 'msg', who: '爸爸', text: '越界的旧标注', s: 2, id: 'old-1', valence: 8, arousal: -3, emotionType: 'praised' }) + '\n',
    'utf8',
  );
  // 用不与事件文本重叠的查询：关键词通道无命中，确保命中来自情绪通道（读取侧钳制）。
  const hits = store.search('别的词', { now: NOW, topK: 5, days: 90, emotion: { valence: 1, arousal: 0 } });
  const hit = hits.find((h) => h.text.includes('越界的旧标注'));
  assert.ok(hit, '越界标注的旧事件应被情绪通道召回（钳制后保留）');
  assert.equal(hit.valence, 1, '读取侧越界 valence 必须钳制到 1');
  assert.equal(hit.arousal, 0, '读取侧越界 arousal 必须钳制到 0');
  assert.equal(hit.emotionChannel, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('读取侧：旧 JSONL 非法标注（字符串/缺字段）整条视为无标注（emotionType 也清空）', () => {
  const { dir, store } = makeTempStore();
  const day = '2026-10-20';
  const dirEvents = path.join(dir, 'events');
  fs.mkdirSync(dirEvents, { recursive: true });
  const ts = new Date(2026, 9, 20, 9).getTime();
  fs.writeFileSync(
    path.join(dirEvents, `${day}.jsonl`),
    [
      { t: ts, k: 'private:2', kind: 'msg', who: '爸爸', text: '字符串标注', s: 2, id: 'old-2', emotionType: 'praised', valence: '0.9', arousal: '0.4' },
      { t: ts + 1000, k: 'private:2', kind: 'msg', who: '爸爸', text: '缺字段标注', s: 2, id: 'old-3', emotionType: 'praised', valence: 0.9 },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  );
  // 关键词检索仍能命中（只是不参与情绪通道）；坐标非法时 emotionType 也必须清空。
  for (const hit of store.search('标注', { now: NOW, topK: 5, days: 90 })) {
    assert.equal(hit.valence, null, `非法标注不能带 valence：${hit.text}`);
    assert.equal(hit.arousal, null);
    assert.equal(hit.emotionType, '', `坐标非法时 emotionType 必须为空：${hit.text}`);
  }
  const emotionHits = store.search('标注', { now: NOW, topK: 5, days: 90, emotion: { valence: -0.6, arousal: 0.4 } });
  assert.equal(emotionHits.some((h) => h.emotionChannel), false, '非法标注整条不参与情绪通道');
  // 合法标注仍保留 emotionType（不能把有效标注一起清掉）
  fs.appendFileSync(path.join(dirEvents, `${day}.jsonl`), JSON.stringify({
    t: ts + 2000, k: 'private:2', kind: 'msg', who: '爸爸', text: '合法标注', s: 2, id: 'old-4', emotionType: 'praised', valence: 0.7, arousal: 0.45,
  }) + '\n', 'utf8');
  const valid = store.search('合法标注', { now: NOW, topK: 5, days: 90 }).find((h) => h.text.includes('合法标注'));
  assert.equal(valid.emotionType, 'praised', '合法标注的 emotionType 必须保留');
  assert.equal(valid.valence, 0.7);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 多样性：perDay 独立于 perWho ───────────────────────────────────────────

test('store.search：补位受 perDay 上限约束（独立于 perWho）', () => {
  const { store } = makeTempStore({ perDayMax: 2, perWhoMax: 10 });
  // 关键词命中 2 条同一天（不同人）→ perDay 已满
  store.appendEvent(eventAt('2026-10-20', 9, { k: 'private:2', kind: 'msg', who: '阿明', text: '火锅一号' }));
  store.appendEvent(eventAt('2026-10-20', 10, { k: 'private:2', kind: 'msg', who: '小林', text: '火锅二号' }));
  // 补位候选同一天、不同人（perWho 不拦，但 perDay 满）
  store.appendEvent(eventAt('2026-10-20', 11, { k: 'private:2', kind: 'msg', who: '阿华', text: '你都不理我', emotionType: 'ignored' }));
  const hits = store.search('火锅', { now: NOW, topK: 5, days: 90, emotion: { valence: -0.6, arousal: 0.4 } });
  assert.equal(hits.filter((h) => h.emotionChannel).length, 0, 'perDay 满时补位必须被拦');
});

test('情绪通道在 isolated 下不跨会话（scopeKey 过滤同时作用于情绪召回）', () => {
  const { dir, store } = makeTempStore({ crossSessionPolicy: 'isolated' });
  const t0 = Date.now() - 3 * DAY;
  store.appendEvent({ t: t0, k: 'group:111', kind: 'msg', who: 'A', text: '被夸了很开心', s: 3, emotionType: 'praised' });
  store.appendEvent({ t: t0, k: 'group:222', kind: 'msg', who: 'B', text: '被夸了也很开心', s: 3, emotionType: 'praised' });
  const hits = store.search('别的关键词', {
    key: 'group:111', topK: 5, now: Date.now(),
    emotion: { valence: 0.6, arousal: 0.4 },
  });
  const leaked = hits.filter((h) => String(h.k || '').includes('222'));
  assert.equal(leaked.length, 0, 'isolated 下不能召回其他会话的事件（情绪通道同样受限）');
  // 正向断言：本会话的情绪召回必须真的存在（防「通道整体失效返回空」也测试通过）
  assert.ok(hits.some((h) => String(h.k || '') === 'group:111' && h.emotionChannel === true
    && String(h.text).includes('被夸了很开心')), '本会话的情绪召回必须存在');
  fs.rmSync(dir, { recursive: true, force: true });
});
