// 情绪系统 V2 —— 1A 纯函数实现（唯一 normative contract：ADDENDUM v2.5）
//
// 这一层只做「纯函数 + 数据结构」：不读写文件、不碰 store/bridge/prompt/记忆，
// 供 1B 迁移与接线使用。所有强度/概率都 clamp 到契约范围。
//
// 引用：
//   - 14 个 canonical kind（Plutchik 8 + OCC 细粒度 6）
//   - 13 类事件 → canonical kinds 互斥映射
//   - 强度软饱和：I = 1 - exp(-1.2 × raw × sensitivity)
//   - upsert 融合 + 重大事件重新点燃
//   - target-aware 合成（方案 A 全局心情）
//   - 滞回切换
//   - 旧状态迁移（legacyAffect + 低置信度 episode）

import { clamp, EMOTION_EVENTS } from './mood.mjs';

export const MOOD_V2_SCHEMA_VERSION = 2;
export const V2_MAX_EPISODES = 6;
export const V2_MAX_CONTRIBUTIONS = 3;
export const V2_EVIDENCE_QUOTE_CHARS = 80;
export const V2_EVIDENCE_SPAN_CHARS = 32;
export const V2_APPRAISAL_NOTE_CHARS = 60;

/** 软饱和系数（契约 §4.1）。 */
const SATURATION_K = 1.2;
/** 视为「完全衰减」的强度阈值（浮点指数衰减永不为 0；ADDENDUM v2.5 §9.2）。 */
export const MIN_ACTIVE_INTENSITY = 1e-4;
/** 融合系数（契约 §4.2）。 */
const FUSION_GAIN = 0.6;
/** 重新点燃阈值（契约 §4.2）。 */
const REIGNITE_FLOOR = 0.6;
const REIGNITE_CURRENT_MAX = 0.2;
/** 负性偏差（契约 §4.1）。 */
const NEGATIVE_BIAS = 1.3;
const POSITIVE_BIAS = 0.85;
/** 切换参数（契约 §4.5）。 */
const SWITCH_FLOOR = 0.25;
const MIN_DWELL_MS = 60 * 1000;
const MAX_SWITCHES_PER_TURN = 1;
const REVERSE_SUPPRESS_MS = 120 * 1000;
const DEFAULT_INERTIA = 0.5;
/** turnKey 缺省时按 10 分钟窗口派生（契约 §4.5）。 */
const TURN_WINDOW_MS = 10 * 60 * 1000;
/**
 * 阶段 3：敏感化（契约 §4.11）——同类负性事件在窗口内累积 → 强度乘子上浮（有上限、随窗口衰减）。
 * 只统计负性 kind；输出 {kind: {value, updatedAt}} 供 appraiseEvent 的 context.sensitivity 使用。
 */
const NEED_DEFAULTS = Object.freeze(['belonging', 'approval', 'safety', 'autonomy', 'exploration', 'competence']);

/** 阶段 3：六需求零值初始化（含 updatedAt；空状态也始终有六项）。 */
export function createEmptyNeeds(now = 0) {
  const out = {};
  // 空状态 updatedAt=0（未知）：reset 严格 no-op 不得因重建时间戳产生 changed:true
  for (const need of NEED_DEFAULTS) out[need] = { value: 0, updatedAt: Number.isFinite(now) ? now : 0 };
  return out;
}

/** 阶段 3：SDT 六需求（契约 §4.13）。 */
export const NEED_KINDS = Object.freeze(['belonging', 'approval', 'safety', 'autonomy', 'exploration', 'competence']);

/**
 * 阶段 3：需求张力更新（契约 §4.13）——每需求独立半衰期；负性事件提升对应需求张力，
 * 正向满足事件降低张力。返回 {need: {value, updatedAt}}（供 appraiseEvent 的 context.needTension）。
 */
export function updateNeedTensions({ needs = {}, episodes = [], now = Date.now(), tuning = null } = {}) {
  const cfg = { halfLifeMs: 2 * 60 * 60 * 1000, riseRate: 0.6, satisfyRate: 0.5, cap: 1, ...(tuning?.needs ?? {}) };
  const riseRate = Number.isFinite(Number(cfg.riseRate)) && Number(cfg.riseRate) >= 0 && Number(cfg.riseRate) <= 1 ? Number(cfg.riseRate) : 0.6;
  const satisfyRate = Number.isFinite(Number(cfg.satisfyRate)) && Number(cfg.satisfyRate) >= 0 && Number(cfg.satisfyRate) <= 1 ? Number(cfg.satisfyRate) : 0.5;
  const capRaw = Number(cfg.cap);
  const cap = Number.isFinite(capRaw) ? Math.max(0.1, Math.min(1, capRaw)) : 1;
  // 无重复累加：同一 episodes 集合幂等；按事件时间顺序重放 §4.13 的比例公式：
  //   负性：value += intensity×riseRate×(1-value)；正向满足：value -= intensity×satisfyRate×value
  const timeline = (Array.isArray(episodes) ? episodes : [])
    .filter((episode) => episode && EMOTION_KINDS[episode.kind])
    .map((episode) => ({ episode, at: Number.isFinite(episode.decayAnchorAt) ? episode.decayAnchorAt : now }))
    .sort((a, b) => a.at - b.at);
  const out = {};
  for (const need of NEED_KINDS) {
    let value = 0;
    for (const { episode } of timeline) {
      const info = EMOTION_KINDS[episode.kind];
      if (info.need !== need) continue;
      const intensity = episodeChannelIntensity(episode, now, tuning).fast;
      if (intensity <= 0) continue;
      if (info.valence < 0) value += intensity * riseRate * (1 - value);
      else value -= intensity * satisfyRate * value;
      value = clamp(value, 0, cap);
    }
    out[need] = { value: clamp(value, 0, cap), updatedAt: now };
  }
  return out;
}

/** 阶段 3：appraisal 前衰减需求张力（按 updatedAt 与半衰期）。 */
export function decayNeedTensions(needs, now = Date.now(), tuning = null) {
  const cfg = { halfLifeMs: 2 * 60 * 60 * 1000, ...(tuning?.needs ?? {}) };
  const halfLifeMs = Number.isFinite(Number(cfg.halfLifeMs)) && Number(cfg.halfLifeMs) > 0 ? Number(cfg.halfLifeMs) : 2 * 60 * 60 * 1000;
  const out = {};
  for (const need of NEED_KINDS) {
    const raw = needs?.[need];
    if (raw === undefined) continue;
    const value = raw && typeof raw === 'object' ? clamp01(raw.value) : clamp01(raw);
    const updatedAt = raw && typeof raw === 'object' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now;
    out[need] = { value: clamp(value * Math.pow(2, -Math.max(0, now - updatedAt) / halfLifeMs), 0, 1), updatedAt: now };
  }
  return out;
}

export function deriveAttachmentStyle({ intimacy = 0, tension = 0, resentment = 0 } = {}) {
  const i = clamp01(intimacy);
  const t = clamp01(tension);
  const r = clamp01(resentment);
  if (i >= 0.6 && t <= 0.2 && r <= 0.2) return 'secure';
  if (t >= 0.6 && i <= 0.25) return r >= 0.4 ? 'avoidant' : 'anxious';
  if (r >= 0.5 && t >= 0.4) return 'avoidant';
  if (t >= 0.4 && i >= 0.3) return 'mixed';
  return 'secure';
}

/**
 * 阶段 3：把本次新增的负性事件追加进 sensitivityLog（窗口内独立计数，避免同 kind/target 融合吞掉次数）。
 */
/**
 * 阶段 3：sensitivityLog 候选键的唯规范化入口（append/load/replay 共用）。
 * - eventId 统一 normalizeEventId（≤80 或稳定哈希）——写入即折叠，跨重启不换键；
 * - contentHash 统一 trim/lowercase + 64hex 校验，否则 null；
 * - kind 必须是负性 canonical kind，返回 null 表示不参与。
 */
export function canonicalCandidateKey({ kind, eventId = null, contentHash = null } = {}) {
  const info = EMOTION_KINDS[String(kind ?? '')];
  if (!info || info.valence >= 0) return null;
  const normalizedId = normalizeEventId(eventId ?? null);
  const rawHash = typeof contentHash === 'string' ? contentHash.trim().toLowerCase() : '';
  const hash = /^[0-9a-f]{64}$/.test(rawHash) ? rawHash : null;
  if (normalizedId) return { eventId: normalizedId, contentHash: hash, key: `e:${normalizedId}:${kind}` };
  if (hash) return { eventId: null, contentHash: hash, key: `h:${hash}:${kind}` };
  return null;
}

