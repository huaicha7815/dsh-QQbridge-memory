// replay 专项测试：每个阶段和边界都要有反例。
//
// 为什么单独一个文件：之前 replay 的逻辑只在「端到端」里被顺带跑到，
// 而它的失败路径（S3 补写失败、已归档事件、坏行）从来没被覆盖过，
// 所以两轮审查都在这上面抓到回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createMemoryStore } from '../src/core/memory-store.mjs';
import { handleSocialV2MemoryApi } from '../src/routes/socialv2-memory-api.mjs';
import { mergePersonFact, mergeThread, mergeSelfNote, verifyMemoryClaim, buildWriteScope, eventsVisibleToSession } from '../src/core/memory-lib.mjs';

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  return { dir, store: createMemoryStore({ dir }) };
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
// 必须用本地日期：appendEvent 的 dayString() 是本地时区的，
// 测试用 UTC 会在 Asia/Shanghai 的 00:00–08:00 窗口找错文件，产生假失败。
const day = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA');
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

test('锁被占用时 fail-closed：不写数据、保留清单', () => {
  const { dir, store } = freshStore();
  // 造一条待恢复记录
  fs.rmSync(path.join(dir, 'events'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'events'), 'blocked');
  store.appendEvent({ t: Date.now(), k: 'g:1', kind: 'msg', text: 'x', s: 1 });
  fs.unlinkSync(path.join(dir, 'events'));
  // 放一个「活锁」：owner 是别人、刚创建、pid 指向一个活着的进程
  // （pid 是死进程的锁会被判定为崩溃残留并立即接管，那是刻意的）
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl.lock'), JSON.stringify({ owner: 'other', pid: process.pid, at: Date.now() }), 'utf8');
  const r = store.replayWriteFailures();
  assert.equal(r.locked, true, '应该返回 locked');
  assert.equal(r.replayed, 0, '锁被占时不能写数据');
  assert.ok(fs.existsSync(path.join(dir, 'write-failures.jsonl')), '清单要保留');
  // 释放：不能删掉别人的锁
  assert.ok(fs.existsSync(path.join(dir, 'write-failures.jsonl.lock')), '不能删除别人的锁');
  cleanup(dir);
});

test('L1 已有 id 但 S3 副本缺失 → 补副本而不是 skip', () => {
  const { dir, store } = freshStore();
  const t = Date.now();
  const id = 's3-missing-1';
  store.appendEvent({ id, t, k: 'g:1', kind: 'msg', text: '关键事件', s: 3 });
  // 人为删掉 S3 副本，模拟「主事件在、副本丢」
  const salientFile = path.join(dir, 'salient.jsonl');
  fs.rmSync(salientFile, { force: true });
  assert.ok(!fs.existsSync(salientFile), '前提：S3 副本已删掉');
  // 造一条 event 阶段记录（同 id）
  const row = { id, t, k: 'g:1', kind: 'msg', text: '关键事件', s: 3 };
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', id, row, error: 'simulated' }) + '\n',
    'utf8',
  );
  const r = store.replayWriteFailures();
  assert.equal(r.skipped, 0, '不能简单 skip——S3 还缺');
  assert.equal(r.replayed, 1, '应该补 S3');
  assert.ok(fs.existsSync(salientFile), 'S3 副本要补上');
  assert.equal(countLines(path.join(dir, 'events', `${day(t)}.jsonl`)), 1, '主事件不能重复');
  cleanup(dir);
});

test('replay 运行期间桥接新增的失败行不能被吞掉', () => {
  const { dir, store } = freshStore();
  // 造一条待恢复记录（主事件写失败）
  fs.rmSync(path.join(dir, 'events'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'events'), 'blocked');
  store.appendEvent({ t: Date.now(), k: 'g:1', kind: 'msg', text: '旧失败', s: 1 });
  fs.unlinkSync(path.join(dir, 'events'));

  // 模拟桥接在 replay「读清单之后、提交之前」又追加了一条失败记录
  const r = store.replayWriteFailures({
    onBeforeCommit: () => {
      const newRow = { id: `late-${Date.now()}`, t: Date.now(), k: 'g:1', kind: 'msg', text: '期间新增', s: 1 };
      fs.appendFileSync(
        path.join(dir, 'write-failures.jsonl'),
        JSON.stringify({ at: Date.now(), phase: 'event', id: newRow.id, row: newRow, error: 'late' }) + '\n',
        'utf8',
      );
    },
  });
  assert.equal(r.replayed, 1, '旧记录应被恢复');
  const failFile = path.join(dir, 'write-failures.jsonl');
  assert.ok(fs.existsSync(failFile), '清单不能整个被删——期间新增的行还在');
  const rest = fs.readFileSync(failFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(rest.length, 1, '应该只剩期间新增的那 1 条');
  const kept = JSON.parse(rest[0]);
  assert.match(kept.row.text, /期间新增/, '保留的必须是新行，不是旧行');
  cleanup(dir);
});

test('锁文件损坏不会被当成活锁卡死', () => {
  const { dir, store } = freshStore();
  fs.rmSync(path.join(dir, 'events'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'events'), 'blocked');
  store.appendEvent({ t: Date.now(), k: 'g:1', kind: 'msg', text: 'x', s: 1 });
  fs.unlinkSync(path.join(dir, 'events'));
  // 坏 JSON 的锁文件（模拟续租时被另一个进程读到坏内容）
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl.lock'), '{ broken', 'utf8');
  const r = store.replayWriteFailures();
  assert.equal(r.locked, undefined, '坏锁应视为过期，可以接管');
  assert.equal(r.replayed, 1, '应能正常恢复');
  cleanup(dir);
});

test('上次 replay 崩溃留下的 .processing 快照会被恢复，而不是被覆盖', () => {
  const { dir, store } = freshStore();
  // 遗留快照里有一条事件 A
  const rowA = { id: 'snap-a', t: Date.now(), k: 'g:1', kind: 'msg', text: '旧快照里的事', s: 1 };
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl.processing'),
    JSON.stringify({ at: Date.now(), phase: 'event', id: 'snap-a', row: rowA, error: 'crash' }) + '\n',
    'utf8',
  );
  // 主清单里有一条事件 B
  const rowB = { id: 'snap-b', t: Date.now(), k: 'g:1', kind: 'msg', text: '主清单里的事', s: 1 };
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', id: 'snap-b', row: rowB, error: 'fail' }) + '\n',
    'utf8',
  );

  const r = store.replayWriteFailures();
  assert.equal(r.replayed, 2, '两条都要恢复，不能只恢复主清单那条');
  const evFile = path.join(dir, 'events', `${day()}.jsonl`);
  const content = fs.readFileSync(evFile, 'utf8');
  assert.ok(content.includes('旧快照里的事'), '遗留快照里的事件必须恢复');
  assert.ok(content.includes('主清单里的事'), '主清单里的事件必须恢复');
  cleanup(dir);
});

test('只有遗留 .processing 时，dry-run 和 apply 的计数一致', () => {
  const { dir, store } = freshStore();
  const row = { id: 'only-snap', t: Date.now(), k: 'g:1', kind: 'msg', text: '只有快照', s: 1 };
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl.processing'),
    JSON.stringify({ at: Date.now(), phase: 'event', id: 'only-snap', row, error: 'crash' }) + '\n',
    'utf8',
  );
  // 主清单不存在
  const dry = store.replayWriteFailures({ dryRun: true });
  assert.equal(dry.replayed, 1, 'dry-run 也要看到遗留快照');
  const st = store.stats();
  assert.ok(st.writeFailures >= 1, '统计要计入遗留快照，不能显示 0');
  const applied = store.replayWriteFailures();
  assert.equal(applied.replayed, 1, 'apply 的计数要与 dry-run 一致');
  cleanup(dir);
});

test('多个遗留快照都会被处理，不互相覆盖', () => {
  const { dir, store } = freshStore();
  for (const [name, id] of [["write-failures.jsonl.processing", "gen-1"], ["write-failures.jsonl.processing-123-abc", "gen-2"]]) {
    const row = { id, t: Date.now(), k: 'g:1', kind: 'msg', text: `快照${id}`, s: 1 };
    fs.writeFileSync(
      path.join(dir, name),
      JSON.stringify({ at: Date.now(), phase: 'event', id, row, error: 'crash' }) + '\n',
      'utf8',
    );
  }
  const r = store.replayWriteFailures();
  assert.equal(r.replayed, 2, '两个快照都要恢复');
  const evFile = path.join(dir, 'events', `${day()}.jsonl`);
  const content = fs.readFileSync(evFile, 'utf8');
  assert.ok(content.includes('快照gen-1'));
  assert.ok(content.includes('快照gen-2'));
  cleanup(dir);
});

test('快照读取失败时不能被删除（保留待下次）', () => {
  const { dir, store } = freshStore();
  // 主清单正常
  const rowA = { id: 'ok-a', t: Date.now(), k: 'g:1', kind: 'msg', text: '能读的', s: 1 };
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', id: 'ok-a', row: rowA, error: 'x' }) + '\n',
    'utf8',
  );
  // 一个读不出来的快照：用目录冒充文件，readFileSync 会抛 EISDIR
  const badSnapshot = path.join(dir, 'write-failures.jsonl.processing-broken');
  fs.mkdirSync(badSnapshot, { recursive: true });

  const r = store.replayWriteFailures();
  assert.equal(r.replayed, 1, '能读的那条要恢复');
  assert.equal(r.unreadable, 1, '读失败的快照要计入 unreadable');
  assert.ok(fs.existsSync(badSnapshot), '读失败的快照必须保留，不能删');
  cleanup(dir);
});

test('dry-run 与 apply 对重复 id 的计数一致', () => {
  const { dir, store } = freshStore();
  const row = { id: 'dup-1', t: Date.now(), k: 'g:1', kind: 'msg', text: '同一条', s: 1 };
  // 两个快照里放同一个 id
  for (const name of ['write-failures.jsonl.processing', 'write-failures.jsonl.processing-2']) {
    fs.writeFileSync(
      path.join(dir, name),
      JSON.stringify({ at: Date.now(), phase: 'event', id: 'dup-1', row, error: 'x' }) + '\n',
      'utf8',
    );
  }
  const dry = store.replayWriteFailures({ dryRun: true });
  const applied = store.replayWriteFailures();
  assert.equal(dry.replayed, applied.replayed, '预览与实际必须一致');
  assert.equal(applied.replayed, 1, '同一个 id 只该恢复一次');
  cleanup(dir);
});

test('故障风暴下失败清单有上限，不会无限增长', () => {
  const { dir, store } = freshStore();
  fs.rmSync(path.join(dir, 'events'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'events'), 'blocked');
  // 模拟大量失败（超过上限）
  for (let i = 0; i < 10500; i += 1) {
    store.appendEvent({ t: Date.now(), k: 'g:1', kind: 'msg', text: `消息${i}`, s: 1 });
  }
  const failFile = path.join(dir, 'write-failures.jsonl');
  const lines = fs.existsSync(failFile) ? fs.readFileSync(failFile, 'utf8').split('\n').filter(Boolean).length : 0;
  assert.ok(lines <= 10000, `清单行数应被限制在 10000 以内，实际 ${lines}`);
  assert.equal(store.stats().writeFailures, 10500, '计数仍然准确（只是不记明细）');
  cleanup(dir);
});

test('长消息恢复后内容完整（不能截断）', () => {
  const { dir, store } = freshStore();
  fs.rmSync(path.join(dir, 'events'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'events'), 'blocked');
  const longText = '长'.repeat(300);
  store.appendEvent({ t: Date.now(), k: 'g:1', kind: 'msg', text: longText, s: 2 });
  fs.unlinkSync(path.join(dir, 'events'));
  const r = store.replayWriteFailures();
  assert.equal(r.replayed, 1);
  const evFile = path.join(dir, 'events', `${day()}.jsonl`);
  const row = JSON.parse(fs.readFileSync(evFile, 'utf8').trim().split('\n')[0]);
  assert.equal(row.text.length, 300, '恢复的必须是原文，200 字截断会丢内容');
  assert.equal(row.text, longText);
  cleanup(dir);
});

test('溢出计数会持久化：新 store 仍知道丢了多少条', () => {
  const { dir, store } = freshStore();
  // 主清单 2 条 + 溢出计数 5 → 总数应为 7
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    '{}\n{}\n',
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl.overflow'), '5', 'utf8');
  void store;
  // 直接用顶部 import 的 createMemoryStore 重建实例（触发计数初始化）
  const s2 = createMemoryStore({ dir });
  assert.equal(s2.stats().writeFailures, 7, '2 条明细 + 5 条溢出');
  cleanup(dir);
});

test('不可读快照会出现在 stats.unreadableSnapshots 里', () => {
  const { dir, store } = freshStore();
  // 用目录冒充不可读快照
  fs.mkdirSync(path.join(dir, 'write-failures.jsonl.processing-broken'), { recursive: true });
  const st = store.stats();
  assert.equal(st.unreadableSnapshots, 1, 'health 必须能提示「有一份看不清的待恢复数据」');
  cleanup(dir);
});

test('旧格式迁移：给失败记录补 id、给归档行补 srcDay', () => {
  const { dir, store } = freshStore();
  // 旧格式失败记录：没有 id
  const oldRow = { t: Date.now(), k: 'g:1', kind: 'msg', text: '旧的', s: 1 };
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', row: oldRow, error: 'old' }) + '\n',
    'utf8',
  );
  // 旧格式归档行：没有 srcDay
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const oldArchiveRow = { t: Date.now() - 86400000, k: 'g:1', kind: 'msg', text: '归档旧行', s: 1 };
  fs.writeFileSync(
    path.join(dir, 'events-archive', '2026-10.jsonl'),
    JSON.stringify(oldArchiveRow) + '\n',
    'utf8',
  );

  // 预览不改数据
  const preview = store.migrateLegacyRecords({ dryRun: true });
  assert.equal(preview.failureIdsAdded, 1);
  assert.equal(preview.archiveSrcDaysAdded, 1);
  assert.ok(!fs.readFileSync(path.join(dir, 'write-failures.jsonl'), 'utf8').includes('"id"'), 'dry-run 不能写');

  // 真正迁移
  const applied = store.migrateLegacyRecords();
  assert.equal(applied.failureIdsAdded, 1);
  assert.equal(applied.archiveSrcDaysAdded, 1);
  const migratedFailure = JSON.parse(fs.readFileSync(path.join(dir, 'write-failures.jsonl'), 'utf8').trim());
  assert.ok(migratedFailure.row.id, '失败记录要有 id');
  assert.equal(migratedFailure.id, migratedFailure.row.id, '外层 id 也要同步');
  const migratedArchive = JSON.parse(fs.readFileSync(path.join(dir, 'events-archive', '2026-10.jsonl'), 'utf8').trim());
  assert.ok(migratedArchive.srcDay, '归档行要有 srcDay');

  // 再跑一次幂等
  const again = store.migrateLegacyRecords();
  assert.equal(again.failureIdsAdded, 0);
  assert.equal(again.archiveSrcDaysAdded, 0);
  cleanup(dir);
});

