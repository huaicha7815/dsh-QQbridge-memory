// 真实桥接 HTTP 鉴权回归：用 audit-bridge-harness 同进程起 bridge（不 spawn、不连真网关）。
//
// 覆盖集中关卡的关键语义：
//   1) tokenless x-agent-call：只允许 GET /api/status，且只拿最小对象；
//   2) tokenless x-agent-call：其它路径必须 403（legacy 只读工具的探测面收窄）；
//   3) 无效 agent token：任何路径都 403；
//   4) 无 token 的无声明请求：401 令牌挑战。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const CONSOLE = 'fixture-console-token';

async function withHarness(fn) {
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    return await fn({ h, base: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

test('tokenless x-agent-call：GET /api/status 返回最小对象（无管理字段）', async () => {
  await withHarness(async ({ base }) => {
    const res = await fetch(base + '/api/status', {
      headers: { 'x-console-token': CONSOLE, 'x-agent-call': '1' },
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text);
    assert.ok(body.mode, '最小对象应含 mode');
    for (const forbidden of ['ownerQQ', 'allowGroups', 'allowPrivate', 'activity', 'build']) {
      assert.equal(body[forbidden], undefined, `tokenless status 不能泄露 ${forbidden}`);
    }
  });
});

test('tokenless x-agent-call：非 /api/status 一律 403', async () => {
  await withHarness(async ({ base }) => {
    const cases = [
      ['GET', '/api/socialV2/prompt?key=private:123'],
      ['GET', '/api/socialV2/state?key=private:123'],
      ['POST', '/api/send/group'],
    ];
    for (const [method, pathName] of cases) {
      const res = await fetch(base + pathName, {
        method,
        headers: { 'x-console-token': CONSOLE, 'x-agent-call': '1', 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      });
      assert.equal(res.status, 403, `tokenless agent 访问 ${method} ${pathName} 必须 403，实际 ${res.status}`);
    }
  });
});

test('无效 agent token：请求被拒绝（不能退回管理端）', async () => {
  await withHarness(async ({ base }) => {
    const res = await fetch(base + '/api/socialV2/prompt?key=private:123', {
      headers: { 'x-console-token': CONSOLE, 'x-agent-token': 'deadbeef', 'x-agent-call': '1' },
    });
    assert.equal(res.status, 403, `无效 token 必须 403，实际 ${res.status}`);
    const admin = await fetch(base + '/api/socialV2/config', {
      headers: { 'x-console-token': CONSOLE, 'x-agent-token': 'deadbeef' },
    });
    assert.equal(admin.status, 403, `无效 token 访问管理端点必须 403，实际 ${admin.status}`);
  });
});

/* ── 活跃 agent token：同 key 可用、跨 key / 管理端点拒绝 ── */

async function withLiveSessions(fn) {
  const h = await bridgeHarness({
    config: { allow: { private: ['123'], groups: ['456', '789'] } },
  });
  h.setMode('reserved2');
  h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    await h.ensureSession('group:456');
    await h.ensureSession('group:789');
    const tokenA = h.getSocialV2State('group:456').agentToken;
    const tokenB = h.getSocialV2State('group:789').agentToken;
    assert.ok(tokenA && tokenB, '两个会话都应有 agentToken');
    return await fn({ h, base: `http://127.0.0.1:${port}`, tokenA, tokenB });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

const agentFetch = (base, token) => async (pathName, method = 'GET', body) => {
  return fetch(base + pathName, {
    method,
    headers: {
      'x-console-token': CONSOLE,
      'x-agent-token': token,
      'x-agent-call': '1',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

test('活跃 agent token：能读自己的 state', async () => {
  await withLiveSessions(async ({ base, tokenA }) => {
    const res = await agentFetch(base, tokenA)('/api/socialV2/state?key=group:456');
    assert.equal(res.status, 200, await res.text());
  });
});

test('活跃 agent token：读取别的会话必须 403', async () => {
  await withLiveSessions(async ({ base, tokenA }) => {
    const res = await agentFetch(base, tokenA)('/api/socialV2/state?key=group:789');
    assert.equal(res.status, 403, `跨会话读取必须 403，实际 ${res.status}`);
  });
});

test('活跃 agent token：管理端点必须 403', async () => {
  await withLiveSessions(async ({ base, tokenA }) => {
    for (const pathName of ['/api/socialV2/config', '/api/socialV2/states', '/api/stickers']) {
      const res = await agentFetch(base, tokenA)(pathName);
      assert.equal(res.status, 403, `agent 访问 ${pathName} 必须 403，实际 ${res.status}`);
    }
  });
});

test('活跃 agent token：白名单内 POST 工具可用', async () => {
  await withLiveSessions(async ({ base, tokenA }) => {
    const res = await agentFetch(base, tokenA)('/api/socialV2/feedback', 'POST', {
      key: 'group:456', level: 'info', message: 'auth probe',
    });
    const text = await res.text();
    assert.equal(res.status, 200, `允许表内工具应真正进入业务处理，实际 ${res.status}: ${text}`);
    const body = JSON.parse(text);
    assert.equal(body.ok, true, '业务响应 ok 必须为 true');
    assert.equal(body.key, 'group:456', '反馈应落在本会话 key 上');
  });
});

test('CSRF：非严格 application/json 的写请求必须 415，charset 变体必须放行', async () => {
  await withHarness(async ({ base }) => {
    for (const ctype of ['text/plain', 'text/application/json', 'application/json-patch+json']) {
      const res = await fetch(base + '/api/socialV2/feedback', {
        method: 'POST',
        headers: { 'x-console-token': CONSOLE, 'content-type': ctype },
        body: '{}',
      });
      assert.equal(res.status, 415, `${ctype} 必须 415，实际 ${res.status}`);
    }
    const ok = await fetch(base + '/api/socialV2/feedback', {
      method: 'POST',
      headers: { 'x-console-token': CONSOLE, 'content-type': 'application/json; charset=utf-8' },
      body: '{}',
    });
    assert.notEqual(ok.status, 415, 'application/json; charset=utf-8 不能被 CSRF 拦');
  });
});

test('?token= 只用于页面引导：API 不接受 query token', async () => {
  await withHarness(async ({ base }) => {
    const api = await fetch(base + '/api/status?token=' + encodeURIComponent(CONSOLE));
    assert.equal(api.status, 401, 'API 不能用 ?token= 鉴权，实际 ' + api.status);
    const page = await fetch(base + '/?token=' + encodeURIComponent(CONSOLE));
    assert.equal(page.status, 200, '页面引导必须接受 ?token=，实际 ' + page.status);
  });
});

test('Sec-Fetch-Site 跨站写请求必须 403', async () => {
  await withHarness(async ({ base }) => {
    const res = await fetch(base + '/api/socialV2/feedback', {
      method: 'POST',
      headers: {
        'x-console-token': CONSOLE,
        'content-type': 'application/json',
        'sec-fetch-site': 'cross-site',
      },
      body: '{}',
    });
    assert.equal(res.status, 403, '跨站写请求必须 403，实际 ' + res.status);
    const same = await fetch(base + '/api/socialV2/feedback', {
      method: 'POST',
      headers: {
        'x-console-token': CONSOLE,
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
      },
      body: '{}',
    });
    assert.notEqual(same.status, 403, '同源请求不能被 Sec-Fetch-Site 拦');
  });
});

test('memory-inspect 对 agent 必须是最小会话视图（无 root/config/paths）', async () => {
  await withLiveSessions(async ({ base, tokenA }) => {
    const res = await agentFetch(base, tokenA)('/api/socialV2/memory-inspect?key=group:456');
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.inspect.scope, 'session', 'agent 必须拿到 session scope');
    assert.equal(body.inspect.stats.scope, 'session', 'stats 也必须 session scope');
    for (const forbidden of ["root", "salient", "config", "paths"]) {
      assert.equal(body.inspect[forbidden], undefined, `agent 不能拿到 ${forbidden}`);
      // 管理字段实际挂在 stats 里，必须逐个检查
      assert.equal(body.inspect.stats[forbidden], undefined, `agent 不能拿到 stats.${forbidden}`);
    }
    for (const field of ["pendingRecoverable", "writeFailures"]) {
      assert.equal(body.inspect.stats[field], undefined, `agent 不能拿到 stats.${field}`);
    }
    assert.ok(Array.isArray(body.inspect.omitted) && body.inspect.omitted.includes('config'), 'omitted 必须列出被裁剪的管理字段');
  });
});
