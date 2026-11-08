// 情绪系统 V2 —— 1A 纯函数单测（R4 最终复审通过；ADDENDUM v2.5 为唯一契约）。
//
// 覆盖：14 kind / 13 事件 golden kind+action 映射 / 强度精确公式（正负与 sens 非 1）/
//       sensitivity 单调与越界 / 多事件隔离 / upsert 融合+重新点燃+幂等+低置信 action 全链路 /
//       批量 applyCandidates / 淘汰收敛与全并列 tie-break / target-aware 合成 /
//       baseline-legacy 优先级 / 滞回切换（来源 episode、衰减、floor、同 kind 锚点、抑制、窗口、legacy 锚点）/
//       迁移 / 字段上限 / 属性测试。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MOOD_V2_SCHEMA_VERSION, V2_MAX_EPISODES, V2_MAX_CONTRIBUTIONS, MIN_ACTIVE_INTENSITY,
  V2_EVIDENCE_QUOTE_CHARS, V2_EVIDENCE_SPAN_CHARS, V2_APPRAISAL_NOTE_CHARS,
  EMOTION_KINDS, EMOTION_TEMPLATES,
  appraiseEvent, episodeIntensityAt, decayEpisodes, upsertEpisode, applyCandidates, evictEpisode,
  isEpisodeInContext, synthesizeMood, switchDominant, migrateMoodV1,
  createEmptyAgentMood, truncateChars, normalizeTarget, sameTarget, normalizeEpisode,
  makeEpisodeId, normalizeEventId, normalizeEpisodes, V2_EPISODE_ID_CHARS, stableHash64,
} from '../src/core/mood-v2.mjs';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function candidate(overrides = {}) {
  return {
    kind: 'hurt',
    target: { kind: 'other', uid: 'u1' },
    intensity: 0.4,
    confidence: 0.8,
    eventId: 'ev-1',
    sourceEventId: 'ev-1',
    evidence: { span: 'span', quote: '引用' },
    appraisal: { relevance: 0.7, goalCongruence: -0.5 },
    need: 'belonging',
    actionTendency: 'protest',
    appraisalNote: '有点委屈',
    at: 1000,
    ...overrides,
  };
}

function makeEpisode(overrides = {}) {
  return normalizeEpisode({
    kind: 'hurt',
    target: { kind: 'other', uid: 'u1' },
    peak: 0.5,
    decayAnchorAt: 1000,
    halfLifeMs: 4 * HOUR,
    confidence: 0.8,
    contributions: [{ sourceEventId: 'ev-1', contribution: 0.5, confidence: 0.8 }],
    appraisal: { goalCongruence: -0.5 },
    need: 'belonging',
    actionTendency: 'protest',
    appraisalNote: '有点委屈',
    ...overrides,
  });
}

// ── 1. 契约常量与表 ──────────────────────────────────────────────────────

test('契约常量：schemaVersion / episodes / contributions / 字段上限 / 完全衰减阈值', () => {
  assert.equal(MOOD_V2_SCHEMA_VERSION, 2);
  assert.equal(V2_MAX_EPISODES, 6);
  assert.equal(V2_MAX_CONTRIBUTIONS, 3);
  assert.equal(V2_EVIDENCE_QUOTE_CHARS, 80);
  assert.equal(V2_EVIDENCE_SPAN_CHARS, 32);
  assert.equal(V2_APPRAISAL_NOTE_CHARS, 60);
  assert.equal(MIN_ACTIVE_INTENSITY, 1e-4);
});

test('14 个 canonical kind 字段完整且坐标合法', () => {
  const kinds = Object.keys(EMOTION_KINDS);
  assert.equal(kinds.length, 14);
  for (const kind of kinds) {
    const info = EMOTION_KINDS[kind];
    assert.ok(typeof info.label === 'string' && info.label.length > 0, `${kind}.label`);
    assert.ok(info.valence >= -1 && info.valence <= 1, `${kind}.valence`);
    assert.ok(info.arousal >= 0 && info.arousal <= 1, `${kind}.arousal`);
    assert.ok(info.dominance >= 0 && info.dominance <= 1, `${kind}.dominance`);
    assert.ok(info.halfLifeMs > 0, `${kind}.halfLifeMs`);
    assert.ok(typeof info.action === 'string' && info.action.length > 0, `${kind}.action`);
    assert.ok(typeof info.theme === 'string' && info.theme.length > 0, `${kind}.theme`);
    assert.ok(typeof info.need === 'string' && info.need.length > 0, `${kind}.need`);
  }
  assert.ok(Object.hasOwn(EMOTION_KINDS, 'reassurance'), '必须有 reassurance（不是 trust）');
  assert.ok(!Object.hasOwn(EMOTION_KINDS, 'trust'), 'episode 不允许 trust（关系层保留）');
});

test('13 类事件 golden：精确 kind 集合 + 精确 action（含第三低强度项）', () => {
  const expected = {
    praised: { joy: 'show', pride: 'show', reassurance: 'approach' },
    thanked: { gratitude: 'repay', joy: 'approach', pride: 'show' },
    comforted: { reassurance: 'open', gratitude: 'approach', joy: 'approach' },
    missed: { joy: 'approach', reassurance: 'approach', loneliness: 'seekComfort' },
    teased: { surprise: 'question', joy: 'approach', hurt: 'hide' },
    ignored: { hurt: 'protest', loneliness: 'seekComfort', anger: 'protest' },
    jealous: { fear: 'seekComfort', anger: 'protest', hurt: 'protest' },
    quarrel: { anger: 'confront', sadness: 'withdraw', fear: 'freeze' },
    insulted: { anger: 'confront', shame: 'hide', sadness: 'withdraw' },
    rejected: { hurt: 'withdraw', disappointment: 'withdraw', sadness: 'withdraw' },
    makeup: { joy: 'approach', reassurance: 'repair', gratitude: 'repay' },
    poked: { surprise: 'attend', joy: 'approach', anticipation: 'approach' },
    lonely: { loneliness: 'seekComfort', hurt: 'protest', sadness: 'withdraw' },
  };
  assert.equal(Object.keys(EMOTION_TEMPLATES).length, 13);
  for (const [type, table] of Object.entries(expected)) {
    const candidates = appraiseEvent({ events: [{ type, confidence: 0.9, eventId: `e-${type}` }] });
    const actual = new Map(candidates.map((c) => [c.kind, c.actionTendency]));
    assert.equal(actual.size, Object.keys(table).length, `${type} kind 数量`);
    for (const [kind, action] of Object.entries(table)) {
      assert.ok(actual.has(kind), `${type} 缺少 ${kind}`);
      assert.equal(actual.get(kind), action, `${type}.${kind} action`);
    }
    for (const c of candidates) {
      assert.ok(c.intensity > 0 && c.intensity < 1, `${type}.${c.kind} 强度`);
      assert.ok(Object.hasOwn(EMOTION_KINDS, c.kind));
    }
  }
});

