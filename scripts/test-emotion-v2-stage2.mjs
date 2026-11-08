// 阶段 2：快慢双通道 + 切换曲线 tuning + per-kind 半衰期（纯函数单测）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMOTION_KINDS,
  DEFAULT_TUNING,
  episodeChannelIntensity,
  episodeIntensityAt,
  synthesizeMood,
  switchDominant,
} from '../src/core/mood-v2.mjs';

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function episode(over = {}) {
  return {
    id: 'ep-' + Math.random().toString(16).slice(2, 8),
    kind: 'joy',
    target: { kind: 'other', uid: '1' },
    peak: 0.8,
    decayAnchorAt: NOW,
    latestSourceEventId: 'evt-1',
    ...over,
  };
}

test('双通道：fast 按 kind 半衰期衰减，slow 按 slowFactor 更慢（默认 6）', () => {
  const ep = episode({ peak: 0.8, decayAnchorAt: NOW - 60 * MINUTE }); // joy halfLife 90min
  const { fast, slow } = episodeChannelIntensity(ep, NOW);
  assert.ok(Math.abs(fast - 0.8 * 0.5 ** (60 / 90)) < 1e-9, 'fast 必须按 90min 半衰期');
  assert.ok(Math.abs(slow - 0.8 * 0.5 ** (60 / (90 * 6))) < 1e-9, 'slow 必须按 halfLife×6');
  assert.ok(slow > fast, '慢通道必须比快通道保留更多');
  // 与既有 episodeIntensityAt 兼容：fast 等于它
  assert.ok(Math.abs(fast - episodeIntensityAt(ep, NOW)) < 1e-9);
});

test('per-kind 半衰期配置覆盖：tuning.halfLifeByKind 优先于内置表', () => {
  const ep = episode({ kind: 'sadness', peak: 0.8, decayAnchorAt: NOW - 60 * MINUTE });
  const builtin = episodeChannelIntensity(ep, NOW);
  const overridden = episodeChannelIntensity(ep, NOW, { halfLifeByKind: { sadness: 10 * MINUTE } });
  assert.ok(overridden.fast < builtin.fast, '缩短半衰期必须衰减更快');
  assert.ok(overridden.slow < builtin.slow);
});

test('slowFactor 边界：非法值回退默认 6，24 为最慢', () => {
  const ep = episode({ peak: 0.8, decayAnchorAt: NOW - 120 * MINUTE });
  const invalid = episodeChannelIntensity(ep, NOW, { slowFactor: 1 });
  assert.ok(Math.abs(invalid.slow - 0.8 * 0.5 ** (120 / (90 * 6))) < 1e-9, 'slowFactor=1 非法 → 回退 6');
  const slow24 = episodeChannelIntensity(ep, NOW, { slowFactor: 24 });
  assert.ok(slow24.slow > invalid.slow);
});

test('synthesizeMood：slowValence 用慢通道加权（快情绪衰减后背景仍偏正）', () => {
  const episodes = [
    episode({ kind: 'joy', peak: 0.8, decayAnchorAt: NOW - 2 * HOUR }),
    episode({ kind: 'sadness', peak: 0.5, decayAnchorAt: NOW - 2 * HOUR }),
  ];
  const view = synthesizeMood({ episodes, context: { mode: 'private', activeUid: '1', now: NOW }, tuning: null });
  assert.ok(Number.isFinite(view.slowValence));
  // joy 半衰期 90min（2h 后衰减多），sadness 8h；慢通道下 joy 保留相对更多 → slowValence > fast valence
  assert.ok(view.slowValence > view.valence, `slowValence(${view.slowValence}) 应大于 valence(${view.valence})`);
  // 无 episode → 0
  const empty = synthesizeMood({ episodes: [], context: { mode: 'private', activeUid: '1', now: NOW } });
  assert.equal(empty.slowValence, 0);
});

test('synthesizeMood 默认参数：valence/arousal/energy/mix/dominant 与 1A 行为一致（回归）', () => {
  const episodes = [episode({ kind: 'joy', peak: 0.8, decayAnchorAt: NOW - 30 * MINUTE })];
  const view = synthesizeMood({ episodes, context: { mode: 'private', activeUid: '1', now: NOW } });
  assert.equal(view.dominant.kind, 'joy');
  assert.ok(view.mix.length > 0);
  assert.equal(view.episodeCount, 1);
  assert.ok(view.valence > 0.5);
});

