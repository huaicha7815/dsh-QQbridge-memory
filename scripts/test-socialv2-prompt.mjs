// 唤醒提示词组装单测（Step B）。
// 提示词决定她怎么说话，所以这里断言的是「关键片段必须存在」而不是全文比对。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakePromptBuilder } from '../src/core/socialv2-prompt.mjs';

function makeBuilder(over = {}) {
  const states = new Map();
  const setState = (key, st) => states.set(key, st);
  const builder = createWakePromptBuilder({
    getState: (key) => {
      if (!states.has(key)) {
        states.set(key, {
          wakeConfig: { batchWindowMs: 8000 },
          unread: [],
          recentMessages: [],
          lastUnreadSeq: 0,
          agentToken: 'tok-test',
          activeTopics: [],
          pendingThoughts: [],
          memberImpressions: {},
          modelSeenSeqs: new Set(),
        });
      }
      return states.get(key);
    },
    cfg: { socialV2: { context: {}, wake: { preSleepWaitMs: 300000 } } },
    formatMemoryInjectionV3: () => '',
    formatParticipationV2: () => '',
    readThroughSeqV2: () => 0,
    suggestQuietMsV2: () => 8000,
    v2ToolEnabled: () => true,
    wakeRoleLineV2: () => '【角色】鱼鱼\n',
    buildStickerContext: () => '',
    buildStickerStrategyHint: () => '',
    compactModelMessage: (m) => JSON.stringify(m),
    looksLikeUnfinished: () => false,
    buildDiaryDigestV2: () => '',
    profileDigestForRefine: () => '',
    threadClosureHints: () => '',
    stickerEntries: () => [],
    memoryStore: { search: () => [], formatHits: () => '' },
    ...over,
  });
  return { builder, setState, states };
}

test('提醒提示词：包含会话 key、令牌、收尾工具与观察窗口', () => {
  const { builder } = makeBuilder();
  const text = builder.buildWakeReminderPrompt('group:123');
  assert.ok(text.includes('group:123'), '必须带会话 key');
  assert.ok(text.includes('tok-test'), '必须带会话令牌');
  assert.ok(text.includes('qq_set_wake_config'), '必须提示设置唤醒配置');
  assert.ok(text.includes('qq_wait_for_messages'), '必须提示先做沉睡前观察');
  assert.ok(text.includes('300000'), '观察窗口时长要写进去');
});

test('提示词：包含角色行与未读消息', () => {
  const { builder, setState } = makeBuilder();
  const key = 'group:9';
  setState(key, {
    wakeConfig: { batchWindowMs: 8000 },
    unread: [{ seq: 1, text: '在吗', sender: '小鱼', time: Date.now() }],
    recentMessages: [{ seq: 1, text: '在吗', sender: '小鱼', time: Date.now() }],
    lastUnreadSeq: 1,
    agentToken: 'tok-2',
    activeTopics: [],
    pendingThoughts: [],
    memberImpressions: {},
    modelSeenSeqs: new Set(),
  });
  const text = builder.buildWakePrompt(key, 'atMention');
  assert.ok(text.includes('【角色】鱼鱼'), '角色行必须注入');
  assert.ok(text.includes('在吗'), '未读消息内容要出现');
});

test('快照：工具全关时返回 null（没有可给模型看的东西）', () => {
  const { builder } = makeBuilder({ v2ToolEnabled: () => false });
  assert.equal(builder.buildWakeSnapshot('group:1'), null);
});

test('快照：正常时带 unread / recent 结构', () => {
  const { builder, setState } = makeBuilder();
  const key = 'group:2';
  setState(key, {
    wakeConfig: { batchWindowMs: 8000 },
    unread: [{ seq: 3, text: '今天吃什么', sender: '小鱼', time: Date.now() }],
    recentMessages: [],
    lastUnreadSeq: 3,
    agentToken: 'tok-3',
    activeTopics: [],
    pendingThoughts: [],
    memberImpressions: {},
    modelSeenSeqs: new Set(),
  });
  const snap = builder.buildWakeSnapshot(key);
  assert.ok(snap, '应有快照');
  // 快照的具体过滤规则（哪些消息算「模型还没看过」）由 readThroughSeq 决定，
  // 这里只断言结构，不锁死筛选逻辑——那部分已有 e2e 覆盖。
  assert.ok(Array.isArray(snap.messages), '快照要带 messages 数组');
  assert.equal(snap.key, undefined, '快照不直接带 key（由 payload 包）');
  assert.ok('partial' in snap || 'includedUnreadCount' in snap, '应有分页/截断标记');
});