// ── 2. 评价引擎 ─────────────────────────────────────────────────────────

test('appraiseEvent：精确强度公式（固定参数手算，正性）', () => {
  const [joy] = appraiseEvent({
    events: [{ type: 'praised', confidence: 0.9, eventId: 'f1' }],
    context: { needTension: { approval: 0.3 }, sensitivity: { joy: 1 } },
  });
  assert.equal(joy.kind, 'joy');
  // base=0.55, goalWeight=1.1, (1+0.3*0.5)=1.15, bias=0.85, confidence=0.9 → raw≈0.532249
  const raw = 0.55 * 1.1 * 1.15 * 0.85 * 0.9;
  const expected = 1 - Math.exp(-1.2 * raw);
  assert.ok(Math.abs(joy.intensity - expected) < 1e-9, `期望 ${expected}，实际 ${joy.intensity}`);
  assert.ok(joy.appraisal.goalCongruence > 0, '正性事件 goalCongruence 为正');
});

test('appraiseEvent：精确强度公式（负性 vs 正性，同 base 手算）', () => {
  const needTension = { approval: 0.3, belonging: 0.3 };
  const [joy] = appraiseEvent({
    events: [{ type: 'praised', confidence: 0.9 }],
    context: { needTension, sensitivity: { joy: 1 } },
  });
  const hurt = appraiseEvent({
    events: [{ type: 'ignored', confidence: 0.9 }],
    context: { needTension, sensitivity: { hurt: 1 } },
  }).find((c) => c.kind === 'hurt');
  // 同为 base=0.55，正性 bias=0.85，负性 bias=1.3
  const rawJoy = 0.55 * 1.1 * 1.15 * 0.85 * 0.9;
  const rawHurt = 0.55 * 1.1 * 1.15 * 1.3 * 0.9;
  assert.ok(Math.abs(joy.intensity - (1 - Math.exp(-1.2 * rawJoy))) < 1e-9);
  assert.ok(Math.abs(hurt.intensity - (1 - Math.exp(-1.2 * rawHurt))) < 1e-9);
  assert.ok(hurt.intensity > joy.intensity, '负性偏差使负性事件更强');
});

test('appraiseEvent：sensitivity 1/1.5/2/3 单调递增且非 1 精确', () => {
  function hurtAt(value) {
    const candidates = appraiseEvent({
      events: [{ type: 'ignored', confidence: 0.8, eventId: 'e' }],
      context: { sensitivity: { hurt: value } },
    });
    return candidates.find((c) => c.kind === 'hurt').intensity;
  }
  const values = [1, 1.5, 2, 3].map(hurtAt);
  for (let i = 1; i < values.length; i += 1) assert.ok(values[i] > values[i - 1], `递增：${values[i - 1]} → ${values[i]}`);
  // sens=1.5 精确值：与 sens=1 的 raw 相同，只乘一次 1.5
  const raw = 0.55 * 1.1 * 1.15 * 1.3 * 0.8;
  assert.ok(Math.abs(values[1] - (1 - Math.exp(-1.2 * raw * 1.5))) < 1e-9, 'sensitivity 只能乘一次');
  for (const value of values) assert.ok(value > 0 && value < 1);
});

test('appraiseEvent：sensitivity 越界归一（-1→1、99→3、NaN→1）', () => {
  function hurtAt(value) {
    const candidates = appraiseEvent({
      events: [{ type: 'ignored', confidence: 0.8 }],
      context: { sensitivity: { hurt: value } },
    });
    return candidates.find((c) => c.kind === 'hurt').intensity;
  }
  const base = hurtAt(1);
  assert.ok(Math.abs(hurtAt(-1) - base) < 1e-12, '-1 clamp 到 1');
  assert.ok(Math.abs(hurtAt(99) - hurtAt(3)) < 1e-12, '99 clamp 到 3');
  assert.ok(Math.abs(hurtAt(Number.NaN) - base) < 1e-12, 'NaN 回退 1');
});

test('appraiseEvent：低置信度（<0.4）actionTendency 必须为 null', () => {
  const candidates = appraiseEvent({ events: [{ type: 'praised', confidence: 0.2 }] });
  for (const c of candidates) assert.equal(c.actionTendency, null);
});

test('appraiseEvent：多事件按事件隔离去重（两条不同用户 praised 各自产出）', () => {
  const candidates = appraiseEvent({
    events: [
      { type: 'praised', actorUid: 'u1', eventId: 'a', confidence: 0.9 },
      { type: 'praised', actorUid: 'u2', eventId: 'b', confidence: 0.9 },
    ],
  });
  const joyTargets = candidates.filter((c) => c.kind === 'joy').map((c) => c.target.uid).sort();
  assert.deepEqual(joyTargets, ['u1', 'u2']);
});

test('appraiseEvent：未知事件不猜；target 缺省 other+actorUid', () => {
  assert.equal(appraiseEvent({ events: [{ type: 'not_a_real_event' }] }).length, 0);
  assert.equal(appraiseEvent({ events: [] }).length, 0);
  assert.equal(appraiseEvent({}).length, 0);
  const [first] = appraiseEvent({ events: [{ type: 'praised', actorUid: 'u9', confidence: 0.9 }] });
  assert.equal(first.target.kind, 'other');
  assert.equal(first.target.uid, 'u9');
});

// ── 3. episode 衰减 / upsert / 批量 ──────────────────────────────────────

test('episodeIntensityAt：半衰期正确（早于 anchor 不放大）', () => {
  const now = 10_000_000;
  const episode = makeEpisode({ peak: 1, decayAnchorAt: now - 4 * HOUR, halfLifeMs: 4 * HOUR });
  assert.ok(Math.abs(episodeIntensityAt(episode, now) - 0.5) < 1e-9);
  assert.equal(episodeIntensityAt(episode, now - 5 * HOUR), 1);
  const views = decayEpisodes([episode], now);
  assert.ok(Math.abs(views[0].currentIntensity - 0.5) < 1e-9);
});

test('upsertEpisode：旧 peak=1 经 4 个半衰期后，新 I=0.2 不会拉回 1（融合）', () => {
  const now = 10_000_000;
  const episode = makeEpisode({ peak: 1, decayAnchorAt: now - 16 * HOUR, halfLifeMs: 4 * HOUR });
  const { episodes, episode: updated, changed } = upsertEpisode([episode], candidate({ intensity: 0.2, sourceEventId: 'ev-2' }), { now });
  assert.equal(changed, true);
  assert.ok(updated.peak < 0.25 && updated.peak > 0.1, `peak 应约 0.18，实际 ${updated.peak}`);
  assert.equal(episodes.length, 1);
});

