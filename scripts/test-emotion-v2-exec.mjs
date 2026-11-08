// 情绪系统 V2 —— 1B 执行层单测（契约：ADDENDUM-1B-internals v2.24 §D/§E/§F/§G/§H）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONVERSATIONS,
  agentMoodBytes,
  applyFactPipeline,
  budgetActionsFor,
  budgetErrorFor,
  authorizeReset,
  bootstrapSocialV2,
  buildArchivePayload,
  classifyOldFile,
  contentHashForEvent,
  createFactId,
  evaluateBudgetGate,
  createResetService,
  resolveV2Flags,
  retryPendingFacts,
  runArchivePipeline,
  consumeRelationshipEvict,
  finalizeRelationshipEvict,
  prepareConversationArchive,
  prepareRelationshipEvict,
  rankRelationshipPressure,
  runSavePipeline,
  upgradeLegacyV2,
} from '../src/core/socialv2-exec.mjs';
import { computeBudgets, loadSocialV2State } from '../src/core/socialv2-state.mjs';
import { createSocialV2Adapter } from '../src/core/socialv2-adapter.mjs';

const NOW = 1_800_000_000_000;

function makeMemory(overrides = {}) {
  const events = new Map();
  return {
    events,
    appendEventWithId(entry) {
      if (overrides.failAppend) return { ok: false, code: 'io_error' };
      if (events.has(entry.id)) {
        const existing = events.get(entry.id);
        if (JSON.stringify(existing) === JSON.stringify(entry)) return { ok: true, duplicate: true, code: 'duplicate' };
        return { ok: false, conflict: true, code: 'conflict' };
      }
      events.set(entry.id, entry);
      return { ok: true, duplicate: false, code: 'ok' };
    },
    findEventByStableId(id) {
      if (overrides.failFind) return { found: false, unknown: true, conflict: false, event: null };
      if (events.has(id)) return { found: true, unknown: false, conflict: false, event: events.get(id) };
      return { found: false, unknown: false, conflict: false, event: null };
    },
  };
}

function makeState(overrides = {}) {
  const loaded = loadSocialV2State({
    version: 2,
    agentMood: { schemaVersion: 2, episodes: [] },
    relationships: {},
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    pendingArchive: null,
    migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 },
    conversations: { 'private:1': { lastIncomingAt: 10, lastActionAt: 5, recentMessages: [] } },
    ...overrides,
  }, { now: NOW });
  return loaded.state;
}

// ── flags ───────────────────────────────────────────────────────────────────

test('flags：12 组合 truth table 逐行（非法组合 fail-closed）', () => {
  const rows = [
    [false, false, null, 'legacy', false],
    [false, false, 'v1', 'legacy', false],
    [false, false, 'v2', 'legacy', true],
    [false, true, null, 'legacy', false],
    [false, true, 'v1', 'legacy', false],
    [false, true, 'v2', 'legacy', true],
    [true, true, null, 'shadow', false],
    [true, true, 'v1', 'shadow', false],
    [true, true, 'v2', 'shadow', true],
    [true, false, null, 'main', true],
    [true, false, 'v1', 'main', true],
    [true, false, 'v2', 'main', false],
  ];
  for (const [enabled, shadow, writeSchema, mode, failClosed] of rows) {
    const out = resolveV2Flags({ emotion: { v2: { enabled, shadow, writeSchema } } });
    assert.equal(out.mode, mode, `${enabled}/${shadow}/${writeSchema} mode`);
    assert.equal(out.failClosed, failClosed, `${enabled}/${shadow}/${writeSchema} failClosed`);
    assert.equal(out.ok, !failClosed);
  }
});

// ── contentHash / factId ────────────────────────────────────────────────────

test('contentHash：8 字段固定输入 → 固定 sha256；空值为 null；at 冻结', () => {
  const base = {
    messageId: 'm1', actorUid: '10001', target: { kind: 'person', uid: '10002' },
    contextKey: 'private:10001', eventType: 'praised', at: 1234567890, quote: '你好',
  };
  const hash = contentHashForEvent(base);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(contentHashForEvent({ ...base }), hash, '相同输入必须相同 hash');
  assert.notEqual(contentHashForEvent({ ...base, quote: '你好！' }), hash);
  // 空值：undefined 与 null 等价
  assert.equal(
    contentHashForEvent({ messageId: null, actorUid: null, target: null, contextKey: null, eventType: null, at: null, quote: null }),
    contentHashForEvent({}),
  );
});

test('createFactId：注入 random 确定性；格式 fact:<32 hex>', () => {
  const a = createFactId({ at: 1, random: 'seed' });
  const b = createFactId({ at: 1, random: 'seed' });
  assert.equal(a, b);
  assert.match(a, /^fact:[0-9a-f]{32}$/);
  assert.notEqual(createFactId({ at: 2, random: 'seed' }), a);
});

// ── fact 管线 ──────────────────────────────────────────────────────────────

test('applyFactPipeline：ok 路径（memory 写入 + mood 更新 + pending 清空）', () => {
  const state = makeState();
  const memory = makeMemory();
  const out = applyFactPipeline({ state, writeCheckpoint: () => {},
    memory,
    now: NOW,
    event: { eventId: 'fact:1', contextKey: 'private:1', actorUid: '10001', eventType: 'praised', at: NOW, text: '你真棒' },
  });
  assert.equal(out.code, 'ok');
  assert.equal(out.state.agentMood.pendingFacts.length, 0);
  assert.equal(memory.events.has('fact:1'), true);
  assert.ok(out.state.agentMood.episodes.length > 0, 'mood 必须产生 episode');
});

test('applyFactPipeline：memory 失败 → checkpoint both 保留；paused → 不写', () => {
  const state = makeState();
  const memory = makeMemory({ failAppend: true });
  const failed = applyFactPipeline({ state, writeCheckpoint: () => {}, memory, now: NOW, event: { eventId: 'fact:2', contextKey: 'private:1', eventType: 'praised', at: NOW } });
  assert.equal(failed.code, 'memory-failed');
  assert.equal(failed.state.agentMood.pendingFacts.length, 1);
  assert.equal(failed.state.agentMood.pendingFacts[0].missingSide, 'both');
  assert.equal(failed.state.agentMood.pendingFacts[0].payload.at, NOW, 'at 必须冻结');
  const paused = applyFactPipeline({ state: { ...state, paused: true }, memory, now: NOW, event: { eventId: 'fact:3', contextKey: 'private:1', eventType: 'praised', at: NOW } });
  assert.equal(paused.code, 'paused');
  assert.equal(memory.events.has('fact:3'), false);
});

test('retryPendingFacts：memory 失败后重试成功 → 清 pending；attempts/退避符合契约', () => {
  const state = makeState();
  const broken = makeMemory({ failAppend: true });
  const first = applyFactPipeline({ state, writeCheckpoint: () => {}, memory: broken, now: NOW, event: { eventId: 'fact:4', contextKey: 'private:1', eventType: 'praised', at: NOW } });
  assert.equal(first.state.agentMood.pendingFacts.length, 1);
  const pending = first.state.agentMood.pendingFacts[0];
  assert.equal(pending.attempts, 1, '首次失败 attempts=1');
  assert.equal(pending.nextAttemptAt, NOW + 30 * 1000, '首次失败退避 30s');
  const early = retryPendingFacts({ state: first.state, memory: makeMemory(), now: NOW });
  assert.equal(early.retried, 0, '未到 nextAttemptAt 不重试');
  const ok = makeMemory();
  const due = { ...first.state, agentMood: { ...first.state.agentMood, pendingFacts: [{ ...pending, nextAttemptAt: NOW }] } };
  const retried = retryPendingFacts({ state: due, memory: ok, now: NOW });
  assert.equal(retried.retried, 1);
  assert.equal(retried.state.agentMood.pendingFacts.length, 0);
  assert.equal(ok.events.has('fact:4'), true);
  // 连续失败：attempts 2→5m、3→30m、4→30m，第 5 次进 unresolved
  let current = { ...first.state, agentMood: { ...first.state.agentMood, pendingFacts: [{ ...pending, nextAttemptAt: NOW }] } };
  const delays = [5 * 60 * 1000, 30 * 60 * 1000, 30 * 60 * 1000];
  for (let i = 0; i < delays.length; i += 1) {
    const out = retryPendingFacts({ state: current, memory: makeMemory({ failAppend: true }), now: NOW });
    assert.equal(out.state.agentMood.pendingFacts[0].attempts, i + 2, '第 ' + (i + 2) + ' 次失败 attempts');
    assert.equal(out.state.agentMood.pendingFacts[0].nextAttemptAt, NOW + delays[i], '第 ' + (i + 2) + ' 次失败退避');
    current = { ...out.state, agentMood: { ...out.state.agentMood, pendingFacts: out.state.agentMood.pendingFacts.map((p) => ({ ...p, nextAttemptAt: NOW })) } };
  }
  const exhausted = retryPendingFacts({ state: current, memory: makeMemory({ failAppend: true }), now: NOW });
  assert.equal(exhausted.unresolved, 1);
  assert.equal(exhausted.state.agentMood.pendingFacts.length, 0);
  assert.equal(exhausted.state.agentMood.unresolvedFacts.length, 1);
  assert.equal(exhausted.state.agentMood.unresolvedFacts[0].attempts, 5);
});

// ── archive ────────────────────────────────────────────────────────────────

test('buildArchivePayload：摘要/话题字符串数组/lastInteractionAt=max', () => {
  const payload = buildArchivePayload({
    lastIncomingAt: 30, lastActionAt: 20,
    recentMessages: [{ text: 'a', time: 10 }, { text: 'b', time: 25 }],
    activeTopics: [{ text: '话题A' }, '话题B'],
  }, { now: NOW });
  assert.equal(payload.lastIncomingAt, 30);
  assert.equal(payload.lastInteractionAt, 30);
  assert.equal(payload.messageCount, 2);
  assert.deepEqual(payload.topics, ['话题A', '话题B']);
  assert.equal(payload.archivedAt, NOW);
});