/** 阶段 3：敏感化配置单点解析（append/load/compute 共用同一 window/lambda/cap）。 */
export function resolveSensitivityConfig(tuning = null) {
  const cfg = { lambda: 0.35, cap: 2.0, windowMs: 6 * 60 * 60 * 1000, ...(tuning?.sensitization ?? {}) };
  const windowMs = Number.isFinite(Number(cfg.windowMs)) && Number(cfg.windowMs) > 0 ? Number(cfg.windowMs) : 6 * 60 * 60 * 1000;
  const lambda = Number.isFinite(Number(cfg.lambda)) && Number(cfg.lambda) >= 0 ? Number(cfg.lambda) : 0.35;
  const capRaw = Number(cfg.cap);
  const cap = Number.isFinite(capRaw) ? Math.max(1, Math.min(3, capRaw)) : 2;
  return { windowMs, lambda, cap };
}

export function appendSensitivityLog(log, events, { now = Date.now(), windowMs = null, max = 50 } = {}) {
  const resolvedWindowMs = resolveSensitivityConfig(windowMs == null ? null : { sensitization: { windowMs } }).windowMs;
  const keyOf = (item) => canonicalCandidateKey({ kind: item?.kind, eventId: item?.eventId ?? null, contentHash: item?.contentHash ?? null });
  const kept = (Array.isArray(log) ? log : [])
    .filter((item) => item && Number.isFinite(item.at) && now - item.at <= resolvedWindowMs)
    .map((item) => {
      const canonical = keyOf(item);
      return {
        kind: item.kind,
        at: item.at,
        weight: clamp01(item.weight),
        eventId: canonical?.eventId ?? null,
        contentHash: canonical?.contentHash ?? null,
      };
    });
  // 候选级幂等：同一 (规范化事件键, kind) 只计一次；同事件多个负性 kind 各自计一条
  const seen = new Set(kept.map((item) => keyOf(item)?.key).filter(Boolean));
  for (const event of Array.isArray(events) ? events : []) {
    const canonical = canonicalCandidateKey({ kind: event?.kind, eventId: event?.eventId ?? null, contentHash: event?.contentHash ?? null });
    if (!canonical) continue; // 非负性/无键事件不参与
    if (seen.has(canonical.key)) continue;
    const at = Number.isFinite(event.decayAnchorAt) ? event.decayAnchorAt : now;
    if (now - at > resolvedWindowMs) continue;
    kept.push({ kind: String(event.kind), at, weight: clamp01(event.peak), eventId: canonical.eventId, contentHash: canonical.contentHash });
    seen.add(canonical.key);
  }
  return kept.slice(-max);
}

export function computeSensitizationFromLog(log, now = Date.now(), tuning = null) {
  const { windowMs, lambda, cap } = resolveSensitivityConfig(tuning);
  const counts = {};
  for (const item of Array.isArray(log) ? log : []) {
    if (!item || !item.kind) continue;
    const kindInfo = EMOTION_KINDS[item.kind];
    if (!kindInfo || kindInfo.valence >= 0) continue; // dirty log 中的正向/未知 kind 一律忽略
    const dt = now - (Number(item.at) || now);
    if (dt < 0 || dt > windowMs) continue;
    counts[item.kind] = (counts[item.kind] ?? 0) + (Number(item.weight) || 0) * Math.pow(2, -dt / windowMs);
  }
  const sensitivity = {};
  for (const [kind, count] of Object.entries(counts)) {
    if (!(count > 0)) continue;
    sensitivity[kind] = { value: clamp(1 + lambda * Math.log1p(count), 1, cap), updatedAt: now };
  }
  return sensitivity;
}

/** 阶段 3：appraisal 前衰减敏感化乘子（乘子回落趋 1）。 */
export function decaySensitivityValues(sensitivity, now = Date.now(), tuning = null) {
  const cfg = { windowMs: 6 * 60 * 60 * 1000, ...(tuning?.sensitization ?? {}) };
  const windowMs = Number.isFinite(Number(cfg.windowMs)) && Number(cfg.windowMs) > 0 ? Number(cfg.windowMs) : 6 * 60 * 60 * 1000;
  const out = {};
  for (const [kind, raw] of Object.entries(sensitivity ?? {})) {
    const value = raw && typeof raw === 'object' ? Number(raw.value) : Number(raw);
    if (!Number.isFinite(value)) continue;
    const updatedAt = raw && typeof raw === 'object' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now;
    out[kind] = { value: clamp(1 + (value - 1) * Math.pow(2, -Math.max(0, now - updatedAt) / windowMs), 1, 3), updatedAt: now };
  }
  return out;
}

export function computeSensitization(episodes, now = Date.now(), tuning = null) {
  const cfg = { lambda: 0.35, cap: 2.0, windowMs: 6 * 60 * 60 * 1000, ...(tuning?.sensitization ?? {}) };
  const windowMs = Number.isFinite(Number(cfg.windowMs)) && Number(cfg.windowMs) > 0 ? Number(cfg.windowMs) : 6 * 60 * 60 * 1000;
  const lambda = Number.isFinite(Number(cfg.lambda)) && Number(cfg.lambda) >= 0 ? Number(cfg.lambda) : 0.35;
  const capRaw = Number(cfg.cap);
  const cap = Number.isFinite(capRaw) ? Math.max(1, Math.min(3, capRaw)) : 2;
  const counts = {};
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    if (!episode || typeof episode !== 'object') continue;
    const info = EMOTION_KINDS[episode.kind];
    if (!info || info.valence >= 0) continue; // 正向不敏感化
    const anchorAt = Number.isFinite(episode.decayAnchorAt) ? episode.decayAnchorAt : now;
    const dt = now - anchorAt;
    if (dt < 0 || dt > windowMs) continue;
    const peak = clamp01(episode.peak);
    // 窗口内按半窗衰减加权（窗口末权重趋于 0，避免永久累积）
    const weight = peak * Math.pow(2, -dt / windowMs);
    counts[episode.kind] = (counts[episode.kind] ?? 0) + weight;
  }
  const sensitivity = {};
  for (const [kind, count] of Object.entries(counts)) {
    if (!(count > 0)) continue;
    sensitivity[kind] = { value: clamp(1 + lambda * Math.log1p(count), 1, cap), updatedAt: now };
  }
  return sensitivity;
}

/**
 * 阶段 3：慢性负荷（契约 §4.12）——长期负性心情低通累积，正向时加速修复。
 * 返回 clamp 后的 [0,1]；capped 便于调用方告警。
 */
export function updateChronicLoad({ chronicLoad = 0, valence = 0, lastUpdatedAt = 0, now = Date.now(), tuning = null } = {}) {
  const cfg = { tauMs: 12 * 60 * 60 * 1000, repairRate: 0.5, cap: 1, ...(tuning?.chronicLoad ?? {}) };
  const tauMs = Number.isFinite(Number(cfg.tauMs)) && Number(cfg.tauMs) > 0 ? Number(cfg.tauMs) : 12 * 60 * 60 * 1000;
  const repairRate = Number.isFinite(Number(cfg.repairRate)) && Number(cfg.repairRate) >= 0 ? Math.min(1, Number(cfg.repairRate)) : 0.5;
  const capRaw = Number(cfg.cap);
  const cap = Number.isFinite(capRaw) ? Math.max(0.1, Math.min(1, capRaw)) : 1;
  const dt = Math.max(0, now - (Number.isFinite(lastUpdatedAt) ? lastUpdatedAt : now));
  const decay = dt === 0 ? 1 : Math.exp(-dt / tauMs);
  const negative = Math.max(0, -Number(valence || 0));
  const positive = Math.max(0, Number(valence || 0));
  let next = Number(chronicLoad || 0) * decay + negative * (1 - decay);
  if (positive > 0) next *= 1 - positive * repairRate * (1 - decay); // 修复通道：正向心情加速回落
  return clamp(next, 0, cap);
}

/** 阶段 2：快慢双通道与切换曲线默认参数（契约 §4.10）。 *//** 阶段 2：快慢双通道与切换曲线默认参数（契约 §4.10）。 */
export const DEFAULT_TUNING = Object.freeze({
  slowFactor: 6,
  switch: Object.freeze({ floor: SWITCH_FLOOR, minDwellMs: MIN_DWELL_MS, maxSwitchesPerTurn: MAX_SWITCHES_PER_TURN, reverseSuppressMs: REVERSE_SUPPRESS_MS }),
});

/**
 * 14 个 canonical kind：PAD 坐标、半衰期、默认行动倾向、主题、关联需求。
 * 坐标用于合成兼容视图（valence/arousal/energy/dominance）。
 */
