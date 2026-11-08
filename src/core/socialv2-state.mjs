// 情绪系统 V2 —— 1B 状态层（唯一契约：ADDENDUM-1B-internals v2.10）
//
// 分层（与契约 §A 一致）：
//   normalizeSocialV2(raw)  纯解析/归一化 + plan（无 IO、无 memory、不写盘）
//   planSocialV2(runtime)   生成冻结的 MigrationStep 列表
//   loadSocialV2State(raw)  组合入口：只 load/normalize/plan，不执行迁移
//   runMigrationStep(state) 执行一步 → proposedState（复制、revision=old+1）
//   applyStartupMigration   循环 runMigrationStep + writeFile，读成功才提交
//   serializeSocialV2(state,{mode})  三模式（final/transition/shadow）
//
// 本文件不写盘；writeFile 由调用方注入。memory archive 的副作用在 §E 的 save/archive 阶段执行，
// 迁移 driver 只负责准备冻结队列（pendingArchive/pendingEvict）并推进状态。

import crypto from 'node:crypto';
import { canonicalUid, serializeMood, serializeRelationships } from './mood.mjs';
import { EMOTION_KINDS, canonicalCandidateKey, createEmptyAgentMood, migrateMoodV1, normalizeEpisodes, resolveSensitivityConfig } from './mood-v2.mjs';
import { canonicalV2Key, hydrateConversationStateV2 } from './socialv2-store.mjs';

export const V2_STATE_SCHEMA_VERSION = 2;
export const MAX_CONVERSATIONS = 32;
export const MAX_RELATIONSHIPS = 50;
export const MAX_RELATIONSHIPS_HARD = 60;
export const HOT_RELATIONSHIPS = 10;
export const HOT_RELATIONSHIPS_DEGRADED = 15;
export const MAX_OPEN_LOOPS = 8;
export const MAX_RELATIONSHIP_EVENTS = 8;
export const MAX_PENDING_EVICT = 10;
export const MAX_ORPHAN_LOOPS = 10;
export const MAX_PENDING_COLD = 10;
export const AGENT_MOOD_BUDGET_BYTES = 96 * 1024;
export const RELATIONSHIPS_BUDGET_BYTES = 64 * 1024;
export const RELATIONSHIP_ARCHIVE_BUDGET_BYTES = 96 * 1024;
export const CONVERSATION_TARGET_BYTES = 128 * 1024;
export const CONVERSATION_HARD_BYTES = 192 * 1024;
export const GLOBAL_BUDGET_BYTES = 5 * 1024 * 1024;
export const SEEN_FORWARD_MAX = 200;
export const SEEN_FORWARD_HEX_CHARS = 16;
// conversation 字段上限（契约 §3.2）
export const MAX_RECENT_MESSAGES = 50;
export const MAX_UNREAD = 20;
export const MAX_MESSAGE_TEXT = 200;
export const MAX_MESSAGE_ID = 32;
export const MAX_SENDER = 24;
export const MAX_USER_ID = 16;
export const MAX_FORWARD_IDS = 3;
export const MAX_MEDIA_COUNT = 2;
export const MAX_MEDIA_URL = 128;
export const MAX_TOPICS = 20;
export const MAX_THOUGHTS = 20;
export const MAX_TOPIC_TEXT = 200;
export const MAX_TOPIC_PARTICIPANTS = 10;
export const MAX_IMPRESSIONS = 30;
export const MAX_IMPRESSION_TEXT = 40;
export const MAX_WAKE_TIMES = 100;
export const MAX_SEND_TIMES = 200;
export const MAX_STICKER_TIMES = 200;
export const MIGRATION_STATUSES = Object.freeze(['pending', 'mood-done', 'relations-done', 'archive-done', 'done', 'failed']);
export const ATTACHMENT_STYLES = Object.freeze(['secure', 'anxious', 'avoidant', 'mixed']);
export const PENDING_ARCHIVE_PHASES = Object.freeze(['checkpoint', 'memory-written', 'conversation-removed']);

const clone = (value) => JSON.parse(JSON.stringify(value));
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const finite = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const clamp01 = (value) => Math.min(1, Math.max(0, finite(value)));
const clampSigned = (value) => Math.min(1, Math.max(-1, finite(value)));
const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.trunc(finite(value))));
const text = (value, max) => String(value ?? '').slice(0, max);
const SEEN_FORWARD_HASH_RE = /^[0-9a-f]{16}$/;

/** md5 前 16 hex（seenForwardIds 防碰撞；与 Internals §I 一致）。 */
export function hashSeenForwardId(id) {
  return crypto.createHash('md5').update(String(id ?? '')).digest('hex').slice(0, SEEN_FORWARD_HEX_CHARS);
}

/** 持久化数组 → 去重 → 最后 200。已是 16hex 的值直接接受（避免二次 md5）。 */
export function normalizeSeenForwardIds(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const raw = String(item ?? '');
    const hash = SEEN_FORWARD_HASH_RE.test(raw) ? raw : hashSeenForwardId(raw);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push(hash);
  }
  return out.slice(-SEEN_FORWARD_MAX);
}

/** 从 conversations（Map）读回 seenForwardIds Map<key, Set<hash>>。rawByKey 为 canonical key → 原始落盘条目。 */
export function readSeenForwardIds(conversations, rawByKey) {
  const map = new Map();
  for (const [key, st] of conversations) {
    const raw = rawByKey?.get?.(key) ?? rawByKey?.[key];
    const list = Array.isArray(raw?.seenForwardIds) ? raw.seenForwardIds : [];
    map.set(key, new Set(normalizeSeenForwardIds(list)));
  }
  return map;
}

/** 媒体条目归一化（对象 allowlist；绝不 String(object)）。 */
export function normalizeMediaItem(raw) {
  const item = raw && typeof raw === 'object' ? raw : null;
  if (!item) return null;
  const kind = text(item.kind, 16);
  if (kind === 'face') return { kind: 'face', faceId: text(item.faceId ?? item.id, 32) };
  const image = {
    kind: 'image',
    file: text(item.file, MAX_MEDIA_URL),
    url: text(item.url, MAX_MEDIA_URL),
    subType: text(item.subType, 16),
    summary: text(item.summary, 64),
  };
  // image 或未知 kind：有 file/url 规范为 image；两者都空 → 丢弃（不允许未知 kind 长期落盘）
  if (kind === 'image' || image.file || image.url) return image;
  return null;
}

