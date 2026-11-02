// 情绪与关系状态层（会话情绪 + 每 QQ 关系）。
//
// 设计原则（对应需求里的五条约束）：
//
// 1. **事件驱动，不随机贴标签**：情绪值只由 applyEmotionEvent 的已知事件改变，
//    没有随机扰动、也没有「看着像开心就 +0.1」这种推断。未知事件类型一律拒绝
//    （返回 ok:false，状态不动），所以任何一次状态变化都能追到一条明确的
//    cause（可读来源）+ causeType（事件类型）+ at（发生时刻）。
//
// 2. **半衰期衰减**：读出来的是「现在这一刻」的值——按 since 到现在的时长做
//    0.5^(age/halfLife)，不写回、不产生副作用。原始值（raw）只在事件发生时更新，
//    所以重启后靠持久化的 since 能继续正确衰减（不需要记录「上次衰减时刻」）。
//
// 3. **关系与情绪互相影响**：
//    - 关系 → 情绪：tension 高时，正面事件被削弱、负面事件被放大；
//    - 情绪 → 关系：valence 为负时，同样的事件让 tension 涨得更多、intimacy 涨得更少。
//    两边都是确定性的乘性调制，不引入随机。
//
// 4. **持久化复用 socialV2 会话状态**（st.mood / st.relationships），
//    由 socialv2-store 的 hydrate/serialize 统一处理，不新建存储文件。
//
// 5. **只读视图不创建会话**：getMood / getRelationship 只从内存 Map 读，
//    未知会话返回默认状态（known:false），不会凭空造出一条空会话。
//
// 依赖方向：socialv2-store.mjs → mood.mjs（store 调用这里的 normalize/serialize）。
// 本文件**不 import store**，避免循环依赖；key 归一化在这里保留一份极简实现。

/** 情绪衰减的默认半衰期：6 小时。 */
export const DEFAULT_DECAY_HALF_LIFE_MS = 6 * 60 * 60 * 1000;
/** 半衰期的合法范围（1 分钟 ~ 365 天），防止脏数据让衰减立刻失效或永远不衰减。 */
export const MIN_DECAY_HALF_LIFE_MS = 60 * 1000;
export const MAX_DECAY_HALF_LIFE_MS = 365 * 24 * 60 * 60 * 1000;

/** 情绪基线：没有任何事件时，以及衰减的归宿。 */
export const MOOD_BASELINE = Object.freeze({ valence: 0, arousal: 0.3, energy: 0.6 });

/** 关系默认值：认识但还生疏。 */
export const DEFAULT_INTIMACY = 0.3;
export const DEFAULT_TENSION = 0;

/** 各数组/映射的上限，避免长期运行后状态无限膨胀。 */
export const MAX_MOOD_EVENTS = 40;
export const MAX_RELATIONSHIP_EVENTS = 12;
export const MAX_OPEN_LOOPS = 20;
export const MAX_RELATIONSHIP_UIDS = 50;

/** 事件来源文本的截断长度。 */
const MAX_CAUSE_CHARS = 160;

/**
 * 情绪事件表：type → 对 (valence, arousal, energy) 的增量。
 *
 * 这些数值是「一次典型事件」的幅度，由表达层决定何时触发；桥接不猜、不随机。
 * 新增类型时请同时补 RELATIONSHIP_EVENTS（除了 openLoop / closeLoop 这类纯动作）。
 */
export const EMOTION_EVENTS = Object.freeze({
  praised: Object.freeze({ label: '被夸', valence: 0.35, arousal: 0.15, energy: 0.05 }),
  thanked: Object.freeze({ label: '被感谢', valence: 0.22, arousal: 0.06, energy: 0.04 }),
  comforted: Object.freeze({ label: '被安慰', valence: 0.30, arousal: -0.10, energy: 0.06 }),
  missed: Object.freeze({ label: '被想念', valence: 0.28, arousal: 0.12, energy: 0.03 }),
  teased: Object.freeze({ label: '被调侃', valence: -0.04, arousal: 0.15, energy: 0 }),
  ignored: Object.freeze({ label: '被冷落', valence: -0.30, arousal: 0.10, energy: -0.10 }),
  jealous: Object.freeze({ label: '吃醋', valence: -0.25, arousal: 0.20, energy: 0.05 }),
  quarrel: Object.freeze({ label: '争吵', valence: -0.45, arousal: 0.30, energy: -0.15 }),
  insulted: Object.freeze({ label: '被贬低', valence: -0.50, arousal: 0.25, energy: -0.10 }),
  rejected: Object.freeze({ label: '被拒绝', valence: -0.30, arousal: 0.18, energy: -0.08 }),
  makeup: Object.freeze({ label: '和好', valence: 0.40, arousal: 0.05, energy: 0.10 }),
  poked: Object.freeze({ label: '被拍一拍', valence: 0.08, arousal: 0.12, energy: 0.02 }),
  lonely: Object.freeze({ label: '冷场', valence: -0.12, arousal: -0.05, energy: -0.05 }),
});

/**
 * 关系事件表：type → 对 (intimacy, tension) 的增量。
 *
 * 需求点名的映射：冷落 → tension↑、哄 → tension↓；
 * openLoop / closeLoop 用于维护 openLoops（未了结的事）。openLoop 不产生数值变化；
 * closeLoop 只有在真的关掉一条时才应用 +0.01 / -0.03，未命中返回 loop_not_found
 * 且不改任何数值（见 applyRelationshipEvent）。
 */
export const RELATIONSHIP_EVENTS = Object.freeze({
  // 普通互动只是「多聊了一句」，数值必须很小：0.001 × 500 条才到 1。
  // 之前是 0.005（200 条到上限），配合刷屏很容易把关系打满（审查 r5 P1）。
  interaction: Object.freeze({ label: '互动', intimacy: 0.001, tension: -0.001 }),
  praised: Object.freeze({ label: '被夸', intimacy: 0.03, tension: 0 }),
  thanked: Object.freeze({ label: '被感谢', intimacy: 0.03, tension: 0 }),
  comforted: Object.freeze({ label: '被哄', intimacy: 0.04, tension: -0.08 }),
  missed: Object.freeze({ label: '被想念', intimacy: 0.04, tension: 0 }),
  teased: Object.freeze({ label: '被调侃', intimacy: 0.01, tension: 0.02 }),
  ignored: Object.freeze({ label: '被冷落', intimacy: -0.03, tension: 0.06 }),
  jealous: Object.freeze({ label: '吃醋', intimacy: 0, tension: 0.05 }),
  quarrel: Object.freeze({ label: '争吵', intimacy: -0.05, tension: 0.15 }),
  insulted: Object.freeze({ label: '被贬低', intimacy: -0.06, tension: 0.18 }),
  rejected: Object.freeze({ label: '被拒绝', intimacy: -0.04, tension: 0.10 }),
  makeup: Object.freeze({ label: '和好', intimacy: 0.05, tension: -0.20 }),
  poked: Object.freeze({ label: '拍一拍', intimacy: 0.01, tension: 0 }),
  lonely: Object.freeze({ label: '冷场', intimacy: -0.01, tension: 0.03 }),
  openLoop: Object.freeze({ label: '记下未了结的事', intimacy: 0, tension: 0 }),
  closeLoop: Object.freeze({ label: '了结了一件事', intimacy: 0.01, tension: -0.03 }),
});

