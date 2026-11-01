// 记忆银河 HTTP 的 hermetic 测试：不依赖正在运行的 bridge。
//
// 注意：fixture 内 token 用普通字符串比较，只验证「接受/拒绝」语义；
// 真实 bridge 用 crypto.timingSafeEqual 防本机时序试探（两层职责不同，不要混用）。
//
// 起一个最小 http server，用与 bridge 相同的谓词（isAllowedGalaxyHost / isAgentRequest）
// 和同一个缓存状态机（createGalaxyCache），覆盖鉴权、Host、agent、no-store、脱敏与状态投影。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGalaxyCache } from '../src/lib/galaxy-cache.mjs';
import { isAllowedGalaxyHost, isAgentRequest, galaxyCachePayload } from '../src/lib/galaxy-security.mjs';

const TOKEN = 'test-token-0123456789abcdef';

function startFixture({ failBuild = false } = {}) {
  let stored = null;
  const cache = createGalaxyCache({
    file: '/virtual/galaxy.json',
    ttlMs: 60_000,
    now: () => 1000,
    readFile: () => stored,
    build: () => {
      if (failBuild) throw new Error('build boom');
      stored = JSON.stringify({
        stars: [{ id: 's1', kind: 'event', rawKind: 'event', title: '记忆', text: '正文', tags: ['私聊'], weight: 2, at: 1, lastHitAt: 0, pin: false }],
        messages: [{ scope: 'private', channel: 'c44bba23f', at: 1, self: true, text: '消息' }],
        meta: { counts: { event: 1 }, partial: false, errorCount: 0, total: 1, pinned: 0, messages: 1, avgStrength: 1, sources: { memory: 1, diary: 0, message: 1 }, dataFingerprint: 'fp1' },
      });
    },
    schedule: (fn) => fn(),   // 同步执行，避免测试里等事件循环
  });

  const server = http.createServer((req, res) => {
    const port = server.address().port;
    if (!isAllowedGalaxyHost(req.headers.host, port)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end('forbidden host');
      return;
    }
    const supplied = String(new URL(req.url, 'http://localhost').searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
    if (supplied !== TOKEN) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(JSON.stringify({ ok: false, error: '未授权' }));
      return;
    }
    if (isAgentRequest(req.headers)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(JSON.stringify({ ok: false, error: '该接口仅控制台可用' }));
      return;
    }
    const body = galaxyCachePayload(cache.getData());
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(JSON.stringify(body));
  });

  cache.warm();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, cache }));
  });
}

function request(port, { path = '/galaxy/api/data', host, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'GET',
      headers: { host: host || `127.0.0.1:${port}`, ...headers },
      agent: false,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('galaxy-http：无 token 401', async () => {
  const fx = await startFixture();
  const r = await request(fx.port);
  assert.equal(r.status, 401);
  fx.server.closeAllConnections?.();
  fx.server.close();
});

test('galaxy-http：错误 Host 403', async () => {
  const fx = await startFixture();
  const r = await request(fx.port, { host: 'evil.example.com', headers: { 'x-console-token': TOKEN } });
  assert.equal(r.status, 403);
  fx.server.closeAllConnections?.();
  fx.server.close();
});

test('galaxy-http：agent token / agent call 403', async () => {
  const fx = await startFixture();
  for (const h of [{ 'x-agent-token': 'x' }, { 'x-agent-call': '1' }]) {
    const r = await request(fx.port, { headers: { 'x-console-token': TOKEN, ...h } });
    assert.equal(r.status, 403, JSON.stringify(h));
  }
  fx.server.closeAllConnections?.();
  fx.server.close();
});

test('galaxy-http：正确 token 200 + no-store + no-referrer + 脱敏字段', async () => {
  const fx = await startFixture();
  const r = await request(fx.port, { headers: { 'x-console-token': TOKEN } });
  assert.equal(r.status, 200);
  assert.ok(String(r.headers['cache-control']).includes('no-store'));
  assert.equal(String(r.headers['referrer-policy']), 'no-referrer');
  const j = JSON.parse(r.body);
  assert.ok(Array.isArray(j.stars));
  assert.equal(j.messages[0].scope, 'private');
  assert.ok(/^c[0-9a-f]{8}$/.test(j.messages[0].channel));
  assert.ok(!r.body.includes('1477325291'));
  fx.server.closeAllConnections?.();
  fx.server.close();
});

test('galaxy-http：冷构建失败返回 build-failed 占位（不伪装空库）', async () => {
  const fx = await startFixture({ failBuild: true });
  const r = await request(fx.port, { headers: { 'x-console-token': TOKEN } });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.meta.partial, true);
  assert.ok(j.meta.errors.some((e) => e.error === 'build-failed'));
  assert.equal(j.meta.cacheState, 'error');
  fx.server.closeAllConnections?.();
  fx.server.close();
});

test('galaxy-http：stale 响应带 cacheState=stale 与警告（数据投影是纯函数）', () => {
  const payload = galaxyCachePayload({
    state: 'stale',
    data: { stars: [{ id: 'old' }], messages: [], meta: { counts: {}, partial: false, errorCount: 0 } },
    error: 'build boom',
  });
  assert.equal(payload.meta.cacheState, 'stale');
  assert.match(String(payload.meta.cacheWarning), /旧数据/);
  assert.equal(payload.stars[0].id, 'old', 'stale 仍返回旧数据');
  // 不带缓存的 cold 状态：pending / error
  const pending = galaxyCachePayload({ state: 'pending', data: null, error: null });
  assert.equal(pending.meta.cacheState, 'pending');
  assert.ok(pending.meta.errors.some((e) => e.error === 'build-pending'));
  const failed = galaxyCachePayload({ state: 'error', data: null, error: 'boom' });
  assert.ok(failed.meta.errors.some((e) => e.error === 'build-failed'));
  // 新鲜数据也要带上 cacheState（可观测性），但不写进 fingerprint 之外
  const fresh = galaxyCachePayload({ state: 'fresh', data: { stars: [], messages: [], meta: { counts: {}, partial: false, errorCount: 0, dataFingerprint: 'x' } } });
  assert.equal(fresh.meta.cacheState, 'fresh');
});

test('galaxy-http：cacheState/cacheWarning 注入不改变 dataFingerprint', () => {
  const data = { stars: [{ id: 's1' }], messages: [], meta: { counts: {}, partial: false, errorCount: 0, dataFingerprint: 'fp-stable' } };
  const fresh = galaxyCachePayload({ state: 'fresh', data });
  const stale = galaxyCachePayload({ state: 'stale', data, error: 'boom' });
  assert.equal(fresh.meta.dataFingerprint, 'fp-stable');
  assert.equal(stale.meta.dataFingerprint, 'fp-stable', '状态注入不能改变内容指纹');
  assert.equal(data.meta.cacheState, undefined, '原始缓存对象不能被原地修改');
  assert.equal(data.meta.cacheWarning, undefined, '原始缓存对象不能被原地修改');
});
