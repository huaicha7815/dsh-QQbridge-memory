// 记忆银河控制台路由的 HTTP 级测试（需要 bridge 正在 3100 运行；未运行时整体 skip）。
//
//   node scripts/test-galaxy-routes.mjs
//
// 覆盖：无 token 401 / 错误 Host 403 / agent token 403 / 正常 token 200 / no-store。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;

function readToken() {
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function probe() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/status', method: 'GET', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode != null);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function rawRequest({ path, host, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

const running = await probe();
const token = readToken();

test('galaxy 路由：bridge 未运行则跳过', { skip: !running }, async () => {
  assert.ok(running);
});

test('galaxy 路由：无 token 401', { skip: !running }, async () => {
  for (const p of ['/galaxy/', '/galaxy/api/data']) {
    const r = await rawRequest({ path: p, host: `127.0.0.1:${PORT}` });
    assert.equal(r.status, 401, `${p} 应 401`);
  }
});

test('galaxy 路由：错误 Host 403（DNS rebinding 防护）', { skip: !running }, async () => {
  for (const p of ['/galaxy/', '/galaxy/api/data']) {
    const r = await rawRequest({ path: p, host: 'evil.example.com', headers: { 'x-console-token': token } });
    assert.equal(r.status, 403, `${p} 错误 Host 应 403`);
  }
});

test('galaxy 路由：agent token 403（会话级不能读管理面）', { skip: !running }, async () => {
  const r = await rawRequest({
    path: '/galaxy/api/data',
    host: `127.0.0.1:${PORT}`,
    headers: { 'x-console-token': token, 'x-agent-token': 'fake-agent' },
  });
  assert.equal(r.status, 403);
});

test('galaxy 路由：正确 token 200 且 no-store', { skip: !running }, async () => {
  for (const p of ['/galaxy/', '/galaxy/api/data']) {
    const r = await rawRequest({ path: p, host: `127.0.0.1:${PORT}`, headers: { 'x-console-token': token } });
    assert.equal(r.status, 200, `${p} 应 200`);
    assert.equal(String(r.headers['cache-control'] || '').includes('no-store'), true, `${p} 需要 no-store`);
    assert.equal(String(r.headers['referrer-policy'] || ''), 'no-referrer', `${p} 需要 no-referrer`);
  }
  const data = await rawRequest({ path: '/galaxy/api/data', host: `127.0.0.1:${PORT}`, headers: { 'x-console-token': token } });
  const j = JSON.parse(data.body);
  assert.ok(Array.isArray(j.stars), '数据必须含 stars');
  assert.ok(String(data.body).includes('"scope"'), '消息必须已脱敏为 scope');
  assert.ok(!String(data.body).includes('private:1'), '不能出现原始会话 key');
});