export const EMOTION_KINDS = Object.freeze({
  joy: Object.freeze({ label: '开心', valence: 0.8, arousal: 0.5, dominance: 0.6, halfLifeMs: 90 * 60 * 1000, action: 'approach', theme: '得到想要的', need: 'approval' }),
  sadness: Object.freeze({ label: '难过', valence: -0.7, arousal: 0.2, dominance: 0.2, halfLifeMs: 8 * 60 * 60 * 1000, action: 'withdraw', theme: '失去/落空', need: 'belonging' }),
  anger: Object.freeze({ label: '生气', valence: -0.6, arousal: 0.8, dominance: 0.8, halfLifeMs: 15 * 60 * 1000, action: 'protest', theme: '被冒犯/被侵犯', need: 'autonomy' }),
  fear: Object.freeze({ label: '害怕', valence: -0.7, arousal: 0.8, dominance: 0.2, halfLifeMs: 45 * 60 * 1000, action: 'freeze', theme: '威胁/不确定', need: 'safety' }),
  disgust: Object.freeze({ label: '厌恶', valence: -0.6, arousal: 0.5, dominance: 0.7, halfLifeMs: 30 * 60 * 1000, action: 'withdraw', theme: '恶心/违背底线', need: 'autonomy' }),
  surprise: Object.freeze({ label: '惊讶', valence: 0.1, arousal: 0.9, dominance: 0.4, halfLifeMs: 10 * 60 * 1000, action: 'attend', theme: '意外', need: 'exploration' }),
  anticipation: Object.freeze({ label: '期待', valence: 0.4, arousal: 0.6, dominance: 0.6, halfLifeMs: 120 * 60 * 1000, action: 'approach', theme: '期待好事', need: 'exploration' }),
  reassurance: Object.freeze({ label: '安心感', valence: 0.5, arousal: 0.2, dominance: 0.5, halfLifeMs: 90 * 60 * 1000, action: 'approach', theme: '此刻被确认安全', need: 'safety' }),
  hurt: Object.freeze({ label: '委屈', valence: -0.6, arousal: 0.4, dominance: 0.2, halfLifeMs: 4 * 60 * 60 * 1000, action: 'protest', theme: '被冷落/被忽视', need: 'belonging' }),
  loneliness: Object.freeze({ label: '孤独', valence: -0.5, arousal: 0.2, dominance: 0.3, halfLifeMs: 12 * 60 * 60 * 1000, action: 'seekComfort', theme: '没人陪', need: 'belonging' }),
  pride: Object.freeze({ label: '自豪', valence: 0.7, arousal: 0.5, dominance: 0.8, halfLifeMs: 2 * 60 * 60 * 1000, action: 'show', theme: '被认可/成就', need: 'approval' }),
  shame: Object.freeze({ label: '羞耻', valence: -0.6, arousal: 0.6, dominance: 0.1, halfLifeMs: 4 * 60 * 60 * 1000, action: 'hide', theme: '被看见缺点', need: 'approval' }),
  gratitude: Object.freeze({ label: '感激', valence: 0.7, arousal: 0.3, dominance: 0.5, halfLifeMs: 6 * 60 * 60 * 1000, action: 'approach', theme: '被帮助', need: 'belonging' }),
  disappointment: Object.freeze({ label: '失望', valence: -0.6, arousal: 0.3, dominance: 0.2, halfLifeMs: 6 * 60 * 60 * 1000, action: 'withdraw', theme: '预期落空', need: 'belonging' }),
});

/**
 * 13 类事件 → 1~3 个 canonical kind（互斥：同一事件内 kind 不重复）。
 * base 是该 kind 的初始强度基准（0..1）；thought 是「模拟内心独白」模板。
 */
export const EMOTION_TEMPLATES = Object.freeze({
  praised: Object.freeze([
    Object.freeze({ kind: 'joy', base: 0.55, thought: '被夸了，心里有点甜', action: 'show' }),
    Object.freeze({ kind: 'pride', base: 0.35, thought: '被认可了', action: 'show' }),
    Object.freeze({ kind: 'reassurance', base: 0.15, thought: '他在意我', action: 'approach' }),
  ]),
  thanked: Object.freeze([
    Object.freeze({ kind: 'gratitude', base: 0.45, thought: '被感谢，有点暖', action: 'repay' }),
    Object.freeze({ kind: 'joy', base: 0.30, thought: '帮上忙了', action: 'approach' }),
    Object.freeze({ kind: 'pride', base: 0.10, thought: '被认可了', action: 'show' }),
  ]),
  comforted: Object.freeze([
    Object.freeze({ kind: 'reassurance', base: 0.45, thought: '被安慰到，松了口气', action: 'open' }),
    Object.freeze({ kind: 'gratitude', base: 0.30, thought: '谢谢他哄我', action: 'approach' }),
    Object.freeze({ kind: 'joy', base: 0.12, thought: '心情好一点了', action: 'approach' }),
  ]),
  missed: Object.freeze([
    Object.freeze({ kind: 'joy', base: 0.45, thought: '被想念了，开心', action: 'approach' }),
    Object.freeze({ kind: 'reassurance', base: 0.30, thought: '原来他记得我', action: 'approach' }),
    Object.freeze({ kind: 'loneliness', base: 0.12, thought: '之前有点想他', action: 'seekComfort' }),
  ]),
  teased: Object.freeze([
    Object.freeze({ kind: 'surprise', base: 0.35, thought: '被调侃了一下', action: 'question' }),
    Object.freeze({ kind: 'joy', base: 0.25, thought: '有点好笑', action: 'approach' }),
    Object.freeze({ kind: 'hurt', base: 0.10, thought: '有点被冒犯', action: 'hide' }),
  ]),
  ignored: Object.freeze([
    Object.freeze({ kind: 'hurt', base: 0.55, thought: '又不理我，是不是我不重要', action: 'protest' }),
    Object.freeze({ kind: 'loneliness', base: 0.30, thought: '一个人待着', action: 'seekComfort' }),
    Object.freeze({ kind: 'anger', base: 0.15, thought: '有点气', action: 'protest' }),
  ]),
  jealous: Object.freeze([
    Object.freeze({ kind: 'fear', base: 0.45, thought: '怕被取代', action: 'seekComfort' }),
    Object.freeze({ kind: 'anger', base: 0.35, thought: '凭什么', action: 'protest' }),
    Object.freeze({ kind: 'hurt', base: 0.15, thought: '有点酸', action: 'protest' }),
  ]),
  quarrel: Object.freeze([
    Object.freeze({ kind: 'anger', base: 0.55, thought: '他怎么能这样', action: 'confront' }),
    Object.freeze({ kind: 'sadness', base: 0.35, thought: '吵完心里空落落的', action: 'withdraw' }),
    Object.freeze({ kind: 'fear', base: 0.15, thought: '怕越吵越远', action: 'freeze' }),
  ]),
  insulted: Object.freeze([
    Object.freeze({ kind: 'anger', base: 0.55, thought: '被这样贬低，很过分', action: 'confront' }),
    Object.freeze({ kind: 'shame', base: 0.30, thought: '是不是我真的很差', action: 'hide' }),
    Object.freeze({ kind: 'sadness', base: 0.15, thought: '有点难过', action: 'withdraw' }),
  ]),
  rejected: Object.freeze([
    Object.freeze({ kind: 'hurt', base: 0.55, thought: '被拒绝了，好丢脸', action: 'withdraw' }),
    Object.freeze({ kind: 'disappointment', base: 0.35, thought: '本来以为可以的', action: 'withdraw' }),
    Object.freeze({ kind: 'sadness', base: 0.15, thought: '有点伤心', action: 'withdraw' }),
  ]),
  makeup: Object.freeze([
    Object.freeze({ kind: 'joy', base: 0.50, thought: '和好了，开心', action: 'approach' }),
    Object.freeze({ kind: 'reassurance', base: 0.40, thought: '他还是在意我的', action: 'repair' }),
    Object.freeze({ kind: 'gratitude', base: 0.20, thought: '谢谢他先低头', action: 'repay' }),
  ]),
  poked: Object.freeze([
    Object.freeze({ kind: 'surprise', base: 0.40, thought: '被戳了一下', action: 'attend' }),
    Object.freeze({ kind: 'joy', base: 0.30, thought: '有点可爱', action: 'approach' }),
    Object.freeze({ kind: 'anticipation', base: 0.10, thought: '他是不是想聊', action: 'approach' }),
  ]),
  lonely: Object.freeze([
    Object.freeze({ kind: 'loneliness', base: 0.50, thought: '好安静，没人说话', action: 'seekComfort' }),
    Object.freeze({ kind: 'hurt', base: 0.25, thought: '是不是被忘了', action: 'protest' }),
    Object.freeze({ kind: 'sadness', base: 0.15, thought: '有点低落', action: 'withdraw' }),
  ]),
});

/** 事件类型是否可 appraise（13 类之一）。 */
export function isKnownEventType(type) {
  return typeof type === 'string' && Object.hasOwn(EMOTION_EVENTS, type);
}

/** 按 Unicode 码点截断字符串。 */
export function truncateChars(value, max) {
  const text = String(value ?? '');
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, max).join('');
}