const PROTECTED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ── 基础工具 ────────────────────────────────────────────────────────────────

/** 数值钳制；NaN/Infinity 用 fallback。 */
export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 毫秒时间戳归一化：非法/负数一律 0（0 表示「还没有任何事件」）。 */
function normalizeStamp(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return n;
}

function normalizeHalfLife(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DECAY_HALF_LIFE_MS;
  return Math.round(clamp(n, MIN_DECAY_HALF_LIFE_MS, MAX_DECAY_HALF_LIFE_MS));
}

/** 会话 key 归一化（与 socialv2-store 的 canonicalV2Key 同规则；这里保留一份避免循环 import）。 */
function canonicalKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

/** QQ 号归一化：只接受正整数（容忍前导零），返回无前导零的字符串形式。 */
export function canonicalUid(uid) {
  const s = String(uid ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return String(n);
}

/** 私聊会话对应的 QQ；群聊没有唯一对象，返回 null。 */
function uidFromKey(key) {
  const m = /^private:(\d+)$/.exec(String(key ?? ''));
  return m ? canonicalUid(m[1]) : null;
}

function cleanType(value) {
  const s = String(value ?? '').trim().slice(0, 40);
  return s;
}

function normalizeCause(cause, fallbackLabel = '') {
  const s = String(cause ?? '').replace(/\s+/g, ' ').trim();
  return (s || fallbackLabel).slice(0, MAX_CAUSE_CHARS);
}

/** 事件时刻：非法用 now；未来时刻钳到现在（否则 since 在未来，衰减会算出负年龄）。 */
function normalizeEventAt(at, now) {
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return now;
  const rounded = Math.round(n);
  return rounded > now ? now : rounded;
}

// ── 情绪：归一化 / 序列化 / 视图 ────────────────────────────────────────────

/** 默认情绪：中性、略有一点活跃度和精力。 */
export function defaultMood() {
  return {
    valence: MOOD_BASELINE.valence,
    arousal: MOOD_BASELINE.arousal,
    energy: MOOD_BASELINE.energy,
    cause: '',
    causeType: '',
    since: 0,
    decayHalfLifeMs: DEFAULT_DECAY_HALF_LIFE_MS,
    events: [],
  };
}

function normalizeMoodEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const at = normalizeStamp(ev.at);
  const type = cleanType(ev.type);
  // 没有时刻或没有类型的事件无法追溯来源，直接丢弃（宁缺勿滥）。
  if (!at || !type) return null;
  const d = ev.deltas && typeof ev.deltas === 'object' ? ev.deltas : {};
  return {
    at,
    type,
    cause: normalizeCause(ev.cause, EMOTION_EVENTS[type]?.label ?? type),
    deltas: {
      valence: finiteNumber(d.valence, 0),
      arousal: finiteNumber(d.arousal, 0),
      energy: finiteNumber(d.energy, 0),
    },
  };
}

/** 把任意落盘数据归一化成合法的 mood（边界钳制、事件过滤、裁剪）。 */
export function normalizeMood(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const events = Array.isArray(m.events)
    ? m.events.map(normalizeMoodEvent).filter(Boolean).slice(-MAX_MOOD_EVENTS)
    : [];
  return {
    valence: clamp(finiteNumber(m.valence, MOOD_BASELINE.valence), -1, 1),
    arousal: clamp(finiteNumber(m.arousal, MOOD_BASELINE.arousal), 0, 1),
    energy: clamp(finiteNumber(m.energy, MOOD_BASELINE.energy), 0, 1),
    cause: normalizeCause(m.cause, ''),
    causeType: cleanType(m.causeType),
    since: normalizeStamp(m.since),
    decayHalfLifeMs: normalizeHalfLife(m.decayHalfLifeMs),
    events,
  };
}

/** 落盘用：与 normalizeMood 同构（这里显式命名，方便 store 的序列化白名单自解释）。 */
export function serializeMood(mood) {
  return normalizeMood(mood);
}

/**
 * 按半衰期衰减到 at 时刻，返回「此刻」的三元值。
 *
 * 只做数学，不修改入参。没有 since（从未发生过事件）或半衰期非法时原样返回。
 * at 非法（NaN/Infinity/非数字）时回落到 Date.now()——可注入时钟出错不应把情绪翻到最负面。
 */
export function decayMood(mood, at = Date.now()) {
  const m = normalizeMood(mood);
  const halfLife = m.decayHalfLifeMs;
  if (!(m.since > 0) || !(halfLife > 0)) {
    return { valence: m.valence, arousal: m.arousal, energy: m.energy, ageMs: 0 };
  }
  const atNum = Number(at);
  const atSafe = Number.isFinite(atNum) ? atNum : Date.now();
  const ageMs = Math.max(0, atSafe - m.since);
  const factor = Math.pow(0.5, ageMs / halfLife);
  return {
    valence: clamp(m.valence * factor, -1, 1),
    arousal: clamp(MOOD_BASELINE.arousal + (m.arousal - MOOD_BASELINE.arousal) * factor, 0, 1),
    energy: clamp(MOOD_BASELINE.energy + (m.energy - MOOD_BASELINE.energy) * factor, 0, 1),
    ageMs,
  };
}

// ── 关系：归一化 / 序列化 ──────────────────────────────────────────────────

/** 默认关系状态（亲密 0.3、无张力、没有未了结的事）。 */
export function defaultRelationship() {
  return {
    intimacy: DEFAULT_INTIMACY,
    tension: DEFAULT_TENSION,
    lastInteraction: 0,
    openLoops: [],
    events: [],
  };
}

function normalizeOpenLoop(loop) {
  if (!loop || typeof loop !== 'object') return null;
  const text = normalizeCause(loop.text, '');
  if (!text) return null;
  const openedAt = normalizeStamp(loop.openedAt);
  const id = String(loop.id ?? '').trim() || `${openedAt}:${text.slice(0, 24)}`;
  return { id: id.slice(0, 80), text, openedAt };
}

function normalizeRelationshipEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const at = normalizeStamp(ev.at);
  const type = cleanType(ev.type);
  if (!at || !type) return null;
  const d = ev.deltas && typeof ev.deltas === 'object' ? ev.deltas : {};
  return {
    at,
    type,
    cause: normalizeCause(ev.cause, RELATIONSHIP_EVENTS[type]?.label ?? type),
    key: canonicalKey(ev.key) ?? '',
    deltas: {
      intimacy: finiteNumber(d.intimacy, 0),
      tension: finiteNumber(d.tension, 0),
    },
  };
}

