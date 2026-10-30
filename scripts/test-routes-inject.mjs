// handler 级依赖注入测试（第三版）。
//
// 关键设计：**按每个模块自己声明的参数列表动态生成 mock**。
// 之前用万能 Proxy 有两个极端：全部放行（掩盖漏注入）或全部严格（mock 不可调用，大面积误报）。
// 现在：模块声明了什么参数就给什么 mock，缺一个就会 undefined → 调用时 TypeError → 测试失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { handleSocialV2SendApi } from '../src/routes/socialv2-send-api.mjs';
import { handleSocialV2ToolsApi } from '../src/routes/socialv2-tools-api.mjs';
import { handleSocialV2WakeSlangApi } from '../src/routes/socialv2-wake-slang-api.mjs';
import { handleSocialV2ControlApi } from '../src/routes/socialv2-control-api.mjs';
import { handleSocialV2StateApi } from '../src/routes/socialv2-state-api.mjs';
import { handleSocialV2MemoryApi } from '../src/routes/socialv2-memory-api.mjs';

import { fileURLToPath } from 'node:url';

// 相对路径：CI / 其他用户机器上也能跑（原来写死了绝对路径）
const ROUTES = fileURLToPath(new URL('../src/routes', import.meta.url));

/** 可调用的万能 mock（任何属性访问继续返回自己） */
function anyMock() {
  const fn = function () { return anyMock(); };
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === 'then') return undefined;
      return anyMock();
    },
    apply() { return anyMock(); },
  });
}