test('迁移后的旧记录能被 replay 正常恢复', () => {
  const { dir, store } = freshStore();
  const oldRow = { t: Date.now(), k: 'g:1', kind: 'msg', text: '迁移后要恢复', s: 1 };
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', row: oldRow, error: 'old' }) + '\n',
    'utf8',
  );
  // 迁移前：无 id → 会被 quarantine
  const before = store.replayWriteFailures();
  assert.equal(before.quarantined, 1, '无 id 的旧记录先被隔离（前提）');

  // 重置场景：放回旧记录并迁移，再 replay
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', row: { ...oldRow, text: '迁移后要恢复2' }, error: 'old' }) + '\n',
    'utf8',
  );
  store.migrateLegacyRecords();
  const after = store.replayWriteFailures();
  assert.equal(after.replayed, 1, '迁移后应该能恢复');
  cleanup(dir);
});

test('crossSessionPolicy=isolated 时只检索当前会话', () => {
  const { dir, store } = freshStore();
  const now = Date.now();
  store.appendEvent({ t: now, k: 'group:111', kind: 'msg', who: 'A', text: '群里的秘密约定', s: 2 });
  store.appendEvent({ t: now, k: 'private:222', kind: 'msg', who: 'B', text: '私聊的秘密约定', s: 2 });

  // 默认 open：两个会话都能搜到
  const openHits = store.search('秘密约定', { days: 30 });
  assert.ok(openHits.length >= 2, '默认跨会话，应该两条都能搜到');

  // isolated：只搜当前 key
  const scoped = store.search('秘密约定', { days: 30, key: 'group:111' });
  assert.ok(scoped.every((h) => !String(h.text).includes('私聊')), '不能返回私聊内容');
  assert.ok(scoped.some((h) => String(h.text).includes('群里')), '当前会话的内容要能搜到');
  cleanup(dir);
});

test('replay 后 overflow 计数一致：当前 store / 重启 store / 文件三方对齐', () => {
  const { dir, store } = freshStore();
  // 2 条明细 + 5 条溢出
  const rows = [
    JSON.stringify({ at: Date.now(), phase: 'event', id: 'a1', row: { id: 'a1', t: Date.now(), k: 'g:1', kind: 'msg', text: '一', s: 1 }, error: 'x' }),
    JSON.stringify({ at: Date.now(), phase: 'event', id: 'a2', row: { id: 'a2', t: Date.now(), k: 'g:1', kind: 'msg', text: '二', s: 1 }, error: 'x' }),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl'), rows, 'utf8');
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl.overflow'), '5', 'utf8');

  const before = store.stats();
  assert.equal(before.pendingRecoverable, 2, '可恢复明细应是 2');
  assert.equal(before.unrecoverableOverflow, 5, '不可恢复溢出应是 5');
  assert.equal(before.writeFailures, 7, '总和 7');

  const r = store.replayWriteFailures();
  assert.equal(r.replayed, 2, '两条明细恢复');

  const after = store.stats();
  assert.equal(after.pendingRecoverable, 0, '明细已恢复');
  assert.equal(after.unrecoverableOverflow, 5, '溢出仍然不可恢复，必须保留');
  assert.equal(after.writeFailures, 5, '当前 store 不能显示 0');

  // 重启后必须看到同一个数
  const restarted = createMemoryStore({ dir });
  const rs = restarted.stats();
  assert.equal(rs.writeFailures, 5, '重启后仍是 5（不能回退成 0 或 7）');
  assert.equal(rs.pendingRecoverable, 0);
  assert.equal(rs.unrecoverableOverflow, 5);
  assert.equal(fs.readFileSync(path.join(dir, 'write-failures.jsonl.overflow'), 'utf8').trim(), '5');
  cleanup(dir);
});

test('overflow 批量累加：不是每条都写盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  // 先塞满明细（10000 行），再创建 store —— 这样计数初始化时才读得到
  const lines = [];
  for (let i = 0; i < 10000; i += 1) {
    lines.push(JSON.stringify({ at: Date.now(), phase: 'event', id: `x${i}`, row: { id: `x${i}`, t: Date.now(), k: 'g:1', kind: 'msg', text: 'x', s: 1 }, error: 'x' }));
  }
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl'), lines.join('\n') + '\n', 'utf8');
  // 再让事件写入持续失败
  fs.rmSync(path.join(dir, 'events'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'events'), 'blocked');
  const store = createMemoryStore({ dir });
  // 制造 150 次溢出（超过 100 的批量阈值）
  for (let i = 0; i < 150; i += 1) {
    store.appendEvent({ t: Date.now(), k: 'g:1', kind: 'msg', text: `溢出${i}`, s: 1 });
  }
  const st = store.stats(); // stats 会 flush
  assert.ok(st.unrecoverableOverflow >= 150, `溢出计数应至少 150，实际 ${st.unrecoverableOverflow}`);
  cleanup(dir);
});

test('isolated 时摘要也不泄漏（私聊内容只在日摘要里）', () => {
  const { dir, store } = freshStore();
  const now = Date.now();
  const yesterday = now - 86400000;
  // 私聊消息只写进事件，随后被压成日摘要
  store.appendEvent({ t: yesterday, k: 'private:222', kind: 'msg', who: 'B', text: '珊瑚的事情只说给一个人听', s: 2 });
  // 强制生成摘要（超过保留阈值才会进 lines）
  store.ensureConsolidation({ now });
  // 群会话做 isolated 搜索：不能通过「日摘要」把私聊内容捞出来
  const hits = store.search('珊瑚', { key: 'group:111', days: 30 });
  const leaked = hits.filter((h) => String(h.text).includes('珊瑚'));
  assert.equal(leaked.length, 0, `isolated 下不能通过摘要拿到私聊内容，实际命中 ${leaked.length} 条`);
  cleanup(dir);
});

test('overflow 用追加日志：崩溃不会丢已落盘的计数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  // 直接写追加日志格式（每行一个 1）
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl.overflow'), '1\n1\n1\n', 'utf8');
  const store = createMemoryStore({ dir });
  assert.equal(store.stats().unrecoverableOverflow, 3, '三行 1 应读成 3');
  // 再追加两条
  // 模拟崩溃：不调用 stats，直接重建
  fs.appendFileSync(path.join(dir, 'write-failures.jsonl.overflow'), '1\n1\n', 'utf8');
  const store2 = createMemoryStore({ dir });
  assert.equal(store2.stats().unrecoverableOverflow, 5, '崩溃后已落盘的计数必须还在');
  cleanup(dir);
});

test('重复跑 migrate 不能把失败清单删掉', () => {
  const { dir, store } = freshStore();
  const oldRow = { t: Date.now(), k: 'g:1', kind: 'msg', text: '旧记录', s: 1 };
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', row: oldRow, error: 'old' }) + '\n',
    'utf8',
  );
  const first = store.migrateLegacyRecords();
  assert.equal(first.failureIdsAdded, 1);
  assert.ok(fs.existsSync(path.join(dir, 'write-failures.jsonl')), '第一次迁移后清单必须还在');

  const second = store.migrateLegacyRecords();
  assert.equal(second.failureIdsAdded, 0, '第二次没有可迁移的' );
  assert.ok(fs.existsSync(path.join(dir, 'write-failures.jsonl')), '第二次迁移不能删掉整份清单');
  const linesAfter = fs.readFileSync(path.join(dir, 'write-failures.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(linesAfter.length, 1, '记录应该还在');
  cleanup(dir);
});

test('overflow 旧数字格式后继续追加不会读错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  // 旧格式：纯数字 "5"（无换行）
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl.overflow'), '5', 'utf8');
  const store = createMemoryStore({ dir });
  assert.equal(store.stats().unrecoverableOverflow, 5, '旧格式应读成 5');
  // 再追加一条（新格式）
  fs.appendFileSync(path.join(dir, 'write-failures.jsonl.overflow'), '1\n', 'utf8');
  const store2 = createMemoryStore({ dir });
  assert.equal(store2.stats().unrecoverableOverflow, 6, '5 + 1 应该是 6，不是 51');
  cleanup(dir);
});

test('迁移归档时不能覆盖期间新归档的事件', () => {
  const { dir, store } = freshStore();
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const archFile = path.join(dir, 'events-archive', '2026-10.jsonl');
  const oldRow = { t: Date.now() - 86400000, k: 'g:1', kind: 'msg', text: '旧归档行', s: 1 };
  fs.writeFileSync(archFile, JSON.stringify(oldRow) + '\n', 'utf8');
  const r = store.migrateLegacyRecords();
  assert.equal(r.archiveSrcDaysAdded, 1);
  // 迁移后归档文件必须还在且有内容
  assert.ok(fs.existsSync(archFile), '归档文件必须还在');
  const rows = fs.readFileSync(archFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(rows.length, 1, '归档行不能丢');
  const parsed = JSON.parse(rows[0]);
  assert.ok(parsed.srcDay, '应该补上了 srcDay');
  cleanup(dir);
});

test('isolated 时摘要按行过滤：群聊会话看不到混在同一天的私聊行', () => {
  const { dir, store } = freshStore();
  const now = Date.now();
  const y = now - 86400000;
  store.appendEvent({ t: y, k: 'group:111', kind: 'msg', who: 'A', text: '群里的珊瑚讨论', s: 2 });
  store.appendEvent({ t: y + 1000, k: 'private:222', kind: 'msg', who: 'B', text: '私聊里的珊瑚秘密', s: 2 });
  store.ensureConsolidation({ now });
  // 摘要已经生成且混了两个会话
  const hits = store.search('珊瑚', { key: 'group:111', days: 30 });
  const leaked = hits.filter((h) => String(h.text).includes('私聊里的珊瑚秘密'));
  assert.equal(leaked.length, 0, '行级过滤必须挡住私聊行');
  const groupHits = hits.filter((h) => String(h.text).includes('群里的珊瑚讨论'));
  assert.ok(groupHits.length > 0, '当前会话的内容应该能搜到');
  cleanup(dir);
});

test('overflow 日志会自动压缩：1000 次追加后行数回到上限内', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  // 先塞满明细（10000 行），让 writeFailureCount 初始就超限
  const detailLines = [];
  for (let i = 0; i < 10000; i += 1) {
    detailLines.push(JSON.stringify({ at: Date.now(), phase: 'event', id: `x${i}`, row: { id: `x${i}`, t: Date.now(), k: 'g:1', kind: 'msg', text: 'x', s: 1 }, error: 'x' }));
  }
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl'), detailLines.join('\n') + '\n', 'utf8');
  // 再塞 6000 行 overflow（已超过 MAX_OVERFLOW_LINES=5000）
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl.overflow'), '1\n'.repeat(6000), 'utf8');
  // 让事件持续写失败
  fs.rmSync(path.join(dir, 'events'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'events'), 'blocked');
  const store = createMemoryStore({ dir });
  // 制造 1000 次溢出追加（第 1000 次会触发 compact 检查）
  for (let i = 0; i < 1000; i += 1) {
    store.appendEvent({ t: Date.now(), k: 'g:1', kind: 'msg', text: `溢出${i}`, s: 1 });
  }
  const overflowFile = path.join(dir, 'write-failures.jsonl.overflow');
  const lineCount = fs.readFileSync(overflowFile, 'utf8').split('\n').filter(Boolean).length;
  assert.ok(lineCount <= 5001, `压缩后行数应 <=5001，实际 ${lineCount}`);
  // 计数语义不变：6000 + 1000
  assert.equal(store.stats().unrecoverableOverflow, 7000, '压缩不能改变总数');
  cleanup(dir);
});

test('周摘要也按行过滤：群会话看不到压进周要点的私聊行', () => {
  const { dir, store } = freshStore();
  const now = Date.now();
  // 必须放在「上一个完整周」：ensureWeekNotes 会跳过当前周
  const lastWeek = now - 10 * 86400000;
  // 造够事件数，确保日摘要不被 summaryMinEvents 跳过、能进入周压缩
  for (let i = 0; i < 4; i += 1) {
    store.appendEvent({ t: lastWeek + i * 1000, k: 'group:111', kind: 'msg', who: 'A', text: `群里的珊瑚讨论${i}`, s: 2 });
  }
  store.appendEvent({ t: lastWeek + 5000, k: 'private:222', kind: 'msg', who: 'B', text: '私聊里的珊瑚秘密', s: 2 });
  store.ensureConsolidation({ now });
  // 前提：周要点确实生成了
  const weekDir = path.join(dir, 'weeks');
  const weekFiles = fs.existsSync(weekDir) ? fs.readdirSync(weekDir).filter((f) => f.endsWith('.json')) : [];
  assert.ok(weekFiles.length > 0, '应该生成了周要点（否则这条测试没覆盖周层）');
  const hits = store.search('珊瑚', { key: 'group:111', days: 60 });
  const leaked = hits.filter((h) => String(h.text).includes('私聊里的珊瑚秘密'));
  assert.equal(leaked.length, 0, '周/月层也不能泄漏私聊内容');
  cleanup(dir);
});
test('旧摘要没有 k 时 isolated 必须 fail-closed（不能默认放行）', () => {
  const { dir, store } = freshStore();
  const now = Date.now();
  // 直接构造一份旧格式日摘要：顶层 keys 含两个会话，但行没有 k
  const day = new Date(now - 86400000).toLocaleDateString('en-CA');
  fs.mkdirSync(path.join(dir, 'days'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'days', `${day}.json`),
    JSON.stringify({
      day,
      ts: now - 86400000,
      count: 2,
      keys: ['group:111', 'private:222'],
      lines: [{ t: '私聊 B：旧格式里的珊瑚秘密', s: 2 }],
      tiers: [0, 0, 2, 0],
    }),
    'utf8',
  );
  const hits = store.search('珊瑚', { key: 'group:111', days: 30 });
  const leaked = hits.filter((h) => String(h.text).includes('旧格式里的珊瑚秘密'));
  assert.equal(leaked.length, 0, '来源未知的旧行在 isolated 下不能返回');
  cleanup(dir);
});

test('迁移快照 .migrate-* 会被 pending 统计看到', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-snap-'));
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl.migrate-123-abc'), JSON.stringify({ at: 1, phase: 'event', id: 'x', row: { id: 'x', t: 1, k: 'g:1', kind: 'msg', text: 'x', s: 1 }, error: 'e' }) + '\n', 'utf8');
  const store = createMemoryStore({ dir });
  assert.equal(store.stats().pendingRecoverable, 1, '迁移快照里的记录必须被统计到（否则数据藏在磁盘上没人知道）');
  cleanup(dir);
});



