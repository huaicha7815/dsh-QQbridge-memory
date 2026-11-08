// 情绪系统 V2 —— 1C bridge runtime 集成测试（§J 映射）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSocialV2Runtime,
} from '../src/core/socialv2-runtime.mjs';
import { authorizeReset, resolveV2Flags, runSavePipeline } from '../src/core/socialv2-exec.mjs';
import { loadSocialV2State, serializeSocialV2 } from '../src/core/socialv2-state.mjs';
import { createSocialV2Adapter as adapterFactory } from '../src/core/socialv2-adapter.mjs';
import { createSocialV2Adapter } from '../src/core/socialv2-adapter.mjs';

const NOW = 1_800_000_000_000;

function makeMemory({ failAppend = false } = {}) {
  const events = new Map();
  return {
    events,
    appendEventWithId(entry) {
      if (failAppend) return { ok: false, code: 'io_error' };
      if (events.has(entry.id)) return { ok: true, duplicate: true };
      events.set(entry.id, entry);
      return { ok: true };
    },
    findEventByStableId(id) {
      return events.has(id) ? { found: true, entry: events.get(id) } : { found: false, unknown: false };
    },
  };
}

function mainConfig() {
  return { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } };
}

function legacyV2State() {
  const conversations = new Map();
  conversations.set('private:1', { recentMessages: [{ id: 1, time: 10, text: 'hi' }], unread: [], lastIncomingAt: 10, wakeConfig: {} });
  const seenForwardIds = new Map([['private:1', new Set(['abc'])] ]);
  return { conversations, seenForwardIds, paused: false };
}

/** candidateFromLegacy 的入参结构：{ socialV2, seenForwardIds }。 */
function legacyArg() {
  const legacy = legacyV2State();
  return { socialV2: legacy, seenForwardIds: legacy.seenForwardIds };
}

function makeRuntime(config = mainConfig(), overrides = {}) {
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

test('runtime：legacy 模式不启用 V2（load 返回 legacy，saveCandidate no-op）', () => {
  const { runtime, files } = makeRuntime({});
  const loaded = runtime.load({ version: 1 });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.mode, 'legacy');
  assert.equal(runtime.enabled, false);
  const out = runtime.saveCandidate(loadSocialV2State({ version: 1 }, { now: NOW }).state);
  assert.equal(out.code, 'legacy-noop');
  assert.equal(files.length, 0);
});

test('runtime：shadow 模式不启用 V2 写路径（不会写 main 文件）', () => {
  const { runtime } = makeRuntime({ emotion: { v2: { enabled: true, shadow: true } } });
  const loaded = runtime.load({ version: 1 });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.mode, 'shadow');
  assert.equal(runtime.enabled, false);
});

test('runtime：main 模式 load 完成迁移（v1 → done），candidateFromLegacy 保留会话与 V2 状态', () => {
  const { runtime } = makeRuntime();
  const loaded = runtime.load({ version: 1 });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.mode, 'main');
  assert.equal(runtime.state.migration.status, 'done');
  const candidate = runtime.candidateFromLegacy(legacyArg());
  assert.ok(candidate.conversations.has('private:1'));
  assert.equal(candidate.conversations.get('private:1').recentMessages.length, 1);
  assert.equal(candidate.seenForwardIds.size, 1);
});

test('runtime：saveCandidate 写入 V2 文件（final 序列化）并更新 lastSave', () => {
  const { runtime, files } = makeRuntime();
  runtime.load({ version: 1 });
  const candidate = runtime.candidateFromLegacy(legacyArg());
  files.length = 0; // load 的 bootstrap 迁移也会落盘，只统计本次 save
  const out = runtime.saveCandidate(candidate);
  assert.equal(out.ok, true);
  assert.equal(files.length, 1);
  assert.equal(files[0].version, 2);
  assert.ok(files[0].conversations['private:1']);
  assert.equal(runtime.lastSave.ok, true);
});

test('runtime：fatal 短路（6MB 会话）→ save-rejected，不写盘、不写 memory', () => {
  const memory = makeMemory();
  const files = [];
  const runtime = createSocialV2Runtime({
    config: mainConfig(), memory,
    readFile: () => null,
    writeFile: (obj) => files.push(obj),
    writeCheckpoint: () => {},
    now: () => NOW,
  });
  runtime.load({ version: 1 });
  const filesAfterLoad = files.length; // bootstrap 迁移可能已落盘
  const state = runtime.candidateFromLegacy(legacyArg());
  const big = new Map(state.conversations);
  big.set('private:big', { recentMessages: [{ text: 'x'.repeat(6 * 1024 * 1024), time: NOW }] });
  const out = runtime.saveCandidate({ ...state, conversations: big });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'save-rejected');
  assert.equal(files.length, filesAfterLoad, 'fatal 后不得再写盘');
  assert.equal(memory.events.size, 0);
});

test('runtime：trimConversations 把超 128KB 会话裁剪到 20/10 条', () => {
  const { runtime } = makeRuntime();
  runtime.load({ version: 1 });
  const candidate = runtime.candidateFromLegacy(legacyArg());
  const many = Array.from({ length: 60 }, (_, i) => ({ id: i, time: i, text: 'x'.repeat(3000) }));
  const conversations = new Map(candidate.conversations);
  conversations.set('private:1', { ...conversations.get('private:1'), recentMessages: many });
  const out = runtime.trimConversations({ ...candidate, conversations });
  assert.equal(out.trimmed, 1);
  assert.equal(out.state.conversations.get('private:1').recentMessages.length, 20);
});

test('runtime：coldRelationships 超 64KB 时保留关系摘要（清 events/openLoops），不删除/不归档', () => {
  const { runtime } = makeRuntime();
  runtime.load({ version: 1 });
  const candidate = runtime.candidateFromLegacy(legacyArg());
  const relationships = {};
  for (let i = 0; i < 51; i += 1) {
    relationships[String(i + 1)] = {
      generationId: 'g' + (i + 1), intimacy: 0.5, lastInteraction: 100 + i,
      events: Array.from({ length: 8 }, (_, k) => ({ at: k, type: 'interaction', pad: 'x'.repeat(200) })),
      openLoops: [],
    };
  }
  const out = runtime.coldRelationships({ ...candidate, relationships }, { hotLimit: 15 });
  assert.ok(out.cold > 0, '超 64KB 必须冷化');
  assert.equal(Object.keys(out.state.relationships).length, 51, '冷化不得删除关系');
  assert.equal(out.state.relationshipArchive.pendingEvict.length, 0, '冷化不得进 pendingEvict');
  const coldUid = Object.keys(out.state.relationships).find((uid) => (out.state.relationships[uid].events?.length ?? 0) === 0);
  assert.ok(coldUid, '至少一个关系做了摘要化');
});

test('runtime：adapter 事件两写（checkpoint + memory）后 live 状态更新', () => {
  const memory = makeMemory();
  const { runtime } = makeRuntime(mainConfig(), { memory });
  runtime.load({ version: 1 });
  const candidate = runtime.candidateFromLegacy(legacyArg());
  runtime.saveCandidate(candidate);
  const out = runtime.adapter.applyEmotionEvent('private:1', { type: 'praised', quote: '你真棒', at: NOW });
  assert.equal(out.ok, true);
  assert.ok(memory.events.size >= 1);
  assert.ok(runtime.state.agentMood.episodes.length > 0);
});

