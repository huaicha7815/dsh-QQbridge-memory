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
  // 放一个「活锁」：owner 是别人、刚创建
  fs.writeFileSync(path.join(dir, 'write-failures.jsonl.lock'), JSON.stringify({ owner: 'other', at: Date.now() }), 'utf8');
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