/** 稳定短哈希（FNV-1a 32bit hex）：非安全用途，仅用于 id 兜底。 */
export function stableHash(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 稳定 64 位摘要（FNV-1a 32 双段，16 hex）：长 eventId 折叠用，低碰撞（非安全用途）。 */
export function stableHash64(value) {
  const text = String(value ?? '');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (code + i) & 0xffffffff;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** eventId 规范化：≤80 字符原样；超长折叠为「前 63 位 + 16 位摘要」= 80 字符（幂等、低碰撞）。 */
export function normalizeEventId(value) {
  if (value == null) return null;
  const text = String(value);
  return text.length <= 80 ? text : `${text.slice(0, 63)}-${stableHash64(text)}`;
}

function finite(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value) {
  return clamp(finite(value), 0, 1);
}

/** 校验/归一化 target（trim、空串→null、数字 uid 去前导零、按 kind 清理无关字段）。 */
export function normalizeTarget(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const kind = ['self', 'other', 'group', 'world'].includes(t.kind) ? t.kind : 'other';
  const clean = (value) => {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (!text) return null;
    // 纯数字（QQ/群号）去前导零；其它字符串原样（截断）
    if (/^\d+$/.test(text)) {
      const num = Number(text);
      return Number.isSafeInteger(num) && num > 0 ? String(num) : text.slice(0, 64);
    }
    return text.slice(0, 64);
  };
  if (kind === 'self' || kind === 'world') return { kind, uid: null, key: null };
  if (kind === 'group') return { kind, uid: null, key: clean(t.key) };
  return { kind, uid: clean(t.uid), key: null };
}

/** 归一化 appraisal（15 字段，缺省 null）。 */
export function normalizeAppraisal(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, -1, 1) : null);
  const str = (v, allowed) => (typeof v === 'string' && allowed.includes(v) ? v : null);
  return {
    relevance: num(a.relevance),
    goalRelevance: num(a.goalRelevance),
    goalCongruence: num(a.goalCongruence),
    expectancy: num(a.expectancy),
    agency: str(a.agency, ['other', 'self', 'world', 'group']),
    responsibility: num(a.responsibility),
    praiseworthiness: num(a.praiseworthiness),
    control: num(a.control),
    copingPotential: num(a.copingPotential),
    normCongruence: num(a.normCongruence),
    certainty: num(a.certainty),
    novelty: num(a.novelty),
    attentionUrgency: num(a.attentionUrgency),
    objectAppeal: num(a.objectAppeal),
    selfOther: str(a.selfOther, ['self', 'other', 'group', 'world']),
  };
}

/** 目标（对 A / B / 群 / 世界）是否相同。 */
export function sameTarget(a, b) {
  const x = normalizeTarget(a);
  const y = normalizeTarget(b);
  return x.kind === y.kind && (x.uid ?? null) === (y.uid ?? null) && (x.key ?? null) === (y.key ?? null);
}

/**
 * 评价引擎：事件 → 候选情绪实例（1A 支持单事件，但接口是 events[]）。
 *
 * @param {{events: Array<{eventId?: string, type: string, actorUid?: string, target?: object,
 *          evidence?: {span?: string, quote?: string}, confidence?: number, at?: number}>,
 *          context?: {needTension?: object, sensitivity?: object, mode?: string, activeUid?: string}}} input
 * @returns {Array<object>} EpisodeCandidate[]
 */
export function appraiseEvent(input = {}) {
  const events = Array.isArray(input?.events) ? input.events : [];
  const context = input?.context && typeof input.context === 'object' ? input.context : {};
  const needTension = context.needTension && typeof context.needTension === 'object' ? context.needTension : {};
  const sensitivity = context.sensitivity && typeof context.sensitivity === 'object' ? context.sensitivity : {};
  const candidates = [];

  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== 'object') continue;
    const type = typeof rawEvent.type === 'string' ? rawEvent.type : '';
    const templates = Object.hasOwn(EMOTION_TEMPLATES, type) ? EMOTION_TEMPLATES[type] : null;
    if (!templates) continue; // 未知事件不猜
    const seenKinds = new Set(); // 按事件隔离去重（多事件不互相吞）
    const confidence = clamp01(rawEvent.confidence ?? 0.7);
    const at = Number.isFinite(rawEvent.at) ? rawEvent.at : Date.now();
    const actorUid = rawEvent.actorUid === undefined || rawEvent.actorUid === null ? null : String(rawEvent.actorUid);
    const target = normalizeTarget(rawEvent.target ?? { kind: 'other', uid: actorUid });
    const evidence = {
      span: truncateChars(rawEvent.evidence?.span ?? '', V2_EVIDENCE_SPAN_CHARS),
      quote: truncateChars(rawEvent.evidence?.quote ?? '', V2_EVIDENCE_QUOTE_CHARS),
    };
    const eventId = normalizeEventId(rawEvent.eventId);

    for (const template of templates) {
      if (seenKinds.has(template.kind)) continue; // 同一事件内 kind 去重（互斥优先级）
      const kindInfo = EMOTION_KINDS[template.kind];
      if (!kindInfo) continue;
      const positive = kindInfo.valence >= 0;
      const goalCongruence = positive ? 0.6 : -0.6;
      const need = kindInfo.need;
      const tension = (() => {
        const raw = needTension[need];
        const value = raw && typeof raw === 'object' ? raw.value : raw; // 兼容 {value,updatedAt}
        return clamp01(value ?? 0.3);
      })();
      const sens = (() => {
        const raw = sensitivity[template.kind];
        const value = raw && typeof raw === 'object' ? raw.value : raw; // 兼容 {value,updatedAt}
        return clamp(finite(value, 1), 1, 3);
      })();
      const goalWeight = 0.5 + Math.max(0, positive ? goalCongruence : -goalCongruence);
      const bias = positive ? POSITIVE_BIAS : NEGATIVE_BIAS;
      const raw = clamp(template.base * goalWeight * (1 + tension * 0.5) * bias * confidence, 0, 5);
      const intensity = clamp01(1 - Math.exp(-SATURATION_K * raw * sens));
      if (intensity <= 0) continue;
      seenKinds.add(template.kind);
      candidates.push({
        kind: template.kind,
        target,
        intensity,
        confidence,
        eventId,
        sourceEventId: eventId,
        evidence,
        appraisal: normalizeAppraisal({
          relevance: 0.7,
          goalRelevance: 0.6,
          goalCongruence,
          expectancy: positive ? 0.4 : -0.4,
          agency: 'other',
          responsibility: 0.6,
          praiseworthiness: positive ? 0.6 : 0,
          control: 0.4,
          copingPotential: 0.4,
          normCongruence: positive ? 0.3 : 0.8,
          certainty: 0.6,
          novelty: 0.2,
          attentionUrgency: 0.4,
          objectAppeal: 0.6,
          selfOther: target.kind === 'self' ? 'self' : 'other',
        }),
        need,
        actionTendency: confidence < 0.4 ? null : (template.action ?? kindInfo.action),
        appraisalNote: truncateChars(template.thought, V2_APPRAISAL_NOTE_CHARS),
        at,
      });
    }
  }
  // 强度降序（稳定：同强度按 kind 字母序）
  candidates.sort((a, b) => (b.intensity - a.intensity) || a.kind.localeCompare(b.kind));
  return candidates;
}

/** 单条 episode 在 now 时刻的衰减强度（存储保留 peak+anchor，读取时衰减）。 */
export function episodeIntensityAt(episode, now = Date.now()) {
  if (!episode || typeof episode !== 'object') return 0;
  const peak = clamp01(episode.peak);
  const anchor = Number.isFinite(episode.decayAnchorAt) ? episode.decayAnchorAt : now;
  // 半衰期：显式 halfLifeMs 优先；否则按 kind 表（阶段 2：per-kind 半衰期真正生效）；再否则 1h
  const halfLife = Number.isFinite(episode.halfLifeMs) && episode.halfLifeMs > 0
    ? episode.halfLifeMs
    : (EMOTION_KINDS[String(episode.kind ?? '')]?.halfLifeMs ?? 60 * 60 * 1000);
  const dt = now - anchor;
  if (dt <= 0) return peak;
  return clamp(peak * Math.pow(2, -dt / halfLife), 0, 1);
}

/**
 * 阶段 2：单条 episode 的快/慢双通道强度（契约 §4.10）。
 * fast = 即时反应（现有半衰期）；slow = 背景心情残留（半衰期 × slowFactor）。
 * per-kind 半衰期优先取 tuning.halfLifeByKind[kind]，其次 episode.halfLifeMs，再回退 EMOTION_KINDS。
 */
