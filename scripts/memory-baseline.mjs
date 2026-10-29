#!/usr/bin/env node
/**
 * 记忆库基线：把「今天的她」和「上次的她」放在一起比。
 *
 * 为什么要基线：测试和 health 只是「跑一次看一眼」，没有历史就发现不了
 * 缓慢的漂移——事件数突然暴跌、悬空率慢慢爬、认领率一路下滑，这些都只有
 * 跟上一版比才看得出来。
 *
 * 用法：
 *   node scripts/memory-baseline.mjs           对比最近一次基线（只读）
 *   node scripts/memory-baseline.mjs --save    把当前状态记为基线（写 state/memory/baseline.json）
 *   node scripts/memory-baseline.mjs --json    机器可读输出（给定时任务/脚本用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryStore } from '../src/core/memory-store.mjs';
import { auditProfile, buildMemoryGraph } from '../src/core/memory-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const BASELINE_FILE = path.join(root, 'state', 'memory', 'baseline.json');

/** 采集当前记忆库的可比指标。所有字段都是数字，方便直接做差。 */
export function collectMetrics(store, profile, now = Date.now()) {
  const st = store.stats({ now });
  const recent7 = store.readEvents({ days: 7 });
  const whoTag = /^(私聊|群聊|群友|管理员|系统)$/;
  const peopleNames = new Set(Object.keys(profile.people || {}));
  let claimed = 0;
  let tag = 0;
  let empty = 0;
  for (const e of recent7) {
    const who = String(e?.who ?? '').trim();
    if (!who) empty += 1;
    else if (whoTag.test(who)) tag += 1;
    else if (peopleNames.has(who)) claimed += 1;
  }
  const total = recent7.length || 1;
  const graph = buildMemoryGraph(profile, recent7, { now, maxEvents: 60 });
  const audit = auditProfile(profile);
  return {
    ts: now,
    events: Number(st.events) || 0,
    eventDays: Number(st.eventDays) || 0,
    s0: Number(st.tiers?.[0]) || 0,
    s1: Number(st.tiers?.[1]) || 0,
    s2: Number(st.tiers?.[2]) || 0,
    s3: Number(st.tiers?.[3]) || 0,
    summaryFiles: Number(st.summaryFiles) || 0,
    weekFiles: Number(st.weekFiles) || 0,
    monthFiles: Number(st.monthFiles) || 0,
    people: Object.keys(profile.people || {}).length,
    openThreads: (profile.threads || []).filter((t) => t.state === 'open').length,
    doneThreads: (profile.threads || []).filter((t) => t.state === 'done').length,
    selfNotes: (profile.self || []).length,
    auditProblems: Number(audit.problems) || 0,
    // 最近 7 天的归属质量（百分比，0~100）
    claimedPct: Math.round((claimed / total) * 1000) / 10,
    tagPct: Math.round((tag / total) * 1000) / 10,
    emptyPct: Math.round((empty / total) * 1000) / 10,
    // 结构健康
    graphNodes: graph.stats.nodes,
    graphEdges: graph.stats.edges,
    isolatedPct: graph.stats.nodes ? Math.round((graph.stats.isolated.length / graph.stats.nodes) * 1000) / 10 : 0,
  };
}

const FIELDS = [
  ['events', '事件总数', 'abs'],
  ['eventDays', '覆盖天数', 'abs'],
  ['s3', 'S3 关键', 'abs'],
  ['summaryFiles', '日摘要', 'abs'],
  ['people', '人物', 'abs'],
  ['openThreads', '未完结线', 'abs'],
  ['selfNotes', '她自己', 'abs'],
  ['auditProblems', '档案问题', 'abs'],
  ['claimedPct', '认领率', 'pct'],
  ['tagPct', '会话标签率', 'pct'],
  ['isolatedPct', '悬空率', 'pct'],
];

/**
 * 比较两份指标。返回每一项的变化与严重度。
 * level: 'ok' | 'warn'（明显变化）| 'bad'（变坏）
 */
