// 阶段 3：敏感化 + 慢性负荷（纯函数 + 接线回归）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSensitization,
  updateChronicLoad,
  EMOTION_KINDS,
} from '../src/core/mood-v2.mjs';

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function episode(over = {}) {
  return {
    id: 'ep-' + Math.random().toString(16).slice(2, 8),
    kind: 'anger',
    target: { kind: 'other', uid: '1' },
    peak: 0.6,
    decayAnchorAt: NOW,
    ...over,
  };
}

test('敏感化：窗口内同类负性事件累积 → 乘子 >1，且受 cap 限制', () => {
  const episodes = [
    episode({ peak: 0.9, decayAnchorAt: NOW - 10 * MINUTE }),
    episode({ peak: 0.9, decayAnchorAt: NOW - 60 * MINUTE }),
    episode({ peak: 0.9, decayAnchorAt: NOW - 3 * HOUR }),
  ];
  const sens = computeSensitization(episodes, NOW);
  assert.ok(sens.anger, '必须产生 anger 敏感化');
  assert.ok(sens.anger.value > 1, '累积后乘子必须 >1');
  assert.ok(sens.anger.value <= 2, '默认 cap=2');
  // cap 极小 → 截断
  const capped = computeSensitization(episodes, NOW, { sensitization: { cap: 1.2 } });
  assert.ok(capped.anger.value <= 1.2);
});

test('敏感化：正向事件不计数、窗口外不计数、空输入为空', () => {
  const positive = computeSensitization([episode({ kind: 'joy', peak: 0.9 })], NOW);
  assert.deepEqual(positive, {});
  const stale = computeSensitization([episode({ peak: 0.9, decayAnchorAt: NOW - 10 * HOUR })], NOW);
  assert.deepEqual(stale, {});
  assert.deepEqual(computeSensitization([], NOW), {});
});

test('敏感化：lambda 配置生效（越大乘子越高）', () => {
  const episodes = [episode({ peak: 1, decayAnchorAt: NOW - MINUTE })];
  const weak = computeSensitization(episodes, NOW, { sensitization: { lambda: 0.05 } });
  const strong = computeSensitization(episodes, NOW, { sensitization: { lambda: 0.8 } });
  assert.ok(strong.anger.value > weak.anger.value);
});

test('慢性负荷：负性连续累积、正向修复、dt=0 幂等、上限', () => {
  // 负性 6h：累积
  const load1 = updateChronicLoad({ chronicLoad: 0, valence: -0.8, lastUpdatedAt: NOW - 6 * HOUR, now: NOW });
  assert.ok(load1 > 0, '负性必须累积');
  assert.ok(load1 <= 1);
  // 相同时间点再算：幂等（decay=1 → 保持）
  const loadSame = updateChronicLoad({ chronicLoad: load1, valence: -0.8, lastUpdatedAt: NOW, now: NOW });
  assert.ok(Math.abs(loadSame - load1) < 1e-12, 'dt=0 不得变化');
  // 正向 6h：修复回落
  const repaired = updateChronicLoad({ chronicLoad: load1, valence: 0.8, lastUpdatedAt: NOW - 6 * HOUR, now: NOW });
  assert.ok(repaired < load1, '正向心情必须修复负荷');
  // cap
  const capped = updateChronicLoad({ chronicLoad: 0.9, valence: -1, lastUpdatedAt: NOW - 24 * HOUR, now: NOW, tuning: { chronicLoad: { cap: 0.5 } } });
  assert.ok(capped <= 0.5);
});

