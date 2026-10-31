// 一次性升级工具：给「V3.1 升级前就存在的事件」补上重要度档位，并生成 S3 独立副本。
//
// 背景：重要度分档是 V3.1 才加的。更早写入的事件（含 migrate-memory-v3 迁移进来的历史）
// 没有 `s` 字段，虽然读取时会按规则现算，但：
//   1. 每次检索都要重算一遍（慢一点）；
//   2. salient.jsonl（「重要的事单独存」）里不会有历史的关键事件。
//
// 这个脚本把 `s` 写回事件行，并把 S3 补进 salient.jsonl。幂等：重复跑不会重复。
//
// 用法：node scripts/backfill-memory-salience.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { salience } from '../src/core/memory-lib.mjs';
import { createMemoryStore } from '../src/core/memory-store.mjs';
import { scriptWriteMode, enterMaintenanceForScript, finishMaintenance } from './lib/maintenance-run.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const dirArg = (() => { const i = argv.indexOf('--dir'); return i >= 0 ? argv[i + 1] : null; })();
const MEMORY_DIR = dirArg ? path.resolve(dirArg) : path.join(root, 'state', 'memory');
// 写模式契约：默认只预览，--apply 才写盘；--dry-run 保留为兼容别名。
const { apply: APPLY, dryRun: DRY_RUN } = scriptWriteMode(process.argv.slice(2));
// 契约变化提示：旧版本默认写盘，现在必须显式 --apply。
console.log(APPLY ? '[模式] 应用（已获取维护门）' : '[模式] 预览（不写盘）');
if (!APPLY) console.log('[提示] 旧版本默认写盘；现在必须显式添加 --apply。');

// gate 覆盖「扫描事件 → 计算档位 → 写回事件/S3/压缩层」整段。
let maintenance = null;
if (APPLY) {
  maintenance = enterMaintenanceForScript({
    memoryDir: MEMORY_DIR,
    command: 'backfill-salience',
    forceUnlocked: process.argv.includes('--force-unlocked'),
  });
}

const store = createMemoryStore({ dir: MEMORY_DIR });
const eventsDir = path.join(MEMORY_DIR, 'events');
const salientFile = path.join(MEMORY_DIR, 'salient.jsonl');

function keyOf(row) {
  return `${Number(row.t) || 0}|${String(row.k || '')}|${String(row.text || '').slice(0, 60)}`;
}

// 已有 salient 索引
const salientIndex = new Set();
try {
  for (const line of fs.readFileSync(salientFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      salientIndex.add(keyOf(JSON.parse(line)));
    } catch {}
  }
} catch {
  // 文件还不存在
}

const days = store.listEventDays();
let scanned = 0;
let patchedRows = 0;
let salientAdded = 0;
const newSalient = [];

for (const day of days) {
  const file = path.join(eventsDir, `${day}.jsonl`);
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    continue;
  }
  let changed = false;
  const out = [];
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      out.push(line); // 坏行原样保留
      continue;
    }
    scanned += 1;
    if (!Number.isInteger(row.s)) {
      row.s = salience(row);
      changed = true;
      patchedRows += 1;
    }
    out.push(JSON.stringify(row));
    if (row.s >= 3) {
      const key = keyOf(row);
      if (!salientIndex.has(key)) {
        salientIndex.add(key);
        newSalient.push({ ...row, srcDay: day });
        salientAdded += 1;
      }
    }
  }
  if (changed && !DRY_RUN) fs.writeFileSync(file, `${out.join('\n')}\n`, 'utf8');
}

console.log(`扫描 ${days.length} 天 / ${scanned} 条事件`);
console.log(`补写档位 ${patchedRows} 条`);
console.log(`新增 S3 独立副本 ${salientAdded} 条`);
if (DRY_RUN) {
  console.log('--dry-run：没有写入任何文件。');
  process.exit(0);
}
if (newSalient.length) {
  fs.appendFileSync(salientFile, `${newSalient.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

// 重算日/周/月压缩层（旧摘要可能没有 tiers）
const { days: d, weeks, months } = store.ensureConsolidation({});
console.log(`压缩层补齐：日 ${d} / 周 ${weeks} / 月 ${months}`);

const st = store.stats({});
console.log(`\n分档：S0 ${st.salience.S0} / S1 ${st.salience.S1} / S2 ${st.salience.S2} / S3 ${st.salience.S3}（寒暄占比 ${st.salience.寒暄占比}）`);
console.log(`S3 独立副本：${st.salient.count} 条，${(st.salient.bytes / 1024).toFixed(1)} KB`);
if (maintenance) { const code = finishMaintenance(maintenance); if (code) process.exitCode = code; }
