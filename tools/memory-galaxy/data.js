// 银河布局/数据层（上游原版）
// 来源：dsh-Memory-Galaxy（https://github.com/leesingx/dsh-Memory-Galaxy，MIT License）
// Copyright (c) 2026 Derpyu520 & 大肥鱼。已按 MIT 许可使用，LICENSE 见同目录。
/**
 * dsh-memory-galaxy / data.js
 *
 * 数据层：把各个「记忆来源」统一成一种星体结构，再按银河规则排位。
 *
 * 支持三种来源（自动探测，可配置强制）：
 *   1. meow-memory —— 工作区 `.dsh-meow/memory.db`（七层表：soul/user/project/fact/lesson/topic/rules）
 *   2. qq-bridge  —— `<workspace>/qq-bridge/state/memory/index.json` + `diary/*.md` + `archive/*.jsonl`
 *   3. 自定义 JSON —— 任意 `{ stars: [...], messages: [...] }`，字段见 docs
 *
 * 所有读取都只读，不写回任何记忆库。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// node:sqlite 只有 Node >= 22.5 才有；没有就把 meow 来源当作空
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const R = 1000;
const ARMS = 4;   // 四条主旋臂
const TAU = {
  soul: 36500, user: 36500, person: 400, preference: 300, fact: 300, plan: 240,
  lesson: 400, topic: 300, event: 45, misc: 60, feeling: 150,
  digest_day: 999, digest_week: 999, digest_month: 999, impression: 300,
  rules: 240, project: 300,
};
const KIND = {
  soul: 'identity', user: 'identity', rules: 'plan',
  person: 'fact', preference: 'fact', fact: 'fact', project: 'fact',
  plan: 'plan', lesson: 'conclusion', topic: 'conclusion',
  digest_day: 'conclusion', digest_week: 'conclusion', digest_month: 'conclusion',
  impression: 'conclusion', event: 'event', misc: 'event', feeling: 'feeling', diary: 'diary',
};

const now = () => Date.now();
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest();
const u01 = (b, i) => b[i % b.length] / 255;
const gauss = (b, i) => {
  const a = u01(b, i) || 0.5;
  const c = u01(b, i + 7) || 0.5;
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * c) * 0.5;
};

/* ---------------- 来源 1：meow-memory ---------------- */
const MEOW_TABLES = [
  ['soul', 'soul'], ['user', 'user'], ['rules', 'rules'],
  ['project', 'project'], ['fact', 'fact'], ['lesson', 'lesson'], ['topic', 'topic'],
];

export function readMeow(dbPath) {
  const out = [];
  if (!DatabaseSync) return out;
  if (!fs.existsSync(dbPath)) return out;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return out;
  }
  const t = now();
  for (const [table, rawKind] of MEOW_TABLES) {
    let rows = [];
    try {
      rows = db.prepare(`SELECT * FROM ${table}`).all();
    } catch {
      continue;
    }
    for (const r of rows) {
      const text = String(r.content ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const title = String(r.title ?? text).slice(0, 60);
      const weight = Math.max(1, Math.min(4, Number(r.importance) || 1));
      const at = Number(r.created_at) || t;
      const hit = Number(r.last_accessed_at) || 0;
      const pinned = weight >= 3 || r.status === 'pinned';
      out.push({
        id: `meow-${table}-${r.id ?? out.length}`,
        rawKind, kind: KIND[rawKind] || 'fact',
        weight, at, lastHitAt: hit, pin: pinned,
        title, text: text.slice(0, 420),
        tags: String(r.keywords ?? '').split(/[,，\s]+/).filter(Boolean).slice(0, 6),
        source: 'meow',
      });
    }
  }
  try { db.close(); } catch { /* ignore */ }
  return out;
}


