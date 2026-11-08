// 情绪系统 V2 —— 1B 状态层单测（契约：ADDENDUM-1B-internals v2.10）
// 覆盖：normalize/plan/load 纯边界、迁移 driver（proposedState/提交语义）、三模式 serialize、
// seenForwardIds md5、预算、pendingArchive/pendingEvict、memory 稳定 id 幂等 API。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  V2_STATE_SCHEMA_VERSION, MAX_CONVERSATIONS, MAX_RELATIONSHIPS, MAX_PENDING_EVICT,
  AGENT_MOOD_BUDGET_BYTES, GLOBAL_BUDGET_BYTES, SEEN_FORWARD_MAX,
  hashSeenForwardId, normalizeSeenForwardIds, readSeenForwardIds,
  normalizeRelationshipEntry, normalizeSocialV2, planSocialV2, loadSocialV2State,
  runMigrationStep, applyStartupMigration, serializeSocialV2, computeBudgets,
} from '../src/core/socialv2-state.mjs';
import { createMemoryStore, dayString } from '../src/core/memory-store.mjs';

const NOW = 1_700_000_000_000;

function v1Raw(overrides = {}) {
  return {
    version: 1,
    paused: false,
    conversations: {
      'private:1': {
        lastIncomingAt: 1000,
        lastActionAt: 900,
        mood: { valence: 0.4, arousal: 0.5, moodLabel: '开心', since: 800 },
        relationships: { '2': { intimacy: 0.6, tension: 0.1, lastInteraction: 700 } },
        seenForwardIds: ['abcdefghijklmnopqrstuvwxyz0123456789'],
      },
    },
    ...overrides,
  };
}

function migrateV1() {
  const loaded = loadSocialV2State(v1Raw(), { now: NOW });
  return applyStartupMigration(loaded.state, { now: NOW, plan: loaded.plan, writeFile: () => {} }).state;
}

function v2Raw(overrides = {}) {
  const migrated = migrateV1();
  const base = serializeSocialV2(migrated, { mode: 'final' });
  return { ...base, ...overrides };
}

test('常量与契约一致', () => {
  assert.equal(V2_STATE_SCHEMA_VERSION, 2);
  assert.equal(MAX_CONVERSATIONS, 32);
  assert.equal(MAX_RELATIONSHIPS, 50);
  assert.equal(MAX_PENDING_EVICT, 10);
  assert.equal(AGENT_MOOD_BUDGET_BYTES, 96 * 1024);
  assert.equal(GLOBAL_BUDGET_BYTES, 5 * 1024 * 1024);
  assert.equal(SEEN_FORWARD_MAX, 200);
});

test('hashSeenForwardId：md5 前 16 hex、稳定、不同输入不同', () => {
  const a = hashSeenForwardId('forward-abc');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(hashSeenForwardId('forward-abc'), a);
  assert.notEqual(hashSeenForwardId('forward-abd'), a);
});

test('normalizeSeenForwardIds：去重 + 最后 200', () => {
  const ids = Array.from({ length: 250 }, (_, i) => `f${i}`);
  ids.push('f249'); // 重复
  const out = normalizeSeenForwardIds(ids);
  assert.equal(out.length, SEEN_FORWARD_MAX);
  assert.equal(new Set(out).size, SEEN_FORWARD_MAX);
  assert.equal(out[out.length - 1], hashSeenForwardId('f249'));
});

test('normalizeSocialV2：v1 文件识别为待迁移，legacy 字段保留', () => {
  const { version, runtime, plan } = normalizeSocialV2(v1Raw(), { now: NOW });
  assert.equal(version, 1);
  assert.equal(plan.migrate, true);
  assert.equal(runtime.migration.status, 'pending');
  assert.equal(runtime.migration.fromVersion, 1);
  assert.equal(runtime.conversations.size, 1);
  const st = runtime.conversations.get('private:1');
  assert.equal(st.legacyMood.valence, 0.4);
  assert.equal(st.legacyRelationships['2'].intimacy, 0.6);
});

test('normalizeSocialV2：v2 文件 migration=done、状态 normal', () => {
  const { version, runtime, plan } = normalizeSocialV2(v2Raw(), { now: NOW });
  assert.equal(version, 2);
  assert.equal(plan.migrate, false);
  assert.equal(runtime.migration.status, 'done');
  assert.equal(runtime.saveStatus, 'normal');
});

test('serialize final：8 字段白名单、conversation 无旧字段、agentMood 无 migrationVersion', () => {
  const state = migrateV1();
  const out = serializeSocialV2(state, { mode: 'final' });
  assert.deepEqual(Object.keys(out).sort(), [
    'agentMood', 'conversations', 'migration', 'paused', 'pendingArchive', 'relationshipArchive', 'relationships', 'version',
  ]);
  assert.equal(out.version, 2);
  const conv = out.conversations['private:1'];
  assert.equal(conv.mood, undefined);
  assert.equal(conv.relationships, undefined);
  assert.equal(out.agentMood.migrationVersion, undefined, 'final 必须显式删除 migrationVersion');
});

test('serialize transition：保留旧字段（迁移未完成）', () => {
  const state = loadSocialV2State(v1Raw(), { now: NOW }).state;
  const out = serializeSocialV2(state, { mode: 'transition' });
  const conv = out.conversations['private:1'];
  assert.ok(conv.mood && typeof conv.mood === 'object', 'transition 必须保留 mood');
  assert.ok(conv.relationships && typeof conv.relationships === 'object', 'transition 必须保留 relationships');
});

test('serialize shadow：磁盘无 V2 块时不含 5 块；有块时透传不更新', () => {
  const state = loadSocialV2State(v1Raw(), { now: NOW }).state;
  const noBlocks = serializeSocialV2(state, { mode: 'shadow', sourceSchema: 'v1' });
  for (const field of ['agentMood', 'relationships', 'relationshipArchive', 'pendingArchive', 'migration']) {
    assert.equal(noBlocks[field], undefined, `shadow 无块时不应含 ${field}`);
  }
  const preserved = {
    agentMood: { schemaVersion: 2, episodes: [], marker: 'disk' },
    relationships: { disk: true },
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    pendingArchive: null,
    migration: { version: 2, status: 'done', revision: 3 },
  };
  assert.throws(() => serializeSocialV2(state, { mode: 'shadow', sourceSchema: 'v2', preservedV2Blocks: { relationships: {} } }), /missing preserved block/, '五块缺任一必须 fail-closed');
  const withBlocks = serializeSocialV2(state, { mode: 'shadow', sourceSchema: 'v2', preservedV2Blocks: preserved });
  assert.deepEqual(withBlocks.agentMood, preserved.agentMood, 'shadow 必须透传磁盘块（不更新）');
  assert.deepEqual(withBlocks.relationships, preserved.relationships);
  assert.equal(withBlocks.conversations['private:1'].mood.valence, 0.4, 'v1 文件 shadow 保留旧 mood');
});

test('seenForwardIds：显式参数优先、按 canonical key 读回', () => {
  const raw = v1Raw({ conversations: { 'private:01': v1Raw().conversations['private:1'] } });
  const { runtime } = normalizeSocialV2(raw, { now: NOW });
  assert.equal(runtime.conversations.has('private:1'), true, 'key 必须 canonical');
  assert.equal(runtime.seenForwardIds.get('private:1').size, 1);
  const explicit = new Map([['private:1', new Set([hashSeenForwardId('override')])]]);
  const out = serializeSocialV2(runtime, { mode: 'final', seenForwardIds: explicit });
  assert.deepEqual(out.conversations['private:1'].seenForwardIds, [hashSeenForwardId('override')]);
});