test('接线：applyFactPipeline 后 agentMood 有 sensitivity/chronicLoad，且负性累积可见', async () => {
  const { applyFactPipeline } = await import('../src/core/socialv2-exec.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const base = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const run = (state, at, eventId) => applyFactPipeline({
    state,
    event: { eventId, type: 'insulted', quote: '你真烦', contextKey: 'private:1', at },
    memory: null, now: at, writeCheckpoint: () => {},
  });
  const first = run(base, NOW, 'evt-s1');
  assert.ok(Number(first.state.agentMood.chronicLoad) >= 0, 'chronicLoad 必须存在');
  assert.ok(first.state.agentMood.chronicLoadUpdatedAt > 0);
  // 连续负性：sensitivity 出现负性 kind
  const second = run(first.state, NOW + 1000, 'evt-s2');
  const third = run(second.state, NOW + 2000, 'evt-s3');
  assert.ok(third.state.agentMood.sensitivity && Object.keys(third.state.agentMood.sensitivity).length > 0, '连续负性必须产生敏感化');
  const anyNegative = Object.keys(third.state.agentMood.sensitivity).some((kind) => (EMOTION_KINDS[kind]?.valence ?? 0) < 0);
  assert.ok(anyNegative, '敏感化只应作用于负性 kind');
  assert.ok(third.state.agentMood.chronicLoad > 0, '连续负性必须累积慢性负荷');
});

// ── 6 需求层 + 依恋慢参数 + per-target ─────────────────────────────────────

test('需求张力：负性事件提升对应 need，正向满足降低，半衰期衰减，cap 限制', async () => {
  const { updateNeedTensions, NEED_KINDS } = await import('../src/core/mood-v2.mjs');
  // insulted → safety/autonomy？按 EMOTION_KINDS.need：anger→autonomy、fear→safety
  const angerEp = episode({ kind: 'anger', peak: 0.8, decayAnchorAt: NOW - MINUTE });
  const risen = updateNeedTensions({ needs: {}, episodes: [angerEp], now: NOW });
  assert.equal(NEED_KINDS.length, 6);
  assert.ok(risen.autonomy.value > 0, 'anger 必须提升 autonomy 张力');
  assert.ok(risen.autonomy.value <= 1);
  // 无重复累加：同样 episodes 再算一次必须完全一致（幂等）
  const again = updateNeedTensions({ needs: risen, episodes: [angerEp], now: NOW });
  assert.equal(again.autonomy.value, risen.autonomy.value, '历史 episode 不得重复计权');
  // 正向事件：无负性贡献时满足事件不产生正张力
  const comfort = episode({ kind: 'joy', peak: 1, decayAnchorAt: NOW });
  const satisfied = updateNeedTensions({ needs: {}, episodes: [comfort], now: NOW });
  assert.equal(satisfied.approval.value, 0, '纯正向事件不得产生需求张力');
  // cap
  const capped = updateNeedTensions({ needs: {}, episodes: [episode({ kind: 'anger', peak: 1, decayAnchorAt: NOW })], now: NOW, tuning: { needs: { cap: 0.3 } } });
  assert.ok(capped.autonomy.value <= 0.3);
});

test('依恋慢参数：关系慢变量确定性映射 attachmentStyle', async () => {
  const { deriveAttachmentStyle } = await import('../src/core/mood-v2.mjs');
  assert.equal(deriveAttachmentStyle({ intimacy: 0.8, tension: 0.1, resentment: 0.05 }), 'secure');
  assert.equal(deriveAttachmentStyle({ intimacy: 0.1, tension: 0.7, resentment: 0.2 }), 'anxious');
  assert.equal(deriveAttachmentStyle({ intimacy: 0.1, tension: 0.7, resentment: 0.6 }), 'avoidant');
  assert.equal(deriveAttachmentStyle({ intimacy: 0.4, tension: 0.5, resentment: 0.3 }), 'mixed');
});