/** 把任意落盘数据归一化成合法的关系状态。 */
export function normalizeRelationship(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const openLoops = Array.isArray(r.openLoops)
    ? r.openLoops.map(normalizeOpenLoop).filter(Boolean).slice(-MAX_OPEN_LOOPS)
    : [];
  const events = Array.isArray(r.events)
    ? r.events.map(normalizeRelationshipEvent).filter(Boolean).slice(-MAX_RELATIONSHIP_EVENTS)
    : [];
  return {
    intimacy: clamp(finiteNumber(r.intimacy, DEFAULT_INTIMACY), 0, 1),
    tension: clamp(finiteNumber(r.tension, DEFAULT_TENSION), 0, 1),
    lastInteraction: normalizeStamp(r.lastInteraction),
    openLoops,
    events,
  };
}

/** 只保留互动时间最新的 MAX_RELATIONSHIP_UIDS 个人，防止 Map 无限膨胀。 */
function pruneRelationshipMap(map) {
  const entries = Object.entries(map);
  if (entries.length <= MAX_RELATIONSHIP_UIDS) return map;
  entries.sort((a, b) => (b[1]?.lastInteraction || 0) - (a[1]?.lastInteraction || 0));
  const out = {};
  for (const [uid, rel] of entries.slice(0, MAX_RELATIONSHIP_UIDS)) out[uid] = rel;
  return out;
}

/** 把任意落盘数据归一化成 { uid → 关系状态 }（过滤原型污染键与非法 QQ 号）。 */
export function normalizeRelationships(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [uid, rel] of Object.entries(raw)) {
    if (PROTECTED_KEYS.has(uid)) continue;
    const u = canonicalUid(uid);
    if (!u) continue;
    out[u] = normalizeRelationship(rel);
  }
  return pruneRelationshipMap(out);
}

/** 落盘用。 */
export function serializeRelationships(rels) {
  return normalizeRelationships(rels);
}

// ── 状态层：给表达层/控制台用的 API ────────────────────────────────────────

/**
 * 创建情绪与关系状态层。
 *
 * @param {object} deps
 * @param {(key: string) => object} [deps.getState]  写路径取会话状态（可创建；bridge 的 getSocialV2State）
 * @param {(key: string) => object|null} [deps.peekState]  读路径取会话状态（**不创建**）
 * @param {Map<string, object>|(() => Map<string, object>)} [deps.conversations] 会话 Map（关系聚合用）
 * @param {() => void} [deps.save] 落盘回调（写操作后调用）
 * @param {() => number} [deps.now] 时钟（测试注入假时钟）
 */
