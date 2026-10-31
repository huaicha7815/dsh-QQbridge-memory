// 状态矩阵：层 × 故障 × 入口。
//
// 为什么单独一个文件：前 39 轮审查里，绝大多数阻断都是同一个根因换了入口 ——
// 「文件读不到 / 内容坏 / 锁状态未知」被当成「没有数据 / 没在运行」。
// 逐个入口补 catch 永远补不完，所以这里按矩阵跑：
//
//   层：events / archive / days / weeks / months / profile / usage / salient / lock
//   故障：ENOENT、EACCES、EIO、坏语法、坏 schema、坏行、锁损坏/未知
//   入口：search / stats / inspect / auditSummaries / writeProfile / 锁检查
//
// 每个场景断言三条不变量：
//   1) 入口不崩；
//   2) 故障可见（readErrors / parseErrorLines / corruptJsonFileCount / profileRead 至少一项）；
//   3) 非 apply 入口零写盘（目录快照前后一致）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createMemoryStore } from '../src/core/memory-store.mjs';
import { bridgeLockState } from './lib/maintenance.mjs';

const DAY = '2026-01-05';

/** 某天的日摘要文件路径。 */
function targetDay(dir) {
  return path.join(dir, 'days', `${DAY}.json`);
}
const TS = new Date('2026-01-05T12:00:00').getTime();

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-matrix-'));
  const store = createMemoryStore({ dir });
  store.appendEvent({ id: 'e1', t: TS, k: 'group:1', kind: 'msg', text: '状态矩阵事件', s: 2 });
  fs.mkdirSync(path.join(dir, 'days'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'days', `${DAY}.json`),
    JSON.stringify({ day: DAY, count: 1, lines: [{ t: '状态矩阵摘要', s: 2 }] }),
    'utf8',
  );
  return { dir, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

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

const ORIG = { statSync: fs.statSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, existsSync: fs.existsSync };

function restoreFs() {
  fs.statSync = ORIG.statSync;
  fs.readFileSync = ORIG.readFileSync;
  fs.readdirSync = ORIG.readdirSync;
  fs.existsSync = ORIG.existsSync;
}

/** 让 fs[name] 对目标路径抛指定的 IO 错误；existsSync 同时返回 false（模拟 Node 真实行为）。 */
function injectIoFailure(name, target, code = 'EACCES') {
  const orig = fs[name];
  fs[name] = (p, ...rest) => {
    if (String(p) === target) {
      const error = new Error(`${code}: 状态矩阵注入`);
      error.code = code;
      throw error;
    }
    return orig(p, ...rest);
  };
  if (name === 'statSync' || name === 'readFileSync') {
    const origExists = fs.existsSync;
    fs.existsSync = (p) => (String(p) === target ? false : origExists(p));
  }
}

/**
 * 故障可见性断言：必须吃「故障仍生效时」的 stats 快照。
 * 恢复 FS 再取一次 stats 会把刚登记的故障清掉（读取成功 = 状态恢复），那就测不到东西了。
 */
function assertVisible(stats, label) {
  const visible = (stats.readErrors || 0) > 0
    || (stats.parseErrorLines || 0) > 0
    || (stats.corruptJsonFileCount || 0) > 0
    || Boolean(stats.profileRead && (stats.profileRead.corrupt || stats.profileRead.readError));
  assert.ok(visible, `${label}：故障不可见（readErrors/parseErrorLines/corruptJsonFileCount/profileRead 全为 0）`);
}

/** 跑一组入口，断言全部不崩；返回最后一份 stats（在故障仍生效时取）。 */
function runEntries(store, entries, label) {
  let lastStats = null;
  for (const [name, fn] of entries) {
    try {
      fn(store);
    } catch (error) {
      assert.fail(`${label} / ${name} 抛错：${error.message}`);
    }
  }
  try {
    lastStats = store.stats();
  } catch (error) {
    assert.fail(`${label} / stats 抛错：${error.message}`);
  }
  return lastStats;
}

const READ_ENTRIES = [
  ['search', (s) => s.search('状态矩阵', { days: 30 })],
  ['stats', (s) => s.stats()],
  ['inspect', (s) => s.inspect()],
  ['auditSummaries', (s) => s.auditSummaries()],
];

function scenario(label, { seed, inject, entries = READ_ENTRIES, expect }) {
  test(`状态矩阵：${label}`, () => {
    const { dir, store, cleanup } = makeStore();
    try {
      if (seed) seed(dir);
      const before = snapshotTree(dir);
      inject(dir, store);
      // 入口 + 断言都在「故障仍生效」时执行：可见性/写保护看的是当下的状态，
      // 一旦恢复文件系统，读取成功本身就会解除这些状态。
      const stats = runEntries(store, entries, label);
      if (expect) expect(store, stats);
      else assertVisible(stats, label);
      restoreFs();
      const after = snapshotTree(dir);
      // search/inspect 会写 recall-log/usage（检索日志与热度），这是设计内的运行时数据；
      // *.corrupt 是首次发现损坏时的保护性备份（既有机制）。
      // 其余任何数据文件都不允许被诊断路径改写。
      const RUNTIME = new Set(['recall-log.jsonl', 'usage.json']);
      const changed = Object.keys(after)
        .filter((rel) => !RUNTIME.has(rel))
        .filter((rel) => !rel.endsWith('.corrupt'))
        .filter((rel) => before[rel] !== after[rel]);
      assert.deepEqual(changed, [], `${label}：诊断路径不能改写数据文件（${changed.join('、')}）`);
    } finally {
      restoreFs();
      cleanup();
    }
  });
}

// ── events 层 ───────────────────────────────────────────────────────
for (const code of ['EACCES', 'EIO']) {
  scenario(`events 日文件 stat ${code}`, {
    inject: (dir) => injectIoFailure('statSync', path.join(dir, 'events', `${DAY}.jsonl`), code),
  });
  scenario(`events 日文件 read ${code}`, {
    inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'events', `${DAY}.jsonl`), code),
  });
}