test('upsertEpisode：重大事件（I>=0.6）且当前已消退时可重新点燃', () => {
  const now = 10_000_000;
  const episode = makeEpisode({ peak: 1, decayAnchorAt: now - 16 * HOUR, halfLifeMs: 4 * HOUR });
  const { episode: updated } = upsertEpisode([episode], candidate({ intensity: 0.8, sourceEventId: 'ev-3' }), { now });
  assert.ok(updated.peak >= 0.8);
});

test('upsertEpisode：同一来源事件幂等；contributions ≤3 且最新在前', () => {
  const now = 10_000_000;
  const episode = makeEpisode({ peak: 0.5, decayAnchorAt: now, contributions: [{ sourceEventId: 'ev-1', contribution: 0.5, confidence: 0.8 }] });
  assert.equal(upsertEpisode([episode], candidate({ intensity: 0.3, sourceEventId: 'ev-1' }), { now }).changed, false);
  const { episode: updated } = upsertEpisode([episode], candidate({ intensity: 0.3, sourceEventId: 'ev-9' }), { now });
  assert.equal(updated.contributions[0].sourceEventId, 'ev-9');
  assert.ok(updated.contributions.length <= V2_MAX_CONTRIBUTIONS);
});

test('upsertEpisode：不同 kind/target 不合并', () => {
  const now = 10_000_000;
  const episode = makeEpisode({ kind: 'hurt', target: { kind: 'other', uid: 'u1' } });
  const { episodes } = upsertEpisode([episode], candidate({ kind: 'joy', target: { kind: 'other', uid: 'u1' } }), { now });
  assert.equal(episodes.length, 2);
});

test('低置信 action 全链路：appraise → upsert → normalize → migrate 均为 null', () => {
  const now = 10_000_000;
  const [cand] = appraiseEvent({ events: [{ type: 'praised', confidence: 0.2, eventId: 'low' }] });
  assert.equal(cand.actionTendency, null);
  const { episode } = upsertEpisode([], cand, { now });
  assert.equal(episode.actionTendency, null, '入库不能恢复成强动作');
  assert.equal(normalizeEpisode(episode, now).actionTendency, null, '规范化不能恢复');
  const migrated = migrateMoodV1({ causeType: 'ignored', valence: -0.3, cause: 'x' }, { now });
  assert.equal(migrated.agentMood.episodes[0].actionTendency, null, '迁移必须为 null');
});

test('normalizeEpisode / resolveAction：显式 null 保持 null；正常动作名保真', () => {
  for (const kind of Object.keys(EMOTION_KINDS)) {
    const episode = normalizeEpisode({ kind, peak: 0.3, actionTendency: null }, 1);
    assert.equal(episode.actionTendency, null, `${kind} 显式 null 必须保持`);
  }
  for (const action of ['repay', 'open', 'question', 'confront', 'repair', 'seekComfort', 'attend']) {
    const episode = normalizeEpisode({ kind: 'joy', peak: 0.3, actionTendency: action }, 1);
    assert.equal(episode.actionTendency, action, `${action} 不应被空串规则误伤`);
  }
});

test('applyCandidates：批量逐条 upsert（多事件同 kind 同 target 融合，幂等）', () => {
  const now = 10_000_000;
  const events = [
    { type: 'praised', actorUid: 'u1', eventId: 'a', confidence: 0.9 },
    { type: 'praised', actorUid: 'u1', eventId: 'b', confidence: 0.9 },
  ];
  const candidates = appraiseEvent({ events });
  assert.ok(candidates.length >= 1);
  const { episodes, changed } = applyCandidates([], candidates, { now });
  assert.equal(changed, true);
  assert.ok(episodes.length <= V2_MAX_EPISODES);
  const joy = episodes.find((episode) => episode.kind === 'joy');
  assert.ok(joy, 'joy 被写入');
  assert.ok(joy.contributions.length >= 1);
  assert.ok(joy.contributions.length <= V2_MAX_CONTRIBUTIONS);
  // 同样的候选再批量应用一次：同 sourceEventId 幂等，不重复贡献
  const again = applyCandidates(episodes, candidates, { now });
  const joyAgain = again.episodes.find((episode) => episode.kind === 'joy');
  assert.equal(joyAgain.contributions.length, joy.contributions.length, '同源事件不重复贡献');
});

// ── 4. 淘汰 ─────────────────────────────────────────────────────────────

test('evictEpisode：超过 6 条时淘汰非 active、非 dominant 的最低强度', () => {
  const now = 10_000_000;
  const episodes = Array.from({ length: 6 }, (_, i) => makeEpisode({
    kind: 'hurt',
    target: { kind: 'other', uid: `t${i}` },
    peak: 0.1 * (i + 1),
    decayAnchorAt: now,
    contributions: [{ sourceEventId: `ev-${i}`, contribution: 0.1, confidence: 0.8 }],
  }));
  const { episodes: next } = upsertEpisode(episodes, candidate({ target: { kind: 'other', uid: 'new' } }), { now, activeUid: 'active' });
  assert.equal(next.length, 6);
  assert.ok(!next.some((e) => e.target.uid === 't0'), '最低强度的非 active 被淘汰');
});

test('evictEpisode：脏输入 7+ 条循环收敛到 6；全 active 也收敛', () => {
  const now = 10_000_000;
  const episodes = Array.from({ length: 9 }, (_, i) => makeEpisode({
    kind: 'hurt', target: { kind: 'other', uid: `t${i}` }, peak: 0.1 * (i + 1), decayAnchorAt: now,
    contributions: [{ sourceEventId: `e${i}`, contribution: 0.1, confidence: 0.8 }],
  }));
  assert.equal(evictEpisode(episodes, { now }).length, 6);
  const allActive = Array.from({ length: 8 }, (_, i) => makeEpisode({
    kind: 'hurt', target: { kind: 'other', uid: 'a' }, peak: 0.1 * (i + 1), decayAnchorAt: now,
    contributions: [{ sourceEventId: `a${i}`, contribution: 0.1, confidence: 0.8 }],
  }));
  assert.equal(evictEpisode(allActive, { now, activeUid: 'a' }).length, 6);
});

test('evictEpisode：同 kind/强度/anchor 多 target 时用 target 做最终 tie-break（稳定）', () => {
  const now = 10_000_000;
  const order = ['t3', 't1', 't2'];
  const episodes = order.map((uid) => makeEpisode({
    kind: 'hurt', target: { kind: 'other', uid }, peak: 0.2, decayAnchorAt: now,
    contributions: [{ sourceEventId: `x-${uid}`, contribution: 0.2, confidence: 0.8 }],
  }));
  const kept = evictEpisode(episodes, { now });
  assert.equal(kept.length, 3, '只有 3 条时不淘汰（构造检查）');
  const full = [...episodes, ...Array.from({ length: 5 }, (_, i) => makeEpisode({
    kind: 'hurt', target: { kind: 'other', uid: `h${i}` }, peak: 0.3, decayAnchorAt: now,
    contributions: [{ sourceEventId: `h-${i}`, contribution: 0.3, confidence: 0.8 }],
  }))];
  const evicted = evictEpisode(full, { now });
  assert.equal(evicted.length, 6);
  assert.ok(!evicted.some((e) => e.target.uid === 't1'), '同并列时淘汰 target 排序最小者（t1）');
});