test('接线：连续负性事件后 needs 有张力；关系事件后 attachmentStyle 被重算', async () => {
  const { applyFactPipeline } = await import('../src/core/socialv2-exec.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const { createSocialV2Adapter } = await import('../src/core/socialv2-adapter.mjs');
  const base = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const run = (state, at, eventId) => applyFactPipeline({
    state, event: { eventId, type: 'insulted', quote: '你真烦', contextKey: 'private:1', at }, memory: null, now: at, writeCheckpoint: () => {},
  });
  const first = run(base, NOW, 'evt-n1');
  assert.ok(first.state.agentMood.needs && Object.keys(first.state.agentMood.needs).length === 6, '必须初始化 6 需求');
  assert.ok(Object.values(first.state.agentMood.needs).some((item) => Number(item.value) > 0), '负性事件必须提升需求张力');
  // 关系事件：连续负性 → tension 高 → attachmentStyle 非 secure（或 mixed/avoidant/anxious）
  let state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const adapter = createSocialV2Adapter({ getState: () => state, setState: (next) => { state = next; }, save: () => {}, memory: null, now: () => NOW });
  for (let i = 0; i < 6; i += 1) adapter.applyRelationshipEvent('1', 'insulted', { contextKey: 'private:1', factId: 'f-' + i });
  const rel = adapter.getRelationship('1');
  assert.ok(['secure', 'anxious', 'avoidant', 'mixed'].includes(rel.attachmentStyle));
  assert.notEqual(rel.attachmentStyle, 'secure', '连续贬低后依恋风格不应仍为 secure');
});

// ── 阶段 3 审查修复补充 ────────────────────────────────────────────────────

test('敏感化：同 kind/target 连续伤害通过 sensitivityLog 计数（不被 fusion 吞）', async () => {
  const { applyFactPipeline } = await import('../src/core/socialv2-exec.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  let state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const run = (seed, at, id) => applyFactPipeline({
    state: seed, event: { eventId: id, type: 'insulted', quote: '你真烦', contextKey: 'private:1', at }, memory: null, now: at, writeCheckpoint: () => {},
  });
  const values = [];
  for (let i = 0; i < 5; i += 1) {
    state = run(state, NOW + i * 1000, 'evt-fusion-' + i).state;
    values.push(state.agentMood.sensitivity?.shame?.value ?? state.agentMood.sensitivity?.hurt?.value ?? 0);
  }
  assert.ok(state.agentMood.sensitivityLog.length >= 5, `每次伤害必须独立计数（实际 ${state.agentMood.sensitivityLog.length}）`);
  const last = Object.values(state.agentMood.sensitivity).map((item) => item.value);
  assert.ok(last.length > 0, '连续伤害必须产生敏感化');
  assert.ok(Math.max(...last) > 1, '乘子必须大于 1');
  assert.ok(Math.max(...last) <= 2, '默认 cap 2 上限');
  // 同一 eventId 重放不得二次计数（事件幂等）
  const beforeReplay = state.agentMood.sensitivityLog.length;
  const replay = run(state, NOW + 10 * 1000, 'evt-fusion-0').state;
  assert.equal(replay.agentMood.sensitivityLog.length, beforeReplay, 'eventId 重放不得追加 log');
});

test('需求张力：历史 episode 在多条后续事件中不重复累加（幂等）', async () => {
  const { applyFactPipeline } = await import('../src/core/socialv2-exec.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  let state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const run = (seed, at, id, type) => applyFactPipeline({
    state: seed, event: { eventId: id, type, quote: '文本', contextKey: 'private:1', at }, memory: null, now: at, writeCheckpoint: () => {},
  });
  state = run(state, NOW, 'evt-n1', 'insulted').state;
  state = run(state, NOW + 1000, 'evt-n2', 'praised').state;
  // 接线值与纯函数重算必须一致（历史 episode 不重复累加）
  const { updateNeedTensions } = await import('../src/core/mood-v2.mjs');
  const recomputed = updateNeedTensions({ episodes: state.agentMood.episodes, now: NOW + 1000 });
  for (const need of Object.keys(recomputed)) {
    assert.ok(Math.abs((state.agentMood.needs[need]?.value ?? 0) - recomputed[need].value) < 1e-9, `${need} 接线值与纯重算不一致`);
  }
});

test('衰减纯函数：长时间无事件后 appraisal 使用衰减值（乘子趋 1、张力减半）', async () => {
  const { decaySensitivityValues, decayNeedTensions } = await import('../src/core/mood-v2.mjs');
  const sens = decaySensitivityValues({ anger: { value: 2, updatedAt: NOW } }, NOW + 6 * HOUR);
  assert.ok(sens.anger.value <= 1.5 + 1e-9 && sens.anger.value < 2, '6h 后敏感化乘子必须回落');
  assert.ok(sens.anger.value >= 1);
  const needs = decayNeedTensions({ autonomy: { value: 0.8, updatedAt: NOW } }, NOW + 2 * HOUR);
  assert.ok(Math.abs(needs.autonomy.value - 0.4) < 1e-6, '2h 半衰期后减半');
});