test('runMigrationStep：proposedState 复制、revision=old+1、不改入参', () => {
  const state = loadSocialV2State(v1Raw(), { now: NOW }).state;
  const plan = planSocialV2(state);
  const beforeRevision = state.migration.revision;
  const step = runMigrationStep(state, plan, { now: NOW });
  assert.equal(step.nextStatus, 'mood-done');
  assert.equal(step.proposedState.migration.revision, beforeRevision + 1);
  assert.equal(state.migration.revision, beforeRevision, '不得原地修改入参');
  assert.equal(step.done, false);
});

test('applyStartupMigration：writeFile 成功才提交，revision 逐步 +1 到 done', () => {
  const loaded = loadSocialV2State(v1Raw(), { now: NOW });
  const writes = [];
  const result = applyStartupMigration(loaded.state, { now: NOW, plan: loaded.plan, writeFile: (obj) => writes.push(obj.migration.status) });
  assert.deepEqual(writes, ['mood-done', 'relations-done', 'archive-done', 'done']);
  assert.equal(result.done, true);
  assert.equal(result.state.migration.status, 'done');
  assert.equal(result.state.migration.revision, 4);
});

test('applyStartupMigration：writeFile 抛错则丢弃 proposedState（状态与 revision 不变）', () => {
  const loaded = loadSocialV2State(v1Raw(), { now: NOW });
  const before = JSON.parse(JSON.stringify(loaded.state.migration));
  let calls = 0;
  const result = applyStartupMigration(loaded.state, {
    now: NOW,
    plan: loaded.plan,
    writeFile: () => { calls += 1; throw new Error('disk full'); },
  });
  assert.equal(calls, 1);
  assert.equal(result.failed, true);
  assert.deepEqual(result.state.migration, before, '写失败必须保持旧 revision/status');
});

test('迁移崩溃点续跑：status=mood-done 时从 relations-done 开始', () => {
  const loaded = loadSocialV2State(v1Raw(), { now: NOW });
  const state = loaded.state;
  state.migration.status = 'mood-done';
  state.migration.revision = 1;
  const writes = [];
  const plan = { ...loaded.plan, steps: planSocialV2(state, loaded.plan).steps };
  const done = applyStartupMigration(state, { now: NOW, plan, writeFile: (obj) => writes.push(obj.migration.status) });
  assert.deepEqual(writes, ['relations-done', 'archive-done', 'done']);
  assert.equal(done.state.migration.status, 'done');
});

test('planSocialV2：pending 四步、done 零步', () => {
  const pending = loadSocialV2State(v1Raw(), { now: NOW }).state;
  assert.deepEqual(planSocialV2(pending).steps.map((s) => s.status), ['mood-done', 'relations-done', 'archive-done', 'done']);
  const done = loadSocialV2State(v2Raw(), { now: NOW }).state;
  assert.deepEqual(planSocialV2(done).steps, []);
});

test('关系 >50：plan 生成 LRU 淘汰候选（按 lastInteraction 升序）', () => {
  const relationships = {};
  for (let i = 0; i < 55; i += 1) relationships[String(i + 1)] = { intimacy: 0.5, lastInteraction: 1000 + i };
  const { runtime, plan } = normalizeSocialV2({ version: 2, relationships }, { now: NOW });
  assert.equal(Object.keys(runtime.relationships).length, 55);
  assert.equal(plan.relationshipEvict.length, 5);
  assert.deepEqual(plan.relationshipEvict, ['1', '2', '3', '4', '5']);
});

test('关系归档：pendingEvict 归一化（缺 payload 过滤、上限 10）', () => {
  const pendingEvict = Array.from({ length: 15 }, (_, i) => ({
    uid: String(i + 1),
    generationId: `g${i}`,
    payload: { intimacy: 0.1 },
    at: 1,
  }));
  pendingEvict.push({ uid: '99', generationId: 'g99' }); // 缺 payload → 丢弃
  const { runtime } = normalizeSocialV2({ version: 2, relationshipArchive: { pendingEvict } }, { now: NOW });
  assert.equal(runtime.relationshipArchive.pendingEvict.length, MAX_PENDING_EVICT);
  assert.ok(runtime.relationshipArchive.pendingEvict.every((item) => item.payload));
});

test('pendingArchive 归一化：phase 非法回 checkpoint、payload 保留', () => {
  const { runtime } = normalizeSocialV2({
    version: 2,
    pendingArchive: { key: 'group:01', generationId: 'g1', at: 5, phase: 'bogus', payload: { summary: 's' } },
  }, { now: NOW });
  assert.equal(runtime.pendingArchive.key, 'group:1');
  assert.equal(runtime.pendingArchive.phase, 'checkpoint');
  assert.equal(runtime.pendingArchive.payload.summary, 's');
});

test('32 会话：trim 计划按 lastInteractionAt 升序保留最新 32', () => {
  const conversations = {};
  for (let i = 0; i < 35; i += 1) {
    conversations[`private:${i + 1}`] = { lastIncomingAt: 100 + i, lastActionAt: 50 + i, recentMessages: [] };
  }
  const { runtime, plan } = normalizeSocialV2({ version: 1, conversations }, { now: NOW });
  assert.equal(runtime.conversations.size, 35);
  assert.equal(plan.trimConversations.length, 3);
  assert.deepEqual(plan.trimConversations, ['private:1', 'private:2', 'private:3']);
});

test('computeBudgets：正常/降级/拒写三种状态', () => {
  const state = loadSocialV2State(v1Raw(), { now: NOW }).state;
  const normal = computeBudgets(state);
  assert.equal(normal.saveStatus, 'normal');
  assert.ok(normal.stateBytes > 0);
  const bigMood = structuredClone(state);
  bigMood.agentMood.bloat = 'x'.repeat(AGENT_MOOD_BUDGET_BYTES + 1024);
  const degraded = computeBudgets(bigMood);
  assert.equal(degraded.saveStatus, 'degraded');
  assert.ok(degraded.degradedReasons.some((r) => r.includes('agentMood')));
  const huge = structuredClone(state);
  huge.conversations.set('private:2', { recentMessages: [{ text: 'x'.repeat(GLOBAL_BUDGET_BYTES + 1024) }] });
  const rejected = computeBudgets(huge);
  assert.equal(rejected.saveStatus, 'rejected');
});

test('空/非法输入不崩', () => {
  for (const raw of [null, undefined, '', 42, { conversations: null }]) {
    const { runtime } = normalizeSocialV2(raw, { now: NOW });
    assert.equal(runtime.version, 2);
    assert.equal(runtime.conversations.size, 0);
  }
  const { warnings } = normalizeSocialV2({ version: 2, conversations: { bad: {} } }, { now: NOW });
  assert.ok(warnings.some((w) => w.includes('非法')));
});