test('evictEpisode：dominant 源受保护', () => {
  const now = 10_000_000;
  const withDominant = [
    makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'x' }, peak: 0.1, decayAnchorAt: now }),
    ...Array.from({ length: 6 }, (_, i) => makeEpisode({ kind: 'hurt', target: { kind: 'other', uid: `h${i}` }, peak: 0.05, decayAnchorAt: now })),
  ];
  const kept = evictEpisode(withDominant, { now, dominantKind: 'anger' });
  assert.ok(kept.some((e) => e.kind === 'anger'), 'dominant 源不被淘汰');
});

// ── 5. 合成（target-aware）──────────────────────────────────────────────

test('synthesizeMood：私聊只纳入对当前对象 + self/world', () => {
  const now = 10_000_000;
  const episodes = [
    makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.7, decayAnchorAt: now }),
    makeEpisode({ kind: 'joy', target: { kind: 'other', uid: 'B' }, peak: 0.8, decayAnchorAt: now }),
    makeEpisode({ kind: 'sadness', target: { kind: 'world' }, peak: 0.3, decayAnchorAt: now }),
  ];
  const mood = synthesizeMood({ episodes, context: { mode: 'private', activeUid: 'A', now } });
  assert.equal(mood.episodeCount, 2);
  assert.ok(mood.valence < 0);
  assert.equal(mood.byTarget.B.dominant.kind, 'joy', 'byTarget 仍包含 B 的只读投影');
  assert.ok(!mood.reasons.some((r) => r.kind === 'joy'));
});

test('synthesizeMood：正负并存 → conflict > 0；label 混合', () => {
  const now = 10_000_000;
  const episodes = [
    makeEpisode({ kind: 'joy', target: { kind: 'other', uid: 'A' }, peak: 0.6, decayAnchorAt: now }),
    makeEpisode({ kind: 'sadness', target: { kind: 'other', uid: 'A' }, peak: 0.6, decayAnchorAt: now }),
  ];
  const mood = synthesizeMood({ episodes, context: { mode: 'private', activeUid: 'A', now } });
  assert.ok(mood.conflict > 0.3);
  assert.ok(mood.label.includes('又'));
});

test('synthesizeMood：群聊纳入当前说话人 / 本群 / self', () => {
  const now = 10_000_000;
  const episodes = [
    makeEpisode({ kind: 'joy', target: { kind: 'other', uid: 'A' }, peak: 0.6, decayAnchorAt: now }),
    makeEpisode({ kind: 'anger', target: { kind: 'group', key: 'group:1' }, peak: 0.4, decayAnchorAt: now }),
    makeEpisode({ kind: 'sadness', target: { kind: 'other', uid: 'B' }, peak: 0.5, decayAnchorAt: now }),
  ];
  const mood = synthesizeMood({ episodes, context: { mode: 'group', key: 'group:1', activeUid: 'A', now } });
  assert.equal(mood.episodeCount, 2);
});

test('synthesizeMood：byTarget 不包含完全衰减的情绪（< MIN_ACTIVE_INTENSITY）', () => {
  const now = 10_000_000;
  const episodes = [
    makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 1, decayAnchorAt: now - 100 * HOUR }),
  ];
  const mood = synthesizeMood({ episodes, context: { mode: 'private', activeUid: 'A', now } });
  assert.equal(mood.episodeCount, 0);
  assert.equal(mood.byTarget.A, undefined, '衰减到阈值以下的不展示');
});

test('synthesizeMood：baseline 优先于 legacy；四组合', () => {
  const now = 10_000_000;
  const context = { mode: 'private', activeUid: 'A', now };
  const none = synthesizeMood({ episodes: [], context });
  assert.deepEqual([none.valence, none.arousal], [0, 0.3]);
  assert.equal(none.legacy, null);

  const baseline = { valence: 0.8, arousal: 0.4, energy: 0.5, dominance: 0.6 };
  const legacyAffect = { valence: -0.8, arousal: 0.2, energy: 0.1, dominance: 0.2 };
  const onlyBaseline = synthesizeMood({ episodes: [], context, baseline });
  assert.equal(onlyBaseline.valence, 0.8);
  assert.equal(onlyBaseline.legacy, null, '有 baseline 时不返回 legacy');

  const onlyLegacy = synthesizeMood({ episodes: [], context, legacyAffect });
  assert.equal(onlyLegacy.valence, -0.8);
  assert.ok(onlyLegacy.legacy);

  const both = synthesizeMood({ episodes: [], context, baseline, legacyAffect });
  assert.equal(both.valence, 0.8, 'baseline 权威');
  assert.equal(both.legacy, null, '两者同时存在时不返回 legacy');
});

test('isEpisodeInContext：私聊不含其它 uid；群聊含 group key', () => {
  const a = makeEpisode({ target: { kind: 'other', uid: 'A' } });
  const b = makeEpisode({ target: { kind: 'other', uid: 'B' } });
  const g = makeEpisode({ target: { kind: 'group', key: 'group:1' } });
  const w = makeEpisode({ target: { kind: 'world' } });
  assert.equal(isEpisodeInContext(a, { mode: 'private', activeUid: 'A' }), true);
  assert.equal(isEpisodeInContext(b, { mode: 'private', activeUid: 'A' }), false);
  assert.equal(isEpisodeInContext(w, { mode: 'private', activeUid: 'A' }), true);
  assert.equal(isEpisodeInContext(b, { mode: 'group', key: 'group:1', activeUid: 'A' }), false);
  assert.equal(isEpisodeInContext(g, { mode: 'group', key: 'group:1', activeUid: 'A' }), true);
});

// ── 6. 切换（滞回）───────────────────────────────────────────────────────

test('switchDominant：候选未超过滞回阈值不切换；超过后切换', () => {
  const now = 10_000_000;
  const base = {
    agentMood: { dominant: { kind: 'hurt', since: now - 5 * MINUTE, intensity: 0.5 }, lastSwitchAt: now - 5 * MINUTE, switchesThisTurn: 0, reverseSuppressUntil: 0, turnKey: 't1', inertia: 0.5 },
    context: { mode: 'private', activeUid: 'A', now },
    now,
    turnKey: 't1',
  };
  const weak = switchDominant({ ...base, episodes: [makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.6, decayAnchorAt: now })] });
  assert.equal(weak.changed, false, '0.6 未超过 0.5×(1+0.5)=0.75');
  const strong = switchDominant({ ...base, episodes: [makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.95, decayAnchorAt: now })] });
  assert.equal(strong.changed, true);
  assert.equal(strong.dominant.kind, 'anger');
  assert.equal(strong.switchesThisTurn, 1);
});