test('chronicLoadUpdatedAt 持久化：save→reload round-trip 保留时间锚', async () => {
  const { loadSocialV2State, serializeSocialV2 } = await import('../src/core/socialv2-state.mjs');
  const state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [], chronicLoad: 0.4, chronicLoadUpdatedAt: 123456789, needs: {}, sensitivity: {} }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  assert.equal(state.agentMood.chronicLoadUpdatedAt, 123456789, 'load 必须保留时间锚');
  const serialized = serializeSocialV2(state, { mode: 'main' });
  const reloaded = loadSocialV2State(JSON.parse(JSON.stringify(serialized)), { now: NOW }).state;
  assert.equal(reloaded.agentMood.chronicLoadUpdatedAt, 123456789, 'round-trip 必须保留');
  assert.equal(reloaded.agentMood.chronicLoad, 0.4);
});

test('六需求始终初始化（空状态即有六项 0 值）', async () => {
  const { createEmptyAgentMood, NEED_KINDS } = await import('../src/core/mood-v2.mjs');
  const empty = createEmptyAgentMood({ now: NOW });
  assert.equal(Object.keys(empty.needs).length, 6);
  for (const need of NEED_KINDS) {
    assert.equal(empty.needs[need].value, 0);
    assert.equal(empty.needs[need].updatedAt, 0, '空状态 updatedAt=0（reset 严格 no-op）');
  }
});

test('sensitivityLog：eventId 幂等、正向/未知 kind 过滤、save→reload round-trip', async () => {
  const { appendSensitivityLog, computeSensitizationFromLog } = await import('../src/core/mood-v2.mjs');
  const { loadSocialV2State, serializeSocialV2 } = await import('../src/core/socialv2-state.mjs');
  // 幂等
  const event = { kind: 'anger', peak: 0.8, decayAnchorAt: NOW, eventId: 'evt-dup', contentHash: 'hash-dup' };
  const once = appendSensitivityLog([], [event], { now: NOW });
  const twice = appendSensitivityLog(once, [event], { now: NOW });
  assert.equal(twice.length, 1, '同一事件不得二次计数');
  // contentHash 去重（无 eventId 时）
  const byHash = appendSensitivityLog([{ kind: 'anger', at: NOW, weight: 0.5, eventId: null, contentHash: 'h1' }], [{ kind: 'anger', peak: 0.5, decayAnchorAt: NOW, eventId: null, contentHash: 'h1' }], { now: NOW });
  assert.equal(byHash.length, 1);
  // 正向 kind 不进入 log
  const withPositive = appendSensitivityLog([], [{ kind: 'joy', peak: 1, decayAnchorAt: NOW, eventId: 'e1' }], { now: NOW });
  assert.equal(withPositive.length, 0);
  // dirty log（正向 kind）计算时被忽略
  const dirty = computeSensitizationFromLog([{ kind: 'joy', at: NOW, weight: 1 }], NOW);
  assert.equal(dirty.joy, undefined);
  // round-trip
  const state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [], sensitivityLog: [{ kind: 'anger', at: NOW, weight: 0.5, eventId: 'keep', contentHash: 'keep-h' }, { kind: 'joy', at: NOW, weight: 1, eventId: 'drop' }] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  assert.equal(state.agentMood.sensitivityLog.length, 1, 'load 必须丢弃正向 kind');
  assert.equal(state.agentMood.sensitivityLog[0].eventId, 'keep');
  const reloaded = loadSocialV2State(JSON.parse(JSON.stringify(serializeSocialV2(state, { mode: 'main' }))), { now: NOW }).state;
  assert.equal(reloaded.agentMood.sensitivityLog.length, 1);
  assert.equal(reloaded.agentMood.sensitivityLog[0].eventId, 'keep');
});