test('runtime：gateEvent 检测 agentMood 超限（拒新增）', () => {
  const { runtime } = makeRuntime();
  runtime.load({ version: 1 });
  const mood = { schemaVersion: 2, episodes: [{ id: 'e', kind: 'joy', pad: 'x'.repeat(100 * 1024) }] };
  const gate = runtime.gateEvent({ ...runtime.state, agentMood: mood });
  assert.equal(gate.decisions.rejectNewEmotionFacts, true);
});

test('reset 鉴权矩阵：admin ok / agent 403（先于 401）/ 无 token 401 / 错误 token 401', () => {
  assert.equal(authorizeReset({ headers: {}, adminToken: 'A' }), 401);
  assert.equal(authorizeReset({ headers: { 'x-console-token': 'bad' }, adminToken: 'A' }), 401);
  assert.equal(authorizeReset({ headers: { 'x-console-token': 'A' }, adminToken: 'A' }), 'ok');
  assert.equal(authorizeReset({ headers: { 'x-agent-token': 'G' }, adminToken: 'A' }), 403);
  assert.equal(authorizeReset({ headers: { 'x-agent-token': 'G', 'x-console-token': 'A' }, adminToken: 'A' }), 'ok');
});

test('runtime reset service：四端点 changed 语义（emotion/relationship/session）', () => {
  const { runtime } = makeRuntime();
  runtime.load({ version: 1 });
  const candidate = runtime.candidateFromLegacy(legacyArg());
  runtime.saveCandidate(candidate);
  const service = runtime.makeResetService();
  assert.equal(service.handle({ pathname: '/api/socialV2/emotion/reset' }).body.changed, false);
  assert.equal(service.handle({ pathname: '/api/socialV2/emotion/reset' }).status, 200);
  const sessionReset = service.handle({ pathname: '/api/session/reset', key: 'private:1' });
  assert.equal(sessionReset.status, 200);
  assert.equal(sessionReset.body.changed, true);
});

test('runtime：load fail-closed（迁移写盘失败）→ enabled=false，save 走 legacy no-op 不覆盖', () => {
  const runtime = createSocialV2Runtime({
    config: mainConfig(),
    memory: makeMemory(),
    readFile: () => null,
    writeFile: () => { throw new Error('disk full'); },
    writeCheckpoint: () => {},
    now: () => NOW,
  });
  const loaded = runtime.load({ version: 1 });
  assert.equal(loaded.ok, false, '迁移写盘失败必须 fail-closed');
  assert.equal(runtime.enabled, false, '失败后 enabled 必须为 false');
  const candidate = loadSocialV2State({ version: 1 }, { now: NOW }).state;
  const out = runtime.saveCandidate(candidate);
  assert.equal(out.code, 'legacy-noop', 'fail-closed 后不得写 V2');
  assert.equal(out.ok, true);
});

test('resolveV2Flags：main 且 shadow=true 的非法组合 fail-closed', () => {
  const flags = resolveV2Flags({ emotion: { v2: { enabled: true, shadow: true, writeSchema: 'v2' } } });
  assert.equal(flags.ok, false);
  assert.equal(flags.failClosed, true);
});

test('bridge 真实路径 main 模式：消息后 social-v2.json 为 V2 格式（agentMood + conversations）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } } });
  h.setMode('reserved2');
  try {
    h.appendSocialV2Message('private:123', '阿明', '你好可爱呀真的好可爱', '你好可爱呀真的好可爱', false, false, 5001, [], '123', []);
    const file = path.join(h.temp, 'state', 'social-v2.json');
    assert.ok(fs.existsSync(file), 'V2 文件必须存在');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.version, 2);
    assert.ok(raw.agentMood && typeof raw.agentMood === 'object', 'V2 文件必须含 agentMood');
    assert.ok(raw.conversations['private:123'], 'conversations 必须保留');
    assert.ok(Array.isArray(raw.conversations['private:123'].recentMessages));
  } finally {
    await h.close();
  }
});

// ── 1C 审查补充 ────────────────────────────────────────────────────────────

test('shadow 投影：加载 V2 内存态、视图可读，但不写 V2 主文件（save=shadow-noop）', () => {
  const memory = makeMemory();
  const files = [];
  const runtime = createSocialV2Runtime({
    config: { emotion: { v2: { enabled: true, shadow: true } } },
    memory,
    readFile: () => null,
    writeFile: (obj) => files.push(obj),
    writeCheckpoint: () => {},
    now: () => NOW,
  });
  const loaded = runtime.load({ version: 1 });
  assert.equal(loaded.ok, true);
  assert.equal(runtime.mode, 'shadow');
  assert.equal(runtime.enabled, false, 'shadow 不写 V2');
  assert.equal(runtime.viewEnabled, true, 'shadow 只读投影可用');
  assert.ok(runtime.adapter, 'shadow 必须有只读 adapter');
  const candidate = runtime.candidateFromLegacy(legacyArg());
  const out = runtime.saveCandidate(candidate);
  assert.equal(out.code, 'shadow-noop');
  assert.equal(files.length, 0, 'shadow 不得写盘');
  assert.equal(memory.events.size, 0, 'shadow 不得写 memory');
});

test('conversation round-trip：agentToken / lastUnreadSeq / preSleepWaitAccumMs 不丢', () => {
  const { runtime } = makeRuntime();
  runtime.load({ version: 1 });
  const legacy = legacyV2State();
  legacy.conversations.set('private:1', {
    ...legacy.conversations.get('private:1'),
    agentToken: 'tok-stable-123',
    lastUnreadSeq: 77,
    lastReadThroughSeq: 70,
    preSleepWaitAccumMs: 12345,
    lastWakeReason: 'question',
    bootstrapSent: true,
  });
  const candidate = runtime.candidateFromLegacy({ socialV2: legacy, seenForwardIds: legacy.seenForwardIds });
  const conv = candidate.conversations.get('private:1');
  assert.equal(conv.agentToken, 'tok-stable-123');
  assert.equal(conv.lastUnreadSeq, 77);
  assert.equal(conv.lastReadThroughSeq, 70);
  assert.equal(conv.preSleepWaitAccumMs, 12345);
  assert.equal(conv.lastWakeReason, 'question');
  assert.equal(conv.bootstrapSent, true);
});

test('33 会话连续 save：归档只产生一个 archive 行，返回态与磁盘都 32 会话', () => {
  const memory = makeMemory();
  const files = [];
  const runtime = createSocialV2Runtime({
    config: mainConfig(), memory,
    readFile: () => null,
    writeFile: (obj) => files.push(obj),
    writeCheckpoint: () => {},
    now: () => NOW,
  });
  runtime.load({ version: 1 });
  const conversations = new Map();
  for (let i = 0; i < 33; i += 1) conversations.set('private:' + (600 + i), { recentMessages: [], lastIncomingAt: 10 + i });
  const legacy = { conversations, seenForwardIds: new Map(), paused: false };
  const candidate = runtime.candidateFromLegacy({ socialV2: legacy, seenForwardIds: legacy.seenForwardIds });
  const first = runtime.saveCandidate(candidate);
  assert.equal(first.ok, true);
  assert.equal(first.state.conversations.size, 32, '返回态必须同步为 32');
  // 第二次 save（按返回态重建候选，模拟 bridge 同步）
  const second = runtime.saveCandidate(runtime.candidateFromLegacy({ socialV2: { conversations: first.state.conversations, seenForwardIds: first.state.seenForwardIds, paused: false }, seenForwardIds: first.state.seenForwardIds }));
  assert.equal(second.ok, true);
  const archiveIds = [...memory.events.keys()].filter((id) => id.startsWith('archive:'));
  assert.equal(archiveIds.length, 1, '同一会话不得重复归档');
});