/** 单条消息归一化（逐字段 allowlist；真实 bridge 形状：seq/plain/tail/hasMedia/forwardIds...）。 */
export function normalizeMessage(raw) {
  const msg = raw && typeof raw === 'object' ? raw : {};
  const media = Array.isArray(msg.media) ? msg.media.slice(0, MAX_MEDIA_COUNT).map(normalizeMediaItem).filter(Boolean) : [];
  const forwardIds = Array.isArray(msg.forwardIds) ? msg.forwardIds.slice(0, MAX_FORWARD_IDS).map((id) => text(id, 32)) : [];
  const out = {
    seq: clampInt(msg.seq, 0, Number.MAX_SAFE_INTEGER),
    messageId: text(msg.messageId, MAX_MESSAGE_ID),
    sender: text(msg.sender, MAX_SENDER),
    userId: text(msg.userId, MAX_USER_ID),
    text: text(msg.text, MAX_MESSAGE_TEXT),
    plain: text(msg.plain ?? msg.text, MAX_MESSAGE_TEXT),
    tail: text(msg.tail ?? msg.plain ?? msg.text, MAX_MESSAGE_TEXT),
    quoteTargetIsSelf: !!msg.quoteTargetIsSelf,
    isOwner: !!msg.isOwner,
    ownerLabel: text(msg.ownerLabel, 64),
    isSelf: !!msg.isSelf,
    media,
    hasMedia: media.length > 0,
    forwardIds,
    hasForward: forwardIds.length > 0,
    time: finite(msg.time, 0),
  };
  // 拍一拍等真实消息：kind + poke 目标元数据（bridge 写 targetId/targetIsSelf/groupId）
  out.kind = text(msg.kind, 16);
  if (msg.poke && typeof msg.poke === 'object') {
    out.poke = {
      targetId: msg.poke.targetId != null ? text(msg.poke.targetId, MAX_USER_ID) : null,
      targetIsSelf: !!msg.poke.targetIsSelf,
      groupId: msg.poke.groupId != null ? text(msg.poke.groupId, MAX_USER_ID) : null,
    };
  }
  return out;
}

/** 热话题（bridge 真实形状：text/lastMentionAt/participants/pendingQuestion）。 */
export function normalizeTopic(raw) {
  const t = raw && typeof raw === 'object' ? raw : null;
  if (!t) return null;
  const textValue = text(t.text, MAX_TOPIC_TEXT);
  if (!textValue) return null;
  return {
    text: textValue,
    lastMentionAt: finite(t.lastMentionAt, 0),
    participants: Array.isArray(t.participants) ? t.participants.slice(0, MAX_TOPIC_PARTICIPANTS).map((p) => text(p, MAX_SENDER)) : [],
    pendingQuestion: text(t.pendingQuestion, MAX_TOPIC_TEXT),
  };
}

/** 待说想法（bridge 真实形状：text/createdAt/expiresAt/motivation）。 */
export function normalizeThought(raw) {
  const t = raw && typeof raw === 'object' ? raw : null;
  if (!t) return null;
  const textValue = text(t.text, MAX_TOPIC_TEXT);
  if (!textValue) return null;
  return {
    text: textValue,
    createdAt: finite(t.createdAt, 0),
    expiresAt: finite(t.expiresAt, 0),
    motivation: text(t.motivation, 50),
  };
}

function normalizeImpressions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const clean = {};
  let count = 0;
  for (const [key, value] of Object.entries(source)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (count >= MAX_IMPRESSIONS) break;
    const entry = value && typeof value === 'object' ? value : {};
    clean[key] = {
      traits: Array.isArray(entry.traits) ? entry.traits.slice(0, 4).map((t) => text(t, 16)) : [],
      interactionCount: clampInt(entry.interactionCount, 0, Number.MAX_SAFE_INTEGER),
      lastSeenAt: finite(entry.lastSeenAt, 0),
    };
    count += 1;
  }
  return clean;
}

