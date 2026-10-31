// 状态矩阵：层 × 故障 × 入口（数据驱动）。
//
// 为什么单独一个文件：前 39 轮审查里，绝大多数阻断都是同一个根因换了入口 ——
// 「文件读不到 / 内容坏 / 锁状态未知」被当成「没有数据 / 没在运行」。
// 逐个入口补 catch 永远补不完，所以这里按矩阵跑。
//
// 每个场景声明：
//   label        测的是什么（失败信息里能看出是哪一格）
//   entries      入口列表（READ_ENTRIES 或控制面入口）
//   expectMetric 期望命中的指标（字段 + 文件 + 原因），**必须命中这一格**，
//                防止「别的故障凑出可见性」造成假通过
//   allowWrite   该入口允许写的文件（默认空：诊断路径零数据写入）
//
// 每个场景断言三条不变量：
//   1) 入口不崩；
//   2) 故障可见且命中声明的那一格；
//   3) 非 apply 入口不写数据文件（size/mtime/hash 三重比较，能抓同字节重写）。
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
const TS = new Date('2026-01-05T12:00:00').getTime();

/** 某天的日摘要文件路径。 */
function targetDay(dir) {
  return path.join(dir, 'days', `${DAY}.json`);
}

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-matrix-'));
  const store = createMemoryStore({ dir });
  store.appendEvent({ id: 'e1', t: TS, k: 'group:1', kind: 'msg', text: '状态矩阵事件', s: 2 });
  fs.mkdirSync(path.join(dir, 'days'), { recursive: true });
  fs.writeFileSync(
    targetDay(dir),
    JSON.stringify({ day: DAY, count: 1, lines: [{ t: '状态矩阵摘要', s: 2 }] }),
    'utf8',
  );
  return { dir, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 快照同时记录 size / mtime / hash：同字节重写（mtime 变）也能被发现。 */
function snapshotTree(dir) {
  const out = {};
  const walk = (cur, base) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) { walk(abs, rel); continue; }
      const stat = fs.statSync(abs);
      out[rel] = {
        size: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
        hash: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
      };
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

const ORIG = {
  statSync: fs.statSync,
  lstatSync: fs.lstatSync,
  readFileSync: fs.readFileSync,
  readdirSync: fs.readdirSync,
  existsSync: fs.existsSync,
};

function restoreFs() {
  fs.statSync = ORIG.statSync;
  fs.lstatSync = ORIG.lstatSync;
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
 * 故障可见性断言：必须命中场景声明的指标字段与文件，
 * 不能靠「别的故障让 readErrors 非零」凑数（审查指出过这个假通过）。
 */
function assertMetric(stats, metric, label) {
  const { field, file, reason } = metric;
  if (field === 'profileRead') {
    assert.ok(
      stats.profileRead && (stats.profileRead.corrupt || stats.profileRead.readError),
      `${label}：profileRead 没有反映故障`,
    );
    return;
  }
  if (field === 'pendingUnreadable') {
    assert.equal(stats.pendingUnreadable, true, `${label}：pendingUnreadable 应为 true`);
    const reasons = stats.pendingUnreadableReasons || {};
    if (reason) {
      const keyMap = {
        manifest: 'manifest',
        overflow: 'overflow',
        snapshots: 'snapshots',
        snapshotsEnumeration: 'snapshotsEnumeration',
        quarantine: 'quarantine',
      };
      const key = keyMap[reason] || 'snapshots';
      assert.ok(reasons[key], `${label}：pendingUnreadableReasons.${key} 没有命中`);
    }
    return;
  }
  if (field === 'failureManifestWriteError') {
    assert.ok(stats.failureManifestWriteError, `${label}：failureManifestWriteError 为空（恢复线索丢失但不可见）`);
    return;
  }
  const value = stats[field] || 0;
  if (field === 'corruptJsonFileCount') {
    assert.ok(value > 0, `${label}：corruptJsonFileCount 为 0`);
    if (file) {
      const reasons = stats.corruptJsonReasons || {};
      const hit = Object.keys(reasons).some((name) => name.includes(file));
      assert.ok(hit, `${label}：损坏名单里没有 ${file}（实际 ${JSON.stringify(Object.keys(reasons))}）`);
      if (reason) {
        const actual = Object.entries(reasons).find(([name]) => name.includes(file))?.[1];
        assert.equal(actual, reason, `${label}：损坏原因应为 ${reason}，实际 ${actual}`);
      }
    }
    return;
  }
  assert.ok(value > 0, `${label}：${field} 为 0`);
  if (file) {
    const names = Array.isArray(stats.unreadableFiles) ? stats.unreadableFiles : [];
    assert.ok(
      names.some((name) => name.includes(file)),
      `${label}：unreadableFiles 里没有 ${file}（实际 ${JSON.stringify(names)}）`,
    );
  }
}

/** 跑一组入口，断言全部不崩；返回最后一份 stats（在故障仍生效时取）。 */
function runEntries(store, entries, label) {
  for (const [name, fn] of entries) {
    try {
      fn(store);
    } catch (error) {
      assert.fail(`${label} / ${name} 抛错：${error.message}`);
    }
  }
  try {
    return store.stats();
  } catch (error) {
    assert.fail(`${label} / stats 抛错：${error.message}`);
  }
}

const READ_ENTRIES = [
  ['search', (s) => s.search('状态矩阵', { days: 30 })],
  ['stats', (s) => s.stats()],
  ['inspect', (s) => s.inspect()],
  ['auditSummaries', (s) => s.auditSummaries()],
];

// 运行中会写的文件：search/inspect 记录召回日志与热度，属于设计内行为。
const RUNTIME_FILES = new Set(['recall-log.jsonl', 'usage.json']);

/**
 * before/after 三重快照比较。
 *   allowWrite  允许内容变化（运行时会写的文件，如 recall-log）
 *   allowTouch  允许 mtime 变化但内容必须不变（rename 恢复现场、同内容重写清单）
 *   allowCorrupt  允许创建 *.corrupt（仅明确声明允许备份的入口）
 */
function assertNoUnexpectedWrites(before, after, {
  allowWrite = [], allowTouch = [], allowCorrupt = false, allowDelete = [],
} = {}, label) {
  const writable = new Set([...RUNTIME_FILES, ...allowWrite]);
  const touchable = new Set(allowTouch);
  const deletable = new Set(allowDelete);
  // 用并集：只看 after 的键会漏掉「入口把文件删了」（删除只体现在 before 里）。
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...allKeys]
    .filter((rel) => !writable.has(rel))
    .filter((rel) => !(allowCorrupt && rel.endsWith('.corrupt')))
    .filter((rel) => {
      const prev = before[rel];
      const cur = after[rel];
      if (!prev) return true; // 新增文件（不在 allowWrite/allowCorrupt 里）
      if (!cur) return !deletable.has(rel); // 删除：只有显式 allowDelete 才允许
      if (touchable.has(rel)) return prev.hash !== cur.hash; // 只允许 mtime/size 变，内容不变
      return prev.size !== cur.size || prev.mtimeMs !== cur.mtimeMs || prev.hash !== cur.hash;
    });
  assert.deepEqual(changed, [], `${label}：诊断路径改写了数据文件（${changed.join('、')}）`);
}

function scenario(label, {
  seed, inject, entries = READ_ENTRIES, expectMetric, allowWrite, allowTouch, allowCorrupt, allowDelete,
}) {
  test(`状态矩阵：${label}`, () => {
    const { dir, store, cleanup } = makeStore();
    try {
      if (seed) seed(dir);
      const before = snapshotTree(dir);
      inject(dir, store);
      const stats = runEntries(store, entries, label);
      assertMetric(stats, expectMetric, label);
      restoreFs();
      const after = snapshotTree(dir);
      assertNoUnexpectedWrites(before, after, { allowWrite, allowTouch, allowCorrupt, allowDelete }, label);
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
    expectMetric: { field: 'readErrors', file: `${DAY}.jsonl` },
  });
  scenario(`events 日文件 read ${code}`, {
    inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'events', `${DAY}.jsonl`), code),
    expectMetric: { field: 'readErrors', file: `${DAY}.jsonl` },
  });
}