test('switchDominant：dominant 当前强度按衰减计算（1.0 存储、4h 后 0.5，候选 0.8 应切）', () => {
  const now = Date.now();
  const agentMood = { dominant: { kind: 'hurt', since: now - 4 * HOUR, intensity: 1 }, lastSwitchAt: now - 5 * MINUTE, switchesThisTurn: 0, reverseSuppressUntil: 0, turnKey: 't', inertia: 0.5 };
  const result = switchDominant({
    agentMood,
    episodes: [makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.8, decayAnchorAt: now })],
    context: { mode: 'private', activeUid: 'A', now },
    now,
    turnKey: 't',
  });
  assert.equal(result.changed, true, '0.8 > 0.5×1.5=0.75，应切换');
});

test('switchDominant：同 kind 多 target 时取最强来源（不依赖数组顺序）', () => {
  const now = 10_000_000;
  const episodes = [
    makeEpisode({ kind: 'joy', target: { kind: 'world' }, peak: 0.2, decayAnchorAt: now }),
    makeEpisode({ kind: 'joy', target: { kind: 'other', uid: 'A' }, peak: 0.3, decayAnchorAt: now }),
    makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.4, decayAnchorAt: now }),
  ];
  const result = switchDominant({
    agentMood: { dominant: { kind: 'joy', since: now, intensity: 0.3 }, lastSwitchAt: now - 5 * MINUTE, switchesThisTurn: 0, reverseSuppressUntil: 0, turnKey: 't', inertia: 0.5 },
    episodes,
    context: { mode: 'private', activeUid: 'A', now },
    now,
    turnKey: 't',
  });
  assert.equal(result.changed, false, '正确当前强度 0.3 → 阈值 0.45；0.4 不应切换');
  assert.equal(result.dominant.kind, 'joy');
});

test('switchDominant：floor 严格 >0.25（0.25 不切、0.250001 切）', () => {
  const now = 10_000_000;
  function attempt(peak) {
    return switchDominant({
      agentMood: { dominant: null, lastSwitchAt: 0, switchesThisTurn: 0, reverseSuppressUntil: 0, turnKey: null, inertia: 0.5 },
      episodes: [makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak, decayAnchorAt: now })],
      context: { mode: 'private', activeUid: 'A', now },
      now,
      turnKey: 't',
    });
  }
  assert.equal(attempt(0.25).changed, false, '0.25 不切（严格大于）');
  assert.equal(attempt(0.250001).changed, true, '0.250001 可切');
});

test('switchDominant：同 kind 强化刷新强度并把锚点同步到 now（不二次衰减、不耗配额）', () => {
  const now = 10_000_000;
  const agentMood = { dominant: { kind: 'hurt', since: now - 2 * HOUR, intensity: 0.42 }, lastSwitchAt: now - 2 * HOUR, switchesThisTurn: 1, reverseSuppressUntil: 0, turnKey: 't', inertia: 0.5 };
  const refreshed = switchDominant({
    agentMood,
    episodes: [makeEpisode({ kind: 'hurt', target: { kind: 'other', uid: 'A' }, peak: 0.6, decayAnchorAt: now })],
    context: { mode: 'private', activeUid: 'A', now },
    now,
    turnKey: 't',
  });
  assert.equal(refreshed.changed, false, '同 kind 不算 switch');
  assert.equal(refreshed.switchesThisTurn, 1, '配额不被消耗');
  assert.equal(refreshed.dominant.intensity, 0.6, '强度被刷新');
  assert.equal(refreshed.dominant.since, now, '衰减锚点同步到刷新时刻');
  // 推进 2 小时：应从刷新时刻（now）衰减，而不是从旧 since 二次衰减
  const later = now + 2 * HOUR;
  const next = switchDominant({
    agentMood: { ...agentMood, ...refreshed },
    episodes: [makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.5, decayAnchorAt: later })],
    context: { mode: 'private', activeUid: 'A', now: later },
    now: later,
    turnKey: 't',
  });
  // 刷新后 2h：0.6×2^-0.5≈0.424 → 阈值 0.636；0.5 不应切换（旧 since 会得到 0.3→阈值 0.45→错误切换）
  assert.equal(next.changed, false, '不能用旧 since 二次衰减');
});

test('switchDominant：反向抑制期内、无 current 时不得生成 dominant', () => {
  const now = 10_000_000;
  const result = switchDominant({
    agentMood: { dominant: null, lastSwitchAt: 0, switchesThisTurn: 0, reverseSuppressUntil: now + 120_000, turnKey: null, inertia: 0.5 },
    episodes: [makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.9, decayAnchorAt: now })],
    context: { mode: 'private', activeUid: 'A', now },
    now,
    turnKey: 't',
  });
  assert.equal(result.changed, false);
  assert.equal(result.dominant, null, '未通过条件不得生成 dominant 投影');
});

test('switchDominant：since=0 且 lastSwitchAt=0 的 legacy dominant 会补锚点并随时间衰减', () => {
  const now = 10_000_000;
  const first = switchDominant({
    agentMood: { dominant: { kind: 'hurt', since: 0, intensity: 0.9 }, lastSwitchAt: 0, switchesThisTurn: 0, reverseSuppressUntil: 0, turnKey: null, inertia: 0.5 },
    episodes: [],
    context: { mode: 'private', activeUid: 'A', now },
    now,
    turnKey: 't',
  });
  assert.equal(first.dominant.since, now, '无锚点时同步 since=now（调用方落盘）');
  const later = now + 4 * HOUR;
  const next = switchDominant({
    agentMood: { ...first, inertia: 0.5 },
    episodes: [makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.7, decayAnchorAt: later })],
    context: { mode: 'private', activeUid: 'A', now: later },
    now: later,
    turnKey: 't',
  });
  // 4h 后 hurt(0.9→0.45) → 阈值 0.675；0.7 可切；若未衰减（0.9）阈值 1.35 不会切
  assert.equal(next.changed, true, 'legacy dominant 不应无限期保持原强度');
});

test('switchDominant：minDwell 未到不切换；turnKey 变化重置计数', () => {
  const now = 10_000_000;
  const episodes = [makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.95, decayAnchorAt: now })];
  const mood = { dominant: { kind: 'hurt', since: 0, intensity: 0.1 }, lastSwitchAt: now - 10_000, switchesThisTurn: 0, reverseSuppressUntil: 0, turnKey: 't1', inertia: 0.5 };
  assert.equal(switchDominant({ agentMood: mood, episodes, context: { mode: 'private', activeUid: 'A', now }, now, turnKey: 't1' }).changed, false);
  const resetMood = { ...mood, lastSwitchAt: now - 5 * MINUTE, switchesThisTurn: 1 };
  assert.equal(switchDominant({ agentMood: resetMood, episodes, context: { mode: 'private', activeUid: 'A', now }, now, turnKey: 't2' }).changed, true);
});