export function createMoodLayer({
  getState,
  peekState,
  conversations,
  save,
  now = () => Date.now(),
} = {}) {
  if (typeof now !== 'function') throw new TypeError('createMoodLayer 需要 now 函数');

  /**
   * 取会话 Map。**不能用 `instanceof Map` 判断**：bridge 在 VM/多 realm 里运行时，
   * 它的 Map 来自另一个 realm，`instanceof` 会失败并被当成普通对象 → 被当成空 Map，
   * 关系聚合/合并全部失明（审查第三轮 P1：bridge 真实路径测试因此假绿）。
   * 这里用 duck-typing：有 get / entries / Symbol.iterator 就当 Map 用。
   */
  function isMapLike(value) {
    return Boolean(value)
      && typeof value.get === 'function'
      && typeof value.entries === 'function'
      && typeof value[Symbol.iterator] === 'function';
  }

  function conversationMap() {
    const c = typeof conversations === 'function' ? conversations() : conversations;
    if (isMapLike(c)) return c;
    if (c && typeof c === 'object') return new Map(Object.entries(c));
    return new Map();
  }

  function peek(key) {
    const k = canonicalKey(key);
    if (!k) return null;
    if (typeof peekState === 'function') {
      try {
        return peekState(k) ?? null;
      } catch {
        return null;
      }
    }
    return conversationMap().get(k) ?? null;
  }

  function ensure(key) {
    if (typeof getState !== 'function') {
      throw new Error('createMoodLayer：写操作需要注入 getState');
    }
    return getState(key);
  }

  /** 读某个会话的当前情绪（衰减后的显示值 + 原始值 + 最近来源事件）。纯读，不创建会话。 */
  function getMood(key) {
    const k = canonicalKey(key);
    if (!k) {
      return {
        key: String(key ?? ''),
        valid: false,
        known: false,
        ...defaultMood(),
        raw: { ...MOOD_BASELINE },
        ageMs: 0,
      };
    }
    const st = peek(k);
    const stored = st && st.mood && typeof st.mood === 'object' ? st.mood : null;
    const base = stored ? normalizeMood(stored) : defaultMood();
    const t = typeof now === 'function' ? now() : Date.now();
    const view = decayMood(base, t);
    return {
      key: k,
      valid: true,
      known: Boolean(st),
      valence: view.valence,
      arousal: view.arousal,
      energy: view.energy,
      raw: { valence: base.valence, arousal: base.arousal, energy: base.energy },
      cause: base.cause,
      causeType: base.causeType,
      since: base.since,
      decayHalfLifeMs: base.decayHalfLifeMs,
      ageMs: view.ageMs,
      events: base.events.slice(-MAX_MOOD_EVENTS),
    };
  }

  /**
   * 应用一条情绪事件。
   *
   * @param {string} key 会话 key（group:群号 / private:QQ号）
   * @param {{type: string, cause?: string, at?: number, uid?: string, decayHalfLifeMs?: number}} event
   *   decayHalfLifeMs **覆盖整份 mood 的新半衰期**（不是单事件独立衰减）。
   * @returns {{ok: boolean, reason?: string, key: string, type?: string, at?: number, cause?: string, mood?: object}}
   */
  function applyEmotionEvent(key, event = {}) {
    const k = canonicalKey(key);
    if (!k) return { ok: false, reason: 'invalid_key', key: String(key ?? '') };
    const type = cleanType(event?.type);
    const def = EMOTION_EVENTS[type];
    // 未知事件：明确拒绝，绝不猜测/编造情绪（这就是「不能随机贴标签」的硬边界）。
    if (!def) return { ok: false, reason: 'unknown_event_type', key: k, type };

    // 显式传入 uid 就必须合法：群聊接线把 uid 写错时不能静默退化成「无调制」。
    const explicitUid = event?.uid === undefined || event?.uid === null ? null : String(event.uid).trim();
    let uid = null;
    if (explicitUid !== null) {
      uid = canonicalUid(explicitUid);
      if (!uid) return { ok: false, reason: 'invalid_uid', key: k, uid: explicitUid };
    } else {
      uid = uidFromKey(k);
    }

    const t = now();
    const at = normalizeEventAt(event?.at, t);
    const cause = normalizeCause(event?.cause, def.label);
    const st = ensure(k);
    const base = normalizeMood(st.mood);

    // 晚到的历史事件：明确拒绝，不把它的增量叠加到「现在」的状态上、也不覆盖 cause/since。
    // （契约：at < since → stale_event，状态与落盘都不动。）
    if (base.since > 0 && at < base.since) {
      return { ok: false, reason: 'stale_event', key: k, type, at, since: base.since };
    }

    // 1) 先把旧状态衰减到事件发生的那一刻，再叠加增量（同一时刻连续事件不会重复享受「未衰减」的旧值）。
    const current = decayMood(base, at);
    // 2) 关系调制：tension 高时，正面事件被削弱、负面事件被放大。
    // 用这个 uid 的**聚合**张力：关系是「每个 QQ 一份」，主记录可能落在别的会话，
    // 只读当前会话的 relationships 会在「私聊养出的张力、群聊里被夸」时漏掉调制。
    const tension = uid
      ? allRelationshipRecords(uid).reduce((max, record) => Math.max(max, record.rel.tension), 0)
      : 0;
    const factor = def.valence >= 0 ? (1 - tension * 0.5) : (1 + tension * 0.5);

    const deltas = {
      valence: def.valence * factor,
      arousal: def.arousal,
      energy: def.energy,
    };
    const next = {
      valence: clamp(current.valence + deltas.valence, -1, 1),
      arousal: clamp(current.arousal + deltas.arousal, 0, 1),
      energy: clamp(current.energy + deltas.energy, 0, 1),
      cause,
      causeType: type,
      since: Math.max(base.since, at),
      decayHalfLifeMs: normalizeHalfLife(event?.decayHalfLifeMs ?? base.decayHalfLifeMs),
      events: [...base.events, { at, type, cause, deltas }].slice(-MAX_MOOD_EVENTS),
    };
    st.mood = next;
    save?.();
    return { ok: true, key: k, type, at, cause, mood: getMood(k) };
  }

  /** 从会话状态里读某个 uid 的关系（只读，不写）。 */
  function readRelationshipFrom(st, uid) {
    const rels = st && st.relationships && typeof st.relationships === 'object' ? st.relationships : null;
    if (!rels) return null;
    const raw = rels[uid];
    if (!raw || typeof raw !== 'object') return null;
    return normalizeRelationship(raw);
  }

  /**
   * 某个 uid 在所有会话里的关系记录。
   * 新写入保证「每个 uid 只有一份主记录」，所以正常情况长度 ≤ 1；
   * 多份只可能来自旧数据，读取时仍按聚合规则展示。
   */
  function allRelationshipRecords(uid) {
    const out = [];
    for (const [key, st] of conversationMap()) {
      const rel = readRelationshipFrom(st, uid);
      if (rel) out.push({ key, st, rel });
    }
    return out;
  }

  /**
   * 读某个 QQ 的关系状态。
   *
   * 新写入保证「每个 uid 只有一份主记录」（见 applyRelationshipEvent），正常情况
   * 这里只有一条记录。仍保留跨分片聚合，是为了兼容旧数据以及手工写入的多份记录：
   * - intimacy 取所有分片里的最高累计（较新的低值分片不能压住旧的累计值）；
   * - tension 取所有场合里最高的（任一场合紧张都算紧张）；
   * - lastInteraction 取最近一次；
   * - openLoops 合并去重；events 合并去重后按时间取最近几条。
   * 纯读，不创建会话。
   */
  function getRelationship(uid) {
    const u = canonicalUid(uid);
    if (!u) {
      return {
        uid: String(uid ?? ''),
        valid: false,
        known: false,
        ...defaultRelationship(),
        sources: [],
      };
    }
    const records = allRelationshipRecords(u);
    if (!records.length) {
      return { uid: u, valid: true, known: false, ...defaultRelationship(), sources: [] };
    }
    // 主记录 = lastInteraction 最大的那份；旧多分片时按「合并规则」展示（与写入端一致）：
    // intimacy 取最高累计、tension 取最高、openLoops/events 合并去重。
    const base = records.reduce((a, b) => (b.rel.lastInteraction >= a.rel.lastInteraction ? b : a));
    const intimacy = records.reduce((max, r) => Math.max(max, r.rel.intimacy), 0);
    const tension = records.reduce((max, r) => Math.max(max, r.rel.tension), 0);
    const loopMap = new Map();
    for (const { rel } of records) {
      for (const loop of rel.openLoops) if (!loopMap.has(loop.id)) loopMap.set(loop.id, loop);
    }
    const openLoops = [...loopMap.values()]
      .sort((a, b) => a.openedAt - b.openedAt)
      .slice(-MAX_OPEN_LOOPS);
    const eventMap = new Map();
    for (const { rel } of records) {
      for (const event of rel.events) eventMap.set(`${event.at}:${event.type}:${event.cause}`, event);
    }
    const events = [...eventMap.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_RELATIONSHIP_EVENTS);
    return {
      uid: u,
      valid: true,
      known: true,
      intimacy,
      tension,
      lastInteraction: base.rel.lastInteraction,
      openLoops,
      events,
      sources: records.map((r) => r.key),
    };
  }

  /** 旧多分片合并规则：intimacy/tension/lastInteraction 取 max，loops 按 id 合并，events 按 at+type+cause 去重。 */
  function mergeRelationshipRecords(records) {
    const lastInteraction = records.reduce((max, r) => Math.max(max, r.rel.lastInteraction || 0), 0);
    const intimacy = records.reduce((max, r) => Math.max(max, r.rel.intimacy), 0);
    const tension = records.reduce((max, r) => Math.max(max, r.rel.tension), 0);
    const loopMap = new Map();
    for (const { rel } of records) {
      for (const loop of rel.openLoops) if (!loopMap.has(loop.id)) loopMap.set(loop.id, loop);
    }
    const openLoops = [...loopMap.values()]
      .sort((a, b) => a.openedAt - b.openedAt)
      .slice(-MAX_OPEN_LOOPS);
    const eventMap = new Map();
    for (const { rel } of records) {
      for (const event of rel.events) eventMap.set(`${event.at}:${event.type}:${event.cause}`, event);
    }
    const events = [...eventMap.values()]
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_RELATIONSHIP_EVENTS);
    return { intimacy, tension, lastInteraction, openLoops, events };
  }

  /** 删除某个会话里该 uid 的关系记录（合并旧分片时用）。 */
  function deleteRelationshipFrom(st, uid) {
    if (!st || !st.relationships || typeof st.relationships !== 'object' || Array.isArray(st.relationships)) return;
    if (!st.relationships[uid]) return;
    const rels = { ...st.relationships };
    delete rels[uid];
    st.relationships = rels;
  }

  /** 把关系写回某个会话（内部用）。 */
  function writeRelationshipTo(st, uid, rel) {
    const rels = st.relationships && typeof st.relationships === 'object' && !Array.isArray(st.relationships)
      ? { ...st.relationships }
      : {};
    rels[uid] = rel;
    st.relationships = pruneRelationshipMap(normalizeRelationships(rels));
  }

  /**
   * 应用一条关系事件（对某个 QQ）。
   *
   * @param {string|number} uid QQ 号
   * @param {{type: string, cause?: string, at?: number, key?: string, text?: string, id?: string, loopId?: string}} event
   *   key 可选：事件发生在哪个会话（默认私聊 private:<uid>）；群聊事件请显式传群 key。
   *   注意：关系值是「每个 uid 一份主记录」，key 只决定这次事件的会话语境
   *   （情绪调制、来源追溯），不决定数值存在哪里。
   * @returns {{ok: boolean, reason?: string, uid: string, type?: string, at?: number, cause?: string, relationship?: object}}
   */
  function applyRelationshipEvent(uid, event = {}) {
    const u = canonicalUid(uid);
    if (!u) return { ok: false, reason: 'invalid_uid', uid: String(uid ?? '') };
    const type = cleanType(event?.type);
    const def = RELATIONSHIP_EVENTS[type];
    if (!def) return { ok: false, reason: 'unknown_event_type', uid: u, type };
    // key 可选：不传就落到私聊（事件对象就是这个 uid）；传了但非法要明确报错，不能悄悄改写到私聊。
    const explicitKey = event?.key === undefined || event?.key === null ? null : String(event.key).trim();
    const contextKey = explicitKey ? canonicalKey(explicitKey) : `private:${u}`;
    if (!contextKey) return { ok: false, reason: 'invalid_key', uid: u, key: explicitKey ?? '' };

    const t = now();
    const at = normalizeEventAt(event?.at, t);
    const cause = normalizeCause(event?.cause, def.label);

    // ── 单主记录：每个 uid 只维护一份关系状态，所有会话的事件都写这一份 ──
    // 物理上它可能落在任意一个会话里（哪个会话先记录就落在哪），所以写入前先找它。
    // 首次遇到旧多分片时，先按合并规则收敛成一份主记录，再应用新事件（审查 P2-1）。
    const records = allRelationshipRecords(u);
    const home = records.length
      ? records.reduce((a, b) => (b.rel.lastInteraction >= a.rel.lastInteraction ? b : a))
      : null;
    const merged = records.length > 1 ? mergeRelationshipRecords(records) : null;
    const base = merged ?? (home ? home.rel : defaultRelationship());

    // 晚到的历史事件：拒绝，避免旧争吵被叠加到后来的和好之上（审查 P1-1）。
    if (base.lastInteraction > 0 && at < base.lastInteraction) {
      return { ok: false, reason: 'stale_event', uid: u, type, at, lastInteraction: base.lastInteraction };
    }

    // closeLoop 必须真的关掉一条才算「了结」：找不到就明确拒绝，不能白送关系奖励（审查 P1-4）。
    const closedLoopIds = new Set();
    if (type === 'closeLoop') {
      const loopId = String(event?.loopId ?? '').trim();
      const text = normalizeCause(event?.text, normalizeCause(event?.cause, ''));
      for (const loop of base.openLoops) {
        const hit = loopId ? loop.id === loopId : (text ? loop.text === text : false);
        if (hit) closedLoopIds.add(loop.id);
      }
      if (!closedLoopIds.size) return { ok: false, reason: 'loop_not_found', uid: u, type, key: contextKey };
    }

    // 情绪调制用「事件发生的那个会话」的心情；关系数值始终写主记录。
    const contextSt = peek(contextKey);
    const moodView = decayMood(contextSt?.mood, at);
    const negative = Math.max(0, -moodView.valence);
    const intimacyFactor = 1 - negative * 0.2;
    const tensionFactor = 1 + negative * 0.5;
    const intimacyDelta = def.intimacy * intimacyFactor;
    const tensionDelta = def.tension > 0 ? def.tension * tensionFactor : def.tension;

    const openLoops = base.openLoops.filter((loop) => !closedLoopIds.has(loop.id));
    if (type === 'openLoop') {
      const text = normalizeCause(event?.text, normalizeCause(event?.cause, ''));
      const exists = base.openLoops.some((loop) => loop.text === text);
      if (text && !exists) {
        openLoops.push({
          id: String(event?.id ?? '').trim().slice(0, 80) || `${at}:${text.slice(0, 24)}`,
          text,
          openedAt: at,
        });
        if (openLoops.length > MAX_OPEN_LOOPS) openLoops.splice(0, openLoops.length - MAX_OPEN_LOOPS);
      }
    }

    const next = {
      intimacy: clamp(base.intimacy + intimacyDelta, 0, 1),
      tension: clamp(base.tension + tensionDelta, 0, 1),
      lastInteraction: Math.max(base.lastInteraction || 0, at),
      openLoops,
      events: [...base.events, {
        at,
        type,
        cause,
        key: contextKey,
        deltas: { intimacy: intimacyDelta, tension: tensionDelta },
      }].slice(-MAX_RELATIONSHIP_EVENTS),
    };

    // 已有主记录就写它；没有就落在事件上下文会话（不凭空创建别的会话）。
    // 首次建记录时若该 QQ 的私聊会话已存在，优先放私聊：私聊被 reset 的概率远低于群。
    const privateKey = `private:${u}`;
    const targetSt = home
      ? home.st
      : (peek(privateKey) ? ensure(privateKey) : ensure(contextKey));
    writeRelationshipTo(targetSt, u, next);
    // 合并完成：删除旧的其它分片副本（真正收敛成一份）。
    for (const record of records) {
      if (record.st !== targetSt) deleteRelationshipFrom(record.st, u);
    }
    save?.();
    return { ok: true, uid: u, key: contextKey, type, at, cause, relationship: getRelationship(u) };
  }

  return { getMood, applyEmotionEvent, getRelationship, applyRelationshipEvent };
}

