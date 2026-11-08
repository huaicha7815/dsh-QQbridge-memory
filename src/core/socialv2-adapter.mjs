// 情绪系统 V2 —— 1B bridge adapter（唯一契约：ADDENDUM-1B-internals v2.24 §I）
//
// 职责：给 bridge 的旧 API 面（getMood/applyEmotionEvent/getRelationship/applyRelationshipEvent）
// 提供 V2 实现：返回兼容视图、只写 V2（禁止同时写旧 per-conversation mood/relationships）。
//
// 提交模型（R26 定死）：persist(candidateState) 成功后才 setState 提交；
// 任何持久化失败 → live state 与调用前完全一致（不得留幽灵状态）。

import { deriveAttachmentStyle } from './mood-v2.mjs';
import { applyFactPipeline } from './socialv2-exec.mjs';
import { synthesizeMood } from './mood-v2.mjs';
import { RELATIONSHIP_EVENTS, canonicalUid } from './mood.mjs';

const DEFAULT_BASELINE = Object.freeze({ valence: 0, arousal: 0.3, energy: 0.6, dominance: 0.5 });
const DEFAULT_ATTACHMENT = 'secure';

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 关系 uid 归一化：复用旧层 canonicalUid（'007' → '7'；非法 → null）。 */
export function canonicalRelationshipUid(uid) {
  return canonicalUid(uid);
}

function contextFromKey(key) {
  const text = String(key ?? '');
  if (text.startsWith('private:')) {
    return { mode: 'private', activeUid: text.slice('private:'.length), key: text };
  }
  if (text.startsWith('group:')) return { mode: 'group', key: text };
  return { mode: 'private', activeUid: null, key: text };
}

function emptyRelationship(uid) {
  return {
    uid,
    generationId: null,
    intimacy: 0,
    tension: 0,
    trust: 0.5,
    resentment: 0,
    attachmentStyle: DEFAULT_ATTACHMENT,
    lastInteraction: 0,
    lastContextKey: null,
    openLoops: [],
    events: [],
  };
}

/** 旧形状只读视图（bridge/控制台兼容）。 */
function relationshipView(rel, uid) {
  if (!rel) return { ...emptyRelationship(uid), known: false };
  return {
    uid,
    known: true,
    intimacy: clamp01(rel.intimacy),
    tension: clamp01(rel.tension),
    trust: clamp01(rel.trust),
    resentment: clamp01(rel.resentment),
    attachmentStyle: rel.attachmentStyle ?? DEFAULT_ATTACHMENT,
    lastInteraction: Number(rel.lastInteraction) || 0,
    lastContextKey: rel.lastContextKey ?? null,
    openLoops: Array.isArray(rel.openLoops) ? rel.openLoops : [],
    events: Array.isArray(rel.events) ? rel.events : [],
    generationId: rel.generationId ?? null,
  };
}

/**
 * @param {object} opts
 * @param {function} opts.getState () => RuntimeState
 * @param {function} opts.setState (state) => void
 * @param {function} [opts.save] (candidateState) => void（持久化候选状态；抛错=提交失败）
 * @param {object} [opts.memory] memoryStore（fact 两写）
 * @param {function} [opts.now]
 */