scenario('events 坏行（null / 字符串 / 数组 / {}）', {
  seed: (dir) => fs.appendFileSync(path.join(dir, 'events', `${DAY}.jsonl`), 'null\n"字符串"\n[1,2]\n{}\n', 'utf8'),
  inject: () => {},
  expectMetric: { field: 'parseErrorLines' },
});

scenario('events 目录 readdir EACCES', {
  inject: (dir) => injectIoFailure('readdirSync', path.join(dir, 'events'), 'EACCES'),
  expectMetric: { field: 'readErrors', file: 'events' },
});

// ── archive 层 ──────────────────────────────────────────────────────
scenario('归档月文件 read EACCES', {
  seed: (dir) => {
    fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'events-archive', '2026-01.jsonl'), JSON.stringify({ id: 'a1', t: TS, k: 'group:1', kind: 'msg', text: '归档', s: 2 }) + '\n', 'utf8');
  },
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'events-archive', '2026-01.jsonl'), 'EACCES'),
  expectMetric: { field: 'readErrors', file: '2026-01.jsonl' },
});

scenario('归档目录 readdir EACCES', {
  seed: (dir) => fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true }),
  inject: (dir) => injectIoFailure('readdirSync', path.join(dir, 'events-archive'), 'EACCES'),
  expectMetric: { field: 'readErrors', file: 'events-archive' },
});

