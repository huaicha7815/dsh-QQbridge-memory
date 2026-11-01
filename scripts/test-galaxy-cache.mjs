// 记忆银河缓存状态机的无 bridge 单测（注入 build/readFile/now/schedule，不碰真实文件）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGalaxyCache } from '../src/lib/galaxy-cache.mjs';

function makeHarness(initial = null) {
  let clock = 1000;
  let stored = initial == null ? null : JSON.stringify(initial);
  const builds = [];
  let failOnce = false;
  const queue = [];
  const cache = createGalaxyCache({
    file: '/virtual/galaxy.json',
    ttlMs: 1000,
    now: () => clock,
    readFile: () => stored,
    build: () => {
      builds.push(1);
      if (failOnce) { failOnce = false; throw new Error('build boom'); }
      stored = JSON.stringify({ stars: [{ id: 's1' }], messages: [], meta: { generatedAt: clock } });
    },
    schedule: (fn) => queue.push(fn),
  });
  return {
    cache,
    builds,
    queue,
    tick(ms) { clock += ms; },
    failNext() { failOnce = true; },
    setStored(v) { stored = v; },
    get stored() { return stored; },
  };
}

test('galaxy-cache：cold start 返回 pending，并只启动一次构建', () => {
  const h = makeHarness();
  const r1 = h.cache.getData();
  const r2 = h.cache.getData();
  assert.equal(r1.state, 'pending');
  assert.equal(r2.state, 'pending');
  assert.equal(h.queue.length, 1, '并发请求只能排一次构建');
  assert.equal(h.cache.isBuilding(), true);
});

test('galaxy-cache：构建成功后转 fresh', () => {
  const h = makeHarness();
  h.cache.getData();
  h.cache.flush();
  const r = h.cache.getData();
  assert.equal(r.state, 'fresh');
  assert.equal(r.data.stars.length, 1);
});

test('galaxy-cache：TTL 内不重复构建，TTL 后返回 stale 并触发重建', () => {
  const h = makeHarness();
  h.cache.getData();
  h.cache.flush();
  h.tick(500);
  assert.equal(h.cache.getData().state, 'fresh');
  assert.equal(h.queue.length, 1, 'TTL 内不应再构建');
  h.tick(600);
  const r = h.cache.getData();
  assert.equal(r.state, 'stale');
  assert.equal(r.data.stars.length, 1, 'stale 也要返回旧数据');
  assert.equal(h.queue.length, 2, 'stale 触发一次后台重建');
});

test('galaxy-cache：stale 期间并发请求只触发一次重建', () => {
  const h = makeHarness();
  h.cache.getData();
  h.cache.flush();
  h.tick(2000);
  h.cache.getData();
  h.cache.getData();
  h.cache.getData();
  assert.equal(h.queue.length, 2, '并发 stale 只能排一次重建');
});

test('galaxy-cache：后台构建失败保留旧缓存并记录错误', () => {
  const h = makeHarness();
  h.cache.getData();
  h.cache.flush();                         // 第一次构建成功 → 缓存可用
  assert.equal(h.cache.getData().state, 'fresh');
  h.tick(2000);                            // 让缓存过期
  h.failNext();                            // 下一次构建失败
  const stale = h.cache.getData();
  assert.equal(stale.state, 'stale');
  assert.equal(stale.data.stars[0].id, 's1', 'stale 仍返回旧数据');
  h.cache.flush();                         // 后台构建失败
  const after = h.cache.getData();
  assert.equal(after.state, 'stale', '构建失败后旧缓存仍可读（不伪装空库）');
  assert.equal(after.data.stars[0].id, 's1');
});


test('galaxy-cache：cold build 失败返回 error，不伪装成空库', () => {
  const h = makeHarness();
  h.failNext();
  h.cache.getData();
  h.cache.flush();
  const r = h.cache.getData();
  assert.equal(r.state, 'error');
  assert.equal(r.data, null);
  assert.match(String(r.error), /build boom/);
});

test('galaxy-cache：构建产出坏 JSON 也按失败处理', () => {
  const h = makeHarness();
  h.cache.getData();
  // 构建后文件是坏 JSON
  const cache2 = createGalaxyCache({
    file: '/virtual/bad.json',
    ttlMs: 1000,
    now: () => 1000,
    readFile: () => '{not json',
    build: () => {},
    schedule: (fn) => fn(),
  });
  cache2.getData();
  const r = cache2.getData();
  assert.equal(r.state, 'error');
  assert.ok(r.error);
});

test('galaxy-cache：warm 预加载后立即可用', () => {
  const h = makeHarness();
  h.cache.warm();
  h.cache.flush();
  assert.equal(h.cache.getData().state, 'fresh');
});

test('galaxy-cache：reset 清空状态', () => {
  const h = makeHarness();
  h.cache.getData();
  h.cache.flush();
  assert.equal(h.cache.getData().state, 'fresh');
  h.cache.reset();
  assert.equal(h.cache.getData().state, 'pending');
});

test('galaxy-cache：缺参数时立刻报错（fail closed）', () => {
  assert.throws(() => createGalaxyCache({ readFile: () => '' , file: 'x' }), /build/);
  assert.throws(() => createGalaxyCache({ build: () => {}, file: 'x' }), /readFile/);
  assert.throws(() => createGalaxyCache({ build: () => {}, readFile: () => '' }), /file/);
});


test('galaxy-cache：构建失败后进入冷却，连续请求不重复构建', () => {
  const h = makeHarness();
  h.failNext();
  h.cache.getData();          // pending
  h.cache.flush();            // 失败
  const first = h.builds.length;
  for (let i = 0; i < 10; i += 1) h.cache.getData();
  assert.equal(h.builds.length, first, '冷却期内不能重复构建');
  const r = h.cache.getData();
  assert.equal(r.state, 'error');
  assert.match(String(r.error), /build boom/);
});

test('galaxy-cache：stale 构建失败时 stale 结果携带最近错误', () => {
  const h = makeHarness();
  h.cache.getData();
  h.cache.flush();
  h.tick(2000);
  h.failNext();
  h.cache.getData();
  h.cache.flush();
  const r = h.cache.getData();
  assert.equal(r.state, 'stale');
  assert.match(String(r.error), /build boom/);
});

test('galaxy-cache：冷却到期后只重试一次', () => {
  const h = makeHarness();
  h.failNext();
  h.cache.getData();
  h.cache.flush();
  const before = h.builds.length;
  h.tick(65_000);             // 超过最大退避 60s
  h.cache.getData();
  h.cache.getData();
  h.cache.getData();
  h.cache.flush();            // 执行排队的唯一一次构建
  assert.equal(h.builds.length, before + 1, '冷却到期后只能排一次');
});

test('galaxy-cache：成功后清除错误与冷却', () => {
  const h = makeHarness();
  h.failNext();
  h.cache.getData();
  h.cache.flush();
  assert.equal(h.cache.getData().state, 'error');
  // 冷却到期后重试成功（harness 的 failNext 只影响一次构建之外？这里重置 stored 模拟成功）
  h.tick(65_000);
  h.cache.getData();
  h.cache.flush();
  const r = h.cache.getData();
  assert.ok(['fresh', 'stale'].includes(r.state), '成功后可读');
  assert.equal(r.error, null, '成功后清除错误');
});