export function createSocialV2Adapter({ getState, setState, save = () => {}, memory = null, now = () => Date.now(), getTuning = null } = {}) {
  if (typeof getState !== 'function' || typeof setState !== 'function') {
    throw new Error('createSocialV2Adapter requires getState/setState');
  }
  // 关系事件 factId 去重账本（有界 LRU：Map 命中时 delete+set 刷新顺序；events 只存 8 条不可依赖）
  const seenRelationFacts = new Map();
  const MAX_SEEN_RELATION_FACTS = 512;
  function hasRelationFact(factId) {
    if (!seenRelationFacts.has(factId)) return false;
    // 访问型 LRU：duplicate 命中也要刷新保活顺序
    const ts = seenRelationFacts.get(factId);
    seenRelationFacts.delete(factId);
    seenRelationFacts.set(factId, ts);
    return true;
  }
  function rememberRelationFact(factId) {
    if (!factId) return;
    seenRelationFacts.delete(factId);
    seenRelationFacts.set(factId, Date.now());
    while (seenRelationFacts.size > MAX_SEEN_RELATION_FACTS) {
      const oldest = seenRelationFacts.keys().next().value;
      seenRelationFacts.delete(oldest);
    }
  }
  /** 提交候选状态：先持久化，成功后才 setState（R26）。 */
  function commit(candidate, previous) {
    try {
      save(candidate);
    } catch {
      return false;
    }
    setState(candidate);
    return true;
  }
  function getMood(key) {
    const state = getState();
    const mood = state?.agentMood ?? {};
    const context = contextFromKey(key);
    const tuning = typeof getTuning === 'function' ? getTuning() : null;
    const view = synthesizeMood({
      episodes: Array.isArray(mood.episodes) ? mood.episodes : [],
      context: { ...context, now: now() },
      baseline: mood.baseline ?? null,
      legacyAffect: mood.legacyAffect ?? null,
      tuning,
    });
    return {
      key: String(key ?? ''),
      valid: true,
      known: (mood.episodes?.length ?? 0) > 0,
      valence: view.valence,
      arousal: view.arousal,
      energy: view.energy,
      dominance: view.dominance,
      label: view.label,
      slowValence: view.slowValence,
      chronicLoad: Number(getState()?.agentMood?.chronicLoad) || 0,
      dominant: view.dominant,
      mix: view.mix,
      conflict: view.conflict,
      reasons: view.reasons,
      episodeCount: view.episodeCount,
      legacy: view.legacy,
      raw: { valence: view.valence, arousal: view.arousal, energy: view.energy },
    };
  }
  function applyEmotionEvent(key, event = {}) {
    const state = getState();
    if (state?.paused) return { ok: false, reason: 'paused', key: String(key ?? '') };
    const at = Number.isFinite(event?.at) ? event.at : now();
    const pipeline = applyFactPipeline({
      state,
      memory,
      now: now(),
      tuning: typeof getTuning === 'function' ? getTuning() : null,
      event: {
        ...event,
        at,
        contextKey: String(key ?? event?.key ?? ''),
        eventType: event?.eventType ?? event?.type ?? null,
      },
      // §D：checkpoint 必须先落盘；成功后 live 即持有该 checkpoint（final save 失败时不得回退覆盖恢复点）
      writeCheckpoint: (checkpointState) => {
        save(checkpointState);
        setState(checkpointState);
      },
    });
    if (pipeline.code === 'checkpoint-failed') {
      return { ok: false, reason: 'checkpoint-failed', key: String(key ?? ''), eventId: pipeline.eventId };
    }
    if (pipeline.state !== state) {
      try {
        save(pipeline.state);
      } catch {
        // checkpoint 已提交（pipeline 在 memory/mood 失败时返回 checkpointState）→ 保留可重放状态
        return { ok: false, reason: 'save-failed', key: String(key ?? ''), eventId: pipeline.eventId };
      }
      setState(pipeline.state);
    }
    const degraded = pipeline.code === 'memory-disabled' ? 'memory-disabled' : null;
    return {
      ok: pipeline.code === 'ok' || pipeline.code === 'memory-disabled',
      reason: pipeline.code,
      degraded,
      key: String(key ?? ''),
      eventId: pipeline.eventId,
      type: event?.eventType ?? event?.type ?? null,
      at,
      mood: getMood(key),
    };
  }
  function getRelationship(uidRaw) {
    const uid = canonicalRelationshipUid(uidRaw);
    if (!uid) return { ...emptyRelationship(String(uidRaw ?? '')), known: false, valid: false };
    const state = getState();
    return { ...relationshipView(state?.relationships?.[uid], uid), valid: true };
  }
  function applyRelationshipEvent(uidRaw, type, extra = {}) {
    const uid = canonicalRelationshipUid(uidRaw);
    if (!uid) return { ok: false, reason: 'invalid_uid', uid: String(uidRaw ?? '') };
    const def = RELATIONSHIP_EVENTS[type];
    if (!def) return { ok: false, reason: 'unknown_event_type', uid, type };
    const state = getState();
    if (state?.paused) return { ok: false, reason: 'paused', uid, type };
    const t = now();
    const rel = { ...emptyRelationship(uid), ...(state.relationships?.[uid] ?? {}) };
    rel.uid = uid;
    // 稳定 factId 幂等：同一消息的 relationship side effect 只应用一次（R36/R37：ledger + events 双查）
    if (extra.factId && (hasRelationFact(extra.factId) || (rel.events ?? []).some((event) => event.factId === extra.factId))) {
      return { ok: true, uid, type, skipped: 'duplicate' };
    }
    // closeLoop 必须先命中 loop；未命中不应用 delta、不写 event（R25）
    if (type === 'closeLoop') {
      const loops = Array.isArray(rel.openLoops) ? rel.openLoops : [];
      const hit = extra.loopId ? loops.some((loop) => String(loop?.id) === String(extra.loopId) && !loop?.closedAt) : false;
      if (!hit) return { ok: false, reason: 'loop_not_found', uid, type, loopId: extra.loopId ?? null };
    }
    rel.intimacy = clamp01(rel.intimacy + (Number(def.intimacy) || 0));
    rel.tension = clamp01(rel.tension + (Number(def.tension) || 0));
    // 阶段 3：负性关系事件累积 resentment（avoidant 依恋可达）
    rel.resentment = clamp01((Number(rel.resentment) || 0) + (Number(def.resentment) || 0));
    rel.lastInteraction = t;
    if (typeof extra.contextKey === 'string' && extra.contextKey) rel.lastContextKey = extra.contextKey;
    const eventRecord = { at: t, type, factId: extra.factId ?? null };
    rel.events = [...(Array.isArray(rel.events) ? rel.events : []), eventRecord].slice(-8);
    if (type === 'openLoop' && extra.loop && typeof extra.loop === 'object') {
      const loop = {
        id: String(extra.loop.id ?? `loop-${t}`).slice(0, 64),
        text: String(extra.loop.text ?? '').slice(0, 120),
        openedAt: Number(extra.loop.openedAt) || t,
      };
      rel.openLoops = [...(Array.isArray(rel.openLoops) ? rel.openLoops : []), loop].slice(-8);
    } else if (type === 'closeLoop') {
      rel.openLoops = (Array.isArray(rel.openLoops) ? rel.openLoops : [])
        .map((loop) => (String(loop?.id) === String(extra.loopId) ? { ...loop, closedAt: t } : loop));
    }
    // 阶段 3：依恋慢参数由关系慢变量确定性映射（每事件重算）
    rel.attachmentStyle = deriveAttachmentStyle({ intimacy: rel.intimacy, tension: rel.tension, resentment: rel.resentment });
    const next = { ...state, relationships: { ...(state.relationships ?? {}), [uid]: rel } };
    // 先持久化候选，成功后才提交 live state（save 抛错 → 不 setState、不记 ledger）
    if (!commit(next, state)) return { ok: false, reason: 'save-failed', uid, type };
    rememberRelationFact(extra.factId);
    return { ok: true, uid, type, at: t, relationship: relationshipView(rel, uid) };
  }
  return { getMood, applyEmotionEvent, getRelationship, applyRelationshipEvent };
}
