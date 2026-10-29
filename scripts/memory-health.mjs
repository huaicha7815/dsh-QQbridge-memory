// 记忆库健康检查：一次看清规模、检索质量、档案健康度，并给出可执行建议。
//
// 用法：node scripts/memory-health.mjs
// 只读，不修改任何数据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '../src/core/memory-store.mjs';
import { collectMetrics, compareMetrics, formatCompare, readBaseline } from './memory-baseline.mjs';
import { PROFILE_LIMITS, auditProfile, buildMemoryGraph } from '../src/core/memory-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const memDir = path.join(root, 'state', 'memory');

// 先确认目录真的可读。否则「读不到」会被下面的 stats() 折叠成「0 条事件」，
// 报告看起来像「库是空的而且很健康」——审查时被指出过这个坑。
let readable = true;
try {
  fs.readdirSync(memDir);
} catch (error) {
  // 目录不存在 = 全新库，不算错误（自检脚本要能在空库上跑通）。
  // 其余错误（EPERM 等）才是真的「读不到」。
  if (error?.code === 'ENOENT') {
    console.warn('ℹ️ 记忆目录还不存在（全新库）：' + memDir);
  } else {
    readable = false;
    console.error(`❌ 无法读取记忆目录：${memDir}`);
    console.error(`   ${error?.message ?? error}`);
    console.error('   这不是「库是空的」，是权限或路径问题——先修好再看下面的数字。');
    process.exit(2);
  }
}
if (!fs.existsSync(path.join(memDir, 'events')) && !fs.existsSync(path.join(memDir, 'profile.json'))) {
  console.warn('⚠️ 记忆目录存在但还没有 events/ 与 profile.json：这可能是一个全新的库。');
}

const store = createMemoryStore({ dir: memDir, config: {} });
const now = Date.now();
const st = store.stats({ now });
const profile = store.readProfile();
const recalls = store.readRecallLog({ limit: 1000 });

// 统计口径提示：stats() 只算活动日文件，归档月文件不计入。
// 库活得久了之后「事件总数」会低估历史规模，这里显式说明，避免误读。
const archiveMonths = (() => {
  try { return fs.readdirSync(path.join(memDir, 'events-archive')).filter((f) => f.endsWith('.jsonl')).length; } catch { return 0; }
})();

const lines = [];
const say = (s = '') => lines.push(s);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '0%');

say('════ 记忆库健康检查 ════');
say(`时间：${new Date(now).toLocaleString('zh-CN')}`);
say('');

// ── 1. 规模 ───────────────────────────────────────────────
say('【规模】');
say(`  事件：${st.events} 条 / 覆盖 ${st.eventDays} 天（${st.firstDay || '-'} ~ ${st.lastDay || '-'}）`);
say(`  （注：以上只算活动日文件；另有 ${archiveMonths} 个月归档文件未计入，历史规模更大）`);
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
say(`  她自己（self）：${profile.self.length} / 上限 ${PROFILE_LIMITS.maxSelfNotes}`);
say('');

// ── 4.5 档案自检（一致性长歪了没有）────────────────────────
// 「能跑」不等于「记得对」：档案里可能出现同一个人两份档案、
// 同一件事两条线、已经了结却还挂着 open 的线。这些不会报错，只会让她记错。
say('【档案自检】');
const audit = auditProfile(profile);
const problems = audit.problems;
if (!problems) {
  say('  一致：没有同人分裂、重复线、已了结却还挂着 open 的矛盾。');
} else {
  for (const names of audit.samePersonGroups) say(`  疑似同人：${names.join(' / ')}（可合并成一份档案）`);
  for (const { keep, drop } of audit.duplicateThreads) say(`  疑似重复线：「${keep.slice(0, 26)}」≈「${drop.slice(0, 26)}」`);
  for (const { text } of audit.contradictedOpen) say(`  已了结却还算 open：「${text.slice(0, 40)}」`);
  say('  → 用 node scripts/repair-memory-profile.mjs 预览，加 --apply 写回（会先备份）。');
}
say('');