test('归档快照不会被 replay 当失败记录隔离，能恢复回归档', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-snap-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const snap = path.join(dir, 'events-archive', '2026-09.jsonl.migrate-123');
  const ev = { t: Date.now(), k: 'g:1', kind: 'msg', who: 'A', text: '归档里的事件', s: 2 };
  fs.writeFileSync(snap, JSON.stringify(ev) + '\n', 'utf8');
  const store = createMemoryStore({ dir });
  // replay 不能碰归档快照
  store.replayWriteFailures();
  assert.ok(fs.existsSync(snap), '归档快照不能被 replay 删掉');
  assert.equal(store.stats().quarantined, 0, '归档事件不能被隔离成坏行');
  // 专用恢复器把它并回归档文件
  const r = store.recoverArchiveSnapshots();
  assert.equal(r.restored, 1);
  assert.ok(!fs.existsSync(snap), '恢复后快照应删除');
  const archFile = path.join(dir, 'events-archive', '2026-09.jsonl');
  assert.ok(fs.existsSync(archFile), '归档文件应被恢复');
  const rows = fs.readFileSync(archFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(rows.length, 1, '事件数量正确');
  assert.ok(JSON.parse(rows[0]).text.includes('归档里的事件'));
  cleanup(dir);
});

test('归档快照恢复用 append，不会覆盖并发新建的归档', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-snap2-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const archFile = path.join(dir, 'events-archive', '2026-09.jsonl');
  const newEv = { t: Date.now(), k: 'g:1', kind: 'msg', who: 'B', text: '并发新事件', s: 1 };
  fs.writeFileSync(archFile, JSON.stringify(newEv) + '\n', 'utf8');
  const snap = path.join(dir, 'events-archive', '2026-09.jsonl.migrate-456');
  const oldEv = { t: Date.now() - 1000, k: 'g:1', kind: 'msg', who: 'A', text: '快照里的事件', s: 1 };
  fs.writeFileSync(snap, JSON.stringify(oldEv) + '\n', 'utf8');
  const store = createMemoryStore({ dir });
  store.recoverArchiveSnapshots();
  const rows = fs.readFileSync(archFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(rows.length, 2, '并发新事件 + 快照事件都要在（append 不是覆盖）');
  const texts = rows.map((r) => JSON.parse(r).text);
  assert.ok(texts.includes('并发新事件'));
  assert.ok(texts.includes('快照里的事件'));
  cleanup(dir);
});

test('检索历史按会话隔离：群会话看不到私聊的查询词', () => {
  const { dir, store } = freshStore();
  const now = Date.now();
  store.appendEvent({ t: now, k: 'group:111', kind: 'msg', who: 'A', text: '群里的公开消息', s: 2 });
  store.appendEvent({ t: now, k: 'private:222', kind: 'msg', who: 'B', text: '私聊绝密内容', s: 2 });
  // 私聊会话做一次检索（会写 recall-log）
  store.search('私聊绝密', { key: 'private:222', days: 30 });
  // 群会话看自省：不能看到私聊的查询词
  const inspect = store.inspect({ recallLimit: 10, sourceKey: 'group:111' });
  const recalls = inspect.recentRecalls || [];
  const leaked = recalls.filter((x) => String(x.q || '').includes('私聊绝密'));
  assert.equal(leaked.length, 0, '群会话不能看到私聊的检索词（这是内容泄漏）');
  cleanup(dir);
});

test('归档恢复是幂等的：append 成功但 unlink 崩溃，重跑不重复写入', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-idem-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const snap = path.join(dir, 'events-archive', '2026-09.jsonl.migrate-999');
  const rows = [
    { id: 'ev-1', t: 1, k: 'g:1', kind: 'msg', who: 'A', text: '归档事件一', s: 1 },
    { id: 'ev-2', t: 2, k: 'g:1', kind: 'msg', who: 'A', text: '归档事件二', s: 1 },
  ];
  fs.writeFileSync(snap, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const store = createMemoryStore({ dir });
  const target = path.join(dir, 'events-archive', '2026-09.jsonl');
  // 模拟「append 成功、unlink 之前崩溃」的窗口
  const origUnlink = fs.unlinkSync;
  fs.unlinkSync = () => { const e = new Error('EIO: i/o error'); e.code = 'EIO'; throw e; };
  let first;
  try { first = store.recoverArchiveSnapshots(); } finally { fs.unlinkSync = origUnlink; }
  assert.equal(first.restored, 0, 'unlink 失败时不能算恢复成功');
  assert.ok(fs.existsSync(snap), '崩溃后快照必须保留');
  assert.equal(countLines(target), 2, '首次 append 已写入 2 条');
  // 崩溃重跑相当于「新进程」：残留锁里的 pid 已经死了，应该立刻接管，不用干等 5 分钟。
  const lockFile = path.join(dir, 'events-archive', '.recover.lock');
  if (fs.existsSync(lockFile)) {
    const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    info.pid = 999999;
    fs.writeFileSync(lockFile, JSON.stringify(info), 'utf8');
  }
  // 崩溃后重跑：只能补缺的，不能把整份快照再写一遍
  const second = store.recoverArchiveSnapshots();
  assert.equal(second.restored, 1);
  assert.equal(second.duplicates, 2, '两条都已存在，应识别为重复');
  assert.equal(second.lines, 0, '没有新行要写');
  const after = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean);
  assert.equal(after.length, 2, '重跑不能产生重复事件');
  assert.deepEqual(after.map((l) => JSON.parse(l).id), ['ev-1', 'ev-2'], '事件顺序与内容保持');
  assert.ok(!fs.existsSync(snap), '第二次成功后才删快照');
  cleanup(dir);
});

test('归档恢复对没有 id 的旧行用「时间+文本」指纹去重', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-idem2-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const legacy = [
    { t: 1000, k: 'g:1', kind: 'msg', who: 'A', text: '旧格式事件', s: 1 },
    { t: 2000, k: 'g:1', kind: 'msg', who: 'A', text: '旧格式事件二', s: 1 },
  ];
  const target = path.join(dir, 'events-archive', '2026-08.jsonl');
  // 目标里已经有第一条（上次 append 了一半）
  fs.writeFileSync(target, JSON.stringify(legacy[0]) + '\n', 'utf8');
  const snap = path.join(dir, 'events-archive', '2026-08.jsonl.migrate-777');
  fs.writeFileSync(snap, legacy.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const store = createMemoryStore({ dir });
  const r = store.recoverArchiveSnapshots();
  assert.equal(r.duplicates, 1, '已存在的那条算重复');
  assert.equal(r.lines, 1, '只补写缺的那条');
  const rows = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 2, '不能出现重复行');
  assert.deepEqual(rows.map((x) => x.text), ['旧格式事件', '旧格式事件二']);
  cleanup(dir);
});

test('归档恢复 dry-run 只报告不写盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-dry-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const snap = path.join(dir, 'events-archive', '2026-07.jsonl.migrate-1');
  fs.writeFileSync(snap, JSON.stringify({ id: 'e1', t: 1, text: 'x' }) + '\n', 'utf8');
  const store = createMemoryStore({ dir });
  const r = store.recoverArchiveSnapshots({ dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.restored, 1);
  assert.equal(r.lines, 1);
  assert.ok(fs.existsSync(snap), 'dry-run 不能删快照');
  assert.ok(!fs.existsSync(path.join(dir, 'events-archive', '2026-07.jsonl')), 'dry-run 不能写归档');
  cleanup(dir);
});

test('自省在 isolated 下只返回会话级统计，不下发全局配置与路径', () => {
  const { dir, store } = freshStore();
  const now = Date.now();
  store.appendEvent({ t: now, k: 'group:111', kind: 'msg', who: 'A', text: '群里的消息一', s: 1 });
  store.appendEvent({ t: now, k: 'group:111', kind: 'msg', who: 'A', text: '群里的消息二', s: 2 });
  store.appendEvent({ t: now, k: 'private:222', kind: 'msg', who: 'B', text: '私聊里的消息', s: 3 });
  const scoped = store.inspect({ recallLimit: 10, sourceKey: 'group:111' });
  assert.equal(scoped.scope, 'session', '必须标明这是会话级视图');
  assert.equal(scoped.usage, null, '工具使用量是全局的，不下发');
  assert.equal(scoped.stats.scope, 'session');
  assert.equal(scoped.stats.events, 2, '只数本会话的事件（不能把私聊的那条也数进来）');
  assert.equal(scoped.stats.root, undefined, '不能下发记忆库路径');
  assert.equal(scoped.stats.config, undefined, '不能下发整份配置');
  assert.equal(scoped.stats.pendingRecoverable, undefined, '待恢复计数属于管理面');
  assert.deepEqual(scoped.omitted.sort(), ['config', 'globalStats', 'paths', 'pendingFailures', 'usage']);
  // 全局视图不受影响
  const global = store.inspect({ recallLimit: 10 });
  assert.equal(global.scope, 'global');
  assert.equal(global.stats.events, 3);
  assert.ok(global.stats.root, '全局视图仍然带路径（控制台要用）');
  cleanup(dir);
});

// ── 归档去重键的唯一性 ─────────────────────────────────────────────
// 旧键是「t + text.slice(0,40)」：同一毫秒、前 40 字相同的两条不同消息会被判成
// 同一条，恢复时静默少恢复一条——旧库恰恰是最需要恢复、又没有 id 的数据。

test('归档恢复不会把前缀相同的不同消息当成重复丢掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-key-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const head = 'x'.repeat(40); // 前 40 字完全相同
  const evA = { t: 1700000000000, k: 'g:1', kind: 'msg', who: 'A', text: head + '结尾甲', s: 1 };
  const evB = { t: 1700000000000, k: 'g:1', kind: 'msg', who: 'A', text: head + '结尾乙', s: 1 };
  const target = path.join(dir, 'events-archive', '2026-01.jsonl');
  fs.writeFileSync(target, JSON.stringify(evA) + '\n', 'utf8'); // 目标只有 A
  const snap = path.join(dir, 'events-archive', '2026-01.jsonl.migrate-1');
  fs.writeFileSync(snap, JSON.stringify(evA) + '\n' + JSON.stringify(evB) + '\n', 'utf8');
  const store = createMemoryStore({ dir });
  const r = store.recoverArchiveSnapshots();
  assert.equal(r.duplicates, 1, '只有 A 是真的重复');
  assert.equal(r.lines, 1, 'B 必须被补写回来（不能因为前 40 字相同就丢掉）');
  const rows = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 2, '归档里应有两条不同消息');
  const texts = rows.map((x) => x.text);
  assert.ok(texts.includes(head + '结尾甲'), 'A 要保留');
  assert.ok(texts.includes(head + '结尾乙'), 'B 不能被误判成重复');
  cleanup(dir);
});

test('归档恢复对合法的完全重复行按次数补写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-dup-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const ev = { t: 1700000001000, k: 'g:1', kind: 'msg', who: 'A', text: '同一句话说了两次', s: 1 };
  const line = JSON.stringify(ev);
  const target = path.join(dir, 'events-archive', '2026-02.jsonl');
  fs.writeFileSync(target, line + '\n', 'utf8');
  const snap = path.join(dir, 'events-archive', '2026-02.jsonl.migrate-2');
  fs.writeFileSync(snap, line + '\n' + line + '\n', 'utf8');
  const store = createMemoryStore({ dir });
  const r = store.recoverArchiveSnapshots();
  assert.equal(r.duplicates, 1, '目标里已有一次，只能抵消一次');
  assert.equal(r.lines, 1, '第二次仍然要补回来（它是合法重复，不是崩溃重复）');
  assert.equal(countLines(target), 2);
  cleanup(dir);
});

test('归档恢复拿不到锁时不执行，也不会重复写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-lock-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const snap = path.join(dir, 'events-archive', '2026-03.jsonl.migrate-3');
  fs.writeFileSync(snap, JSON.stringify({ t: 1, k: 'g:1', text: 'x' }) + '\n', 'utf8');
  // 模拟另一个恢复进程正持锁：pid 必须是个活着的进程，否则会被判定为崩溃残留接管掉
  fs.writeFileSync(
    path.join(dir, 'events-archive', '.recover.lock'),
    JSON.stringify({ owner: 'other-process', pid: process.pid, at: Date.now() }),
    'utf8',
  );
  const store = createMemoryStore({ dir });
  const r = store.recoverArchiveSnapshots();
  assert.equal(r.locked, true, '必须明确报告被锁挡住');
  assert.equal(r.restored, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'events-archive', '2026-03.jsonl')), '拿不到锁就不能写归档');
  assert.ok(fs.existsSync(snap), '快照必须原样保留');
  // dry-run 只读，不受锁影响
  const dry = store.recoverArchiveSnapshots({ dryRun: true });
  assert.equal(dry.locked, undefined);
  assert.equal(dry.lines, 1);
  cleanup(dir);
});

test('会话级统计把归档事件也算进去，不只是活动日文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-stats-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'events-archive', '2026-01.jsonl'),
    JSON.stringify({ t: 1767225600000, k: 'group:111', kind: 'msg', s: 1, srcDay: '2026-01-05', text: '归档期的群消息' }) + '\n'
    + JSON.stringify({ t: 1767225600000, k: 'private:222', kind: 'msg', s: 1, srcDay: '2026-01-05', text: '归档期的私聊消息' }) + '\n',
    'utf8',
  );
  const store = createMemoryStore({ dir });
  store.appendEvent({ t: Date.now(), k: 'group:111', kind: 'msg', who: 'A', text: '今天的小组消息', s: 1 });
  const scoped = store.inspect({ recallLimit: 5, sourceKey: 'group:111' });
  assert.equal(scoped.stats.events, 2, '归档事件 + 活动日事件都要算，且不混入私聊');
  assert.equal(scoped.stats.archivedIncluded, true);
  assert.equal(scoped.stats.activeOnly, false);
  assert.ok(scoped.stats.eventDays >= 2, '归档那天和今天都要算进覆盖天数');
  assert.ok(scoped.stats.firstDay <= '2026-01-05', 'firstDay 要覆盖到归档期');
  cleanup(dir);
});

test('自省响应带时间口径标记，避免把序数当时间戳', () => {
  const { dir, store } = freshStore();
  store.appendEvent({ t: Date.now(), k: 'group:111', kind: 'msg', who: 'A', text: '群消息', s: 1 });
  const scoped = store.inspect({ recallLimit: 5, sourceKey: 'group:111' });
  assert.equal(scoped.clock, 'session-rank', 'isolated 下要声明序数口径');
  assert.ok(String(scoped.clockNote || '').includes('序数'), '要有一句人话解释');
  const global = store.inspect({ recallLimit: 5 });
  assert.equal(global.clock, 'epoch-ms', '全局视图仍是真实时间戳');
  cleanup(dir);
});