/** 严格 ISO 8601 UTC + 日历合法性（拒绝 02-30、非闰年 02-29；bridge 用 toISOString 生成）。 */
function isStrictIsoUtc(value) {
  if (typeof value !== 'string') return false;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!ISO_RE.test(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const year = String(d.getUTCFullYear()).padStart(4, '0'); // 四位年份 0000–0999 必须补零（评审 R18）
  const rebuilt = `${year}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return rebuilt === value.slice(0, 19);
}

/** 唤醒配置字段级归一化（防契约外字段/超长数组撑爆单会话）。 */
export function normalizeWakeConfig(raw) {
  const w = raw && typeof raw === 'object' ? raw : {};
  const triggers = w.triggers && typeof w.triggers === 'object' ? w.triggers : {};
  const rawSleep = typeof w.sleepUntil === 'string' ? w.sleepUntil : '';
  // 严格 ISO 8601 UTC + 日历合法（评审 R17）；宽松日期/非法日历 → 视为未设置
  const parsedSleep = isStrictIsoUtc(rawSleep) ? rawSleep : null;
  // 有限但无有效期限 → 视为无限（避免「有限睡眠但没有有效期限」的状态；评审 P2）
  const infinite = !!w.infinite || !parsedSleep;
  return {
    mode: w.mode === 'active' ? 'active' : 'diving',
    infinite,
    sleepUntil: infinite ? null : parsedSleep,
    triggers: {
      atMention: !!triggers.atMention,
      nameMention: !!triggers.nameMention,
      speakerIds: Array.isArray(triggers.speakerIds) ? triggers.speakerIds.slice(0, 20).map((id) => text(id, 16)) : [],
      keywords: Array.isArray(triggers.keywords) ? triggers.keywords.slice(0, 10).map((kw) => text(kw, 16)) : [],
      question: !!triggers.question,
      poke: !!triggers.poke,
      probability: clamp01(triggers.probability),
      anyMessage: !!triggers.anyMessage,
    },
    batchWindowMs: clampInt(w.batchWindowMs, 1000, 600000),
    lastWakeAt: finite(w.lastWakeAt, 0),
    wakeCount: clampInt(w.wakeCount, 0, Number.MAX_SAFE_INTEGER),
    noActionCount: clampInt(w.noActionCount, 0, Number.MAX_SAFE_INTEGER),
    confirmedAt: finite(w.confirmedAt, 0),
    confirmedBy: text(w.confirmedBy ?? 'default', 16),
  };
}

/**
 * conversation 归一化（v2 字段 + 容量上限）：在 hydrate 之后统一执行。
 * 上限：recent 50 / unread 20 / wakeTimes 100 / sendTimes 200 / sticker 200 / topics 20 / thoughts 20 / impressions 30。
 */
export function normalizeConversationV2(st, raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  st.lastContextKey = canonicalV2Key(source.lastContextKey) ?? null;
  st.generationId = typeof source.generationId === 'string' && source.generationId ? source.generationId.slice(0, 64) : null;
  st.wakeConfig = normalizeWakeConfig(st.wakeConfig);
  st.recentMessages = (Array.isArray(st.recentMessages) ? st.recentMessages : []).slice(-MAX_RECENT_MESSAGES).map(normalizeMessage);
  st.unread = (Array.isArray(st.unread) ? st.unread : []).slice(-MAX_UNREAD).map(normalizeMessage);
  st.activeTopics = (Array.isArray(st.activeTopics) ? st.activeTopics : []).map(normalizeTopic).filter(Boolean).slice(0, MAX_TOPICS);
  st.pendingThoughts = (Array.isArray(st.pendingThoughts) ? st.pendingThoughts : []).map(normalizeThought).filter(Boolean).slice(0, MAX_THOUGHTS);
  st.memberImpressions = normalizeImpressions(st.memberImpressions);
  st.wakeTimes = (Array.isArray(st.wakeTimes) ? st.wakeTimes : []).slice(-MAX_WAKE_TIMES);
  st.sendTimes = (Array.isArray(st.sendTimes) ? st.sendTimes : []).slice(-MAX_SEND_TIMES);
  st.stickerCollectTimes = (Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes : []).slice(-MAX_STICKER_TIMES);
  return st;
}

/** 同一 canonical key 的重复原始会话：合并（seenForwardIds union、legacy 取较新、字段取 lastInteraction 较大者）。 */
function mergeConversationV2(prev, next, nextRaw, prevRaw) {
  const merged = { ...prev, ...next };
  merged.lastIncomingAt = Math.max(finite(prev.lastIncomingAt, 0), finite(next.lastIncomingAt, 0));
  merged.lastActionAt = Math.max(finite(prev.lastActionAt, 0), finite(next.lastActionAt, 0));
  merged.recentMessages = [...(prev.recentMessages ?? []), ...(next.recentMessages ?? [])].slice(-MAX_RECENT_MESSAGES);
  merged.unread = [...(prev.unread ?? []), ...(next.unread ?? [])].slice(-MAX_UNREAD);
  merged.wakeTimes = [...(prev.wakeTimes ?? []), ...(next.wakeTimes ?? [])].slice(-MAX_WAKE_TIMES);
  merged.sendTimes = [...(prev.sendTimes ?? []), ...(next.sendTimes ?? [])].slice(-MAX_SEND_TIMES);
  merged.stickerCollectTimes = [...(prev.stickerCollectTimes ?? []), ...(next.stickerCollectTimes ?? [])].slice(-MAX_STICKER_TIMES);
  merged.activeTopics = [...(prev.activeTopics ?? []), ...(next.activeTopics ?? [])].slice(0, MAX_TOPICS);
  merged.pendingThoughts = [...(prev.pendingThoughts ?? []), ...(next.pendingThoughts ?? [])].slice(0, MAX_THOUGHTS);
  merged.memberImpressions = { ...(prev.memberImpressions ?? {}), ...(next.memberImpressions ?? {}) };
  const prevMood = prevRaw?.mood ?? null;
  const nextMood = nextRaw?.mood ?? null;
  const prevSince = finite(prevMood?.since, 0);
  const nextSince = finite(nextMood?.since, 0);
  merged.legacyMood = nextSince >= prevSince ? nextMood : prevMood;
  merged.legacyRelationships = { ...(prevRaw?.relationships ?? {}), ...(nextRaw?.relationships ?? {}) };
  merged.agentToken = next.agentToken || prev.agentToken;
  merged.seenForwardMerged = [...(prev.seenForwardIds ?? []), ...(next.seenForwardIds ?? [])];
  return merged;
}

/** 关系记录归一化（canonical uid、数值 clamp、generationId 稳定保留、数组上限）。 */
export function normalizeRelationshipEntry(raw, uid, { now = Date.now() } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const canonical = canonicalUid(uid) ?? String(uid ?? '').trim();
  if (!canonical) return null;
  // generationId：合法值保留；缺失 → 确定性生成（跨重启稳定，不每次 archive 重新生成）
  const rawGen = typeof source.generationId === 'string' ? source.generationId.trim() : '';
  const generationId = rawGen
    ? rawGen.slice(0, 64)
    : `gen-${crypto.createHash('sha256').update(`relationship:${canonical}`).digest('hex').slice(0, 16)}`;
  const loops = Array.isArray(source.openLoops) ? source.openLoops : [];
  const events = Array.isArray(source.events) ? source.events : [];
  return {
    uid: canonical,
    generationId,
    intimacy: clamp01(source.intimacy),
    tension: clamp01(source.tension),
    trust: clamp01(source.trust),
    resentment: clamp01(source.resentment),
    attachmentStyle: ATTACHMENT_STYLES.includes(source.attachmentStyle) ? source.attachmentStyle : 'secure',
    lastInteraction: finite(source.lastInteraction, 0),
    lastContextKey: typeof source.lastContextKey === 'string' ? source.lastContextKey.slice(0, 64) : null,
    openLoops: loops
      .filter((loop) => loop && typeof loop === 'object')
      .map((loop) => ({
        id: String(loop.id ?? '').slice(0, 64),
        text: String(loop.text ?? '').slice(0, 120),
        openedAt: finite(loop.openedAt, now),
        ...(loop.closedAt ? { closedAt: finite(loop.closedAt, now) } : {}),
      }))
      .filter((loop) => loop.id)
      .slice(0, MAX_OPEN_LOOPS),
    events: events
      .filter((event) => event && typeof event === 'object')
      .map((event) => ({ at: finite(event.at, 0), type: String(event.type ?? '').slice(0, 32), factId: event.factId ?? null }))
      .slice(0, MAX_RELATIONSHIP_EVENTS),
  };
}

/** 关系归档 payload 归一化（冻结前调用；保证重试内容稳定、同 id 同内容）。 */
export function normalizeRelationshipArchivePayload(raw, { now = Date.now() } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const loops = Array.isArray(src.openLoops) ? src.openLoops : [];
  return {
    intimacy: clamp01(src.intimacy),
    tension: clamp01(src.tension),
    trust: clamp01(src.trust),
    resentment: clamp01(src.resentment),
    attachmentStyle: ATTACHMENT_STYLES.includes(src.attachmentStyle) ? src.attachmentStyle : 'secure',
    lastInteraction: finite(src.lastInteraction, 0),
    lastContextKey: canonicalV2Key(src.lastContextKey) ?? null,
    openLoops: loops
      .slice(0, MAX_OPEN_LOOPS)
      .filter((loop) => loop && typeof loop === 'object')
      .map((loop) => ({
        id: text(loop.id, 64),
        text: text(loop.text, 120),
        openedAt: finite(loop.openedAt, now),
        ...(loop.closedAt ? { closedAt: finite(loop.closedAt, now) } : {}),
      }))
      .filter((loop) => loop.id),
    archivedAt: finite(src.archivedAt, now),
  };
}

/** needs 归一化：契约 §3 为 `{ [need]: { value(0..1), updatedAt } }`（兼容 1A 数字形式）。 */
function normalizeNeedMap(raw) {
  // 阶段 3：六需求始终初始化（空状态与 load 后同形，reset 严格 no-op 依赖此一致性）
  const out = {};
  for (const need of ['belonging', 'approval', 'safety', 'autonomy', 'exploration', 'competence']) {
    out[need] = { value: 0, updatedAt: 0 };
  }
  if (raw && typeof raw === 'object') {
    for (const need of ['belonging', 'approval', 'safety', 'autonomy', 'exploration', 'competence']) {
      const value = raw[need];
      if (value === undefined) continue;
      if (value && typeof value === 'object') {
        out[need] = { value: clamp01(value.value), updatedAt: finite(value.updatedAt, 0) };
      } else if (Number.isFinite(value)) {
        out[need] = { value: clamp01(value), updatedAt: 0 };
      }
    }
  }
  return out;
}

/** sensitivity 归一化：契约 §3.2 与 1A 公式一致为 1..3（不是 0..1）。 */
function normalizeSensitivityMap(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      const name = key.slice(0, 32);
      if (value && typeof value === 'object') {
        out[name] = { value: Math.min(3, Math.max(1, finite(value.value, 1))), updatedAt: finite(value.updatedAt, 0) };
      } else if (Number.isFinite(value)) {
        out[name] = { value: Math.min(3, Math.max(1, value)), updatedAt: 0 };
      }
    }
  }
  return out;
}

/** legacyAffect 归一化：保留 1A 依赖的 energy/dominance/cause/causeType。 */
function normalizeLegacyAffect(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    valence: clampSigned(raw.valence),
    arousal: clamp01(raw.arousal),
    energy: clamp01(raw.energy),
    dominance: clamp01(raw.dominance),
    cause: text(raw.cause, 64),
    causeType: text(raw.causeType, 32),
    at: finite(raw.at, 0), // 0 = 未知（不用 now，避免多次 load 漂移）
  };
}

function normalizeSensitivityLog(raw, { now = Date.now(), windowMs = resolveSensitivityConfig(null).windowMs } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  // 窗口来自 tuning（resolveSensitivityConfig），过期条目在 load 时物理裁剪
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const kind = text(item.kind, 32);
    const at = finite(item.at, now);
    const weight = clamp01(item.weight);
    if (!(at > 0) || !(weight > 0)) continue;
    if (now - at > windowMs) continue; // 物理裁剪（逻辑忽略之外，明确从状态移除）
    const canonical = canonicalCandidateKey({ kind, eventId: item.eventId ?? null, contentHash: item.contentHash ?? null });
    if (!canonical) continue; // dirty：非负性/未知 kind
    if (seen.has(canonical.key)) continue;
    seen.add(canonical.key);
    out.push({ kind, at, weight, eventId: canonical.eventId, contentHash: canonical.contentHash });
  }
  return out.slice(-50);
}

function normalizeAgentMood(raw, { now = Date.now(), tuning = null } = {}) {
  if (!raw || typeof raw !== 'object') return createEmptyAgentMood({ now });
  if (raw.schemaVersion !== V2_STATE_SCHEMA_VERSION || !Array.isArray(raw.episodes)) {
    return migrateMoodV1(raw, { now }).agentMood;
  }
  const empty = createEmptyAgentMood({ now });
  const episodes = normalizeEpisodes(raw.episodes, { now, existingIds: new Set() });
  const dominant = raw.dominant && typeof raw.dominant === 'object' && typeof raw.dominant.kind === 'string'
    ? {
      kind: raw.dominant.kind,
      since: finite(raw.dominant.since, 0),
      intensity: clamp01(raw.dominant.intensity),
      sourceEpisodeId: episodes.some((episode) => episode.id === raw.dominant.sourceEpisodeId)
        ? raw.dominant.sourceEpisodeId
        : null,
    }
    : null;
  // allowlist 重建（不 spread raw，防脏字段/越界值透传）
  return {
    schemaVersion: V2_STATE_SCHEMA_VERSION,
    migratedAt: finite(raw.migratedAt, 0), // 不伪造：0 = 未知（避免多次 load 时间漂移）
    episodes,
    dominant,
    lastSwitchAt: finite(raw.lastSwitchAt, 0),
    switchesThisTurn: clampInt(raw.switchesThisTurn, 0, 10),
    reverseSuppressUntil: finite(raw.reverseSuppressUntil, 0),
    turnKey: typeof raw.turnKey === 'string' ? raw.turnKey.slice(0, 64) : null,
    baseline: {
      valence: clampSigned(raw.baseline?.valence),
      arousal: clamp01(raw.baseline?.arousal ?? empty.baseline.arousal),
      energy: clamp01(raw.baseline?.energy ?? empty.baseline.energy),
      dominance: clamp01(raw.baseline?.dominance ?? empty.baseline.dominance),
      updatedAt: finite(raw.baseline?.updatedAt, now),
    },
    needs: normalizeNeedMap(raw.needs),
    sensitivity: normalizeSensitivityMap(raw.sensitivity),
    sensitivityLog: normalizeSensitivityLog(raw.sensitivityLog, { now, windowMs: resolveSensitivityConfig(tuning).windowMs }),
    chronicLoad: clamp01(raw.chronicLoad),
    chronicLoadUpdatedAt: finite(raw.chronicLoadUpdatedAt, 0),
    volatility: clamp01(raw.volatility ?? empty.volatility),
    inertia: clamp01(raw.inertia ?? empty.inertia),
    legacyAffect: normalizeLegacyAffect(raw.legacyAffect, { now }),
    pendingFacts: Array.isArray(raw.pendingFacts) ? raw.pendingFacts.slice(0, 20) : [],
    unresolvedFacts: Array.isArray(raw.unresolvedFacts) ? raw.unresolvedFacts.slice(0, 20) : [],
  };
}

function mergeLegacyRelationships(conversations, existing, { now }) {
  const merged = new Map();
  for (const [uid, entry] of Object.entries(existing ?? {})) {
    const normalized = normalizeRelationshipEntry(entry, uid, { now });
    if (normalized) merged.set(normalized.uid, normalized);
  }
  // 旧分片：每个 conversation 一份 relationships，按 lastInteraction 取最新合并
  for (const st of conversations.values()) {
    for (const [uid, entry] of Object.entries(st.relationships ?? {})) {
      const normalized = normalizeRelationshipEntry(entry, uid, { now });
      if (!normalized) continue;
      const current = merged.get(normalized.uid);
      if (!current || normalized.lastInteraction >= current.lastInteraction) merged.set(normalized.uid, normalized);
    }
  }
  return Object.fromEntries(merged);
}

/** openLoop 字段级归一化（冻结队列与关系共用）。 */
export function normalizeOpenLoop(raw, { now = Date.now() } = {}) {
  const loop = raw && typeof raw === 'object' ? raw : null;
  if (!loop || !loop.id) return null;
  const out = { id: text(loop.id, 64), text: text(loop.text, 120), openedAt: finite(loop.openedAt, now) };
  if (loop.closedAt) out.closedAt = finite(loop.closedAt, now);
  return out;
}

/** conversation archive 冻结 payload 归一化（契约 §3：topics 为字符串数组）。 */
function normalizeArchivePayload(raw, { now }) {
  if (!raw || typeof raw !== 'object') return null;
  const topics = Array.isArray(raw.topics)
    ? raw.topics.map((topic) => text(topic && typeof topic === 'object' ? topic.text : topic, MAX_TOPIC_TEXT)).filter(Boolean).slice(0, MAX_TOPICS)
    : [];
  return {
    topics,
    summary: text(raw.summary, 200),
    lastActionAt: finite(raw.lastActionAt, 0),
    lastIncomingAt: finite(raw.lastIncomingAt, 0),
    lastInteractionAt: finite(raw.lastInteractionAt, 0),
    messageCount: clampInt(raw.messageCount, 0, Number.MAX_SAFE_INTEGER),
    archivedAt: finite(raw.archivedAt, now),
  };
}

function normalizeRelationshipArchive(raw, { now }) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const dedupeByUidGen = (list, max) => {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item !== 'object') continue;
      const uid = canonicalUid(item.uid) ?? String(item.uid ?? '');
      const generationId = String(item.generationId ?? '');
      if (!uid || !generationId) continue;
      if (seen.has(`${uid}|${generationId}`)) continue;
      seen.add(`${uid}|${generationId}`);
      out.push({ ...item, uid, generationId });
      if (out.length >= max) break;
    }
    return out;
  };
  const loopsOf = (item) => (Array.isArray(item.loops) ? item.loops.map((loop) => normalizeOpenLoop(loop, { now })).filter(Boolean).slice(0, MAX_OPEN_LOOPS) : []);
  const orphanLoops = dedupeByUidGen(source.orphanLoops, MAX_ORPHAN_LOOPS).map((item) => ({
    uid: item.uid,
    generationId: item.generationId,
    // 稳定键按 canonical uid+generationId 重建，不信任磁盘上的任意 archiveId（评审 P1）
    archiveId: 'loop-archive:' + item.uid + ':' + item.generationId,
    loops: loopsOf(item),
    at: finite(item.at, now),
  }));
  const pendingCold = dedupeByUidGen(source.pendingCold, MAX_PENDING_COLD).map((item) => ({
    uid: item.uid,
    generationId: item.generationId,
    archiveId: 'loop-archive:' + item.uid + ':' + item.generationId,
    loops: loopsOf(item),
    at: finite(item.at, now),
  }));
  const pendingEvict = dedupeByUidGen(source.pendingEvict, MAX_PENDING_EVICT).map((item) => ({
    uid: item.uid,
    generationId: item.generationId,
    archiveId: 'relationship-archive:' + item.uid + ':' + item.generationId,
    payload: item.payload && typeof item.payload === 'object' ? normalizeRelationshipArchivePayload(item.payload, { now }) : null,
    at: finite(item.at, now),
  })).filter((item) => item.payload);
  return { orphanLoops, pendingCold, pendingEvict };
}

function normalizePendingArchive(raw, { now }) {
  if (!raw || typeof raw !== 'object') return null;
  const key = canonicalV2Key(raw.key);
  if (!key) return null;
  const phase = PENDING_ARCHIVE_PHASES.includes(raw.phase) ? raw.phase : 'checkpoint';
  const payload = normalizeArchivePayload(raw.payload, { now });
  // 单槽 checkpoint 必须带冻结 payload；缺失 → 丢弃（评审 P2）
  if (!payload) return null;
  // generationId 缺失/空白时 archive 稳定 id 会退化为 archive:<key>: → 无法稳定恢复，丢弃（评审 R21/R22）
  const generationId = String(raw.generationId ?? '').trim().slice(0, 64);
  if (!generationId) return null;
  return {
    key,
    generationId,
    at: finite(raw.at, now),
    phase,
    payload,
  };
}

function normalizeMigration(raw, { version, now }) {
  const source = raw && typeof raw === 'object' ? raw : null;
  if (!source) {
    const from = version === 1 ? 1 : 2;
    return {
      version: V2_STATE_SCHEMA_VERSION,
      fromVersion: from,
      status: from === 1 ? 'pending' : 'done',
      revision: 0,
      startedAt: from === 1 ? now : 0,
      completedAt: from === 1 ? 0 : now,
      warnings: [],
      shadowToMainAt: null,
    };
  }
  return {
    version: V2_STATE_SCHEMA_VERSION,
    fromVersion: source.fromVersion === 1 ? 1 : 2,
    status: MIGRATION_STATUSES.includes(source.status) ? source.status : 'pending',
    revision: clampInt(source.revision, 0, Number.MAX_SAFE_INTEGER),
    startedAt: finite(source.startedAt, 0),
    completedAt: finite(source.completedAt, 0),
    warnings: Array.isArray(source.warnings) ? source.warnings.slice(0, 50).map(String) : [],
    shadowToMainAt: Number.isFinite(source.shadowToMainAt) ? source.shadowToMainAt : null,
  };
}

/**
 * 纯函数：解析 + 归一化 + plan（不写盘、不碰 memory）。
 * @returns {{version:number, runtime:object, plan:object, warnings:string[]}}
 */
export function normalizeSocialV2(raw, { now = Date.now(), tuning = null } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const version = source.version === V2_STATE_SCHEMA_VERSION ? 2 : 1;
  const warnings = [];
  const rawConversations = source.conversations && typeof source.conversations === 'object' ? source.conversations : {};
  const conversations = new Map();
  const rawByKey = new Map();
  const usedTokens = new Set();
  for (const [rawKey, val] of Object.entries(rawConversations)) {
    const key = canonicalV2Key(rawKey);
    if (!key) {
      warnings.push(`conversation key 非法: ${rawKey}`);
      continue;
    }
    const rawVal = val && typeof val === 'object' ? val : {};
    const st = hydrateConversationStateV2({ key, val: rawVal, cfg: undefined, random: () => 0.5, token: 'pending' });
    // transition 模式需要旧字段：保留原始引用（final serialize 不输出）
    st.legacyMood = rawVal.mood ?? null;
    st.legacyRelationships = rawVal.relationships ?? null;
    normalizeConversationV2(st, rawVal);
    // agentToken：优先保留原始；缺失/重复 → 确定性 fallback（保证唯一、可 round-trip）
    const rawToken = typeof rawVal.agentToken === 'string' ? rawVal.agentToken.trim() : '';
    const fallback = `tok-${crypto.createHash('sha256').update(`agent-token:${key}`).digest('hex').slice(0, 24)}`;
    st.agentToken = rawToken && !usedTokens.has(rawToken) ? rawToken : fallback;
    usedTokens.add(st.agentToken);
    const prevRaw = rawByKey.get(key) ?? null;
    if (prevRaw && conversations.has(key)) {
      // 同 canonical key 的重复原始会话：合并（seenForwardIds union、legacy 取较新、字段合并）
      const merged = mergeConversationV2(conversations.get(key), st, rawVal, prevRaw);
      merged.agentToken = conversations.get(key).agentToken || st.agentToken;
      conversations.set(key, merged);
      rawByKey.set(key, {
        ...prevRaw,
        ...rawVal,
        seenForwardIds: [...(prevRaw.seenForwardIds ?? []), ...(rawVal.seenForwardIds ?? [])],
      });
      warnings.push(`conversation key canonical 重复已合并: ${rawKey}`);
    } else {
      conversations.set(key, st);
      rawByKey.set(key, rawVal);
    }
  }
  const seenForwardIds = readSeenForwardIds(conversations, rawByKey);

  // agentMood：v2 直接归一化；v1 取最新 per-conversation mood 迁移
  let agentMood;
  if (version === 2 && source.agentMood) {
    agentMood = normalizeAgentMood(source.agentMood, { now, tuning });
  } else if (version === 1) {
    let latest = null;
    for (const [key] of conversations) {
      const legacy = rawByKey.get(key)?.mood ?? null;
      if (!legacy || typeof legacy !== 'object') continue;
      const since = finite(legacy.since, 0);
      if (!latest || since > latest.since) latest = { since, legacy };
    }
    agentMood = latest ? migrateMoodV1(latest.legacy, { now }).agentMood : createEmptyAgentMood({ now });
  } else {
    agentMood = normalizeAgentMood(source.agentMood, { now, tuning });
  }

  // relationships：v2 全局 + v1 分片合并
  const relationships = mergeLegacyRelationships(conversations, source.relationships, { now });
  const relationshipArchive = normalizeRelationshipArchive(source.relationshipArchive, { now });
  let pendingArchive = version === 2 ? normalizePendingArchive(source.pendingArchive, { now }) : null;
  const migration = normalizeMigration(source.migration, { version, now });

  const runtime = {
    version: V2_STATE_SCHEMA_VERSION,
    paused: !!source.paused,
    agentMood,
    relationships,
    relationshipArchive,
    conversations,
    seenForwardIds,
    pendingArchive,
    migration,
    saveStatus: 'normal',
    stateBytes: 0,
    degradedReasons: [],
  };

  // plan（纯）：迁移/裁剪/淘汰候选 + 迁移用的最新 legacy mood（主记录，避免多条迁移 episode）
  const lastInteractionAtOf = (key) => {
    const st = conversations.get(key) ?? {};
    return Math.max(
      finite(st.lastIncomingAt, 0),
      finite(st.lastActionAt, 0),
      ...(Array.isArray(st.recentMessages) ? st.recentMessages.map((m) => finite(m?.time, 0)) : [0]),
    );
  };
  const trimCandidates = [...conversations.keys()]
    .map((key) => ({ key, lastInteractionAt: lastInteractionAtOf(key) }))
    .sort((a, b) => (a.lastInteractionAt - b.lastInteractionAt) || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, conversations.size - MAX_CONVERSATIONS))
    .map((item) => item.key);
  const evictUids = Object.keys(relationships)
    .sort((a, b) => (relationships[a].lastInteraction - relationships[b].lastInteraction) || a.localeCompare(b))
    .slice(0, Math.max(0, Object.keys(relationships).length - MAX_RELATIONSHIPS));
  let legacyMoodSource = null;
  if (version === 1) {
    for (const [key] of conversations) {
      const legacy = rawByKey.get(key)?.mood ?? null;
      if (!legacy || typeof legacy !== 'object') continue;
      const since = finite(legacy.since, 0);
      if (!legacyMoodSource || since > legacyMoodSource.since) legacyMoodSource = { key, since, mood: legacy };
    }
  }
  const plan = {
    migrate: version === 1 || migration.status !== 'done',
    trimConversations: trimCandidates,
    archiveCandidates: trimCandidates,
    relationshipEvict: evictUids,
    legacyMoodSource,
    warnings: [...warnings],
  };
  return { version, runtime, plan, warnings };
}

/** 冻结迁移步骤 + 候选（normalize plan 与 steps 合并为单一 plan，archive 步因此拿得到候选）。 */
export function planSocialV2(runtime, normalizePlan = null) {
  const status = runtime.migration.status;
  const base = {
    status,
    trimConversations: normalizePlan?.trimConversations ?? [],
    relationshipEvict: normalizePlan?.relationshipEvict ?? [],
    legacyMoodSource: normalizePlan?.legacyMoodSource ?? null,
    warnings: normalizePlan?.warnings ?? [],
  };
  if (status === 'done' || status === 'failed') return { ...base, steps: [] };
  const steps = [];
  if (status === 'pending') steps.push({ status: 'mood-done', op: 'mood' });
  if (status === 'pending' || status === 'mood-done') steps.push({ status: 'relations-done', op: 'relations' });
  if (status === 'pending' || status === 'mood-done' || status === 'relations-done') {
    steps.push({ status: 'archive-done', op: 'archive' });
  }
  steps.push({ status: 'done', op: 'finalize' });
  return { ...base, steps };
}

function cloneRuntime(state) {
  return {
    ...state,
    agentMood: clone(state.agentMood),
    relationships: clone(state.relationships),
    relationshipArchive: clone(state.relationshipArchive),
    conversations: new Map([...state.conversations].map(([key, st]) => [key, { ...st }])),
    seenForwardIds: new Map([...state.seenForwardIds].map(([key, set]) => [key, new Set(set)])),
    pendingArchive: state.pendingArchive ? clone(state.pendingArchive) : null,
    migration: clone(state.migration),
  };
}

/**
 * @internal 仅供 applyStartupMigration 与测试使用；bridge 不得直接驱动 step（评审 R18）。
 * 执行一步迁移（复制状态，revision=old+1，不原地修改入参）。
 * @returns {{proposedState:object, serializedTransition:object|null, nextStatus:string, done:boolean, failed:boolean}}
 */
export function runMigrationStep(state, plan, { now = Date.now() } = {}) {
  const proposed = cloneRuntime(state);
  if (proposed.migration.status === 'failed') {
    // failed 是终态：不自动继续、不覆盖旧文件（评审 P1）
    return { proposedState: state, serializedTransition: null, nextStatus: 'failed', done: false, failed: true };
  }
  const frozen = Array.isArray(plan?.steps) ? plan.steps : planSocialV2(state).steps;
  const status = proposed.migration.status;
  const currentIndex = status === 'pending' ? -1 : frozen.findIndex((s) => s.status === status);
  const step = frozen[currentIndex + 1];
  if (!step) {
    proposed.migration.status = 'done';
    proposed.migration.completedAt = now;
    return {
      proposedState: proposed,
      serializedTransition: serializeSocialV2(proposed, { mode: 'final' }),
      nextStatus: 'done',
      done: true,
      failed: false,
    };
  }
  if (step.op === 'mood') {
    // 只迁移「最新」的那份旧 mood（主记录），其它会话保留原始 legacy（不产生多条迁移 episode）
    const source = plan?.legacyMoodSource ?? null;
    const legacy = source?.mood ?? null;
    if (legacy && typeof legacy === 'object') {
      try {
        const migrated = migrateMoodV1(legacy, { now }).agentMood;
        if (migrated.episodes.length) {
          proposed.agentMood.episodes = normalizeEpisodes([...proposed.agentMood.episodes, ...migrated.episodes], { now });
        }
        if (migrated.legacyAffect) proposed.agentMood.legacyAffect = migrated.legacyAffect;
      } catch { /* 单条脏数据不阻塞迁移 */ }
    }
    // transition 阶段保留原始 legacy 字段（final done 时才删除）
  } else if (step.op === 'relations') {
    for (const [key, st] of proposed.conversations) {
      const legacyRels = st.legacyRelationships;
      if (legacyRels && typeof legacyRels === 'object') {
        for (const [uid, entry] of Object.entries(legacyRels)) {
          const normalized = normalizeRelationshipEntry(entry, uid, { now });
          if (!normalized) continue;
          const current = proposed.relationships[normalized.uid];
          if (!current || normalized.lastInteraction >= current.lastInteraction) proposed.relationships[normalized.uid] = normalized;
        }
      }
    }
    // transition 阶段保留原始 legacy 字段（final done 时才删除）
  } else if (step.op === 'archive') {
    // 只准备冻结队列（archive-done = 队列已准备；memory 写入在 save/archive 执行层，§E）
    const nowTs = now;
    for (const key of plan?.trimConversations ?? []) {
      if (!proposed.conversations.has(key) || proposed.pendingArchive) continue;
      const st = proposed.conversations.get(key);
      proposed.pendingArchive = {
        key,
        generationId: `gen-${nowTs}-${key}`,
        at: nowTs,
        phase: 'checkpoint',
        payload: {
          lastActionAt: finite(st.lastActionAt, 0),
          lastIncomingAt: finite(st.lastIncomingAt, 0),
          lastInteractionAt: Math.max(finite(st.lastIncomingAt, 0), finite(st.lastActionAt, 0)),
          messageCount: Array.isArray(st.recentMessages) ? st.recentMessages.length : 0,
          topics: (Array.isArray(st.activeTopics) ? st.activeTopics : []).slice(0, 20),
          summary: '',
          archivedAt: nowTs,
        },
      };
    }
    for (const uid of plan?.relationshipEvict ?? []) {
      const rel = proposed.relationships[uid];
      if (!rel) continue;
      if (proposed.relationshipArchive.pendingEvict.length >= MAX_PENDING_EVICT) break;
      // generationId 来自关系记录（稳定），不能每次 archive 重新生成（评审 P1）
      const generationId = String(rel.generationId || `gen-${nowTs}-${uid}`).slice(0, 64);
      proposed.relationshipArchive.pendingEvict.push({
        uid,
        generationId,
        archiveId: `relationship-archive:${uid}:${generationId}`,
        payload: normalizeRelationshipArchivePayload({ ...rel, archivedAt: nowTs }, { now: nowTs }),
        at: nowTs,
      });
    }
  } else if (step.op === 'finalize') {
    for (const st of proposed.conversations.values()) {
      delete st.legacyMood;
      delete st.legacyRelationships;
    }
    proposed.migration.status = 'done';
    proposed.migration.completedAt = now;
  }
  proposed.migration.status = step.status;
  proposed.migration.revision = clampInt(proposed.migration.revision, 0, Number.MAX_SAFE_INTEGER) + 1;
  const mode = step.status === 'done' ? 'final' : 'transition';
  return {
    proposedState: proposed,
    serializedTransition: serializeSocialV2(proposed, { mode }),
    nextStatus: step.status,
    done: step.status === 'done',
    failed: false,
  };
}

/**
 * 启动迁移编排：循环 runMigrationStep + writeFile；**写成功才提交 proposedState**。
 * @returns {{state:object, done:boolean, failed:boolean, currentStatus:string, error:string|null}}
 */
export function applyStartupMigration(state, { now = Date.now(), writeFile, plan = null } = {}) {
  if (!plan || !Array.isArray(plan.steps)) {
    // 生产入口必须传 loadSocialV2State(...).plan：否则 >32/>50 候选会被静默丢弃（评审 P1）
    throw new Error('applyStartupMigration requires plan from loadSocialV2State (steps + trim/evict candidates)');
  }
  if (typeof writeFile !== 'function') {
    // 迁移完成必须与磁盘一致：不注入原子写函数时拒绝执行（评审新风险 2）
    throw new Error('applyStartupMigration requires writeFile (atomic write)');
  }
  let current = state;
  const frozen = { ...plan, steps: plan.steps.slice() }; // 冻结列表：全程同一份，按 index 推进
  let index = 0;
  if (current.migration.status === 'failed') {
    return { state: current, done: false, failed: true, currentStatus: 'failed', error: 'migration already failed' };
  }
  if (current.migration.status === 'done') {
    return { state: current, done: true, failed: false, currentStatus: 'done', error: null };
  }
  if (!frozen.steps.length) {
    return { state: current, done: false, failed: true, currentStatus: current.migration.status, error: 'plan has no steps but migration is not done' };
  }
  // 启动前校验：plan 必须以 done 结尾（防截断 plan 写到一半才发现；评审 P2）
  if (frozen.steps[frozen.steps.length - 1]?.status !== 'done') {
    return { state: current, done: false, failed: true, currentStatus: current.migration.status, error: 'plan must end with done' };
  }
  while (index < frozen.steps.length) {
    const stepMeta = frozen.steps[index];
    // 防 handcrafted plan 跳过迁移步骤：当前 status 派生的合法下一步必须等于 stepMeta（评审 P2）
    const expected = planSocialV2(current, frozen).steps[0]?.status ?? null;
    if (!expected || stepMeta.status !== expected) {
      return {
        state: current,
        done: false,
        failed: true,
        currentStatus: current.migration.status,
        error: `illegal migration step: expected ${expected ?? 'none'}, got ${stepMeta.status}`,
      };
    }
    // 每次只把当前步交给 driver（status 由 proposedState 推进）
    const step = runMigrationStep(current, { ...frozen, steps: [stepMeta] }, { now });
    if (step.failed) {
      return { state: current, done: false, failed: true, currentStatus: current.migration.status, error: 'migration step failed' };
    }
    if (step.nextStatus !== stepMeta.status) {
      return {
        state: current,
        done: false,
        failed: true,
        currentStatus: current.migration.status,
        error: `migration step mismatch: expected ${stepMeta.status}, got ${step.nextStatus}`,
      };
    }
    try {
      writeFile(step.serializedTransition);
    } catch (error) {
      return {
        state: current,
        done: false,
        failed: true,
        currentStatus: current.migration.status,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    current = step.proposedState;
    index += 1;
    if (step.done) break;
  }
  // 计划耗尽但迁移未完成：不得返回部分成功（评审 P2）
  if (current.migration.status !== 'done') {
    return { state: current, done: false, failed: true, currentStatus: current.migration.status, error: 'plan exhausted before done' };
  }
  return {
    state: current,
    done: true,
    failed: false,
    currentStatus: 'done',
    error: null,
  };
}

/** 组合入口：只 load/normalize/plan（plan 含迁移步骤 + 裁剪/淘汰候选），不执行迁移、不写盘。 */
export function loadSocialV2State(raw, { now = Date.now(), tuning = null } = {}) {
  const { runtime, plan: normalizePlan, warnings } = normalizeSocialV2(raw, { now, tuning });
  return { state: runtime, serializedForSave: null, plan: planSocialV2(runtime, normalizePlan), warnings };
}

function serializeConversationEntry(st, { mode, seenForwardIds, key, preservedLegacy }) {
  const entry = {
    wakeConfig: st.wakeConfig,
    recentMessages: (Array.isArray(st.recentMessages) ? st.recentMessages : []).slice(-MAX_RECENT_MESSAGES),
    unread: (Array.isArray(st.unread) ? st.unread : []).slice(-MAX_UNREAD),
    lastWakeReason: st.lastWakeReason ?? '',
    lastAiReplyAt: st.lastAiReplyAt ?? 0,
    lastActionAt: st.lastActionAt ?? 0,
    agentToken: st.agentToken,
    bootstrapSent: !!st.bootstrapSent,
    wakeTimes: (Array.isArray(st.wakeTimes) ? st.wakeTimes : []).slice(-MAX_WAKE_TIMES),
    sendTimes: (Array.isArray(st.sendTimes) ? st.sendTimes : []).slice(-MAX_SEND_TIMES),
    stickerCollectTimes: (Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes : []).slice(-MAX_STICKER_TIMES),
    lastIncomingAt: st.lastIncomingAt || 0,
    preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
    preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
    preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
    lastUnreadSeq: st.lastUnreadSeq || 0,
    lastReadThroughSeq: st.lastReadThroughSeq || 0,
    activeTopics: (Array.isArray(st.activeTopics) ? st.activeTopics : []).slice(-MAX_TOPICS),
    pendingThoughts: (Array.isArray(st.pendingThoughts) ? st.pendingThoughts : []).slice(-MAX_THOUGHTS),
    memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
    lastContextKey: st.lastContextKey ?? null,
    generationId: st.generationId ?? null,
    seenForwardIds: Array.from(seenForwardIds?.get?.(key) || []).slice(-SEEN_FORWARD_MAX),
  };
  // transition（迁移未完成）：保留旧字段——优先原始 legacy 引用（不被旧层归一化值替换）
  if (mode === 'transition') {
    const mood = st.legacyMood ?? preservedLegacy?.mood ?? (st.mood ? serializeMood(st.mood) : null);
    const rels = st.legacyRelationships ?? preservedLegacy?.relationships ?? (st.relationships ? serializeRelationships(st.relationships) : null);
    if (mood) entry.mood = mood;
    if (rels) entry.relationships = rels;
  }
  // shadow + v1 磁盘文件：旧字段原样保留（v2 main 文件的 legacy 为 null → 不写）
  if (mode === 'shadow') {
    const legacyMood = preservedLegacy?.mood ?? st.legacyMood ?? null;
    const legacyRels = preservedLegacy?.relationships ?? st.legacyRelationships ?? null;
    if (legacyMood) entry.mood = legacyMood;
    if (legacyRels) entry.relationships = legacyRels;
  }
  return entry;
}

/**
 * 三模式序列化。
 * @param {object} state RuntimeState
 * @param {{mode?:'final'|'transition'|'shadow', preservedV2Blocks?:object, seenForwardIds?:Map, preservedLegacyConversations?:object}} options
 */
export function serializeSocialV2(state, options = {}) {
  const mode = ['final', 'transition', 'shadow'].includes(options.mode) ? options.mode : 'final';
  // shadow 必须显式声明源文件 schema（评审 P1）：v2 main → shadow 必须带 preservedV2Blocks，
  // 否则 fail-closed（抛错），绝不静默输出缺 5 块/version=1 的文件。
  if (mode === 'shadow') {
    if (options.sourceSchema !== 'v1' && options.sourceSchema !== 'v2') {
      throw new Error('serializeSocialV2(shadow) requires sourceSchema: "v1" | "v2"');
    }
    if (options.sourceSchema === 'v2') {
      const blocks = options.preservedV2Blocks;
      if (!blocks || typeof blocks !== 'object') {
        throw new Error('serializeSocialV2(shadow, v2) requires preservedV2Blocks (fail-closed)');
      }
      // 五个旧块必须齐全且类型正确（pendingArchive 必须 null 或 object；其余必须是 object）
      for (const field of ['agentMood', 'relationships', 'relationshipArchive', 'pendingArchive', 'migration']) {
        if (!Object.prototype.hasOwnProperty.call(blocks, field)) {
          throw new Error(`serializeSocialV2(shadow, v2): missing preserved block "${field}" (fail-closed)`);
        }
        const value = blocks[field];
        if (field === 'pendingArchive') {
          if (!(value === null || (typeof value === 'object' && !Array.isArray(value)))) {
            throw new Error('serializeSocialV2(shadow, v2): "pendingArchive" must be an object or null (fail-closed)');
          }
        } else if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`serializeSocialV2(shadow, v2): "${field}" must be an object (fail-closed)`);
        }
      }
    }
  }
  const seenForwardIds = options.seenForwardIds instanceof Map ? options.seenForwardIds : state.seenForwardIds;
  const conversations = Object.create(null);
  for (const [key, st] of state.conversations) {
    const preservedLegacy = options.preservedLegacyConversations?.[key] ?? null;
    conversations[key] = serializeConversationEntry(st, { mode, seenForwardIds, key, preservedLegacy });
  }
  const base = {
    // shadow + 磁盘无 V2 块：保持 version=1（避免重启被误判「迁移已完成」；评审 P0）
    // shadow：源文件 v1 → version 1（无 V2 块）；源文件 v2 → version 2 + 透传旧块
    version: mode === 'shadow' && options.sourceSchema === 'v1' ? 1 : V2_STATE_SCHEMA_VERSION,
    paused: !!state.paused,
    agentMood: stripAgentMood(state.agentMood, mode),
    relationships: state.relationships,
    relationshipArchive: state.relationshipArchive,
    conversations,
    pendingArchive: state.pendingArchive,
    migration: state.migration,
  };
  if (mode === 'shadow') {
    // preserve-on-disk：v2 源文件透传已有 5 块（不更新，presence 已校验）；v1 源文件不含这 5 块。
    const V2_BLOCKS = ['agentMood', 'relationships', 'relationshipArchive', 'pendingArchive', 'migration'];
    if (options.sourceSchema === 'v2') {
      const preserved = options.preservedV2Blocks;
      for (const field of V2_BLOCKS) base[field] = preserved[field];
    } else {
      for (const field of V2_BLOCKS) delete base[field];
    }
  }
  return base;
}

function stripAgentMood(agentMood, mode) {
  if (!agentMood) return agentMood;
  const out = { ...agentMood };
  // final：显式删除 1A 兼容字段（normalize 不复活）
  if (mode === 'final') delete out.migrationVersion;
  return out;
}

/** 单位预算与整体字节检查（save 前调用；返回更新后的 saveStatus/degradedReasons/stateBytes）。 */
export function computeBudgets(state, { serialized } = {}) {
  const payload = serialized ?? serializeSocialV2(state, { mode: 'final' });
  const bytes = bytesOf(payload);
  const reasons = [];
  const moodBytes = bytesOf(state.agentMood ?? {});
  const relBytes = bytesOf(state.relationships ?? {});
  const archiveBytes = bytesOf(state.relationshipArchive ?? {});
  if (moodBytes > AGENT_MOOD_BUDGET_BYTES) reasons.push(`agentMood ${moodBytes}B > ${AGENT_MOOD_BUDGET_BYTES}B`);
  if (relBytes > RELATIONSHIPS_BUDGET_BYTES) reasons.push(`relationships ${relBytes}B > ${RELATIONSHIPS_BUDGET_BYTES}B`);
  if (archiveBytes > RELATIONSHIP_ARCHIVE_BUDGET_BYTES) reasons.push(`relationshipArchive ${archiveBytes}B > ${RELATIONSHIP_ARCHIVE_BUDGET_BYTES}B`);
  // 单会话预算（target 128KB / hard 192KB）
  let hardBreach = false;
  for (const [key, entry] of Object.entries(payload.conversations ?? {})) {
    const convBytes = bytesOf(entry);
    if (convBytes > CONVERSATION_HARD_BYTES) {
      hardBreach = true;
      reasons.push(`conversation ${key} ${convBytes}B > hard ${CONVERSATION_HARD_BYTES}B`);
    } else if (convBytes > CONVERSATION_TARGET_BYTES) {
      reasons.push(`conversation ${key} ${convBytes}B > target ${CONVERSATION_TARGET_BYTES}B`);
    }
  }
  const stateOut = { ...state, stateBytes: bytes, degradedReasons: reasons };
  if (bytes > GLOBAL_BUDGET_BYTES || hardBreach) stateOut.saveStatus = 'rejected';
  else if (reasons.length) stateOut.saveStatus = 'degraded';
  else stateOut.saveStatus = 'normal';
  return stateOut;
}