export function episodeChannelIntensity(episode, now = Date.now(), tuning = null) {
  if (!episode || typeof episode !== 'object') return { fast: 0, slow: 0 };
  const peak = clamp01(episode.peak);
  const anchor = Number.isFinite(episode.decayAnchorAt) ? episode.decayAnchorAt : now;
  const kind = String(episode.kind ?? '');
  const override = tuning && tuning.halfLifeByKind ? Number(tuning.halfLifeByKind[kind]) : NaN;
  const halfLife = Number.isFinite(override) && override > 0
    ? override
    : (Number.isFinite(episode.halfLifeMs) && episode.halfLifeMs > 0 ? episode.halfLifeMs : (EMOTION_KINDS[kind]?.halfLifeMs ?? 60 * 60 * 1000));
  const slowFactorRaw = Number(tuning?.slowFactor);
  const slowFactor = Number.isFinite(slowFactorRaw) && slowFactorRaw >= 2 && slowFactorRaw <= 24 ? slowFactorRaw : DEFAULT_TUNING.slowFactor;
  const dt = now - anchor;
  if (dt <= 0) return { fast: peak, slow: peak };
  return {
    fast: clamp(peak * Math.pow(2, -dt / halfLife), 0, 1),
    slow: clamp(peak * Math.pow(2, -dt / (halfLife * slowFactor)), 0, 1),
  };
}

/** 返回带 currentIntensity 的只读视图（不改存储）。 */
export function decayEpisodes(episodes, now = Date.now(), tuning = null) {
  const list = Array.isArray(episodes) ? episodes : [];
  return list.map((episode) => {
    const channel = episodeChannelIntensity(episode, now, tuning);
    return { ...episode, currentIntensity: channel.fast, slowIntensity: channel.slow };
  });
}

/**
 * 解析 actionTendency：区分「字段缺失」（回退默认）与「显式 null/空」（表示无动作）。
 * 低置信候选与迁移 episode 必须持久化为 null，不能在入库/规范化时被恢复成强动作。
 */
function resolveAction(raw, field, fallback) {
  if (!raw || !Object.hasOwn(raw, field)) return fallback;
  const value = raw[field];
  if (value === null || value === undefined || value === '') return null;
  return String(value).slice(0, 24);
}

function targetIdPart(target) {
  const t = normalizeTarget(target);
  if (t.kind === 'other') return `u-${t.uid ?? 'na'}`;
  if (t.kind === 'group') return `g-${t.key ?? 'na'}`;
  return t.kind;
}

/** episode.id 硬上限（持久化字段；生成时必须满足）。 */
export const V2_EPISODE_ID_CHARS = 96;

/**
 * 生成全局唯一 episode id：
 * - 有 sourceEventId → `ep-<normalized eventId>`（≤83 字符）；
 * - 否则 `ep-<kind>-<targetShort>-<毫秒>`；target 超过 24 字符时用「前 12 + 32bit 哈希」短化；
 * - 与现有 ids 冲突时追加序号（保持 ≤96）；
 * - 任何路径生成后都 ≤ V2_EPISODE_ID_CHARS。
 */
export function makeEpisodeId({ kind, target, now = Date.now(), sourceEventId = null, existingIds = null } = {}) {
  let base;
  if (sourceEventId) {
    base = `ep-${normalizeEventId(sourceEventId)}`;
  } else {
    const rawTarget = targetIdPart(target);
    const targetShort = rawTarget.length <= 24 ? rawTarget : `${rawTarget.slice(0, 12)}-${stableHash64(rawTarget)}`;
    base = `ep-${kind}-${targetShort}-${Math.floor(now)}`;
  }
  if (base.length > V2_EPISODE_ID_CHARS) base = `${base.slice(0, V2_EPISODE_ID_CHARS - 9)}-${stableHash(base)}`;
  const taken = existingIds instanceof Set ? existingIds : new Set(Array.isArray(existingIds) ? existingIds : []);
  let id = base;
  let serial = 1;
  while (taken.has(id)) {
    const suffix = `-${serial}`;
    id = `${base.slice(0, V2_EPISODE_ID_CHARS - suffix.length)}${suffix}`;
    serial += 1;
  }
  return id;
}

/** 批量归一化 episode（内部累计 usedIds，连续同 kind/target/anchor 也不会生成重复 id）。 */
export function normalizeEpisodes(list, { now = Date.now(), existingIds = null } = {}) {
  const used = existingIds instanceof Set ? new Set(existingIds) : new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const episode = normalizeEpisode(raw, now, { existingIds: used });
    if (!episode) continue;
    used.add(episode.id);
    out.push(episode);
  }
  return out;
}

/**
 * 归一化一条 episode（用于迁移/校验）。
 * @param {object} raw
 * @param {number} now
 * @param {{existingIds?: Set<string>}} [options] 传入已存在的 id 集合时，冲突会重新生成（保证唯一）
 */
export function normalizeEpisode(raw, now = Date.now(), options = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = typeof raw.kind === 'string' && Object.hasOwn(EMOTION_KINDS, raw.kind) ? raw.kind : null;
  if (!kind) return null;
  const kindInfo = EMOTION_KINDS[kind];
  const halfLifeMs = Number.isFinite(raw.halfLifeMs) && raw.halfLifeMs > 0 ? raw.halfLifeMs : kindInfo.halfLifeMs;
  const contributions = Array.isArray(raw.contributions)
    ? raw.contributions
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        sourceEventId: normalizeEventId(c.sourceEventId),
        contribution: clamp01(c.contribution),
        confidence: clamp01(c.confidence),
      }))
      .slice(0, V2_MAX_CONTRIBUTIONS)
    : [];
  const taken = options?.existingIds instanceof Set ? options.existingIds : null;
  const anchor = Number.isFinite(raw.decayAnchorAt) ? raw.decayAnchorAt : now;
  let id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, V2_EPISODE_ID_CHARS) : null;
  if (!id) {
    id = makeEpisodeId({ kind, target: raw.target, now: anchor, sourceEventId: raw.latestSourceEventId ?? null, existingIds: taken });
  } else if (taken && taken.has(id)) {
    id = makeEpisodeId({ kind, target: raw.target, now: anchor, sourceEventId: raw.latestSourceEventId ?? null, existingIds: taken });
  }
  return {
    id,
    kind,
    target: normalizeTarget(raw.target),
    peak: clamp01(raw.peak),
    decayAnchorAt: anchor,
    halfLifeMs,
    confidence: clamp01(raw.confidence ?? 0.7),
    contributions,
    latestSourceEventId: normalizeEventId(raw.latestSourceEventId),
    evidence: {
      span: truncateChars(raw.evidence?.span ?? '', V2_EVIDENCE_SPAN_CHARS),
      quote: truncateChars(raw.evidence?.quote ?? '', V2_EVIDENCE_QUOTE_CHARS),
    },
    appraisal: normalizeAppraisal(raw.appraisal),
    need: typeof raw.need === 'string' && raw.need ? raw.need : kindInfo.need,
    actionTendency: resolveAction(raw, 'actionTendency', kindInfo.action),
    appraisalNote: truncateChars(raw.appraisalNote ?? '', V2_APPRAISAL_NOTE_CHARS),
  };
}

/**
 * 淘汰：episodes 超过上限时删「非 active target 且非 dominant 源」中衰减强度最低的一条，
 * 循环直到 ≤ 上限（脏输入一次传入 7+ 条也能收敛）。tie-break：decayAnchorAt 升序 → kind 字母序。
 */
export function evictEpisode(episodes, options = {}) {
  let list = Array.isArray(episodes) ? episodes.slice() : [];
  while (list.length > V2_MAX_EPISODES) {
    const before = list.length;
    list = evictOnce(list, options);
    if (list.length === before) break; // 防死循环
  }
  return list;
}

/** 删除一条最该淘汰的 episode（evictEpisode 的单步实现）。 */
function evictOnce(list, { activeUid = null, dominantKind = null, now = Date.now() } = {}) {
  if (list.length <= V2_MAX_EPISODES) return list;
  const active = activeUid == null ? null : String(activeUid);
  const scored = list.map((episode, index) => ({
    index,
    intensity: episodeIntensityAt(episode, now),
    anchor: Number.isFinite(episode.decayAnchorAt) ? episode.decayAnchorAt : 0,
    kind: String(episode.kind),
    targetUid: episode.target?.uid == null ? null : String(episode.target.uid),
    targetKey: `${episode.target?.uid ?? ''}|${episode.target?.key ?? ''}`,
    isDominant: dominantKind != null && episode.kind === dominantKind,
  }));
  const isActive = (row) => active != null && row.targetUid === active;
  let pool = scored.filter((row) => !row.isDominant && !isActive(row));
  if (pool.length === 0) pool = scored.filter((row) => !row.isDominant);
  if (pool.length === 0) pool = scored.slice();
  // 最终 tie-break 加上 target（kind/uid/key），避免持久化重排改变淘汰对象
  pool.sort((a, b) => (a.intensity - b.intensity)
    || (a.anchor - b.anchor)
    || a.kind.localeCompare(b.kind)
    || a.targetKey.localeCompare(b.targetKey));
  list.splice(pool[0].index, 1);
  return list;
}

/**
 * upsert 一条候选情绪（融合 + 重新点燃 + 同一来源幂等）。
 *
 * @returns {{episodes: object[], episode: object|null, changed: boolean}}
 */