test('归档去重键对字段顺序不同、带不带 srcDay 都算同一行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-stable-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const target = path.join(dir, 'events-archive', '2026-04.jsonl');
  // 目标里是原始行（无 id、字段顺序 A）
  fs.writeFileSync(target, '{"t":1700000002000,"k":"g:1","kind":"msg","text":"同一条旧事件","s":1}\n', 'utf8');
  // 快照里同一行被迁移补了 srcDay，且字段顺序不同 → 仍然是同一条
  const snap = path.join(dir, 'events-archive', '2026-04.jsonl.migrate-4');
  fs.writeFileSync(
    snap,
    '{"s":1,"text":"同一条旧事件","kind":"msg","k":"g:1","srcDay":"2026-04-01","t":1700000002000}\n',
    'utf8',
  );
  const store = createMemoryStore({ dir });
  const r = store.recoverArchiveSnapshots();
  assert.equal(r.duplicates, 1, '字段顺序和 srcDay 不应影响同一行的判定');
  assert.equal(r.lines, 0, '同一行不能重复写入');
  assert.equal(countLines(target), 1);
  cleanup(dir);
});

// ── 归档目录 IO 错误：不能折叠成「没有快照」 ────────────────────────
// ENOENT 是正常空态（还没归档过）；EACCES/EPERM/ENOTDIR/EIO 说明目录读不到，
// 里面可能还有待恢复快照 —— 当成空数组就是 fail-open，健康页会假绿。

test('归档目录读不到时不能被当成没有快照', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-eacces-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'events-archive', '2026-05.jsonl.migrate-1'),
    JSON.stringify({ t: 1700000005000, k: 'g:1', text: '看不见的快照事件' }) + '\n',
    'utf8',
  );
  const store = createMemoryStore({ dir });
  const origReaddir = fs.readdirSync;
  // 只让归档目录读失败（别把 days/ 等其它目录也弄坏）
  fs.readdirSync = (p, ...rest) => {
    if (String(p).includes('events-archive')) {
      const e = new Error('EACCES: permission denied');
      e.code = 'EACCES';
      throw e;
    }
    return origReaddir(p, ...rest);
  };
  try {
    const st = store.stats();
    assert.ok(String(st.archiveSnapshotError || '').includes('EACCES'), '统计必须带上「读不到归档目录」');
    assert.equal(st.archiveSnapshots, 0);
    const r = store.recoverArchiveSnapshots();
    assert.ok(String(r.archiveDirError || '').includes('EACCES'), '恢复器要报告目录读不到');
    assert.equal(r.noSnapshots, undefined, '读不到 ≠ 没有快照，不能返回 noSnapshots');
    assert.ok(fs.existsSync(path.join(dir, 'events-archive', '2026-05.jsonl.migrate-1')), '快照必须原样保留');
  } finally {
    fs.readdirSync = origReaddir;
  }
  cleanup(dir);
});

test('归档目录不存在仍是正常空态（ENOENT 不报警）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-none-'));
  const store = createMemoryStore({ dir });
  const st = store.stats();
  assert.equal(st.archiveSnapshotError, null, '全新库没有归档目录，不算错误');
  const r = store.recoverArchiveSnapshots();
  assert.equal(r.noSnapshots, true);
  cleanup(dir);
});

test('归档恢复写不进去时要报失败、保留快照并给出剩余数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-enospc-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const snap = path.join(dir, 'events-archive', '2026-06.jsonl.migrate-1');
  fs.writeFileSync(snap, JSON.stringify({ t: 1700000006000, k: 'g:1', text: '写不进去的事件' }) + '\n', 'utf8');
  const store = createMemoryStore({ dir });
  const origAppend = fs.appendFileSync;
  fs.appendFileSync = () => {
    const e = new Error('ENOSPC: no space left on device');
    e.code = 'ENOSPC';
    throw e;
  };
  let r;
  try {
    r = store.recoverArchiveSnapshots();
  } finally {
    fs.appendFileSync = origAppend;
  }
  assert.equal(r.failed, 1, '写失败必须计数，不能空 catch 吞掉');
  assert.equal(r.restored, 0);
  assert.equal(r.remaining, 1, '快照还在 —— CLI 要靠 remaining 决定退出码');
  assert.ok(String(r.errors[0] || '').includes('ENOSPC'), '错误要带原因');
  assert.ok(fs.existsSync(snap), '失败的快照必须保留');
  assert.equal(store.stats().archiveSnapshots, 1, '健康页还能看到这个快照');
  cleanup(dir);
});

test('目标归档瞬时读失败不能被当成空文件（否则重复写 + 删快照）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-target-eio-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const ev = { id: 'ev-1', t: 1700000007000, k: 'g:1', kind: 'msg', text: '已在归档里的事件', s: 1 };
  const target = path.join(dir, 'events-archive', '2026-07.jsonl');
  fs.writeFileSync(target, JSON.stringify(ev) + '\n', 'utf8');
  const snap = path.join(dir, 'events-archive', '2026-07.jsonl.migrate-1');
  fs.writeFileSync(snap, JSON.stringify(ev) + '\n', 'utf8');
  const store = createMemoryStore({ dir });
  // 只让「目标归档」的第一次读取抛瞬时 EIO
  const origRead = fs.readFileSync;
  let thrown = false;
  fs.readFileSync = (p, ...rest) => {
    if (!thrown && String(p) === target) {
      thrown = true;
      const e = new Error('EIO: i/o error');
      e.code = 'EIO';
      throw e;
    }
    return origRead(p, ...rest);
  };
  let r;
  try {
    r = store.recoverArchiveSnapshots();
  } finally {
    fs.readFileSync = origRead;
  }
  assert.equal(r.failed, 1, '读不出目标必须算失败');
  assert.equal(r.restored, 0, '不能报恢复成功');
  assert.ok(String(r.errors[0] || '').includes('EIO'), '错误要带原因');
  assert.equal(r.remaining, 1, '快照必须保留');
  assert.ok(fs.existsSync(snap), '快照不能被删');
  const rows = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean);
  assert.equal(rows.length, 1, '归档里不能出现重复的 ev-1');
  // 再跑一次（读恢复正常）→ 识别为重复，不写、不重复
  const again = store.recoverArchiveSnapshots();
  assert.equal(again.duplicates, 1);
  assert.equal(again.lines, 0);
  assert.equal(again.failed, 0);
  assert.equal(again.remaining, 0, '这次才算恢复完');
  assert.equal(countLines(target), 1, '归档仍然只有一条');
  assert.ok(!fs.existsSync(snap), '成功后快照删除');
  cleanup(dir);
});

