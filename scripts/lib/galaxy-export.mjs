// 记忆银河数据层：把 qq-bridge V3 记忆库投影成 dsh-Memory-Galaxy 的星图数据。
//
// 只读：不写记忆库任何文件。
// 视觉/布局来自 dsh-Memory-Galaxy（MIT, leesingx，见 tools/memory-galaxy/LICENSE）。
//
// 投影约定（与 README「记忆银河」一节一致）：
//   S3 重要记忆 → 心情（feeling，τ=150）
//   重要事件(s≥2) → 经历（event，τ=45）
//   人物事实 → 事实（fact，τ=300，时间取最新 confirmedAt）
//   未完结的约定 → 约定（plan，τ=240，时间取 lastMentionAt）
//   日/周/月摘要 → 结论（conclusion，τ=999）
//
// 容错原则：只有 ENOENT 才是「合法的空状态」；EACCES/EIO/EPERM 一律进 errors 并标 partial。
// 去重原则：live 与 archive 共享一个 seen 集合（ID 优先，无 ID 用 t+k+text 指纹）；
// 同 ID 不同内容记 id-conflict，不静默丢弃也不重复占位。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { layout } from '../../tools/memory-galaxy/data.js';

const TAU_BY_RAW = Object.freeze({
  feeling: 150,
  event: 45,
  fact: 300,
  plan: 240,
  digest_day: 999,
  digest_week: 999,
  digest_month: 999,
});

function sha1(...parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}
function stableId(prefix, ...parts) {
  return `${prefix}:${sha1(...parts)}`;
}

/** 只把 ENOENT 当空态；其它 IO 错误写进 errors。 */
function readFileText(file, errors, { optional = true } = {}) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = error?.code;
    if (optional && code === 'ENOENT') return null;
    errors.push({ file: path.basename(file), error: `${code || ''} ${error?.message || error}`.trim() });
    return null;
  }
}

function listFiles(dir, suffix, errors) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).sort();
  } catch (error) {
    const code = error?.code;
    if (code !== 'ENOENT') errors.push({ file: path.basename(dir) + '/', error: `${code || ''} ${error?.message || error}`.trim() });
    return [];
  }
}

/** 事件行结构校验：JSON.parse 成功不代表这是一条合法记忆记录。 */
function isValidEventRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const t = Number(row.t);
  if (!Number.isFinite(t) || t <= 0) return false;
  if (typeof row.text !== 'string' || !row.text.trim()) return false;
  if (row.k !== undefined && typeof row.k !== 'string') return false;
  if (row.id !== undefined && typeof row.id !== 'string' && typeof row.id !== 'number') return false;
  if (row.s !== undefined && !Number.isFinite(Number(row.s))) return false;
  return true;
}

function readJsonl(file, errors) {
  const text = readFileText(file, errors);
  if (text == null) return [];
  const rows = [];
  let bad = 0;
  let schemaErrors = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (!isValidEventRow(row)) {
      schemaErrors += 1;
      continue;
    }
    rows.push(row);
  }
  if (bad) errors.push({ file: path.basename(file), parseErrors: bad });
  if (schemaErrors) errors.push({ file: path.basename(file), schemaErrors });
  return rows;
}