/* ---------------- 来源 2：qq-bridge ---------------- */
export function readQqBridge(dir) {
  const stars = [];
  const messages = [];
  const idx = path.join(dir, 'state', 'memory', 'index.json');
  if (fs.existsSync(idx)) {
    let arr = [];
    try {
      const raw = JSON.parse(fs.readFileSync(idx, 'utf8'));
      arr = Array.isArray(raw) ? raw : (raw.entries ?? []);
    } catch { /* 坏文件跳过 */ }
    for (const e of arr) {
      if (!e || !(e.summary || e.title || e.text)) continue;
      const rawKind = String(e.kind || 'fact');
      const text = String(e.summary || e.text || e.title).replace(/\s+/g, ' ').trim();
      stars.push({
        id: String(e.id || `qb-${e.at}`), rawKind, kind: KIND[rawKind] || 'fact',
        weight: Math.max(1, Math.min(4, Number(e.weight) || 1)),
        at: Number(e.at) || now(), lastHitAt: Number(e.lastHitAt) || 0, pin: !!e.pin,
        title: String(e.title || text).slice(0, 60), text: text.slice(0, 420),
        tags: Array.isArray(e.tags) ? e.tags.slice(0, 6) : [], source: 'qq-bridge',
      });
    }
  }
  const diaryDir = path.join(dir, 'diary');
  if (fs.existsSync(diaryDir)) {
    for (const f of fs.readdirSync(diaryDir).filter((x) => x.endsWith('.md'))) {
      const day = f.replace(/\.md$/, '');
      const body = fs.readFileSync(path.join(diaryDir, f), 'utf8');
      for (const chunk of body.split(/\n(?=## )/)) {
        const head = (chunk.match(/^## (.+)$/m) || [])[1] || day;
        const text = chunk.replace(/^## .+$/m, '').replace(/^# .+$/m, '').trim();
        if (text.length < 8) continue;
        stars.push({
          id: `diary-${day}-${hash(head).toString('hex').slice(0, 6)}`,
          rawKind: 'diary', kind: 'diary', weight: 2,
          at: new Date(`${day}T20:00:00+08:00`).getTime() || now(),
          lastHitAt: 0, pin: false, title: head.slice(0, 60),
          text: text.slice(0, 420), tags: [], source: 'qq-bridge',
        });
      }
    }
  }
  const archDir = path.join(dir, 'state', 'memory', 'archive');
  if (fs.existsSync(archDir)) {
    for (const f of fs.readdirSync(archDir).filter((x) => x.endsWith('.jsonl'))) {
      const key = f.replace(/\.jsonl$/, '');
      for (const line of fs.readFileSync(path.join(archDir, f), 'utf8').split('\n').filter(Boolean)) {
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        messages.push({
          id: `m${key}-${messages.length}`, key, at: Number(m.at || m.time) || now(),
          self: !!m.isSelf, text: String(m.text || '').replace(/\s+/g, ' ').slice(0, 60),
          source: 'qq-bridge',
        });
      }
    }
  }
  return { stars, messages };
}

/* ---------------- 来源 3：自定义 JSON ---------------- */
export function readCustom(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const stars = (raw.stars ?? []).map((s, i) => ({
      id: String(s.id ?? `c-${i}`), rawKind: String(s.kind ?? 'fact'),
      kind: KIND[String(s.kind ?? 'fact')] || 'fact',
      weight: Math.max(1, Math.min(4, Number(s.weight) || 1)),
      at: Number(s.at ?? s.createdAt) || now(), lastHitAt: Number(s.lastHitAt) || 0,
      pin: !!s.pin, title: String(s.title ?? s.text ?? '').slice(0, 60),
      text: String(s.text ?? '').slice(0, 420),
      tags: Array.isArray(s.tags) ? s.tags.slice(0, 6) : [], source: 'custom',
    })).filter((s) => s.text || s.title);
    const messages = (raw.messages ?? []).map((m, i) => ({
      id: `cm-${i}`, key: String(m.key ?? 'chat'), at: Number(m.at) || now(),
      self: !!m.self, text: String(m.text ?? '').slice(0, 60), source: 'custom',
    }));
    return { stars, messages };
  } catch {
    return { stars: [], messages: [] };
  }
}

/* ---------------- 排位：把星体摆成银河 ---------------- */
export function layout(input) {
  const t = now();
  const stars = input.stars.map((s) => {
    const tau = TAU[s.rawKind] ?? 240;
    const ageDays = Math.max(0, (t - s.at) / 86400000);
    const hitDays = s.lastHitAt ? Math.max(0, (t - s.lastHitAt) / 86400000) : null;
    const effAge = hitDays === null ? ageDays : Math.min(ageDays, hitDays * 0.55);
    const strength = Math.pow(s.weight, 1.5) * Math.exp(-effAge / tau);
    return { ...s, tau, ageDays: +ageDays.toFixed(2), hitDays: hitDays === null ? null : +hitDays.toFixed(2), strength };
  });

  // 分层：钉住/身份 → 核心；其余按强度排名 55/15/15
  const core = stars.filter((s) => s.pin || s.kind === 'identity');
  const rest = stars.filter((s) => !(s.pin || s.kind === 'identity')).sort((a, b) => b.strength - a.strength);
  for (const s of core) s.shell = 0;
  rest.forEach((s, i) => {
    const f = i / Math.max(1, rest.length - 1);
    s.shell = f < 0.55 ? 1 : f < 0.85 ? 2 : 3;
  });

  const SHELL_R = [[0.02, 0.11], [0.14, 0.44], [0.44, 0.72], [0.72, 1.0]];
  const all = [...core, ...rest];
  all.forEach((s, i) => {
    const h = hash(s.id + '|' + i);
    const [r0, r1] = SHELL_R[s.shell];
    const frac = 0.5 + 0.5 * u01(h, 3) + (s.shell === 0 ? 0 : 0.25 * (1 - Math.min(1, s.strength / 4)));
    const rr = Math.min(r1, r0 + (r1 - r0) * Math.min(1, frac * 0.85));
    const arm = Math.floor(u01(h, 5) * ARMS) % ARMS;
    const theta = (arm / ARMS) * Math.PI * 2 - 2.6 * Math.log(rr * 6 + 1) + (u01(h, 9) - 0.5) * 1.30;
    const radius = R * rr * (1 + (u01(h, 11) - 0.5) * (s.shell === 0 ? 0.12 : 0.26));
    const yScale = s.shell === 0 ? 0.20 : 0.055;
    s.arm = arm;
    s.r = +(radius / R).toFixed(4);
    s.x = +(Math.cos(theta) * radius).toFixed(2);
    s.z = +(Math.sin(theta) * radius).toFixed(2);
    s.y = +(gauss(h, 13) * R * yScale * Math.exp(-rr * 1.1) + (s.shell === 0 ? gauss(h, 17) * R * 0.05 : 0)).toFixed(2);
  });

  const messages = input.messages.map((m, i) => {
    const h = hash(`${m.key}:${m.at}:${i}`);
    const rr = 0.30 + Math.pow(u01(h, 2), 0.55) * 0.76;
    const arm = Math.floor(u01(h, 5) * ARMS) % ARMS;
    const theta = (arm / ARMS) * Math.PI * 2 - 2.6 * Math.log(rr * 6 + 1) + (u01(h, 9) - 0.5) * 1.35;
    const radius = R * rr;
    const ageDays = Math.max(0, (t - m.at) / 86400000);
    return {
      ...m, x: +(Math.cos(theta) * radius).toFixed(1),
      y: +(gauss(h, 13) * R * 0.075).toFixed(1),
      z: +(Math.sin(theta) * radius).toFixed(1),
      tau: +(24 + u01(h, 15) * 12).toFixed(1),
      ageDays: +ageDays.toFixed(2),
    };
  });

  const counts = {};
  for (const s of stars) counts[s.kind] = (counts[s.kind] || 0) + 1;
  // 页面用 memory / diary / message 三个数；bySource 里保留"来自哪个库"
  const bySource = {};
  for (const s of [...stars, ...messages]) bySource[s.source] = (bySource[s.source] || 0) + 1;
  const sources = {
    memory: stars.filter((s) => s.kind !== 'diary').length,
    diary: stars.filter((s) => s.kind === 'diary').length,
    message: messages.length,
    bySource,
  };

  return {
    meta: {
      generatedAt: t, radius: R, arms: ARMS,
      total: stars.length, pinned: stars.filter((s) => s.pin).length,
      messages: messages.length, counts, sources,
      avgStrength: +(stars.reduce((a, s) => a + s.strength, 0) / Math.max(1, stars.length)).toFixed(3),
    },
    stars, messages,
  };
}

/* ---------------- 统一入口 ---------------- */
export function buildGalaxy(cfg = {}) {
  const source = String(cfg.source || 'auto');
  const picked = [];
  if (source === 'auto' || source === 'meow') {
    for (const p of cfg.meowCandidates ?? []) {
      if (fs.existsSync(p)) {
        const rows = readMeow(p);
        if (rows.length) { picked.push({ stars: rows, messages: [] }); break; }
      }
    }
  }
  if (source === 'auto' || source === 'qq-bridge') {
    for (const p of cfg.qqBridgeCandidates ?? []) {
      if (fs.existsSync(p)) {
        const r = readQqBridge(p);
        if (r.stars.length || r.messages.length) { picked.push(r); break; }
      }
    }
  }
  if ((source === 'auto' || source === 'file') && cfg.dataFile && fs.existsSync(cfg.dataFile)) {
    picked.push(readCustom(cfg.dataFile));
  }
  const merged = picked.reduce((acc, r) => {
    acc.stars.push(...r.stars);
    acc.messages.push(...r.messages);
    return acc;
  }, { stars: [], messages: [] });
  return layout(merged);
}