scenario('events 坏行（null / 字符串 / 数组 / {}）', {
  seed: (dir) => fs.appendFileSync(
    path.join(dir, 'events', `${DAY}.jsonl`),
    'null\n"字符串"\n[1,2]\n{}\n',
    'utf8',
  ),
  inject: () => {},
  expect: (store) => {
    const st = store.stats();
    assert.equal(st.parseErrorLines, 4, '四条结构错误都要计入坏行');
  },
});

scenario('events 目录 readdir EACCES', {
  inject: (dir) => injectIoFailure('readdirSync', path.join(dir, 'events'), 'EACCES'),
});

// ── archive 层 ──────────────────────────────────────────────────────
scenario('归档月文件 read EACCES', {
  seed: (dir) => {
    fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'events-archive', '2026-01.jsonl'), JSON.stringify({ id: 'a1', t: TS, k: 'group:1', kind: 'msg', text: '归档', s: 2 }) + '\n', 'utf8');
  },
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'events-archive', '2026-01.jsonl'), 'EACCES'),
});

// ── days 层 ─────────────────────────────────────────────────────────
scenario('日摘要语法坏', {
  seed: (dir) => fs.writeFileSync(path.join(dir, 'days', `${DAY}.json`), '{ 坏 JSON', 'utf8'),
  inject: () => {},
  expect: (store) => {
    const st = store.stats();
    assert.ok(st.corruptJsonFileCount >= 1, '语法坏要登记');
    assert.equal(st.corruptJsonReasons[`${DAY}.json`], 'syntax');
  },
});

scenario('日摘要 schema 坏（lines 不是数组）', {
  seed: (dir) => fs.writeFileSync(targetDay(dir), JSON.stringify({ day: DAY, count: 1, lines: '坏' }), 'utf8'),
  inject: () => {},
  expect: (store) => {
    const st = store.stats();
    assert.ok(st.corruptJsonFileCount >= 1, 'schema 坏要登记');
    assert.equal(st.corruptJsonReasons[`${DAY}.json`], 'schema');
  },
});

