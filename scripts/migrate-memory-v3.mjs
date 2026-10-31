// 把「升级前就已经存在」的存量记忆一次性导进 Memory V3。
//
// 为什么需要它：V3 只从升级那一刻开始记录事件流，而聊天记录里已经有几天的真实历史
//（state/social-v2.json 的 recentMessages / 热话题 / 群友印象，以及 state/diary/*.jsonl）。
// 不迁移的话，她升级当天会「失忆一次」——正好是这个功能要解决的问题。
//
// 幂等：按 (t, k, text 前 80 字) 去重，重复运行不会产生副本。
//
// 用法：
//   node scripts/migrate-memory-v3.mjs            # 实际导入
//   node scripts/migrate-memory-v3.mjs --dry-run  # 只报告会导入多少，不写盘
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '../src/core/memory-store.mjs';
import { mergePersonFact, ensureProfile } from '../src/core/memory-lib.mjs';
import { scriptWriteMode, enterMaintenanceForScript, leaveMaintenance } from './lib/maintenance-run.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const STATE_DIR = path.join(root, 'state');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
const DIARY_DIR = path.join(STATE_DIR, 'diary');
const dirArg = (() => { const i = process.argv.indexOf('--dir'); return i >= 0 ? process.argv[i + 1] : null; })();
const MEMORY_DIR = dirArg ? path.resolve(dirArg) : path.join(STATE_DIR, 'memory');
// 写模式契约（和其他维护命令一致）：默认只预览，--apply 才写盘；
// --dry-run 保留为兼容别名。旧版本默认写盘，无参数调用会绕过维护门 —— 已修正。
const { apply: APPLY, dryRun: DRY_RUN } = scriptWriteMode(process.argv.slice(2));

// gate 覆盖「读取旧状态 → 计算 → 写回」整段：只包写回会让 bridge 在扫描期间
// 改写同一批记忆，随后用旧快照覆盖新内容。
let maintenance = null;
if (APPLY) {
  maintenance = enterMaintenanceForScript({
    memoryDir: MEMORY_DIR,
    command: 'migrate-v3',
    forceUnlocked: process.argv.includes('--force-unlocked'),
  });
}

const store = createMemoryStore({ dir: MEMORY_DIR });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function dayKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dedupeKey(row) {
  return `${Number(row.t) || 0}|${String(row.k || '')}|${String(row.text || '').slice(0, 80)}`;
}

// 已有事件流里的事实，全部纳入去重集合（扫全部日期文件）
const existing = new Set();
for (const day of store.listEventDays()) {
  for (const row of store.readDayEvents(day)) {
    existing.add(dedupeKey(row));
  }
}

const pending = [];
const seen = new Set();
function queue(row) {
  if (!row || !Number(row.t)) return false;
  if (!/^(group|private):\d+$/.test(String(row.k || ''))) return false;
  const text = String(row.text || '').trim();
  if (!text) return false;
  const key = dedupeKey({ ...row, text });
  if (existing.has(key) || seen.has(key)) return false;
  seen.add(key);
  pending.push({ ...row, text: text.slice(0, 300) });
  return true;
}