// ── 4.55 事件归属：这条记忆是谁的 ─────────────────────────
// 星图第一次跑就靠「悬空的点」暴露了归档层的缺陷（私聊发送者被写死成「私聊」）。
// 这里把那次的发现固化成可自动跑的指标：谁说的记全了没有、结构上悬空多少。
say('【事件归属】（最近 7 天）');
const recent7 = store.readEvents({ days: 7 });
const whoTag = /^(私聊|群聊|群友|管理员|系统)$/;
const owners = { claimed: 0, tag: 0, empty: 0, other: 0 };
const strangerNames = new Map();
const peopleNames = new Set(people.map(([n]) => n));
for (const e of recent7) {
  const who = String(e?.who ?? '').trim();
  if (!who) owners.empty += 1;
  else if (whoTag.test(who)) owners.tag += 1;
  else if (peopleNames.has(who)) owners.claimed += 1;
  else { owners.other += 1; strangerNames.set(who, (strangerNames.get(who) || 0) + 1); }
}
const total7 = recent7.length || 1;
say(`  总事件 ${recent7.length} 条：认领 ${owners.claimed}（${pct(owners.claimed, total7)}）· 会话标签 ${owners.tag}（${pct(owners.tag, total7)}）· 无发送者 ${owners.empty} · 未建档群友 ${owners.other}`);
if (owners.tag > total7 * 0.01) say('  ⚠ 有事件把「私聊/群聊」当成了发送者：这些记忆接不到任何人，检索里「谁跟谁」的信号会丢。');
const topStrangers = [...strangerNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
if (topStrangers.length) say(`  未建档但活跃：${topStrangers.map(([n, ct]) => `${n}(${ct})`).join('、')}`);
// 结构悬空率：用和星图同一套构图（S2/S3 为主），看记忆之间有没有钩子
const graph = buildMemoryGraph(profile, recent7, { now, maxEvents: 60 });
const isoRate = graph.stats.nodes ? graph.stats.isolated.length / graph.stats.nodes : 0;
say(`  结构：${graph.stats.nodes} 点 / ${graph.stats.edges} 连 / 悬空 ${graph.stats.isolated.length}（${pct(graph.stats.isolated.length, graph.stats.nodes)}）· 最大枢纽 ${graph.stats.hubs[0] ? `${graph.stats.hubs[0].label}(${graph.stats.hubs[0].degree})` : '—'}`);
if (isoRate > 0.4) say('  ⚠ 悬空点超过 40%：这些记忆没跟任何人物/事件挂钩，等于「记下来了但没人认领」。');
say('');

// ── 4.6 日终归纳（V3.7）是否在跑 ────────────────────────────
// 每天一次独立调用，最容易「悄悄没跑」：时间配错、记忆库关着、owner 没设。
// 这里只报告事实，不猜原因。
say('【日终归纳】');
try {
  const st = JSON.parse(fs.readFileSync(path.join(root, 'state', 'memory-refine.json'), 'utf8'));
  const lastAt = Number(st.lastAt) || 0;
  const days = lastAt ? Math.floor((now - lastAt) / 86400000) : -1;
  say(`  最近一次：${st.lastDay || '—'}${lastAt ? `（${new Date(lastAt).toLocaleString('zh-CN')}）` : ''}`);
  if (days > 2) say('  已经超过 2 天没整理过：检查 config.memoryRefine（enabled/time）与桥接是否在跑。');
} catch {
  say('  还从没跑过（state/memory-refine.json 不存在）。要么是新装的，要么 config.memoryRefine.enabled=false。');
}
say('');

// ── 4.7 基线对比：跟上一版比，哪里在慢慢变坏 ─────────────────
// 单看一次 health 看不出漂移；跟基线比，「悬空率悄悄爬到 40%」这种才藏不住。
const baseline = readBaseline();
let baseBad = [];
if (baseline) {
  const current = collectMetrics(store, profile, now);
  const rows = compareMetrics(baseline.metrics, current);
  for (const line of formatCompare(baseline, rows, now)) say(line);
  baseBad = rows.filter((r) => r.level === 'bad');
  say('');
} else {
  say('【基线对比】还没有基线。记一次：node scripts/memory-baseline.mjs --save');
  say('');
}

// ── 5. 建议 ───────────────────────────────────────────────
const advice = [];
if (baseBad.length) advice.push(`基线变坏：${baseBad.map((r) => r.label).join('、')}（对比上一版；先看上面数值，再查归档/档案）。`);
if (problems) advice.push(`档案有 ${problems} 处一致性问题（同人分裂/重复线/已了结还挂着），用 node scripts/repair-memory-profile.mjs --apply 修掉。`);
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
if (owners.tag > total7 * 0.03) advice.push(`会话标签事件占 ${Math.round((owners.tag / total7) * 100)}%：归档层可能没记真实发送者（V4.4 前的私聊缺陷），用 node scripts/backfill-private-who.mjs 预览回填。`);
if (isoRate > 0.4) advice.push(`星图悬空 ${Math.round(isoRate * 100)}%：先看上面【事件归属】里未建档的群友，或用 qq_memory_remember(kind="person") 把常说话的人建档。`);

say('【建议】');
if (advice.length) for (const a of advice) say(`  · ${a}`);
else say('  · 一切正常，没发现需要处理的问题。');
say('');

console.log(lines.join('\n'));