scenario('日摘要 read EIO', {
  inject: (dir) => injectIoFailure('readFileSync', targetDay(dir), 'EIO'),
});

// ── weeks / months 层 ───────────────────────────────────────────────
scenario('weeks 目录 readdir EACCES', {
  // 目录必须真实存在，EACCES 才有意义（不存在时 readdir 抛的是 ENOENT，
  // 那是正常空态，登记会被「确定不存在」清理掉——不是本场景要测的东西）。
  seed: (dir) => fs.mkdirSync(path.join(dir, 'weeks'), { recursive: true }),
  inject: (dir) => injectIoFailure('readdirSync', path.join(dir, 'weeks'), 'EACCES'),
});

scenario('months 文件 schema 坏', {
  seed: (dir) => {
    fs.mkdirSync(path.join(dir, 'months'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'months', '2025-12.json'), JSON.stringify({ month: '2025-12', count: 1, lines: '坏' }), 'utf8');
  },
  inject: () => {},
  expect: (store) => {
    const st = store.stats();
    const audit = store.auditSummaries();
    assert.ok(audit.corrupt.some((c) => c.file === '2025-12.json'), '主动审计要发现');
    assert.ok(st.corruptJsonFileCount >= 1);
  },
});

// ── profile 层 ──────────────────────────────────────────────────────
for (const body of ['[]', '"字符串"', '{"people":[]}']) {
  scenario(`profile 顶层结构坏（${body}）`, {
    seed: (dir) => fs.writeFileSync(path.join(dir, 'profile.json'), body, 'utf8'),
    inject: () => {},
    expect: (store) => {
      const state = store.readState();
      assert.equal(state.corrupt, true, '要标记 corrupt');
      assert.equal(state.writable, false, '写保护要生效');
      assert.equal(store.writeProfile(store.readProfile()), false, '不能覆盖');
    },
  });
}

scenario('profile 读 EIO', {
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'profile.json'), 'EIO'),
  expect: (store) => {
    const state = store.readState();
    assert.equal(state.writable, false, '读不到时写保护要生效');
    assert.equal(store.writeProfile(store.readProfile()), false);
  },
});

// ── usage / salient 层 ──────────────────────────────────────────────
scenario('usage schema 坏', {
  seed: (dir) => fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ hits: '坏' }), 'utf8'),
  inject: () => {},
  expect: (store) => {
    const st = store.stats();
    assert.ok(st.corruptFiles.includes('usage.json'), 'usage 坏要可见');
  },
});

scenario('salient 坏行', {
  seed: (dir) => {
    fs.writeFileSync(path.join(dir, 'salient.jsonl'), JSON.stringify({ id: 's1', t: TS, k: 'g:1', text: '好行', s: 3 }) + '\n{"broken":\n', 'utf8');
  },
  inject: () => {},
  expect: (store) => {
    assert.ok(store.stats().parseErrorLines >= 1, 'S3 坏行要计入');
  },
});

// ── 锁层（直接测共享库，不依赖 CLI） ────────────────────────────────
test('状态矩阵：bridge.lock 四态判定', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-matrix-'));
  try {
    const lock = path.join(base, 'bridge.lock');
    assert.equal(bridgeLockState(lock).state, 'missing', '不存在 = missing');

    fs.writeFileSync(lock, 'not-a-valid-pid', 'utf8');
    assert.equal(bridgeLockState(lock).state, 'unknown', '损坏内容 = unknown');

    fs.writeFileSync(lock, '', 'utf8');
    assert.equal(bridgeLockState(lock).state, 'unknown', '空文件 = unknown');

    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), 'utf8');
    assert.equal(bridgeLockState(lock).state, 'running', '存活 PID = running');

    const dead = spawnSync(process.execPath, ['-e', '0'], { timeout: 10000 });
    fs.writeFileSync(lock, String(dead.pid), 'utf8');
    assert.equal(bridgeLockState(lock).state, 'stopped', '已退出 PID = stopped');

    assert.equal(bridgeLockState(path.join(base, 'nope.lock'), { explicit: true }).state, 'unknown', '显式路径不存在 = unknown');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