test('switchDominant：默认 maxSwitchesPerTurn=1 / minDwell 60s 限制同日切换', () => {
  const episodes = [
    episode({ kind: 'sadness', peak: 0.8, decayAnchorAt: NOW - MINUTE }),
    episode({ kind: 'anger', peak: 0.9, decayAnchorAt: NOW - MINUTE }),
  ];
  const agentMood = { schemaVersion: 2, episodes, dominant: { kind: 'joy', intensity: 0.3, since: NOW - 10 * MINUTE, sourceEpisodeId: null }, lastSwitchAt: 0, switchesThisTurn: 0, turnKey: null, inertia: 0.5 };
  const first = switchDominant({ agentMood, context: { mode: 'private', activeUid: '1' }, episodes, now: NOW, turnKey: 'turn-1' });
  assert.equal(first.changed, true, '首次切换允许');
  const second = switchDominant({ agentMood: { ...agentMood, dominant: first.dominant, lastSwitchAt: first.lastSwitchAt, switchesThisTurn: first.switchesThisTurn, turnKey: first.turnKey }, context: { mode: 'private', activeUid: '1' }, episodes, now: NOW + 1000, turnKey: 'turn-1' });
  assert.equal(second.changed, false, '默认每 turn 只切一次（且 minDwell 60s）');
});

test('switchDominant：tuning.switch 调参生效（maxSwitchesPerTurn=3 / minDwell=0 / floor=0）', () => {
  const tuning = { switch: { floor: 0, minDwellMs: 0, maxSwitchesPerTurn: 3, reverseSuppressMs: 0 } };
  const context = { mode: 'private', activeUid: '1' };
  const baseMood = { schemaVersion: 2, dominant: { kind: 'joy', intensity: 0.1, since: NOW - 10 * MINUTE, sourceEpisodeId: null }, lastSwitchAt: 0, switchesThisTurn: 0, turnKey: null, inertia: 0 };
  const eSad = episode({ kind: 'sadness', peak: 0.8, decayAnchorAt: NOW - MINUTE });
  const eAnger = episode({ kind: 'anger', peak: 0.9, decayAnchorAt: NOW - MINUTE });
  const eHurt = episode({ kind: 'hurt', peak: 0.95, decayAnchorAt: NOW - MINUTE });
  const first = switchDominant({ agentMood: baseMood, context, episodes: [eSad], now: NOW, turnKey: 'turn-x', tuning });
  assert.equal(first.changed, true, '第 1 次切换');
  const second = switchDominant({ agentMood: { ...baseMood, dominant: first.dominant, lastSwitchAt: first.lastSwitchAt, switchesThisTurn: first.switchesThisTurn, turnKey: first.turnKey }, context, episodes: [eSad, eAnger], now: NOW + 10, turnKey: 'turn-x', tuning });
  assert.equal(second.changed, true, 'maxSwitchesPerTurn=3 + minDwell=0 + suppress=0 允许同 turn 再切');
  const third = switchDominant({ agentMood: { ...baseMood, dominant: second.dominant, lastSwitchAt: second.lastSwitchAt, switchesThisTurn: second.switchesThisTurn, turnKey: second.turnKey }, context, episodes: [eAnger, eHurt], now: NOW + 20, turnKey: 'turn-x', tuning });
  assert.equal(third.changed, true, '允许第 3 次切换');
  const fourth = switchDominant({ agentMood: { ...baseMood, dominant: third.dominant, lastSwitchAt: third.lastSwitchAt, switchesThisTurn: third.switchesThisTurn, turnKey: third.turnKey }, context, episodes: [eHurt, episode({ kind: 'fear', peak: 1, decayAnchorAt: NOW - MINUTE })], now: NOW + 30, turnKey: 'turn-x', tuning });
  assert.equal(fourth.changed, false, '第 4 次超过 maxSwitchesPerTurn=3');
});