// ── 桥接接线：入站文本分类 + 事件分发 ─────────────────────────────────────
//
// 状态层只接受显式事件；这里把「真实运行里能确定的事件」翻译成事件：
// - 入站消息：一定算一次互动（关系微增），文本能明确判定时再叠加情绪/关系事件；
// - 拍一拍：拍的是自己才算情绪事件；
// - 出站消息：只更新关系互动，不改情绪；
// - 冷落：私聊里我发言后对方长时间没回，3 小时内最多记一次。
//
// 分类原则：只匹配明确措辞，匹配不到就返回 null（「无法判定就不产生事件」）。
// 所有接线逻辑都是纯函数，bridge 只负责在合适的位置调用（见 bridge.js 的 4 个调用点）。

/** 冷落事件的去重窗口：3 小时。 */
export const NEGLECT_REPEAT_GAP_MS = 3 * 60 * 60 * 1000;
/** 同类事件的冷却窗口：同一 actor 同一 type 在窗口内只应用一次增量（防刷屏打满状态，审查 r5 P1）。 */
export const SAME_EVENT_COOLDOWN_MS = 30 * 1000;

/**
 * 入站文本 → 事件类型（确定性、保守）。
 *
 * 规则字段：
 * - type：事件类型（情绪事件必须同时在 EMOTION_EVENTS 里；关系动作只存在于 RELATIONSHIP_EVENTS）
 * - polarity：'positive' 表示会被否定语境保护（「我不喜欢你」不能算成被夸）；
 *   'negative' 不受否定保护（「别烦我」本身就是负向措辞）
 * - relationshipOnly：只写关系、不写情绪（openLoop / closeLoop）
 *
 * 顺序有意义：明确的否定/恶化规则在最前（否则「我不喜欢你了」会先匹配到「喜欢你」），
 * 然后是和好/安慰（「别生气了」不是争吵），再是正向、负向、最后是关系动作。
 */