test('runtime：main 下关系事件写入 V2 relationships（不再为空）', () => {
  const { runtime } = makeRuntime();
  runtime.load({ version: 1 });
  const candidate = runtime.candidateFromLegacy(legacyArg());
  runtime.saveCandidate(candidate);
  const out = runtime.adapter.applyRelationshipEvent('123', 'praised', { contextKey: 'private:123' });
  assert.equal(out.ok, true);
  assert.ok(runtime.state.relationships['123'], 'V2 relationships 必须写入');
  assert.equal(runtime.state.relationships['123'].intimacy, 0.03);
});

// ── R36 复审补充 ───────────────────────────────────────────────────────────

test('shadow 事件投影：更新内存 state，但 memory=0、文件=0', () => {
  const memory = makeMemory();
  const files = [];
  const runtime = createSocialV2Runtime({
    config: { emotion: { v2: { enabled: true, shadow: true } } },
    memory,
    readFile: () => null,
    writeFile: (obj) => files.push(obj),
    writeCheckpoint: () => {},
    now: () => NOW,
  });
  runtime.load({ version: 1 });
  const out = runtime.adapter.applyEmotionEvent('private:1', { type: 'praised', quote: '你真棒', at: NOW });
  assert.equal(out.ok, true);
  assert.ok(runtime.state.agentMood.episodes.length > 0, 'shadow 必须更新内存投影');
  assert.equal(memory.events.size, 0, 'shadow 不得写 memory');
  assert.equal(files.length, 0, 'shadow 不得写文件');
});

test('relationship factId 幂等：同一消息重复分发只应用一次', () => {
  const { runtime } = makeRuntime();
  runtime.load({ version: 1 });
  const candidate = runtime.candidateFromLegacy(legacyArg());
  runtime.saveCandidate(candidate);
  const factId = 'fact:msg:private:1:5001';
  const first = runtime.adapter.applyRelationshipEvent('123', 'praised', { contextKey: 'private:1', factId });
  assert.equal(first.ok, true);
  const second = runtime.adapter.applyRelationshipEvent('123', 'praised', { contextKey: 'private:1', factId });
  assert.equal(second.skipped, 'duplicate');
  assert.equal(runtime.state.relationships['123'].intimacy, 0.03, '不得重复累加');
  assert.equal(runtime.state.relationships['123'].events.length, 1);
});

test('trim 分档：20 条已足够不裁；仍超 128KB 才裁到 10', () => {
  const { runtime } = makeRuntime();
  runtime.load({ version: 1 });
  const candidate = runtime.candidateFromLegacy(legacyArg());
  const small = Array.from({ length: 20 }, (_, i) => ({ id: i, time: i, text: 'x'.repeat(100) }));
  const conversations = new Map(candidate.conversations);
  conversations.set('private:1', { ...conversations.get('private:1'), recentMessages: small });
  // 构造总大小略超 128KB 但 20 条裁掉后仍超的场景
  const big = Array.from({ length: 20 }, (_, i) => ({ id: i, time: i, text: 'x'.repeat(7000) }));
  conversations.set('private:2', { recentMessages: big });
  const out = runtime.trimConversations({ ...candidate, conversations });
  assert.equal(out.state.conversations.get('private:2').recentMessages.length, 10, '20 条仍超 → 裁到 10');
  const fine = new Map([['private:9', { recentMessages: Array.from({ length: 20 }, (_, i) => ({ id: i, time: i, text: 'x'.repeat(50) })) }]]);
  const out2 = runtime.trimConversations({ ...candidate, conversations: fine });
  assert.equal(out2.trimmed, 0, '20 条且小于目标 → 不裁');
});

test('runtime sessionReset：无 DSH session 的孤儿 conversation 也被删除', () => {
  const { runtime } = makeRuntime();
  runtime.load({ version: 1 });
  const candidate = runtime.candidateFromLegacy(legacyArg());
  runtime.saveCandidate(candidate);
  const service = runtime.makeResetService();
  const out = service.handle({ pathname: '/api/session/reset', key: 'private:1' });
  assert.equal(out.status, 200);
  assert.equal(out.body.changed, true);
  assert.equal(runtime.state.conversations.has('private:1'), false, '孤儿 conversation 必须删除');
});

// ── R37 复审补充 ───────────────────────────────────────────────────────────

test('shadow save：预置 V2 文件（五块）→ shadowSave 后五块原样保留，不回落 legacy', () => {
  const existing = {
    version: 2,
    paused: false,
    agentMood: { schemaVersion: 2, episodes: [{ id: 'keep', kind: 'joy' }] },
    relationships: { 7: { generationId: 'g7', intimacy: 0.4 } },
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    pendingArchive: null,
    migration: { version: 2, fromVersion: 1, status: 'done', revision: 4 },
    conversations: { 'private:1': { recentMessages: [] } },
  };
  const files = [];
  const runtime = createSocialV2Runtime({
    config: { emotion: { v2: { enabled: true, shadow: true } } },
    memory: makeMemory(),
    readFile: () => JSON.stringify(existing),
    writeFile: (obj) => files.push(obj),
    writeCheckpoint: () => {},
    now: () => NOW,
  });
  runtime.load(existing);
  const candidate = runtime.candidateFromLegacy(legacyArg());
  const out = runtime.shadowSave(candidate);
  assert.equal(out.ok, true);
  assert.equal(out.code, 'shadow-saved');
  assert.equal(files.length, 1);
  const written = files[0];
  assert.equal(written.version, 2);
  assert.ok(written.agentMood, 'shadow 必须保留 agentMood 五块');
  assert.ok(written.relationships);
  assert.ok(written.relationshipArchive);
  assert.ok(written.pendingArchive !== undefined);
  assert.ok(written.migration);
  assert.deepEqual(written.agentMood, existing.agentMood, '五块原样保留');
});

test('relationship factId 持久化：写入 state.relationships.events[].factId', () => {
  const { runtime } = makeRuntime();
  runtime.load({ version: 1 });
  runtime.saveCandidate(runtime.candidateFromLegacy(legacyArg()));
  const factId = 'fact:msg:private:1:5001:rel:praised';
  const out = runtime.adapter.applyRelationshipEvent('123', 'praised', { contextKey: 'private:1', factId });
  assert.equal(out.ok, true);
  const events = runtime.state.relationships['123'].events;
  assert.equal(events.length, 1);
  assert.equal(events[0].factId, factId, 'factId 必须进入持久化事件');
  // 第二次同 factId 被 ledger 拦下
  const again = runtime.adapter.applyRelationshipEvent('123', 'praised', { contextKey: 'private:1', factId });
  assert.equal(again.skipped, 'duplicate');
  assert.equal(runtime.state.relationships['123'].events.length, 1);
});

// ── R38 复审补充 ───────────────────────────────────────────────────────────