test('normalizeRelationshipEntry：数值 clamp + openLoops 上限', () => {
  const entry = normalizeRelationshipEntry({ intimacy: 9, tension: -1, openLoops: Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, text: 't' })) }, '007', { now: NOW });
  assert.equal(entry.uid, '7', 'uid 必须 canonical');
  assert.equal(entry.intimacy, 1);
  assert.equal(entry.tension, 0);
  assert.equal(entry.openLoops.length, 8);
});

test('memory appendEventWithId：ok/duplicate/conflict（no-k 事件）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-mem-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    const event = { id: 'archive:group:1:g1', t: NOW, kind: 'archive', text: '归档摘要', k: 'group:1' };
    assert.equal(store.appendEventWithId(event).code, 'ok');
    assert.equal(store.appendEventWithId(event).code, 'duplicate');
    assert.equal(store.appendEventWithId({ ...event, text: '不同内容' }).code, 'conflict');
    assert.equal(store.findEventByStableId('archive:group:1:g1').found, true);
    assert.equal(store.findEventByStableId('missing').found, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory appendEventWithId：无 id 返回 io_error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-mem-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    assert.equal(store.appendEventWithId({ text: 'x' }).code, 'io_error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移 archive 候选：35 会话 + 55 关系 → pendingArchive 与 pendingEvict 实际生成', () => {
  const conversations = {};
  for (let i = 0; i < 35; i += 1) conversations[`private:${i + 1}`] = { lastIncomingAt: 100 + i, lastActionAt: 50 + i, recentMessages: [] };
  const relationships = {};
  for (let i = 0; i < 55; i += 1) relationships[String(i + 1)] = { intimacy: 0.5, lastInteraction: 1000 + i };
  const loaded = loadSocialV2State({ version: 1, conversations, relationships }, { now: NOW });
  const result = applyStartupMigration(loaded.state, { now: NOW, plan: loaded.plan, writeFile: () => {} });
  assert.equal(result.done, true);
  assert.ok(result.state.pendingArchive, 'pendingArchive 必须由 archive 步生成');
  assert.equal(result.state.pendingArchive.key, 'private:1');
  assert.equal(result.state.relationshipArchive.pendingEvict.length, 5, '>50 关系必须进入 pendingEvict');
});

test('两个会话不同 agentToken：保留且唯一（不统一覆盖）', () => {
  const raw = {
    version: 1,
    conversations: {
      'private:1': { agentToken: 'tok-a', mood: { valence: 0.1 } },
      'private:2': { agentToken: 'tok-b', mood: { valence: 0.2 } },
    },
  };
  const { runtime } = normalizeSocialV2(raw, { now: NOW });
  assert.equal(runtime.conversations.get('private:1').agentToken, 'tok-a');
  assert.equal(runtime.conversations.get('private:2').agentToken, 'tok-b');
  // 空 token 也要生成唯一 fallback
  const { runtime: fallback } = normalizeSocialV2({ version: 1, conversations: { 'private:3': {}, 'private:4': {} } }, { now: NOW });
  const t3 = fallback.conversations.get('private:3').agentToken;
  const t4 = fallback.conversations.get('private:4').agentToken;
  assert.ok(t3 && t4 && t3 !== t4, '缺失 token 必须生成唯一值');
});

test('shadow：v1 文件保存后 version=1，重载仍是 pending（不误判迁移完成）', () => {
  const state = loadSocialV2State(v1Raw(), { now: NOW }).state;
  const shadow = serializeSocialV2(state, { mode: 'shadow', sourceSchema: 'v1' });
  assert.equal(shadow.version, 1, 'shadow + v1 源必须保持 version=1');
  const reload = normalizeSocialV2(shadow, { now: NOW });
  assert.equal(reload.version, 1);
  assert.equal(reload.runtime.migration.status, 'pending');
  assert.throws(() => serializeSocialV2(state, { mode: 'shadow' }), /sourceSchema/, 'shadow 缺 sourceSchema 必须 fail-closed');
  assert.throws(() => serializeSocialV2(state, { mode: 'shadow', sourceSchema: 'v2' }), /preservedV2Blocks/, 'v2 源缺块必须 fail-closed');
  const withBlocks = serializeSocialV2(state, {
    mode: 'shadow',
    sourceSchema: 'v2',
    preservedV2Blocks: {
      agentMood: { schemaVersion: 2, episodes: [] },
      relationships: {},
      relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
      pendingArchive: null,
      migration: { version: 2, status: 'done', revision: 0 },
    },
  });
  assert.equal(withBlocks.version, 2);
});

test('seenForwardIds：save → load → save 稳定（不二次 md5）', () => {
  const state = loadSocialV2State(v1Raw(), { now: NOW }).state;
  const first = serializeSocialV2(state, { mode: 'final' });
  const reloaded = normalizeSocialV2(first, { now: NOW }).runtime;
  const second = serializeSocialV2(reloaded, { mode: 'final' });
  assert.deepEqual(second.conversations['private:1'].seenForwardIds, first.conversations['private:1'].seenForwardIds);
});

test('conversation 新字段与容量上限：lastContextKey/generationId round-trip、recent 50/unread 20/topics 20/wakeTimes 100', () => {
  const raw = {
    version: 1,
    conversations: {
      'group:1': {
        lastContextKey: 'group:01',
        generationId: 'gen-xyz',
        recentMessages: Array.from({ length: 100 }, (_, i) => ({ messageId: `m${i}`, text: 'x'.repeat(500), time: i })),
        unread: Array.from({ length: 50 }, (_, i) => ({ messageId: `u${i}`, text: 'y', time: i })),
        activeTopics: Array.from({ length: 50 }, (_, i) => ({ text: `t${i}`, lastMentionAt: i, participants: ['阿明'], pendingQuestion: 'q' })),
        wakeTimes: Array.from({ length: 300 }, (_, i) => i),
        memberImpressions: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, { note: 'n'.repeat(100) }])),
      },
    },
  };
  const { runtime } = normalizeSocialV2(raw, { now: NOW });
  const st = runtime.conversations.get('group:1');
  assert.equal(st.lastContextKey, 'group:1');
  assert.equal(st.generationId, 'gen-xyz');
  const out = serializeSocialV2(runtime, { mode: 'final' }).conversations['group:1'];
  assert.equal(out.recentMessages.length, 50);
  assert.equal(out.recentMessages[0].text.length, 200);
  assert.equal(out.unread.length, 20);
  assert.equal(out.activeTopics.length, 20);
  assert.equal(out.wakeTimes.length, 100);
  assert.equal(Object.keys(out.memberImpressions).length, 30);
});

test('computeBudgets：单会话 target 128KB → degraded；hard 192KB → rejected', () => {
  const state = loadSocialV2State({ version: 2, conversations: { 'private:1': {} } }, { now: NOW }).state;
  // 字段级 normalizer 之后合法字段堆不到 128KB，预算判定用注入的 serialized 验证
  const make = (size) => computeBudgets(state, { serialized: { conversations: { 'private:1': { bloat: 'x'.repeat(size) } } } });
  const target = make(140 * 1024);
  assert.equal(target.saveStatus, 'degraded');
  assert.ok(target.degradedReasons.some((r) => r.includes('target')));
  const hard = make(200 * 1024);
  assert.equal(hard.saveStatus, 'rejected');
});

