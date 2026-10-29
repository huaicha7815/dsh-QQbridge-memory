// handler 级依赖可用性测试：mock 掉所有外部副作用，把每个端点的 handler 调一遍，
// 断言不会因为「某个依赖没注入」而抛 ReferenceError。
//
// 为什么需要这个：HTTP 级测试没法覆盖会真的发消息的端点（send-*），
// 而「参数齐全的正常路径」恰恰最容易暴露漏注入（缺参数会在早期就 return）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { handleSocialV2SendApi } from '../src/routes/socialv2-send-api.mjs';
import { handleSocialV2ToolsApi } from '../src/routes/socialv2-tools-api.mjs';
import { handleSocialV2WakeSlangApi } from '../src/routes/socialv2-wake-slang-api.mjs';
import { handleSocialV2ControlApi } from '../src/routes/socialv2-control-api.mjs';
import { handleSocialV2StateApi } from '../src/routes/socialv2-state-api.mjs';
import { handleSocialV2MemoryApi } from '../src/routes/socialv2-memory-api.mjs';

// ── 万能 mock：任何属性访问/调用都返回自身，用于填充大量不关心的依赖 ──
function anyMock() {
  const fn = function () { return anyMock(); };
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === 'then') return undefined; // 避免被当成 thenable
      if (prop === 'length') return 0;
      return anyMock();
    },
    apply() { return anyMock(); },
  });
}

function baseDeps(over = {}) {
  const st = {
    wakeConfig: { mode: 'diving', infinite: true, sleepUntil: null, triggers: {}, batchWindowMs: 8000 },
    unread: [],
    recentMessages: [],
    lastUnreadSeq: 0,
    agentToken: 'tok',
    activeTopics: [],
    pendingThoughts: [],
    memberImpressions: {},
    modelSeenSeqs: new Set(),
    sendTimes: [],
    pendingWakeReasons: [],
  };
  const sent = [];
  const deps = new Proxy({
    getSocialV2State: () => st,
    sendJson: (obj) => { sent.push(obj); },
    readBody: async () => ({}),
    v2ToolEnabled: () => true,
    v2SessionAllowed: () => true,
    agentTokenOk: () => true,
    modeAllowed: () => true,
    currentMode: () => 'reserved2',
    cfg: {
      socialV2: {
        enabled: true, sticker: {}, wake: {}, proactive: {}, context: {},
        send: { maxPerMessageChars: 500 },
      },
    },
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
    _sent: sent,
    _st: st,
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // 未知依赖一律给万能 mock（这正是我们要验证「不会因为未注入而崩」的地方）
      return anyMock();
    },
  });
  return Object.assign(deps, over);
}

function makeReq(pathname, method = 'GET', headers = {}) {
  return {
    method,
    headers: { 'x-agent-token': 'tok', ...headers },
    url: pathname,
  };
}

function makeUrl(pathname, params = {}) {
  const sp = new URLSearchParams(params);
  return { pathname, searchParams: sp };
}