test('shadowSave：EACCES 等读取故障 → shadow-read-failed，不写盘（只有 ENOENT 视为 missing）', () => {
  const files = [];
  const runtime = createSocialV2Runtime({
    config: { emotion: { v2: { enabled: true, shadow: true } } },
    memory: makeMemory(),
    readFileInfo: () => ({ error: 'EACCES' }),
    writeFile: (obj) => files.push(obj),
    writeCheckpoint: () => {},
    now: () => NOW,
  });
  runtime.load({ version: 2, agentMood: { schemaVersion: 2 }, conversations: {} });
  const candidate = runtime.candidateFromLegacy(legacyArg());
  const out = runtime.shadowSave(candidate);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'shadow-read-failed');
  assert.equal(files.length, 0, '读取故障必须禁止写盘');
  // ENOENT 才视为 missing
  const okRuntime = createSocialV2Runtime({
    config: { emotion: { v2: { enabled: true, shadow: true } } },
    memory: makeMemory(),
    readFileInfo: () => ({ missing: true }),
    writeFile: (obj) => files.push(obj),
    writeCheckpoint: () => {},
    now: () => NOW,
  });
  okRuntime.load({ version: 1 });
  const okOut = okRuntime.shadowSave(okRuntime.candidateFromLegacy(legacyArg()));
  assert.equal(okOut.ok, true);
  assert.equal(files.length, 1);
});

test('main candidateFromLegacy：conversation 内 legacy relationships/mood 不得回灌 V2 权威状态', () => {
  const memory = makeMemory();
  const runtime = createSocialV2Runtime({
    config: mainConfig(), memory,
    readFile: () => null,
    writeFile: () => {},
    writeCheckpoint: () => {},
    now: () => NOW,
  });
  runtime.load({ version: 1 });
  // 先写入 V2 权威关系
  runtime.saveCandidate(runtime.candidateFromLegacy(legacyArg()));
  runtime.adapter.applyRelationshipEvent('123', 'praised', { contextKey: 'private:1' });
  const authoritative = runtime.state.relationships['123'].intimacy;
  assert.ok(authoritative > 0);
  // legacy conversation 里放更「新」的关系分片
  const legacy = legacyV2State();
  legacy.conversations.set('private:1', {
    ...legacy.conversations.get('private:1'),
    relationships: { 123: { intimacy: 0.95, lastInteraction: NOW + 999999 } },
    mood: { valence: 0.9, arousal: 0.5, energy: 0.5 },
  });
  const candidate = runtime.candidateFromLegacy({ socialV2: legacy, seenForwardIds: legacy.seenForwardIds });
  assert.equal(candidate.relationships['123'].intimacy, authoritative, 'V2 权威关系不得被旧分片覆盖');
});

test('adapter：首次 save 失败不记 ledger；第二次成功才提交并幂等', () => {
  let state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  let failCount = 1;
  const adapter = createSocialV2Adapter({
    getState: () => state,
    setState: (next) => { state = next; },
    save: () => { if (failCount > 0) { failCount -= 1; throw new Error('disk full'); } },
    memory: null,
    now: () => NOW,
  });
  const factId = 'fact:msg:private:1:5001:rel:praised';
  const first = adapter.applyRelationshipEvent('9', 'praised', { contextKey: 'private:1', factId });
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'save-failed');
  assert.equal(state.relationships?.['9'], undefined, '失败不得留下 state 修改');
  const second = adapter.applyRelationshipEvent('9', 'praised', { contextKey: 'private:1', factId });
  assert.equal(second.ok, true);
  assert.equal(state.relationships['9'].intimacy, 0.03, '重试必须真正提交');
  const third = adapter.applyRelationshipEvent('9', 'praised', { contextKey: 'private:1', factId });
  assert.equal(third.skipped, 'duplicate', '提交成功后 ledger 生效');
});

// ── R39 复审补充（codex 探针矩阵固化）────────────────────────────────────

test('main 启动：截断 JSON → fail-closed，原文件不得被覆盖', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const broken = '{"version":2,broken';
  const h = await bridgeHarness({
    config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } },
    files: { 'state/social-v2.json': broken },
  });
  try {
    const file = path.join(h.temp, 'state/social-v2.json');
    assert.equal(fs.readFileSync(file, 'utf8'), broken, '解析失败时原文件必须保持不动');
  } finally {
    await h.close();
  }
});

test('main：非指向 AI 的群消息不产生 V2 relationship', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } } });
  h.setMode('reserved2');
  try {
    h.appendSocialV2Message('group:456', '路人', '今天天气不错哦', '今天天气不错哦', false, false, 5001, [], '777', []);
    const file = path.join(h.temp, 'state', 'social-v2.json');
    const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    assert.deepEqual(Object.keys(raw.relationships ?? {}), [], '群聊未指向 AI 不得写关系');
  } finally {
    await h.close();
  }
});

test('adapter：不同 factId 重复 close 同一已关闭 loop 必须拒绝', () => {
  const { createSocialV2Adapter } = require_adapter();
  let state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: { 5: { generationId: 'g5', openLoops: [{ id: 'l1', text: '答应的事', openedAt: NOW }] } }, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const adapter = createSocialV2Adapter({
    getState: () => state, setState: (next) => { state = next; }, save: () => {}, memory: null, now: () => NOW,
  });
  const first = adapter.applyRelationshipEvent('5', 'closeLoop', { loopId: 'l1', factId: 'f1' });
  assert.equal(first.ok, true);
  const second = adapter.applyRelationshipEvent('5', 'closeLoop', { loopId: 'l1', factId: 'f2' });
  assert.equal(second.ok, false, '已关闭 loop 不能被不同 factId 再次关闭');
  assert.equal(second.reason, 'loop_not_found');
});

test('ledger：512 上限、513 淘汰最旧、duplicate 命中刷新保活', () => {
  const { createSocialV2Adapter } = require_adapter();
  let state = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const adapter = createSocialV2Adapter({
    getState: () => state, setState: (next) => { state = next; }, save: () => {}, memory: null, now: () => NOW,
  });
  for (let i = 0; i < 512; i += 1) {
    const out = adapter.applyRelationshipEvent('7', 'interaction', { contextKey: 'private:7', factId: 'fact:' + i });
    assert.equal(out.ok ?? true, true);
  }
  // 重放第 0 个（仍在 ledger）→ duplicate
  const hit = adapter.applyRelationshipEvent('7', 'interaction', { contextKey: 'private:7', factId: 'fact:0' });
  assert.equal(hit.skipped, 'duplicate');
  // 插入第 513 个 → 淘汰最旧（fact:1，因 fact:0 刚被访问刷新）
  adapter.applyRelationshipEvent('7', 'interaction', { contextKey: 'private:7', factId: 'fact:512' });
  const evicted = adapter.applyRelationshipEvent('7', 'interaction', { contextKey: 'private:7', factId: 'fact:1' });
  assert.notEqual(evicted.skipped, 'duplicate', '最旧项应被淘汰');
});

// 本文件顶部未导入 adapter；用包装避免重复 import 区改动
function require_adapter() {
  return { createSocialV2Adapter: adapterFactory };
}

test('paused：poke 不写 V2（live + 磁盘均保持）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } } });
  h.setMode('reserved2');
  try {
    h.socialV2.paused = true;
    h.appendSocialV2Poke('private:1', { sender: '阿明', userId: '1', targetId: '1', targetIsSelf: true, isOwner: false, groupId: null });
    const file = path.join(h.temp, 'state', 'social-v2.json');
    const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    assert.deepEqual(Object.keys(raw.relationships ?? {}), [], 'paused poke 不得写 V2 关系');
  } finally {
    await h.close();
  }
});