// ── days 层 ─────────────────────────────────────────────────────────
scenario('日摘要语法坏', {
  seed: (dir) => fs.writeFileSync(targetDay(dir), '{ 坏 JSON', 'utf8'),
  inject: () => {},
  expectMetric: { field: 'corruptJsonFileCount', file: `${DAY}.json`, reason: 'syntax' },
});

scenario('日摘要 schema 坏（lines 不是数组）', {
  seed: (dir) => fs.writeFileSync(targetDay(dir), JSON.stringify({ day: DAY, count: 1, lines: '坏' }), 'utf8'),
  inject: () => {},
  expectMetric: { field: 'corruptJsonFileCount', file: `${DAY}.json`, reason: 'schema' },
});

scenario('日摘要 read EIO', {
  inject: (dir) => injectIoFailure('readFileSync', targetDay(dir), 'EIO'),
  expectMetric: { field: 'readErrors', file: `${DAY}.json` },
});

scenario('days 目录 readdir EACCES', {
  inject: (dir) => injectIoFailure('readdirSync', path.join(dir, 'days'), 'EACCES'),
  expectMetric: { field: 'readErrors', file: 'days' },
});

// ── weeks 层 ────────────────────────────────────────────────────────
scenario('weeks 文件 schema 坏', {
  seed: (dir) => {
    fs.mkdirSync(path.join(dir, 'weeks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'weeks', '2025-W52.json'), JSON.stringify({ week: '2025-W52', count: 1, lines: '坏' }), 'utf8');
  },
  inject: () => {},
  expectMetric: { field: 'corruptJsonFileCount', file: '2025-W52.json', reason: 'schema' },
});

scenario('weeks 目录 readdir EACCES', {
  // 目录必须真实存在，EACCES 才有意义（不存在时 readdir 抛 ENOENT，是正常空态）。
  seed: (dir) => fs.mkdirSync(path.join(dir, 'weeks'), { recursive: true }),
  inject: (dir) => injectIoFailure('readdirSync', path.join(dir, 'weeks'), 'EACCES'),
  expectMetric: { field: 'readErrors', file: 'weeks' },
});

// ── months 层 ───────────────────────────────────────────────────────
scenario('months 文件 schema 坏', {
  seed: (dir) => {
    fs.mkdirSync(path.join(dir, 'months'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'months', '2025-12.json'), JSON.stringify({ month: '2025-12', count: 1, lines: '坏' }), 'utf8');
  },
  inject: () => {},
  expectMetric: { field: 'corruptJsonFileCount', file: '2025-12.json', reason: 'schema' },
});

scenario('months 目录 readdir EACCES', {
  seed: (dir) => fs.mkdirSync(path.join(dir, 'months'), { recursive: true }),
  inject: (dir) => injectIoFailure('readdirSync', path.join(dir, 'months'), 'EACCES'),
  expectMetric: { field: 'readErrors', file: 'months' },
});

// ── profile 层 ──────────────────────────────────────────────────────
for (const body of ['[]', '"字符串"', '{"people":[]}']) {
  scenario(`profile 顶层结构坏（${body}）`, {
    seed: (dir) => fs.writeFileSync(path.join(dir, 'profile.json'), body, 'utf8'),
    inject: () => {},
    expectMetric: { field: 'profileRead' },
    entries: [
      ['stats', (s) => s.stats()],
      ['inspect', (s) => s.inspect()],
    ],
    // stats/inspect 是「首次发现损坏」的入口，允许做一次保护性备份（.corrupt）。
    allowCorrupt: true,
  });
}

scenario('profile 语法坏', {
  seed: (dir) => fs.writeFileSync(path.join(dir, 'profile.json'), '{ 坏 JSON', 'utf8'),
  inject: () => {},
  expectMetric: { field: 'profileRead' },
  allowCorrupt: true,
});

scenario('profile 读 EACCES', {
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'profile.json'), 'EACCES'),
  expectMetric: { field: 'profileRead' },
});