export const INCOMING_EVENT_RULES = Object.freeze([
  // ── 明确否定/恶化：优先于所有正向规则 ──
  Object.freeze({ type: 'rejected', polarity: 'negative', re: /(?:不喜欢你|不爱你|不想要你|不想你|不接受.{0,8}抱歉|不原谅你|不想原谅你|别再来找我|不想跟你)/ }),
  // 只认「直接对 AI 说」的贬低；裸词「垃圾/废物」会误伤「垃圾游戏真难玩」这类对物的评价。
  Object.freeze({ type: 'insulted', polarity: 'negative', re: /(?:你就是个?废物|你个废物|你是废物|你就是个?垃圾|你个垃圾|你是垃圾|你就是个?蠢货|你个蠢货|你没用|你什么都不是|你蠢死)/ }),
  Object.freeze({ type: 'jealous', polarity: 'negative', re: /(?:吃醋|嫉妒|我(?:在|跟)(?:别人|其他人|他|她)一起|和(?:别人|其他人)约|你(?:在|跟).{0,4}(?:别人|其他人|她|他).{0,12}(?:聊天|玩|约))/ }),
  // 「好无聊的剧情」是评价剧情，不是冷场；只有「好无聊啊 / 太无聊了」这类独立感叹才算。
  Object.freeze({ type: 'lonely', polarity: 'negative', re: /(?:好无聊啊|太无聊了|好无聊(?!的)|没人说话|好冷清|好安静啊|都没人)/ }),
  // ── 关系修复（先于争吵/调侃）──
  Object.freeze({ type: 'makeup', polarity: 'positive', re: /(?:对不起|我错了|原谅我|和好吧|别生气了|不生气了|是我不对|抱歉)/ }),
  Object.freeze({ type: 'comforted', polarity: 'positive', re: /(?:别难过|不难过|别伤心|不哭|抱抱|抱一抱|摸摸头|我懂你|安慰你|哄哄你|别放在心上)/ }),
  Object.freeze({ type: 'missed', polarity: 'positive', re: /(?:想你了|好想你|想你啦|什么时候回来|好久不见)/ }),
  Object.freeze({ type: 'praised', polarity: 'positive', re: /(?:好可爱|真可爱|太可爱|好棒|真棒|好厉害|真厉害|好聪明|真聪明|好温柔|真温柔|好贴心|真贴心|你真棒|喜欢你|爱你|好乖|真乖|优秀)/ }),
  Object.freeze({ type: 'rejected', polarity: 'negative', re: /(?:不要你|不需要你|不想跟你|别来找我|离我远点|别烦我)/ }),
  Object.freeze({ type: 'quarrel', polarity: 'negative', re: /(?:滚开|闭嘴|少来烦我|讨厌你|烦不烦|不想理你|说不通|你懂什么)/ }),
  Object.freeze({ type: 'teased', polarity: 'negative', re: /(?:笑死|你好菜|笨蛋|傻子|就这)/ }),
  Object.freeze({ type: 'thanked', polarity: 'positive', re: /(?:谢谢你|感谢你|多谢|谢谢啦|谢谢你啊)/ }),
  // ── 关系动作：只写关系，不写情绪（真实运行时入口）──
  Object.freeze({ type: 'openLoop', relationshipOnly: true, re: /(?:你答应(?:我|过)|说好(?:的|了)|约好(?:的|了)|你欠我|欠我(?:一个|一顿|一次)|别忘了(?:你)?答应)/ }),
  Object.freeze({ type: 'closeLoop', relationshipOnly: true, re: /(?:给你了|已经给了|还你了|做完了|办好了|唱完了|给你做了|已经办好了)/ }),
]);

/** 转折词：以「最后的态度」为准（「别生气了，但我还是不想原谅你」→ 不产生和好事件）。 */
const TURN_SPLIT_RE = /(?:但是|但|可是|不过|然而|只是)/;
/** 分句边界：否定保护在分句内判断，而不是只看紧邻两个字。 */
const CLAUSE_SPLIT_RE = /[，,。；;！!？?\n]/;
/** 否定词（分句级）。 */
const NEGATION_RE = /(?:不|没|别|未|并不|才不|不是|没有|从不|不再)/;

/** 匹配位置所在分句里、匹配位置之前是否出现否定词。 */
function clauseHasNegationBefore(segment, index) {
  let start = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (CLAUSE_SPLIT_RE.test(segment[i])) { start = i + 1; break; }
  }
  return NEGATION_RE.test(segment.slice(start, index));
}

/** 匹配词本身是否以否定开头（「不想你」——用于双重否定判断）。 */
function matchStartsWithNegation(text) {
  return /^(?:不|没|别|未|并不|才不|不是|没有|从不|不再)/.test(text);
}

/**
 * 询问句不产生事件：
 * - 情绪事件：`吗/么/呢/?/？` 结尾都算询问（「你好可爱吗」「没觉得你好可爱吗」）；
 * - 关系动作：只有 `吗/么/?/？` 结尾算询问（「你做完了吗」）——「你答应我的事呢」是提醒，不算。
 */
function isQuestionSentence(segment, { forRelationshipAction = false } = {}) {
  if (/[?？]\s*$/.test(segment)) return true;
  if (/(?:吗|么)\s*[?？]?\s*$/.test(segment)) return true;
  if (!forRelationshipAction && /(?:呢)\s*[?？]?\s*$/.test(segment)) return true;
  return false;
}

/**
 * 判定一条入站文本对应哪种事件；判不出来返回 null（不产生事件）。
 * - 超过 200 字（长文/转发）不猜；
 * - 有转折词时只看转折之后的分句（以最后的态度为准）；
 * - 询问句不产生情绪事件（「你做完了吗」不是「做完了」）；
 * - 分句级否定保护（「我没觉得你好可爱」「我不是很喜欢你」不能算成被夸）；
 * - 双重否定保护（「我不是不想你」不能算成被拒绝）。
 */