// ---------------------------------------------------------------- 1) 社交状态
const social = readJson(SOCIAL_V2_FILE, null);
const stats = { socialMessages: 0, topics: 0, thoughts: 0, diary: 0, people: 0 };
if (social?.conversations && typeof social.conversations === 'object') {
  for (const [key, st] of Object.entries(social.conversations)) {
    if (!st || typeof st !== 'object') continue;
    for (const m of Array.isArray(st.recentMessages) ? st.recentMessages : []) {
      if (!m || !Number(m.time)) continue;
      const isSelf = m.isSelf === true;
      if (queue({
        t: Number(m.time),
        k: key,
        kind: isSelf ? 'self' : 'msg',
        who: isSelf ? '' : String(m.sender || ''),
        uid: m.userId ? String(m.userId) : null,
        owner: !!m.isOwner,
        text: String(m.text || m.plain || ''),
        mid: m.messageId ? String(m.messageId) : null,
        source: 'migrate:social-v2',
      })) stats.socialMessages += 1;
    }
    for (const t of Array.isArray(st.activeTopics) ? st.activeTopics : []) {
      if (!t?.text) continue;
      if (queue({
        t: Number(t.lastMentionAt) || Date.now(),
        k: key,
        kind: 'topic',
        text: String(t.text),
        participants: Array.isArray(t.participants) ? t.participants : [],
        source: 'migrate:social-v2',
      })) stats.topics += 1;
    }
    for (const t of Array.isArray(st.pendingThoughts) ? st.pendingThoughts : []) {
      if (!t?.text) continue;
      if (queue({
        t: Number(t.createdAt) || Date.now(),
        k: key,
        kind: 'thought',
        text: String(t.text),
        source: 'migrate:social-v2',
      })) stats.thoughts += 1;
    }
  }
}

// ---------------------------------------------------------------- 2) 日记归档
// state/diary/*.jsonl 是收消息时就在写的原始记录，比 social-v2 的 200 条窗口更久。
try {
  for (const name of fs.readdirSync(DIARY_DIR)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    const lines = fs.readFileSync(path.join(DIARY_DIR, name), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (queue({
        t: Number(o.t) || 0,
        k: String(o.key || ''),
        kind: 'msg',
        who: String(o.sender || ''),
        uid: o.userId ? String(o.userId) : null,
        owner: !!o.isOwner,
        text: String(o.text || ''),
        source: 'migrate:diary',
      })) stats.diary += 1;
    }
  }
} catch {
  // 没有 diary 目录就跳过
}

// ---------------------------------------------------------------- 3) 群友印象 → 档案
let profile = store.readProfile();
const impressionSources = [];
if (social?.conversations && typeof social.conversations === 'object') {
  for (const st of Object.values(social.conversations)) {
    const imps = st?.memberImpressions;
    if (!imps || typeof imps !== 'object') continue;
    for (const [name, im] of Object.entries(imps)) {
      const traits = Array.isArray(im?.traits) ? im.traits : [];
      for (const trait of traits) {
        if (!trait) continue;
        impressionSources.push({ name, trait, lastSeen: Number(im?.lastSeenAt) || Date.now(), count: Number(im?.interactionCount) || 0 });
      }
    }
  }
}
for (const item of impressionSources) {
  const before = profile.people[item.name]?.facts?.length || 0;
  const out = mergePersonFact(ensureProfile(profile), item.name, item.trait, { now: item.lastSeen || Date.now() });
  profile = out.profile;
  const after = profile.people[item.name]?.facts?.length || 0;
  if (after > before) stats.people += 1;
}

// ---------------------------------------------------------------- 4) 落盘
console.log(`[migrate] 目标目录：${MEMORY_DIR}`);
console.log(`[migrate] 待导入事件 ${pending.length} 条：social-v2 ${stats.socialMessages} / 话题 ${stats.topics} / 想法 ${stats.thoughts} / 日记 ${stats.diary}`);
console.log(`[migrate] 群友印象事实 ${stats.people} 条`);

if (DRY_RUN) {
  console.log('[migrate] --dry-run：没有写入任何文件。');
  process.exit(0);
}

let written = 0;
for (const row of pending) {
  if (store.appendEvent(row)) written += 1;
}
if (stats.people > 0) store.writeProfile(profile);
const summaries = store.ensureDaySummaries({});
console.log(`[migrate] 已写入事件 ${written} 条，生成日摘要 ${summaries} 天`);

const st = store.stats({});
console.log(`[migrate] 记忆库现状：覆盖 ${st.eventDays} 天（${st.firstDay} ~ ${st.lastDay}），共 ${st.events} 条事件，档案 ${st.profile.people} 人 / 未完结的线 ${st.profile.openThreads} 条`);
if (maintenance) leaveMaintenance(maintenance);