test('真实 bridge：unpaused target-self poke → V2 有 interaction+poked；30s 内第二次只 interaction', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } } });
  h.setMode('reserved2');
  try {
    const file = path.join(h.temp, 'state', 'social-v2.json');
    h.appendSocialV2Poke('private:123', { sender: '阿明', userId: '123', targetId: '123', targetIsSelf: true });
    let raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    let rel = raw.relationships['123'];
    assert.ok(rel, 'unpaused poke 必须写 V2 关系（R41 修复 ReferenceError）');
    let types = rel.events.map((e) => e.type);
    assert.ok(types.includes('interaction'), 'V2 必须有 interaction');
    assert.ok(types.includes('poked'), 'V2 必须有 poked');
    // 第二次（30s 内）→ cooldown：只加 interaction，不得再 poked
    h.appendSocialV2Poke('private:123', { sender: '阿明', userId: '123', targetId: '123', targetIsSelf: true });
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    rel = raw.relationships['123'];
    types = rel.events.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'poked').length, 1, 'cooldown 不得重复 poked');
    assert.ok(types.filter((t) => t === 'interaction').length >= 2, 'cooldown 仍写 interaction');
  } finally {
    await h.close();
  }
});

test('真实 bridge：outgoing（recordSentMessagesV2）→ V2 interaction', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } } });
  h.setMode('reserved2');
  try {
    const file = path.join(h.temp, 'state', 'social-v2.json');
    h.recordSentMessagesV2('private:123', ['你好呀']);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(raw.relationships['123'], 'outgoing 必须写 V2 interaction');
    assert.ok(raw.relationships['123'].events.some((e) => e.type === 'interaction'));
  } finally {
    await h.close();
  }
});

test('真实 bridge：paused poke/outgoing 解除暂停后保存不复活', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } } });
  h.setMode('reserved2');
  try {
    const file = path.join(h.temp, 'state', 'social-v2.json');
    h.socialV2.paused = true;
    h.appendSocialV2Poke('private:123', { sender: '阿明', userId: '123', targetId: '123', targetIsSelf: true });
    h.recordSentMessagesV2('private:123', ['暂停期间的消息']);
    h.socialV2.paused = false;
    h.saveSocialV2State();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(raw.relationships ?? {}), [], '暂停期间事件不得在解除暂停后复活');
  } finally {
    await h.close();
  }
});

test('1D：非法 prompt 配置 fail-closed → legacy（不注入情绪段、variant=off）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const badConfigs = [
    { prompt: 'bad' },
    { prompt: null },
    { prompt: [] },
    { prompt: { ab: 'true' } },
    { prompt: { enabled: 0 } },
    { prompt: { mode: 'bogus' } },
  ];
  for (const v2 of badConfigs) {
    const h = await bridgeHarness({ config: { emotion: { v2 } } });
    try {
      const text = h.buildWakePromptV2('private:1', 'question');
      assert.ok(!text.includes('【此刻心情】'), '非法配置不得注入情绪段：' + JSON.stringify(v2));
      assert.equal(h.socialV2.emotionV2AbVariantFor('private:1'), 'off');
    } finally {
      await h.close();
    }
  }
});

test('1D：mode=treatment/ab/legacy 三态与 A/B 分桶', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const hTreatment = await bridgeHarness({ config: { emotion: { v2: { prompt: { mode: 'treatment' } } } } });
  try {
    assert.equal(hTreatment.socialV2.emotionV2AbVariantFor('private:1'), 'treatment');
  } finally { await hTreatment.close(); }
  const hLegacy = await bridgeHarness({ config: { emotion: { v2: { prompt: { mode: 'legacy' } } } } });
  try {
    assert.equal(hLegacy.socialV2.emotionV2AbVariantFor('private:1'), 'off');
    const text = hLegacy.buildWakePromptV2('private:1', 'question');
    assert.ok(!text.includes('【此刻心情】'));
  } finally { await hLegacy.close(); }
  const hAb = await bridgeHarness({ config: { emotion: { v2: { prompt: { mode: 'ab' } } } } });
  try {
    const variants = new Set();
    for (let i = 1; i <= 8; i += 1) variants.add(hAb.socialV2.emotionV2AbVariantFor('private:' + i));
    assert.ok(variants.has('control') || variants.has('treatment'), 'ab 模式必须产出 control/treatment');
    assert.ok(!variants.has('off'));
  } finally { await hAb.close(); }
});

test('1D：mode:treatment/ab + 非法 enabled/ab → 强制 legacy（off、不注入）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  for (const v2 of [{ prompt: { mode: 'treatment', ab: 'true' } }, { prompt: { mode: 'ab', enabled: 0 } }]) {
    const h = await bridgeHarness({ config: { emotion: { v2 } } });
    try {
      assert.equal(h.socialV2.emotionV2AbVariantFor('private:1'), 'off', '非法字段必须降级 legacy');
      const text = h.buildWakePromptV2('private:1', 'question');
      assert.ok(!text.includes('【此刻心情】'));
    } finally {
      await h.close();
    }
  }
});

test('1D：一次真实 wake 只写一条 exposure，且 hash/长度对应最终 prompt', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const cryptoMod = await import('node:crypto');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { prompt: { mode: 'ab' } } } } });
  h.setMode('reserved2');
  try {
    await h.sendWakePromptV2('private:123', 'question');
    const file = path.join(h.temp, 'state', 'emotion-v2-ab.jsonl');
    assert.ok(fs.existsSync(file), 'ab 模式必须产生 exposure 文件');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, '一次 wake 只能一条 exposure');
    const row = JSON.parse(lines[0]);
    assert.ok(row.exposureId && row.exposureId.startsWith('exp-'));
    assert.match(row.promptHash, /^[0-9a-f]{64}$/);
    assert.ok(['control', 'treatment'].includes(row.variant));
    assert.ok(row.promptLength > 0);
  } finally {
    await h.close();
  }
});

test('1D：exposure 与 outcome 通过 exposureId 关联（wake → 回复 → turn 结束两行）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { prompt: { mode: 'ab' } } } } });
  h.setMode('reserved2');
  try {
    await h.sendWakePromptV2('private:123', 'question');
    h.recordSentMessagesV2('private:123', ['我在呢，怎么啦']);
    const file = path.join(h.temp, 'state', 'emotion-v2-ab.jsonl');
    let rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(rows.filter((r) => r.kind === 'outcome').length, 0, '发送阶段不写 outcome（turn 结束才聚合）');
    h.socialV2.finalizeEmotionV2AbTurn('private:123');
    rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const exposure = rows.find((row) => row.kind !== 'outcome');
    const outcome = rows.find((row) => row.kind === 'outcome');
    assert.ok(exposure && outcome, '必须有 exposure + outcome 两行');
    assert.equal(outcome.exposureId, exposure.exposureId, 'outcome 必须关联同一 exposureId');
    assert.equal(outcome.variant, exposure.variant);
    assert.ok(outcome.replyChars > 0);
  } finally {
    await h.close();
  }
});

test('1D：一次 wake 的 outcome 只关联一次（多消息发送不重复关联）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { prompt: { mode: 'ab' } } } } });
  h.setMode('reserved2');
  try {
    await h.sendWakePromptV2('private:123', 'question');
    h.recordSentMessagesV2('private:123', ['第一条']);
    h.recordSentMessagesV2('private:123', ['第二条更长']);
    const file = path.join(h.temp, 'state', 'emotion-v2-ab.jsonl');
    h.socialV2.finalizeEmotionV2AbTurn('private:123');
    h.socialV2.finalizeEmotionV2AbTurn('private:123'); // 幂等：消费后不得再写
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const outcomes = rows.filter((r) => r.kind === 'outcome');
    assert.equal(outcomes.length, 1, '同一 exposure 只能有一个 outcome');
    assert.equal(outcomes[0].replied, true);
    assert.equal(outcomes[0].replyChars, '第一条\n第二条更长'.length, '必须聚合整个 turn 的回复');
    assert.equal(outcomes[0].turnReplies, 2);
  } finally {
    await h.close();
  }
});