scenario('profile 读 EIO', {
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'profile.json'), 'EIO'),
  expectMetric: { field: 'profileRead' },
});

// ── usage / salient 层 ──────────────────────────────────────────────
scenario('usage schema 坏', {
  seed: (dir) => fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ hits: '坏' }), 'utf8'),
  inject: () => {},
  expectMetric: { field: 'corruptJsonFileCount', file: 'usage.json', reason: 'schema' },
  allowCorrupt: true,
});

scenario('salient 坏行', {
  seed: (dir) => fs.writeFileSync(
    path.join(dir, 'salient.jsonl'),
    JSON.stringify({ id: 's1', t: TS, k: 'g:1', text: '好行', s: 3 }) + '\n{"broken":\n',
    'utf8',
  ),
  inject: () => {},
  expectMetric: { field: 'parseErrorLines' },
});

// ── 恢复控制面：失败清单 / replay / migrate / recover / repair ─────────
scenario('失败清单 write-failures 读 EACCES', {
  seed: (dir) => fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: TS, phase: 'event', id: 'pending-1', row: { id: 'pending-1', t: TS, k: 'g:1', kind: 'msg', text: '待恢复', s: 2 } }) + '\n',
    'utf8',
  ),
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'write-failures.jsonl'), 'EACCES'),
  entries: [['stats', (s) => s.stats()], ['inspect', (s) => s.inspect()]],
  expectMetric: { field: 'readErrors', file: 'write-failures.jsonl' },
});

scenario('replay 在 L1 判重读失败时不写', {
  seed: (dir) => fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: TS, phase: 'event', id: 'e1', row: { id: 'e1', t: TS, k: 'g:1', kind: 'msg', text: '同一条', s: 2 } }) + '\n',
    'utf8',
  ),
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'events', `${DAY}.jsonl`), 'EACCES'),
  entries: [['replay', (s) => s.replayWriteFailures({ dryRun: false })]],
  expectMetric: { field: 'readErrors', file: `${DAY}.jsonl` },
  allowTouch: ['write-failures.jsonl'],
});

scenario('migrate 在失败清单读失败时不写', {
  seed: (dir) => fs.writeFileSync(
    path.join(dir, 'write-failures.jsonl'),
    JSON.stringify({ at: TS, phase: 'event', row: { id: 'x', t: TS, k: 'g:1', kind: 'msg', text: '旧格式' } }) + '\n',
    'utf8',
  ),
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'write-failures.jsonl'), 'EACCES'),
  entries: [['migrate', (s) => s.migrateLegacyRecords({ dryRun: false })]],
  expectMetric: { field: 'readErrors', file: 'write-failures.jsonl' },
  allowTouch: ['write-failures.jsonl'],
});

scenario('recover-archive 在归档目录读失败时不写', {
  // 目录真实存在才可能 EACCES；不存在时 readdir 抛 ENOENT，那是正常空态。
  seed: (dir) => fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true }),
  inject: (dir) => injectIoFailure('readdirSync', path.join(dir, 'events-archive'), 'EACCES'),
  entries: [['recover', (s) => s.recoverArchiveSnapshots({ dryRun: false })]],
  expectMetric: { field: 'readErrors', file: 'events-archive' },
});