// ── 1D：prompt opt-in + A/B 分桶 ──────────────────────────────────────────

function minimalBuilder(overrides = {}) {
  return createWakePromptBuilder({
    getState: (key) => ({ key, wakeConfig: {}, recentMessages: [], unread: [], lastIncomingAt: 0 }),
    peekState: (key) => ({ key, wakeConfig: {}, recentMessages: [], unread: [], lastIncomingAt: 0 }),
    cfg: { socialV2: {} },
    formatMemoryInjectionV3: () => '',
    formatParticipationV2: () => '',
    readThroughSeqV2: () => 0,
    suggestQuietMsV2: () => 10000,
    v2ToolEnabled: () => true,
    wakeRoleLineV2: () => '',
    buildStickerContext: () => '',
    buildStickerStrategyHint: () => '',
    compactModelMessage: (m) => m,
    looksLikeUnfinished: () => false,
    buildDiaryDigestV2: () => '',
    profileDigestForRefine: () => '',
    threadClosureHints: () => [],
    stickerEntries: () => [],
    memoryStore: { getConfig: () => ({ enabled: false }) },
    getMoodView: () => ({ valence: 0.5, arousal: 0.6, energy: 0.7, causeType: 'praised' }),
    getRelationshipView: () => ({ intimacy: 0.1, tension: 0 }),
    expressionCfg: () => ({}),
    ...overrides,
  });
}

test('1D promptOptIn=false → prompt 不含情绪决策段，但运行时 explainMood 仍可用', () => {
  const builder = minimalBuilder({ promptOptIn: () => false });
  const text = builder.buildWakePrompt('private:1', 'question');
  assert.ok(!text.includes('心情'), 'prompt 不得含情绪决策段');
  assert.ok(builder.explainMood('private:1'), '运行时表达计划不受 prompt opt-in 影响');
});

test('1D promptOptIn=true → 注入情绪决策段（explainMood 有 plan）', () => {
  const builder = minimalBuilder({ promptOptIn: () => true });
  const plan = builder.explainMood('private:1');
  assert.ok(plan, '必须返回表达计划');
  assert.ok(typeof plan.moodBand === 'string');
});

test('1D promptOptIn 抛错 → prompt fail-closed（不注入情绪段）', () => {
  const builder = minimalBuilder({ promptOptIn: () => { throw new Error('boom'); } });
  const text = builder.buildWakePrompt('private:1', 'question');
  assert.ok(!text.includes('心情'), '开关异常不得注入情绪段');
});

test('1D A/B：同一 key 的分桶结果稳定', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const h = await bridgeHarness({ config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2', prompt: { enabled: true, ab: true } } } } });
  try {
    const first = h.socialV2.emotionV2AbVariantFor('private:1');
    const second = h.socialV2.emotionV2AbVariantFor('private:1');
    assert.equal(first, second, 'A/B 分桶必须稳定');
    assert.ok(['control', 'treatment'].includes(first));
    assert.equal(h.socialV2.emotionV2AbVariantFor('private:1'), h.socialV2.emotionV2AbVariantFor('private:1'));
  } finally {
    await h.close();
  }
});

test('1D 状态读取异常 → 不生成情绪计划（不得用默认平静冒充）', () => {
  const builder = minimalBuilder({ promptOptIn: () => true, getMoodView: () => { throw new Error('io'); } });
  assert.equal(builder.explainMood('private:1'), null, '运行时计划必须 null');
  const text = builder.buildWakePrompt('private:1', 'question');
  assert.ok(!text.includes('心情'), '不得注入伪造情绪段');
});

test('1D promptOptIn=true → prompt 含情绪决策段，其余段不变', () => {
  const builder = minimalBuilder({ promptOptIn: () => true });
  const text = builder.buildWakePrompt('private:1', 'question');
  assert.ok(text.includes('心情') || text.includes('情绪'), '必须含情绪决策段');
});
