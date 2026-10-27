// 记忆库健康检查：一次看清规模、检索质量、档案健康度，并给出可执行建议。
//
// 用法：node scripts/memory-health.mjs
// 只读，不修改任何数据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '../src/core/memory-store.mjs';
import { PROFILE_LIMITS } from '../src/core/memory-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const store = createMemoryStore({ dir: path.join(root, 'state', 'memory'), config: {} });
const now = Date.now();
const st = store.stats({ now });
const profile = store.readProfile();
const recalls = store.readRecallLog({ limit: 1000 });

const lines = [];
const say = (s = '') => lines.push(s);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '0%');

say('════ 记忆库健康检查 ════');
say(`时间：${new Date(now).toLocaleString('zh-CN')}`);
say('');

// ── 1. 规模 ───────────────────────────────────────────────
say('【规模】');
say(`  事件：${st.events} 条 / 覆盖 ${st.eventDays} 天（${st.firstDay || '-'} ~ ${st.lastDay || '-'}）`);
say(`  体积：事件 ${(st.eventBytes / 1024).toFixed(0)} KB · S3 档案 ${(st.salient.bytes / 1024).toFixed(1)} KB`);
say(`  压缩层：日摘要 ${st.summaryFiles} / 周要点 ${st.weekFiles} / 月要点 ${st.monthFiles}`);
say(`  归档：${store.listArchiveMonths().length} 个月`);
say('');

// ── 2. 分档 ───────────────────────────────────────────────
say('【重要度分档】');
const tiers = st.tiers;
for (const [i, label] of ['S0 寒暄', 'S1 日常', 'S2 值得记', 'S3 关键'].entries()) {
  const n = tiers[i];
  say(`  ${label}：${n} 条（${pct(n, st.events)}）`);
}
say('');

// ── 3. 检索质量 ───────────────────────────────────────────
say('【检索质量】（基于最近 ' + recalls.length + ' 次检索）');
if (recalls.length) {
  const empty = recalls.filter((r) => !r.n).length;
  const related = recalls.reduce((s, r) => s + (Number(r.related) || 0), 0);
  const echo = recalls.reduce((s, r) => s + (Number(r.echo) || 0), 0);
  const avgN = (recalls.reduce((s, r) => s + (Number(r.n) || 0), 0) / recalls.length).toFixed(1);
  const freq = new Map();
  for (const r of recalls) freq.set(r.q, (freq.get(r.q) || 0) + 1);
  const topQ = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  say(`  平均命中：${avgN} 条 / 空结果率：${pct(empty, recalls.length)}`);
  say(`  关联扩散命中：${related} 条 · 回音命中：${echo} 条`);
  say(`  最高频查询：${topQ.map(([q, n]) => `「${String(q).slice(0, 12)}」×${n}`).join('  ') || '（无）'}`);
}
say('');

// ── 4. 档案 ───────────────────────────────────────────────
say('【长期档案】');
const people = Object.entries(profile.people);
say(`  人物：${people.length} / 上限 ${PROFILE_LIMITS.maxPeople}`);
for (const [name, v] of people.slice(0, 8)) {
  const facts = (v.facts || []).length;
  const last = v.lastSeen ? new Date(v.lastSeen).toLocaleDateString('zh-CN') : '-';
  say(`    ${name}：${facts} 条事实（最近 ${last}）`);
}
const open = profile.threads.filter((t) => t.state === 'open');
const done = profile.threads.filter((t) => t.state === 'done');
say(`  线：未完结 ${open.length} / 已了结 ${done.length} / 上限 ${PROFILE_LIMITS.maxThreads}`);
for (const t of open.slice(0, 5)) say(`    [open] ${t.text.slice(0, 50)}`);
say(`  心事（self）：${profile.self.length} / 上限 ${PROFILE_LIMITS.maxSelfNotes}`);
say('');

// ── 5. 建议 ───────────────────────────────────────────────
const advice = [];
const shard = st.events ? tiers[0] / st.events : 0;
if (st.eventDays >= 3 && st.events < 50) advice.push('事件量偏少：桥接可能没在跑，或最近很安静。');
if (shard > 0.45) advice.push(`寒暄占比 ${Math.round(shard * 100)}% 偏高：重要度阈值可能太松，可调 socialV2.memory.weekMinSalience。`);
if (recalls.length >= 20) {
  const empty = recalls.filter((r) => !r.n).length / recalls.length;
  if (empty > 0.35) advice.push(`空结果率 ${Math.round(empty * 100)}% 偏高：可调大 searchDays，或把 searchTopK 提高。`);
}
if (people.length === 0 && st.eventDays >= 7) advice.push('档案还是空的：日记【顺手记住】可能没生效（检查 diaryRemember 与桥接重启）。');
if (open.length === 0 && done.length === 0 && st.eventDays >= 7) advice.push('没有记下任何「线」：她可能没在用 qq_memory_remember。');
if (st.weekFiles === 0 && st.eventDays > 7) advice.push('周要点还没生成：需要有一个「已经过完的周」（周一到周日走完）才会补。');
const overdue = open.filter((t) => now - (t.lastMentionAt || t.createdAt) > 30 * 86400000);
if (overdue.length) advice.push(`有 ${overdue.length} 条线超过 30 天没被提起，可以考虑用 qq_memory_remember(kind="threadDone") 收尾。`);
const superseded = people.reduce((s, [, v]) => s + (v.facts || []).filter((f) => f.previous).length, 0);
if (superseded) advice.push(`档案里有 ${superseded} 条事实被纠正过（保留在 previous 里），可以用 qq_memory_inspect 复查。`);

say('【建议】');
if (advice.length) for (const a of advice) say(`  · ${a}`);
else say('  · 一切正常，没发现需要处理的问题。');
say('');

console.log(lines.join('\n'));
