// 情绪系统 V2 —— 交审前自测探针矩阵（效率工具）
// 用法：node scripts/probe-emotion-v2.mjs
// 把 codex 每轮用过的定向探针固化在这里；新增探针请同步到 test-emotion-v2-bridge.mjs。
import assert from 'node:assert/strict';
import {
  createSocialV2Runtime,
} from '../src/core/socialv2-runtime.mjs';
import { createSocialV2Adapter } from '../src/core/socialv2-adapter.mjs';
import { loadSocialV2State, serializeSocialV2 } from '../src/core/socialv2-state.mjs';
import { authorizeReset } from '../src/core/socialv2-exec.mjs';
import { createMoodEventDispatcher } from '../src/core/mood.mjs';

const NOW = 1_800_000_000_000;
const MAIN = { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } };
const SHADOW = { emotion: { v2: { enabled: true, shadow: true } } };

function makeMemory() {
  const events = new Map();
  return {
    events,
    appendEventWithId(entry) {
      if (events.has(entry.id)) return { ok: true, duplicate: true };
      events.set(entry.id, entry);
      return { ok: true };
    },
    findEventByStableId(id) {
      return events.has(id) ? { found: true, entry: events.get(id) } : { found: false, unknown: false };
    },
  };
}

function baseState() {
  return loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
}

function legacyArg(entries = [['private:1', { recentMessages: [], lastIncomingAt: 10, wakeConfig: {} }]]) {
  const conversations = new Map(entries);
  const seenForwardIds = new Map();
  return { socialV2: { conversations, seenForwardIds, paused: false }, seenForwardIds };
}

function makeRuntime(config, overrides = {}) {
  const files = [];
  const checkpoints = [];
  const runtime = createSocialV2Runtime({
    config,
    memory: makeMemory(),
    readFile: () => null,
    writeFile: (obj) => files.push(obj),
    writeCheckpoint: (state) => checkpoints.push(state),
    now: () => NOW,
    ...overrides,
  });
  return { runtime, files, checkpoints };
}

const probes = [];
function probe(name, fn) {
  try {
    fn();
    probes.push({ name, status: 'PASS' });
  } catch (error) {
    probes.push({ name, status: 'FAIL', detail: String(error?.message ?? error) });
  }
}

// 1. 启动：阴影读取故障 fail-closed
probe('shadow 读取 EACCES → shadow-read-failed 且零写盘', () => {
  const files = [];
  const runtime = createSocialV2Runtime({
    config: SHADOW,
    memory: makeMemory(),
    readFileInfo: () => ({ error: 'EACCES' }),
    writeFile: (obj) => files.push(obj),
    writeCheckpoint: () => {},
    now: () => NOW,
  });
  runtime.load({ version: 2, conversations: {} });
  const out = runtime.shadowSave(runtime.candidateFromLegacy(legacyArg()));
  assert.equal(out.code, 'shadow-read-failed');
  assert.equal(files.length, 0);
});

