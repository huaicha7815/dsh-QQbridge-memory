// replay 专项测试：每个阶段和边界都要有反例。
//
// 为什么单独一个文件：之前 replay 的逻辑只在「端到端」里被顺带跑到，
// 而它的失败路径（S3 补写失败、已归档事件、坏行）从来没被覆盖过，
// 所以两轮审查都在这上面抓到回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore } from '../src/core/memory-store.mjs';

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  return { dir, store: createMemoryStore({ dir }) };
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

test('S3 初始写失败 → replay 补副本，主事件不重复', () => {
  const { dir, store } = freshStore();
  // 让 salient.jsonl 不可写（做成目录）
  fs.mkdirSync(path.join(dir, 'salient.jsonl'), { recursive: true });
  const ok = store.appendEvent({ t: Date.now(), k: 'g:1', kind: 'msg', text: '关键事件', s: 3 });
  assert.equal(ok, true, '主事件应写入成功');
  const evFile = path.join(dir, 'events', `${day()}.jsonl`);
  assert.equal(countLines(evFile), 1);
  assert.equal(store.stats().writeFailures, 1, 'S3 失败要记进清单');

  fs.rmdirSync(path.join(dir, 'salient.jsonl'));
  const r = store.replayWriteFailures();
  assert.equal(countLines(evFile), 1, '主事件不能被重复写');
  assert.equal(r.failed, 0);
  assert.equal(countLines(path.join(dir, 'salient.jsonl')), 1, 'S3 副本要补上');
  cleanup(dir);
});

test('replay 时 S3 补写仍失败 → 保留记录、不算恢复完成', () => {
  const { dir, store } = freshStore();
  // 造一条 phase=event 的失败记录（模拟主事件当时没写进去）
  const row = { id: 'ev-1', t: Date.now(), k: 'g:1', kind: 'msg', text: '待恢复', s: 3 };
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', id: 'ev-1', row, error: 'simulated' }) + '\n',
    'utf8',
  );
  // 让 salient 不可写
  fs.mkdirSync(path.join(dir, 'salient.jsonl'), { recursive: true });

  const r = store.replayWriteFailures();
  assert.equal(r.replayed, 0, 'S3 失败时不能算恢复成功');
  assert.equal(r.failed, 1, '失败记录必须保留');
  assert.ok(fs.existsSync(path.join(dir, 'write-failures.jsonl')), '清单不能被删');
  const kept = JSON.parse(fs.readFileSync(path.join(dir, 'write-failures.jsonl'), 'utf8').trim());
  assert.equal(kept.phase, 'salient', '应降级为 salient 阶段，下次只补副本');
  assert.equal(countLines(path.join(dir, 'events', `${day()}.jsonl`)), 1, '主事件已经写进去了');

  // 修好 S3 再 replay 一次 → 这次才算成功
  fs.rmdirSync(path.join(dir, 'salient.jsonl'));
  const r2 = store.replayWriteFailures();
  assert.equal(r2.replayed, 1);
  assert.equal(r2.failed, 0);
  assert.equal(countLines(path.join(dir, 'events', `${day()}.jsonl`)), 1, '主事件仍然只有一条');
  cleanup(dir);
});

test('已归档的事件：replay 不能重复写进活动日', () => {
  const { dir, store } = freshStore();
  const t = Date.now() - 200 * 86400000; // 200 天前（会被归档）
  const d = day(t);
  const id = 'arch-1';
  // 先把事件写进 L1 并归档
  store.appendEvent({ id, t, k: 'g:1', kind: 'msg', text: '早就归档的事', s: 3 });
  store.ensureConsolidation({ now: Date.now() });
  const archiveDir = path.join(dir, 'events-archive');
  const archived = fs.existsSync(archiveDir)
    ? fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'))
    : [];
  assert.ok(archived.length > 0, '应该有归档文件（前提）');

  // 造一条同 id 的失败记录
  const row = { id, t, k: 'g:1', kind: 'msg', text: '早就归档的事', s: 3 };
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', id, row, error: 'simulated' }) + '\n',
    'utf8',
  );
  const r = store.replayWriteFailures();
  assert.equal(r.skipped, 1, '归档里已有该 id → 应跳过');
  assert.equal(r.replayed, 0);
  const activeFile = path.join(dir, 'events', `${d}.jsonl`);
  assert.equal(countLines(activeFile), 0, '不能重新写进活动日文件');
  cleanup(dir);
});

test('主事件失败 → replay 补写；再跑一次幂等', () => {
  const { dir, store } = freshStore();
  fs.rmSync(path.join(dir, 'events'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'events'), 'blocked');
  const ok = store.appendEvent({ t: Date.now(), k: 'g:1', kind: 'msg', text: '要恢复', s: 1 });
  assert.equal(ok, false);
  assert.equal(store.stats().writeFailures, 1);

  fs.unlinkSync(path.join(dir, 'events'));
  const r1 = store.replayWriteFailures();
  assert.equal(r1.replayed, 1);
  const evFile = path.join(dir, 'events', `${day()}.jsonl`);
  assert.equal(countLines(evFile), 1);

  const r2 = store.replayWriteFailures(); // 模拟崩溃后重跑
  assert.equal(r2.replayed, 0, '第二次不应再写');
  assert.equal(countLines(evFile), 1, 'L1 仍然只有一条');
  cleanup(dir);
});

test('dryRun 只统计、不动数据', () => {
  const { dir, store } = freshStore();
  fs.rmSync(path.join(dir, 'events'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'events'), 'blocked');
  store.appendEvent({ t: Date.now(), k: 'g:1', kind: 'msg', text: 'x', s: 1 });
  fs.unlinkSync(path.join(dir, 'events'));

  const r = store.replayWriteFailures({ dryRun: true });
  assert.equal(r.replayed, 1);
  assert.ok(fs.existsSync(path.join(dir, 'write-failures.jsonl')), 'dryRun 不能删清单');
  assert.equal(countLines(path.join(dir, 'events', `${day()}.jsonl`)), 0, 'dryRun 不能写数据');
  cleanup(dir);
});

test('坏行进 quarantine，不被静默丢弃', () => {
  const { dir, store } = freshStore();
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl'), '{ 这不是 JSON\n', 'utf8');
  const r = store.replayWriteFailures();
  assert.equal(r.quarantined, 1);
  assert.ok(fs.existsSync(path.join(dir, 'write-failures.jsonl.quarantine')), '坏行要隔离保存');
  cleanup(dir);
});

test('旧格式记录（无 id）不会被误判为已恢复', () => {
  const { dir, store } = freshStore();
  const row = { t: Date.now(), k: 'g:1', kind: 'msg', text: '旧格式', s: 1 };
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), error: 'old', row }) + '\n',
    'utf8',
  );
  const r = store.replayWriteFailures();
  // 没有 id 无法安全幂等 → 进 quarantine，而不是假装恢复
  assert.equal(r.quarantined, 1);
  assert.equal(r.replayed, 0);
  assert.ok(fs.existsSync(path.join(dir, 'write-failures.jsonl.quarantine')));
  cleanup(dir);
});

test('quarantine 数量要能被健康检查看到', () => {
  const { dir, store } = freshStore();
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl'), '{ 坏行\n', 'utf8');
  store.replayWriteFailures();
  const st = store.stats();
  assert.ok(typeof st.quarantined === 'number', 'stats 应暴露 quarantined');
  assert.equal(st.quarantined, 1, 'quarantine 里的行数要计入');
  cleanup(dir);
});