test('switchDominant：floor 调高后弱情绪不触发切换', () => {
  const context = { mode: 'private', activeUid: '1' };
  const episodes = [episode({ kind: 'sadness', peak: 0.24, decayAnchorAt: NOW - MINUTE })];
  const agentMood = { schemaVersion: 2, episodes, dominant: { kind: 'joy', intensity: 0.1, since: NOW - 10 * MINUTE }, lastSwitchAt: 0, switchesThisTurn: 0, turnKey: null, inertia: 0.5 };
  const blocked = switchDominant({ agentMood, context, episodes, now: NOW, turnKey: 't', tuning: { switch: { floor: 0.25 } } });
  assert.equal(blocked.changed, false, '0.24 不大于 floor 0.25');
  const allowed = switchDominant({ agentMood, context, episodes, now: NOW, turnKey: 't2', tuning: { switch: { floor: 0.1 } } });
  assert.equal(allowed.changed, true);
});

test('DEFAULT_TUNING 形状与默认值', () => {
  assert.equal(DEFAULT_TUNING.slowFactor, 6);
  assert.equal(DEFAULT_TUNING.switch.floor, 0.25);
  assert.equal(DEFAULT_TUNING.switch.minDwellMs, 60 * 1000);
  assert.equal(DEFAULT_TUNING.switch.maxSwitchesPerTurn, 1);
  assert.ok(EMOTION_KINDS.joy.halfLifeMs > 0);
});