scenario('repairSummaries 预览在摘要坏时不写', {
  seed: (dir) => fs.writeFileSync(targetDay(dir), JSON.stringify({ day: DAY, count: 1, lines: '坏' }), 'utf8'),
  inject: () => {},
  entries: [['repairPreview', (s) => s.repairSummaries({ dryRun: true })]],
  expectMetric: { field: 'corruptJsonFileCount', file: `${DAY}.json`, reason: 'schema' },
});

// ── 追加格：归档/摘要/账本的 P0/P1 故障（审查给的下一档预算） ────────
scenario('归档目录 readdir EACCES（replay 判重必须 unknown）', {
  seed: (dir) => {
    fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'events-archive', '2026-01.jsonl'), JSON.stringify({ id: 'same', t: TS, k: 'g:1', kind: 'msg', text: '归档同 id', s: 2 }) + '\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'write-failures.jsonl'),
      JSON.stringify({ at: TS, phase: 'event', id: 'same', row: { id: 'same', t: TS, k: 'g:1', kind: 'msg', text: '归档同 id', s: 2 } }) + '\n',
      'utf8',
    );
  },
  inject: (dir) => injectIoFailure('readdirSync', path.join(dir, 'events-archive'), 'EACCES'),
  entries: [['replay', (s) => s.replayWriteFailures({ dryRun: false })]],
  expectMetric: { field: 'readErrors', file: 'events-archive' },
  allowTouch: ['write-failures.jsonl'],
});

scenario('归档月文件 stat EIO', {
  seed: (dir) => {
    fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'events-archive', '2026-01.jsonl'), JSON.stringify({ id: 'a1', t: TS, k: 'g:1', kind: 'msg', text: '归档', s: 2 }) + '\n', 'utf8');
  },
  inject: (dir) => injectIoFailure('statSync', path.join(dir, 'events-archive', '2026-01.jsonl'), 'EIO'),
  expectMetric: { field: 'readErrors', file: '2026-01.jsonl' },
});

scenario('归档月文件坏行', {
  seed: (dir) => {
    fs.mkdirSync(path.join(dir, 'events-archive'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'events-archive', '2026-01.jsonl'), JSON.stringify({ id: 'a1', t: TS, k: 'g:1', kind: 'msg', text: '归档', s: 2 }) + '\nnull\n', 'utf8');
  },
  inject: () => {},
  expectMetric: { field: 'parseErrorLines' },
});

scenario('日摘要 read EACCES', {
  inject: (dir) => injectIoFailure('readFileSync', targetDay(dir), 'EACCES'),
  expectMetric: { field: 'readErrors', file: `${DAY}.json` },
  allowCorrupt: true,
});

scenario('周要点 read EIO', {
  seed: (dir) => {
    fs.mkdirSync(path.join(dir, 'weeks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'weeks', '2025-W52.json'), JSON.stringify({ week: '2025-W52', count: 1, lines: [{ t: 'x', s: 2 }] }), 'utf8');
  },
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'weeks', '2025-W52.json'), 'EIO'),
  expectMetric: { field: 'readErrors', file: '2025-W52.json' },
});

scenario('周要点语法坏', {
  seed: (dir) => {
    fs.mkdirSync(path.join(dir, 'weeks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'weeks', '2025-W52.json'), '{ 坏 JSON', 'utf8');
  },
  inject: () => {},
  expectMetric: { field: 'corruptJsonFileCount', file: '2025-W52.json', reason: 'syntax' },
  allowCorrupt: true,
});

scenario('月要点 read EIO', {
  seed: (dir) => {
    fs.mkdirSync(path.join(dir, 'months'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'months', '2025-12.json'), JSON.stringify({ month: '2025-12', count: 1, lines: [{ t: 'x', s: 2 }] }), 'utf8');
  },
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'months', '2025-12.json'), 'EIO'),
  expectMetric: { field: 'readErrors', file: '2025-12.json' },
});

scenario('月要点语法坏', {
  seed: (dir) => {
    fs.mkdirSync(path.join(dir, 'months'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'months', '2025-12.json'), '{ 坏 JSON', 'utf8');
  },
  inject: () => {},
  expectMetric: { field: 'corruptJsonFileCount', file: '2025-12.json', reason: 'syntax' },
  allowCorrupt: true,
});

scenario('usage read EACCES', {
  seed: (dir) => fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ hits: {} }), 'utf8'),
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'usage.json'), 'EACCES'),
  expectMetric: { field: 'readErrors', file: 'usage.json' },
});