/** outFile 必须落在 memoryDir 之外（防止把导出物写进记忆库）。 */
export function assertOutOutsideMemory(outFile, memoryDir) {
  const a = path.resolve(outFile);
  const b = path.resolve(memoryDir);
  const rel = path.relative(b, a);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error(`拒绝把导出物写进记忆库：${outFile} 位于 ${memoryDir} 内`);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.memoryDir 记忆库目录（<project>/state/memory）
 * @param {string} opts.outFile   输出 JSON 路径（必须在 memoryDir 之外）
 * @param {object} [opts.labels]  { core, coreSub }
 */
export function exportGalaxy({ memoryDir, outFile, labels = {} }) {
  assertOutOutsideMemory(outFile, memoryDir);
  const MEM = memoryDir;
  const now = Date.now();
  const errors = [];
  const stars = [];
  const messages = [];
  const usedIds = new Set();
  const idContents = new Map();   // 原始 ID → 已出现的内容指纹集合

  // 去重集合：id → { text, t, k }；无 id 用 t|k|text 指纹
  const seenEvents = new Map();
  const seenMessages = new Set();

  function addStar({ id, rawKind, kind, weight, at, title, text, tags = [] }) {
    const atNum = Number(at);
    const originalId = String(id);
    // 同一原始 ID 下按内容指纹去重：完全相同的重复导入只留一条
    if (!idContents.has(originalId)) idContents.set(originalId, new Set());
    const bucket = idContents.get(originalId);
    const contentKey = `${kind}|${text}|${atNum}`;
    if (bucket.has(contentKey)) return null;     // 重复导入：跳过
    if (bucket.size > 0) {
      // 同 ID 不同内容：记冲突，但两份内容都要保留（各自唯一 ID）
      errors.push({ file: 'layout', error: `id-conflict: ${originalId}` });
    }
    bucket.add(contentKey);
    // 后缀可能再次撞车（X/A、X/B、X/B 的真实路径）：循环到未使用为止
    let finalId = originalId;
    let suffix = 0;
    while (usedIds.has(finalId)) {
      suffix += 1;
      finalId = `${originalId}~${sha1(text, atNum, suffix)}`;
      if (suffix > 200) {
        errors.push({ file: 'layout', error: `id-unsolvable: ${originalId}` });
        break;
      }
    }
    usedIds.add(finalId);
    stars.push({
      id: finalId,
      kind,
      rawKind,                 // 上游 layout 用 rawKind 查 TAU（缺失会全部退化成 240）
      source: 'qq-bridge',
      weight: Math.max(1, Math.min(4, Number(weight) || 1)),
      at: Number.isFinite(atNum) && atNum > 0 ? atNum : now,
      lastHitAt: 0,
      pin: false,              // 核心留给「她」本人，记忆全部走旋臂
      title: String(title || text || '').slice(0, 40),
      text: String(text || '').slice(0, 420),
      tags,
    });
  }

  // 0) 先收 S3（稍后按 id 去重：事件与 S3 同 id 时以 S3 为准）
  const salientById = new Map();
  for (const row of readJsonl(path.join(MEM, 'salient.jsonl'), errors)) {
    const text = String(row.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const id = row.id ? String(row.id) : stableId('salient', text, row.t);
    const prev = salientById.get(id);
    if (prev) {
      if (prev.text !== text) errors.push({ file: 'salient.jsonl', error: `id-conflict: ${id}` });
      continue;
    }
    salientById.set(id, { row, text });
  }

  // 1) 事件流：live 先扫、archive 后扫，共享 seenEvents（ID 或指纹）
  const scanEvents = (dir, { archived = false } = {}) => {
    for (const f of listFiles(dir, '.jsonl', errors)) {
      for (const e of readJsonl(path.join(dir, f), errors)) {
        const text = String(e.text || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const t = Number(e.t) || 0;
        const k = String(e.k || 'chat');
        const srcId = e.id ? String(e.id) : '';
        const key = srcId || `fp:${t}|${k}|${text}`;

        const prev = seenEvents.get(key);
        if (prev) {
          if (prev.text !== text) {
            // 同 ID 不同内容：记冲突，用指纹另立一条（不丢数据也不重复占位）
            errors.push({ file: archived ? 'events-archive' : 'events', error: `id-conflict: ${srcId || key}` });
          } else {
            continue;   // 同一条事件（live/archive 重复或重复导入）：跳过
          }
        } else {
          seenEvents.set(key, { text, t, k });
        }

        // 消息点独立指纹去重（不用 seenEvents 的 ID 语义，避免同 ID 不同内容被误吞）
        const msgKey = `${k}|${t}|${text}`;
        if (!seenMessages.has(msgKey)) {
          seenMessages.add(msgKey);
          messages.push({ key: k, at: t || now, self: e.kind === 'self', text: text.slice(0, 60) });
        }

        const s = Number(e.s) || 0;
        if (s < 2) continue;
        if (srcId && salientById.has(srcId)) continue;   // 与 S3 同一条：只留 S3 那颗
        addStar({
          id: srcId || stableId(archived ? 'archived' : 'event', text, t),
          rawKind: 'event',
          kind: 'event',
          weight: s,
          at: t,
          title: text,
          text,
          tags: [archived ? '归档' : k],
        });
      }
    }
  };
  scanEvents(path.join(MEM, 'events'));
  scanEvents(path.join(MEM, 'events-archive'), { archived: true });

  // 2) S3 重要记忆 → 心情
  for (const [id, { row, text }] of salientById) {
    addStar({ id, rawKind: 'feeling', kind: 'feeling', weight: 4, at: row.t, title: text, text, tags: ['S3'] });
  }

  // 3) 长期档案：人物（事实，最新 confirmedAt）、未完结的约定（lastMentionAt）
  const profileText = readFileText(path.join(MEM, 'profile.json'), errors, { optional: true });
  if (profileText != null) {
    try {
      const profile = JSON.parse(profileText);
      for (const [name, person] of Object.entries(profile.people || {})) {
        const facts = Array.isArray(person?.facts) ? person.facts : [];
        const entries = facts
          .map((f) => (typeof f === 'string'
            ? { text: f, at: 0 }
            : { text: String(f?.text || ''), at: Number(f?.confirmedAt || f?.createdAt) || 0 }))
          .filter((f) => f.text);
        const text = entries.map((f) => f.text).join('；');
        if (!text) continue;
        const times = entries.map((f) => f.at).filter((n) => n > 0);
        const at = times.length ? Math.max(...times) : (Number(person?.lastSeen) || 0);
        addStar({ id: `person:${name}`, rawKind: 'fact', kind: 'fact', weight: 3, at, title: name, text, tags: ['人物'] });
      }
      for (const [i, thread] of (profile.threads || []).entries()) {
        if (String(thread?.state || 'open') !== 'open') continue;   // 已了结的不再显示为「未完结」
        const text = String(thread?.text || '').trim();
        if (!text) continue;
        // 用文本 hash 当身份：数组重排不会改变同一条约定的 id
        addStar({
          id: `thread:${sha1(text)}`,
          rawKind: 'plan', kind: 'plan', weight: 3,
          at: Number(thread?.lastMentionAt || thread?.createdAt) || 0,
          title: text, text, tags: ['约定'],
        });
      }
    } catch (error) {
      errors.push({ file: 'profile.json', error: String(error?.message ?? error) });
    }
  }

  // 4) 摘要层（结论，τ=999）
  for (const [dir, rawKind] of [['days', 'digest_day'], ['weeks', 'digest_week'], ['months', 'digest_month']]) {
    const d = path.join(MEM, dir);
    for (const f of listFiles(d, '.json', errors)) {
      const text = readFileText(path.join(d, f), errors, { optional: true });
      if (text == null) continue;
      try {
        const note = JSON.parse(text);
        const lines = Array.isArray(note.lines) ? note.lines.map((l) => l?.t).filter(Boolean) : [];
        if (!lines.length) continue;
        addStar({
          id: `summary:${dir}:${f}`, rawKind, kind: 'conclusion', weight: 2,
          at: Number(note.ts) || 0,
          title: `${note.day || note.week || note.month || f} 摘要`,
          text: lines.join('；'), tags: ['摘要'],
        });
      } catch (error) {
        errors.push({ file: `${dir}/${f}`, error: String(error?.message ?? error) });
      }
    }
  }

  // 上游 layout：旋臂坐标 + tau/ageDays/strength（TAU 由 rawKind 决定）
  const data = layout({ stars, messages });

  // 自检（fail-closed）：未知/缺失 rawKind 也算错误，不能只比较 tau 数值
  const observed = {};
  for (const s of data.stars) {
    observed[s.rawKind] = s.tau;
    if (!Object.hasOwn(TAU_BY_RAW, s.rawKind)) {
      errors.push({ file: 'layout', error: `未知 rawKind: ${String(s.rawKind)}` });
    } else if (s.tau !== TAU_BY_RAW[s.rawKind]) {
      errors.push({ file: 'layout', error: `rawKind=${s.rawKind} tau=${s.tau} != ${TAU_BY_RAW[s.rawKind]}` });
    }
  }
  data.meta.coreLabel = labels.core || '我';
  data.meta.coreSub = labels.coreSub || '她自己';
  data.meta.source = 'qq-bridge V3 memory';
  data.meta.generatedAt = now;
  data.meta.partial = errors.length > 0;
  data.meta.errorCount = errors.length;
  data.meta.errors = errors.slice(0, 50);
  data.meta.tauByRaw = { schema: TAU_BY_RAW, observed };

  // 原子写（tmp + rename），避免半截 JSON 被前端读到
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, outFile);
  return {
    out: outFile,
    stars: data.stars.length,
    messages: data.messages.length,
    counts: data.meta.counts,
    partial: data.meta.partial,
    errors: errors.length,
  };
}
