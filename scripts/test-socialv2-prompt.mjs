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