test('adapter：getTuning 生效——per-kind override 让 currentIntensity/mix 数值不同', async () => {
  const { createSocialV2Adapter } = await import('../src/core/socialv2-adapter.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const episodeData = { kind: 'joy', target: { kind: 'other', uid: '1' }, peak: 0.8, decayAnchorAt: NOW - 60 * MINUTE };
  const state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [episodeData] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const make = (tuning) => createSocialV2Adapter({ getState: () => state, setState: () => {}, save: () => {}, memory: null, now: () => NOW, getTuning: tuning ? () => tuning : null });
  const plain = make(null).getMood('private:1');
  const tuned = make({ halfLifeByKind: { joy: 10 * MINUTE } }).getMood('private:1');
  // joy 60min 前：默认 90min 半衰期 → 0.8×0.5^(60/90)=0.504；override 10min → 0.8×0.5^6≈0.0125
  assert.ok(plain.valence > 0.9, '默认半衰期下 valence 接近 1（单情绪）');
  const plainMood = make(null).getMood('private:1');
  const plainIntensity = plain.mix[0]?.intensity ?? 0;
  const tunedIntensity = tuned.mix[0]?.intensity ?? 0;
  assert.ok(plainIntensity > 0.4, `默认 mix 强度应约 0.5，实际 ${plainIntensity}`);
  assert.ok(tunedIntensity < 0.1, `override 后 mix 强度应约 0.01，实际 ${tunedIntensity}`);
  assert.ok(Number.isFinite(tuned.slowValence), 'slowValence 必须存在');
});
test('tuning 校验：非法 slowFactor/halfLife/switch 回退默认', () => {
  // 纯函数层：episodeChannelIntensity 对非法 slowFactor 回退 6（已在前面测）；这里验证 switch 非法值回退
  const episodes = [episode({ kind: 'sadness', peak: 0.8, decayAnchorAt: NOW - MINUTE })];
  const agentMood = { schemaVersion: 2, episodes, dominant: { kind: 'joy', intensity: 0.1, since: NOW - 10 * MINUTE }, lastSwitchAt: 0, switchesThisTurn: 0, turnKey: null, inertia: 0.5 };
  const blocked = switchDominant({ agentMood, context: { mode: 'private', activeUid: '1' }, episodes, now: NOW, turnKey: 't', tuning: { switch: { floor: 99, minDwellMs: -5, maxSwitchesPerTurn: 0 } } });
  // 非法 floor 回退 0.25：0.8 > 0.25 允许切
  assert.equal(blocked.changed, true);
});

test('slow 通道独立 active：fast 完全衰减后 slowValence 仍保留背景心情', () => {
  // anger 半衰期 15min：240min 后 fast≈1.2e-5（< MIN_ACTIVE_INTENSITY），slow（×6=90min）≈0.126
  const ep = episode({ kind: 'anger', peak: 0.8, decayAnchorAt: NOW - 240 * MINUTE });
  const view = synthesizeMood({ episodes: [ep], context: { mode: 'private', activeUid: '1', now: NOW } });
  assert.equal(view.episodeCount, 0, 'fast 已 inactive（mix 为空）');
  assert.ok(Math.abs(view.slowValence - (-0.6)) < 1e-6 || view.slowValence < -0.5, `slowValence 应保留负性背景，实际 ${view.slowValence}`);
});

test('旧 episode 缺 halfLifeMs：kind fallback（阶段 2 语义升级，§4.10）', () => {
  // 旧数据无 halfLifeMs：应使用 kind 表（sadness 8h），而不是 1h
  const ep = { kind: 'sadness', target: { kind: 'other', uid: '1' }, peak: 0.8, decayAnchorAt: NOW - 4 * HOUR, confidence: 0.8, contributions: [] };
  const fast = episodeIntensityAt(ep, NOW);
  assert.ok(Math.abs(fast - 0.8 * 0.5 ** (4 / 8)) < 1e-6, '必须按 sadness 8h 半衰期，而不是 1h');
});

test('生产事件管线：adapter.applyEmotionEvent 传入 tuning.switch 后同 turn 多次切换', async () => {
  const { createSocialV2Adapter } = await import('../src/core/socialv2-adapter.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  let state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const tuning = { switch: { floor: 0, minDwellMs: 0, maxSwitchesPerTurn: 3, reverseSuppressMs: 0 } };
  const adapter = createSocialV2Adapter({
    getState: () => state, setState: (next) => { state = next; }, save: () => {}, memory: null, now: () => NOW,
    getTuning: () => tuning,
  });
  const first = adapter.applyEmotionEvent('private:1', { type: 'praised', quote: '你真棒', at: NOW, eventId: 'evt-a' });
  assert.equal(first.ok, true);
  const afterFirst = state.agentMood.dominant?.kind;
  assert.ok(afterFirst, '首次事件必须产生 dominant');
  // 第二种情绪事件（同一 turn 窗口内）：tuning 允许再切
  const second = adapter.applyEmotionEvent('private:1', { type: 'frightened', quote: '好可怕', at: NOW + 1000, eventId: 'evt-b' });
  assert.equal(second.ok, true);
  assert.ok(state.agentMood.lastSwitchAt > 0, '必须发生切换（tuning 生效，lastSwitchAt 被写入）');
});

test('switchDominant：per-kind half-life override 影响切换判定（tuned/untuned 数值差异）', () => {
  const context = { mode: 'private', activeUid: '1' };
  const ep = episode({ kind: 'anger', peak: 0.6, decayAnchorAt: NOW - 20 * MINUTE });
  const agentMood = { schemaVersion: 2, episodes: [ep], dominant: { kind: 'joy', intensity: 0.1, since: NOW - 30 * MINUTE }, lastSwitchAt: 0, switchesThisTurn: 0, turnKey: null, inertia: 0 };
  // anger 内置 15min：0.6×0.5^(20/15)=0.238；floor 0.25 → 不切
  const untuned = switchDominant({ agentMood, context, episodes: [ep], now: NOW, turnKey: 't', tuning: { switch: { floor: 0.25, minDwellMs: 0, reverseSuppressMs: 0, maxSwitchesPerTurn: 3 } } });
  assert.equal(untuned.changed, false, '内置 15min：0.238 < floor 0.25');
  // override 30min：0.6×0.5^(20/30)=0.378 > floor 0.25 → 切换
  const tuned = switchDominant({ agentMood, context, episodes: [ep], now: NOW, turnKey: 't2', tuning: { halfLifeByKind: { anger: 30 * MINUTE }, switch: { floor: 0.25, minDwellMs: 0, reverseSuppressMs: 0, maxSwitchesPerTurn: 3 } } });
  assert.equal(tuned.changed, true, 'override 30min：0.378 > floor 0.25');
});

test('pending retry：真实 memory 失败 → pending → 重试成功，非空 candidates 重放', async () => {
  const { applyFactPipeline, retryPendingFacts } = await import('../src/core/socialv2-exec.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const base = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const events = new Map();
  let failNext = true;
  const memory = {
    appendEventWithId(entry) {
      if (failNext) { failNext = false; return { ok: false, code: 'IO' }; }
      if (events.has(entry.id)) return { ok: true, duplicate: true };
      events.set(entry.id, entry);
      return { ok: true };
    },
    findEventByStableId: (id) => (events.has(id) ? { found: true, entry: events.get(id) } : { found: false, unknown: false }),
  };
  const tuning = { halfLifeByKind: { joy: 10 * MINUTE } };
  const event = { eventId: 'evt-retry-2', type: 'praised', quote: '你真棒', contextKey: 'private:1', at: NOW };
  const first = applyFactPipeline({ state: base, event, memory, now: NOW, writeCheckpoint: () => {}, tuning });
  const pending = first.state.agentMood.pendingFacts ?? [];
  assert.ok(pending.length > 0, 'memory 失败必须建立 pending');
  assert.ok(Array.isArray(pending[0].payload?.candidates) && pending[0].payload.candidates.length > 0, 'pending payload 必须含非空 candidates');
  // 重试：memory 恢复 → 重放 candidates → 产生 episode 与 dominant
  const retried = retryPendingFacts({ state: first.state, memory, now: NOW + 2 * 60 * 1000, tuning }); // 超过首次重试退避
  assert.equal(retried.retried, 1);
  assert.ok(retried.state.agentMood.episodes.length > 0, '重放必须应用 candidates');
  assert.ok(retried.state.agentMood.dominant?.kind, '重放后必须有 dominant');
});

test('bridge config → detail：tuning 注入链路（默认 ≈0.504 vs joy=10min ≈0.0125）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const http = await import('node:http');
  const NOWT = Date.now();
  const v2State = {
    version: 2, paused: false,
    agentMood: { schemaVersion: 2, episodes: [{ id: 'ep-joy', kind: 'joy', peak: 0.8, decayAnchorAt: NOWT - 60 * 60 * 1000, target: { kind: 'other', uid: '1' }, latestSourceEventId: 'evt-1', appraisalNote: '被夸' }] },
    relationships: { 1: { generationId: 'g', intimacy: 0.1, tension: 0, trust: 0.5, openLoops: [], events: [] } },
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    pendingArchive: null,
    migration: { version: 2, fromVersion: 1, status: 'done', revision: 1 },
    conversations: { 'private:1': { recentMessages: [], wakeConfig: {} } },
  };
  const fetchDetail = async (h) => {
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    try {
      return await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/emotion/detail?key=private%3A1', method: 'GET', headers: { 'x-console-token': 'fixture-console-token' } }, (res) => {
          let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
        });
        req.on('error', reject); req.end();
      });
    } finally { await new Promise((resolve) => server.close(resolve)); }
  };
  const baseCfg = { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } };
  const plainHarness = await bridgeHarness({ config: baseCfg, files: { 'state/social-v2.json': JSON.stringify(v2State) } });
  const plain = await fetchDetail(plainHarness);
  await plainHarness.close();
  const tunedHarness = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2', tuning: { halfLifeByKind: { joy: 10 * 60 * 1000 } } } } }, files: { 'state/social-v2.json': JSON.stringify(v2State) } });
  const tuned = await fetchDetail(tunedHarness);
  await tunedHarness.close();
  const plainIntensity = plain.agentMood.episodes[0]?.currentIntensity ?? 0;
  const tunedIntensity = tuned.agentMood.episodes[0]?.currentIntensity ?? 0;
  assert.ok(plainIntensity > 0.4 && plainIntensity < 0.6, `默认应约 0.504，实际 ${plainIntensity}`);
  assert.ok(tunedIntensity < 0.05, `override 后应约 0.0125，实际 ${tunedIntensity}`);
});

test('bridge sanitizeTuning：非整数 maxSwitchesPerTurn=3.7 → 回退默认 1 + 告警', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2', tuning: { switch: { maxSwitchesPerTurn: 3.7 } } } } } });
  try {
    const tuning = h.cfg.emotion.v2.tuning;
    assert.equal(tuning.switch.maxSwitchesPerTurn, 1, '非整数必须回退默认 1');
    assert.ok(Array.isArray(tuning.warnings) && tuning.warnings.some((w) => w.includes('maxSwitchesPerTurn')), '必须产生告警');
  } finally {
    await h.close();
  }
});