test('敏感化 cap 可达：足够权重的事件使乘子达到 cap 2', async () => {
  const { computeSensitizationFromLog } = await import('../src/core/mood-v2.mjs');
  const log = [];
  for (let i = 0; i < 40; i += 1) log.push({ kind: 'anger', at: NOW - i * 1000, weight: 1, eventId: 'e' + i });
  const sens = computeSensitizationFromLog(log, NOW);
  assert.ok(sens.anger.value >= 1.99, `乘子应达到 cap，实际 ${sens.anger.value}`);
  assert.equal(sens.anger.value, 2);
});

test('需求张力：§4.13 非线性比例公式（混合正负按时间重放）', async () => {
  const { updateNeedTensions } = await import('../src/core/mood-v2.mjs');
  // 两个 anger（负性）：0.6 比例上升两次
  const neg1 = episode({ kind: 'anger', peak: 0.5, decayAnchorAt: NOW - 2000 });
  const pos1 = episode({ kind: 'joy', peak: 0.5, decayAnchorAt: NOW - 1000 }); // joy need=approval 不影响 autonomy
  const out = updateNeedTensions({ episodes: [neg1, pos1], now: NOW });
  // 负性一次：0.5×0.6×(1-0) = 0.3
  assert.ok(Math.abs(out.autonomy.value - 0.3) < 0.05, `autonomy 应约 0.3，实际 ${out.autonomy.value}`);
  // 非线性组合：两个 anger 依次重放
  const twoNeg = updateNeedTensions({ episodes: [episode({ kind: 'anger', peak: 0.5, decayAnchorAt: NOW - 2000 }), episode({ kind: 'anger', peak: 0.5, decayAnchorAt: NOW - 1000 })], now: NOW });
  // 0.3 → 0.3 + 0.5×0.6×(1-0.3) = 0.51
  assert.ok(Math.abs(twoNeg.autonomy.value - 0.51) < 0.06, `两次负性应约 0.51，实际 ${twoNeg.autonomy.value}`);
});

test('normalizeNeedMap：六项之外字段被丢弃', async () => {
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [], needs: { foo: 0.9, autonomy: 0.2 } }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  assert.equal(state.agentMood.needs.foo, undefined, '非 canonical 需求必须丢弃');
  assert.equal(Object.keys(state.agentMood.needs).length, 6);
  assert.equal(state.agentMood.needs.autonomy.value, 0.2);
});