export function classifyIncomingEvent(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 200) return null;
  const parts = raw.split(TURN_SPLIT_RE).map((part) => part.trim()).filter(Boolean);
  const segment = parts.length > 1 ? parts[parts.length - 1] : raw;
  if (!segment) return null;
  const questionForEmotion = isQuestionSentence(segment);
  const questionForAction = isQuestionSentence(segment, { forRelationshipAction: true });
  for (const rule of INCOMING_EVENT_RULES) {
    const match = rule.re.exec(segment);
    if (!match) continue;
    if (rule.relationshipOnly ? questionForAction : questionForEmotion) continue;
    const negatedBefore = clauseHasNegationBefore(segment, match.index);
    // 分句级否定：正向事件前面有否定就跳过（「我没觉得你好可爱」「我不是很喜欢你」）
    if (rule.polarity === 'positive' && negatedBefore) continue;
    // 双重否定：负向规则的匹配词本身以否定开头（「不想你」），前面又有否定（「我不是」）→ 语义反转，跳过
    if (rule.polarity === 'negative' && negatedBefore && matchStartsWithNegation(match[0])) continue;
    return {
      type: rule.type,
      label: EMOTION_EVENTS[rule.type]?.label ?? RELATIONSHIP_EVENTS[rule.type]?.label ?? rule.type,
      relationshipOnly: rule.relationshipOnly === true,
    };
  }
  return null;
}

/**
 * 桥接用的事件分发器：把「消息/拍一拍/出站/冷落」翻译成情绪与关系事件。
 *
 * 审计要点：
 * - 同一件事要么两边都写、要么两边都不写（先做 stale 预检）；
 * - 所有失败都走显式 reason，不静默；
 * - 不产生随机事件（分类是确定性的；冷落去重基于时间，不基于概率）。
 */
