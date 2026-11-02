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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGalaxyCache } from '../src/lib/galaxy-cache.mjs';
import { isAllowedGalaxyHost, isAgentRequest, galaxyCachePayload, GALAXY_CSP } from '../src/lib/galaxy-security.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

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
    // 静态 JS 在 token 闸门前（Host 校验后）：不含记忆数据，浏览器 <script src> 不带 token
    if (req.method === 'GET' && req.url === '/galaxy/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end('console.log(1)');
      return;
    }
    // 页面入口：/galaxy 与 /galaxy/ 都返回同一份真实 HTML（与 bridge 的双入口一致）。
    if (req.method === 'GET' && (req.url === '/galaxy' || req.url === '/galaxy/')) {
      let html = '';
      try { html = fs.readFileSync(path.join(ROOT, 'tools', 'memory-galaxy', 'index.html'), 'utf8'); } catch { html = ''; }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': GALAXY_CSP,
      });
      res.end(html);
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
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': GALAXY_CSP });
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

test('galaxy-http：冷失败占位必须带 retryAfterMs（否则前端倒计时永远不生效）', () => {
  const failed = galaxyCachePayload({ state: 'error', data: null, error: 'boom', retryAfterMs: 2000 });
  assert.equal(failed.meta.retryAfterMs, 2000);
  const pending = galaxyCachePayload({ state: 'pending', data: null, error: null, retryAfterMs: 1500 });
  assert.equal(pending.meta.retryAfterMs, 1500);
  // stale 不需要该字段（仍有旧数据可看）
  const stale = galaxyCachePayload({ state: 'stale', data: { stars: [], messages: [], meta: {} }, error: null });
  assert.equal(stale.meta.retryAfterMs, undefined);
});

test('galaxy-http：静态 app.js 无 token 可加载（不进 token 闸门）', async () => {
  const fx = await startFixture();
  const r = await request(fx.port, { path: '/galaxy/app.js' });
  assert.equal(r.status, 200);
  assert.ok(String(r.headers['content-type']).includes('javascript'));
  // 页面/数据仍要求 token
  assert.equal((await request(fx.port)).status, 401);
  fx.server.closeAllConnections?.();
  fx.server.close();
});

test('galaxy-http：页面 CSP 收紧到 script-src self（无 unsafe-inline 脚本）', async () => {
  const fx = await startFixture();
  const r = await request(fx.port, { headers: { 'x-console-token': TOKEN } });
  const csp = String(r.headers['content-security-policy'] || '');
  assert.ok(csp.includes("script-src 'self'"), '必须限制 script-src self');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'script-src 不能含 unsafe-inline');
  fx.server.closeAllConnections?.();
  fx.server.close();
});

test('galaxy-http：/galaxy 与 /galaxy/ 页面入口的脚本 URL 都命中静态资源（审查 r6 P1）', async () => {
  const fx = await startFixture();
  try {
    for (const pagePath of ['/galaxy', '/galaxy/']) {
      const page = await request(fx.port, { path: pagePath });
      assert.equal(page.status, 200, `${pagePath} 应返回页面`);
      assert.match(String(page.headers['content-security-policy'] || ''), /script-src 'self'/, `${pagePath} 页面应带 CSP`);
      const src = /<script[^>]+src="([^"]+)"/.exec(page.body)?.[1];
      assert.ok(src, `${pagePath} 页面必须有外置脚本`);
      // 用真实页面 URL 解析脚本路径：/galaxy 入口下相对路径会变成 /app.js（404），
      // 所以这里必须解析到 /galaxy/app.js。
      const resolved = new URL(src, `http://127.0.0.1:${fx.port}${pagePath}`).pathname;
      assert.equal(resolved, '/galaxy/app.js', `${pagePath} 入口脚本应解析为 /galaxy/app.js，实际 ${resolved}`);
      const js = await request(fx.port, { path: resolved });
      assert.equal(js.status, 200, `${pagePath} 解析出的 ${resolved} 应命中静态资源`);
      assert.ok(String(js.headers['content-type'] || '').includes('javascript'), `${resolved} 应返回 JS`);
    }
  } finally {
    fx.server.closeAllConnections?.();
    fx.server.close();
  }
});