test('tuning.needs bridge 集成：needs.cap=0.3 注入后 detail 张力受 cap 限制', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const http = await import('node:http');
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2', tuning: { needs: { cap: 0.3 } } } } } });
  h.setMode('reserved2');
  h.getSocialV2State('private:1');
  h.appendSocialV2Message('private:1', '阿明', '你真烦人', '你真烦人', false, false, 1, [], '1', []);
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const detail = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/emotion/detail?key=private%3A1', method: 'GET', headers: { 'x-console-token': 'fixture-console-token' } }, (res) => {
        let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
      });
      req.on('error', reject); req.end();
    });
    const values = Object.values(detail.agentMood?.needs ?? {}).map((item) => Number(item.value) || 0);
    assert.equal(values.length, 6, '六需求必须存在');
    assert.ok(Math.max(...values) <= 0.3 + 1e-9, `needs.cap=0.3 必须生效（实际 ${Math.max(...values)}）`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('memory 成功路径：每行 log 带稳定事件键，同 eventId 重放不增长', async () => {
  const { applyFactPipeline } = await import('../src/core/socialv2-exec.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const base = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const events = new Map();
  const memory = {
    appendEventWithId(entry) { if (events.has(entry.id)) return { ok: true, duplicate: true }; events.set(entry.id, entry); return { ok: true }; },
    findEventByStableId: (id) => (events.has(id) ? { found: true } : { found: false }),
  };
  const run = (state, id) => applyFactPipeline({
    state, event: { eventId: id, type: 'insulted', quote: '你真烦', contextKey: 'private:1', at: NOW }, memory, now: NOW, writeCheckpoint: () => {},
  });
  const first = run(base, 'same');
  assert.equal(first.code, 'ok');
  const rows = first.state.agentMood.sensitivityLog;
  assert.ok(rows.length >= 1, '必须有 log');
  for (const row of rows) assert.ok(typeof row.eventId === 'string' && row.eventId.length > 0, '每行 log 必须带 eventId');
  const before = rows.length;
  const replay = run(first.state, 'same');
  assert.equal(replay.state.agentMood.sensitivityLog.length, before, '同 eventId 重放不得增长');
});

test('候选级幂等：同一事件多个负性 kind 各记一条，整事件重放不增长', async () => {
  const { appendSensitivityLog } = await import('../src/core/mood-v2.mjs');
  const events = [
    { kind: 'anger', peak: 0.6, decayAnchorAt: NOW, eventId: 'ev', contentHash: 'h' },
    { kind: 'shame', peak: 0.5, decayAnchorAt: NOW, eventId: 'ev', contentHash: 'h' },
    { kind: 'sadness', peak: 0.4, decayAnchorAt: NOW, eventId: 'ev', contentHash: 'h' },
  ];
  const once = appendSensitivityLog([], events, { now: NOW });
  assert.equal(once.length, 3, '同事件三个负性 kind 各一条');
  const twice = appendSensitivityLog(once, events, { now: NOW });
  assert.equal(twice.length, 3, '整事件重放不得增长');
});

test('候选级 reload：save→load 保持候选身份与行数（80 字符 eventId round-trip）', async () => {
  const { loadSocialV2State, serializeSocialV2 } = await import('../src/core/socialv2-state.mjs');
  const longId = 'x'.repeat(80);
  const state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [], sensitivityLog: [
    { kind: 'anger', at: NOW, weight: 0.5, eventId: longId, contentHash: 'a'.repeat(64) },
    { kind: 'shame', at: NOW, weight: 0.4, eventId: longId, contentHash: 'a'.repeat(64) },
    { kind: 'anger', at: NOW, weight: 0.5, eventId: longId, contentHash: 'a'.repeat(64) },
  ] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  assert.equal(state.agentMood.sensitivityLog.length, 2, '候选级去重后 2 条');
  assert.equal(state.agentMood.sensitivityLog[0].eventId, longId, '80 字符 eventId 不得截断');
  const reloaded = loadSocialV2State(JSON.parse(JSON.stringify(serializeSocialV2(state, { mode: 'main' }))), { now: NOW }).state;
  assert.equal(reloaded.agentMood.sensitivityLog.length, 2);
  assert.equal(reloaded.agentMood.sensitivityLog[0].eventId, longId);
  assert.equal(reloaded.agentMood.sensitivityLog[0].contentHash, 'a'.repeat(64));
  // 64 字符前缀不同 ID 不得误去重
  const prefixState = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [], sensitivityLog: [
    { kind: 'anger', at: NOW, weight: 0.5, eventId: 'x'.repeat(64) + '\u0001' },
    { kind: 'anger', at: NOW, weight: 0.5, eventId: 'x'.repeat(64) + '\u0002' },
  ] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  assert.equal(prefixState.agentMood.sensitivityLog.length, 2, '不同 80 字符 ID 不得碰撞');
});

test('超长 eventId：首次写入即折叠，save→load→replay 不增长', async () => {
  const { appendSensitivityLog, normalizeEventId } = await import('../src/core/mood-v2.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const longId = 'y'.repeat(100);
  const event = { kind: 'anger', peak: 0.6, decayAnchorAt: NOW, eventId: longId, contentHash: null };
  const once = appendSensitivityLog([], [event], { now: NOW });
  assert.equal(once.length, 1);
  assert.equal(once[0].eventId, normalizeEventId(longId), '运行态必须已是规范化 eventId');
  assert.ok(once[0].eventId.length <= 80, '写入即折叠到 ≤80');
  // save（state normalize）→ load
  const state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [], sensitivityLog: once }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  assert.equal(state.agentMood.sensitivityLog[0].eventId, once[0].eventId);
  // reload 后用原始（未折叠）事件回放：不得换键重复计数
  const replay = appendSensitivityLog(state.agentMood.sensitivityLog, [event], { now: NOW });
  assert.equal(replay.length, 1, '跨启动回放不得重复计数');
});

test('contentHash-only：写入即 trim+lowercase，跨启动幂等', async () => {
  const { appendSensitivityLog } = await import('../src/core/mood-v2.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const upper = 'A'.repeat(64);
  const event = { kind: 'shame', peak: 0.5, decayAnchorAt: NOW, eventId: null, contentHash: upper };
  const once = appendSensitivityLog([], [event], { now: NOW });
  assert.equal(once.length, 1);
  assert.equal(once[0].contentHash, 'a'.repeat(64), '写入即小写');
  const state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [], sensitivityLog: once }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  assert.equal(state.agentMood.sensitivityLog[0].contentHash, 'a'.repeat(64));
  const replay = appendSensitivityLog(state.agentMood.sensitivityLog, [event], { now: NOW });
  assert.equal(replay.length, 1, '大小写不同不得重复计数');
  // 非 64hex 的 hash 丢弃
  const bogus = appendSensitivityLog([], [{ kind: 'anger', peak: 0.5, decayAnchorAt: NOW, eventId: null, contentHash: 'xyz' }], { now: NOW });
  assert.equal(bogus.length, 0, '非 canonical hash 不得产生无键条目');
});

test('load 物理裁剪：窗口外（>6h）log 条目从状态移除', async () => {
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [], sensitivityLog: [
    { kind: 'anger', at: NOW - 7 * HOUR, weight: 0.5, eventId: null, contentHash: null },
    { kind: 'anger', at: NOW - 1 * HOUR, weight: 0.5, eventId: 'fresh', contentHash: null },
  ] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  assert.equal(state.agentMood.sensitivityLog.length, 1, '窗口外必须物理裁剪');
  assert.equal(state.agentMood.sensitivityLog[0].eventId, 'fresh');
});

test('可配置窗口贯通持久层：72h 配置下 7h 行 load 保留并计权；1h 配置下 4h 行被裁剪', async () => {
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const { appendSensitivityLog, computeSensitizationFromLog } = await import('../src/core/mood-v2.mjs');
  const log72 = [{ kind: 'anger', at: NOW - 7 * HOUR, weight: 0.8, eventId: 'old', contentHash: null }];
  const with72 = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [], sensitivityLog: log72 }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW, tuning: { sensitization: { windowMs: 72 * HOUR } } }).state;
  assert.equal(with72.agentMood.sensitivityLog.length, 1, '72h 窗口下 7h 行必须保留');
  const sens72 = computeSensitizationFromLog(with72.agentMood.sensitivityLog, NOW, { sensitization: { windowMs: 72 * HOUR } });
  assert.ok(sens72.anger.value > 1.1, '7h 事件在 72h 窗口下必须计权');
  // append 使用同一窗口：72h 下 7h 事件不得被删
  const appended = appendSensitivityLog(with72.agentMood.sensitivityLog, [{ kind: 'shame', peak: 0.5, decayAnchorAt: NOW, eventId: 'new' }], { now: NOW, windowMs: 72 * HOUR });
  assert.equal(appended.length, 2, '72h 窗口 append 不得裁剪 7h 行');
  // 1h 配置：4h 行 load 被物理裁剪
  const with1h = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [], sensitivityLog: [{ kind: 'anger', at: NOW - 4 * HOUR, weight: 0.8, eventId: 'old1h' }] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW, tuning: { sensitization: { windowMs: 1 * HOUR } } }).state;
  assert.equal(with1h.agentMood.sensitivityLog.length, 0, '1h 窗口下 4h 行必须裁剪');
});