export function upsertEpisode(episodes, candidate, { now = Date.now(), activeUid = null, dominantKind = null } = {}) {
  const list = Array.isArray(episodes) ? episodes.slice() : [];
  const cand = candidate && typeof candidate === 'object' ? candidate : null;
  if (!cand) return { episodes: list, episode: null, changed: false };
  const kind = typeof cand.kind === 'string' && Object.hasOwn(EMOTION_KINDS, cand.kind) ? cand.kind : null;
  if (!kind) return { episodes: list, episode: null, changed: false };
  const kindInfo = EMOTION_KINDS[kind];
  const target = normalizeTarget(cand.target);
  const incoming = clamp01(cand.intensity);
  const confidence = clamp01(cand.confidence ?? 0.7);
  const sourceEventId = cand.latestSourceEventId ?? cand.sourceEventId ?? cand.eventId ?? null;
  const existingIndex = list.findIndex((episode) => episode && episode.kind === kind && sameTarget(episode.target, target));
  if (existingIndex >= 0) {
    const existing = list[existingIndex];
    // 同一来源事件幂等：已记录过就跳过（比较归一化后的 id，超长 eventId 也不重复）
    if (sourceEventId != null && Array.isArray(existing.contributions)
      && existing.contributions.some((c) => c.sourceEventId === normalizeEventId(sourceEventId))) {
      return { episodes: list, episode: existing, changed: false };
    }
    const current = episodeIntensityAt(existing, now);
    let next = clamp(current + incoming * FUSION_GAIN, 0, 1);
    if (incoming >= REIGNITE_FLOOR && current <= REIGNITE_CURRENT_MAX) next = Math.max(next, incoming);
    const contributions = [
      { sourceEventId: normalizeEventId(sourceEventId), contribution: incoming, confidence },
      ...(Array.isArray(existing.contributions) ? existing.contributions : []),
    ].slice(0, V2_MAX_CONTRIBUTIONS);
    const updated = {
      ...existing,
      peak: next,
      decayAnchorAt: now,
      confidence,
      appraisal: normalizeAppraisal(cand.appraisal),
      contributions,
      latestSourceEventId: normalizeEventId(sourceEventId),
      evidence: {
        span: truncateChars(cand.evidence?.span ?? existing.evidence?.span ?? '', V2_EVIDENCE_SPAN_CHARS),
        quote: truncateChars(cand.evidence?.quote ?? existing.evidence?.quote ?? '', V2_EVIDENCE_QUOTE_CHARS),
      },
      need: cand.need || existing.need || kindInfo.need,
      actionTendency: resolveAction(cand, 'actionTendency', existing.actionTendency ?? kindInfo.action),
      appraisalNote: truncateChars(cand.appraisalNote ?? existing.appraisalNote ?? '', V2_APPRAISAL_NOTE_CHARS),
    };
    list[existingIndex] = updated;
    return { episodes: evictEpisode(list, { activeUid, dominantKind, now }), episode: updated, changed: true };
  }
  const episode = {
    id: makeEpisodeId({
      kind,
      target,
      now,
      sourceEventId,
      existingIds: new Set(list.map((item) => item && item.id).filter(Boolean)),
    }),
    kind,
    target,
    peak: incoming,
    decayAnchorAt: now,
    halfLifeMs: kindInfo.halfLifeMs,
    confidence,
    contributions: sourceEventId == null ? [] : [{ sourceEventId: normalizeEventId(sourceEventId), contribution: incoming, confidence }],
    latestSourceEventId: normalizeEventId(sourceEventId),
    evidence: {
      span: truncateChars(cand.evidence?.span ?? '', V2_EVIDENCE_SPAN_CHARS),
      quote: truncateChars(cand.evidence?.quote ?? '', V2_EVIDENCE_QUOTE_CHARS),
    },
    appraisal: normalizeAppraisal(cand.appraisal),
    need: cand.need || kindInfo.need,
    actionTendency: resolveAction(cand, 'actionTendency', kindInfo.action),
    appraisalNote: truncateChars(cand.appraisalNote ?? '', V2_APPRAISAL_NOTE_CHARS),
  };
  list.push(episode);
  return { episodes: evictEpisode(list, { activeUid, dominantKind, now }), episode, changed: true };
}

/**
 * 批量应用候选（多事件路径）：按事件时间（candidate.at）升序逐条 upsert。
 *
 * 关键语义：
 * - 顺序由事件时间决定，而不是 appraise 输出的强度排序；否则「最新来源」会被低强度新事件覆盖；
 * - 每次 upsert 用 candidate.at 作为 now（每条 episode 的 anchor 是它自己的事件时间）；
 * - contributions「最新在前」因此按事件时间成立。
 *
 * 注意：本函数不改变 dominantKind（批次内不产生 switch）；1B 应在批次结束后显式调用 switchDominant。
 */
export function applyCandidates(episodes, candidates, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const incoming = Array.isArray(candidates) ? candidates : [];
  const ordered = incoming
    .map((cand, index) => ({ cand, index }))
    .sort((a, b) => {
      const atA = Number.isFinite(a.cand?.at) ? a.cand.at : now;
      const atB = Number.isFinite(b.cand?.at) ? b.cand.at : now;
      return (atA - atB) || (a.index - b.index);
    })
    .map((entry) => entry.cand);
  let list = Array.isArray(episodes) ? episodes.slice() : [];
  let changed = false;
  for (const cand of ordered) {
    const eventNow = Number.isFinite(cand?.at) ? cand.at : now;
    const result = upsertEpisode(list, cand, { ...options, now: eventNow });
    list = result.episodes;
    changed = changed || result.changed;
  }
  return { episodes: list, changed };
}

/** 判断 episode 是否纳入当前对话视图（契约 §4.4）。 */
export function isEpisodeInContext(episode, context = {}) {
  if (!episode) return false;
  const target = normalizeTarget(episode.target);
  const mode = context.mode === 'group' ? 'group' : 'private';
  const activeUid = context.activeUid == null ? null : String(context.activeUid);
  const key = context.key == null ? null : String(context.key);
  if (target.kind === 'self' || target.kind === 'world') return true;
  if (mode === 'private') {
    return target.kind === 'other' && activeUid != null && target.uid === activeUid;
  }
  // 群聊：当前说话人 / 本群 / 自己
  if (target.kind === 'other' && activeUid != null && target.uid === activeUid) return true;
  if (target.kind === 'group' && key != null && target.key === key) return true;
  return false;
}

/**
 * 合成「完整心情」（target-aware，方案 A 全局心情）。
 *
 * @param {{episodes: object[], context?: object, baseline?: object, legacyAffect?: object|null}} input
 * @returns {{dominant: object|null, mix: object[], conflict: number, valence: number, arousal: number,
 *            energy: number, dominance: number, label: string, reasons: object[],
 *            byTarget: object, episodeCount: number, legacy: object|null}}
 */