test('migration status=failed：driver 停止、不自动推进', () => {
  const state = loadSocialV2State(v1Raw(), { now: NOW }).state;
  state.migration.status = 'failed';
  const writes = [];
  const result = applyStartupMigration(state, { now: NOW, plan: { steps: [], trimConversations: [], relationshipEvict: [] }, writeFile: (obj) => writes.push(obj) });
  assert.equal(result.failed, true);
  assert.deepEqual(writes, [], 'failed 状态不得写盘推进');
  const step = runMigrationStep(state, planSocialV2(state), { now: NOW });
  assert.equal(step.failed, true);
});

test('transition：mood-done 之后仍保留原始 legacy mood（不换成归一化旧值）', () => {
  const raw = v1Raw();
  const legacy = raw.conversations['private:1'].mood;
  const state = loadSocialV2State(raw, { now: NOW }).state;
  const step = runMigrationStep(state, planSocialV2(state), { now: NOW });
  assert.deepEqual(step.serializedTransition.conversations['private:1'].mood, legacy);
  const relations = runMigrationStep(step.proposedState, planSocialV2(step.proposedState, { trimConversations: [], relationshipEvict: [] }), { now: NOW });
  assert.ok(relations.serializedTransition.conversations['private:1'].relationships, 'relations-done 仍保留原始旧关系');
});

test('agentMood：脏字段/越界 baseline 不透传（allowlist 重建）', () => {
  const { runtime } = normalizeSocialV2({
    version: 2,
    agentMood: { schemaVersion: 2, episodes: [], evil: 'x', baseline: { valence: 99 }, needs: { safety: 9 } },
  }, { now: NOW });
  assert.equal(runtime.agentMood.evil, undefined);
  assert.equal(runtime.agentMood.baseline.valence, 1);
  assert.deepEqual(runtime.agentMood.needs.safety, { value: 1, updatedAt: 0 });
});

test('多会话旧 mood：只生成最新主 affect（不产生多条迁移 episode）', () => {
  const raw = {
    version: 1,
    conversations: {
      'private:1': { mood: { valence: 0.1, since: 100 } },
      'private:2': { mood: { valence: -0.5, since: 900 } },
    },
  };
  const loaded = loadSocialV2State(raw, { now: NOW });
  const result = applyStartupMigration(loaded.state, { now: NOW, plan: loaded.plan, writeFile: () => {} });
  assert.ok(result.state.agentMood.episodes.length <= 1, '迁移不得产生多条 episode');
  assert.equal(result.state.agentMood.legacyAffect.valence, -0.5, '只用最新（since 最大）的旧 mood 作为主记录');
});