test('switchDominant：turnKey 缺省按 10 分钟窗口派生（9:59 / 10:00 边界）', () => {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const windowMs = 10 * 60 * 1000;
  const episodesAt = (now) => [makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.9, decayAnchorAt: now })];
  const at959 = base + 9 * 60 * 1000 + 59 * 1000;
  const first = switchDominant({
    agentMood: { dominant: null, lastSwitchAt: 0, switchesThisTurn: 0, reverseSuppressUntil: 0, turnKey: null, inertia: 0.5 },
    episodes: episodesAt(at959),
    context: { mode: 'private', activeUid: 'A', now: at959 },
    now: at959,
    turnKey: null,
  });
  assert.equal(first.changed, true);
  const sameWindow = switchDominant({
    agentMood: { ...first, inertia: 0.5 },
    episodes: episodesAt(at959 + 1000),
    context: { mode: 'private', activeUid: 'A', now: at959 + 1000 },
    now: at959 + 1000,
    turnKey: null,
  });
  assert.equal(sameWindow.changed, false, '同窗口内不再切（配额已用）');
  const nextWindow = switchDominant({
    agentMood: { dominant: { kind: 'hurt', since: at959, intensity: 0.5 }, lastSwitchAt: at959, switchesThisTurn: 1, reverseSuppressUntil: 0, turnKey: 'win-16', inertia: 0.5 },
    episodes: [makeEpisode({ kind: 'joy', target: { kind: 'other', uid: 'A' }, peak: 0.9, decayAnchorAt: at959 + windowMs })],
    context: { mode: 'private', activeUid: 'A', now: at959 + windowMs },
    now: at959 + windowMs,
    turnKey: null,
  });
  assert.equal(nextWindow.changed, true, '新窗口重置计数');
});

// ── 7. 迁移、字段与属性 ────────────────────────────────────────────────

test('migrateMoodV1：旧 mood → legacyAffect + 低置信度 episode，幂等、脏数据不崩', () => {
  const now = 10_000_000;
  const first = migrateMoodV1({ valence: -0.5, arousal: 0.3, energy: 0.4, cause: '又不理我', causeType: 'ignored', since: 1 }, { now });
  assert.equal(first.migrated, true);
  assert.equal(first.agentMood.schemaVersion, 2);
  assert.equal(first.agentMood.episodes.length, 1);
  assert.equal(first.agentMood.episodes[0].kind, 'hurt');
  assert.equal(first.agentMood.episodes[0].confidence, 0.3);
  assert.equal(first.legacyAffect.valence, -0.5);
  assert.equal(migrateMoodV1(first.agentMood, { now }).migrated, false);
  const dirty = migrateMoodV1({ cause: 'x'.repeat(500), valence: 'NaN', arousal: null }, { now });
  assert.ok(dirty.agentMood.legacyAffect);
  assert.ok(dirty.agentMood.legacyAffect.cause.length <= 160);
});

test('字段上限：quote/span/note 按字符截断', () => {
  assert.equal(truncateChars('字'.repeat(200), 80).length, 80);
  const candidates = appraiseEvent({ events: [{ type: 'praised', confidence: 0.9, evidence: { span: 'x'.repeat(100), quote: '字'.repeat(200) } }] });
  for (const c of candidates) {
    assert.equal(c.evidence.span.length, V2_EVIDENCE_SPAN_CHARS);
    assert.equal(c.evidence.quote.length, V2_EVIDENCE_QUOTE_CHARS);
    assert.ok(c.appraisalNote.length <= V2_APPRAISAL_NOTE_CHARS);
  }
});

test('target 边界：trim / 空串 / 前导零 / self/world/group 清理', () => {
  assert.equal(normalizeTarget({ kind: 'other', uid: ' 123 ' }).uid, '123');
  assert.equal(normalizeTarget({ kind: 'other', uid: '00123' }).uid, '123');
  assert.equal(normalizeTarget({ kind: 'other', uid: '   ' }).uid, null);
  assert.deepEqual(normalizeTarget({ kind: 'self', uid: '1', key: 'x' }), { kind: 'self', uid: null, key: null });
  assert.deepEqual(normalizeTarget({ kind: 'world', uid: '1' }), { kind: 'world', uid: null, key: null });
  assert.equal(normalizeTarget({ kind: 'group', uid: '2', key: 'group:9' }).uid, null);
  assert.equal(normalizeTarget({ kind: 'group', key: 'group:9' }).key, 'group:9');
  assert.equal(sameTarget({ kind: 'other', uid: '1' }, { kind: 'other', uid: 1 }), true);
  assert.equal(sameTarget({ kind: 'other', uid: '1' }, { kind: 'other', uid: '2' }), false);
});

test('属性测试：随机参数下 I∈(0,1)、peak∈[0,1]、episodes≤6、入参不被修改', () => {
  const now = 10_000_000;
  const events = Object.keys(EMOTION_TEMPLATES);
  for (let i = 0; i < 200; i += 1) {
    const type = events[i % events.length];
    const confidence = (i % 10) / 10 + 0.05;
    const sensitivityValue = [1, 1.5, 2, 3][i % 4];
    const rawEvent = { type, confidence, eventId: `p-${i}` };
    const snapshot = JSON.stringify(rawEvent);
    const candidates = appraiseEvent({
      events: [rawEvent],
      context: { sensitivity: Object.fromEntries(Object.keys(EMOTION_KINDS).map((k) => [k, sensitivityValue])), needTension: {} },
    });
    assert.equal(JSON.stringify(rawEvent), snapshot, 'appraiseEvent 不得修改入参');
    for (const candidate of candidates) {
      assert.ok(candidate.intensity > 0 && candidate.intensity < 1, `I 越界：${candidate.intensity}`);
    }
    // 逐 candidate 应用（不是把整个 candidates 数组当单一 candidate）
    let episodes = [];
    for (const candidate of candidates) {
      const result = upsertEpisode(episodes, candidate, { now });
      episodes = result.episodes;
    }
    assert.ok(episodes.length <= V2_MAX_EPISODES, `episodes 超限：${episodes.length}`);
    for (const episode of episodes) {
      assert.ok(episode.peak >= 0 && episode.peak <= 1, `peak 越界：${episode.peak}`);
    }
  }
});