test('runArchivePipeline：三阶段推进 checkpoint→memory-written→conversation-removed→null', () => {
  const state = makeState();
  const memory = makeMemory();
  const withPending = {
    ...state,
    pendingArchive: {
      key: 'private:1', generationId: 'g1', at: NOW, phase: 'checkpoint',
      payload: { lastActionAt: 5, lastIncomingAt: 10, lastInteractionAt: 10, messageCount: 0, topics: [], summary: 's', archivedAt: NOW },
    },
  };
  const step1 = runArchivePipeline({ state: withPending, memory, now: NOW });
  assert.equal(step1.code, 'ok');
  assert.equal(step1.state.pendingArchive.phase, 'memory-written');
  assert.equal(memory.events.has('archive:private:1:g1'), true);
  const step2 = runArchivePipeline({ state: step1.state, memory, now: NOW });
  assert.equal(step2.state.pendingArchive.phase, 'conversation-removed');
  assert.equal(step2.state.conversations.has('private:1'), false);
  const step3 = runArchivePipeline({ state: step2.state, memory, now: NOW });
  assert.equal(step3.state.pendingArchive, null);
  // append 失败 → 不推进（冻结 entry 保留）
  const failed = runArchivePipeline({ state: withPending, memory: makeMemory({ failAppend: true }), now: NOW });
  assert.equal(failed.code, 'memory-failed');
  assert.equal(failed.state.pendingArchive.phase, 'checkpoint');
});

// ── save 流水线 ────────────────────────────────────────────────────────────

test('classifyOldFile：missing/v1/v2/v2-incomplete/corrupt', () => {
  assert.equal(classifyOldFile(null).schema, 'missing');
  assert.equal(classifyOldFile('{bad json').schema, 'corrupt');
  assert.equal(classifyOldFile(JSON.stringify({ version: 1, conversations: {} })).schema, 'v1');
  const v2 = {
    version: 2,
    conversations: {},
    agentMood: { schemaVersion: 2, episodes: [] },
    relationships: {},
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    pendingArchive: null,
    migration: { version: 2, status: 'done', revision: 0 },
  };
  assert.equal(classifyOldFile(JSON.stringify(v2)).schema, 'v2');
  assert.equal(classifyOldFile(JSON.stringify({ version: 2, conversations: {} })).schema, 'v2-incomplete');
});

test('upgradeLegacyV2：缺块补齐全五块', () => {
  const upgraded = upgradeLegacyV2({ version: 2, conversations: { 'private:1': {} } });
  for (const field of ['agentMood', 'relationships', 'relationshipArchive', 'pendingArchive', 'migration']) {
    assert.ok(Object.prototype.hasOwnProperty.call(upgraded, field), `缺块必须补齐：${field}`);
  }
});

test('runSavePipeline：main 成功写盘（final）、shadow 无旧文件 version=1、corrupt 拒写', () => {
  const state = makeState();
  const written = [];
  const ok = runSavePipeline({ state, mode: 'main', writeCheckpoint: () => {}, memory: makeMemory(), readOldFile: () => null, writeFile: (obj) => written.push(obj), now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.saveStatus, 'normal');
  assert.equal(written.length, 1);
  assert.equal(written[0].migration.status, 'done');
  // shadow：旧文件不存在 → version 1、无五块
  const shadow = runSavePipeline({ state, mode: 'shadow', memory: makeMemory(), readOldFile: () => null, writeFile: () => {}, now: NOW });
  assert.equal(shadow.ok, true);
  assert.equal(shadow.serialized.version, 1);
  assert.equal(shadow.serialized.agentMood, undefined);
  // shadow：旧文件损坏 → fail-closed 不写盘
  let wrote = false;
  const corrupt = runSavePipeline({ state, mode: 'shadow', memory: makeMemory(), readOldFile: () => '{bad', writeFile: () => { wrote = true; }, now: NOW });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.saveStatus, 'rejected');
  assert.equal(wrote, false);
  // writeFile 抛错 → rejected、错误可读
  const writeFail = runSavePipeline({ state, mode: 'main', writeCheckpoint: () => {}, memory: makeMemory(), readOldFile: () => null, writeFile: () => { throw new Error('disk full'); }, now: NOW });
  assert.equal(writeFail.ok, false);
  assert.match(writeFail.error, /disk full/);
});