export function synthesizeMood(input = {}) {
  const tuning = input?.tuning && typeof input.tuning === 'object' ? input.tuning : null;
  const episodes = Array.isArray(input?.episodes) ? input.episodes : [];
  const context = input?.context && typeof input.context === 'object' ? input.context : {};
  const baseline = input?.baseline && typeof input.baseline === 'object' ? input.baseline : null;
  const legacyAffect = input?.legacyAffect && typeof input.legacyAffect === 'object' ? input.legacyAffect : null;
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const included = [];
  const byTarget = Object.create(null);
  for (const episode of episodes) {
    // 阶段 2：fast 通道使用 tuning-aware 衰减（per-kind 半衰期覆盖对 mix/valence/dominant 一致生效）
    const channel = episodeChannelIntensity(episode, now, tuning);
    const view = { ...episode, currentIntensity: channel.fast, slowIntensity: channel.slow };
    const uidKey = view.target?.uid == null ? null : String(view.target.uid);
    // byTarget 只读投影：与全局 active 过滤一致，不展示完全衰减的情绪
    if (uidKey && view.currentIntensity >= MIN_ACTIVE_INTENSITY) {
      if (!byTarget[uidKey]) byTarget[uidKey] = [];
      byTarget[uidKey].push(view);
    }
    if (isEpisodeInContext(view, context)) included.push(view);
  }
  // byTarget 只读投影：每个 target 计算自己的 mix/dominant
  const byTargetView = Object.create(null);
  for (const [uid, list] of Object.entries(byTarget)) {
    byTargetView[uid] = { dominant: pickDominant(list), mix: buildMix(list) };
  }

  const active = included.filter((episode) => episode.currentIntensity >= MIN_ACTIVE_INTENSITY);
  let positive = 0;
  let negative = 0;
  for (const episode of active) {
    const info = EMOTION_KINDS[episode.kind];
    if (!info) continue;
    if (info.valence >= 0) positive += info.valence * episode.currentIntensity;
    else negative += Math.abs(info.valence) * episode.currentIntensity;
  }
  const sum = positive + negative;
  const valence = sum > 0 ? (positive - negative) / sum : 0;
  const conflict = sum > 0 ? Math.min(positive, negative) / Math.max(positive, negative) : 0;
  // 阶段 2：慢通道（背景心情）valence —— 独立 slow-active 集合（fast 完全衰减后仍保留背景心情）
  let slowPositive = 0;
  let slowNegative = 0;
  for (const episode of included) {
    const info = EMOTION_KINDS[episode.kind];
    if (!info) continue;
    const slow = Number.isFinite(episode.slowIntensity) ? episode.slowIntensity : episodeChannelIntensity(episode, now, tuning).slow;
    if (slow < MIN_ACTIVE_INTENSITY) continue;
    if (info.valence >= 0) slowPositive += info.valence * slow;
    else slowNegative += Math.abs(info.valence) * slow;
  }
  const slowSum = slowPositive + slowNegative;
  const slowValence = slowSum > 0 ? (slowPositive - slowNegative) / slowSum : 0;

  // 兼容视图：按 kind 坐标 × 强度加权
  const coord = { arousal: 0, energy: 0, dominance: 0 };
  let weightSum = 0;
  for (const episode of active) {
    const info = EMOTION_KINDS[episode.kind];
    if (!info) continue;
    const w = episode.currentIntensity;
    coord.arousal += info.arousal * w;
    coord.energy += ((info.arousal + info.valence + 1) / 3) * w; // energy 近似：唤醒+效价归一
    coord.dominance += info.dominance * w;
    weightSum += w;
  }
  const normalized = weightSum > 0
    ? {
      valence: clamp(valence, -1, 1),
      arousal: clamp(coord.arousal / weightSum, 0, 1),
      energy: clamp(coord.energy / weightSum, 0, 1),
      dominance: clamp(coord.dominance / weightSum, 0, 1),
    }
    : null;

  let view;
  if (normalized) {
    view = normalized;
  } else if (baseline) {
    view = {
      valence: clamp(finite(baseline.valence), -1, 1),
      arousal: clamp01(baseline.arousal),
      energy: clamp01(baseline.energy),
      dominance: clamp01(baseline.dominance ?? 0.5),
    };
  } else if (legacyAffect) {
    view = {
      valence: clamp(finite(legacyAffect.valence), -1, 1),
      arousal: clamp01(legacyAffect.arousal),
      energy: clamp01(legacyAffect.energy),
      dominance: clamp01(legacyAffect.dominance ?? 0.5),
    };
  } else {
    view = { valence: 0, arousal: 0.3, energy: 0.6, dominance: 0.5 };
  }

  const mix = buildMix(active);
  const dominant = active.length ? pickDominant(active) : null;
  const label = buildLabel(dominant, mix, conflict);
  return {
    dominant,
    mix,
    conflict: clamp01(conflict),
    slowValence,
    ...view,
    label,
    reasons: active.map((episode) => ({
      kind: episode.kind,
      intensity: clamp01(episode.currentIntensity),
      sourceEventId: episode.latestSourceEventId ?? null,
      note: episode.appraisalNote ?? '',
    })),
    byTarget: byTargetView,
    episodeCount: active.length,
    // baseline 优先于 legacyAffect；只有「无 episode 且无 baseline」时才回退 legacy
    legacy: !normalized && !baseline && legacyAffect ? { ...legacyAffect } : null,
  };
}

function pickDominant(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const scored = list.map((episode) => ({
    episode,
    intensity: Number.isFinite(episode.currentIntensity) ? episode.currentIntensity : episodeIntensityAt(episode),
    anchor: Number.isFinite(episode.decayAnchorAt) ? episode.decayAnchorAt : 0,
    kind: String(episode.kind),
    id: String(episode.id ?? ''),
  }));
  // 完全确定性：强度降序 → kind 升序 → anchor 降序（更近更新优先）→ id 升序
  scored.sort((a, b) => (b.intensity - a.intensity)
    || a.kind.localeCompare(b.kind)
    || (b.anchor - a.anchor)
    || a.id.localeCompare(b.id));
  const best = scored[0];
  return {
    kind: best.episode.kind,
    intensity: best.intensity,
    since: best.anchor,
    sourceEpisodeId: best.episode.id ?? null,
    sourceEventId: best.episode.latestSourceEventId ?? null,
  };
}

function buildMix(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  // 按 kind 聚合：同 kind 取 max（与七情面板一致；迁移副本/重复事件不重复放大占比），ratio 归一化
  const byKind = new Map();
  for (const episode of list) {
    const intensity = Number.isFinite(episode.currentIntensity) ? clamp01(episode.currentIntensity) : 0;
    if (intensity <= 0) continue;
    const current = byKind.get(episode.kind) ?? { kind: episode.kind, intensity: 0 };
    current.intensity = Math.max(current.intensity, intensity);
    byKind.set(episode.kind, current);
  }
  const merged = [...byKind.values()].map((item) => ({ ...item, intensity: clamp01(item.intensity) }));
  const total = merged.reduce((acc, item) => acc + item.intensity, 0);
  if (total <= 0) return [];
  return merged
    .map((item) => ({ kind: item.kind, intensity: item.intensity, ratio: clamp01(item.intensity / total) }))
    .sort((a, b) => (b.intensity - a.intensity) || a.kind.localeCompare(b.kind));
}

function buildLabel(dominant, mix, conflict) {
  if (!dominant) return '平静';
  const info = EMOTION_KINDS[dominant.kind];
  const main = info ? info.label : dominant.kind;
  const secondary = mix.filter((item) => item.kind !== dominant.kind).slice(0, 1)[0];
  const secondInfo = secondary ? EMOTION_KINDS[secondary.kind] : null;
  if (secondInfo && conflict > 0.3) return `又${secondInfo.label}又${main}`;
  if (secondInfo && secondary.ratio >= 0.25) return `${main}，还有点${secondInfo.label}`;
  return main;
}

/**
 * 主情绪切换（滞回 + 最小驻留 + 每轮一次 + 反向抑制）。
 *
 * 规则（契约 §4.5）：
 * - 当前强度从「dominant 对应 episode」按衰减计算（找不到 episode 时按 kind 半衰期从 since 衰减）；
 * - 候选必须严格 > 0.25；
 * - 同 kind 强化只刷新强度，不消耗本轮 switch 配额；
 * - 未满足切换条件时不得凭空生成 dominant（无 current 时保持 null）。
 *
 * @param {{agentMood: object, episodes: object[], context?: object, now?: number, turnKey?: string|null}} input
 * @returns {{dominant: object|null, lastSwitchAt: number, switchesThisTurn: number,
 *            reverseSuppressUntil: number, turnKey: string|null, changed: boolean}}
 */