test('episode id 唯一：满容量同毫秒不同 target 不重复', () => {
  const now = Date.now();
  let episodes = [];
  for (let i = 0; i < 6; i += 1) {
    const result = upsertEpisode(episodes, candidate({ kind: 'joy', target: { kind: 'other', uid: `u${i}` }, intensity: 0.3 }), { now });
    episodes = result.episodes;
  }
  const a = upsertEpisode(episodes, candidate({ kind: 'joy', target: { kind: 'other', uid: 'A' }, intensity: 0.5 }), { now });
  const b = upsertEpisode(a.episodes, candidate({ kind: 'joy', target: { kind: 'other', uid: 'B' }, intensity: 0.5 }), { now });
  const ids = b.episodes.map((episode) => episode.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须全局唯一');
  assert.equal(b.episodes.length, V2_MAX_EPISODES);
});

test('normalizeEpisode fallback id：existingIds 冲突时重新生成', () => {
  const ep1 = normalizeEpisode({ kind: 'joy', target: { kind: 'other', uid: 'A' }, decayAnchorAt: 1000 }, 1000);
  const taken = new Set([ep1.id]);
  const ep2 = normalizeEpisode({ kind: 'joy', target: { kind: 'other', uid: 'A' }, decayAnchorAt: 1000 }, 1000, { existingIds: taken });
  assert.notEqual(ep2.id, ep1.id, '同 kind/同 target/同 anchor 且 id 冲突时必须重新生成');
  const ep3 = normalizeEpisode({ kind: 'joy', target: { kind: 'other', uid: 'B' }, decayAnchorAt: 1000 }, 1000);
  assert.notEqual(ep3.id, ep1.id, '不同 target 的 fallback id 不同');
});

test('synthesizeMood：global 与 byTarget dominant 都带 sourceEpisodeId', () => {
  const now = Date.now();
  const episodes = [makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.6, decayAnchorAt: now })];
  const mood = synthesizeMood({ episodes, context: { mode: 'private', activeUid: 'A', now } });
  assert.equal(mood.dominant.sourceEpisodeId, episodes[0].id, 'global dominant 带来源 id');
  assert.equal(mood.byTarget.A.dominant.sourceEpisodeId, episodes[0].id, 'byTarget dominant 带来源 id');
});

test('switchDominant：source episode 不在当前 context 时仍按它计算阈值（一级定位不受 context 限制）', () => {
  const now = Date.now();
  const sourceB = makeEpisode({ kind: 'joy', target: { kind: 'other', uid: 'B' }, peak: 0.8, decayAnchorAt: now });
  const episodes = [
    sourceB,
    makeEpisode({ kind: 'joy', target: { kind: 'other', uid: 'A' }, peak: 0.2, decayAnchorAt: now }),
    makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.4, decayAnchorAt: now }),
  ];
  const result = switchDominant({
    agentMood: { dominant: { kind: 'joy', since: now, intensity: 0.8, sourceEpisodeId: sourceB.id }, lastSwitchAt: now - 5 * MINUTE, switchesThisTurn: 0, reverseSuppressUntil: 0, turnKey: 't', inertia: 0.5 },
    episodes,
    context: { mode: 'private', activeUid: 'A', now },
    now,
    turnKey: 't',
  });
  assert.equal(result.changed, false, '按 source B(0.8) 阈值 1.2，anger 0.4 不应切换');
  assert.equal(result.dominant.kind, 'joy');
});

test('applyCandidates：按事件时间写入（旧低强度事件不覆盖 latestSourceEventId）', () => {
  const now = Date.now();
  const old = candidate({ kind: 'hurt', sourceEventId: 'old', eventId: 'old', intensity: 0.2, at: now - HOUR, confidence: 0.2 });
  const fresh = candidate({ kind: 'hurt', sourceEventId: 'new', eventId: 'new', intensity: 0.3, at: now, confidence: 0.9 });
  // appraise 输出按强度排序（fresh 在前），但 applyCandidates 必须按 at 升序
  const { episodes } = applyCandidates([], [fresh, old], { now });
  const hurt = episodes.find((episode) => episode.kind === 'hurt');
  assert.equal(hurt.latestSourceEventId, 'new', '最新来源按事件时间，不按强度');
  assert.equal(hurt.contributions[0].sourceEventId, 'new');
  assert.equal(hurt.decayAnchorAt, now, 'anchor 是最后（最新）事件的时间');
});

test('applyCandidates：每条 episode 用自身 candidate.at 作为 anchor', () => {
  const now = Date.now();
  const { episodes } = applyCandidates([], [candidate({ kind: 'hurt', sourceEventId: 'a', at: now - 2 * HOUR, intensity: 0.5 })], { now });
  assert.equal(episodes[0].decayAnchorAt, now - 2 * HOUR, '不能用统一 options.now');
});

test('normalizeEventId：超长 eventId 折叠后不碰撞、同源仍幂等', () => {
  const longBase = 'x'.repeat(200);
  const id1 = normalizeEventId(`${longBase}a`);
  const id2 = normalizeEventId(`${longBase}b`);
  assert.notEqual(id1, id2, '超长 id 折叠后不能碰撞');
  assert.ok(id1.length <= 80);
  const now = Date.now();
  const { episodes } = applyCandidates([], [
    candidate({ kind: 'hurt', eventId: id1, sourceEventId: id1, at: now }),
    candidate({ kind: 'hurt', eventId: id1, sourceEventId: id1, at: now }),
  ], { now });
  const hurt = episodes.find((episode) => episode.kind === 'hurt');
  assert.equal(hurt.contributions.length, 1, '同源长 id 仍然幂等');
});

test('synthesizeMood：MIN_ACTIVE_INTENSITY 边界（=阈值 active、<阈值 inactive）', () => {
  const now = Date.now();
  const context = { mode: 'private', activeUid: 'A', now };
  const atThreshold = makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: MIN_ACTIVE_INTENSITY, decayAnchorAt: now });
  assert.equal(synthesizeMood({ episodes: [atThreshold], context }).episodeCount, 1, '等于阈值视为 active');
  const below = makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: MIN_ACTIVE_INTENSITY * 0.99, decayAnchorAt: now });
  assert.equal(synthesizeMood({ episodes: [below], context }).episodeCount, 0, '低于阈值视为完全衰减');
});

test('switchDominant：legacy 锚点同步即使 changed=false 也必须由调用方落盘', () => {
  const now = Date.now();
  const result = switchDominant({
    agentMood: { dominant: { kind: 'hurt', since: 0, intensity: 0.9 }, lastSwitchAt: 0, switchesThisTurn: 0, reverseSuppressUntil: 0, turnKey: null, inertia: 0.5 },
    episodes: [],
    context: { mode: 'private', activeUid: 'A', now },
    now,
    turnKey: 't',
  });
  assert.equal(result.changed, false);
  assert.equal(result.dominant.since, now, '即使 changed=false，调用方也必须合并该 since（1B 验收项）');
});