export function compareMetrics(prev, cur) {
  if (!prev) return [];
  const hours = Math.max(0, ((Number(cur.ts) || 0) - (Number(prev.ts) || 0)) / 3600000);
  const rows = [];
  for (const [key, label, kind] of FIELDS) {
    const a = Number(prev[key]) || 0;
    const b = Number(cur[key]) || 0;
    const delta = Math.round((b - a) * 10) / 10;
    let level = 'ok';
    if (key === 'isolatedPct' || key === 'tagPct') {
      if (delta >= 5) level = 'bad';
      else if (delta >= 2) level = 'warn';
    } else if (key === 'claimedPct') {
      if (delta <= -5) level = 'bad';
      else if (delta <= -2) level = 'warn';
    } else if (key === 'auditProblems') {
      if (delta > 0) level = 'bad';
    } else if (key === 'events') {
      // 事件数只增不减；减少说明归档丢了或文件被删
      if (delta < 0) level = 'bad';
      // 半天以上一条新事件都没有 → 桥接大概没在跑（短时间不变是正常的）
      else if (delta === 0 && hours >= 12 && a > 50) level = 'warn';
    } else if (key === 's3' || key === 'people' || key === 'openThreads' || key === 'selfNotes') {
      if (delta < 0) level = 'warn';
    }
    rows.push({ key, label, kind, prev: a, cur: b, delta, level });
  }
  return rows;
}

export function readBaseline() {
  try {
    const val = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    return val && typeof val === 'object' && val.metrics ? val : null;
  } catch {
    return null;
  }
}

export function saveBaseline(metrics) {
  const prev = readBaseline();
  const history = Array.isArray(prev?.history) ? prev.history.slice(-29) : [];
  if (prev?.metrics) history.push(prev.metrics);
  const payload = { ts: metrics.ts, metrics, history };
  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/** 把对比结果渲染成文本行（health 与 CLI 共用）。 */
export function formatCompare(baseline, rows, now = Date.now()) {
  const lines = [];
  if (!baseline) {
    lines.push('【基线对比】还没有基线。运行 node scripts/memory-baseline.mjs --save 记一次。');
    return lines;
  }
  const ago = Math.max(0, Math.round((now - (baseline.ts || 0)) / 3600000));
  lines.push(`【基线对比】（对比 ${new Date(baseline.ts || 0).toLocaleString('zh-CN')}，约 ${ago} 小时前）`);
  const pad = (s, n) => String(s).padEnd(n, ' ');
  lines.push(`  ${pad('指标', 12)}${pad('上次', 10)}${pad('当前', 10)}变化`);
  for (const r of rows) {
    if (!r.delta && r.level === 'ok') continue; // 没变化的不占行
    const sign = r.delta > 0 ? '+' : '';
    const mark = r.level === 'bad' ? '  ⚠' : r.level === 'warn' ? '  ·' : '';
    lines.push(`  ${pad(r.label, 12)}${pad(r.prev, 10)}${pad(r.cur, 10)}${sign}${r.delta}${mark}`);
  }
  const bad = rows.filter((r) => r.level === 'bad');
  const warn = rows.filter((r) => r.level === 'warn');
  if (bad.length) lines.push(`  ⚠ 变坏：${bad.map((r) => r.label).join('、')}（看上面数值，必要时查归档/档案）`);
  else if (warn.length) lines.push(`  · 有变化但不算坏：${warn.map((r) => r.label).join('、')}`);
  else lines.push('  · 和上次比没有明显变化。');
  return lines;
}

function main() {
  const store = createMemoryStore({ dir: path.join(root, 'state', 'memory'), config: {} });
  const profile = store.readProfile();
  const now = Date.now();
  const metrics = collectMetrics(store, profile, now);
  const save = process.argv.includes('--save');
  const json = process.argv.includes('--json');

  if (save) {
    const payload = saveBaseline(metrics);
    if (json) {
      console.log(JSON.stringify(payload.metrics, null, 2));
    } else {
      console.log(`已记录基线：${new Date(metrics.ts).toLocaleString('zh-CN')}`);
      console.log(JSON.stringify(metrics, null, 2));
    }
    return;
  }
  const baseline = readBaseline();
  const rows = compareMetrics(baseline?.metrics, metrics);
  if (json) {
    console.log(JSON.stringify({ current: metrics, previous: baseline?.metrics || null, rows }, null, 2));
    return;
  }
  console.log('════ 记忆库基线 ════');
  console.log(`时间：${new Date(now).toLocaleString('zh-CN')}`);
  console.log('');
  for (const line of formatCompare(baseline, rows, now)) console.log(line);
  console.log('');
  console.log('（记一次基线：node scripts/memory-baseline.mjs --save）');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