export function switchDominant(input = {}) {
  const agentMood = input?.agentMood && typeof input.agentMood === 'object' ? input.agentMood : {};
  const context = input?.context && typeof input.context === 'object' ? input.context : {};
  const now = Number.isFinite(input?.now) ? input.now : Date.now();
  const turnKey = input?.turnKey == null ? null : String(input.turnKey);
  const effectiveTurnKey = turnKey ?? `win-${Math.floor(now / TURN_WINDOW_MS)}`;
  const inertia = clamp01(agentMood.inertia ?? DEFAULT_INERTIA);
  const tuning = input?.tuning && typeof input.tuning === 'object' ? input.tuning : null;
  const switchCfg = tuning?.switch && typeof tuning.switch === 'object' ? tuning.switch : {};
  const floorCfg = Number(switchCfg.floor);
  const switchFloor = Number.isFinite(floorCfg) && floorCfg >= 0 && floorCfg <= 1 ? floorCfg : SWITCH_FLOOR;
  const dwellCfg = Number(switchCfg.minDwellMs);
  const minDwellMs = Number.isFinite(dwellCfg) && dwellCfg >= 0 && dwellCfg <= 60 * 60 * 1000 ? dwellCfg : MIN_DWELL_MS;
  const maxSwitchesCfg = Number(switchCfg.maxSwitchesPerTurn);
  const maxSwitchesPerTurn = Number.isInteger(maxSwitchesCfg) && maxSwitchesCfg >= 1 && maxSwitchesCfg <= 10
    ? maxSwitchesCfg
    : MAX_SWITCHES_PER_TURN;
  const suppressCfg = Number(switchCfg.reverseSuppressMs);
  const reverseSuppressMs = Number.isFinite(suppressCfg) && suppressCfg >= 0 && suppressCfg <= 24 * 60 * 60 * 1000
    ? suppressCfg
    : REVERSE_SUPPRESS_MS;
  const prevTurnKey = agentMood.turnKey == null ? null : String(agentMood.turnKey);
  const sameTurn = prevTurnKey === effectiveTurnKey;
  const switchesThisTurn = sameTurn ? Math.max(0, Number(agentMood.switchesThisTurn) || 0) : 0;
  const lastSwitchAt = Number(agentMood.lastSwitchAt) || 0;
  const reverseSuppressUntil = Number(agentMood.reverseSuppressUntil) || 0;
  const current = agentMood.dominant && Object.hasOwn(EMOTION_KINDS, agentMood.dominant.kind)
    ? {
      kind: agentMood.dominant.kind,
      intensity: clamp01(agentMood.dominant.intensity),
      since: Number(agentMood.dominant.since) || 0,
      sourceEpisodeId: typeof agentMood.dominant.sourceEpisodeId === 'string' ? agentMood.dominant.sourceEpisodeId : null,
    }
    : null;
  if (current && !current.since) current.since = lastSwitchAt;

  // dominant 的当前衰减强度：
  // 1) 有 sourceEpisodeId 且仍存在 → 精确取该 episode；
  // 2) 否则在同 kind 且在 context 内的 episode 中取「最高衰减强度」（不依赖数组顺序）；
  // 3) 都不存在 → 按 kind 半衰期从 since 衰减；since 与 lastSwitchAt 都为 0 时视为 legacy 未知锚点（见下方 next.dominant 同步 now）。
  const episodes = Array.isArray(input?.episodes) ? input.episodes : [];
  function currentIntensityAt() {
    if (!current) return 0;
    // 一级：sourceEpisodeId 全局精确命中（不受当前 context 限制；契约 §4.2.1）
    if (current.sourceEpisodeId) {
      const exact = episodes.find((episode) => episode && episode.id === current.sourceEpisodeId);
      if (exact) return episodeChannelIntensity(exact, now, tuning).fast;
    }
    // 二级：当前 context 内同 kind 取最高衰减强度
    const sameKind = episodes.filter((episode) => episode && episode.kind === current.kind && isEpisodeInContext(episode, context));
    if (sameKind.length > 0) return Math.max(...sameKind.map((episode) => episodeChannelIntensity(episode, now, tuning).fast));
    // 三级：按 kind 半衰期从 since 衰减；无锚点返回存储值（本次调用会同步 since=now）
    const info = EMOTION_KINDS[current.kind];
    const override = tuning?.halfLifeByKind ? Number(tuning.halfLifeByKind[current.kind]) : NaN;
    const halfLife = Number.isFinite(override) && override > 0 ? override : (info?.halfLifeMs ?? MIN_DWELL_MS);
    const anchor = current.since !== 0 ? current.since : (lastSwitchAt !== 0 ? lastSwitchAt : null);
    if (anchor == null) return current.intensity;
    const dt = Math.max(0, now - anchor);
    return clamp01(current.intensity * Math.pow(2, -dt / halfLife));
  }

  const candidates = episodes
    .filter((episode) => episode && isEpisodeInContext(episode, context))
    .map((episode) => ({
      kind: episode.kind,
      episodeId: episode.id ?? null,
      intensity: episodeChannelIntensity(episode, now, tuning).fast,
      anchor: episode.decayAnchorAt ?? 0,
    }))
    .sort((a, b) => (b.intensity - a.intensity) || (a.kind.localeCompare(b.kind)));
  const best = candidates[0] ?? null;

  const next = { dominant: current, lastSwitchAt, switchesThisTurn, reverseSuppressUntil, turnKey: prevTurnKey, changed: false };
  // legacy 无锚点 dominant：本次同步 since=now（避免无限期保持原强度；调用方需落盘）
  if (current && current.since === 0 && lastSwitchAt === 0) {
    next.dominant = { kind: current.kind, since: now, intensity: current.intensity, sourceEpisodeId: current.sourceEpisodeId };
  }
  if (!best) return next;
  const currentIntensity = currentIntensityAt();
  const threshold = currentIntensity * (1 + inertia);

  // 同 kind 强化：刷新强度并把衰减锚点同步到 now（since 即「当前 intensity 的锚点」），
  // 不计 switch、不更新 lastSwitchAt；下次衰减从 now 起算，避免用旧 since 二次衰减。
  if (current && best.kind === current.kind) {
    next.dominant = {
      kind: current.kind,
      since: now,
      intensity: Math.max(currentIntensity, best.intensity),
      sourceEpisodeId: best.episodeId ?? current.sourceEpisodeId,
    };
    return next;
  }

  const canSwitch = best.intensity > switchFloor // 严格大于（默认 0.25 不切）
    && (!current || best.intensity > threshold)
    && now - lastSwitchAt >= minDwellMs
    && switchesThisTurn < maxSwitchesPerTurn
    && now >= reverseSuppressUntil;
  if (!canSwitch) {
    // 未通过条件：不生成 dominant 投影（无 current 时保持 null）
    return next;
  }
  next.dominant = { kind: best.kind, since: now, intensity: best.intensity, sourceEpisodeId: best.episodeId };
  next.lastSwitchAt = now;
  next.switchesThisTurn = switchesThisTurn + 1;
  next.reverseSuppressUntil = now + reverseSuppressMs;
  next.turnKey = effectiveTurnKey;
  next.changed = true;
  return next;
}

/**
 * 旧状态迁移：mood v1 → agentMood v2（legacyAffect + 可映射的低置信度 episode）。
 * 幂等：输入已是 v2（schemaVersion=2 且有 episodes）时原样返回。
 */
export function migrateMoodV1(raw, { now = Date.now() } = {}) {
  const old = raw && typeof raw === 'object' ? raw : {};
  if (old.schemaVersion === MOOD_V2_SCHEMA_VERSION && Array.isArray(old.episodes)) {
    return {
      agentMood: old,
      legacyAffect: old.legacyAffect ?? null,
      migrated: false,
    };
  }
  const cause = truncateChars(old.cause ?? '', 160);
  const legacyAffect = {
    valence: clamp(finite(old.valence), -1, 1),
    arousal: clamp01(old.arousal),
    energy: clamp01(old.energy),
    dominance: clamp01(old.dominance ?? 0.5),
    cause,
    causeType: typeof old.causeType === 'string' ? old.causeType.slice(0, 40) : '',
  };
  const episodes = [];
  const type = legacyAffect.causeType;
  if (type && Object.hasOwn(EMOTION_TEMPLATES, type)) {
    const template = EMOTION_TEMPLATES[type][0];
    const kindInfo = EMOTION_KINDS[template.kind];
    episodes.push(normalizeEpisode({
      id: `ep-migrated-${template.kind}`,
      kind: template.kind,
      target: { kind: 'world' },
      peak: 0.3,
      decayAnchorAt: now,
      halfLifeMs: kindInfo.halfLifeMs,
      confidence: 0.3,
      contributions: [],
      latestSourceEventId: null,
      evidence: { span: '', quote: truncateChars(cause, V2_EVIDENCE_QUOTE_CHARS) },
      appraisal: normalizeAppraisal({ relevance: 0.5, goalCongruence: kindInfo.valence >= 0 ? 0.5 : -0.5 }),
      need: kindInfo.need,
      actionTendency: '',
      appraisalNote: '',
    }, now));
  }
  return {
    agentMood: {
      schemaVersion: MOOD_V2_SCHEMA_VERSION,
      migratedAt: now,
      migrationVersion: 1,
      episodes,
      dominant: null,
      lastSwitchAt: 0,
      switchesThisTurn: 0,
      reverseSuppressUntil: 0,
      turnKey: null,
      baseline: {
        valence: legacyAffect.valence,
        arousal: legacyAffect.arousal,
        energy: legacyAffect.energy,
        dominance: legacyAffect.dominance,
        updatedAt: now,
      },
      needs: createEmptyNeeds(0),
      sensitivity: {},
      sensitivityLog: [],
      chronicLoad: 0,
      chronicLoadUpdatedAt: 0,
      volatility: 0.6,
      inertia: DEFAULT_INERTIA,
      legacyAffect,
      pendingFacts: [],
      unresolvedFacts: [],
    },
    legacyAffect,
    migrated: true,
  };
}

/** 空 agentMood（新建/测试用）。 */
export function createEmptyAgentMood({ now = Date.now() } = {}) {
  return {
    schemaVersion: MOOD_V2_SCHEMA_VERSION,
    migratedAt: now,
    migrationVersion: 1,
    episodes: [],
    dominant: null,
    lastSwitchAt: 0,
    switchesThisTurn: 0,
    reverseSuppressUntil: 0,
    turnKey: null,
    baseline: { valence: 0, arousal: 0.3, energy: 0.6, dominance: 0.5, updatedAt: now },
    needs: createEmptyNeeds(0),
    sensitivity: {},
    sensitivityLog: [],
    chronicLoad: 0,
    chronicLoadUpdatedAt: 0,
    volatility: 0.6,
    inertia: DEFAULT_INERTIA,
    legacyAffect: null,
    pendingFacts: [],
    unresolvedFacts: [],
  };
}