test('1D：非法 prompt 配置必须产生 warnings（string/null/array）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  for (const bad of [{ prompt: 'bad' }, { prompt: null }, { prompt: [] }]) {
    const h = await bridgeHarness({ config: { emotion: { v2: bad } } });
    try {
      const warnings = h.cfg.emotion.v2.prompt.warnings;
      assert.ok(Array.isArray(warnings) && warnings.length > 0, '非法 prompt 必须有告警：' + JSON.stringify(bad));
    } finally {
      await h.close();
    }
  }
});

test('1D：无回复 turn 结束时写 no-reply outcome；重复 finalize 幂等', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { prompt: { mode: 'ab' } } } } });
  h.setMode('reserved2');
  try {
    await h.sendWakePromptV2('private:123', 'question');
    h.socialV2.finalizeEmotionV2AbTurn('private:123');
    h.socialV2.finalizeEmotionV2AbTurn('private:123');
    const file = path.join(h.temp, 'state', 'emotion-v2-ab.jsonl');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const outcomes = rows.filter((r) => r.kind === 'outcome');
    assert.equal(outcomes.length, 1, 'no-reply turn 只写一条 outcome');
    assert.equal(outcomes[0].replied, false);
    assert.equal(outcomes[0].replyChars, 0);
  } finally {
    await h.close();
  }
});

test('1D：turnReplies = 实际消息条数（含换行消息不按行计数）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { prompt: { mode: 'ab' } } } } });
  h.setMode('reserved2');
  try {
    await h.sendWakePromptV2('private:123', 'question');
    h.recordSentMessagesV2('private:123', ['第一条\n附言', '第二条更长']);
    h.socialV2.finalizeEmotionV2AbTurn('private:123');
    const file = path.join(h.temp, 'state', 'emotion-v2-ab.jsonl');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const outcome = rows.find((r) => r.kind === 'outcome');
    assert.equal(outcome.turnReplies, 2, '两条消息（其中一条含换行）必须记 2 条');
    assert.equal(outcome.replyChars, '第一条\n附言\n第二条更长'.length);
  } finally {
    await h.close();
  }
});

test('1D：空字符串/纯空白发送不计为回复（no-reply outcome）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { prompt: { mode: 'ab' } } } } });
  h.setMode('reserved2');
  try {
    await h.sendWakePromptV2('private:123', 'question');
    h.recordSentMessagesV2('private:123', ['', '   ', '\n']);
    h.socialV2.finalizeEmotionV2AbTurn('private:123');
    const file = path.join(h.temp, 'state', 'emotion-v2-ab.jsonl');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const outcome = rows.find((r) => r.kind === 'outcome');
    assert.equal(outcome.replied, false, '空文本不得计为回复');
    assert.equal(outcome.turnReplies, 0);
  } finally {
    await h.close();
  }
});

test('1D：reset 清理 pending/last exposure（reset 后 finalize 不写 outcome）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const http = await import('node:http');
  const h = await bridgeHarness({ config: { emotion: { v2: { prompt: { mode: 'ab' } } } } });
  h.setMode('reserved2');
  await h.ensureSession('private:123');
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    await h.sendWakePromptV2('private:123', 'question');
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/session/reset', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject); req.end(JSON.stringify({ key: 'private:123' }));
    });
    h.socialV2.finalizeEmotionV2AbTurn('private:123');
    const file = path.join(h.temp, 'state', 'emotion-v2-ab.jsonl');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows.filter((r) => r.kind === 'outcome').length, 0, 'reset 后不得再关联 outcome');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('1D：JSONL 超 5MB 轮转保留 .1/.2 两份', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { prompt: { mode: 'ab' } } } } });
  h.setMode('reserved2');
  try {
    const dir = path.join(h.temp, 'state');
    const file = path.join(dir, 'emotion-v2-ab.jsonl');
    fs.writeFileSync(file + '.1', 'old1\n');
    fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 10));
    await h.sendWakePromptV2('private:123', 'question');
    assert.ok(fs.existsSync(file + '.1'), '轮转必须产生 .1');
    assert.ok(fs.existsSync(file + '.2'), '轮转必须产生 .2');
    assert.equal(fs.readFileSync(file + '.2', 'utf8'), 'old1\n', '旧 .1 必须移到 .2');
  } finally {
    await h.close();
  }
});

