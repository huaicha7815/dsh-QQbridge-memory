#!/usr/bin/env node
/**
 * 回填历史事件的发送者（who）。
 *
 * 背景：V4.3 之前，私聊消息的发送者被写死成「私聊」，导致这些记忆在检索、
 * 档案、星图上都成了「没人认领」的悬空事件（who 是会话标签而不是人）。
 * 归档层已修（现在记真实昵称），但历史数据还在。好在线程里存了 uid，
 * 可以按「私聊对象 = ownerQQ」把 who 补回真实的人。
 *
 * 用法（默认只预览，不改文件）：
 *   node scripts/backfill-private-who.mjs --name 爸爸
 *   node scripts/backfill-private-who.mjs --name 爸爸 --uid 1477325291
 *   node scripts/backfill-private-who.mjs --name 爸爸 --uid 1477325291 --apply
 *
 * 参数：
 *   --name <名字>     回填成谁（必填；取自长期档案里的人物名）
 *   --uid <QQ号>      只回填这个 QQ 发的事件（默认用 config.ownerQQ）
 *   --all             不按 uid 过滤，所有 who 是会话标签的都回填（谨慎）
 *   --apply           真正写盘（会先备份成 .bak-<时间戳>）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterMaintenanceForScript, leaveMaintenance } from './lib/maintenance-run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const dirArg = (() => { const i = args.indexOf('--dir'); return i >= 0 ? args[i + 1] : null; })();
const MEMORY_DIR_WHO = dirArg ? path.resolve(dirArg) : path.join(ROOT, 'state', 'memory');
const EVENTS_DIR = path.join(MEMORY_DIR_WHO, 'events');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const name = String(opt('name') || '').trim();
const apply = args.includes('--apply');
// 回填会重写事件日文件：bridge 正在 append 同一天的事件时，整体重写会丢新行。
// gate 覆盖「扫描事件 → 计算 who → 备份 + 写回」整段（备份与写回必须同一把门）。
let maintenance = null;
if (apply) {
  maintenance = enterMaintenanceForScript({
    memoryDir: MEMORY_DIR_WHO,
    command: 'backfill-who',
    forceUnlocked: args.includes('--force-unlocked'),
  });
}
const all = args.includes('--all');
if (!name) {
  console.error('用法：node scripts/backfill-private-who.mjs --name 爸爸 [--uid 1477325291] [--apply]');
  process.exit(1);
}
let ownerQQ = String(opt('uid') || '').trim();
if (!ownerQQ && !all) {
  try {
    ownerQQ = String(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))?.ownerQQ ?? '').trim();
  } catch {}
  if (!ownerQQ) {
    console.error('没读到 config.json 的 ownerQQ；请显式传 --uid，或加 --all 表示不按 uid 过滤');
    process.exit(1);
  }
}

const NOISE = /^(私聊|群聊|群友|管理员|系统|我|你|他|她|\?|-)$/;
let files = [];
try {
  files = fs.readdirSync(EVENTS_DIR).filter((f) => f.endsWith('.jsonl')).sort();
} catch {
  console.error('没有找到事件目录：', EVENTS_DIR);
  process.exit(1);
}

let total = 0;
let hit = 0;
let skippedUid = 0;
const perDay = [];
const touched = [];

for (const file of files) {
  const full = path.join(EVENTS_DIR, file);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  let changed = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let e;
    try { e = JSON.parse(line); } catch { return line; }
    total += 1;
    const who = String(e?.who ?? '').trim();
    if (!NOISE.test(who)) return line;
    if (!all) {
      if (String(e?.uid ?? '') !== ownerQQ) { skippedUid += 1; return line; }
    }
    e.who = name;
    changed += 1;
    hit += 1;
    return JSON.stringify(e);
  });
  if (changed) {
    perDay.push([file.slice(0, 10), changed]);
    touched.push({ full, content: out.join('\n') });
  }
}

console.log(`事件总数 ${total} 条；可回填 ${hit} 条（回填成「${name}」${all ? '，不按 uid 过滤' : `，uid=${ownerQQ}`}）`);
if (skippedUid) console.log(`另有 ${skippedUid} 条 who 是会话标签但不属于该 uid，保持原样（来源不明，不猜）`);
if (perDay.length) console.log('按天：', perDay.map(([d, n]) => `${d}=${n}`).join(' '));
if (!hit) { console.log('没有需要回填的事件。'); process.exit(0); }
if (!apply) {
  console.log('\n（预览模式，未写盘。确认无误后加 --apply）');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const t of touched) {
  fs.copyFileSync(t.full, `${t.full}.bak-${stamp}`);
  fs.writeFileSync(t.full, t.content, 'utf8');
}
console.log(`\n已写回 ${touched.length} 个文件，备份后缀 .bak-${stamp}`);
console.log('提示：重启桥接后新事件会正常记录发送者；历史检索结果立刻可见。');
if (maintenance) leaveMaintenance(maintenance);