test('真实长 eventId 链：appraiseEvent → applyCandidates 两个不同后缀事件不合并', () => {
  const now = Date.now();
  const base = 'x'.repeat(200);
  const events = [
    { type: 'praised', actorUid: 'u1', eventId: `${base}a`, confidence: 0.9, at: now - 1000 },
    { type: 'praised', actorUid: 'u1', eventId: `${base}b`, confidence: 0.9, at: now },
  ];
  const candidates = appraiseEvent({ events });
  const joyCandidates = candidates.filter((c) => c.kind === 'joy');
  assert.equal(joyCandidates.length, 2, '两个长 id 事件各自产出候选');
  assert.notEqual(joyCandidates[0].sourceEventId, joyCandidates[1].sourceEventId, '折叠后仍不同');
  const { episodes } = applyCandidates([], candidates, { now });
  const joy = episodes.find((episode) => episode.kind === 'joy');
  assert.equal(joy.contributions.length, 2, '两个不同事件产生两条 contribution（不误合并）');
  assert.equal(joy.latestSourceEventId, normalizeEventId(`${base}b`), '最新来源按事件时间');
});

test('episode id 上限：长 uid fallback 与长 eventId 都 ≤96 且 normalize 后不变', () => {
  const now = Date.now();
  const longUid = 'u'.repeat(64);
  const fallbackId = makeEpisodeId({ kind: 'disappointment', target: { kind: 'other', uid: longUid }, now });
  assert.ok(fallbackId.length <= V2_EPISODE_ID_CHARS, `fallback id 长度 ${fallbackId.length}`);
  const fromFallback = normalizeEpisode({ id: fallbackId, kind: 'disappointment', target: { kind: 'other', uid: longUid }, decayAnchorAt: now }, now);
  assert.equal(fromFallback.id, fallbackId, 'normalize 不能改掉合法 id');
  const eventIdBased = makeEpisodeId({ kind: 'joy', target: { kind: 'other', uid: 'u1' }, now, sourceEventId: 'e'.repeat(200) });
  assert.ok(eventIdBased.length <= V2_EPISODE_ID_CHARS);
  assert.equal(normalizeEpisode({ id: eventIdBased, kind: 'joy', target: { kind: 'other', uid: 'u1' }, decayAnchorAt: now }, now).id, eventIdBased);
});

test('episode id：长 target 短化使用 64bit 摘要（前 12 相同也能区分）', () => {
  const now = Date.now();
  const common = 'u'.repeat(12);
  const a = makeEpisodeId({ kind: 'anger', target: { kind: 'other', uid: `${common}${'a'.repeat(52)}` }, now });
  const b = makeEpisodeId({ kind: 'anger', target: { kind: 'other', uid: `${common}${'b'.repeat(52)}` }, now });
  assert.notEqual(a, b, '前 12 相同、后缀不同的长 uid 必须生成不同 id');
  assert.ok(a.length <= V2_EPISODE_ID_CHARS);
});

test('normalizeEpisodes：共享 existingIds 连续冲突也能唯一', () => {
  const raw = { kind: 'joy', target: { kind: 'other', uid: 'A' }, decayAnchorAt: 1000 };
  const list = normalizeEpisodes([raw, raw, raw], { now: 1000 });
  assert.equal(list.length, 3);
  assert.equal(new Set(list.map((episode) => episode.id)).size, 3, '连续同 kind/target/anchor 也唯一');
});

test('normalizeEventId 幂等：normalize(normalize(x)) === normalize(x)', () => {
  const long = `${'z'.repeat(300)}tail`;
  const once = normalizeEventId(long);
  assert.equal(normalizeEventId(once), once);
  assert.ok(once.length <= 80);
});

test('synthesizeMood：同 kind 同强度全并列时按 id 确定性选 source', () => {
  const now = Date.now();
  const a = normalizeEpisode({ id: 'ep-a', kind: 'joy', target: { kind: 'other', uid: 'A' }, peak: 0.5, decayAnchorAt: now }, now);
  const b = normalizeEpisode({ id: 'ep-b', kind: 'joy', target: { kind: 'world' }, peak: 0.5, decayAnchorAt: now }, now);
  const mood = synthesizeMood({ episodes: [b, a], context: { mode: 'private', activeUid: 'A', now } });
  assert.equal(mood.dominant.sourceEpisodeId, 'ep-a', '全并列按 id 升序确定性选择（与输入顺序无关）');
});

test('applyCandidates：同 at 保持输入顺序（可复现）', () => {
  const now = Date.now();
  const a = candidate({ kind: 'hurt', sourceEventId: 'a', eventId: 'a', at: now });
  const b = candidate({ kind: 'hurt', sourceEventId: 'b', eventId: 'b', at: now });
  const r1 = applyCandidates([], [a, b], { now });
  const r2 = applyCandidates([], [b, a], { now });
  assert.equal(r1.episodes[0].contributions[0].sourceEventId, 'b', '[a,b] 时 b 最后写入');
  assert.equal(r2.episodes[0].contributions[0].sourceEventId, 'a', '[b,a] 时 a 最后写入');
});

test('switchDominant：sourceEpisodeId 悬空时退到同 kind 最高（不崩、不误切）', () => {
  const now = Date.now();
  const episodes = [
    makeEpisode({ kind: 'joy', target: { kind: 'other', uid: 'A' }, peak: 0.3, decayAnchorAt: now }),
    makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: 0.4, decayAnchorAt: now }),
  ];
  const result = switchDominant({
    agentMood: { dominant: { kind: 'joy', since: now, intensity: 0.9, sourceEpisodeId: 'ep-gone' }, lastSwitchAt: now - 5 * MINUTE, switchesThisTurn: 0, reverseSuppressUntil: 0, turnKey: 't', inertia: 0.5 },
    episodes,
    context: { mode: 'private', activeUid: 'A', now },
    now,
    turnKey: 't',
  });
  assert.equal(result.changed, false, '二级 joy(A)=0.3 → 阈值 0.45，anger 0.4 不应切');
});

test('synthesizeMood：MIN_ACTIVE 浮点邻近（下一可表示值视为 inactive）', () => {
  const now = Date.now();
  const below = MIN_ACTIVE_INTENSITY * (1 - 1e-12);
  assert.ok(below < MIN_ACTIVE_INTENSITY);
  const episode = makeEpisode({ kind: 'anger', target: { kind: 'other', uid: 'A' }, peak: below, decayAnchorAt: now });
  assert.equal(synthesizeMood({ episodes: [episode], context: { mode: 'private', activeUid: 'A', now } }).episodeCount, 0);
});

test('createEmptyAgentMood：结构完整、episodes 为空、baseline 合法', () => {
  const mood = createEmptyAgentMood({ now: 1 });
  assert.equal(mood.schemaVersion, 2);
  assert.deepEqual(mood.episodes, []);
  assert.equal(mood.dominant, null);
  assert.equal(mood.baseline.valence, 0);
  assert.ok(mood.baseline.arousal >= 0 && mood.baseline.arousal <= 1);
  assert.ok(Array.isArray(mood.pendingFacts));
});