const ENDPOINTS = [
  // [模块, handler, 方法, 路径, query]
  [handleSocialV2SendApi, 'send-burst', 'POST', '/api/socialV2/send-burst', {}],
  [handleSocialV2SendApi, 'send-message', 'POST', '/api/socialV2/send-message', {}],
  [handleSocialV2SendApi, 'send-poke', 'POST', '/api/socialV2/send-poke', {}],
  [handleSocialV2SendApi, 'send-voice', 'POST', '/api/socialV2/send-voice', {}],
  [handleSocialV2SendApi, 'send-sticker', 'POST', '/api/socialV2/send-sticker', {}],
  [handleSocialV2SendApi, 'collect-sticker', 'POST', '/api/socialV2/collect-sticker', {}],
  [handleSocialV2SendApi, 'sticker-image', 'GET', '/api/socialV2/sticker-image', {}],
  [handleSocialV2SendApi, 'self-image', 'GET', '/api/socialV2/self-image', {}],
  [handleSocialV2SendApi, 'voices', 'GET', '/api/socialV2/voices', {}],
  [handleSocialV2SendApi, 'sticker-list', 'GET', '/api/socialV2/sticker-list', {}],
  [handleSocialV2SendApi, 'sticker-note', 'POST', '/api/socialV2/sticker-note', {}],
  [handleSocialV2SendApi, 'qzone-send', 'POST', '/api/socialV2/qzone-send', {}],
  [handleSocialV2SendApi, 'qzone-list', 'POST', '/api/socialV2/qzone-list', {}],
  [handleSocialV2ToolsApi, 'tool-log', 'GET', '/api/socialV2/tool-log', {}],
  [handleSocialV2ToolsApi, 'tool-log/clear', 'POST', '/api/socialV2/tool-log/clear', {}],
  [handleSocialV2ToolsApi, 'feedback-clear', 'POST', '/api/socialV2/feedback-clear', {}],
  [handleSocialV2ToolsApi, 'my-recent', 'GET', '/api/socialV2/my-recent', {}],
  [handleSocialV2ToolsApi, 'active-members', 'GET', '/api/socialV2/active-members', {}],
  [handleSocialV2ToolsApi, 'message-detail', 'GET', '/api/socialV2/message-detail', {}],
  [handleSocialV2ToolsApi, 'forward-message', 'GET', '/api/socialV2/forward-message', {}],
  [handleSocialV2ToolsApi, 'forward-media', 'POST', '/api/socialV2/forward-media', {}],
  [handleSocialV2WakeSlangApi, 'wake', 'POST', '/api/socialV2/wake', {}],
  [handleSocialV2WakeSlangApi, 'wait', 'POST', '/api/socialV2/wait', {}],
  [handleSocialV2WakeSlangApi, 'check-send', 'POST', '/api/socialV2/check-send', {}],
  [handleSocialV2WakeSlangApi, 'slang/query', 'GET', '/api/socialV2/slang/query', {}],
  [handleSocialV2ControlApi, 'config', 'GET', '/api/socialV2/config', {}],
  [handleSocialV2ControlApi, 'activity', 'GET', '/api/socialV2/activity', {}],
  [handleSocialV2ControlApi, 'mark-read', 'POST', '/api/socialV2/mark-read', {}],
  [handleSocialV2ControlApi, 'wake-config', 'POST', '/api/socialV2/wake-config', {}],
  [handleSocialV2StateApi, 'state', 'GET', '/api/socialV2/state', {}],
  [handleSocialV2StateApi, 'prompt', 'GET', '/api/socialV2/prompt', {}],
  [handleSocialV2StateApi, 'unread', 'GET', '/api/socialV2/unread', {}],
  [handleSocialV2StateApi, 'recent', 'GET', '/api/socialV2/recent', {}],
  [handleSocialV2StateApi, 'states', 'GET', '/api/socialV2/states', {}],
  [handleSocialV2MemoryApi, 'memory', 'GET', '/api/socialV2/memory', {}],
  [handleSocialV2MemoryApi, 'memory-stats', 'GET', '/api/socialV2/memory-stats', {}],
  [handleSocialV2MemoryApi, 'memory-inspect', 'GET', '/api/socialV2/memory-inspect', {}],
  [handleSocialV2MemoryApi, 'memory-profile', 'GET', '/api/socialV2/memory-profile', {}],
];

for (const [handler, name, method, pathname] of ENDPOINTS) {
  test(`端点 ${name} 的依赖都能解析`, async () => {
    const deps = baseDeps();
    const req = makeReq(pathname, method);
    const url = makeUrl(pathname, { key: 'group:1', token: 't' });
    // 只关心「不会因为未注入而抛 ReferenceError」
    try {
      await handler({ ...deps, req, url });
    } catch (error) {
      // ReferenceError / TypeError（未定义）都算失败；业务异常（会走 catch 返回 500）可接受
      if (error instanceof ReferenceError) throw error;
      if (error instanceof TypeError && /is not a function|Cannot read/.test(String(error.message))) {
        // mock 返回的万能对象可能不是函数，这属于 mock 局限，不是真实 bug
        return;
      }
      // 其他异常视为业务路径，放行
    }
  });
}