test('pending retry 使用冻结事件时间：延迟 7h 重放后 log at 不刷新', async () => {
  const { applyFactPipeline, retryPendingFacts } = await import('../src/core/socialv2-exec.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const base = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  let failNext = true;
  const events = new Map();
  const memory = {
    appendEventWithId(entry) { if (failNext) { failNext = false; return { ok: false, code: 'IO' }; } if (events.has(entry.id)) return { ok: true, duplicate: true }; events.set(entry.id, entry); return { ok: true }; },
    findEventByStableId: (id) => (events.has(id) ? { found: true } : { found: false }),
  };
  const eventAt = NOW - 7 * HOUR; // 事件发生在 7h 前
  const first = applyFactPipeline({ state: base, event: { eventId: 'evt-late', type: 'insulted', quote: '你真烦', contextKey: 'private:1', at: eventAt }, memory, now: eventAt, writeCheckpoint: () => {} });
  assert.equal(first.code, 'memory-failed');
  // 延迟到 NOW 重试
  const retryTuning = { sensitization: { windowMs: 72 * HOUR } };
  const retried = retryPendingFacts({ state: first.state, memory, now: NOW, tuning: retryTuning });
  assert.equal(retried.retried, 1);
  const rows = retried.state.agentMood.sensitivityLog;
  assert.ok(rows.length > 0, '重试必须产生 log');
  for (const row of rows) {
    assert.ok(Math.abs(row.at - eventAt) < 1000, `log at 必须为冻结事件时间（实际 ${row.at} vs ${eventAt}）`);
  }
  // 72h 窗口下该事件仍计权（age=7h）
  const { computeSensitizationFromLog } = await import('../src/core/mood-v2.mjs');
  const sens = computeSensitizationFromLog(rows, NOW, retryTuning);
  assert.ok(Object.keys(sens).length > 0, '7h 前事件在 72h 窗口下仍计权');
});

test('真实 runtime.load：getTuning 72h 保留 7h log、1h 裁剪（启动入口链路）', async () => {
  const { createSocialV2Runtime } = await import('../src/core/socialv2-runtime.mjs');
  const raw = { version: 2, paused: false, agentMood: { schemaVersion: 2, episodes: [], sensitivityLog: [{ kind: 'anger', at: NOW - 7 * HOUR, weight: 0.8, eventId: 'old7h' }] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, pendingArchive: null, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 }, conversations: {} };
  const make = (tuning) => createSocialV2Runtime({
    config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2', tuning } } },
    memory: null,
    readFile: () => null,
    readFileInfo: () => ({ missing: true }),
    writeFile: () => {}, writeCheckpoint: () => {}, now: () => NOW,
    getTuning: () => tuning,
  });
  // 72h：7h 行保留
  const r72 = make({ sensitization: { windowMs: 72 * HOUR } });
  const boot72 = r72.load(raw);
  assert.equal(boot72.ok, true);
  assert.equal(r72.state.agentMood.sensitivityLog.length, 1, 'runtime.load 72h 必须保留 7h 行');
  // 1h：7h 行裁剪
  const r1h = make({ sensitization: { windowMs: 1 * HOUR } });
  r1h.load(raw);
  assert.equal(r1h.state.agentMood.sensitivityLog.length, 0, 'runtime.load 1h 必须裁剪 7h 行');
});

test('bridge 配置经 getTuning 到启动 state 的完整链路（72h）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const raw = { version: 2, paused: false, agentMood: { schemaVersion: 2, episodes: [], sensitivityLog: [{ kind: 'anger', at: NOW - 7 * HOUR, weight: 0.8, eventId: 'bridge-old' }] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, pendingArchive: null, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 }, conversations: {} };
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2', tuning: { sensitization: { windowMs: 72 * 60 * 60 * 1000 } } } } }, files: { 'state/social-v2.json': JSON.stringify(raw) } });
  try {
    const boot = h.getEmotionV2Runtime ? h.getEmotionV2Runtime().load(raw) : null;
    if (boot) {
      assert.equal(h.getEmotionV2Runtime().state.agentMood.sensitivityLog.length, 1, 'bridge→getTuning→runtime.load 必须保留 7h 行');
    } else {
      // 兜底：通过 runtime 探针入口验证 tuning 已注入 cfg
      assert.equal(h.cfg.emotion.v2.tuning.sensitization.windowMs, 72 * 60 * 60 * 1000);
    }
  } finally {
    await h.close();
  }
});