export function createMoodEventDispatcher({
  getState,
  peekState,
  conversations,
  save,
  now = () => Date.now(),
  isPaused = () => false,
} = {}) {
  const layer = createMoodLayer({ getState, peekState, conversations, save, now });

  // ── 冷却账本（审查 r6 P1）──
  // 不能用 relationship.events 当冷却账本：它最多只保留 12 条、且每次冷却消息仍写 interaction
  // 会把真实的 praised 挤出历史，导致 30 秒内重复应用。这里用独立的运行时 Map：
  //   key = `${主体}:${type}`（主体优先 uid，群聊无 uid 时用 key），value = 上次真正应用增量的时刻。
  // 不落盘：重启后清空（重启后第一条同类型事件立即生效是合理语义）。
  const cooldownLedger = new Map();

  function pruneCooldown(t) {
    for (const [key, at] of cooldownLedger) {
      if (t - at >= SAME_EVENT_COOLDOWN_MS) cooldownLedger.delete(key);
    }
  }

  /**
   * 判断同类事件是否还在冷却窗口；不在窗口内则登记本次应用并返回 false。
   * @returns {boolean} true = 命中冷却（本次不应叠加增量）
   */
  function isCooling(subject, type, t) {
    pruneCooldown(t);
    const key = `${subject}:${type}`;
    const last = cooldownLedger.get(key);
    if (last !== undefined && t - last < SAME_EVENT_COOLDOWN_MS) return true;
    cooldownLedger.set(key, t);
    return false;
  }

  /** 所有事件源的统一暂停闸门：暂停 = 冻结，任何 mood/relationship 变更都不写，但返回统一结构。 */
  function pausedResult(t) {
    return isPaused() ? { ok: true, at: t, skipped: 'paused' } : null;
  }

  /** 事件两边的时间锚：mood 的 since、关系的 lastInteraction。 */
  function anchorsFor(key, uid) {
    const moodView = layer.getMood(key);
    const relView = uid ? layer.getRelationship(uid) : null;
    return [moodView.since, relView?.lastInteraction]
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  /**
   * 同一件事同时喂情绪和关系。先在两边做 stale 预检：
   * 只要有一边认为事件是「晚到的历史事件」，两边都不写（避免只写一边）。
   */
  function applyPair({ contextKey, uid, emotionType, relationshipType, cause, at }) {
    const t = normalizeEventAt(at, now());
    const anchors = anchorsFor(contextKey, uid);
    if (anchors.some((anchor) => t < anchor)) {
      return { ok: false, reason: 'stale_event', at: t };
    }
    const out = { ok: true, at: t, emotion: null, relationship: null };
    if (emotionType) {
      out.emotion = layer.applyEmotionEvent(contextKey, { type: emotionType, cause, at: t, uid });
    }
    if (relationshipType && uid) {
      out.relationship = layer.applyRelationshipEvent(uid, { type: relationshipType, cause, at: t, key: contextKey });
    }
    // 类型/uid 已在上层校验过；这里只防御「预检之后状态又被改」的极端情况。
    if (out.emotion && out.emotion.ok === false) return out.emotion;
    if (out.relationship && out.relationship.ok === false) return out.relationship;
    return out;
  }

  /**
   * 解析事件对象：显式 uid 非法 → invalid_uid；私聊 key 与显式 uid 不一致 → uid_mismatch；
   * 群聊没给 uid → { uid: null }（允许只记情绪，不写关系）。
   */
  function resolveUid(contextKey, uid) {
    const explicit = uid === undefined || uid === null || String(uid).trim() === '' ? null : String(uid).trim();
    if (explicit !== null) {
      const u = canonicalUid(explicit);
      if (!u) return { ok: false, reason: 'invalid_uid', uid: explicit };
      const derived = uidFromKey(contextKey);
      if (derived && derived !== u) return { ok: false, reason: 'uid_mismatch', uid: u, expected: derived };
      return { ok: true, uid: u };
    }
    return { ok: true, uid: uidFromKey(contextKey) };
  }

  /** 入站消息：先记一次互动，再按文本判定事件。 */
  function dispatchIncoming({ key, uid, text, directedAtSelf = false, at } = {}) {
    const contextKey = canonicalKey(key);
    if (!contextKey) return { ok: false, reason: 'invalid_key' };
    // 参数校验优先：显式 uid 非法 / 与私聊 key 不一致要报错，而不是被「群聊不指向 AI」静默吞掉。
    const target = resolveUid(contextKey, uid);
    if (!target.ok) return { ok: false, reason: target.reason, uid: target.uid };
    // 群聊方向门控（审查 r5 P1）：只有明确指向 AI（@/引用自己）的消息才改变「我和她」的情绪与关系。
    // 群友之间的聊天、评价别人或作品不产生 AI 的情绪。私聊天然都是对她说的。
    const isPrivate = contextKey.startsWith('private:');
    if (!isPrivate && directedAtSelf !== true) {
      return { ok: true, at: normalizeEventAt(at, now()), skipped: 'not-directed-at-ai' };
    }
    const targetUid = target.uid;
    const t = normalizeEventAt(at, now());
    // 暂停闸门（审查 r6 P2）：暂停期间不更新情绪/关系；拍一拍/出站/冷落同样走各 dispatch 内的闸门。
    const paused = pausedResult(t);
    if (paused) return paused;
    const anchors = anchorsFor(contextKey, targetUid);
    if (anchors.some((anchor) => t < anchor)) return { ok: false, reason: 'stale_event', at: t };

    const classified = classifyIncomingEvent(text);
    const rawText = String(text ?? '').replace(/\s+/g, ' ').trim();
    const cause = rawText.slice(0, 120) || classified?.label || '收到一条消息';

    // closeLoop 预检（审查第三轮 P1）：没有可关闭的未了结事项时**什么都不写**——
    // 连「任何消息都算一次 interaction」也不行，否则失败仍会把 intimacy 从 0.300 推到 0.305。
    let closedLoopTarget = null;
    if (classified?.type === 'closeLoop') {
      if (!targetUid) return { ok: true, at: t, eventType: null, skipped: 'no-uid' };
      const loops = layer.getRelationship(targetUid).openLoops;
      if (!loops.length) return { ok: false, reason: 'loop_not_found', eventType: 'closeLoop', at: t };
      closedLoopTarget = loops.reduce((a, b) => (a.openedAt <= b.openedAt ? a : b));
    }

    // 同类事件冷却（审查 r5 P1 / r6 P1）：独立账本，同主体同类型 30s 内只应用一次增量。
    // 只对情绪事件生效；openLoop/closeLoop 是动作，不受冷却影响。
    const cooldownSubject = targetUid ?? contextKey;
    const cooled = Boolean(classified) && !classified.relationshipOnly
      && isCooling(cooldownSubject, classified.type, t);

    // 任何消息都是一次真实互动（interaction 数值已降到 0.001，且不参与冷却）。
    if (targetUid) {
      layer.applyRelationshipEvent(targetUid, { type: 'interaction', cause, at: t, key: contextKey });
    }
    if (!classified) return { ok: true, at: t, eventType: null, emotion: null, relationship: null };
    if (cooled) return { ok: true, at: t, eventType: classified.type, skipped: 'cooldown' };

    // openLoop / closeLoop 只写关系：
    // - openLoop 用消息原文当未了结事项的文本（截断 80）；
    // - closeLoop 关闭最早的一条未了结事项（上面已预检过，这里一定命中）。
    if (classified.relationshipOnly) {
      if (!targetUid) return { ok: true, at: t, eventType: null, skipped: 'no-uid' };
      if (classified.type === 'closeLoop') {
        const closed = layer.applyRelationshipEvent(targetUid, {
          type: 'closeLoop',
          loopId: closedLoopTarget.id,
          cause,
          at: t,
          key: contextKey,
        });
        return { ...closed, eventType: 'closeLoop' };
      }
      const opened = layer.applyRelationshipEvent(targetUid, {
        type: 'openLoop',
        text: rawText.slice(0, 80) || classified.label,
        cause,
        at: t,
        key: contextKey,
      });
      return { ...opened, eventType: 'openLoop' };
    }

    const pair = applyPair({
      contextKey,
      uid: targetUid,
      emotionType: classified.type,
      relationshipType: RELATIONSHIP_EVENTS[classified.type] ? classified.type : null,
      cause,
      at: t,
    });
    return { ...pair, eventType: classified.type };
  }

  /** 拍一拍：拍到自己才算情绪事件；拍别人只记一次互动。 */
  function dispatchPoke({ key, uid, targetIsSelf = false, at } = {}) {
    const contextKey = canonicalKey(key);
    if (!contextKey) return { ok: false, reason: 'invalid_key' };
    const target = resolveUid(contextKey, uid);
    if (!target.ok) return { ok: false, reason: target.reason, uid: target.uid };
    const targetUid = target.uid;
    const t = normalizeEventAt(at, now());
    const paused = pausedResult(t);
    if (paused) return paused;
    if (!targetUid) return { ok: true, at: t, skipped: 'no-uid' };
    const anchors = anchorsFor(contextKey, targetUid);
    if (anchors.some((anchor) => t < anchor)) return { ok: false, reason: 'stale_event', at: t };
    layer.applyRelationshipEvent(targetUid, { type: 'interaction', cause: '拍一拍', at: t, key: contextKey });
    if (!targetIsSelf) return { ok: true, at: t, eventType: null };
    // 拍一拍也是情绪事件，同样受同类冷却约束（审查 r6 P1）：冷却期间仍记 interaction，但不叠加 poked。
    if (isCooling(targetUid, 'poked', t)) {
      return { ok: true, at: t, eventType: 'poked', skipped: 'cooldown' };
    }
    const pair = applyPair({
      contextKey,
      uid: targetUid,
      emotionType: 'poked',
      relationshipType: 'poked',
      cause: '被拍了一拍',
      at: t,
    });
    return { ...pair, eventType: 'poked' };
  }

  /** 出站消息：只更新关系互动（私聊才有唯一对象；群聊跳过）。 */
  function dispatchOutgoing({ key, at } = {}) {
    const contextKey = canonicalKey(key);
    if (!contextKey) return { ok: false, reason: 'invalid_key' };
    const targetUid = uidFromKey(contextKey);
    if (!targetUid) return { ok: true, skipped: 'group' };
    const t = normalizeEventAt(at, now());
    const paused = pausedResult(t);
    if (paused) return paused;
    const anchors = anchorsFor(contextKey, targetUid);
    if (anchors.some((anchor) => t < anchor)) return { ok: false, reason: 'stale_event', at: t };
    return layer.applyRelationshipEvent(targetUid, { type: 'interaction', cause: '我发了一条消息', at: t, key: contextKey });
  }

  /** 冷落：私聊里我发言后对方长时间没回；3 小时内只记一次。 */
  function dispatchNeglect({ key, uid, at } = {}) {
    const contextKey = canonicalKey(key);
    if (!contextKey) return { ok: false, reason: 'invalid_key' };
    const target = resolveUid(contextKey, uid);
    if (!target.ok) return { ok: false, reason: target.reason, uid: target.uid };
    const targetUid = target.uid;
    if (!targetUid) return { ok: false, reason: 'invalid_uid' };
    const t = normalizeEventAt(at, now());
    const paused = pausedResult(t);
    if (paused) return paused;
    const moodView = layer.getMood(contextKey);
    const lastIgnored = [...moodView.events].reverse().find((event) => event.type === 'ignored');
    if (lastIgnored && t - lastIgnored.at < NEGLECT_REPEAT_GAP_MS) {
      return { ok: true, at: t, skipped: 'recent_neglect' };
    }
    const pair = applyPair({
      contextKey,
      uid: targetUid,
      emotionType: 'ignored',
      relationshipType: 'ignored',
      cause: '对方很久没回我',
      at: t,
    });
    return { ...pair, eventType: 'ignored' };
  }

  return {
    getMood: layer.getMood,
    getRelationship: layer.getRelationship,
    applyEmotionEvent: layer.applyEmotionEvent,
    applyRelationshipEvent: layer.applyRelationshipEvent,
    dispatchIncoming,
    dispatchPoke,
    dispatchOutgoing,
    dispatchNeglect,
  };
}