scenario('overflow 账本读 EACCES → pendingUnreadable', {
  seed: (dir) => {
    fs.writeFileSync(path.join(dir, 'write-failures.jsonl'), '', 'utf8');
    fs.writeFileSync(path.join(dir, 'write-failures.jsonl.overflow'), '3\n', 'utf8');
  },
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'write-failures.jsonl.overflow'), 'EACCES'),
  entries: [['stats', (s) => s.stats()]],
  expectMetric: { field: 'pendingUnreadable', reason: 'overflow' },
});

scenario('processing 快照读 EACCES → pendingUnreadable', {
  seed: (dir) => {
    fs.writeFileSync(path.join(dir, 'write-failures.jsonl'), '', 'utf8');
    fs.writeFileSync(path.join(dir, 'write-failures.jsonl.processing-1'), JSON.stringify({ at: TS, phase: 'event', id: 'p1', row: { id: 'p1', t: TS, k: 'g:1', kind: 'msg', text: '待恢复', s: 2 } }) + '\n', 'utf8');
  },
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'write-failures.jsonl.processing-1'), 'EACCES'),
  entries: [['stats', (s) => s.stats()]],
  expectMetric: { field: 'pendingUnreadable', reason: 'snapshots' },
});

scenario('recordWriteFailure 连清单都写不进去 → failureManifestWriteError 可见', {
  seed: (dir) => fs.mkdirSync(path.join(dir, 'events'), { recursive: true }),
  inject: () => {},
  entries: [['append', (s) => {
    const origAppend = fs.appendFileSync;
    fs.appendFileSync = (p, ...rest) => {
      const target = String(p);
      if (target.includes('write-failures') || target.includes(`${path.sep}events${path.sep}`)) {
        const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e;
      }
      return origAppend(p, ...rest);
    };
    try {
      s.appendEvent({ id: 'fail-1', t: TS, k: 'g:1', kind: 'msg', text: '写不进去', s: 2 });
    } finally {
      fs.appendFileSync = origAppend;
    }
  }]],
  expectMetric: { field: 'failureManifestWriteError' },
});

scenario('失败快照根目录枚举 EACCES → pendingUnreadable', {
  seed: (dir) => {
    fs.writeFileSync(path.join(dir, 'write-failures.jsonl'), '', 'utf8');
    fs.writeFileSync(path.join(dir, 'write-failures.jsonl.processing-old'), JSON.stringify({ at: TS, phase: 'event', id: 'old-1', row: { id: 'old-1', t: TS, k: 'g:1', kind: 'msg', text: '遗留快照', s: 2 } }) + '\n', 'utf8');
  },
  inject: (dir) => injectIoFailure('readdirSync', dir, 'EACCES'),
  entries: [['stats', (s) => s.stats()]],
  expectMetric: { field: 'pendingUnreadable', reason: 'snapshotsEnumeration' },
});

scenario('quarantine 读 EACCES → pendingUnreadable', {
  seed: (dir) => {
    fs.writeFileSync(path.join(dir, 'write-failures.jsonl'), '', 'utf8');
    fs.writeFileSync(path.join(dir, 'write-failures.jsonl.quarantine'), JSON.stringify({ at: TS, bad: true }) + '\n', 'utf8');
  },
  inject: (dir) => injectIoFailure('readFileSync', path.join(dir, 'write-failures.jsonl.quarantine'), 'EACCES'),
  entries: [['stats', (s) => s.stats()]],
  expectMetric: { field: 'pendingUnreadable', reason: 'quarantine' },
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