/** 从模块源码里读它声明的参数名 */
function moduleParams(file) {
  const src = fs.readFileSync(path.join(ROUTES, file), 'utf8');
  const sig = src.match(/export\s+(?:async\s+)?function\s+\w+\s*\(\{([\s\S]*?)\}\)\s*\{/);
  if (!sig) return [];
  const names = new Set();
  for (const part of sig[1].split(',')) {
    const t = part.trim();
    if (!t) continue;
    const [left, right] = t.split(':').map((x) => x && x.trim());
    if (left && /^[A-Za-z_$][\w$]*$/.test(left)) names.add(left);
    if (right && /^[A-Za-z_$][\w$]*$/.test(right)) names.add(left);
  }
  return [...names];
}

const st = {
  wakeConfig: { mode: 'diving', infinite: true, sleepUntil: null, triggers: {}, batchWindowMs: 8000 },
  unread: [], recentMessages: [], lastUnreadSeq: 0,
  agentToken: 'tok', activeTopics: [], pendingThoughts: [], memberImpressions: {},
  modelSeenSeqs: new Set(), sendTimes: [], pendingWakeReasons: [],
  lastAiReplyAt: 0, lastIncomingAt: 0, sendTimes: [],
};

const memoryStoreMock = {
  readProfile: () => ({ version: 3, people: {}, threads: [], self: [], audit: [] }),
  writeProfile: () => true,
  // 新增的档案读取状态：路由会用 readState() 判断「档案读不到 vs 档案是空的」。
  // mock 里必须给出完整形状，否则 memory-profile 这类端点会直接 TypeError。
  readState: () => ({ corrupt: false, readError: null, writable: true }),
  // 会话级事件统计：memory-stats 在 isolated 下会调它。
  sessionStats: () => ({ scope: 'session', events: 0, eventDays: 0, firstDay: null, lastDay: null, tiers: [0, 0, 0, 0] }),
  stats: () => ({
    events: 0, eventDays: 0, firstDay: null, lastDay: null, tiers: [0, 0, 0, 0],
    salience: { S0: 0, S1: 0, S2: 0, S3: 0 }, summaryFiles: 0, weekFiles: 0, monthFiles: 0,
    profile: { people: 0, openThreads: 0, selfNotes: 0 }, writeFailures: 0,
    readErrors: 0, unreadableFiles: [], profileRead: { corrupt: false, readError: null, writable: true },
    eventsWithoutSource: 0, archivedEvents: 0,
  }),
  getConfig: () => ({}),
  search: () => [],
  readEvents: () => [],
  readRecallLog: () => [],
  correctFact: () => ({ profile: { version: 3, people: {}, threads: [], self: [], audit: [] }, changed: false }),
};

/** 为某个模块生成一份「完整」的依赖：参数全覆盖 + 关键项给合理实现 */
function depsFor(file) {
  const deps = {};
  for (const name of moduleParams(file)) deps[name] = anyMock();
  Object.assign(deps, {
    getSocialV2State: () => st,
    sendJson: () => {},
    readBody: async () => ({}),
    v2ToolEnabled: () => true,
    v2SessionAllowed: () => true,
    agentTokenOk: () => true,
    modeAllowed: () => true,
    currentMode: () => 'reserved2',
    getCurrentMode: () => 'reserved2',
    isSleepingConfigV2: () => false,
    preSleepWaitBlockedV2: () => false,
    cfg: { socialV2: { enabled: true, sticker: {}, wake: {}, proactive: {}, context: {}, send: { maxPerMessageChars: 500 } } },
    socialV2: { paused: false, conversations: new Map() },
    replyInfoCache: new Map(),
    activeWaits: new Map(),
    sessionPromises: new Map(),
    sessionModels: new Map(),
    modelAppliedSessions: new Map(),
    reverse: new Map(),
    collectors: new Map(),
    v2TurnStartAt: new Map(),
    toolCallNames: new Map(),
    pendingSendToolCalls: new Map(),
    sendToolSucceededSessions: new Set(),
    seenForwardIds: new Map(),
    pendingWakeKeys: new Set(),
    markReadCalledKeys: new Set(),
    memoryStore: { ...memoryStoreMock, inspect: () => ({}) },
    ROOT: 'C:/tmp',
    MAX_MEDIA_BYTES: 4 * 1024 * 1024,
    MAX_MEDIA_PIXELS: 64_000_000,
    ACTIVE_WAIT_LEASE_MS: 900000,
  });
  return deps;
}

const FILES = {
  send: ['socialv2-send-api.mjs', handleSocialV2SendApi],
  tools: ['socialv2-tools-api.mjs', handleSocialV2ToolsApi],
  wakeSlang: ['socialv2-wake-slang-api.mjs', handleSocialV2WakeSlangApi],
  control: ['socialv2-control-api.mjs', handleSocialV2ControlApi],
  state: ['socialv2-state-api.mjs', handleSocialV2StateApi],
  memory: ['socialv2-memory-api.mjs', handleSocialV2MemoryApi],
};

const BODIES = {
  '/api/socialV2/send-burst': { key: 'group:1', messages: ['hello'] },
  '/api/socialV2/send-message': { key: 'group:1', messages: ['hello'] },
  '/api/socialV2/send-poke': { key: 'group:1', targetUserId: '123' },
  '/api/socialV2/send-voice': { key: 'group:1', voice: 'test.mp3' },
  '/api/socialV2/send-sticker': { key: 'group:1', stickerId: 'abc' },
  '/api/socialV2/collect-sticker': { key: 'group:1', messageId: '123' },
  '/api/socialV2/sticker-note': { key: 'group:1', stickerId: 'abc', note: 'note' },
  '/api/socialV2/qzone-send': { key: 'private:1', content: 'hello' },
  '/api/socialV2/qzone-list': { key: 'private:1' },
  '/api/socialV2/forward-media': { key: 'group:1', media: [] },
  '/api/socialV2/wake': { key: 'group:1', reason: 'admin' },
  '/api/socialV2/wait': { key: 'group:1', purpose: 'reply', timeoutMs: 1000 },
  '/api/socialV2/check-send': { key: 'group:1', tool: 'sendGroup', token: 'tok' },
  '/api/socialV2/mark-read': { key: 'group:1', throughSeq: 1 },
  '/api/socialV2/wake-config': { key: 'group:1', config: { mode: 'diving' } },
  '/api/socialV2/reset': {},
  '/api/socialV2/memory-append': { key: 'group:1', category: 'activeTopic', content: 'topic' },
  '/api/socialV2/memory-remember': { key: 'group:1', kind: 'self', content: 'note' },
};

const ENDPOINTS = [
  ['send', 'send-burst', 'POST', '/api/socialV2/send-burst'],
  ['send', 'send-message', 'POST', '/api/socialV2/send-message'],
  ['send', 'send-poke', 'POST', '/api/socialV2/send-poke'],
  ['send', 'send-voice', 'POST', '/api/socialV2/send-voice'],
  ['send', 'send-sticker', 'POST', '/api/socialV2/send-sticker'],
  ['send', 'collect-sticker', 'POST', '/api/socialV2/collect-sticker'],
  ['send', 'sticker-image', 'GET', '/api/socialV2/sticker-image'],
  ['send', 'self-image', 'GET', '/api/socialV2/self-image'],
  ['send', 'voices', 'GET', '/api/socialV2/voices'],
  ['send', 'sticker-list', 'GET', '/api/socialV2/sticker-list'],
  ['send', 'sticker-note', 'POST', '/api/socialV2/sticker-note'],
  ['send', 'qzone-send', 'POST', '/api/socialV2/qzone-send'],
  ['send', 'qzone-list', 'POST', '/api/socialV2/qzone-list'],
  ['tools', 'tool-log', 'GET', '/api/socialV2/tool-log'],
  ['tools', 'tool-log/clear', 'POST', '/api/socialV2/tool-log/clear'],
  ['tools', 'feedback-clear', 'POST', '/api/socialV2/feedback-clear'],
  ['tools', 'my-recent', 'GET', '/api/socialV2/my-recent'],
  ['tools', 'active-members', 'GET', '/api/socialV2/active-members'],
  ['tools', 'message-detail', 'GET', '/api/socialV2/message-detail'],
  ['tools', 'forward-message', 'GET', '/api/socialV2/forward-message'],
  ['tools', 'forward-media', 'POST', '/api/socialV2/forward-media'],
  ['wakeSlang', 'wake', 'POST', '/api/socialV2/wake'],
  ['wakeSlang', 'wait', 'POST', '/api/socialV2/wait'],
  ['wakeSlang', 'check-send', 'POST', '/api/socialV2/check-send'],
  ['wakeSlang', 'slang/query', 'GET', '/api/socialV2/slang/query'],
  ['control', 'config', 'GET', '/api/socialV2/config'],
  ['control', 'activity', 'GET', '/api/socialV2/activity'],
  ['control', 'mark-read', 'POST', '/api/socialV2/mark-read'],
  ['control', 'wake-config', 'POST', '/api/socialV2/wake-config'],
  ['control', 'reset', 'POST', '/api/socialV2/reset'],
  ['state', 'state', 'GET', '/api/socialV2/state'],
  ['state', 'prompt', 'GET', '/api/socialV2/prompt'],
  ['state', 'unread', 'GET', '/api/socialV2/unread'],
  ['state', 'recent', 'GET', '/api/socialV2/recent'],
  ['state', 'states', 'GET', '/api/socialV2/states'],
  ['memory', 'memory', 'GET', '/api/socialV2/memory'],
  ['memory', 'memory-stats', 'GET', '/api/socialV2/memory-stats'],
  ['memory', 'memory-inspect', 'GET', '/api/socialV2/memory-inspect'],
  ['memory', 'memory-profile', 'GET', '/api/socialV2/memory-profile'],
  ['memory', 'memory-remember', 'POST', '/api/socialV2/memory-remember'],
];

for (const [fileKey, name, method, pathname] of ENDPOINTS) {
  test(`端点 ${name} 的依赖都能解析`, async () => {
    const [file, handler] = FILES[fileKey];
    const deps = depsFor(file);
    deps.readBody = async () => (BODIES[pathname] ?? {});
    const req = {
      method,
      headers: { 'x-agent-token': 'tok' },
      url: pathname,
      on: () => {},
      once: () => {},
      removeListener: () => {},
    };
    const url = { pathname, searchParams: new URLSearchParams({ key: 'group:1', token: 't' }) };
    try {
      await handler({ ...deps, req, url });
    } catch (error) {
      const msg = String(error?.message ?? error);
      // 只有这几种算「依赖问题」；其余是业务路径（内部 catch 后返回 500），不算失败
      if (error instanceof ReferenceError) throw error;
      if (/依赖未注入/.test(msg)) throw error;
      if (error instanceof TypeError && /Cannot read properties of undefined/.test(msg)) throw error;
      if (error instanceof TypeError && /is not a function/.test(msg)) throw error;
    }
  });
}