test('isolated 检索不返回无来源事件，健康统计能看到它们的数量', () => {
  const { dir, store } = freshStore();
  const file = path.join(dir, 'events', `${day()}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = Date.now();
  // 无 k 的旧事件：无法证明属于群聊还是私聊
  fs.appendFileSync(file, JSON.stringify({ id: 'nok-1', t: now, kind: 'msg', who: 'A', text: '无来源旧私聊秘密珊瑚', s: 2 }) + '\n', 'utf8');
  fs.appendFileSync(file, JSON.stringify({ id: 'ok-1', t: now, k: 'group:111', kind: 'msg', who: 'A', text: '群里的珊瑚话题', s: 2 }) + '\n', 'utf8');
  const scoped = store.search('珊瑚', { key: 'group:111', days: 30 });
  const texts = scoped.map((h) => String(h.text));
  assert.ok(texts.some((t) => t.includes('群里的珊瑚话题')), '本会话事件照常命中');
  assert.ok(!texts.some((t) => t.includes('无来源旧私聊秘密珊瑚')), '无 k 事件不能出现在 isolated 检索里（fail-closed）');
  const open = store.search('珊瑚', { days: 30 });
  assert.ok(open.some((h) => String(h.text).includes('无来源旧私聊秘密珊瑚')), 'open 模式仍能检索到（行为没变）');
  assert.equal(store.stats().eventsWithoutSource, 1, '健康统计要报出无来源事件数，别让它悄悄变少');
  cleanup(dir);
});

test('eventsWithoutSource 把归档事件也算进去', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosrc-arch-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const store = createMemoryStore({ dir });
  store.appendEvent({ t: Date.now(), k: 'group:111', kind: 'msg', who: 'A', text: '活动日的群消息', s: 1 });
  // 归档期里一条没有 k 的旧事件
  fs.appendFileSync(
    path.join(dir, 'events-archive', '2026-02.jsonl'),
    JSON.stringify({ t: 1767225600000, kind: 'msg', who: 'B', text: '归档期无来源的私密珊瑚', s: 1, srcDay: '2026-02-01' }) + '\n',
    'utf8',
  );
  const st = store.stats();
  assert.equal(st.events, 1, '活动日事件数照旧');
  assert.equal(st.archivedEvents, 1, '归档事件数要单列');
  assert.equal(st.eventsWithoutSource, 1, '归档里的无来源事件必须算进「受影响的历史数据」');
  cleanup(dir);
});

test('memory-stats 在 isolated 下只返回会话统计（不含路径与配置）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'datas-scope-'));
  const isolated = createMemoryStore({ dir, config: { crossSessionPolicy: 'isolated' } });
  isolated.appendEvent({ t: Date.now(), k: 'group:111', kind: 'msg', who: 'A', text: '群消息', s: 1 });
  isolated.appendEvent({ t: Date.now(), k: 'private:222', kind: 'msg', who: 'B', text: '私聊消息', s: 1 });

  const call = async (store) => {
    let payload = null;
    const handled = await handleSocialV2MemoryApi({
      req: { method: 'GET', headers: {} },
      url: new URL('http://127.0.0.1/api/socialV2/memory-stats?key=group:111'),
      sendJson: (obj) => { payload = obj; },
      readBody: async () => ({}),
      memoryStore: store,
    });
    return { handled, payload };
  };

  const scoped = await call(isolated);
  assert.equal(scoped.handled, true);
  assert.equal(scoped.payload.scope, 'session', 'isolated 下必须标明会话级视图');
  assert.equal(scoped.payload.stats.events, 1, '只数本会话事件，不能暴露全库活动量');
  assert.equal(scoped.payload.stats.root, undefined, '不能把本机路径交给会话');
  assert.equal(scoped.payload.stats.config, undefined, '不能把整份配置交给会话');
  assert.equal(scoped.payload.stats.pendingRecoverable, undefined, '待恢复计数属于管理面');
  assert.ok(Array.isArray(scoped.payload.omitted) && scoped.payload.omitted.includes('globalStats'));

  // open 模式仍是全局管理视图（控制台/运维要用）
  const openStore = createMemoryStore({ dir });
  const open = await call(openStore);
  assert.equal(open.payload.scope, 'global');
  assert.ok(open.payload.stats.root, 'open 下仍带路径');
  assert.equal(open.payload.stats.events >= 2, true, 'open 下是全局事件数');
  cleanup(dir);
});

// ── 底层 IO 失败语义：ENOENT / 解析失败 / 暂时读不到必须分开 ────────
// 以前一次瞬时 EIO 会让 readProfile 返回空档案，写路径随后把空档案写回磁盘，
// 原档案被清空 —— 聊天一切正常，档案却悄悄没了。

test('档案读不到时严格读会抛错，且写档案被拒绝（不会清空原档案）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-eio-'));
  const profilePath = path.join(dir, 'profile.json');
  const original = {
    version: 3,
    people: {
      小明: {
        facts: [{ text: '不能丢的旧事实', createdAt: 1, confirmedAt: 1, count: 1 }],
        count: 1, firstSeen: 1, lastSeen: 1,
      },
    },
    threads: [], self: [], audit: [], updatedAt: 1,
  };
  fs.writeFileSync(profilePath, JSON.stringify(original), 'utf8');
  const store = createMemoryStore({ dir });
  assert.equal(Object.keys(store.readProfile({ strict: true }).people).length, 1);

  const origRead = fs.readFileSync;
  // 前两次读都失败：一次给严格读（应抛错），一次给降级读（应返回空档案）
  let failuresLeft = 2;
  fs.readFileSync = (p, ...rest) => {
    if (failuresLeft > 0 && String(p) === profilePath) {
      failuresLeft -= 1;
      const e = new Error('EIO: i/o error');
      e.code = 'EIO';
      throw e;
    }
    return origRead(p, ...rest);
  };
  try {
    assert.throws(() => store.readProfile({ strict: true }), /读取 profile\.json 失败/, '严格读必须抛错，不能返回空档案');
    // 非严格调用读不到 → 空档案，但写保护已点起
    const degraded = store.readProfile();
    assert.equal(Object.keys(degraded.people).length, 0, '降级读返回空档案（仅用于展示）');
    assert.equal(store.writeProfile(degraded), false, '写保护必须拒绝写回，否则就是清空原档案');
    assert.equal(store.readState().writable, false);
  } finally {
    fs.readFileSync = origRead;
  }
  const onDisk = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  assert.equal(onDisk.people['小明'].facts[0].text, '不能丢的旧事实', '原档案必须完好');
  // 权限恢复后自动解除写保护
  const recovered = store.readProfile({ strict: true });
  assert.equal(Object.keys(recovered.people).length, 1);
  assert.equal(store.readState().writable, true, '读取恢复后写保护自动解除');
  cleanup(dir);
});

test('档案 JSON 损坏时备份并拒绝写回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-corrupt-'));
  const profilePath = path.join(dir, 'profile.json');
  fs.writeFileSync(profilePath, '{ this is not json', 'utf8');
  const store = createMemoryStore({ dir });
  const degraded = store.readProfile();
  assert.equal(Object.keys(degraded.people).length, 0);
  assert.equal(store.readState().corrupt, true, '解析失败要暴露状态');
  assert.equal(store.writeProfile(degraded), false, '损坏后不能把空档案写回去');
  const backups = fs.readdirSync(dir).filter((n) => n.includes('.corrupt'));
  assert.equal(backups.length, 1, '坏文件必须先备份');
  // force 也允许显式覆盖（管理员修好后用）
  assert.equal(store.writeProfile({ people: {}, threads: [], self: [] }, { force: true }), true, 'force 允许显式覆盖');
  cleanup(dir);
});

test('活动日/归档事件读失败不写缓存：权限恢复后同一 store 能重新读到', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-eio-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const store = createMemoryStore({ dir });
  store.appendEvent({ t: Date.now(), k: 'g:1', kind: 'msg', text: '当天的事件', s: 1 });
  const dayFile = path.join(dir, 'events', `${day()}.jsonl`);
  const archiveFile = path.join(dir, 'events-archive', '2026-01.jsonl');
  fs.writeFileSync(archiveFile, JSON.stringify({ t: 1, k: 'g:1', kind: 'msg', text: '归档的事件', s: 1 }) + '\n', 'utf8');

  const origRead = fs.readFileSync;
  let dayThrown = false;
  let archThrown = false;
  fs.readFileSync = (p, ...rest) => {
    const file = String(p);
    if (!dayThrown && file === dayFile) {
      dayThrown = true;
      const e = new Error('EIO: i/o error'); e.code = 'EIO'; throw e;
    }
    if (!archThrown && file === archiveFile) {
      archThrown = true;
      const e = new Error('EIO: i/o error'); e.code = 'EIO'; throw e;
    }
    return origRead(p, ...rest);
  };
  try {
    assert.equal(store.search('当天的事件', { days: 30 }).length, 0, '这次确实读不到');
    const st1 = store.stats();
    assert.ok(st1.readErrors >= 1, '读失败必须登记到 stats');
    assert.ok(Array.isArray(st1.unreadableFiles) && st1.unreadableFiles.length >= 1);
  } finally {
    fs.readFileSync = origRead;
  }
  // 关键：同一个 store、文件 mtime 没变，恢复后必须能重新读到（缓存没被污染）
  assert.ok(store.search('当天的事件', { days: 30 }).length > 0, '读失败不能把空结果写进缓存');
  const st2 = store.stats();
  assert.equal(st2.archivedEvents, 1, '归档文件恢复后要能读到');
  assert.equal(st2.readErrors, 0, '读成功要清除失败登记');
  cleanup(dir);
});

test('memory-remember 在档案读不到时返回 503，且不写入任何东西', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-eio-'));
  const store = createMemoryStore({ dir });
  const profilePath = path.join(dir, 'profile.json');
  store.writeProfile({ people: { 小明: { facts: [{ text: '不能丢的旧事实', createdAt: 1, confirmedAt: 1, count: 1 }], count: 1, firstSeen: 1, lastSeen: 1 } }, threads: [], self: [] });

  const call = async (content) => {
    let payload = null;
    let status = 200;
    const handled = await handleSocialV2MemoryApi({
      req: { method: 'POST', headers: {} },
      url: new URL('http://127.0.0.1/api/socialV2/memory-remember'),
      sendJson: (obj, code) => { payload = obj; status = Number(code) || 200; },
      readBody: async () => ({ key: 'group:111', kind: 'person', name: '小明', content }),
      memoryStore: store,
      mergePersonFact, mergeThread, mergeSelfNote, verifyMemoryClaim,
      buildWriteScope, eventsVisibleToSession,
      archiveMemoryEventV3: () => {},
      redactKnownTokensOnly: (v) => String(v ?? ''),
    });
    return { handled, payload, status };
  };

  // 正常情况：能写入
  const ok = await call('正常写入的事实');
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.ok, true);

  // 档案读失败：必须 503，且磁盘上的档案不能被改动
  const origRead = fs.readFileSync;
  let thrown = false;
  fs.readFileSync = (p, ...rest) => {
    if (!thrown && String(p) === profilePath) {
      thrown = true;
      const e = new Error('EIO: i/o error'); e.code = 'EIO'; throw e;
    }
    return origRead(p, ...rest);
  };
  let failed;
  try {
    failed = await call('读失败时的新事实');
  } finally {
    fs.readFileSync = origRead;
  }
  assert.equal(failed.status, 503, '读不到档案要明确报 503，不能假装写成功');
  assert.equal(failed.payload.ok, false);
  const onDisk = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const facts = Object.values(onDisk.people).flatMap((v) => v.facts.map((f) => f.text));
  assert.ok(facts.includes('不能丢的旧事实'), '原事实必须还在');
  assert.ok(facts.includes('正常写入的事实'), '第一次正常写入的事实要在');
  assert.ok(!facts.includes('读失败时的新事实'), '读失败那次的写入不能落盘');
  cleanup(dir);
});

test('事件文件 statSync 失败也要登记（不能只修 readFileSync）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-eacces-'));
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const store = createMemoryStore({ dir });
  store.appendEvent({ t: Date.now(), k: 'g:1', kind: 'msg', text: '当天的事件', s: 1 });
  const dayFile = path.join(dir, 'events', `${day()}.jsonl`);
  const archiveFile = path.join(dir, 'events-archive', '2026-01.jsonl');
  fs.writeFileSync(archiveFile, JSON.stringify({ t: 1, k: 'g:1', kind: 'msg', text: '归档的事件', s: 1 }) + '\n', 'utf8');

  const origStat = fs.statSync;
  fs.statSync = (p, ...rest) => {
    const file = String(p);
    if (file === dayFile || file === archiveFile) {
      const e = new Error('EACCES: permission denied');
      e.code = 'EACCES';
      throw e;
    }
    return origStat(p, ...rest);
  };
  try {
    assert.equal(store.search('当天的事件', { days: 30 }).length, 0, 'stat 失败时这次确实读不到');
    const st = store.stats();
    assert.ok(st.readErrors >= 2, 'stat 失败必须登记，否则 health 会假绿');
    assert.ok(st.unreadableFiles.length >= 1);
    assert.equal(store.readState().writable, true, '事件读失败不影响档案写权限');
  } finally {
    fs.statSync = origStat;
  }
  // 恢复正常后同一 store 必须能读到（stat 失败不缓存空结果）
  assert.ok(store.search('当天的事件', { days: 30 }).length > 0, '恢复后要能重新读到');
  const st2 = store.stats();
  assert.equal(st2.archivedEvents, 1);
  assert.equal(st2.readErrors, 0, '读成功要清除登记');
  cleanup(dir);
});

test('correctFact 只改内存不落盘；路由统一写一次（含 audit）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'correct-once-'));
  const store = createMemoryStore({ dir });
  const profilePath = path.join(dir, 'profile.json');
  store.writeProfile({
    people: { 小明: { facts: [{ text: '喜欢篮球', createdAt: 1, confirmedAt: 1, count: 1 }], count: 1, firstSeen: 1, lastSeen: 1 } },
    threads: [], self: [],
  });

  // 1) core 层：只改内存
  const out = store.correctFact('小明', '喜欢足球', {});
  assert.equal(out.action, 'CORRECT');
  const mid = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const midTexts = Object.values(mid.people).flatMap((v) => v.facts.map((f) => f.text));
  assert.ok(!midTexts.includes('喜欢足球'), 'correctFact 不能自己写盘（否则路由第二次写失败就自相矛盾）');
  assert.equal((mid.audit || []).length, 0, 'core 层不应该有 audit');

  // 2) 路由层：一次写入，纠正内容和 audit 都在
  let payload = null;
  const handled = await handleSocialV2MemoryApi({
    req: { method: 'POST', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/memory-remember'),
    sendJson: (obj) => { payload = obj; },
    readBody: async () => ({ key: 'group:111', kind: 'correct', name: '小明', content: '喜欢足球' }),
    memoryStore: store,
    mergePersonFact, mergeThread, mergeSelfNote, verifyMemoryClaim,
    buildWriteScope, eventsVisibleToSession,
    archiveMemoryEventV3: () => {},
    redactKnownTokensOnly: (v) => String(v ?? ''),
  });
  assert.equal(handled, true);
  assert.equal(payload.ok, true);
  assert.equal(payload.correct.action, 'CORRECT');
  const after = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const afterTexts = Object.values(after.people).flatMap((v) => v.facts.map((f) => f.text));
  assert.ok(afterTexts.includes('喜欢足球'), '纠正后的内容要落盘');
  assert.ok(!afterTexts.includes('喜欢篮球'), '旧文本被替换');
  assert.equal((after.audit || []).length, 1, 'audit 要跟着同一次写入落盘');
  cleanup(dir);
});

test('周/月摘要目录和 S3 文件读失败也要登记 readErrors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layers-eacces-'));
  fs.mkdirSync(path.join(dir, 'weeks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'months'), { recursive: true });
  const salient = path.join(dir, 'salient.jsonl');
  fs.writeFileSync(salient, JSON.stringify({ id: 's1', t: 1, k: 'g:1', text: '关键的事', s: 3 }) + '\n', 'utf8');
  const store = createMemoryStore({ dir });
  const weeksDir = path.join(dir, 'weeks');
  const monthsDir = path.join(dir, 'months');

  const origReaddir = fs.readdirSync;
  const origRead = fs.readFileSync;
  fs.readdirSync = (p, ...rest) => {
    const file = String(p);
    if (file === weeksDir || file === monthsDir) {
      const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e;
    }
    return origReaddir(p, ...rest);
  };
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === salient) {
      const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e;
    }
    return origRead(p, ...rest);
  };
  try {
    const st = store.stats();
    assert.equal(st.weekFiles, 0, '读不到就是 0（但下面必须能被看见）');
    assert.equal(st.monthFiles, 0);
    assert.equal(st.salient.count, 0);
    assert.ok(st.readErrors >= 3, `周/月/S3 三层读失败都要登记，实际 ${st.readErrors}`);
    assert.ok(st.unreadableFiles.some((n) => n.includes('salient')));
  } finally {
    fs.readdirSync = origReaddir;
    fs.readFileSync = origRead;
  }
  // 恢复后：重新读到 + 登记清空
  const st2 = store.stats();
  assert.equal(st2.readErrors, 0, '恢复后失败登记要清空');
  assert.ok(st2.salient.count >= 1, 'S3 恢复后要能读到');
  cleanup(dir);
});

test('memory-search 在读失败时返回 partial，而不是静默的空结果', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-partial-'));
  const store = createMemoryStore({ dir });
  store.appendEvent({ t: Date.now(), k: 'group:111', kind: 'msg', text: '今天的珊瑚话题', s: 2 });
  const dayFile = path.join(dir, 'events', `${day()}.jsonl`);

  const call = async () => {
    let payload = null;
    await handleSocialV2MemoryApi({
      req: { method: 'GET', headers: {} },
      url: new URL('http://127.0.0.1/api/socialV2/memory-search?key=group:111&q=' + encodeURIComponent('珊瑚')),
      sendJson: (obj) => { payload = obj; },
      readBody: async () => ({}),
      memoryStore: store,
    });
    return payload;
  };

  // 正常：有结果、没有 partial
  const ok = await call();
  assert.equal(ok.ok, true);
  assert.equal(ok.partial, undefined, '正常时不该标 partial');

  // 事件文件 stat 失败：结果为空，但必须告诉调用方「这次不完整」
  const origStat = fs.statSync;
  fs.statSync = (p, ...rest) => {
    if (String(p) === dayFile) {
      const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e;
    }
    return origStat(p, ...rest);
  };
  let degraded;
  try {
    degraded = await call();
  } finally {
    fs.statSync = origStat;
  }
  assert.equal(degraded.ok, true);
  assert.equal(degraded.partial, true, '读失败必须标记 partial，别让模型以为「想不起来」');
  assert.ok(degraded.readErrors >= 1);
  assert.ok(String(degraded.warning || '').includes('不完整'));
  cleanup(dir);
});

// ── 解析失败：读到字节但解释不了，也是一种「看不见的记忆」 ────────────

test('JSONL 坏行会被计数（事件/S3），search 也标 partial', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-jsonl-'));
  const store = createMemoryStore({ dir });
  store.appendEvent({ t: Date.now(), k: 'group:111', kind: 'msg', text: '有效珊瑚事件', s: 2 });
  const dayFile = path.join(dir, 'events', `${day()}.jsonl`);
  fs.appendFileSync(dayFile, '{"t":1,"text":"这条是截断的坏行\n', 'utf8');
  // S3 也是「一好一坏」
  const salient = path.join(dir, 'salient.jsonl');
  fs.writeFileSync(
    salient,
    JSON.stringify({ id: 's1', t: 1, k: 'g:1', text: '有效的关键事', s: 3 }) + '\n{"broken":\n',
    'utf8',
  );

  const st = store.stats();
  assert.ok(st.parseErrors >= 2, `坏行要被计数（事件 + S3），实际 ${st.parseErrors}`);
  assert.ok(st.corruptFiles.some((n) => n.includes(day())));

  assert.ok(store.parseErrorCount() >= 2, '对外要能查到解析失败数');
  // 好行仍然能用（坏行不阻塞整份文件）
  const hits = store.search('有效珊瑚', { days: 30, key: 'group:111' });
  assert.ok(hits.length > 0, '好行照常进入检索');

  // 路由：partial 要同时覆盖 IO 与解析失败
  let payload = null;
  await handleSocialV2MemoryApi({
    req: { method: 'GET', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/memory-search?key=group:111&q=' + encodeURIComponent('珊瑚')),
    sendJson: (obj) => { payload = obj; },
    readBody: async () => ({}),
    memoryStore: store,
  });
  assert.equal(payload.partial, true, '有坏行时检索结果可能不完整，必须标 partial');
  assert.ok(payload.parseErrors >= 2);
  assert.ok(String(payload.warning || '').includes('解析失败'));

  // 修好坏行后计数自动清零（重新读取即恢复）
  fs.writeFileSync(
    dayFile,
    JSON.stringify({ t: Date.now(), k: 'group:111', kind: 'msg', text: '有效珊瑚事件', s: 2 }) + '\n',
    'utf8',
  );
  fs.writeFileSync(salient, JSON.stringify({ id: 's1', t: 1, k: 'g:1', text: '有效的关键事', s: 3 }) + '\n', 'utf8');
  // 重新读一遍（search 读事件、stats 读 S3）后计数才会清空
  store.search('有效珊瑚', { days: 30 });
  store.stats();
  assert.equal(store.parseErrorCount(), 0, '文件修好后解析失败计数要清空');
  cleanup(dir);
});

test('摘要 JSON 损坏：登记状态、只备份一次、修复后恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-summary-'));
  fs.mkdirSync(path.join(dir, 'days'), { recursive: true });
  const store = createMemoryStore({ dir });
  store.appendEvent({ t: Date.now(), k: 'group:111', kind: 'msg', text: '今天的珊瑚事件', s: 2 });
  const noteFile = path.join(dir, 'days', `${day()}.json`);
  fs.writeFileSync(noteFile, '{ 这不是合法 JSON', 'utf8');

  // 连续两次读（search 会读日摘要）：只应产生一个 .corrupt 备份
  store.search('珊瑚', { days: 30 });
  assert.ok(store.parseErrorCount() >= 1, '摘要解析失败要登记，不能当成「没有摘要」');
  store.search('珊瑚', { days: 30 });
  const backups = fs.readdirSync(path.join(dir, 'days')).filter((n) => n.endsWith('.corrupt'));
  assert.equal(backups.length, 1, '同一份损坏摘要只能备份一次，否则目录会被副本撑爆');
  assert.ok(store.stats().parseErrors >= 1);
  assert.ok(store.stats().corruptFiles.some((n) => n.startsWith(day())));

  // 修复后：能正常读，计数清零
  fs.writeFileSync(noteFile, JSON.stringify({ version: 1, day: day(), count: 1, lines: [{ t: '今天的珊瑚事件', s: 2 }] }), 'utf8');
  store.search('珊瑚', { days: 30 });
  store.stats();
  assert.equal(store.parseErrorCount(), 0, '修好摘要后计数要清零');
  cleanup(dir);
});

test('合法 JSON 但类型不对的行按坏行处理，search/stats 不能被打崩', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-jsonl-'));
  const store = createMemoryStore({ dir });
  store.appendEvent({ t: Date.now(), k: 'group:111', kind: 'msg', text: '合法的珊瑚事件', s: 2 });
  const dayFile = path.join(dir, 'events', `${day()}.jsonl`);
  // 四种「语法合法但记录不合法」：null / 字符串 / 数组 / 空对象
  fs.appendFileSync(dayFile, 'null\n"只是一段字符串"\n[1,2]\n{}\n', 'utf8');

  // 都不能抛：search 和 stats 是这个进程的主干路径
  const hits = store.search('合法的珊瑚', { days: 30, key: 'group:111' });
  assert.ok(hits.length > 0, '好行照常进入检索');
  const st = store.stats();
  assert.equal(st.parseErrorLines, 4, '四种非法记录都要计入坏行');
  assert.equal(st.parseErrors, 4);
  assert.equal(store.parseErrorCount(), 4);
  // 健康页/路由用的字段也要在
  assert.ok(Array.isArray(st.corruptFiles));
  cleanup(dir);
});

test('S3 索引带文件指纹：外部修复文件后不会被旧缓存挡住', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salient-stamp-'));
  const store = createMemoryStore({ dir });
  const salient = path.join(dir, 'salient.jsonl');
  const rowA = { id: 'A', t: 1_700_000_000_000, k: 'g:1', kind: 'msg', text: 'A 事件', s: 3 };
  const rowB = { id: 'B', t: 1_700_000_100_000, k: 'g:1', kind: 'msg', text: 'B 事件', s: 3 };
  // S3 里有 A + 一条坏行
  fs.writeFileSync(salient, JSON.stringify(rowA) + '\n{"t":2,\n', 'utf8');

  // 触发一次索引加载（写一条新的高分事件会走 writeSalientRow → loadSalientIndex）
  store.appendEvent({ t: 1_700_000_200_000, k: 'g:1', kind: 'msg', text: '第一次写入', s: 3 });
  assert.ok(store.stats().parseErrorLines >= 1, '坏行要被 counted');

  // 管理员修好 S3：去掉坏行，并加入 B（这一步不经过本进程的写路径）
  fs.writeFileSync(salient, JSON.stringify(rowA) + '\n' + JSON.stringify(rowB) + '\n', 'utf8');

  // 再走一次写路径，内容与 B 完全相同：索引若没按指纹失效，就会重复 append
  store.appendEvent(rowB);
  const lines = fs.readFileSync(salient, 'utf8').split('\n').filter(Boolean);
  const countB = lines.filter((line) => {
    try { return JSON.parse(line).id === 'B'; } catch { return false; }
  }).length;
  assert.equal(countB, 1, '外部修复后的 S3 必须按 mtime/size 重新解析，不能拿旧索引重复补写');
  cleanup(dir);
});

test('S3 索引不可用时写入要 fail-closed（不再静默跳过缺失副本）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salient-unknown-'));
  const store = createMemoryStore({ dir });
  const salient = path.join(dir, 'salient.jsonl');
  const rowK = { id: 'K', t: 1_700_000_000_000, k: 'g:1', kind: 'msg', text: 'K 的关键事', s: 3 };
  // 1) 先写 K（此时索引缓存里有 K）
  store.appendEvent(rowK);
  assert.ok(fs.existsSync(salient));

  // 2) 外部替换 S3：K 消失，只剩 Q
  fs.writeFileSync(
    salient,
    JSON.stringify({ id: 'Q', t: 1_700_000_000_100, k: 'g:1', kind: 'msg', text: 'Q 的关键事', s: 3 }) + '\n',
    'utf8',
  );

  // 3) 下一次写 K 时，stat 抛一次瞬时 EIO → 索引处于 unknown
  const origStat = fs.statSync;
  let thrown = false;
  fs.statSync = (p, ...rest) => {
    if (!thrown && String(p) === salient) {
      thrown = true;
      const e = new Error('EIO: i/o error'); e.code = 'EIO'; throw e;
    }
    return origStat(p, ...rest);
  };
  try {
    store.appendEvent(rowK); // 旧实现会拿旧索引认为「K 已存在」→ 静默跳过
  } finally {
    fs.statSync = origStat;
  }

  // 4) 必须留下待恢复记录（而不是无声无息地丢副本）
  const st = store.stats();
  assert.ok(st.pendingRecoverable > 0, '索引不可用时要记 pending 失败，交给 replay 补写');

  // 5) 文件可读后 replay：S3 里应把 K 补回来
  store.replayWriteFailures();
  const ids = fs.readFileSync(salient, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l).id; } catch { return null; }
  }).filter(Boolean);
  assert.ok(ids.includes('K'), `K 的 S3 副本必须被补写，实际 ${JSON.stringify(ids)}`);
  cleanup(dir);
});

test('删除坏文件后解析失败登记自动失效（health 不能一直假红）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-gone-'));
  const store = createMemoryStore({ dir });
  store.appendEvent({ t: Date.now(), k: 'group:111', kind: 'msg', text: '正常事件', s: 2 });
  const dayFile = path.join(dir, 'events', `${day()}.jsonl`);
  // 结构错误：字符串时间 / 布尔时间 / null —— 都不能算合法事件
  fs.appendFileSync(dayFile, '{"t":"123","text":"字符串时间"}\n{"t":true,"text":"布尔时间"}\nnull\n', 'utf8');
  assert.equal(store.stats().parseErrorLines, 3, '三种结构错误都要计数（t 必须是数字）');

  // 用户直接删掉坏文件：登记必须自动失效，不能继续报红
  fs.rmSync(dayFile, { force: true });
  const st = store.stats();
  assert.equal(st.parseErrorLines, 0, '文件删了，解析失败登记要清掉');
  assert.equal(store.parseErrorCount(), 0);
  cleanup(dir);
});

test('文件存在但读不到时，故障登记不会被「清理旧登记」抹掉', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-tristate-'));
  const store = createMemoryStore({ dir });
  store.appendEvent({ t: Date.now(), k: 'group:111', kind: 'msg', text: '读不到的珊瑚事件', s: 2 });
  const dayFile = path.join(dir, 'events', `${day()}.jsonl`);

  const origStat = fs.statSync;
  const origRead = fs.readFileSync;
  const origExists = fs.existsSync;
  const eacces = () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; };
  fs.statSync = (p, ...rest) => (String(p) === dayFile ? eacces() : origStat(p, ...rest));
  fs.readFileSync = (p, ...rest) => (String(p) === dayFile ? eacces() : origRead(p, ...rest));
  // 关键：Node 的 existsSync 在 EACCES 下也返回 false —— 这正是上一版的坑
  fs.existsSync = (p) => (String(p) === dayFile ? false : origExists(p));

  try {
    const st = store.stats();
    assert.ok(st.readErrors > 0, '文件其实存在，只是读不到；登记不能被 existsSync 抹掉');
    assert.ok(st.unreadableFiles.length > 0);
    // 快照是幂等的：连读两次也不能把刚登记的故障清空
    assert.ok(store.stats().readErrors > 0, '连续读快照不能清除故障登记');
    assert.ok(store.readErrorCount() > 0, 'readErrorCount 也不能被清成 0');

    // 路由侧：search 必须仍然标 partial
    let payload = null;
    await handleSocialV2MemoryApi({
      req: { method: 'GET', headers: {} },
      url: new URL('http://127.0.0.1/api/socialV2/memory-search?key=group:111&q=' + encodeURIComponent('珊瑚')),
      sendJson: (obj) => { payload = obj; },
      readBody: async () => ({}),
      memoryStore: store,
    });
    assert.equal(payload.partial, true, '读不到时 search 仍要标 partial');
  } finally {
    fs.statSync = origStat;
    fs.readFileSync = origRead;
    fs.existsSync = origExists;
  }

  // 真的删除（ENOENT）时才允许清理登记
  fs.rmSync(dayFile, { force: true });
  assert.equal(store.stats().readErrors, 0, '文件确定不存在时才清理');
  cleanup(dir);
});

test('坏行文件的故障登记同样不会被 existsSync 抹掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-parse-'));
  const store = createMemoryStore({ dir });
  store.appendEvent({ t: Date.now(), k: 'group:111', kind: 'msg', text: '正常事件', s: 2 });
  const dayFile = path.join(dir, 'events', `${day()}.jsonl`);
  fs.appendFileSync(dayFile, 'null\n', 'utf8');
  assert.ok(store.stats().parseErrorLines > 0, '坏行先被登记');

  const origExists = fs.existsSync;
  // 模拟权限异常时 existsSync 的假阴性
  fs.existsSync = (p) => (String(p) === dayFile ? false : origExists(p));
  try {
    assert.ok(store.stats().parseErrorLines > 0, '文件还在，坏行登记不能被抹掉');
    assert.ok(store.parseErrorCount() > 0);
  } finally {
    fs.existsSync = origExists;
  }
  cleanup(dir);
});

// ── JSON schema：语法合法 ≠ 内容是这份文件该有的东西 ────────────────

test('profile 顶层结构不合法时同样写保护（数组/字符串/people 数组）', () => {
  const cases = [
    '[{"text":"可能是可恢复的人物资料"}]',
    '"只是一个字符串"',
    '{"people":[]}',
  ];
  for (const body of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-schema-'));
    const profilePath = path.join(dir, 'profile.json');
    fs.writeFileSync(profilePath, body, 'utf8');
    const store = createMemoryStore({ dir });

    assert.throws(
      () => store.readProfile({ strict: true }),
      /结构不符合/,
      `${body} 应该被判定为 schema 损坏`,
    );
    const state = store.readState();
    assert.equal(state.corrupt, true, '要标记 corrupt（不是「空档案」）');
    assert.equal(state.writable, false, '写保护必须生效');
    assert.equal(store.writeProfile(store.readProfile()), false, '不能把空档案覆盖回去');
    assert.ok(fs.existsSync(profilePath + '.corrupt'), 'schema 损坏也要备份原内容');
    assert.equal(fs.readFileSync(profilePath, 'utf8'), body, '磁盘原内容不能被改动');
    cleanup(dir);
  }
});

test('摘要 JSON 结构不合法时登记 schema 损坏，而不是当成没有摘要', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-schema-'));
  fs.mkdirSync(path.join(dir, 'days'), { recursive: true });
  const store = createMemoryStore({ dir });
  store.appendEvent({ t: Date.now(), k: 'group:111', kind: 'msg', text: '今天的珊瑚事件', s: 2 });
  const noteFile = path.join(dir, 'days', `${day()}.json`);
  // 合法 JSON，但 lines 应该是数组
  fs.writeFileSync(noteFile, JSON.stringify({ day: day(), count: 1, lines: '本应是数组' }), 'utf8');

  store.search('珊瑚', { days: 30 }); // 不能崩
  const st = store.stats();
  assert.ok(st.corruptJsonFiles.some((n) => n.startsWith(day())), 'sore 结构坏要被登记');
  assert.equal(st.corruptJsonReasons[`${day()}.json`], 'schema', '原因要标成 schema 而不是 syntax');
  assert.ok(fs.existsSync(noteFile + '.corrupt'), '结构坏也要备份');

  // 修好后重新读取：登记自动清零
  fs.writeFileSync(noteFile, JSON.stringify({ version: 1, day: day(), count: 1, lines: [{ t: '珊瑚', s: 2 }] }), 'utf8');
  store.search('珊瑚', { days: 30 });
  const st2 = store.stats();
  assert.ok(!st2.corruptJsonFiles.some((n) => n.startsWith(day())), '修好后要恢复');
  cleanup(dir);
});

test('usage.json 结构不合法时同样登记（hits 必须是对象）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-schema-'));
  const store = createMemoryStore({ dir });
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ hits: '不是对象' }), 'utf8');
  const st = store.stats();
  assert.ok(st.corruptJsonFiles.includes('usage.json'), 'usage 结构坏要被登记');
  assert.equal(st.corruptJsonReasons['usage.json'], 'schema');
  assert.ok(fs.existsSync(path.join(dir, 'usage.json.corrupt')), '要备份');
  cleanup(dir);
});

// ── consolidation 的读取路径也要过 schema，不能只靠 search 才发现 ─────

test('日摘要结构损坏时 consolidation 会重建（不能等 search 才发现）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consol-day-'));
  const store = createMemoryStore({ dir });
  const now = Date.now();
  store.appendEvent({ t: now, k: 'group:111', kind: 'msg', text: '第一件事', s: 2 });
  store.appendEvent({ t: now, k: 'group:111', kind: 'msg', text: '第二件事', s: 2 });
  assert.ok(store.ensureDaySummaries({ now }) >= 1, '先正常生成一次');

  const file = path.join(dir, 'days', `${day(now)}.json`);
  const real = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 结构坏：lines 变成字符串；srcFingerprint 保留（否则会因指纹变化而重建，测不到 schema 分支）
  fs.writeFileSync(file, JSON.stringify({ ...real, lines: '本应是数组' }), 'utf8');

  const rebuilt = store.ensureDaySummaries({ now });
  assert.equal(rebuilt, 1, '结构损坏必须触发重建，而不是 continue');
  const fixed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(fixed.lines), '重建后 lines 要恢复成数组');
  assert.equal(store.stats().corruptJsonFileCount, 0, '重建成功后损坏登记要清掉');
  cleanup(dir);
});

test('周要点结构损坏时 consolidation 会重建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consol-week-'));
  const store = createMemoryStore({ dir });
  const now = Date.now();
  // 造上周的若干事件（current week 不会生成周要点）
  const lastWeek = now - 7 * 86400000;
  for (let i = 0; i < 6; i += 1) {
    store.appendEvent({ t: lastWeek + i * 60000, k: 'group:111', kind: 'msg', text: `上周第${i}件事`, s: 2 });
  }
  store.ensureDaySummaries({ now });
  assert.ok(store.ensureWeekNotes({ now }) >= 1, '先正常生成周要点');

  const weeks = store.listWeekFiles ? store.listWeekFiles() : null;
  const dirWeeks = fs.readdirSync(path.join(dir, 'weeks')).filter((n) => n.endsWith('.json'));
  assert.ok(dirWeeks.length >= 1, '应该有周要点文件');
  const file = path.join(dir, 'weeks', dirWeeks[0]);
  const real = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...real, lines: '本应是数组' }), 'utf8');

  const rebuilt = store.ensureWeekNotes({ now });
  assert.ok(rebuilt >= 1, '结构损坏的周要点要重建');
  const fixed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(fixed.lines));
  cleanup(dir);
});

test('损坏 JSON 总数不会被展示列表截断，auditSummaries 能主动发现', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consol-count-'));
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'days'), { recursive: true });
  const store = createMemoryStore({ dir });
  for (let i = 1; i <= 12; i += 1) {
    const d = `2026-01-${String(i).padStart(2, '0')}`;
    fs.writeFileSync(path.join(dir, 'events', `${d}.jsonl`), '', 'utf8');
    fs.writeFileSync(path.join(dir, 'days', `${d}.json`), JSON.stringify({ lines: '坏' }), 'utf8');
  }

  const audit = store.auditSummaries({ limit: 400 });
  assert.equal(audit.corrupt.length, 12, '主动校验要能把 12 个都捞出来');
  const st = store.stats();
  assert.equal(st.corruptJsonFileCount, 12, '总数不能被截断');
  assert.equal(st.corruptJsonFiles.length, 10, '展示名单可以截断');
  assert.equal(st.parseErrors, 12, 'parseErrors 用完整计数');
  cleanup(dir);
});

test('memory-store 里读记忆数据必须走统一原语（禁止手写 JSON 解析）', () => {
  // Codex 的风险点：schema 校验已经有了，但只要有一处手写 JSON.parse(fs.readFileSync(...))，
  // 「合法 JSON、错误结构」就会从那条路径重新渗回来（ensure* 就绕过过一次）。
  // 唯一的豁免是锁文件：它是控制面数据，损坏按过期处理，本来就不走 schema。
  const file = fileURLToPath(new URL('../src/core/memory-store.mjs', import.meta.url));
  const offenders = fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => ({ text: line.trim(), no: i + 1 }))
    .filter(({ text }) => /JSON\.parse\(\s*fs\.readFileSync/.test(text) && !/lockFile/.test(text));
  assert.deepEqual(
    offenders,
    [],
    '记忆数据的读取必须走 readJsonFile / parseJsonl（含 schema 与故障登记）；只有锁文件可以手写解析',
  );
});

test('auditSummaries 以摘要文件为枚举源：归档后的 orphan 日摘要也能发现/重建', () => {
  // case A：没有任何事件来源的 orphan 损坏日摘要 —— 必须被报告（不能 checked:0）
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-audit-a-'));
  fs.mkdirSync(path.join(dirA, 'days'), { recursive: true });
  const storeA = createMemoryStore({ dir: dirA });
  fs.writeFileSync(
    path.join(dirA, 'days', '2026-01-05.json'),
    JSON.stringify({ day: '2026-01-05', count: 1, lines: '结构损坏的旧日摘要' }),
    'utf8',
  );
  const auditA = storeA.auditSummaries({ limit: 400 });
  assert.equal(auditA.checked, 1, '没有事件日文件也要检查已存在的日摘要');
  assert.equal(auditA.corrupt.length, 1);
  assert.equal(auditA.corrupt[0].reason, 'schema');
  assert.ok(!fs.existsSync(path.join(dirA, 'days', '2026-01-05.json.corrupt')), '只读审计不能备份');
  cleanup(dirA);

  // case B：归档里还有该天的事件 → 应能按 srcDay 自动重建
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-audit-b-'));
  fs.mkdirSync(path.join(dirB, 'days'), { recursive: true });
  fs.mkdirSync(path.join(dirB, 'events-archive'), { recursive: true });
  const storeB = createMemoryStore({ dir: dirB });
  const orphanDay = '2026-01-05';
  const ts = new Date('2026-01-05T12:00:00').getTime();
  fs.writeFileSync(
    path.join(dirB, 'events-archive', '2026-01.jsonl'),
    [1, 2, 3].map((i) => JSON.stringify({ id: `e${i}`, t: ts + i * 1000, k: 'group:111', kind: 'msg', text: `归档事件${i}`, s: 2, srcDay: orphanDay })).join('\n') + '\n',
    'utf8',
  );
  fs.writeFileSync(path.join(dirB, 'days', `${orphanDay}.json`), JSON.stringify({ day: orphanDay, count: 1, lines: '坏的' }), 'utf8');
  const auditB = storeB.auditSummaries({ limit: 400 });
  assert.equal(auditB.repairable.length, 1, '归档事件还在 → 标记为可修复');
  assert.equal(auditB.wouldRewrite, 1);
  assert.equal(auditB.corrupt.length, 1, '只读审计仍把它算作损坏项');
  // 真正重建必须显式 apply（只读审计本身不写盘）
  const repaired = storeB.repairSummaries({ limit: 400, dryRun: false });
  assert.equal(repaired.repaired.length, 1);
  const fixed = JSON.parse(fs.readFileSync(path.join(dirB, 'days', `${orphanDay}.json`), 'utf8'));
  assert.ok(Array.isArray(fixed.lines), 'apply 后要恢复成数组');
  cleanup(dirB);
});

test('auditSummaries 明确区分抽样与全量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-sample-'));
  fs.mkdirSync(path.join(dir, 'days'), { recursive: true });
  const store = createMemoryStore({ dir });
  for (let i = 1; i <= 5; i += 1) {
    fs.writeFileSync(
      path.join(dir, 'days', `2026-02-0${i}.json`),
      JSON.stringify({ day: `2026-02-0${i}`, count: 1, lines: [{ t: 'x', s: 1 }] }),
      'utf8',
    );
  }
  const sampled = store.auditSummaries({ limit: 2 });
  assert.equal(sampled.totalFiles, 5);
  assert.equal(sampled.checked, 2);
  assert.equal(sampled.skippedByLimit, 3);
  assert.equal(sampled.sampled, true, '有跳过时要明确标记为抽样');

  const full = store.auditSummaries({ limit: 400 });
  assert.equal(full.checked, 5);
  assert.equal(full.skippedByLimit, 0);
  assert.equal(full.sampled, false);
  cleanup(dir);
});

// ── 只读诊断契约：audit 不能写盘，修复必须是单独显式命令 ─────────────

function snapshotTree(dir) {
  const out = {};
  const walk = (cur, base) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) { walk(abs, rel); continue; }
      out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

function seedRepairableOrphan(dir) {
  fs.mkdirSync(path.join(dir, 'days'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  const orphanDay = '2026-01-05';
  const ts = new Date('2026-01-05T12:00:00').getTime();
  fs.writeFileSync(
    path.join(dir, 'events-archive', '2026-01.jsonl'),
    [1, 2, 3].map((i) => JSON.stringify({ id: `e${i}`, t: ts + i * 1000, k: 'group:111', kind: 'msg', text: `归档事件${i}`, s: 2, srcDay: orphanDay })).join('\n') + '\n',
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'days', `${orphanDay}.json`), JSON.stringify({ day: orphanDay, count: 1, lines: '坏的' }), 'utf8');
  return orphanDay;
}

test('auditSummaries 默认零磁盘副作用（不建 .corrupt、不覆盖摘要）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-readonly-'));
  const orphanDay = seedRepairableOrphan(dir);
  const store = createMemoryStore({ dir });
  const before = snapshotTree(dir);

  const audit = store.auditSummaries({ limit: 400 });
  assert.equal(audit.dryRun, true);
  assert.equal(audit.repairable.length, 1, '可修的要报出来');
  assert.equal(audit.wouldBackup, 1);
  assert.equal(audit.wouldRewrite, 1);
  assert.deepEqual(snapshotTree(dir), before, 'audit 不能写任何文件（包括 .corrupt）');
  assert.equal(fs.readFileSync(path.join(dir, 'days', `${orphanDay}.json`), 'utf8'), JSON.stringify({ day: orphanDay, count: 1, lines: '坏的' }), '原摘要不能被覆盖');
  cleanup(dir);
});

test('repairSummaries 只有 dryRun:false 才写盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-explicit-'));
  const orphanDay = seedRepairableOrphan(dir);
  const store = createMemoryStore({ dir });

  const before = snapshotTree(dir);
  const preview = store.repairSummaries({ limit: 400 });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.repaired.length, 1);
  assert.deepEqual(snapshotTree(dir), before, '预览不能写盘');

  const applied = store.repairSummaries({ limit: 400, dryRun: false });
  assert.equal(applied.repaired.length, 1);
  const fixed = JSON.parse(fs.readFileSync(path.join(dir, 'days', `${orphanDay}.json`), 'utf8'));
  assert.ok(Array.isArray(fixed.lines), 'apply 后要重建成功');
  assert.ok(fs.existsSync(path.join(dir, 'days', `${orphanDay}.json.corrupt`)), 'apply 时要备份原文件');
  cleanup(dir);
});

test('memory-health 默认只读：跑完 state/memory 一个字节都不变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-readonly-'));
  seedRepairableOrphan(dir);
  const before = snapshotTree(dir);
  const script = fileURLToPath(new URL('../scripts/memory-health.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--dir', dir], { encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, '健康检查应正常退出：' + (run.stderr || '').slice(0, 400));
  assert.deepEqual(snapshotTree(dir), before, 'health 默认不能改记忆库（不备份、不重建）');
  cleanup(dir);
});

// ── --dir 的并发保护必须跟着目标库走，而不是脚本所在项目 ──────────────

function seedRepairableProject(baseDir) {
  // 项目结构：<base>/state/memory + <base>/state/bridge.lock
  const memDir = path.join(baseDir, 'state', 'memory');
  fs.mkdirSync(path.join(memDir, 'days'), { recursive: true });
  fs.mkdirSync(path.join(memDir, 'events-archive'), { recursive: true });
  const orphanDay = '2026-01-05';
  const ts = new Date('2026-01-05T12:00:00').getTime();
  fs.writeFileSync(
    path.join(memDir, 'events-archive', '2026-01.jsonl'),
    [1, 2, 3].map((i) => JSON.stringify({ id: `e${i}`, t: ts + i * 1000, k: 'group:111', kind: 'msg', text: `归档事件${i}`, s: 2, srcDay: orphanDay })).join('\n') + '\n',
    'utf8',
  );
  const summaryFile = path.join(memDir, 'days', `${orphanDay}.json`);
  fs.writeFileSync(summaryFile, JSON.stringify({ day: orphanDay, count: 1, lines: '坏的' }), 'utf8');
  return { memDir, summaryFile };
}

function runHealth(args) {
  const script = fileURLToPath(new URL('../scripts/memory-health.mjs', import.meta.url));
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120000 });
}

test('repair apply 必须检查目标库的 bridge.lock（不是当前项目）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-scope-'));
  const { memDir, summaryFile } = seedRepairableProject(base);
  const before = fs.readFileSync(summaryFile, 'utf8');
  // 目标库自己的 bridge 正在运行（用当前测试进程的 PID 保证存活）
  fs.mkdirSync(path.join(base, 'state'), { recursive: true });
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), String(process.pid), 'utf8');

  const run = runHealth(['--dir', memDir, '--repair-summaries', '--apply']);
  assert.equal(run.status, 2, '目标库 bridge 在跑时 apply 必须拒绝：' + (run.stdout || run.stderr || '').slice(0, 300));
  assert.equal(fs.readFileSync(summaryFile, 'utf8'), before, '拒绝时不能改摘要');
  assert.ok(!fs.existsSync(summaryFile + '.corrupt'), '拒绝时不能产生备份');
  cleanup(base);
});

test('目标库没有 bridge.lock 时 apply 正常执行（不误用当前项目的锁）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-scope-free-'));
  const { memDir, summaryFile } = seedRepairableProject(base);

  const run = runHealth(['--dir', memDir, '--repair-summaries', '--apply']);
  assert.equal(run.status, 0, '目标库没跑 bridge，应允许修复：' + (run.stdout || run.stderr || '').slice(0, 300));
  const fixed = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  assert.ok(Array.isArray(fixed.lines), '摘要应被重建');
  assert.ok(fs.existsSync(summaryFile + '.corrupt'), '应备份原文件');
  cleanup(base);
});

test('推断不出 lock 位置时 fail-closed，必须显式 --bridge-lock', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-scope-unknown-'));
  // 目录不是 <project>/state/memory 形态
  const plainMem = path.join(base, 'custom-memory');
  fs.mkdirSync(path.join(plainMem, 'days'), { recursive: true });
  fs.mkdirSync(path.join(plainMem, 'events-archive'), { recursive: true });
  const orphanDay = '2026-01-05';
  const ts = new Date('2026-01-05T12:00:00').getTime();
  fs.writeFileSync(
    path.join(plainMem, 'events-archive', '2026-01.jsonl'),
    JSON.stringify({ id: 'e1', t: ts, k: 'group:111', kind: 'msg', text: '归档事件', s: 2, srcDay: orphanDay }) + '\n',
    'utf8',
  );
  const summaryFile = path.join(plainMem, 'days', `${orphanDay}.json`);
  fs.writeFileSync(summaryFile, JSON.stringify({ day: orphanDay, count: 1, lines: '坏的' }), 'utf8');

  const refused = runHealth(['--dir', plainMem, '--repair-summaries', '--apply']);
  assert.equal(refused.status, 2, '推断不出锁位置时必须拒绝');
  assert.equal(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).lines, '坏的', '拒绝时不能改摘要');

  // 显式锁路径必须真实存在且可解析（新语义：拼错路径 = 未知 → 拒绝）
  const stopped = spawnSync(process.execPath, ['-e', '0'], { timeout: 10000 });
  const lockFile = path.join(base, 'explicit.lock');
  fs.writeFileSync(lockFile, String(stopped.pid), 'utf8');
  const okRun = runHealth(['--dir', plainMem, '--bridge-lock', lockFile, '--repair-summaries', '--apply']);
  assert.equal(okRun.status, 0, '显式给了有效 lock 路径就应执行：' + (okRun.stdout || okRun.stderr || '').slice(0, 300));
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).lines));
  cleanup(base);
});

// ── 锁状态：missing / stopped 才允许写；unknown 必须 fail-closed ──────

test('锁内容损坏时必须 fail-closed（不能当成「桥接没在跑」）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-corrupt-'));
  const { memDir, summaryFile } = seedRepairableProject(base);
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), 'not-a-valid-pid', 'utf8');
  const before = fs.readFileSync(summaryFile, 'utf8');

  const refused = runHealth(['--dir', memDir, '--repair-summaries', '--apply']);
  assert.equal(refused.status, 2, '锁内容损坏 → 状态未知 → 必须拒绝：' + (refused.stdout || refused.stderr || '').slice(0, 300));
  assert.equal(fs.readFileSync(summaryFile, 'utf8'), before, '拒绝时不能改摘要');
  assert.ok(!fs.existsSync(summaryFile + '.corrupt'));

  // 明确知道桥接已停的人可以 --force-unlocked 越过
  const forced = runHealth(['--dir', memDir, '--repair-summaries', '--apply', '--force-unlocked']);
  assert.equal(forced.status, 0, '--force-unlocked 后应执行：' + (forced.stdout || forced.stderr || '').slice(0, 300));
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).lines), '摘要应被重建');
  cleanup(base);
});

test('锁内容为合法 PID 但进程已退出（stopped）时允许 apply', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-stopped-'));
  const { memDir, summaryFile } = seedRepairableProject(base);
  // 起一个立刻退出的进程，拿它的 PID：这个 PID 一定不存在了
  const dead = spawnSync(process.execPath, ['-e', '0'], { timeout: 10000 });
  assert.ok(Number.isInteger(dead.pid) && dead.pid > 0, '要拿到一个已退出进程的 PID');
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), String(dead.pid), 'utf8');

  const run = runHealth(['--dir', memDir, '--repair-summaries', '--apply']);
  assert.equal(run.status, 0, 'stopped 不是故障，应允许修复：' + (run.stdout || run.stderr || '').slice(0, 300));
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).lines));
  cleanup(base);
});

test('显式 --bridge-lock 指向不存在的文件时也算未知（除非 --force-unlocked）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-explicit-missing-'));
  const plainMem = path.join(base, 'custom-memory');
  fs.mkdirSync(path.join(plainMem, 'days'), { recursive: true });
  fs.mkdirSync(path.join(plainMem, 'events-archive'), { recursive: true });
  const orphanDay = '2026-01-05';
  const ts = new Date('2026-01-05T12:00:00').getTime();
  fs.writeFileSync(
    path.join(plainMem, 'events-archive', '2026-01.jsonl'),
    JSON.stringify({ id: 'e1', t: ts, k: 'group:111', kind: 'msg', text: '归档事件', s: 2, srcDay: orphanDay }) + '\n',
    'utf8',
  );
  const summaryFile = path.join(plainMem, 'days', `${orphanDay}.json`);
  fs.writeFileSync(summaryFile, JSON.stringify({ day: orphanDay, count: 1, lines: '坏的' }), 'utf8');

  const refused = runHealth(['--dir', plainMem, '--bridge-lock', path.join(base, 'typo.lock'), '--repair-summaries', '--apply']);
  assert.equal(refused.status, 2, '显式锁路径不存在 → 未知 → 拒绝（拼错路径也挡得住）');
  assert.equal(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).lines, '坏的');

  const forced = runHealth(['--dir', plainMem, '--bridge-lock', path.join(base, 'typo.lock'), '--repair-summaries', '--apply', '--force-unlocked']);
  assert.equal(forced.status, 0);
  cleanup(base);
});

// ── 恢复控制面：判重读取失败必须 fail-closed（不能重复写） ─────────────

test('replay 幂等判重读不到时不能重复写 L1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-unknown-'));
  const store = createMemoryStore({ dir });
  const row = { id: 'same-event', t: Date.now(), k: 'group:111', kind: 'msg', text: '同一条事件', s: 2 };
  store.appendEvent(row); // L1 已经有一条
  const dayFile = path.join(dir, 'events', `${day()}.jsonl`);
  // 失败清单里放同 id 的待恢复记录
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', id: 'same-event', row }) + '\n',
    'utf8',
  );

  const origRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === dayFile) {
      const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e;
    }
    return origRead(p, ...rest);
  };
  let result;
  let stDuring = null;
  try {
    result = store.replayWriteFailures({ dryRun: false });
    // 故障仍生效时取 stats：恢复后重新读成功会把登记清掉（那正是期望行为）。
    stDuring = store.stats();
  } finally {
    fs.readFileSync = origRead;
  }

  const lines = fs.readFileSync(dayFile, 'utf8').split('\n').filter(Boolean);
  const sameId = lines.filter((line) => {
    try { return JSON.parse(line).id === 'same-event'; } catch { return false; }
  });
  assert.equal(sameId.length, 1, '判重读不到时绝不能重复写同一条事件');
  assert.ok((result.failed || 0) > 0 || (result.remaining || 0) > 0, '要如实报告没恢复成功');
  assert.ok(stDuring.readErrors > 0, '判重读取失败要登记，health 能看见');
  cleanup(dir);
});

test('失败清单读不到时 pending 不可信且可见', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-unknown-'));
  const store = createMemoryStore({ dir });
  const row = { id: 'pending-1', t: Date.now(), k: 'group:111', kind: 'msg', text: '待恢复', s: 2 };
  const failFile = path.join(dir, 'write-failures.jsonl');
  fs.writeFileSync(failFile, JSON.stringify({ at: Date.now(), phase: 'event', id: 'pending-1', row }) + '\n', 'utf8');

  const origRead = fs.readFileSync;
  let injected = true;
  fs.readFileSync = (p, ...rest) => {
    if (injected && String(p) === failFile) {
      const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e;
    }
    return origRead(p, ...rest);
  };
  try {
    const st = store.stats();
    assert.equal(st.pendingUnreadable, true, '主清单读不到必须标记 pendingUnreadable');
    assert.ok(st.readErrors > 0, '读失败要登记');
  } finally {
    fs.readFileSync = origRead;
  }
  cleanup(dir);
});

test('health --replay --apply 在 replay 锁被占用时 exit 1（不能把没恢复当成功）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-cli-lock-'));
  const memDir = path.join(base, 'state', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  const row = { id: 'cli-pending', t: Date.now(), k: 'g:1', kind: 'msg', text: '待恢复', s: 2 };
  fs.writeFileSync(
    path.join(memDir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', id: 'cli-pending', row }) + '\n',
    'utf8',
  );
  // 另一个进程持有 replay 锁（PID 用当前存活进程）
  fs.writeFileSync(
    path.join(memDir, 'write-failures.jsonl.lock'),
    JSON.stringify({ owner: 'other', pid: process.pid, at: Date.now() }),
    'utf8',
  );
  // 目标库 bridge 已停（合法 PID 但进程不存在），允许进入 replay
  const dead = spawnSync(process.execPath, ['-e', '0'], { timeout: 10000 });
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), String(dead.pid), 'utf8');

  const run = runHealth(['--dir', memDir, '--replay', '--apply']);
  assert.equal(run.status, 1, '锁被占用时 CLI 必须 exit 1：' + (run.stdout || run.stderr || '').slice(0, 400));
  assert.ok(fs.existsSync(path.join(memDir, 'write-failures.jsonl.lock')), '不能删除别人的锁');
  assert.ok(fs.existsSync(path.join(memDir, 'write-failures.jsonl')), '待恢复清单要还在');
  cleanup(base);
});

test('同 ID 的 salient 和 event 两阶段必须都执行（不能跳过 event）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-stages-'));
  const store = createMemoryStore({ dir });
  const row = { id: 'same', t: Date.now(), k: 'group:111', kind: 'msg', text: '两阶段记录', s: 3 };
  // 失败清单里先 salient 后 event（同一 id、同一 row）
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    [
      JSON.stringify({ at: Date.now(), phase: 'salient', id: 'same', row }),
      JSON.stringify({ at: Date.now(), phase: 'event', id: 'same', row }),
    ].join('\n') + '\n',
    'utf8',
  );
  const result = store.replayWriteFailures({ dryRun: false });
  assert.equal(result.replayed, 1, '同 id 只算一次恢复');
  const dayFile = path.join(dir, 'events', `${day()}.jsonl`);
  assert.ok(fs.existsSync(dayFile), 'L1 必须被写入（event 阶段不能被跳过）');
  const lines = fs.readFileSync(dayFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'L1 里只应有一条');
  assert.equal(JSON.parse(lines[0]).id, 'same');
  cleanup(dir);
});

test('失败清单写失败后，重启仍能看到诊断（不能只是内存字段）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-restart-'));
  const store = createMemoryStore({ dir });
  const origAppend = fs.appendFileSync;
  fs.appendFileSync = (p, ...rest) => {
    const target = String(p);
    if (target.includes('write-failures.jsonl') && !target.includes('manifest-error')) {
      const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e;
    }
    return origAppend(p, ...rest);
  };
  try {
    // 让 L1 写失败（触发 recordWriteFailure），同时清单 append 也失败
    const row = { id: 'lost-1', t: Date.now(), k: 'g:1', kind: 'msg', text: '丢掉的', s: 2 };
    const origWrite = fs.appendFileSync;
    fs.appendFileSync = (p, ...rest) => {
      const target = String(p);
      if (target.includes('write-failures.jsonl') && !target.includes('manifest-error')) {
        const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e;
      }
      if (target.includes(`${path.sep}events${path.sep}`)) {
        const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e;
      }
      return origWrite(p, ...rest);
    };
    try { store.appendEvent(row); } finally { fs.appendFileSync = origWrite; }
  } finally {
    fs.appendFileSync = origAppend;
  }
  assert.ok(fs.existsSync(path.join(dir, 'write-failures.manifest-error.jsonl')), '要写替代诊断文件');

  // 新进程（新 store）必须读回它
  const fresh = createMemoryStore({ dir });
  const st = fresh.stats();
  assert.ok(st.failureManifestWriteError, '重启后 stats 必须能看到上次的清单写失败');
  assert.ok(st.failureManifestWriteError.history >= 1);
  assert.equal(st.failureManifestWriteError.code, 'ENOSPC');
  cleanup(dir);
});

test('migrate 归档目录 readdir 失败要返回错误（不能当成没有归档）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-archive-err-'));
  const store = createMemoryStore({ dir });
  fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'events-archive', '2026-01.jsonl'), JSON.stringify({ id: 'a1', t: Date.now(), k: 'g:1', kind: 'msg', text: '归档', s: 2 }) + '\n', 'utf8');
  const origReaddir = fs.readdirSync;
  fs.readdirSync = (p, ...rest) => {
    if (String(p) === path.join(dir, 'events-archive')) {
      const e = new Error('EACCES'); e.code = 'EACCES'; throw e;
    }
    return origReaddir(p, ...rest);
  };
  let result;
  try {
    result = store.migrateLegacyRecords({ dryRun: false });
  } finally {
    fs.readdirSync = origReaddir;
  }
  assert.ok(String(result.error || '').includes('archive-readdir-failed'), '必须返回 archive-readdir-failed：' + JSON.stringify(result));
  cleanup(dir);
});

test('migrate --apply 在锁被占用时 exit 1（不能报成功）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-cli-lock-'));
  const memDir = path.join(base, 'state', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'write-failures.jsonl'), JSON.stringify({ at: Date.now(), phase: 'event', row: { t: Date.now(), k: 'g:1', kind: 'msg', text: '旧格式' } }) + '\n', 'utf8');
  fs.writeFileSync(
    path.join(memDir, 'write-failures.jsonl.lock'),
    JSON.stringify({ owner: 'other', pid: process.pid, at: Date.now() }),
    'utf8',
  );
  const dead = spawnSync(process.execPath, ['-e', '0'], { timeout: 10000 });
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), String(dead.pid), 'utf8');

  const run = runHealth(['--dir', memDir, '--migrate', '--apply']);
  assert.equal(run.status, 1, '锁冲突时 migrate 必须 exit 1：' + (run.stdout || run.stderr || '').slice(0, 400));
  assert.ok(fs.existsSync(path.join(memDir, 'write-failures.jsonl.lock')), '不能删别人的锁');
  cleanup(base);
});

test('replay --apply 有 overflow 残留时 exit 1（已知不可恢复数据不能当成功）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-overflow-'));
  const memDir = path.join(base, 'state', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'write-failures.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(memDir, 'write-failures.jsonl.overflow'), '2\n3\n', 'utf8');
  const dead = spawnSync(process.execPath, ['-e', '0'], { timeout: 10000 });
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), String(dead.pid), 'utf8');

  const run = runHealth(['--dir', memDir, '--replay', '--apply']);
  assert.equal(run.status, 1, 'overflow 残留时 replay 必须 exit 1：' + (run.stdout || run.stderr || '').slice(0, 400));
  cleanup(base);
});

test('同 ID 不同内容必须报 id-conflict，不能静默挑一条', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-conflict-'));
  const store = createMemoryStore({ dir });
  const rowA = { id: 'dup', t: Date.now(), k: 'g:1', kind: 'msg', text: '内容 A', s: 2 };
  const rowB = { id: 'dup', t: Date.now(), k: 'g:1', kind: 'msg', text: '内容 B', s: 2 };
  fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    [
      JSON.stringify({ at: Date.now(), phase: 'event', id: 'dup', row: rowA }),
      JSON.stringify({ at: Date.now(), phase: 'event', id: 'dup', row: rowB }),
    ].join('\n') + '\n',
    'utf8',
  );
  const result = store.replayWriteFailures({ dryRun: false });
  assert.ok(Array.isArray(result.idConflicts) && result.idConflicts.length === 1, '冲突必须被报告：' + JSON.stringify(result));
  cleanup(dir);
});

test('诊断文件按阶段计数，ack 后归档并解除告警', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unrecorded-'));
  const store = createMemoryStore({ dir });
  const diagFile = path.join(dir, 'write-failures.manifest-error.jsonl');
  fs.writeFileSync(
    diagFile,
    [
      JSON.stringify({ at: Date.now(), phase: 'event', id: 'e1', code: 'ENOSPC', error: 'no space' }),
      JSON.stringify({ at: Date.now(), phase: 'salient', id: 's1', code: 'ENOSPC', error: 'no space' }),
    ].join('\n') + '\n',
    'utf8',
  );
  const fresh = createMemoryStore({ dir });
  const st = fresh.stats();
  assert.equal(st.unrecordedFailureCount, 2);
  assert.equal(st.unrecordedByPhase.event, 1);
  assert.equal(st.unrecordedByPhase.salient, 1);

  const ack = fresh.ackManifestErrors();
  assert.equal(ack.ok, true);
  assert.equal(ack.acknowledged, 2);
  assert.ok(!fs.existsSync(diagFile), 'ack 后诊断文件应被归档');
  assert.ok(fs.readdirSync(dir).some((n) => n.includes('manifest-error.jsonl.ack-')), '要保留审计线索');
  const after = createMemoryStore({ dir }).stats();
  assert.equal(after.unrecordedFailureCount, 0, 'ack 后不再告警');
  cleanup(dir);
});

test('migrate 在有 pending 记录时不应假失败（迁移只补 ID）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-no-false-fail-'));
  const memDir = path.join(base, 'state', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(
    path.join(memDir, 'write-failures.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', row: { t: Date.now(), k: 'g:1', kind: 'msg', text: '旧格式' } }) + '\n',
    'utf8',
  );
  const dead = spawnSync(process.execPath, ['-e', '0'], { timeout: 10000 });
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), String(dead.pid), 'utf8');

  const run = runHealth(['--dir', memDir, '--migrate', '--apply']);
  assert.equal(run.status, 0, '迁移成功不应因 pending 仍存在而 exit 1：' + (run.stdout || run.stderr || '').slice(0, 500));
  const after = fs.readFileSync(path.join(memDir, 'write-failures.jsonl'), 'utf8').trim();
  assert.ok(after.includes('"id"'), '旧记录要补上 id');
  cleanup(base);
});

test('replay --apply 在存在未记录失败（未 ack）时 exit 1', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-unrecorded-'));
  const memDir = path.join(base, 'state', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'write-failures.jsonl'), '', 'utf8');
  fs.writeFileSync(
    path.join(memDir, 'write-failures.manifest-error.jsonl'),
    JSON.stringify({ at: Date.now(), phase: 'event', id: 'lost', code: 'ENOSPC', error: 'no space' }) + '\n',
    'utf8',
  );
  const dead = spawnSync(process.execPath, ['-e', '0'], { timeout: 10000 });
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), String(dead.pid), 'utf8');

  const run = runHealth(['--dir', memDir, '--replay', '--apply']);
  assert.equal(run.status, 1, '未记录失败存在时 replay 必须 exit 1：' + (run.stdout || run.stderr || '').slice(0, 500));
  assert.ok(String(`${run.stdout || ''}${run.stderr || ''}`).includes('连清单都没写进去'), '要说明原因');
  cleanup(base);
});