// 2. 阴影：五块透传
probe('shadowSave 保留 V2 五块（agentMood 深相等）', () => {
  const existing = { version: 2, agentMood: { schemaVersion: 2, episodes: [{ id: 'keep' }] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, pendingArchive: null, migration: { version: 2, status: 'done', revision: 4 }, conversations: {} };
  const files = [];
  const runtime = createSocialV2Runtime({
    config: SHADOW,
    memory: makeMemory(),
    readFileInfo: () => ({ text: JSON.stringify(existing) }),
    writeFile: (obj) => files.push(obj),
    writeCheckpoint: () => {},
    now: () => NOW,
  });
  runtime.load(existing);
  const out = runtime.shadowSave(runtime.candidateFromLegacy(legacyArg()));
  assert.equal(out.ok, true);
  assert.deepEqual(files[0].agentMood, existing.agentMood);
});

// 3. main：legacy 分片不得回灌 V2 权威关系
probe('main candidate 剥离 conversation legacy relationships（不回灌）', () => {
  const { runtime } = makeRuntime(MAIN);
  runtime.load({ version: 1 });
  runtime.saveCandidate(runtime.candidateFromLegacy(legacyArg()));
  runtime.adapter.applyRelationshipEvent('123', 'praised', { contextKey: 'private:1' });
  const authoritative = runtime.state.relationships['123'].intimacy;
  const legacy = legacyArg([['private:1', { recentMessages: [], relationships: { 123: { intimacy: 0.95, lastInteraction: NOW + 1 } } }]]);
  const candidate = runtime.candidateFromLegacy(legacy);
  assert.equal(candidate.relationships['123'].intimacy, authoritative);
});

// 4. relationship factId 幂等 + 提交边界
probe('同 factId 二次 → duplicate；save 失败不记 ledger', () => {
  let state = baseState();
  let failures = 1;
  const adapter = createSocialV2Adapter({
    getState: () => state,
    setState: (next) => { state = next; },
    save: () => { if (failures > 0) { failures -= 1; throw new Error('disk full'); } },
    memory: null,
    now: () => NOW,
  });
  const factId = 'fact:msg:private:1:1:rel:praised';
  assert.equal(adapter.applyRelationshipEvent('9', 'praised', { contextKey: 'private:1', factId }).ok, false);
  assert.equal(adapter.applyRelationshipEvent('9', 'praised', { contextKey: 'private:1', factId }).ok, true);
  assert.equal(adapter.applyRelationshipEvent('9', 'praised', { contextKey: 'private:1', factId }).skipped, 'duplicate');
});

// 5. closeLoop：已关闭 loop 不得二次关闭
probe('重复 close 同一 loop → loop_not_found', () => {
  let state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: { 5: { generationId: 'g5', openLoops: [{ id: 'l1', text: '答应', openedAt: NOW }] } }, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const adapter = createSocialV2Adapter({ getState: () => state, setState: (next) => { state = next; }, save: () => {}, memory: null, now: () => NOW });
  assert.equal(adapter.applyRelationshipEvent('5', 'closeLoop', { loopId: 'l1', factId: 'f1' }).ok, true);
  assert.equal(adapter.applyRelationshipEvent('5', 'closeLoop', { loopId: 'l1', factId: 'f2' }).reason, 'loop_not_found');
});

// 6. 33 会话：只产生一个 archive 行
probe('33 会话两次 save 只一个 archive 行', () => {
  const memory = makeMemory();
  const { runtime } = makeRuntime(MAIN, { memory });
  runtime.load({ version: 1 });
  const entries = [];
  for (let i = 0; i < 33; i += 1) entries.push(['private:' + (600 + i), { recentMessages: [], lastIncomingAt: 10 + i }]);
  const legacy = legacyArg(entries);
  const first = runtime.saveCandidate(runtime.candidateFromLegacy(legacy));
  assert.equal(first.state.conversations.size, 32);
  runtime.saveCandidate(runtime.candidateFromLegacy({ socialV2: { conversations: first.state.conversations, seenForwardIds: first.state.seenForwardIds, paused: false }, seenForwardIds: first.state.seenForwardIds }));
  assert.equal([...memory.events.keys()].filter((id) => id.startsWith('archive:')).length, 1);
});

// 7. reset 鉴权矩阵
probe('reset 鉴权：admin ok / agent-only 403 / 无 token 401', () => {
  assert.equal(authorizeReset({ headers: {}, adminToken: 'A' }), 401);
  assert.equal(authorizeReset({ headers: { 'x-agent-token': 'G' }, adminToken: 'A' }), 403);
  assert.equal(authorizeReset({ headers: { 'x-console-token': 'A' }, adminToken: 'A' }), 'ok');
});

// 8. 预算 fatal 短路（6MB 会话）
probe('6MB 会话 → save-rejected 且零写盘/零 memory', () => {
  const memory = makeMemory();
  const { runtime, files } = makeRuntime(MAIN, { memory });
  runtime.load({ version: 1 });
  const filesAfterLoad = files.length; // load 的迁移会写盘，只统计 save 新增
  const candidate = runtime.candidateFromLegacy(legacyArg());
  const big = new Map(candidate.conversations);
  big.set('private:big', { recentMessages: [{ text: 'x'.repeat(6 * 1024 * 1024), time: NOW }] });
  const out = runtime.saveCandidate({ ...candidate, conversations: big });
  assert.equal(out.code, 'save-rejected');
  assert.equal(files.length, filesAfterLoad, 'fatal 后不得再写盘');
  assert.equal(memory.events.size, 0);
});

// 9. poke/outgoing/neglect dispatcher flags 矩阵（R40：事件源统一门控）
function makeDispatcher({ paused = false } = {}) {
  const conversations = new Map();
  const getState = (key) => {
    let st = conversations.get(key);
    if (!st) {
      st = { wakeConfig: {}, recentMessages: [], unread: [], activeTopics: [], pendingThoughts: [], memberImpressions: {}, wakeTimes: [], sendTimes: [], stickerCollectTimes: [], mood: null, relationships: {} };
      conversations.set(key, st);
    }
    return st;
  };
  return createMoodEventDispatcher({
    getState,
    peekState: (key) => conversations.get(key) ?? null,
    conversations: () => conversations,
    save: null,
    isPaused: () => paused,
  });
}

probe('dispatchPoke：success=interaction+poked / cooldown 只 interaction / paused 零', () => {
  const d = makeDispatcher();
  const ok = d.dispatchPoke({ key: 'private:1', uid: '1', targetIsSelf: true, at: NOW });
  assert.equal(ok.interactionApplied, true);
  assert.equal(ok.classifiedApplied, true);
  const cooled = d.dispatchPoke({ key: 'private:1', uid: '1', targetIsSelf: true, at: NOW + 1000 });
  assert.equal(cooled.skipped, 'cooldown');
  assert.equal(cooled.interactionApplied, true);
  assert.equal(cooled.classifiedApplied, false);
  const paused = makeDispatcher({ paused: true }).dispatchPoke({ key: 'private:1', uid: '1', targetIsSelf: true, at: NOW });
  assert.equal(paused.interactionApplied, false);
  assert.equal(paused.classifiedApplied, false);
});

probe('dispatchOutgoing：成功 interaction / paused 零 / 群聊零', () => {
  const d = makeDispatcher();
  const ok = d.dispatchOutgoing({ key: 'private:1', at: NOW });
  assert.equal(ok.interactionApplied, true);
  assert.equal(ok.classifiedApplied, false);
  const paused = makeDispatcher({ paused: true }).dispatchOutgoing({ key: 'private:1', at: NOW });
  assert.equal(paused.interactionApplied, false);
  const group = makeDispatcher().dispatchOutgoing({ key: 'group:456', at: NOW });
  assert.equal(group.interactionApplied, false);
});

probe('dispatchNeglect：成功 interaction / paused 零 / 重复窗口零', () => {
  const d = makeDispatcher();
  const ok = d.dispatchNeglect({ key: 'private:1', uid: '1', at: NOW });
  assert.equal(ok.interactionApplied, true);
  assert.equal(ok.classifiedApplied, true);
  const again = d.dispatchNeglect({ key: 'private:1', uid: '1', at: NOW + 1000 });
  assert.equal(again.skipped, 'recent_neglect');
  assert.equal(again.interactionApplied, false);
  const paused = makeDispatcher({ paused: true }).dispatchNeglect({ key: 'private:1', uid: '1', at: NOW });
  assert.equal(paused.interactionApplied, false);
});

// 12-13. 真实 bridge 边界（dispatcher → bridge → adapter 全链）
{
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const check = (name, fn) => {
    try { fn(); probes.push({ name, status: 'PASS' }); } catch (e) { probes.push({ name, status: 'FAIL', detail: String(e?.message ?? e) }); }
  };
  const h = await bridgeHarness({ config: MAIN });
  h.setMode('reserved2');
  try {
    const file = pathMod.join(h.temp, 'state', 'social-v2.json');
    h.appendSocialV2Poke('private:123', { sender: '阿明', userId: '123', targetId: '123', targetIsSelf: true });
    check('真实 bridge unpaused poke → V2 interaction+poked', () => {
      const raw = JSON.parse(fsMod.readFileSync(file, 'utf8'));
      const types = (raw.relationships?.['123']?.events ?? []).map((e) => e.type);
      assert.ok(types.includes('interaction'), '缺 interaction');
      assert.ok(types.includes('poked'), '缺 poked');
    });
    h.recordSentMessagesV2('private:123', ['你好呀']);
    check('真实 bridge outgoing → V2 interaction', () => {
      const raw = JSON.parse(fsMod.readFileSync(file, 'utf8'));
      assert.ok((raw.relationships?.['123']?.events ?? []).some((e) => e.type === 'interaction'));
    });
  } finally {
    await h.close();
  }
}

const failed = probes.filter((item) => item.status === 'FAIL');
for (const item of probes) {
  console.log(`${item.status === 'PASS' ? '✅' : '❌'} ${item.name}${item.detail ? ' — ' + item.detail : ''}`);
}
console.log(`\n探针矩阵：${probes.length - failed.length}/${probes.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