test('memory find：坏行 → unknown（不当作不存在）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-mem-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
    const file = path.join(dir, 'events', `${dayString(Date.now())}.jsonl`);
    fs.writeFileSync(file, 'not-json\n', 'utf8');
    const result = store.findEventByStableId('anything');
    assert.equal(result.found, false);
    assert.equal(result.unknown, true, '坏行必须返回 unknown');
    assert.equal(store.appendEventWithId({ id: 'x', t: Date.now(), text: 'x' }).code, 'io_error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical 重复会话 key：合并为一个会话且 seenForwardIds union', () => {
  const raw = {
    version: 1,
    conversations: {
      'group:01': { seenForwardIds: ['f1'], lastIncomingAt: 10 },
      'group:1': { seenForwardIds: ['f2'], lastIncomingAt: 20 },
    },
  };
  const { runtime, warnings } = normalizeSocialV2(raw, { now: NOW });
  assert.equal(runtime.conversations.size, 1);
  assert.equal(runtime.seenForwardIds.get('group:1').size, 2);
  assert.ok(warnings.some((w) => w.includes('重复')));
});

test('pendingArchive 缺 payload → 丢弃（单槽 checkpoint 必须有冻结 payload）', () => {
  const { runtime } = normalizeSocialV2({ version: 2, pendingArchive: { key: 'group:1', generationId: 'g', at: 1 } }, { now: NOW });
  assert.equal(runtime.pendingArchive, null);
});

test('真实消息 media 对象：image/face round-trip，不出现 [object Object]', () => {
  const raw = {
    version: 1,
    conversations: {
      'group:1': {
        recentMessages: [{
          seq: 1, messageId: 'm1', sender: '阿明', userId: '2', text: '看图', plain: '看图', tail: '看图',
          media: [
            { kind: 'image', file: 'abc.image', url: 'https://x/y.png', subType: '0', summary: '一只猫' },
            { kind: 'face', faceId: '178' },
          ],
          hasMedia: true, forwardIds: [], hasForward: false, time: 5,
        }],
      },
    },
  };
  const state = loadSocialV2State(raw, { now: NOW }).state;
  const out = serializeSocialV2(state, { mode: 'final' });
  const saved = out.conversations['group:1'].recentMessages[0];
  assert.deepEqual(saved.media[0], { kind: 'image', file: 'abc.image', url: 'https://x/y.png', subType: '0', summary: '一只猫' });
  assert.deepEqual(saved.media[1], { kind: 'face', faceId: '178' });
  assert.ok(!JSON.stringify(saved).includes('[object Object]'));
});

test('真实 activeTopics / pendingThoughts 对象 round-trip', () => {
  const raw = {
    version: 1,
    conversations: {
      'group:1': {
        activeTopics: [{ text: '讨论语音模型', lastMentionAt: 12, participants: ['阿明'], pendingQuestion: '会不会做？' }],
        pendingThoughts: [{ text: '想问问她', createdAt: 3, expiresAt: 99, motivation: 'curiosity' }],
      },
    },
  };
  const state = loadSocialV2State(raw, { now: NOW }).state;
  const out = serializeSocialV2(state, { mode: 'final' }).conversations['group:1'];
  assert.deepEqual(out.activeTopics[0], { text: '讨论语音模型', lastMentionAt: 12, participants: ['阿明'], pendingQuestion: '会不会做？' });
  assert.equal(out.activeTopics[0].text, '讨论语音模型', '注入时必须能读到 .text');
  assert.deepEqual(out.pendingThoughts[0], { text: '想问问她', createdAt: 3, expiresAt: 99, motivation: 'curiosity' });
});

test('needs/sensitivity 契约对象 {value,updatedAt}：clamp + final save→reload 不丢', () => {
  const raw = { version: 2, agentMood: { schemaVersion: 2, episodes: [], needs: { safety: { value: 0.7, updatedAt: 123 } }, sensitivity: { hurt: { value: 9, updatedAt: 4 } } } };
  const state = loadSocialV2State(raw, { now: NOW }).state;
  assert.deepEqual(state.agentMood.needs.safety, { value: 0.7, updatedAt: 123 });
  assert.deepEqual(state.agentMood.sensitivity.hurt, { value: 3, updatedAt: 4 }, 'sensitivity clamp 1..3，不得压成 0..1');
  const reloaded = normalizeSocialV2(serializeSocialV2(state, { mode: 'final' }), { now: NOW }).runtime;
  assert.deepEqual(reloaded.agentMood.needs.safety, { value: 0.7, updatedAt: 123 });
});

test('legacyAffect final save→reload：energy/dominance/cause/causeType 保留', () => {
  const affect = { valence: -0.4, arousal: 0.2, energy: 0.5, dominance: 0.6, cause: '被忽略', causeType: 'ignored', at: 42 };
  const raw = { version: 2, agentMood: { schemaVersion: 2, episodes: [], legacyAffect: affect } };
  const state = loadSocialV2State(raw, { now: NOW }).state;
  const reloaded = normalizeSocialV2(serializeSocialV2(state, { mode: 'final' }), { now: NOW }).runtime;
  assert.deepEqual(reloaded.agentMood.legacyAffect, affect);
});

test('relationship generationId：已有保留；缺失只生成一次且 pendingEvict 使用稳定值', () => {
  const state = loadSocialV2State({ version: 2, relationships: { 5: { intimacy: 0.5, lastInteraction: 1 }, 6: { generationId: 'gen-keep', intimacy: 0.2 } } }, { now: NOW }).state;
  assert.equal(state.relationships['6'].generationId, 'gen-keep');
  const first = state.relationships['5'].generationId;
  assert.match(first, /^gen-[0-9a-f]{16}$/);
  const again = loadSocialV2State(serializeSocialV2(state, { mode: 'final' }), { now: NOW }).state;
  assert.equal(again.relationships['5'].generationId, first, 'generationId 跨重载稳定');
  const conversations = {};
  for (let i = 0; i < 35; i += 1) conversations['private:' + (i + 1)] = { lastIncomingAt: 100 + i, recentMessages: [] };
  const rels = {};
  for (let i = 0; i < 55; i += 1) rels[String(i + 1)] = { intimacy: 0.5, lastInteraction: 1000 + i };
  const loaded = loadSocialV2State({ version: 1, conversations, relationships: rels }, { now: NOW });
  const done = applyStartupMigration(loaded.state, { now: NOW, plan: loaded.plan, writeFile: () => {} });
  const evicted = done.state.relationshipArchive.pendingEvict[0];
  assert.ok(evicted.archiveId.endsWith(done.state.relationships['1'].generationId), 'pendingEvict.archiveId 必须用关系的稳定 generationId');
});

test('applyStartupMigration：plan / writeFile 必填（缺任一抛错）', () => {
  const loaded = loadSocialV2State(v1Raw(), { now: NOW });
  assert.throws(() => applyStartupMigration(loaded.state, { now: NOW, writeFile: () => {} }), /plan/);
  assert.throws(() => applyStartupMigration(loaded.state, { now: NOW, plan: loaded.plan }), /writeFile/);
});

test('未知消息字段丢弃 + wakeConfig 字段级上限', () => {
  const raw = {
    version: 1,
    conversations: {
      'group:1': {
        recentMessages: [{ messageId: 'm', text: 'hi', evil: 'x'.repeat(5000) }],
        wakeConfig: {
          mode: 'bogus', infinite: true, sleepUntil: '2026-01-01T00:00:00.000Z',
          triggers: { speakerIds: Array.from({ length: 30 }, (_, i) => String(i)), keywords: Array.from({ length: 20 }, (_, i) => 'k' + i), probability: 9 },
          batchWindowMs: 5,
        },
      },
    },
  };
  const out = serializeSocialV2(loadSocialV2State(raw, { now: NOW }).state, { mode: 'final' }).conversations['group:1'];
  assert.equal(out.recentMessages[0].evil, undefined, '未知消息字段必须丢弃');
  assert.equal(out.wakeConfig.mode, 'diving');
  assert.equal(out.wakeConfig.triggers.speakerIds.length, 20);
  assert.equal(out.wakeConfig.triggers.keywords.length, 10);
  assert.equal(out.wakeConfig.triggers.probability, 1);
  assert.equal(out.wakeConfig.batchWindowMs, 1000);
});

test('pendingEvict 异常 payload：冻结前归一化（clamp + openLoops 上限）', () => {
  const raw = {
    version: 2,
    relationshipArchive: {
      pendingEvict: [{ uid: '1', generationId: 'g1', at: 5, payload: { intimacy: 9, tension: -1, openLoops: Array.from({ length: 20 }, (_, i) => ({ id: 'l' + i, text: 'x'.repeat(500) })) } }],
    },
  };
  const { runtime } = normalizeSocialV2(raw, { now: NOW });
  const payload = runtime.relationshipArchive.pendingEvict[0].payload;
  assert.equal(payload.intimacy, 1);
  assert.equal(payload.tension, 0);
  assert.equal(payload.openLoops.length, 8);
  assert.equal(payload.openLoops[0].text.length, 120);
});

test('migratedAt：缺失不伪造（多次 load 不漂移）', () => {
  const raw = { version: 2, agentMood: { schemaVersion: 2, episodes: [] } };
  assert.equal(normalizeSocialV2(raw, { now: NOW }).runtime.agentMood.migratedAt, 0);
  assert.equal(normalizeSocialV2(raw, { now: NOW + 99999 }).runtime.agentMood.migratedAt, 0);
});

test('MigrationStep 冻结：driver 写盘顺序与 plan.steps 完全一致', () => {
  const loaded = loadSocialV2State(v1Raw(), { now: NOW });
  const writes = [];
  applyStartupMigration(loaded.state, { now: NOW, plan: loaded.plan, writeFile: (obj) => writes.push(obj.migration.status) });
  assert.deepEqual(writes, loaded.plan.steps.map((step) => step.status));
});

test('sensitivity 1..3 不得被压成 0..1：state → appraiseEvent 强度随值单调', async () => {
  const { appraiseEvent } = await import('../src/core/mood-v2.mjs');
  const values = [1, 1.5, 2, 3];
  const intensities = values.map((value) => {
    const raw = { version: 2, agentMood: { schemaVersion: 2, episodes: [], sensitivity: { anger: { value, updatedAt: 1 } } } };
    const state = loadSocialV2State(raw, { now: NOW }).state;
    const sens = state.agentMood.sensitivity.anger.value;
    assert.equal(sens, value, 'sensitivity 必须保留 1..3 原值');
    const event = { type: 'insulted', actorUid: 'u1', eventId: 'e1', at: NOW, confidence: 0.8 };
    const cand = appraiseEvent({ events: [event], context: { mode: 'private', activeUid: 'u1', sensitivity: state.agentMood.sensitivity } });
    return cand.find((c) => c.kind === 'anger').intensity;
  });
  for (let i = 1; i < intensities.length; i += 1) {
    assert.ok(intensities[i] > intensities[i - 1], '敏感度越高强度必须越大');
  }
  assert.ok(intensities[0] >= 0);
});

test('真实 poke 消息 round-trip：kind 与 poke.targetId/targetIsSelf/groupId 保留', () => {
  const raw = {
    version: 1,
    conversations: {
      'group:1': {
        recentMessages: [{
          seq: 3, messageId: null, sender: '阿明', userId: '2', text: '[拍一拍] 阿明 拍了拍 你', plain: 'x', tail: 'x',
          kind: 'poke', media: [], hasMedia: false, forwardIds: [], hasForward: false,
          poke: { targetId: '10001', targetIsSelf: true, groupId: '123' }, time: 9,
        }],
      },
    },
  };
  const out = serializeSocialV2(loadSocialV2State(raw, { now: NOW }).state, { mode: 'final' }).conversations['group:1'];
  const saved = out.recentMessages[0];
  assert.equal(saved.kind, 'poke');
  assert.deepEqual(saved.poke, { targetId: '10001', targetIsSelf: true, groupId: '123' });
});

test('handcrafted plan 跳过 mood-done：driver 必须拒绝（failed、无写盘）', () => {
  const loaded = loadSocialV2State(v1Raw(), { now: NOW });
  const badPlan = { steps: [{ status: 'relations-done', op: 'relations' }], trimConversations: [], relationshipEvict: [] };
  const writes = [];
  const result = applyStartupMigration(loaded.state, { now: NOW, plan: badPlan, writeFile: (obj) => writes.push(obj) });
  assert.equal(result.failed, true);
  assert.deepEqual(writes, []);
  assert.match(result.error, /plan must end with done|illegal migration step/);
});

test('legacyAffect 缺 at：0=未知，两次 load 不漂移', () => {
  const raw = { version: 2, agentMood: { schemaVersion: 2, episodes: [], legacyAffect: { valence: 0.2 } } };
  const a = normalizeSocialV2(raw, { now: 100 }).runtime.agentMood.legacyAffect;
  const b = normalizeSocialV2(raw, { now: 200 }).runtime.agentMood.legacyAffect;
  assert.equal(a.at, 0);
  assert.equal(b.at, 0);
  assert.equal(a.at, b.at, '缺 at 不得随 now 漂移');
});

test('sleepUntil：合法 ISO 保留；非法值 → infinite + null（不产生“有限无期限”）', () => {
  const iso = '2099-01-01T00:00:00.000Z';
  const ok = serializeSocialV2(loadSocialV2State({ version: 1, conversations: { 'private:1': { wakeConfig: { infinite: false, sleepUntil: iso } } } }, { now: NOW }).state, { mode: 'final' }).conversations['private:1'].wakeConfig;
  assert.equal(ok.infinite, false);
  assert.equal(ok.sleepUntil, iso);
  const bad = serializeSocialV2(loadSocialV2State({ version: 1, conversations: { 'private:1': { wakeConfig: { infinite: false, sleepUntil: 'not-a-date' } } } }, { now: NOW }).state, { mode: 'final' }).conversations['private:1'].wakeConfig;
  assert.equal(bad.infinite, true);
  assert.equal(bad.sleepUntil, null);
});

test('media 未知 kind：有 file/url 规范为 image；两者都空则丢弃', () => {
  const state = loadSocialV2State({
    version: 1,
    conversations: {
      'group:1': {
        recentMessages: [{ messageId: 'm', text: 'x', media: [{ kind: 'video', file: 'v.file', url: 'https://v' }, { kind: 'unknown' }] }],
      },
    },
  }, { now: NOW }).state;
  const saved = serializeSocialV2(state, { mode: 'final' }).conversations['group:1'].recentMessages[0];
  assert.equal(saved.media.length, 1);
  assert.equal(saved.media[0].kind, 'image');
  assert.equal(saved.media[0].file, 'v.file');
});

test('wakeConfig confirmedBy=default 保留（refreshDefaultWakeConfig 仍可刷新）', () => {
  const raw = { version: 1, conversations: { 'private:1': { wakeConfig: { confirmedBy: 'default', mode: 'diving' } } } };
  const out = serializeSocialV2(loadSocialV2State(raw, { now: NOW }).state, { mode: 'final' }).conversations['private:1'].wakeConfig;
  assert.equal(out.confirmedBy, 'default');
  assert.equal(out.mode, 'diving');
});

test('截断 plan（只含首步、未以 done 结尾）：启动前拒绝，不写任何部分迁移', () => {
  const loaded = loadSocialV2State(v1Raw(), { now: NOW });
  const writes = [];
  const truncated = { steps: [{ status: 'mood-done', op: 'mood' }], trimConversations: [], relationshipEvict: [] };
  const result = applyStartupMigration(loaded.state, { now: NOW, plan: truncated, writeFile: (obj) => writes.push(obj) });
  assert.equal(result.failed, true);
  assert.deepEqual(writes, [], '不得写入部分迁移');
  assert.equal(result.currentStatus, 'pending');
  assert.match(result.error, /plan must end with done/);
  // resume 场景：relations-done 状态只给 archive-done（仍不以 done 结尾）
  const resume = loadSocialV2State(v1Raw(), { now: NOW });
  resume.state.migration.status = 'relations-done';
  const writes2 = [];
  const r2 = applyStartupMigration(resume.state, { now: NOW, plan: { steps: [{ status: 'archive-done', op: 'archive' }], trimConversations: [], relationshipEvict: [] }, writeFile: (obj) => writes2.push(obj) });
  assert.equal(r2.failed, true);
  assert.deepEqual(writes2, []);
});

test('shadow pendingArchive 类型：undefined / 0 / string / 数组 → fail-closed；null 合法', () => {
  const state = loadSocialV2State(v1Raw(), { now: NOW }).state;
  const base = {
    agentMood: { schemaVersion: 2, episodes: [] },
    relationships: {},
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    pendingArchive: null,
    migration: { version: 2, status: 'done', revision: 0 },
  };
  assert.doesNotThrow(() => serializeSocialV2(state, { mode: 'shadow', sourceSchema: 'v2', preservedV2Blocks: { ...base } }));
  for (const bad of [undefined, 0, 'x', []]) {
    const blocks = { ...base, pendingArchive: bad };
    assert.throws(() => serializeSocialV2(state, { mode: 'shadow', sourceSchema: 'v2', preservedV2Blocks: blocks }), /pendingArchive/, 'pendingArchive 仅允许 object|null');
  }
  assert.throws(() => serializeSocialV2(state, { mode: 'shadow', sourceSchema: 'v2', preservedV2Blocks: { ...base, agentMood: null } }), /must be an object/);
  assert.throws(() => serializeSocialV2(state, { mode: 'shadow', sourceSchema: 'v2', preservedV2Blocks: { ...base, migration: undefined } }), /must be an object/);
});

test('sleepUntil 严格 ISO：宽松可解析字符串不被接受', () => {
  const make = (sleepUntil) => serializeSocialV2(loadSocialV2State({ version: 1, conversations: { 'private:1': { wakeConfig: { infinite: false, sleepUntil } } } }, { now: NOW }).state, { mode: 'final' }).conversations['private:1'].wakeConfig;
  for (const bad of ['05/06/2026', '0', '2099-1-1T00:00:00Z']) {
    const out = make(bad);
    assert.equal(out.infinite, true, '非严格 ISO 必须视为无限');
    assert.equal(out.sleepUntil, null);
  }
  assert.equal(make('2099-01-01T00:00:00.000Z').sleepUntil, '2099-01-01T00:00:00.000Z');
});

test('sleepUntil 日历合法性：2026-02-30 / 非闰年 02-29 必须拒绝', () => {
  const make = (sleepUntil) => serializeSocialV2(loadSocialV2State({ version: 1, conversations: { 'private:1': { wakeConfig: { infinite: false, sleepUntil } } } }, { now: NOW }).state, { mode: 'final' }).conversations['private:1'].wakeConfig;
  for (const bad of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-13-01T00:00:00Z']) {
    const out = make(bad);
    assert.equal(out.infinite, true, '日历非法必须视为无限');
    assert.equal(out.sleepUntil, null);
  }
  assert.equal(make('2026-02-28T00:00:00Z').sleepUntil, '2026-02-28T00:00:00Z');
  assert.equal(make('2024-02-29T00:00:00Z').sleepUntil, '2024-02-29T00:00:00Z', '闰年 02-29 合法');
});

test('shadow 四块逐类型 fail-closed；pendingArchive={} 合法透传', () => {
  const state = loadSocialV2State(v1Raw(), { now: NOW }).state;
  const base = {
    agentMood: { schemaVersion: 2, episodes: [] },
    relationships: {},
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    pendingArchive: null,
    migration: { version: 2, status: 'done', revision: 0 },
  };
  for (const field of ['agentMood', 'relationships', 'relationshipArchive', 'migration']) {
    for (const bad of [null, undefined, []]) {
      assert.throws(
        () => serializeSocialV2(state, { mode: 'shadow', sourceSchema: 'v2', preservedV2Blocks: { ...base, [field]: bad } }),
        /must be an object/,
        field + ' 非 object 必须 fail-closed',
      );
    }
  }
  const emptyPending = serializeSocialV2(state, { mode: 'shadow', sourceSchema: 'v2', preservedV2Blocks: { ...base, pendingArchive: {} } });
  assert.deepEqual(emptyPending.pendingArchive, {}, '空对象合法且原样透传');
});

test('planSocialV2 四种未完成状态：steps 恒以 done 结尾', () => {
  const loaded = loadSocialV2State(v1Raw(), { now: NOW });
  for (const status of ['pending', 'mood-done', 'relations-done', 'archive-done']) {
    const state = { ...loaded.state, migration: { ...loaded.state.migration, status } };
    const plan = planSocialV2(state, loaded.plan);
    assert.ok(plan.steps.length > 0, status + ' 必须有 steps');
    assert.equal(plan.steps[plan.steps.length - 1].status, 'done', status + ' 必须以 done 结尾');
  }
});

test('sleepUntil 四位年份边界：0000–9999 全部保留（000–999 年份补零）', () => {
  const make = (sleepUntil) => serializeSocialV2(loadSocialV2State({ version: 1, conversations: { 'private:1': { wakeConfig: { infinite: false, sleepUntil } } } }, { now: NOW }).state, { mode: 'final' }).conversations['private:1'].wakeConfig;
  for (const ok of ['0000-01-01T00:00:00Z', '0001-01-01T00:00:00Z', '0999-12-31T23:59:59Z', '1000-01-01T00:00:00Z', '9999-12-31T23:59:59.999Z']) {
    assert.equal(make(ok).sleepUntil, ok, '合法四位年份必须保留：' + ok);
  }
  assert.equal(make('2026-02-28T00:00:00Z').sleepUntil, '2026-02-28T00:00:00Z', '无毫秒合法');
  assert.equal(make('2026-02-28T00:00:00.000Z').sleepUntil, '2026-02-28T00:00:00.000Z', '毫秒 3 位合法');
});

test('sleepUntil 拒绝：纯日期、时区偏移、24:00:00', () => {
  const make = (sleepUntil) => serializeSocialV2(loadSocialV2State({ version: 1, conversations: { 'private:1': { wakeConfig: { infinite: false, sleepUntil } } } }, { now: NOW }).state, { mode: 'final' }).conversations['private:1'].wakeConfig;
  for (const bad of ['2026-02-28', '2026-02-28T00:00:00+08:00', '2026-02-28T24:00:00Z', '2026-02-28T00:00:00']) {
    const out = make(bad);
    assert.equal(out.infinite, true, '非法形态必须 infinite：' + bad);
    assert.equal(out.sleepUntil, null);
  }
});

test('sleepUntil 毫秒位数：1/2/3 位均合法；10000 年与负年份拒绝', () => {
  const make = (sleepUntil) => serializeSocialV2(loadSocialV2State({ version: 1, conversations: { 'private:1': { wakeConfig: { infinite: false, sleepUntil } } } }, { now: NOW }).state, { mode: 'final' }).conversations['private:1'].wakeConfig;
  for (const ok of ['2026-02-28T00:00:00.1Z', '2026-02-28T00:00:00.12Z', '2026-02-28T00:00:00.123Z']) {
    assert.equal(make(ok).sleepUntil, ok, '1–3 位毫秒必须保留：' + ok);
  }
  for (const bad of ['10000-01-01T00:00:00Z', '-0001-01-01T00:00:00Z']) {
    const out = make(bad);
    assert.equal(out.infinite, true, '超出四位年份/负年份必须拒绝：' + bad);
    assert.equal(out.sleepUntil, null);
  }
});

test('故障注入：events 目录不可枚举（ENOTDIR）→ find unknown、append io_error（不重复写）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-fs-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    assert.equal(store.appendEventWithId({ id: 'audit:event:1', k: 'group:1', kind: 'msg', text: 'x' }).ok, true);
    fs.rmSync(path.join(dir, 'events'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, 'events'), 'x', 'utf8'); // 目录位置被文件占据 → readdir ENOTDIR
    assert.equal(store.findEventByStableId('audit:event:1').unknown, true, '枚举失败必须 unknown');
    assert.equal(store.appendEventWithId({ id: 'audit:event:1', k: 'group:1', kind: 'msg', text: 'x' }).code, 'io_error', 'unknown 时不得重复写入');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('故障注入：日文件被目录占据（读失败）→ find unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-fs2-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    assert.equal(store.appendEventWithId({ id: 'audit:event:2', k: 'group:1', kind: 'msg', text: 'y' }).ok, true);
    const dayFile = path.join(dir, 'events', dayString(Date.now()) + '.jsonl');
    fs.rmSync(dayFile);
    fs.mkdirSync(dayFile);
    assert.equal(store.findEventByStableId('audit:event:2').unknown, true, 'stat 成功但读失败必须 unknown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stableIdCache 不得掩盖外部删除：命中缓存后删文件，find 必须重扫', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-fs3-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    assert.equal(store.appendEventWithId({ id: 'audit:event:3', k: 'group:1', kind: 'msg', text: 'z' }).ok, true);
    assert.equal(store.findEventByStableId('audit:event:3').found, true);
    fs.rmSync(path.join(dir, 'events', dayString(Date.now()) + '.jsonl'));
    assert.equal(store.findEventByStableId('audit:event:3').found, false, '缓存命中必须校验文件指纹');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同 ID 异内容：find conflict、append 返回 conflict（不静默取第一条）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-fs4-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    assert.equal(store.appendEventWithId({ id: 'audit:event:4', k: 'group:1', kind: 'msg', text: '第一条' }).ok, true);
    const dayFile = path.join(dir, 'events', dayString(Date.now()) + '.jsonl');
    fs.appendFileSync(dayFile, JSON.stringify({ id: 'audit:event:4', k: 'group:1', kind: 'msg', text: '另一条', t: Date.now() }) + '\n', 'utf8');
    const found = store.findEventByStableId('audit:event:4');
    assert.equal(found.conflict, true);
    assert.equal(store.appendEventWithId({ id: 'audit:event:4', k: 'group:1', kind: 'msg', text: '第一条' }).code, 'conflict');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('归档队列 archiveId 按 canonical uid+generationId 重建；loops 字段级归一化', () => {
  const { runtime } = normalizeSocialV2({
    version: 2,
    relationshipArchive: {
      orphanLoops: [{ uid: '1', generationId: 'g1', archiveId: 'wrong-id', loops: [{ id: 'l1', text: 'x'.repeat(500), openedAt: 5 }, { text: 'no-id' }] }],
      pendingCold: [{ uid: '2', generationId: 'g2', archiveId: 'wrong-2', loops: [] }],
      pendingEvict: [{ uid: '3', generationId: 'g3', archiveId: 'wrong-3', payload: { intimacy: 0.5, openLoops: [] }, at: 1 }],
    },
  }, { now: NOW });
  assert.equal(runtime.relationshipArchive.orphanLoops[0].archiveId, 'loop-archive:1:g1');
  assert.equal(runtime.relationshipArchive.pendingCold[0].archiveId, 'loop-archive:2:g2');
  assert.equal(runtime.relationshipArchive.pendingEvict[0].archiveId, 'relationship-archive:3:g3');
  assert.equal(runtime.relationshipArchive.orphanLoops[0].loops.length, 1, '缺 id 的 loop 丢弃');
  assert.equal(runtime.relationshipArchive.orphanLoops[0].loops[0].text.length, 120, 'loop.text 截 120');
});

test('pendingArchive：at 使用注入 now；payload 字段级归一化（topics 字符串/summary 截断）', () => {
  const { runtime } = normalizeSocialV2({
    version: 2,
    pendingArchive: {
      key: 'group:1', generationId: 'g', phase: 'checkpoint',
      payload: { topics: [{ text: '话题A' }, '话题B', ''], summary: 's'.repeat(500), messageCount: 5, lastActionAt: 7 },
    },
  }, { now: 123 });
  assert.equal(runtime.pendingArchive.at, 123, '缺 at 必须用注入 now');
  assert.deepEqual(runtime.pendingArchive.payload.topics, ['话题A', '话题B']);
  assert.equal(runtime.pendingArchive.payload.summary.length, 200);
  assert.equal(runtime.pendingArchive.payload.messageCount, 5);
  assert.equal(runtime.pendingArchive.payload.archivedAt, 123);
});

test('缓存后同尺寸替换并恢复 mtime：不得返回旧事件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-cache1-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    assert.equal(store.appendEventWithId({ id: 'audit:cache:1', k: 'group:1', kind: 'msg', text: 'AAAA' }).ok, true);
    const dayFile = path.join(dir, 'events', dayString(Date.now()) + '.jsonl');
    const stat1 = fs.statSync(dayFile);
    assert.equal(store.findEventByStableId('audit:cache:1').found, true);
    const content = fs.readFileSync(dayFile, 'utf8');
    const tmp = dayFile + '.tmp';
    fs.writeFileSync(tmp, content.split('"AAAA"').join('"BBBB"'), 'utf8'); // 同尺寸
    fs.renameSync(tmp, dayFile); // ino 变化
    fs.utimesSync(dayFile, stat1.atime, stat1.mtime); // 恢复 mtime
    const after = store.findEventByStableId('audit:cache:1');
    assert.notEqual(after.event && after.event.text, 'AAAA', '不得返回旧事件');
    assert.equal(after.event && after.event.text, 'BBBB');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('缓存命中后另一日档新增同 ID 异内容：必须重扫并返回 conflict', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-cache2-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    assert.equal(store.appendEventWithId({ id: 'audit:cross:1', k: 'group:1', kind: 'msg', text: '第一条' }).ok, true);
    assert.equal(store.findEventByStableId('audit:cross:1').found, true);
    const otherDay = dayString(Date.now() - 86400000);
    fs.writeFileSync(
      path.join(dir, 'events', otherDay + '.jsonl'),
      JSON.stringify({ id: 'audit:cross:1', k: 'group:1', kind: 'msg', text: '另一条', t: Date.now() - 86400000 }) + '\n',
      'utf8',
    );
    assert.equal(store.findEventByStableId('audit:cross:1').conflict, true, '跨文件同 ID 异内容必须 conflict');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同 ID 同内容不同键顺序：不得误报 conflict，append 应 duplicate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-cache3-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    assert.equal(store.appendEventWithId({ id: 'audit:order:1', k: 'group:1', kind: 'msg', text: 'same' }).ok, true);
    const dayFile = path.join(dir, 'events', dayString(Date.now()) + '.jsonl');
    fs.appendFileSync(dayFile, JSON.stringify({ text: 'same', kind: 'msg', k: 'group:1', id: 'audit:order:1', t: Date.now() }) + '\n', 'utf8');
    const found = store.findEventByStableId('audit:order:1');
    assert.equal(found.conflict, false, '键顺序不同不得误报 conflict');
    assert.equal(found.found, true);
    assert.equal(store.appendEventWithId({ id: 'audit:order:1', k: 'group:1', kind: 'msg', text: 'same' }).code, 'duplicate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pendingArchive 缺 generationId：丢弃（不能保留空串）', () => {
  const { runtime } = normalizeSocialV2({ version: 2, pendingArchive: { key: 'group:1', payload: { summary: 's' } } }, { now: NOW });
  assert.equal(runtime.pendingArchive, null);
});

test('find 返回副本：调用方修改不得污染缓存/后续命中', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-clone-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    assert.equal(store.appendEventWithId({ id: 'audit:clone:1', k: 'group:1', kind: 'msg', text: '原始' }).ok, true);
    const first = store.findEventByStableId('audit:clone:1');
    first.event.text = '被调用方修改';
    const second = store.findEventByStableId('audit:clone:1');
    assert.equal(second.event.text, '原始', '缓存不得被调用方修改污染');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('contentHash 空串与缺失等价：不误报 conflict，append duplicate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-hash-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    const dayFile = path.join(dir, 'events', dayString(Date.now()) + '.jsonl');
    fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
    fs.writeFileSync(dayFile, [
      JSON.stringify({ id: 'audit:hash:1', k: 'group:1', kind: 'msg', text: 'same', t: 1, contentHash: '' }),
      JSON.stringify({ id: 'audit:hash:1', k: 'group:1', kind: 'msg', text: 'same', t: 1 }),
    ].join('\n') + '\n', 'utf8');
    const found = store.findEventByStableId('audit:hash:1');
    assert.equal(found.conflict, false, '空 contentHash 与缺失不得误报 conflict');
    assert.equal(store.appendEventWithId({ id: 'audit:hash:1', k: 'group:1', kind: 'msg', text: 'same' }).code, 'duplicate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pendingArchive generationId 空白：trim 后为空 → 丢弃', () => {
  const { runtime } = normalizeSocialV2({ version: 2, pendingArchive: { key: 'group:1', generationId: '   ', payload: { summary: 's' } } }, { now: NOW });
  assert.equal(runtime.pendingArchive, null);
});

test('statWithCode：无 code 普通 Error → unknown（monkey-patch fs.statSync）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-v2-nocode-'));
  try {
    const store = createMemoryStore({ dir, config: {} });
    assert.equal(store.appendEventWithId({ id: 'audit:nocode:1', k: 'group:1', kind: 'msg', text: 'x' }).ok, true);
    const fsModule = (await import('node:fs')).default;
    const original = fsModule.statSync;
    fsModule.statSync = () => { throw new Error('boom-no-code'); };
    try {
      assert.equal(store.findEventByStableId('audit:nocode:1').unknown, true, '无 code 异常必须 unknown，不得当作不存在');
    } finally {
      fsModule.statSync = original;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