test('1D HTTP：/state 对 agent 盲化 abVariant、对控制台返回变体', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const http = await import('node:http');
  const h = await bridgeHarness({ config: { emotion: { v2: { prompt: { mode: 'ab' } } } } });
  h.setMode('reserved2');
  await h.ensureSession('private:123');
  const agentToken = h.getSocialV2State('private:123').agentToken;
  const server = h.startConsoleServer();
  const getJson = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/state?key=private%3A123', method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end();
  });
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const agent = await getJson({ 'x-agent-token': agentToken, 'x-agent-call': '1' });
    if (agent.status === 200) assert.equal(agent.body.emotionV2?.abVariant ?? null, null, 'agent 不得看到 A/B 标签');
    else assert.equal(agent.status, 401, 'agent 请求应被拒（401 或 200 盲化）');
    const admin = await getJson({ 'x-console-token': 'fixture-console-token' });
    assert.ok(['control', 'treatment'].includes(admin.body.emotionV2?.abVariant), '控制台应看到变体');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('1E：/emotion/detail 使用真实 episode schema（读取时衰减 currentIntensity + peak 另存）+ target-aware mix', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const http = await import('node:http');
  const NOWT = Date.now();
  const v2State = {
    version: 2,
    paused: false,
    agentMood: { schemaVersion: 2, episodes: [
      { id: 'ep-a', kind: 'joy', peak: 0.8, decayAnchorAt: NOWT - 1000, target: { kind: 'person', uid: '123' }, latestSourceEventId: 'evt-1', appraisalNote: '被夸' },
      { id: 'ep-b', kind: 'sadness', peak: 0.4, decayAnchorAt: NOWT - 60000, target: { kind: 'person', uid: '123' }, latestSourceEventId: 'evt-2', appraisalNote: '' },
    ] },
    relationships: { 123: { generationId: 'g', intimacy: 0.031, tension: 0.2, trust: 0.5, openLoops: [], events: [] } },
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    pendingArchive: null,
    migration: { version: 2, fromVersion: 1, status: 'done', revision: 1 },
    conversations: { 'private:123': { recentMessages: [], wakeConfig: {} } },
  };
  const h = await bridgeHarness({
    config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } },
    files: { 'state/social-v2.json': JSON.stringify(v2State) },
  });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/emotion/detail?key=private%3A123', method: 'GET', headers: { 'x-console-token': 'fixture-console-token' } }, (res) => {
        let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.end();
    });
    assert.equal(body.ok, true);
    const episodes = body.agentMood.episodes;
    assert.ok(episodes.length >= 1);
    const joy = episodes.find((e) => e.kind === 'joy');
    assert.ok(joy, '必须有 joy episode');
    assert.ok(joy.currentIntensity > 0.4 && joy.currentIntensity < 0.8, 'currentIntensity 必须是读取时衰减值（小于 peak）');
    assert.equal(joy.peak, 0.8, 'peak 必须单独返回');
    assert.ok(joy.at > 0, 'at 来自 decayAnchorAt');
    assert.equal(joy.source, 'evt-1');
    assert.equal(joy.note, '被夸');
    assert.ok(body.agentMood.dominant && typeof body.agentMood.dominant === 'object', 'dominant 必须是对象（synthesizeMood）');
    assert.ok(Array.isArray(body.agentMood.mixed) && body.agentMood.mixed.length > 0);
    assert.deepEqual(body.health.thresholds, { negativeValence: -0.2, negativeTension: 0.5 });
    // agent 拒绝
    const agentState = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/emotion/detail?key=private%3A123', method: 'GET', headers: { 'x-agent-token': h.getSocialV2State('private:123').agentToken, 'x-agent-call': '1' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(agentState, 403, 'detail 必须拒绝 agent');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('1E：控制台暂停端点（POST /api/socialV2/pause）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const http = await import('node:http');
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const doPost = (body) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/pause', method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' } }, (res) => {
        let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve(JSON.parse(text)));
      });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
    const paused = await doPost({ paused: true });
    assert.equal(paused.paused, true);
    const resumed = await doPost({ paused: false });
    assert.equal(resumed.paused, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('1E：/relationship 与 detail 无条件 200 且数值一致（预置真实 V2 关系）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const http = await import('node:http');
  const NOWT = Date.now();
  const v2State = {
    version: 2, paused: false,
    agentMood: { schemaVersion: 2, episodes: [{ id: 'ep-mood', kind: 'joy', peak: 0.6, decayAnchorAt: NOWT - 1000, target: { kind: 'person', uid: '123' }, latestSourceEventId: 'evt-mood', appraisalNote: '被夸' }] },
    relationships: { 123: { generationId: 'g', intimacy: 0.031, tension: 0.2, trust: 0.5, openLoops: [], events: [] } },
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    pendingArchive: null,
    migration: { version: 2, fromVersion: 1, status: 'done', revision: 1 },
    conversations: { 'private:123': { recentMessages: [], wakeConfig: {} } },
  };
  const h = await bridgeHarness({
    config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } },
    files: { 'state/social-v2.json': JSON.stringify(v2State) },
  });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const getJson = (path) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'GET', headers: { 'x-console-token': 'fixture-console-token' } }, (res) => {
        let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.end();
    });
    const rel = await getJson('/api/socialV2/relationship?uid=123');
    assert.equal(rel.status, 200, '合法 uid 必须 200');
    assert.equal(rel.body.ok, true);
    assert.equal(rel.body.relationship.intimacy, 0.031);
    const detail = await getJson('/api/socialV2/emotion/detail?key=private%3A123');
    assert.equal(detail.status, 200, 'detail 必须 200');
    assert.equal(detail.body.relationship.intimacy, 0.031, 'detail 与 /relationship 数值必须一致');
    // /mood 的 reasons→cause/events 映射（非空 episode，逐字段断言）
    const mood = await getJson('/api/socialV2/mood?key=private%3A123');
    assert.equal(mood.status, 200);
    assert.ok(Array.isArray(mood.body.reasons) && mood.body.reasons.length > 0, '/mood 必须有 reasons');
    const reason = mood.body.reasons[0];
    assert.equal(mood.body.mood.causeType, reason.kind);
    assert.equal(mood.body.mood.cause, reason.note || '');
    assert.ok(Array.isArray(mood.body.events) && mood.body.events.length > 0);
    const event = mood.body.events[0];
    assert.equal(event.type, reason.kind);
    assert.equal(event.cause, reason.note || '');
    assert.equal(event.at, null, '未知时间必须为 null（不得伪造 0）');
    assert.equal(event.sourceEventId, reason.sourceEventId ?? null);
    assert.equal(event.intensity, reason.intensity);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('1E：pause 落盘 + resume 落盘（重启后状态保持）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const http = await import('node:http');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const doPost = (body) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/pause', method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' } }, (res) => {
        let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
    const paused = await doPost({ paused: true });
    assert.equal(paused.status, 200);
    const file = path.join(h.temp, 'state', 'social-v2.json');
    const afterPause = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(afterPause.paused, true, 'pause 必须落盘');
    const resumed = await doPost({ paused: false });
    assert.equal(resumed.status, 200);
    const afterResume = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(afterResume.paused, false, 'resume 必须落盘');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('1E：控制台 UI 使用 currentIntensity/ratio 且存在恢复按钮', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  assert.ok(html.includes('currentIntensity'), 'UI 必须读 currentIntensity');
  assert.ok(html.includes('item.ratio'), 'UI 必须读 mix.ratio');
  assert.ok(html.includes('emotionV2Resume'), '必须有恢复按钮');
  assert.ok(html.includes("api('/api/socialV2/pause', 'POST'"), '按钮必须用 api(path, method, body) 签名');
  assert.ok(html.includes("api('/api/socialV2/emotion/reset', 'POST'"), '重置情绪必须用正确签名');
});

test('1E：savePauseState 写失败返回失败、corrupt 文件 fail-closed', () => {
  // 写失败
  let failNow = false;
  const failRuntime = createSocialV2Runtime({
    config: mainConfig(), memory: makeMemory(),
    readFileInfo: () => ({ missing: true }),
    writeFile: () => { if (failNow) throw new Error('disk full'); },
    writeCheckpoint: () => {}, now: () => NOW,
  });
  failRuntime.load({ version: 1 });
  failNow = true;
  const failed = failRuntime.savePauseState(true);
  assert.equal(failed.ok, false, '写失败必须返回 ok:false');
  assert.equal(failRuntime.state.paused, false, '失败不得改变 runtime state');
  // corrupt 文件 fail-closed（不按 v1 重写）
  let corruptWrites = 0;
  const corruptRuntime = createSocialV2Runtime({
    config: mainConfig(), memory: makeMemory(),
    readFileInfo: () => ({ text: '{"version":2,broken' }),
    writeFile: () => { corruptWrites += 1; },
    writeCheckpoint: () => {}, now: () => NOW,
  });
  corruptRuntime.load({ version: 1 });
  const writesAfterLoad = corruptWrites;
  const corrupt = corruptRuntime.savePauseState(true);
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.code, 'pause-file-invalid');
  assert.equal(corruptWrites, writesAfterLoad, 'corrupt 文件不得被重写覆盖');
  assert.equal(corruptRuntime.state.paused, false);
});