test('runSavePipeline：整体/单会话预算超限 → rejected', () => {
  // runtime 直接注入大对象（不经 normalize 清洗），验证 gate 拒写
  const state = { ...makeState(), conversations: new Map([['private:1', { wakeConfig: { bloat: 'x'.repeat(200 * 1024) } }]]) };
  const out = runSavePipeline({ state, mode: 'main', writeCheckpoint: () => {}, memory: makeMemory(), readOldFile: () => null, writeFile: () => {}, now: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.saveStatus, 'rejected');
});

// ── reset service ──────────────────────────────────────────────────────────

test('authorizeReset：agent→403 先于 401；无 admin→401；admin→ok', () => {
  assert.equal(authorizeReset({ headers: { 'x-agent-token': 'a' }, adminToken: 'adm', agentToken: 'a' }), 403);
  assert.equal(authorizeReset({ headers: { 'x-agent-token': 'a' }, adminToken: 'adm', agentToken: 'other' }), 403);
  assert.equal(authorizeReset({ headers: {}, adminToken: 'adm', agentToken: 'a' }), 401);
  assert.equal(authorizeReset({ headers: { 'x-console-token': 'adm' }, adminToken: 'adm', agentToken: 'a' }), 'ok');
});

test('reset service：emotion/relationship/session/workspace 四端点语义', () => {
  let state = makeState({
    relationships: { 5: { generationId: 'g5', intimacy: 0.4 } },
    relationshipArchive: {
      orphanLoops: [{ uid: '5', generationId: 'g5', archiveId: 'loop-archive:5:g5', loops: [] }],
      pendingCold: [],
      pendingEvict: [{ uid: '5', generationId: 'g5', archiveId: 'relationship-archive:5:g5', payload: { intimacy: 0.4 }, at: NOW }],
    },
  });
  const memory = makeMemory();
  const audits = [];
  const service = createResetService({
    getState: () => state,
    setState: (next) => { state = next; },
    memory,
    audit: (action, target) => audits.push([action, target]),
    now: () => NOW,
  });
  // emotion：清 agentMood，不动关系
  state.agentMood = { ...state.agentMood, episodes: [{ id: 'ep-1', kind: 'joy', target: { kind: 'person', uid: '1' }, peak: 0.5, decayAnchorAt: NOW }] };
  const emo = service.handle({ pathname: '/api/socialV2/emotion/reset' });
  assert.equal(emo.status, 200);
  assert.equal(emo.body.changed, true);
  assert.equal(Object.keys(state.relationships).length, 1);
  const emoAgain = service.handle({ pathname: '/api/socialV2/emotion/reset' });
  assert.equal(emoAgain.body.changed, false, '重复 reset 幂等 changed:false');
  // relationship：清关系 + orphan/pendingEvict + 墓碑
  const rel = service.handle({ pathname: '/api/socialV2/relationship/reset', uid: '5' });
  assert.equal(rel.status, 200);
  assert.equal(state.relationships[5], undefined);
  assert.equal(state.relationshipArchive.orphanLoops.length, 0);
  assert.equal(state.relationshipArchive.pendingEvict.length, 0);
  assert.equal(memory.events.has(`relationship-reset:5:${NOW}`), true);
  // session：只清会话
  const sessionState = makeState({ relationships: { 5: { intimacy: 0.4 } } });
  state = sessionState;
  const sess = service.handle({ pathname: '/api/session/reset', key: 'private:1' });
  assert.equal(sess.status, 200);
  assert.equal(state.conversations.has('private:1'), false);
  assert.equal(Object.keys(state.relationships).length, 1, 'session reset 不动全局关系');
  // workspace：清 7 字段
  const ws = service.handle({ pathname: '/api/socialV2/reset' });
  assert.equal(ws.status, 200);
  assert.equal(state.conversations.size, 0);
  assert.equal(Object.keys(state.relationships).length, 0);
  assert.equal(state.agentMood.episodes.length, 0);
  assert.ok(audits.length >= 4);
});

// ── 启动编排 ───────────────────────────────────────────────────────────────

test('bootstrapSocialV2：legacy/shadow 不迁移；main 迁移到 done；非法 flag fail-closed', () => {
  const v1 = { version: 1, conversations: { 'private:1': { mood: { valence: 0.5, since: 100 } } } };
  const legacy = bootstrapSocialV2({ raw: v1, config: { emotion: { v2: { enabled: false } } }, now: NOW });
  assert.equal(legacy.mode, 'legacy');
  assert.equal(legacy.state.migration.status, 'pending', 'legacy 不迁移');
  const shadow = bootstrapSocialV2({ raw: v1, config: { emotion: { v2: { enabled: true, shadow: true } } }, now: NOW });
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.state.migration.status, 'pending');
  const written = [];
  const main = bootstrapSocialV2({ raw: v1, config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2' } } }, now: NOW, writeFile: (obj) => written.push(obj) });
  assert.equal(main.mode, 'main');
  assert.equal(main.state.migration.status, 'done');
  assert.equal(written.length, 4);
  const bad = bootstrapSocialV2({ raw: v1, config: { emotion: { v2: { enabled: true, shadow: true, writeSchema: 'v2' } } }, now: NOW });
  assert.equal(bad.ok, false);
  assert.equal(bad.failClosed, true);
});

// ── adapter（§I）────────────────────────────────────────────────────────────

function makeAdapter(initial = makeState()) {
  let state = initial;
  const saves = [];
  const memory = makeMemory();
  const adapter = createSocialV2Adapter({
    getState: () => state,
    setState: (next) => { state = next; },
    save: (candidate) => saves.push(candidate ?? state),
    memory,
    now: () => NOW,
  });
  return { adapter, getState: () => state, saves, memory };
}

test('adapter.getMood：空状态返回 baseline/平静；private key 映射 context', () => {
  const { adapter } = makeAdapter();
  const view = adapter.getMood('private:10001');
  assert.equal(view.valid, true);
  assert.equal(view.known, false);
  assert.equal(view.valence, 0);
  assert.equal(view.arousal, 0.3);
  assert.equal(view.label, '平静');
});

test('adapter.applyEmotionEvent：写 V2（episode + dominant），save 一次；paused 拒绝', () => {
  const { adapter, getState, saves } = makeAdapter();
  const out = adapter.applyEmotionEvent('private:10001', { type: 'praised', cause: '被夸', at: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.type, 'praised');
  assert.ok(getState().agentMood.episodes.length > 0);
  assert.ok(out.mood.dominant, '返回兼容视图必须带 dominant');
  assert.equal(saves.length, 2, 'checkpoint + final 两次落盘');
  const pausedState = { ...getState(), paused: true };
  const { adapter: pausedAdapter } = makeAdapter(pausedState);
  const paused = pausedAdapter.applyEmotionEvent('private:10001', { type: 'praised', at: NOW });
  assert.equal(paused.ok, false);
  assert.equal(paused.reason, 'paused');
});

test('adapter.getRelationship：未知 uid 返回 known:false 默认值；已知返回字段视图', () => {
  const state = makeState({ relationships: { 10002: { generationId: 'g', intimacy: 0.4, tension: 0.2, trust: 0.6, resentment: 0.1, lastInteraction: 99 } } });
  const { adapter } = makeAdapter(state);
  const unknown = adapter.getRelationship('99999');
  assert.equal(unknown.known, false);
  assert.equal(unknown.intimacy, 0);
  const known = adapter.getRelationship('10002');
  assert.equal(known.known, true);
  assert.equal(known.intimacy, 0.4);
  assert.equal(known.tension, 0.2);
  assert.equal(known.lastInteraction, 99);
});

test('adapter.applyRelationshipEvent：旧事件表增量 + clamp + events 记录；未知类型/暂停拒绝', () => {
  const { adapter, getState } = makeAdapter();
  const praised = adapter.applyRelationshipEvent('10002', 'praised', { contextKey: 'private:10002' });
  assert.equal(praised.ok, true);
  assert.equal(praised.relationship.intimacy, 0.03);
  assert.equal(praised.relationship.lastContextKey, 'private:10002');
  assert.equal(praised.relationship.events.length, 1);
  assert.equal(getState().relationships['10002'].events[0].type, 'praised');
  // insulted → tension +0.18 clamp
  for (let i = 0; i < 10; i += 1) adapter.applyRelationshipEvent('10002', 'insulted', {});
  const after = adapter.getRelationship('10002');
  assert.equal(after.tension, 1, 'tension 必须 clamp 到 1');
  assert.equal(adapter.applyRelationshipEvent('10002', 'nope', {}).ok, false);
  const { adapter: pausedAdapter } = makeAdapter({ ...getState(), paused: true });
  assert.equal(pausedAdapter.applyRelationshipEvent('10002', 'praised', {}).ok, false);
});

test('adapter.applyRelationshipEvent：openLoop/closeLoop 维护 openLoops（≤8）', () => {
  const { adapter } = makeAdapter();
  adapter.applyRelationshipEvent('10002', 'openLoop', { loop: { id: 'l1', text: '答应教她唱歌', openedAt: NOW }, contextKey: 'private:10002' });
  let rel = adapter.getRelationship('10002');
  assert.equal(rel.openLoops.length, 1);
  assert.equal(rel.openLoops[0].text, '答应教她唱歌');
  adapter.applyRelationshipEvent('10002', 'closeLoop', { loopId: 'l1' });
  rel = adapter.getRelationship('10002');
  assert.equal(rel.openLoops[0].closedAt, NOW);
});

test('runSavePipeline：gate.rejected 时 archive/evict 内存回滚（会话恢复、pendingArchive 保留冻结 payload）', () => {
  const base = makeState();
  const state = {
    ...base,
    conversations: new Map([
      ['private:1', { lastIncomingAt: 10, recentMessages: [] }],
      ['private:2', { wakeConfig: { bloat: 'x'.repeat(200 * 1024) } }],
    ]),
    pendingArchive: {
      key: 'private:1', generationId: 'g1', at: NOW, phase: 'checkpoint',
      payload: { lastActionAt: 5, lastIncomingAt: 10, lastInteractionAt: 10, messageCount: 0, topics: [], summary: 's', archivedAt: NOW },
    },
  };
  const memory = makeMemory();
  const out = runSavePipeline({ state, mode: 'main', writeCheckpoint: () => {}, memory, readOldFile: () => null, writeFile: () => {}, now: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.saveStatus, 'rejected');
  assert.equal(out.state.conversations.has('private:1'), true, '拒写后会话必须回滚');
  assert.equal(out.state.pendingArchive.phase, 'checkpoint', 'pendingArchive 回滚为 checkpoint（payload 不丢）');
  assert.equal(out.state.pendingArchive.payload.summary, 's');
  assert.equal(memory.events.has('archive:private:1:g1'), true, 'memory 已写归档行保留（幂等键）');
});

test('runSavePipeline：shadow 读取旧文件抛错 → fail-closed 不写盘', () => {
  const state = makeState();
  let wrote = false;
  const out = runSavePipeline({
    state, mode: 'shadow', memory: makeMemory(),
    readOldFile: () => { throw new Error('EACCES'); },
    writeFile: () => { wrote = true; },
    now: NOW,
  });
  assert.equal(out.ok, false);
  assert.equal(out.saveStatus, 'rejected');
  assert.equal(out.code, 'shadow-read-failed');
  assert.equal(wrote, false);
});

test('workspaceReset：migration 重置为干净 done（revision 0）', () => {
  let state = makeState();
  const service = createResetService({ getState: () => state, setState: (next) => { state = next; }, now: () => NOW });
  service.handle({ pathname: '/api/socialV2/reset' });
  assert.equal(state.migration.status, 'done');
  assert.equal(state.migration.revision, 0);
  assert.equal(state.migration.fromVersion, 2);
});

test('retryPendingFacts：第 5 次失败进 unresolved 时保留原 eventId/contentHash', () => {
  const state = makeState();
  const broken = makeMemory({ failAppend: true });
  const first = applyFactPipeline({ state, writeCheckpoint: () => {}, memory: broken, now: NOW, event: { eventId: 'fact:unresolved', contextKey: 'private:1', eventType: 'praised', at: NOW, text: '夸' } });
  const pending = first.state.agentMood.pendingFacts[0];
  const retiring = {
    ...first.state,
    agentMood: { ...first.state.agentMood, pendingFacts: [{ ...pending, attempts: 4, nextAttemptAt: NOW }] },
  };
  const out = retryPendingFacts({ state: retiring, memory: broken, now: NOW });
  assert.equal(out.state.agentMood.pendingFacts.length, 0);
  assert.equal(out.state.agentMood.unresolvedFacts.length, 1);
  assert.equal(out.state.agentMood.unresolvedFacts[0].eventId, 'fact:unresolved');
  assert.equal(out.state.agentMood.unresolvedFacts[0].attempts, 5);
});

test('runSavePipeline：shadow 遇旧 v2 缺块 → fail-closed（要求先 upgrade，不静默删块）', () => {
  const state = makeState();
  let wrote = false;
  const incomplete = JSON.stringify({ version: 2, conversations: { 'private:1': {} } });
  const out = runSavePipeline({ state, mode: 'shadow', memory: makeMemory(), readOldFile: () => incomplete, writeFile: () => { wrote = true; }, now: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'shadow-upgrade-required');
  assert.equal(wrote, false);
});

// ── R25 复审补充 ────────────────────────────────────────────────────────────

test('checkpoint 必须先落盘：writeCheckpoint 在 memory 前调用；失败则不写 memory', () => {
  const state = makeState();
  const memory = makeMemory();
  const order = [];
  const spyMemory = {
    appendEventWithId(entry) { order.push('memory'); return memory.appendEventWithId(entry); },
    findEventByStableId(id) { return memory.findEventByStableId(id); },
  };
  const ok = applyFactPipeline({ state, writeCheckpoint: () => {}, memory: spyMemory, now: NOW,
    event: { eventId: 'fact:cp1', contextKey: 'private:1', eventType: 'praised', at: NOW },
    writeCheckpoint: () => order.push('checkpoint'),
  });
  assert.equal(ok.code, 'ok');
  assert.deepEqual(order, ['checkpoint', 'memory'], 'checkpoint 必须先于 memory');
  assert.equal(memory.events.has('fact:cp1'), true);
  // checkpoint 写失败 → 不写 memory、返回原 state
  const order2 = [];
  const failed = applyFactPipeline({ state, writeCheckpoint: () => {}, memory: spyMemory, now: NOW,
    event: { eventId: 'fact:cp2', contextKey: 'private:1', eventType: 'praised', at: NOW },
    writeCheckpoint: () => { order2.push('checkpoint'); throw new Error('disk full'); },
  });
  assert.equal(failed.code, 'checkpoint-failed');
  assert.deepEqual(order2, ['checkpoint']);
  assert.equal(memory.events.has('fact:cp2'), false, 'checkpoint 失败不得写 memory');
  assert.equal(failed.state, state, '失败时状态不变');
});

test('memory 响应丢失后 retry：重放冻结 entry，内容与首次完全一致', () => {
  const state = makeState();
  const lost = makeMemory();
  const realAppend = lost.appendEventWithId.bind(lost);
  let drop = true;
  lost.appendEventWithId = (entry) => {
    if (drop) { realAppend(entry); drop = false; return { ok: false, code: 'io_error' }; }
    return realAppend(entry);
  };
  const first = applyFactPipeline({ state, writeCheckpoint: () => {}, memory: lost, now: NOW, event: { eventId: 'fact:replay', contextKey: 'private:1', eventType: 'praised', at: NOW, text: '你真棒' } });
  assert.equal(first.code, 'memory-failed');
  const pending = first.state.agentMood.pendingFacts[0];
  assert.ok(pending.payload.entry, 'pending 必须冻结完整 entry');
  const due = { ...first.state, agentMood: { ...first.state.agentMood, pendingFacts: [{ ...pending, nextAttemptAt: NOW }] } };
  const retried = retryPendingFacts({ state: due, memory: lost, now: NOW });
  assert.equal(retried.state.agentMood.pendingFacts.length, 0);
  assert.equal(lost.events.get('fact:replay').text, '你真棒', '重放文本与首次一致');
  assert.equal(lost.events.get('fact:replay').meta.eventType, 'praised', '重放 eventType 与首次一致');
});

test('memory disabled：不创建 pending；第 21 条 pending 把最旧移入 unresolved', () => {
  const state = makeState();
  const disabled = applyFactPipeline({ state, writeCheckpoint: () => {}, memory: null, now: NOW, event: { eventId: 'fact:dis', contextKey: 'private:1', eventType: 'praised', at: NOW } });
  assert.equal(disabled.code, 'memory-disabled');
  assert.equal((disabled.state.agentMood.pendingFacts ?? []).length, 0, 'memory disabled 不创建 pending');
  assert.ok((disabled.state.agentMood.episodes ?? []).length > 0, 'mood 仍应更新');
  // 20 条 pending + 新 1 条（memory 失败）→ 最旧进 unresolved
  const dummy = Array.from({ length: 20 }, (_, i) => ({
    eventId: 'old:' + i, contentHash: 'h' + i, missingSide: 'both', attempts: 1,
    payload: { candidates: [], needTension: {}, messageId: null, contextKey: 'private:1', at: NOW, entry: { id: 'old:' + i, t: NOW, k: 'private:1', kind: 'emotion', text: '', meta: {}, contentHash: 'h' + i } },
    lastAttemptAt: NOW, nextAttemptAt: NOW + 999999, status: 'pending',
  }));
  const full = { ...state, agentMood: { ...state.agentMood, pendingFacts: dummy } };
  const over = applyFactPipeline({ state: full, writeCheckpoint: () => {}, memory: makeMemory({ failAppend: true }), now: NOW, event: { eventId: 'fact:over', contextKey: 'private:1', eventType: 'praised', at: NOW } });
  assert.equal(over.state.agentMood.pendingFacts.length, 20);
  assert.equal(over.state.agentMood.pendingFacts[0].eventId, 'old:1', '最旧被移出 pending');
  assert.equal(over.state.agentMood.unresolvedFacts.length, 1);
  assert.equal(over.state.agentMood.unresolvedFacts[0].eventId, 'old:0');
  assert.equal(over.state.agentMood.unresolvedFacts[0].lastErrorCode, 'pending_overflow');
});

test('archive 同 ID 异内容：append 返回 conflict → 不推进 phase', () => {
  const state = makeState();
  const memory = makeMemory();
  memory.appendEventWithId = () => ({ ok: false, conflict: true, code: 'conflict' });
  const withPending = {
    ...state,
    pendingArchive: {
      key: 'private:1', generationId: 'g1', at: NOW, phase: 'checkpoint',
      payload: { lastActionAt: 5, lastIncomingAt: 10, lastInteractionAt: 10, messageCount: 0, topics: [], summary: 'new', archivedAt: NOW },
    },
  };
  const out = runArchivePipeline({ state: withPending, memory, now: NOW });
  assert.equal(out.code, 'conflict');
  assert.equal(out.state.pendingArchive.phase, 'checkpoint', 'conflict 不得推进');
});

test('adapter closeLoop：未命中 loop → loop_not_found，不应用 delta/event', () => {
  const { adapter, getState } = makeAdapter();
  const out = adapter.applyRelationshipEvent('10002', 'closeLoop', { loopId: 'not-exist' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'loop_not_found');
  assert.equal(getState().relationships['10002'], undefined, '不得创建关系');
});

test('reset relationship：canonical uid / 仅 pendingEvict 也 changed / 重复 reset 幂等', () => {
  let state = makeState({
    relationships: { 7: { generationId: 'g7', intimacy: 0.4 } },
    relationshipArchive: {
      orphanLoops: [],
      pendingCold: [],
      pendingEvict: [{ uid: '7', generationId: 'g7', archiveId: 'relationship-archive:7:g7', payload: { intimacy: 0.4 }, at: NOW }],
    },
  });
  const memory = makeMemory();
  const service = createResetService({ getState: () => state, setState: (next) => { state = next; }, memory, now: () => NOW });
  const out = service.handle({ pathname: '/api/socialV2/relationship/reset', uid: '007' });
  assert.equal(out.status, 200);
  assert.equal(out.body.changed, true);
  assert.equal(out.body.uid, '7');
  assert.equal(state.relationships[7], undefined);
  assert.equal(state.relationshipArchive.pendingEvict.length, 0);
  assert.equal(memory.events.has('relationship-reset:7:' + NOW), true);
  const again = service.handle({ pathname: '/api/socialV2/relationship/reset', uid: '7' });
  assert.equal(again.body.changed, false, '重复 reset 幂等');
  // 仅 pendingEvict（关系已无）也要 changed:true
  state = makeState({ relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [{ uid: '9', generationId: 'g9', archiveId: 'relationship-archive:9:g9', payload: { intimacy: 0.1 }, at: NOW }] } });
  const onlyEvict = service.handle({ pathname: '/api/socialV2/relationship/reset', uid: '9' });
  assert.equal(onlyEvict.body.changed, true);
  assert.equal(state.relationshipArchive.pendingEvict.length, 0);
});

test('legacy save：不序列化、不调用 writeFile', () => {
  const state = makeState();
  let wrote = false;
  const out = runSavePipeline({ state, mode: 'legacy', memory: makeMemory(), readOldFile: () => null, writeFile: () => { wrote = true; }, now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'noop-legacy');
  assert.equal(out.serialized, null);
  assert.equal(wrote, false);
  assert.equal(out.state, state);
  assert.throws(() => runSavePipeline({ state, mode: 'bogus', memory: makeMemory(), writeFile: () => {} }), /mode/);
});

test('save 前 retryPendingFacts：到期 pending 在 save 前被处理', () => {
  const state = makeState();
  const memory = makeMemory();
  const entry = { id: 'fact:save-retry', t: NOW, k: 'private:1', kind: 'emotion', text: 'x', meta: { eventType: 'praised', contentHash: 'h', at: NOW }, contentHash: 'h' };
  const pending = {
    eventId: 'fact:save-retry', contentHash: 'h', missingSide: 'mood', attempts: 1,
    payload: { candidates: [], needTension: {}, messageId: null, contextKey: 'private:1', at: NOW, entry },
    lastAttemptAt: NOW, nextAttemptAt: NOW, status: 'pending',
  };
  const withPending = { ...state, agentMood: { ...state.agentMood, pendingFacts: [pending] } };
  const out = runSavePipeline({ state: withPending, mode: 'main', writeCheckpoint: () => {}, memory, readOldFile: () => null, writeFile: () => {}, now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.state.agentMood.pendingFacts.length, 0, 'save 前必须处理到期 pending');
});

test('serialize 失败：archive/evict 的内存变化回滚，冻结 payload 保留', () => {
  const base = makeState();
  // 用 getter 让预算/序列化路径抛错（Map 合法，便于 archive 预提交先发生）；
  // private:1 被 archive 消费删除，private:2 的 wakeConfig getter 在序列化时抛错 → 回滚
  const boom = { get wakeConfig() { throw new Error('serialize-boom'); } };
  const state = {
    ...base,
    conversations: new Map([['private:1', { recentMessages: [] }], ['private:2', boom]]),
    pendingArchive: {
      key: 'private:1', generationId: 'g9', at: NOW, phase: 'checkpoint',
      payload: { lastActionAt: 0, lastIncomingAt: 0, lastInteractionAt: 0, messageCount: 0, topics: [], summary: 's', archivedAt: NOW },
    },
  };
  const memory = makeMemory();
  const out = runSavePipeline({ state, mode: 'main', writeCheckpoint: () => {}, memory, readOldFile: () => null, writeFile: () => {}, now: NOW });
  assert.equal(out.ok, false);
  assert.match(out.code, /serialize-failed|budget-failed/);
  assert.equal(out.state.pendingArchive.phase, 'checkpoint', '回滚到 checkpoint');
  assert.equal(out.state.conversations, state.conversations, 'conversations 回滚');
  assert.equal(memory.events.has('archive:private:1:g9'), true, 'memory 已写行保留');
});

// ── R26 复审补充 ────────────────────────────────────────────────────────────

test('33 会话 main save：冻结 pendingArchive → memory 归档 → 最终 32 会话', () => {
  const base = makeState();
  const conversations = new Map(base.conversations);
  for (let i = 0; i < 32; i += 1) conversations.set('private:' + (100 + i), { lastIncomingAt: 100 + i, recentMessages: [] });
  const state = { ...base, conversations };
  const memory = makeMemory();
  const checkpoints = [];
  const written = [];
  const out = runSavePipeline({
    state, mode: 'main', memory,
    writeCheckpoint: (candidate) => checkpoints.push(candidate),
    readOldFile: () => null,
    writeFile: (obj) => written.push(obj),
    now: NOW,
  });
  assert.equal(out.ok, true);
  assert.ok(checkpoints.length >= 1, '冻结队列必须先落盘');
  assert.equal(out.state.conversations.size, 32, '最终只保留 32 会话');
  assert.equal(out.state.pendingArchive, null, 'archive 槽已清');
  const archivedIds = [...memory.events.keys()].filter((id) => id.startsWith('archive:'));
  assert.equal(archivedIds.length, 1, 'memory 必须写入 archive 行');
  assert.ok(written[0].conversations['private:100'], '最旧会话被归档（保留其余）');
});

test('51 关系 main save：冻结队列先落盘；最终写失败 → 关系回滚但冻结条目保留', () => {
  const relationships = {};
  for (let i = 0; i < 51; i += 1) relationships[String(i + 1)] = { generationId: 'gen-' + (i + 1), intimacy: 0.5, lastInteraction: 100 + i };
  const state = makeState({ relationships });
  const memory = makeMemory();
  const checkpoints = [];
  const out = runSavePipeline({
    state, mode: 'main', memory,
    writeCheckpoint: (candidate) => checkpoints.push(candidate),
    readOldFile: () => null,
    writeFile: () => { throw new Error('disk full'); },
    now: NOW,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'write-failed');
  assert.ok(checkpoints.length >= 1, '关系冻结队列必须先落盘');
  assert.equal(Object.keys(out.state.relationships).length, 51, '写失败关系回滚');
  assert.equal(out.state.relationshipArchive.pendingEvict.length, 1, '冻结条目保留（不得回滚成空）');
  assert.equal(memory.events.has('relationship-archive:1:gen-1'), true, 'memory 行保留（幂等键）');
});

test('有 memory 但缺 writeCheckpoint：applyFactPipeline 必须拒绝', () => {
  const state = makeState();
  assert.throws(
    () => applyFactPipeline({ state, memory: makeMemory(), now: NOW, event: { eventId: 'fact:no-cp', contextKey: 'private:1', eventType: 'praised', at: NOW } }),
    /writeCheckpoint/,
  );
});

test('adapter checkpoint save 抛错：live state 与调用前完全一致', () => {
  const initial = makeState();
  let state = initial;
  let calls = 0;
  const adapter = createSocialV2Adapter({
    getState: () => state,
    setState: (next) => { state = next; },
    save: () => { calls += 1; throw new Error('disk full'); },
    memory: makeMemory(),
    now: () => NOW,
  });
  const out = adapter.applyEmotionEvent('private:1', { type: 'praised', at: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'checkpoint-failed');
  assert.equal(state, initial, 'live state 不得残留 pendingFacts');
  assert.equal(calls, 1);
});

test('adapter memory-disabled：mood 更新并 save 持久化（可重启恢复）', () => {
  const { adapter, saves, memory } = (() => {
    let state = makeState();
    const saves = [];
    const adapter = createSocialV2Adapter({
      getState: () => state,
      setState: (next) => { state = next; },
      save: (candidate) => saves.push(candidate),
      memory: null,
      now: () => NOW,
    });
    return { adapter, saves, get state() { return state; } };
  })();
  const out = adapter.applyEmotionEvent('private:10001', { type: 'praised', at: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.degraded, 'memory-disabled');
  assert.ok(saves.length >= 1, 'memory-disabled 也必须持久化 mood');
  assert.ok((saves[saves.length - 1]?.agentMood?.episodes ?? []).length > 0);
});

test('paused：save/retry/archive 全部 no-op（无 memory 追加、无写盘）', () => {
  const state = { ...makeState(), paused: true };
  const memory = makeMemory();
  let wrote = false;
  const saves = [];
  const pausedPending = {
    ...state,
    agentMood: {
      ...state.agentMood,
      pendingFacts: [{
        eventId: 'fact:paused', contentHash: 'h', missingSide: 'mood', attempts: 0,
        payload: { candidates: [], needTension: {}, messageId: null, contextKey: 'private:1', at: NOW, entry: { id: 'fact:paused', t: NOW, k: 'private:1', kind: 'emotion', text: '', meta: {}, contentHash: 'h' } },
        lastAttemptAt: 0, nextAttemptAt: 0, status: 'pending',
      }],
    },
  };
  const out = runSavePipeline({ state: pausedPending, mode: 'main', writeCheckpoint: (c) => saves.push(c), memory, readOldFile: () => null, writeFile: () => { wrote = true; }, now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'paused');
  assert.equal(wrote, false);
  assert.equal(saves.length, 0);
  assert.equal(memory.events.size, 0);
  assert.equal(retryPendingFacts({ state: pausedPending, memory, now: NOW }).retried, 0);
  assert.equal(runArchivePipeline({ state: pausedPending, memory, now: NOW }).code, 'paused');
});

test("adapter uid canonical：'007' 写入/读取命中 '7'", () => {
  const { adapter, getState } = makeAdapter();
  const out = adapter.applyRelationshipEvent('007', 'praised', {});
  assert.equal(out.ok, true);
  assert.equal(out.uid, '7');
  assert.ok(getState().relationships['7']);
  assert.equal(getState().relationships['007'], undefined);
  assert.equal(adapter.getRelationship('007').uid, '7');
  const invalid = adapter.applyRelationshipEvent('not-a-uid', 'praised', {});
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid_uid');
});

test('workspace reset：二次调用 changed:false', () => {
  let state = makeState();
  const service = createResetService({ getState: () => state, setState: (next) => { state = next; }, now: () => NOW });
  assert.equal(service.handle({ pathname: '/api/socialV2/reset' }).body.changed, true);
  assert.equal(service.handle({ pathname: '/api/socialV2/reset' }).body.changed, false, '重复 workspace reset changed:false');
});

test('关系事件 save 抛错：live state 不变', () => {
  const initial = makeState();
  let state = initial;
  const adapter = createSocialV2Adapter({
    getState: () => state,
    setState: (next) => { state = next; },
    save: () => { throw new Error('disk full'); },
    memory: makeMemory(),
    now: () => NOW,
  });
  const out = adapter.applyRelationshipEvent('10002', 'praised', {});
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'save-failed');
  assert.equal(state, initial);
});

// ── R27 复审补充 ────────────────────────────────────────────────────────────

test('33 会话 + memory 成功 + 最终写失败：保留本次 frozen checkpoint，重试不产生第二个 archive ID', () => {
  const base = makeState();
  const conversations = new Map([['private:1', { recentMessages: [] }]]);
  for (let i = 0; i < 32; i += 1) conversations.set('private:' + (100 + i), { lastIncomingAt: 100 + i, recentMessages: [] });
  const state = { ...base, conversations };
  const memory = makeMemory();
  const out = runSavePipeline({ state, mode: 'main', memory, writeCheckpoint: () => {}, readOldFile: () => null, writeFile: () => { throw new Error('disk full'); }, now: NOW });
  assert.equal(out.ok, false);
  assert.ok(out.state.pendingArchive, '本次冻结的 checkpoint 必须保留');
  assert.equal(out.state.pendingArchive.phase, 'checkpoint');
  const firstGen = out.state.pendingArchive.generationId;
  assert.equal(out.state.conversations.size, 33, '会话回滚到 33');
  // 不同时间重试：复用冻结槽，不产生第二个 generation/archive 行
  const retry = runSavePipeline({ state: out.state, mode: 'main', memory, writeCheckpoint: () => {}, readOldFile: () => null, writeFile: () => {}, now: NOW + 5000 });
  assert.equal(retry.ok, true);
  assert.equal(retry.state.conversations.size, 32);
  assert.equal(retry.state.pendingArchive, null);
  const archiveIds = [...memory.events.keys()].filter((id) => id.startsWith('archive:'));
  assert.equal(archiveIds.length, 1, '只产生一个 archive 行');
  assert.equal(archiveIds[0], 'archive:' + out.state.pendingArchive?.key + ':' + firstGen, '沿用同一 generation');
});

test('pendingEvict(g-old) + 同 uid 新 generation：不得删除新关系，finalize 只清旧 item', () => {
  const state = makeState({
    relationships: { 7: { generationId: 'g-new', intimacy: 0.5 } },
    relationshipArchive: {
      orphanLoops: [],
      pendingCold: [],
      pendingEvict: [{ uid: '7', generationId: 'g-old', archiveId: 'relationship-archive:7:g-old', payload: { intimacy: 0.5, archivedAt: NOW }, at: NOW }],
    },
  });
  const memory = makeMemory();
  const consumed = consumeRelationshipEvict({ state, memory, now: NOW });
  assert.equal(consumed.written, 1);
  assert.ok(consumed.state.relationships['7'], '新 generation 关系不得删除');
  assert.equal(consumed.state.relationships['7'].generationId, 'g-new');
  const finalized = finalizeRelationshipEvict({ state: consumed.state, consumedIds: consumed.writtenIds });
  assert.equal(finalized.relationshipArchive.pendingEvict.length, 0, '旧 item 被清');
  assert.ok(finalized.relationships['7']);
});

test('adapter checkpoint 成功、final save 失败：live 保留可重放 checkpoint（不丢 pending）', () => {
  let state = makeState();
  let calls = 0;
  const memory = makeMemory();
  const adapter = createSocialV2Adapter({
    getState: () => state,
    setState: (next) => { state = next; },
    save: () => { calls += 1; if (calls >= 2) throw new Error('disk full'); },
    memory,
    now: () => NOW,
  });
  const out = adapter.applyEmotionEvent('private:1', { type: 'praised', at: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'save-failed');
  assert.equal(state.agentMood.pendingFacts.length, 1, 'live 必须保留 checkpoint pending');
  assert.equal(memory.events.has(out.eventId), true, 'memory 已有事实');
});

test('32 会话门槛：乱序 recentMessages 按全部消息最大时间选择淘汰对象', () => {
  const base = makeState();
  const conversations = new Map([['private:1', { recentMessages: [{ time: 5000 }, { time: 0 }] }]]);
  for (let i = 0; i < 32; i += 1) conversations.set('private:' + (2 + i), { lastIncomingAt: 100 + i, recentMessages: [] });
  const state = { ...base, conversations };
  const prepared = prepareConversationArchive({ state, now: NOW });
  assert.equal(prepared.frozen, true);
  assert.equal(prepared.state.pendingArchive.key, 'private:2', '按 max(消息时间) 应淘汰 lastIncomingAt 最小的 private:2');
  assert.notEqual(prepared.state.pendingArchive.key, 'private:1');
});

test('35 会话：多次 save 收敛到 32，首次 saveStatus degraded 且带 conversations_overflow', () => {
  const base = makeState();
  const conversations = new Map();
  for (let i = 0; i < 35; i += 1) conversations.set('private:' + (200 + i), { lastIncomingAt: 10 + i, recentMessages: [] });
  let state = { ...base, conversations };
  const memory = makeMemory();
  let first = null;
  for (let i = 0; i < 5 && state.conversations.size > 32; i += 1) {
    const out = runSavePipeline({ state, mode: 'main', memory, writeCheckpoint: () => {}, readOldFile: () => null, writeFile: () => {}, now: NOW + i * 1000 });
    assert.equal(out.ok, true);
    if (!first) first = out;
    state = out.state;
  }
  assert.equal(state.conversations.size, 32, '多次 save 必须收敛到 32');
  assert.equal(first.saveStatus, 'degraded');
  assert.ok((first.degradedReasons ?? []).includes('conversations_overflow'));
});

test('paused：prepare/consume 均 no-op，且输入 state 深相等（纯函数边界）', () => {
  const base = makeState();
  const conversations = new Map();
  for (let i = 0; i < 35; i += 1) conversations.set('private:' + (300 + i), { lastIncomingAt: 10 + i, recentMessages: [] });
  const state = {
    ...base,
    paused: true,
    conversations,
    relationships: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [String(i + 1), { generationId: 'g' + (i + 1), intimacy: 0.5, lastInteraction: 100 + i }])),
  };
  const snapshot = JSON.parse(JSON.stringify({ ...state, conversations: [...state.conversations.entries()] }));
  const memory = makeMemory();
  const prepared = prepareConversationArchive({ state, now: NOW });
  assert.equal(prepared.frozen, false);
  const evictPrepared = prepareRelationshipEvict({ state, now: NOW });
  assert.equal(evictPrepared.added, 0);
  const consumed = consumeRelationshipEvict({ state, memory, now: NOW });
  assert.equal(consumed.written, 0);
  assert.equal(memory.events.size, 0);
  assert.deepEqual(JSON.parse(JSON.stringify({ ...state, conversations: [...state.conversations.entries()] })), snapshot, 'state 不得被修改');
});

test('prepareConversationArchive / prepareRelationshipEvict 是纯函数：输入 state 深相等', () => {
  const base = makeState();
  const conversations = new Map();
  for (let i = 0; i < 35; i += 1) conversations.set('private:' + (400 + i), { lastIncomingAt: 10 + i, recentMessages: [] });
  const relationships = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [String(i + 1), { generationId: 'g' + (i + 1), intimacy: 0.5, lastInteraction: 100 + i }]));
  const state = { ...base, conversations, relationships };
  const snapshot = JSON.parse(JSON.stringify({
    conversations: [...conversations.entries()],
    relationships,
  }));
  const archived = prepareConversationArchive({ state, now: NOW });
  assert.equal(archived.frozen, true);
  const evicted = prepareRelationshipEvict({ state, now: NOW });
  assert.equal(evicted.added, 1);
  assert.deepEqual(JSON.parse(JSON.stringify({
    conversations: [...state.conversations.entries()],
    relationships: state.relationships,
  })), snapshot, '两次 prepare 不得修改入参');
});

test('workspace reset：paused 或非 episode mood 字段也应 changed:true', () => {
  // paused 唯一非默认
  let state = { ...makeState(), paused: true };
  const service = createResetService({ getState: () => state, setState: (next) => { state = next; }, now: () => NOW });
  assert.equal(service.handle({ pathname: '/api/socialV2/reset' }).body.changed, true);
  assert.equal(service.handle({ pathname: '/api/socialV2/reset' }).body.changed, false);
  // 只有 baseline/needs（无 episodes）
  let state2 = makeState();
  state2 = { ...state2, agentMood: { ...state2.agentMood, needs: { safety: { value: 0.7, updatedAt: NOW } } } };
  const service2 = createResetService({ getState: () => state2, setState: (next) => { state2 = next; }, now: () => NOW });
  assert.equal(service2.handle({ pathname: '/api/socialV2/reset' }).body.changed, true, 'needs 非空也算 changed');
});

// ── R28 复审补充 ────────────────────────────────────────────────────────────

function manyRelationships(n) {
  const rels = {};
  for (let i = 0; i < n; i += 1) rels[String(i + 1)] = { generationId: 'gen-' + (i + 1), intimacy: 0.5, lastInteraction: 100 + i };
  return rels;
}

test('51 关系成功 save：写入文件的 pendingEvict 必须为空（磁盘不得残留僵尸队列）', () => {
  const state = makeState({ relationships: manyRelationships(51) });
  const memory = makeMemory();
  const written = [];
  const out = runSavePipeline({ state, mode: 'main', memory, writeCheckpoint: () => {}, readOldFile: () => null, writeFile: (obj) => written.push(obj), now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.state.relationshipArchive.pendingEvict.length, 0);
  assert.equal(written[0].relationshipArchive.pendingEvict.length, 0, '磁盘上的冻结队列必须清空');
  assert.equal(Object.keys(written[0].relationships).length, 50);
});

test('51 关系写失败 → 保留冻结队列；重试（duplicate）成功后最终文件清空', () => {
  const state = makeState({ relationships: manyRelationships(51) });
  const memory = makeMemory();
  const failed = runSavePipeline({ state, mode: 'main', memory, writeCheckpoint: () => {}, readOldFile: () => null, writeFile: () => { throw new Error('disk full'); }, now: NOW });
  assert.equal(failed.ok, false);
  assert.equal(failed.state.relationshipArchive.pendingEvict.length, 1, '写失败保留冻结条目');
  assert.equal(Object.keys(failed.state.relationships).length, 51, '关系回滚');
  const written = [];
  const retry = runSavePipeline({ state: failed.state, mode: 'main', memory, writeCheckpoint: () => {}, readOldFile: () => null, writeFile: (obj) => written.push(obj), now: NOW + 1000 });
  assert.equal(retry.ok, true);
  assert.equal(written[0].relationshipArchive.pendingEvict.length, 0, '重试后最终文件清空');
  assert.equal(Object.keys(written[0].relationships).length, 50);
});

test('多 checkpoint 事务：会话 checkpoint 成功、关系 checkpoint 失败 → 返回最后一个已落盘 checkpoint', () => {
  const base = makeState({ relationships: manyRelationships(51) });
  const conversations = new Map([['private:1', { recentMessages: [] }]]);
  for (let i = 0; i < 32; i += 1) conversations.set('private:' + (100 + i), { lastIncomingAt: 100 + i, recentMessages: [] });
  const state = { ...base, conversations };
  const memory = makeMemory();
  let calls = 0;
  const out = runSavePipeline({
    state, mode: 'main', memory,
    writeCheckpoint: () => { calls += 1; if (calls === 2) throw new Error('cp2'); },
    readOldFile: () => null, writeFile: () => {}, now: NOW,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'checkpoint-failed');
  assert.equal(out.state.conversations.size, 33, '返回会话 checkpoint（不是原始 null 槽）');
  assert.ok(out.state.pendingArchive, '会话冻结 checkpoint 必须保留');
  assert.equal(Object.keys(out.state.relationships).length, 51, '关系未消费');
  // 再次 save：复用会话冻结槽，只产生一个会话 archive ID
  const retry = runSavePipeline({ state: out.state, mode: 'main', memory, writeCheckpoint: () => {}, readOldFile: () => null, writeFile: () => {}, now: NOW + 1000 });
  assert.equal(retry.ok, true);
  const sessionArchives = [...memory.events.keys()].filter((id) => id.startsWith('archive:'));
  assert.equal(sessionArchives.length, 1, '只产生一个会话 archive ID');
  assert.equal(retry.state.conversations.size, 32);
});

test('workspace reset changed:false：严格 no-op（state 深相等、persist 零调用、时间戳不变）', () => {
  let state = makeState();
  const persists = [];
  const service = createResetService({ getState: () => state, setState: (next) => { state = next; }, persist: (next) => persists.push(next), now: () => NOW });
  assert.equal(service.handle({ pathname: '/api/socialV2/reset' }).body.changed, true);
  const snapshot = JSON.stringify({ ...state, conversations: [...state.conversations.entries()], seenForwardIds: [...state.seenForwardIds.entries()] });
  const persistCount = persists.length;
  const again = service.handle({ pathname: '/api/socialV2/reset' });
  assert.equal(again.body.changed, false);
  assert.equal(persistCount, persists.length, 'changed:false 不得 persist');
  const after = JSON.stringify({ ...state, conversations: [...state.conversations.entries()], seenForwardIds: [...state.seenForwardIds.entries()] });
  assert.equal(after, snapshot, 'changed:false 不得改动 state（含时间戳）');
});

test('workspace changed：migration.warnings / agentMood 单标量非默认也必须 true', () => {
  let state1 = makeState();
  state1 = { ...state1, migration: { ...state1.migration, warnings: ['legacy warning'] } };
  const s1 = createResetService({ getState: () => state1, setState: (next) => { state1 = next; }, now: () => NOW });
  assert.equal(s1.handle({ pathname: '/api/socialV2/reset' }).body.changed, true, 'warnings 非空算 changed');
  let state2 = makeState();
  state2 = { ...state2, agentMood: { ...state2.agentMood, chronicLoad: 0.5 } };
  const s2 = createResetService({ getState: () => state2, setState: (next) => { state2 = next; }, now: () => NOW });
  assert.equal(s2.handle({ pathname: '/api/socialV2/reset' }).body.changed, true, 'chronicLoad 非默认算 changed');
});

test('emotion/relationship/session reset 的 changed:false 严格无副作用', () => {
  let state = makeState();
  const persists = [];
  const memory = makeMemory();
  const service = createResetService({ getState: () => state, setState: (next) => { state = next; }, persist: (next) => persists.push(next), memory, now: () => NOW });
  // emotion：空 mood → false 且不 persist
  const emo = service.handle({ pathname: '/api/socialV2/emotion/reset' });
  assert.equal(emo.body.changed, false);
  assert.equal(persists.length, 0);
  // relationship：不存在 → false 且不写墓碑
  const rel = service.handle({ pathname: '/api/socialV2/relationship/reset', uid: '999' });
  assert.equal(rel.body.changed, false);
  assert.equal(memory.events.size, 0);
  // session：不存在 → false
  const sess = service.handle({ pathname: '/api/session/reset', key: 'private:999' });
  assert.equal(sess.body.changed, false);
});

// ── R29 复审补充：结构化预算判定 ────────────────────────────────────────────

function moodWithTargetBytes(bytesTarget) {
  const mood = { schemaVersion: 2, episodes: [{ id: 'e', kind: 'joy', pad: '' }] };
  const baseBytes = agentMoodBytes({ agentMood: mood });
  const pad = Math.max(0, bytesTarget - baseBytes);
  mood.episodes[0].pad = 'x'.repeat(pad);
  // 微调：确保目标值可达（x 1 字节）
  let guard = 0;
  while (agentMoodBytes({ agentMood: mood }) > bytesTarget && guard < 10) {
    mood.episodes[0].pad = mood.episodes[0].pad.slice(0, -1);
    guard += 1;
  }
  return mood;
}

test('evaluateBudgetGate：仅 relationshipArchive 超 96KB → archiveRejectNew=true、relationshipColdFirst=false', () => {
  const state = { ...makeState(), relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [{ uid: '1', payload: { pad: 'x'.repeat(100 * 1024) } }] } };
  const gate = evaluateBudgetGate({ state, scope: 'event' });
  assert.equal(gate.decisions.archiveRejectNew, true);
  assert.equal(gate.decisions.relationshipColdFirst, false);
  assert.ok(gate.overUnits.includes('relationshipArchive'));
  assert.ok(!gate.overUnits.includes('relationships'));
  assert.equal(gate.saveStatus, 'degraded');
});

test('evaluateBudgetGate：仅 relationships 超 64KB → relationshipColdFirst=true、archiveRejectNew=false', () => {
  const relationships = { 1: { intimacy: 0.5, pad: 'x'.repeat(70 * 1024) } };
  const state = { ...makeState(), relationships };
  const gate = evaluateBudgetGate({ state, scope: 'event' });
  assert.equal(gate.decisions.relationshipColdFirst, true);
  assert.equal(gate.decisions.archiveRejectNew, false);
  assert.ok(gate.overUnits.includes('relationships'));
  assert.ok(!gate.overUnits.includes('relationshipArchive'));
});

test('evaluateBudgetGate：两者同时超限 → 两个 decision 都为 true', () => {
  const state = {
    ...makeState(),
    relationships: { 1: { intimacy: 0.5, pad: 'x'.repeat(70 * 1024) } },
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [{ uid: '1', payload: { pad: 'x'.repeat(100 * 1024) } }] },
  };
  const gate = evaluateBudgetGate({ state, scope: 'event' });
  assert.equal(gate.decisions.relationshipColdFirst, true);
  assert.equal(gate.decisions.archiveRejectNew, true);
  assert.deepEqual(gate.overUnits.sort(), ['relationshipArchive', 'relationships']);
});

test('evaluateBudgetGate：agentMood 96KB 边界（恰好 / 超 1 字节）', () => {
  const base = makeState();
  const exact = { ...base, agentMood: moodWithTargetBytes(96 * 1024) };
  assert.equal(agentMoodBytes(exact) <= 96 * 1024, true);
  assert.equal(evaluateBudgetGate({ state: exact, scope: 'event' }).decisions.rejectNewEmotionFacts, false);
  const over = { ...base, agentMood: moodWithTargetBytes(96 * 1024 + 1) };
  assert.ok(agentMoodBytes(over) > 96 * 1024);
  assert.equal(evaluateBudgetGate({ state: over, scope: 'event' }).decisions.rejectNewEmotionFacts, true);
});

test('agentMoodBytes：BigInt / 循环引用 → Infinity（fail-closed）', () => {
  const bigintState = { agentMood: { big: 1n } };
  assert.equal(agentMoodBytes(bigintState), Number.POSITIVE_INFINITY);
  const circular = { agentMood: {} };
  circular.agentMood.self = circular.agentMood;
  assert.equal(agentMoodBytes(circular), Number.POSITIVE_INFINITY);
  const gate = evaluateBudgetGate({ state: bigintState, scope: 'event' });
  assert.equal(gate.decisions.rejectNewEmotionFacts, true, '测量失败必须 fail-closed');
});

test('mood-budget：候选越界即拒绝（不写 checkpoint/memory）', () => {
  const base = makeState();
  const state = { ...base, agentMood: moodWithTargetBytes(96 * 1024 - 1) }; // 候选必然越界
  const memory = makeMemory();
  let checkpoints = 0;
  const out = applyFactPipeline({
    state,
    memory,
    now: NOW,
    event: { eventId: 'fact:budget', contextKey: 'private:1', eventType: 'praised', at: NOW },
    writeCheckpoint: () => { checkpoints += 1; },
  });
  assert.equal(out.code, 'mood-budget-full');
  assert.equal(checkpoints, 0, '拒绝时不得写 checkpoint');
  assert.equal(memory.events.size, 0, '拒绝时不得写 memory');
  assert.equal(out.state, state, '保持旧状态');
});

// ── R30 复审补充：预算接口完整性与一致性 ────────────────────────────────────

test('evaluateBudgetGate(save-scope)：无 serialized → complete:false（禁止消费 total/conversation 决策）', () => {
  const base = makeState();
  const conversations = new Map();
  for (let i = 0; i < 6; i += 1) conversations.set('private:' + (500 + i), { pad: 'x'.repeat(1024 * 1024) });
  const state = { ...base, conversations };
  assert.throws(() => evaluateBudgetGate({ state, scope: 'save' }), /budget-scope-incomplete/, 'save-scope 缺 serialized 必须抛错');
  const serialized = { version: 2, conversations: Object.fromEntries([...conversations].map(([key, conv]) => [key, conv])) };
  const withSerialized = evaluateBudgetGate({ state, serialized, scope: 'save' });
  assert.equal(withSerialized.complete, true);
  assert.equal(withSerialized.decisions.globalReject, true);
  assert.equal(withSerialized.saveStatus, 'rejected');
  // event-scope 不需要 serialized
  const eventScope = evaluateBudgetGate({ state, scope: 'event' });
  assert.equal(eventScope.complete, true);
});

test('evaluateBudgetGate 与 computeBudgets 单会话边界一致（128KB target / 192KB hard）', () => {
  const base = makeState();
  const state = { ...base, conversations: new Map() };
  const trimSerialized = { version: 2, conversations: { x: { pad: 'x'.repeat(140 * 1024) } } };
  const trimGate = evaluateBudgetGate({ state, serialized: trimSerialized });
  assert.equal(trimGate.decisions.conversationTrim, true);
  assert.equal(trimGate.decisions.conversationHardReject, false);
  assert.equal(trimGate.saveStatus, 'degraded');
  const hardSerialized = { version: 2, conversations: { x: { pad: 'x'.repeat(226 * 1024) } } };
  const hardGate = evaluateBudgetGate({ state, serialized: hardSerialized });
  assert.equal(hardGate.decisions.conversationHardReject, true);
  assert.equal(hardGate.saveStatus, 'rejected');
  const budgets = computeBudgets(state, { serialized: hardSerialized });
  assert.equal(budgets.saveStatus, 'rejected', '与 computeBudgets 的 hard reject 一致');
});

test('mood-budget：checkpoint 含 pending 载荷也不得越过 96KB', () => {
  const base = makeState();
  const state = { ...base, agentMood: moodWithTargetBytes(96 * 1024 - 2400) };
  const memory = makeMemory();
  let checkpoints = 0;
  const out = applyFactPipeline({
    state,
    memory,
    now: NOW,
    event: { eventId: 'fact:cp-budget', contextKey: 'private:1', eventType: 'praised', at: NOW },
    writeCheckpoint: () => { checkpoints += 1; },
  });
  assert.equal(out.code, 'mood-budget-full', '含 pending 的 checkpoint 越界必须拒绝');
  assert.equal(checkpoints, 0);
  assert.equal(memory.events.size, 0);
});

test('BigInt agentMood：measurementFailed 限定作用域，不升级为全局拒写', () => {
  const gate = evaluateBudgetGate({ state: { agentMood: { big: 1n } }, scope: 'event' });
  assert.equal(gate.decisions.rejectNewEmotionFacts, true);
  assert.equal(gate.decisions.globalReject, false, 'mood 测量失败不得触发全局拒写');
  assert.ok(gate.measurementFailed.includes('agentMood'));
  assert.equal(gate.complete, false);
});

test('rankRelationshipPressure：HOT ≤10、cold 候选排序、队列满标记', () => {
  const relationships = {};
  for (let i = 0; i < 51; i += 1) relationships[String(i + 1)] = { generationId: 'g' + (i + 1), intimacy: 0.5, lastInteraction: 100 + i };
  const state = makeState({
    relationships,
    relationshipArchive: {
      orphanLoops: Array.from({ length: 10 }, (_, i) => ({ uid: String(i + 1), generationId: 'g' })),
      pendingCold: Array.from({ length: 10 }, (_, i) => ({ uid: String(i + 1), generationId: 'g' })),
      pendingEvict: Array.from({ length: 10 }, (_, i) => ({ uid: String(i + 1), generationId: 'g', payload: {} })),
    },
  });
  const pressure = rankRelationshipPressure(state);
  assert.equal(pressure.total, 51);
  assert.equal(pressure.hot.length, 10);
  assert.equal(pressure.hot.includes('51'), true, '最近的 10 个在 HOT');
  assert.equal(pressure.coldCandidates.length, 41);
  assert.equal(pressure.coldCandidates[0], '1', 'cold 候选按 lastInteraction 升序');
  assert.equal(pressure.orphanFull, true);
  assert.equal(pressure.pendingColdFull, true);
  assert.equal(pressure.pendingEvictFull, true);
});

test('budget decisions → 1C 错误码映射表结构（enum 布尔 + unit）', () => {
  const gate = evaluateBudgetGate({ state: makeState(), scope: 'event' });
  assert.deepEqual(Object.keys(gate.decisions).sort(), [
    'archiveRejectNew', 'conversationHardReject', 'conversationTrim', 'globalReject', 'relationshipColdFirst', 'rejectNewEmotionFacts',
  ].sort());
  assert.ok(Array.isArray(gate.overUnits));
  const codeMap = {
    agentMood: 'mood-budget-full',
    relationships: 'relationship-budget-full',
    relationshipArchive: 'archive-budget-full',
    total: 'save-rejected',
    conversationHard: 'save-rejected',
  };
  assert.equal(codeMap.agentMood, 'mood-budget-full');
});

test('文件头版本注记：exec/adapter 均为 Internals v2.24', async () => {
  const fs = await import('node:fs');
  const execHead = fs.readFileSync(new URL('../src/core/socialv2-exec.mjs', import.meta.url), 'utf8').split('\n')[0];
  const adapterHead = fs.readFileSync(new URL('../src/core/socialv2-adapter.mjs', import.meta.url), 'utf8').split('\n')[0];
  assert.match(execHead, /v2\.24/);
  assert.match(adapterHead, /v2\.24/);
});

// ── R31 复审补充：入口 fail-closed ──────────────────────────────────────────

test('evaluateBudgetGate：非法 scope 必须抛错', () => {
  assert.throws(() => evaluateBudgetGate({ state: makeState(), scope: 'bogus' }), /scope/);
  assert.throws(() => evaluateBudgetGate({ state: makeState(), scope: null }), /scope/);
});

test('rankRelationshipPressure：degraded HOT=15 与 hotLimit 回显', () => {
  const relationships = {};
  for (let i = 0; i < 51; i += 1) relationships[String(i + 1)] = { generationId: 'g' + (i + 1), intimacy: 0.5, lastInteraction: 100 + i };
  const state = makeState({ relationships });
  const normal = rankRelationshipPressure(state);
  assert.equal(normal.hotLimit, 10);
  assert.equal(normal.hot.length, 10);
  const degraded = rankRelationshipPressure(state, { hotLimit: 15 });
  assert.equal(degraded.hotLimit, 15);
  assert.equal(degraded.hot.length, 15);
  assert.equal(degraded.coldCandidates.length, 36);
  assert.equal(degraded.hot.includes('51'), true);
});

test('budgetErrorFor：固定错误码 + unit 映射（不解析文本）', () => {
  const archiveGate = evaluateBudgetGate({ state: { ...makeState(), relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [{ uid: '1', payload: { pad: 'x'.repeat(100 * 1024) } }] } }, scope: 'event' });
  assert.equal(budgetErrorFor(archiveGate).code, 'archive-budget-full');
  assert.equal(budgetErrorFor(archiveGate).unit, 'relationshipArchive');
  const cleanGate = evaluateBudgetGate({ state: makeState(), scope: 'event' });
  assert.equal(budgetErrorFor(cleanGate).code, null);
});

// ── R32 复审补充：入口边界 ──────────────────────────────────────────────────

test('save-scope：serialized={} / 缺 conversations / conversations 为数组 → 必须抛错', () => {
  const state = makeState();
  assert.throws(() => evaluateBudgetGate({ state, serialized: {}, scope: 'save' }), /budget-scope-incomplete/);
  assert.throws(() => evaluateBudgetGate({ state, serialized: { version: 2 }, scope: 'save' }), /budget-scope-incomplete/);
  assert.throws(() => evaluateBudgetGate({ state, serialized: { conversations: [] }, scope: 'save' }), /budget-scope-incomplete/);
  assert.throws(() => evaluateBudgetGate({ state, serialized: null, scope: 'save' }), /budget-scope-incomplete/);
});

test('budgetActionsFor：conversation-only trim → conversation-trim（不得是 save-rejected）；hard → save-rejected', () => {
  const state = makeState();
  const trimGate = evaluateBudgetGate({ state, serialized: { conversations: { x: { pad: 'x'.repeat(140 * 1024) } } }, scope: 'save' });
  const trimActions = budgetActionsFor(trimGate);
  assert.equal(trimActions.actions.length, 1);
  assert.equal(trimActions.actions[0].code, 'conversation-trim');
  assert.equal(trimActions.actions[0].action, 'trim-conversation');
  assert.notEqual(trimActions.actions[0].code, 'save-rejected');
  const hardGate = evaluateBudgetGate({ state, serialized: { conversations: { x: { pad: 'x'.repeat(226 * 1024) } } }, scope: 'save' });
  assert.equal(budgetActionsFor(hardGate).actions[0].code, 'save-rejected');
});

test('rankRelationshipPressure：hotLimit 只允许 10/15，其他值抛错', () => {
  const state = makeState();
  assert.throws(() => rankRelationshipPressure(state, { hotLimit: 11 }), /hotLimit/);
  assert.throws(() => rankRelationshipPressure(state, { hotLimit: 20 }), /hotLimit/);
  assert.throws(() => rankRelationshipPressure(state, { hotLimit: 10.5 }), /hotLimit/);
  assert.equal(rankRelationshipPressure(state, { hotLimit: 10 }).hotLimit, 10);
  assert.equal(rankRelationshipPressure(state, { hotLimit: 15 }).hotLimit, 15);
});

test('budgetActionsFor：多单位同时超限返回全部动作/错误', () => {
  const state = {
    ...makeState(),
    agentMood: moodWithTargetBytes(97 * 1024),
    relationships: { 1: { intimacy: 0.5, pad: 'x'.repeat(70 * 1024) } },
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [{ uid: '1', payload: { pad: 'x'.repeat(100 * 1024) } }] },
  };
  const gate = evaluateBudgetGate({ state, scope: 'event' });
  const out = budgetActionsFor(gate);
  assert.ok(out.actions.length >= 3);
  assert.ok(out.errors.some((item) => item.code === 'mood-budget-full'));
  assert.ok(out.errors.some((item) => item.code === 'relationship-budget-full'));
  assert.ok(out.errors.some((item) => item.code === 'archive-budget-full'));
  assert.deepEqual(out.overUnits, gate.overUnits);
});

test('final/transition/shadow 三种 serializer 输出可直接传入 save-scope', async () => {
  const { serializeSocialV2 } = await import('../src/core/socialv2-state.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const now = 1_800_000_000_000;
  const raw = { version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, pendingArchive: null, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 }, conversations: { 'private:1': { recentMessages: [] } } };
  const state = loadSocialV2State(raw, { now }).state;
  const final = serializeSocialV2(state, { mode: 'final' });
  assert.doesNotThrow(() => evaluateBudgetGate({ state, serialized: final, scope: 'save' }));
  const shadow = serializeSocialV2(state, { mode: 'shadow', sourceSchema: 'v1' });
  assert.doesNotThrow(() => evaluateBudgetGate({ state, serialized: shadow, scope: 'save' }));
  const transitionState = { ...state, migration: { ...state.migration, status: 'pending', revision: 0 } };
  const transition = serializeSocialV2(transitionState, { mode: 'transition' });
  assert.doesNotThrow(() => evaluateBudgetGate({ state: transitionState, serialized: transition, scope: 'save' }));
});

// ── R33 复审补充：plain object 严格性 + fatal 短路 ──────────────────────────

test('save-scope：Map/Date/class instance 作为 conversations 或根对象 → 抛错', () => {
  const state = makeState();
  class FakeConversations { constructor() { this.x = 1; } }
  assert.throws(() => evaluateBudgetGate({ state, serialized: { conversations: new Map([['x', {}]]) }, scope: 'save' }), /budget-scope-incomplete/);
  assert.throws(() => evaluateBudgetGate({ state, serialized: { conversations: new Date() }, scope: 'save' }), /budget-scope-incomplete/);
  assert.throws(() => evaluateBudgetGate({ state, serialized: { conversations: new FakeConversations() }, scope: 'save' }), /budget-scope-incomplete/);
  assert.throws(() => evaluateBudgetGate({ state, serialized: new Map(), scope: 'save' }), /budget-scope-incomplete/);
  assert.throws(() => evaluateBudgetGate({ state, serialized: [], scope: 'save' }), /budget-scope-incomplete/);
  // null prototype 允许
  const nullProto = Object.create(null);
  nullProto.conversations = Object.create(null);
  assert.doesNotThrow(() => evaluateBudgetGate({ state, serialized: nullProto, scope: 'save' }));
});

test('budgetActionsFor：fatal 置顶、fatal/shortCircuit 字段、budgetErrorFor 一致', () => {
  const state = {
    ...makeState(),
    relationships: { 1: { intimacy: 0.5, pad: 'x'.repeat(70 * 1024) } },
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [{ uid: '1', payload: { pad: 'x'.repeat(100 * 1024) } }] },
  };
  const gate = evaluateBudgetGate({ state, serialized: { conversations: { big: { pad: 'x'.repeat(6 * 1024 * 1024) } } }, scope: 'save' });
  assert.equal(gate.decisions.globalReject, true);
  const out = budgetActionsFor(gate);
  assert.equal(out.fatal, true);
  assert.equal(out.shortCircuit, 'save-rejected');
  assert.equal(out.actions[0].code, 'save-rejected', 'fatal 必须置顶');
  assert.equal(out.actions[0].fatal, true);
  assert.equal(out.errors[0].fatal, true);
  assert.equal(budgetErrorFor(gate).code, 'save-rejected', 'budgetErrorFor 与 actions 的 fatal 选择一致');
});

test('applyFactPipeline：不传 eventId 时 entry.id / 返回 eventId / episode.latestSourceEventId 三者一致（重启后仍一致）', () => {
  const state = makeState();
  const memory = makeMemory();
  const out = applyFactPipeline({
    state, writeCheckpoint: () => {}, memory, now: NOW,
    event: { contextKey: 'private:10001', actorUid: '10001', eventType: 'praised', at: NOW, text: '你真棒' },
  });
  assert.equal(out.code, 'ok');
  assert.ok(out.eventId, '必须返回生成的 eventId');
  assert.ok(memory.events.has(out.eventId), 'memory 写入的事件 id = 返回的 eventId');
  const eps = out.state.agentMood.episodes || [];
  const ep = eps.find((x) => x.latestSourceEventId);
  assert.ok(ep, 'episode 必须带 latestSourceEventId');
  assert.equal(ep.latestSourceEventId, out.eventId, 'episode 来源 id = memory 事件 id（追溯链）');
  // 序列化 → 重新 load（模拟重启）后仍一致
  const reloaded = loadSocialV2State(JSON.parse(JSON.stringify(out.state)), { now: NOW }).state;
  const ep2 = (reloaded.agentMood.episodes || []).find((x) => x.latestSourceEventId);
  assert.ok(ep2, '重启后 episode 仍带 source id');
  assert.equal(ep2.latestSourceEventId, out.eventId, '重启后追溯链不变');
});