test('1E：/relationship 非法 uid 返回 400（回归）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const http = await import('node:http');
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/relationship?uid=abc', method: 'GET', headers: { 'x-console-token': 'fixture-console-token' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 400, '非法 uid 必须 400');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('UI 回归：detail 在 4 种以上活跃情绪时返回完整 mixed（ratio 合计≈1）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const http = await import('node:http');
  const NOWT = Date.now();
  const ep = (kind, peak, uid) => ({ id: 'ep-' + kind, kind, peak, decayAnchorAt: NOWT - 60 * 1000, target: { kind: 'other', uid: String(uid) }, latestSourceEventId: 'evt-' + kind });
  const v2State = {
    version: 2, paused: false,
    agentMood: { schemaVersion: 2, episodes: [ep('joy', 0.8, '1'), ep('hurt', 0.7, '1'), ep('loneliness', 0.6, '1'), ep('anger', 0.5, '1')] },
    relationships: { 1: { generationId: 'g', intimacy: 0.3, tension: 0.4, trust: 0.5, resentment: 0.2, openLoops: [], events: [] } },
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    pendingArchive: null,
    migration: { version: 2, fromVersion: 1, status: 'done', revision: 1 },
    conversations: { 'private:1': { recentMessages: [], wakeConfig: {} } },
  };
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } }, files: { 'state/social-v2.json': JSON.stringify(v2State) } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const detail = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/emotion/detail?key=private%3A1', method: 'GET', headers: { 'x-console-token': 'fixture-console-token' } }, (res) => {
        let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
      });
      req.on('error', reject); req.end();
    });
    const mixed = detail.agentMood.mixed;
    assert.ok(mixed.length >= 4, `4 种活跃情绪必须全部返回（实际 ${mixed.length}）`);
    const sum = mixed.reduce((acc, item) => acc + (Number(item.ratio) || 0), 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `ratio 合计必须≈1（实际 ${sum}）`);
    const kinds = mixed.map((item) => item.kind).sort();
    assert.deepEqual(kinds, ['anger', 'hurt', 'joy', 'loneliness']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('UI 回归：detail episodes 标记迁移副本（id/migrated），曲线可过滤', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const http = await import('node:http');
  const NOWT = Date.now();
  const v2State = {
    version: 2, paused: false,
    agentMood: { schemaVersion: 2, episodes: [
      { id: 'ep-migrated-joy', kind: 'joy', peak: 0.3, decayAnchorAt: NOWT - 60000, target: { kind: 'world', uid: null } },
      { id: 'ep-joy-world-' + NOWT, kind: 'joy', peak: 0.5, decayAnchorAt: NOWT - 30000, target: { kind: 'world', uid: null } },
    ] },
    relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, pendingArchive: null,
    migration: { version: 2, fromVersion: 1, status: 'done', revision: 1 }, conversations: { 'private:1': { recentMessages: [], wakeConfig: {} } },
  };
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } }, files: { 'state/social-v2.json': JSON.stringify(v2State) } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const detail = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/emotion/detail?key=private%3A1', method: 'GET', headers: { 'x-console-token': 'fixture-console-token' } }, (res) => {
        let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
      });
      req.on('error', reject); req.end();
    });
    const episodes = detail.agentMood.episodes;
    const migrated = episodes.find((item) => item.id === 'ep-migrated-joy');
    const real = episodes.find((item) => item.id !== 'ep-migrated-joy');
    assert.ok(migrated && migrated.migrated === true, '迁移副本必须标记 migrated:true');
    assert.ok(real && real.migrated === false, '真实事件不得标记');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('数据保护：legacy 保存的 V2 块保留逻辑（serialize 层）', async () => {
  const { serializeSocialV2 } = await import('../src/core/socialv2-state.mjs');
  const NOWT = Date.now();
  const agentMood = { schemaVersion: 2, episodes: [{ id: 'ep-1', kind: 'joy', peak: 0.5, decayAnchorAt: NOWT }], needs: {}, sensitivity: {}, sensitivityLog: [] };
  const blocks = {
    agentMood,
    relationships: { 1: { uid: '1', intimacy: 0.2, tension: 0, trust: 0.5, openLoops: [], events: [] } },
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    pendingArchive: null,
    migration: { version: 2, fromVersion: 1, status: 'done', revision: 1 },
  };
  const conversations = new Map();
  conversations.set('private:1', { recentMessages: [], wakeConfig: {} });
  const out = serializeSocialV2({ paused: false, conversations, seenForwardIds: new Map(), ...blocks }, { mode: 'shadow', sourceSchema: 'v2', preservedV2Blocks: blocks, seenForwardIds: new Map() });
  assert.equal(out.version, 2);
  assert.ok(Array.isArray(out.agentMood.episodes) && out.agentMood.episodes.length === 1, 'V2 agentMood 必须保留');
  assert.ok(out.relationships['1'], 'V2 relationships 必须保留');
  assert.equal(out.migration.status, 'done');
  assert.ok(out.conversations['private:1'], '会话数据必须更新');
  // 源码守卫存在（真实路径证据）
  const bridgeSource = (await import('node:fs')).readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.ok(bridgeSource.includes('preservedV2Blocks'), 'legacy 保存路径必须含 V2 保护守卫');
});

test('真实 bridge：poke 写入的记忆事件带正文与稳定 id，episode 能回指（协作检查 4/5）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } } });
  h.setMode('reserved2');
  try {
    h.appendSocialV2Poke('private:123', { sender: '阿明', userId: '123', targetId: '123', targetIsSelf: true });
    const sv = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
    const eps = (sv.agentMood?.episodes || []).filter((e) => e.latestSourceEventId);
    assert.ok(eps.length > 0, 'poke 后 episode 必须带 latestSourceEventId');
    const eventsDir = path.join(h.temp, 'state', 'memory', 'events');
    const ids = new Set();
    const emotionTexts = [];
    if (fs.existsSync(eventsDir)) {
      for (const f of fs.readdirSync(eventsDir).filter((x) => x.endsWith('.jsonl'))) {
        for (const line of fs.readFileSync(path.join(eventsDir, f), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.id) ids.add(String(e.id));
          if (e.kind === 'emotion') emotionTexts.push(String(e.text || ''));
        }
      }
    }
    assert.ok(emotionTexts.length > 0, 'poke 必须写入 emotion 记忆事件');
    assert.ok(emotionTexts.every((x) => x.trim().length > 0), 'emotion 事件必须有正文（不能空字符串）');
    assert.ok(ids.has(eps[0].latestSourceEventId), 'episode source id 必须能在记忆事件里找到');
  } finally {
    await h.close();
  }
});

test('真实 bridge：同一 poke 载荷处理两次 → 同一 eventId、情绪事实只一条、关系不重复累加（幂等）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } } });
  h.setMode('reserved2');
  const readState = () => JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
  const readEmotionEvents = () => {
    const dir = path.join(h.temp, 'state', 'memory', 'events');
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const e = JSON.parse(line); if (e.kind === 'emotion') out.push(e); } catch {}
      }
    }
    return out;
  };
  try {
    // 同一上游载荷（含 messageId + 上游时间）处理两次 = 上游重投
    const payload = {
      sender: '阿明', userId: '123', targetId: '123', targetIsSelf: true,
      messageId: 'poke-9001', at: 1794000000000,
    };
    h.appendSocialV2Poke('private:123', payload);
    const first = readState();
    h.appendSocialV2Poke('private:123', payload);
    const second = readState();

    const emotions1 = readEmotionEvents();
    assert.equal(emotions1.length, 1, '同一载荷重投后情绪事实只能有一条');
    const epId1 = (first.agentMood?.episodes || []).find((e) => e.latestSourceEventId)?.latestSourceEventId;
    const epId2 = (second.agentMood?.episodes || []).find((e) => e.latestSourceEventId)?.latestSourceEventId;
    assert.ok(epId1, '第一次处理后 episode 必须带 source id');
    assert.equal(epId2, epId1, '重投后 episode source id 不变');
    assert.equal(emotions1[0].id, epId1, '记忆事件 id 与 episode source id 一致');

    const pokedCount = (second.relationships['123']?.events || []).filter((e) => e.type === 'poked').length;
    assert.equal(pokedCount, 1, '关系事件 poked 不得重复累加（同一个 factId 幂等）');
  } finally {
    await h.close();
  }
});
