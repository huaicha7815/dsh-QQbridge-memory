// 情绪系统 V2 —— 1B 执行层（唯一契约：ADDENDUM-1B-internals v2.24 §D/§E/§F/§G/§H）
//
// 分层：
//   socialv2-state.mjs  纯 normalize/plan/serialize（已冻结）
//   socialv2-exec.mjs   执行层：factId 两写、archive 管线、gate/save 流水线、reset service、flags
//
// 原则（R25 定死）：
//   - 所有 IO 通过注入（memory/readFile/writeFile/writeCheckpoint），本模块不直接碰 fs；
//   - checkpoint 必须先落盘（writeCheckpoint）才写 memory；checkpoint 失败不得写 memory；
//   - memory 写入幂等（appendEventWithId duplicate 即成功）；完整 memory entry 冻结进 pending.payload.entry；
//   - archive 以冻结 entry 调 append（duplicate/conflict 决策）；gate 拒写时内存回滚、payload 不丢。

import { createHash } from 'node:crypto';
import {
  AGENT_MOOD_BUDGET_BYTES,
  CONVERSATION_HARD_BYTES,
  GLOBAL_BUDGET_BYTES,
  HOT_RELATIONSHIPS,
  MAX_ORPHAN_LOOPS,
  MAX_PENDING_COLD,
  RELATIONSHIPS_BUDGET_BYTES,
  RELATIONSHIP_ARCHIVE_BUDGET_BYTES,
  CONVERSATION_TARGET_BYTES,
  MAX_CONVERSATIONS,
  MAX_PENDING_EVICT,
  MAX_RELATIONSHIPS,
  PENDING_ARCHIVE_PHASES,
  applyStartupMigration,
  computeBudgets,
  loadSocialV2State,
  normalizeRelationshipArchivePayload,
  planSocialV2,
  serializeSocialV2,
} from './socialv2-state.mjs';
import { EMOTION_KINDS, appendSensitivityLog, resolveSensitivityConfig, applyCandidates, appraiseEvent, computeSensitizationFromLog, createEmptyAgentMood, decayNeedTensions, decaySensitivityValues, synthesizeMood, switchDominant, updateChronicLoad, updateNeedTensions } from './mood-v2.mjs';
import { canonicalUid } from './mood.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// 1. flags（§G 12 组合 truth table，非法组合 fail-closed）
// ─────────────────────────────────────────────────────────────────────────────

export const V2_MODES = Object.freeze(['legacy', 'shadow', 'main']);

function flagResult(enabled, shadow, writeSchema, ok, failClosed, error) {
  const combo = (enabled ? 1 : 0) + '/' + (shadow ? 1 : 0) + '/' + (writeSchema === null ? 'null' : writeSchema);
  return { ok, mode: ok ? (enabled ? (shadow ? 'shadow' : 'main') : 'legacy') : (enabled ? (shadow ? 'shadow' : 'main') : 'legacy'), enabled, shadow, writeSchema, failClosed, error, combo };
}

/**
 * 解析 emotion.v2.* 配置（非法值 fail-closed）。
 * @returns {{ok:boolean, mode:'legacy'|'shadow'|'main', enabled:boolean, shadow:boolean,
 *            writeSchema:'v1'|'v2'|null, failClosed:boolean, error:string|null, combo:string}}
 */
export function resolveV2Flags(config = {}) {
  const v2 = (config && config.emotion && config.emotion.v2) || {};
  const enabled = v2.enabled === true;
  const shadow = v2.shadow !== false; // 默认 true
  const rawSchema = v2.writeSchema;
  if (rawSchema !== undefined && rawSchema !== null && rawSchema !== 'v1' && rawSchema !== 'v2') {
    return flagResult(enabled, shadow, null, false, true, 'emotion.v2.writeSchema 非法（只允许 v1/v2/null）');
  }
  const writeSchema = rawSchema === 'v1' || rawSchema === 'v2' ? rawSchema : null;
  if (!enabled) {
    if (writeSchema === 'v2') return flagResult(enabled, shadow, writeSchema, false, true, 'emotion.v2.enabled=false 时 writeSchema 不得为 v2');
    return flagResult(enabled, shadow, writeSchema, true, false, null);
  }
  if (shadow) {
    if (writeSchema === 'v2') return flagResult(enabled, shadow, writeSchema, false, true, 'shadow 模式 writeSchema 不得为 v2');
    return flagResult(enabled, shadow, writeSchema, true, false, null);
  }
  if (writeSchema !== 'v2') return flagResult(enabled, shadow, writeSchema, false, true, 'main 模式必须 writeSchema=v2');
  return flagResult(enabled, shadow, writeSchema, true, false, null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1.1 预算判定（§F 纯接口，1C 接线前可独立测试）
// ─────────────────────────────────────────────────────────────────────────────

/** agentMood 序列化字节数（用于拒新增判定）。失败 → Infinity（fail-closed）。 */
export function agentMoodBytes(state) {
  try {
    return Buffer.byteLength(JSON.stringify(state?.agentMood ?? {}), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** 各预算单位的 UTF-8 JSON 字节数（结构化；complete=false 时 total/conversation 不可消费）。 */
/** 严格 plain object：prototype 必须是 Object.prototype 或 null。 */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function unitBytes(state, serialized = null) {
  const measurementFailed = [];
  const bytesOf = (value, unit) => {
    try {
      return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
    } catch {
      measurementFailed.push(unit);
      return Number.POSITIVE_INFINITY;
    }
  };
  const agentMood = agentMoodBytes(state);
  if (!Number.isFinite(agentMood)) measurementFailed.push('agentMood');
  const relationships = bytesOf(state?.relationships ?? {}, 'relationships');
  const relationshipArchive = bytesOf(state?.relationshipArchive ?? {}, 'relationshipArchive');
  let conversationMax = 0;
  let total = Number.NaN;
  let totalKnown = false;
  if (serialized && typeof serialized === 'object' && serialized.conversations && typeof serialized.conversations === 'object') {
    for (const conv of Object.values(serialized.conversations)) {
      conversationMax = Math.max(conversationMax, bytesOf(conv, 'conversation'));
    }
    total = bytesOf(serialized, 'total');
    totalKnown = Number.isFinite(total);
  }
  const complete = totalKnown && measurementFailed.length === 0;
  return { agentMood, relationships, relationshipArchive, conversationMax, total, totalKnown, complete, measurementFailed };
}

/**
 * 纯预算判定（§F）。
 * - scope='save'（默认）：save-scope 必须传 serialized，否则 `complete:false`（禁止消费 total/conversation 决策）；
 * - scope='event'：只判定 agentMood/relationships/relationshipArchive（事件入口用，不需要 conversations/total）。
 * decision 只读结构化单位，禁止从 degradedReasons 文本推断。
 */
export function evaluateBudgetGate({ state, serialized = null, scope = 'save' } = {}) {
  if (scope !== 'save' && scope !== 'event') {
    throw new Error('evaluateBudgetGate: scope 必须是 save/event');
  }
  if (scope === 'save') {
    // fail-closed：save-scope 必须有完整 serializer 输出（plain object，Map/Date/类实例一律拒绝）
    if (!isPlainObject(serialized) || !isPlainObject(serialized.conversations)) {
      throw new Error('budget-scope-incomplete: save-scope requires plain-object serialized.conversations');
    }
  }
  const bytes = unitBytes(state, serialized);
  const overUnits = [];
  if (bytes.agentMood > AGENT_MOOD_BUDGET_BYTES) overUnits.push('agentMood');
  if (bytes.relationships > RELATIONSHIPS_BUDGET_BYTES) overUnits.push('relationships');
  if (bytes.relationshipArchive > RELATIONSHIP_ARCHIVE_BUDGET_BYTES) overUnits.push('relationshipArchive');
  const conversationHardReject = bytes.conversationMax > CONVERSATION_HARD_BYTES;
  const conversationTrim = !conversationHardReject && bytes.conversationMax > CONVERSATION_TARGET_BYTES;
  if (conversationHardReject) overUnits.push('conversationHard');
  else if (conversationTrim) overUnits.push('conversation');
  const globalReject = bytes.totalKnown && bytes.total > GLOBAL_BUDGET_BYTES;
  if (globalReject) overUnits.push('total');
  const decisions = {
    rejectNewEmotionFacts: overUnits.includes('agentMood'),
    relationshipColdFirst: overUnits.includes('relationships'),
    archiveRejectNew: overUnits.includes('relationshipArchive'),
    conversationTrim,
    conversationHardReject,
    globalReject,
  };
  const complete = scope === 'event'
    ? bytes.measurementFailed.length === 0
    : (bytes.complete && bytes.totalKnown);
  const saveStatus = (globalReject || conversationHardReject) ? 'rejected' : (overUnits.length > 0 ? 'degraded' : 'normal');
  return {
    saveStatus,
    scope,
    complete,
    stateBytes: bytes.totalKnown ? bytes.total : 0,
    unitBytes: bytes,
    overUnits,
    decisions,
    measurementFailed: bytes.measurementFailed,
  };
}

/** 固定动作/错误码映射（1C 用；不得从文本推断）。 */
const BUDGET_ACTIONS = Object.freeze({
  agentMood: Object.freeze({ code: 'mood-budget-full', action: 'reject-new-facts' }),
  relationships: Object.freeze({ code: 'relationship-budget-full', action: 'cold-first' }),
  relationshipArchive: Object.freeze({ code: 'archive-budget-full', action: 'reject-new-archive' }),
  conversation: Object.freeze({ code: 'conversation-trim', action: 'trim-conversation' }),
  conversationHard: Object.freeze({ code: 'save-rejected', action: 'reject-save' }),
  total: Object.freeze({ code: 'save-rejected', action: 'reject-save' }),
});

/** 全部超限动作（1C 必须消费全部 overUnits，不得只处理首个）。 */
export function budgetActionsFor(gate) {
  const overUnits = Array.isArray(gate?.overUnits) ? gate.overUnits : [];
  const actions = overUnits.map((unit) => ({ unit, ...(BUDGET_ACTIONS[unit] ?? { code: 'save-rejected', action: 'reject-save' }) }));
  for (const item of actions) {
    item.fatal = item.code === 'save-rejected';
  }
  // fatal（save-rejected）置顶：稳定排序，1C 必须在任何 cold/archive/trim 副作用前先看它
  actions.sort((a, b) => (Number(a.fatal ? 0 : 1) - Number(b.fatal ? 0 : 1)));
  const fatal = actions.some((item) => item.fatal);
  return {
    actions,
    errors: actions.map((item) => ({ code: item.code, unit: item.unit, fatal: item.fatal })),
    overUnits,
    fatal,
    shortCircuit: fatal ? 'save-rejected' : null,
  };
}

/** 单一错误选择器（兼容）：优先 save-rejected，否则首个动作。 */
export function budgetErrorFor(gate) {
  const { actions } = budgetActionsFor(gate);
  const fatal = actions.find((item) => item.code === 'save-rejected');
  const chosen = fatal ?? actions[0] ?? null;
  return { code: chosen?.code ?? null, unit: chosen?.unit ?? null, overUnits: Array.isArray(gate?.overUnits) ? gate.overUnits : [] };
}

/** 关系压力纯函数（§3.1）：HOT / cold 候选 / 三类队列是否已满（1C 冷化接线用）。 */
export function rankRelationshipPressure(state, { hotLimit = HOT_RELATIONSHIPS } = {}) {
  // 只允许契约内 business enum：normal 10 / degraded 15（20 有超预算历史，不得接受）
  if (hotLimit !== 10 && hotLimit !== 15) {
    throw new Error('rankRelationshipPressure: hotLimit 只允许 10（normal）或 15（degraded）');
  }
  const limit = hotLimit;
  const rels = state?.relationships ?? {};
  const entries = Object.entries(rels)
    .map(([uid, rel]) => ({ uid, lastInteraction: Number(rel?.lastInteraction) || 0 }))
    .sort((a, b) => (a.lastInteraction - b.lastInteraction) || String(a.uid).localeCompare(String(b.uid)));
  const byRecencyDesc = entries.slice().sort((a, b) => (b.lastInteraction - a.lastInteraction) || String(a.uid).localeCompare(String(b.uid)));
  const hot = new Set(byRecencyDesc.slice(0, limit).map((entry) => entry.uid));
  const coldCandidates = entries.filter((entry) => !hot.has(entry.uid)).map((entry) => entry.uid);
  const archive = state?.relationshipArchive ?? {};
  return {
    hotLimit: limit,
    total: entries.length,
    hot: [...hot],
    coldCandidates,
    orphanFull: (archive.orphanLoops?.length ?? 0) >= MAX_ORPHAN_LOOPS,
    pendingColdFull: (archive.pendingCold?.length ?? 0) >= MAX_PENDING_COLD,
    pendingEvictFull: (archive.pendingEvict?.length ?? 0) >= MAX_PENDING_EVICT,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. contentHash / factId（§C）
// ─────────────────────────────────────────────────────────────────────────────

function strOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function canonicalActorUid(value) {
  const text = strOrNull(value);
  if (!text) return null;
  return canonicalUid(text) ?? text;
}

/** §C contentHash：fields=[messageId, actorUid, target.kind, target.uid, contextKey, eventType, at, quote]。 */
export function contentHashForEvent(raw = {}) {
  const target = raw.target && typeof raw.target === 'object' ? raw.target : {};
  const fields = [
    strOrNull(raw.messageId),
    canonicalActorUid(raw.actorUid),
    strOrNull(target.kind),
    canonicalActorUid(target.uid),
    strOrNull(raw.contextKey),
    strOrNull(raw.eventType),
    Number.isFinite(raw.at) ? raw.at : null,
    strOrNull(raw.quote),
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/** 稳定 factId：at + 随机/事件内容 → sha256 截断（测试可注入 random 保证确定性）。 */
export function createFactId({ at = Date.now(), random = null } = {}) {
  const seed = random ?? `${process.pid}:${Math.random()}:${at}`;
  return `fact:${createHash('sha256').update(`${at}:${seed}`).digest('hex').slice(0, 32)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. factId 两写（§D：checkpoint → memory → mood → 清 checkpoint）
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_PENDING_FACTS = 20;
export const MAX_UNRESOLVED_FACTS = 20;
// attempts（已失败次数）1..4 对应的下次重试间隔；首次失败立即设置 30s
export const FACT_RETRY_DELAYS_MS = Object.freeze([30 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 30 * 60 * 1000]);

function contextFromKey(key) {
  const text = String(key ?? '');
  if (text.startsWith('private:')) return { mode: 'private', activeUid: text.slice('private:'.length), key: text };
  if (text.startsWith('group:')) return { mode: 'group', key: text };
  return { mode: 'private', activeUid: null, key: text };
}

/** 1A 纪律：applyCandidates → switchDominant（episodes 由 applied 提供，switch 返回 dominant 等字段）。 */
function applyMoodCandidates(agentMood, candidates, context, now, tuning = null, eventIds = null) {
  const applied = applyCandidates(agentMood.episodes ?? [], candidates, {
    now,
    activeUid: context.activeUid,
    dominantKind: agentMood.dominant?.kind ?? null,
  });
  const switched = switchDominant({
    agentMood,
    episodes: applied.episodes,
    context: { mode: context.mode, activeUid: context.activeUid },
    now,
    tuning,
  });
  // 阶段 3：敏感化（窗口独立计数）与慢性负荷（低通 + 修复）随事件更新
  let sensitivity = agentMood.sensitivity ?? {};
  let sensitivityLog = agentMood.sensitivityLog ?? [];
  let chronicLoad = agentMood.chronicLoad ?? 0;
  let chronicLoadUpdatedAt = agentMood.chronicLoadUpdatedAt ?? 0;
  let needs = agentMood.needs ?? {};
  try {
    // 敏感化窗口按「本次事件候选」计数（同 kind/target 的 episode 融合不会吞掉重复次数）
    const negativeEvents = (Array.isArray(candidates) ? candidates : [])
      .filter((cand) => cand && ((EMOTION_KINDS[cand.kind]?.valence ?? 0) < 0))
      .map((cand) => ({ kind: cand.kind, peak: cand.intensity, decayAnchorAt: Number.isFinite(cand?.at) ? cand.at : (Number.isFinite(eventIds?.at) ? eventIds.at : now), eventId: eventIds?.eventId ?? null, contentHash: eventIds?.contentHash ?? null }));
    sensitivityLog = appendSensitivityLog(sensitivityLog, negativeEvents, { now, windowMs: resolveSensitivityConfig(tuning).windowMs });
    sensitivity = computeSensitizationFromLog(sensitivityLog, now, tuning);
    // 需求张力无重复重算（纯函数、幂等）
    needs = updateNeedTensions({ needs, episodes: applied.episodes, now, tuning });
    const fastValence = synthesizeMood({ episodes: applied.episodes, context: { mode: context.mode, activeUid: context.activeUid, now }, tuning }).valence;
    chronicLoad = updateChronicLoad({ chronicLoad, valence: fastValence, lastUpdatedAt: chronicLoadUpdatedAt, now, tuning });
    chronicLoadUpdatedAt = now;
  } catch { /* 阶段 3 新能力失败不阻塞主流程 */ }
  return {
    ...agentMood,
    episodes: applied.episodes,
    dominant: switched.dominant ?? null,
    lastSwitchAt: switched.lastSwitchAt ?? agentMood.lastSwitchAt,
    switchesThisTurn: switched.switchesThisTurn ?? agentMood.switchesThisTurn,
    reverseSuppressUntil: switched.reverseSuppressUntil ?? agentMood.reverseSuppressUntil,
    turnKey: switched.turnKey ?? agentMood.turnKey ?? null,
    sensitivity,
    sensitivityLog,
    needs,
    chronicLoad,
    chronicLoadUpdatedAt,
  };
}

function trimFacts(list, max) {
  const arr = Array.isArray(list) ? list.slice() : [];
  return arr.length > max ? arr.slice(-max) : arr;
}

function toUnresolved(pending, now, code) {
  return {
    eventId: pending.eventId ?? null,
    contentHash: pending.contentHash ?? null,
    at: pending.payload?.at ?? now,
    missingSide: pending.missingSide ?? 'both',
    evidenceQuote: String(pending.payload?.event?.quote ?? pending.payload?.event?.text ?? '').slice(0, 40),
    lastErrorCode: code,
    attempts: Number(pending.attempts) || 0,
    status: 'unresolved',
  };
}

/** pending 上限：第 21 条把最旧 pending 移入 unresolved（不得静默删除）。 */
function pushPending(mood, pending) {
  const list = [...(mood.pendingFacts ?? []), pending];
  const overflow = list.length > MAX_PENDING_FACTS ? list.splice(0, list.length - MAX_PENDING_FACTS) : [];
  mood.pendingFacts = list;
  if (overflow.length > 0) {
    mood.unresolvedFacts = trimFacts([...(mood.unresolvedFacts ?? []), ...overflow.map((item) => toUnresolved(item, pending.payload?.at ?? Date.now(), 'pending_overflow'))], MAX_UNRESOLVED_FACTS);
  }
}

function nextRetryAt(attempt, now) {
  const delay = FACT_RETRY_DELAYS_MS[Math.min(Math.max(attempt, 1) - 1, FACT_RETRY_DELAYS_MS.length - 1)];
  return now + delay;
}

/**
 * 处理一条情绪事实：checkpoint 落盘 → memory → mood → 清 checkpoint。
 * 不改入参；checkpoint/memory/mood 失败保留可恢复 checkpoint。
 * @param {object} opts
 * @param {object} opts.state
 * @param {object} opts.event
 * @param {object} opts.memory memoryStore
 * @param {number} [opts.now]
 * @param {function} [opts.writeCheckpoint] (checkpointState) => void（原子写；生产必须提供，测试可传 spy）
 * @returns {{state:object, code:'ok'|'paused'|'memory-disabled'|'checkpoint-failed'|'memory-failed'|'mood-failed', eventId:string}}
 */
export function applyFactPipeline({ state, event, memory, now = Date.now(), writeCheckpoint = null, tuning = null }) {
  if (!state || typeof state !== 'object') throw new Error('applyFactPipeline requires state');
  if (!event || typeof event !== 'object') throw new Error('applyFactPipeline requires event');
  const rawEventId = String(event.eventId ?? '').trim();
  const eventId = rawEventId || createFactId({ at: event.at ?? now });
  if (state.paused) return { state, code: 'paused', eventId };
  const contextKey = String(event.contextKey ?? event.key ?? '');
  const context = contextFromKey(contextKey);
  const at = Number.isFinite(event.at) ? event.at : now; // at 首次冻结，重试不重算（§C）
  const contentHash = typeof event.contentHash === 'string' && event.contentHash
    ? event.contentHash
    : contentHashForEvent({
      messageId: event.messageId ?? null,
      actorUid: event.actorUid ?? context.activeUid ?? null,
      target: event.target ?? { kind: 'other', uid: null },
      contextKey,
      eventType: event.eventType ?? event.type ?? null,
      at,
      quote: event.quote ?? event.text ?? null,
    });
  const contextForAppraise = {
    mode: context.mode,
    activeUid: context.activeUid,
    // 阶段 3：appraisal 前按事件时间重算（log 精确重算；无 log 状态回退聚合衰减）
    needTension: decayNeedTensions(state.agentMood?.needs ?? {}, at, tuning),
    sensitivity: (Array.isArray(state.agentMood?.sensitivityLog) && state.agentMood.sensitivityLog.length > 0)
      ? computeSensitizationFromLog(state.agentMood.sensitivityLog, at, tuning)
      : decaySensitivityValues(state.agentMood?.sensitivity ?? {}, at, tuning),
  };
  // appraiseEvent 的事件类型字段是 type（1A 契约）；未给 target 时按 context 生成
  const defaultTarget = context.activeUid ? { kind: 'person', uid: String(context.activeUid) } : { kind: 'world', uid: null };
  // 事件 id 必须进 appraise 输入：episode.latestSourceEventId 由 appraise 的 eventId 生成，
  // 不传的话情绪 episode 无法回指记忆事件（协作检查：追溯链断裂）。
  const appraiseEventInput = { ...event, eventId, type: event.eventType ?? event.type, target: event.target ?? defaultTarget, at };
  const candidates = appraiseEvent({ events: [appraiseEventInput], context: contextForAppraise });
  const baseMood = state.agentMood ?? createEmptyAgentMood({ now });
  // 完整 memory entry 冻结进 payload（重试原样重放，不得重组）
  const entry = {
    id: eventId,
    t: at,
    k: contextKey,
    kind: 'emotion',
    text: String(event.text ?? event.quote ?? '').slice(0, 160),
    meta: {
      eventType: event.eventType ?? event.type ?? null,
      contentHash,
      at,
      // 阶段 4：记忆事件携带多情绪标签（appraise 候选，≤3，按强度降序）
      emotions: Array.isArray(candidates)
        ? candidates.slice().sort((a, b) => (b.intensity ?? 0) - (a.intensity ?? 0)).slice(0, 3).map((cand) => ({ kind: cand.kind, intensity: cand.intensity }))
        : [],
    },
    contentHash,
  };
  const pending = {
    eventId,
    contentHash,
    missingSide: 'both',
    payload: { candidates, needTension: contextForAppraise.needTension, messageId: event.messageId ?? null, contextKey, at, event: appraiseEventInput, entry },
    attempts: 0,
    lastAttemptAt: 0,
    nextAttemptAt: now,
    status: 'pending',
  };
  const projectedMood = applyMoodCandidates(baseMood, candidates, context, at, tuning, { eventId, contentHash });
  // §F：候选不得越界——测量「最终 mood + 即将写入 checkpoint 的 pending 载荷」整体
  const checkpointCandidate = { ...projectedMood, pendingFacts: [...(projectedMood.pendingFacts ?? []), pending] };
  if (agentMoodBytes({ agentMood: checkpointCandidate }) > AGENT_MOOD_BUDGET_BYTES) {
    return { state, code: 'mood-budget-full', eventId };
  }
  const memoryAvailable = !!(memory && typeof memory.appendEventWithId === 'function');
  // memory disabled：不创建 checkpoint/pending（memory 审计源不存在时无法重放）→ 只走 mood
  if (!memoryAvailable) {
    return { state: { ...state, agentMood: projectedMood }, code: 'memory-disabled', eventId };
  }
  // 有 memory 时 checkpoint 必填（R26）
  if (typeof writeCheckpoint !== 'function') {
    throw new Error('applyFactPipeline requires writeCheckpoint when memory is available');
  }
  const checkpointState = { ...state, agentMood: { ...baseMood } };
  pushPending(checkpointState.agentMood, pending);
  // 1. checkpoint 必须先落盘（失败不得写 memory）
  try {
    writeCheckpoint(checkpointState);
  } catch {
    return { state, code: 'checkpoint-failed', eventId };
  }
  // 2. memory（幂等）
  const memResult = memory.appendEventWithId(entry);
  if (memResult?.ok !== true) {
    checkpointState.agentMood = {
      ...checkpointState.agentMood,
      pendingFacts: checkpointState.agentMood.pendingFacts.map((item) => (item.eventId === eventId ? { ...item, attempts: 1, lastAttemptAt: now, nextAttemptAt: nextRetryAt(1, now) } : item)),
    };
    return { state: checkpointState, code: 'memory-failed', eventId };
  }
  // 3. mood
  try {
    const mood = applyMoodCandidates(checkpointState.agentMood, candidates, context, at, tuning, { eventId, contentHash });
    mood.pendingFacts = (mood.pendingFacts ?? []).filter((item) => item.eventId !== eventId);
    mood.unresolvedFacts = trimFacts(mood.unresolvedFacts ?? [], MAX_UNRESOLVED_FACTS);
    return { state: { ...checkpointState, agentMood: mood }, code: 'ok', eventId };
  } catch {
    checkpointState.agentMood = {
      ...checkpointState.agentMood,
      pendingFacts: checkpointState.agentMood.pendingFacts.map((item) => (item.eventId === eventId ? { ...item, missingSide: 'mood', attempts: 1, lastAttemptAt: now, nextAttemptAt: nextRetryAt(1, now) } : item)),
    };
    return { state: checkpointState, code: 'mood-failed', eventId };
  }
}

/**
 * 重试 pendingFacts（save 前/启动时调用）。重放冻结 entry，不得重组。
 * attempts 0..5：首次失败 attempts=1；重试失败 +1；第 5 次失败进 unresolvedFacts。
 */
export function retryPendingFacts({ state, memory, now = Date.now(), tuning = null }) {
  if (!state?.agentMood) return { state, retried: 0, unresolved: 0 };
  if (state.paused) return { state, retried: 0, unresolved: 0 };
  let retried = 0;
  let unresolved = 0;
  const kept = [];
  const exhausted = [];
  const next = { ...state, agentMood: { ...state.agentMood } };
  for (const pending of state.agentMood.pendingFacts ?? []) {
    if (Number(pending.nextAttemptAt ?? 0) > now) { kept.push(pending); continue; }
    const attempt = (Number(pending.attempts) || 0) + 1;
    let memoryOk = pending.missingSide === 'mood';
    if (!memoryOk && memory && typeof memory.appendEventWithId === 'function') {
      const entry = pending.payload?.entry;
      if (!entry) {
        if (attempt >= 5) { unresolved += 1; exhausted.push(toUnresolved({ ...pending, attempts: attempt }, now, 'missing_frozen_entry')); continue; }
        kept.push({ ...pending, attempts: attempt, lastAttemptAt: now, nextAttemptAt: nextRetryAt(attempt, now) });
        continue;
      }
      const result = memory.appendEventWithId(entry);
      memoryOk = result?.ok === true;
    }
    if (!memoryOk) {
      if (attempt >= 5) { unresolved += 1; exhausted.push(toUnresolved({ ...pending, attempts: attempt }, now, 'memory_retry_exhausted')); continue; }
      kept.push({ ...pending, attempts: attempt, lastAttemptAt: now, nextAttemptAt: nextRetryAt(attempt, now) });
      continue;
    }
    try {
      const context = contextFromKey(pending.payload?.contextKey ?? '');
      next.agentMood = applyMoodCandidates(next.agentMood, pending.payload?.candidates ?? [], context, now, tuning, { eventId: pending.eventId ?? null, contentHash: pending.contentHash ?? null, at: pending.payload?.at ?? pending.payload?.event?.at ?? now });
    } catch {
      if (attempt >= 5) { unresolved += 1; exhausted.push(toUnresolved({ ...pending, attempts: attempt }, now, 'mood_retry_exhausted')); continue; }
      kept.push({ ...pending, attempts: attempt, missingSide: 'mood', lastAttemptAt: now, nextAttemptAt: nextRetryAt(attempt, now) });
      continue;
    }
    retried += 1;
  }
  next.agentMood.pendingFacts = trimFacts(kept, MAX_PENDING_FACTS);
  if (exhausted.length > 0) {
    next.agentMood.unresolvedFacts = trimFacts([...(next.agentMood.unresolvedFacts ?? []), ...exhausted], MAX_UNRESOLVED_FACTS);
  }
  return { state: next, retried, unresolved };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. archive 管线（§E）
// ─────────────────────────────────────────────────────────────────────────────

/** conversation archive 摘要（冻结 payload：checkpoint 时生成，重试复用）。 */
export function buildArchivePayload(conversation, { now = Date.now() } = {}) {
  if (!conversation || typeof conversation !== 'object') return null;
  const recent = Array.isArray(conversation.recentMessages) ? conversation.recentMessages : [];
  const topics = (Array.isArray(conversation.activeTopics) ? conversation.activeTopics : [])
    .map((topic) => (topic && typeof topic === 'object' ? String(topic.text ?? '') : String(topic ?? '')))
    .filter(Boolean)
    .slice(0, 20);
  const summary = recent.slice(-6).map((msg) => String(msg?.text ?? '')).filter(Boolean).join(' / ').slice(0, 200);
  const lastIncomingAt = Number(conversation.lastIncomingAt) || 0;
  const lastActionAt = Number(conversation.lastActionAt) || 0;
  const lastMessageTime = recent.length ? Number(recent[recent.length - 1]?.time) || 0 : 0;
  return {
    lastActionAt,
    lastIncomingAt,
    lastInteractionAt: Math.max(lastIncomingAt, lastActionAt, lastMessageTime),
    messageCount: recent.length,
    topics,
    summary,
    archivedAt: now,
  };
}

/** 冻结 archive memory entry（payload 内 entry 一旦生成不再重建）。 */
export function buildArchiveEntry(pending, now = Date.now()) {
  const payload = pending.payload ?? {};
  return {
    id: `archive:${pending.key}:${pending.generationId}`,
    t: payload.archivedAt ?? now,
    k: pending.key,
    kind: 'archive',
    text: String(payload.summary ?? '').slice(0, 200),
    meta: {
      lastActionAt: payload.lastActionAt,
      lastIncomingAt: payload.lastIncomingAt,
      lastInteractionAt: payload.lastInteractionAt,
      messageCount: payload.messageCount,
      topics: payload.topics,
      archivedAt: payload.archivedAt,
    },
  };
}

/**
 * pendingArchive 三阶段推进（checkpoint → memory-written → conversation-removed → null）。
 * 以冻结 entry 调 appendEventWithId：duplicate → 推进；conflict → 不推进（code conflict）；
 * 失败 → 保留 checkpoint。一次调用只推进一个阶段。
 * @returns {{state:object, changed:boolean, code:'ok'|'memory-failed'|'conflict'|'noop'}}
 */
export function runArchivePipeline({ state, memory, now = Date.now() }) {
  if (state?.paused) return { state, changed: false, code: 'paused' };
  const pending = state.pendingArchive;
  if (!pending) return { state, changed: false, code: 'noop' };
  const next = { ...state, pendingArchive: { ...pending } };
  if (pending.phase === 'checkpoint') {
    const entry = pending.payload?.entry ?? buildArchiveEntry(pending, now);
    if (!pending.payload?.entry) next.pendingArchive.payload = { ...(pending.payload ?? {}), entry };
    if (!memory || typeof memory.appendEventWithId !== 'function') return { state, changed: false, code: 'memory-failed' };
    const result = memory.appendEventWithId(entry);
    if (!result || result.ok !== true) {
      return { state: next, changed: false, code: result?.conflict ? 'conflict' : 'memory-failed' };
    }
    next.pendingArchive.phase = 'memory-written';
    return { state: next, changed: true, code: 'ok' };
  }
  if (pending.phase === 'memory-written') {
    const conversations = new Map(next.conversations);
    conversations.delete(pending.key);
    next.conversations = conversations;
    next.pendingArchive.phase = 'conversation-removed';
    return { state: next, changed: true, code: 'ok' };
  }
  if (pending.phase === 'conversation-removed') {
    next.pendingArchive = null;
    return { state: next, changed: true, code: 'ok' };
  }
  return { state, changed: false, code: 'noop' };
}

/** 32 会话门禁：>32 时冻结一个 pendingArchive（最旧 lastInteractionAt），返回 {state, frozen:boolean}。 */
export function prepareConversationArchive({ state, now = Date.now() }) {
  if (state?.paused) return { state, frozen: false };
  if (state.pendingArchive) return { state, frozen: false }; // 单槽：已有 checkpoint 先消费
  const conversations = state.conversations;
  if (!conversations || typeof conversations.size !== 'number' || conversations.size <= MAX_CONVERSATIONS) {
    return { state, frozen: false };
  }
  const candidates = [];
  for (const [key, conv] of conversations) {
    const recent = Array.isArray(conv?.recentMessages) ? conv.recentMessages : [];
    const lastMessageTime = recent.length ? Math.max(...recent.map((msg) => Number(msg?.time) || 0)) : 0;
    const lastInteractionAt = Math.max(Number(conv?.lastIncomingAt) || 0, Number(conv?.lastActionAt) || 0, lastMessageTime);
    candidates.push({ key, lastInteractionAt });
  }
  candidates.sort((a, b) => (a.lastInteractionAt - b.lastInteractionAt) || a.key.localeCompare(b.key));
  const victim = candidates[0];
  if (!victim) return { state, frozen: false };
  const conv = conversations.get(victim.key);
  const payload = buildArchivePayload(conv, { now });
  const generationId = `gen-${now}-${victim.key}`.slice(0, 64);
  const next = {
    ...state,
    pendingArchive: { key: victim.key, generationId, at: now, phase: 'checkpoint', payload },
  };
  return { state: next, frozen: true };
}

/** 关系淘汰阶段 1（纯）：>50 按 lastInteraction 升序冻结 payload 写入 pendingEvict（≤10）。 */
export function prepareRelationshipEvict({ state, now = Date.now() }) {
  if (state?.paused) return { state, added: 0 };
  if (!state?.relationships) return { state, added: 0 };
  const next = { ...state, relationships: { ...state.relationships }, relationshipArchive: { ...state.relationshipArchive } };
  const pendingEvict = Array.isArray(next.relationshipArchive.pendingEvict) ? next.relationshipArchive.pendingEvict.slice() : [];
  next.relationshipArchive.pendingEvict = pendingEvict;
  const rels = next.relationships;
  const existing = new Set(pendingEvict.map((item) => `${item.uid}|${item.generationId}`));
  let added = 0;
  const uids = Object.keys(rels);
  if (uids.length > MAX_RELATIONSHIPS && pendingEvict.length < MAX_PENDING_EVICT) {
    const excess = uids.length - MAX_RELATIONSHIPS;
    const candidates = uids.slice()
      .sort((a, b) => (Number(rels[a]?.lastInteraction) || 0) - (Number(rels[b]?.lastInteraction) || 0) || String(a).localeCompare(String(b)))
      .slice(0, Math.min(excess, MAX_PENDING_EVICT - pendingEvict.length));
    for (const uid of candidates) {
      const rel = rels[uid];
      if (!rel) continue;
      const generationId = String(rel.generationId || `gen-${uid}`).slice(0, 64);
      if (existing.has(`${uid}|${generationId}`)) continue;
      pendingEvict.push({
        uid,
        generationId,
        archiveId: `relationship-archive:${uid}:${generationId}`,
        payload: normalizeRelationshipArchivePayload({ ...rel, archivedAt: now }, { now }),
        at: now,
      });
      existing.add(`${uid}|${generationId}`);
      added += 1;
    }
  }
  return { state: next, added };
}

/** 关系淘汰阶段 2：冻结 payload 写 memory（幂等）→ 成功后删关系；条目保留到 finalize。 */
export function consumeRelationshipEvict({ state, memory, now = Date.now() }) {
  if (state?.paused) return { state, written: 0, writtenIds: [] };
  if (!state?.relationshipArchive?.pendingEvict?.length) return { state, written: 0, writtenIds: [] };
  if (!memory || typeof memory.appendEventWithId !== 'function') return { state, written: 0, writtenIds: [] };
  const next = { ...state, relationships: { ...state.relationships }, relationshipArchive: { ...state.relationshipArchive } };
  let written = 0;
  const writtenIds = [];
  for (const item of state.relationshipArchive.pendingEvict) {
    const result = memory.appendEventWithId({
      id: item.archiveId,
      t: item.payload?.archivedAt ?? item.at ?? now,
      kind: 'relationship-archive',
      text: '',
      meta: {
        uid: item.uid,
        generationId: item.generationId,
        intimacy: item.payload?.intimacy,
        tension: item.payload?.tension,
        trust: item.payload?.trust,
        resentment: item.payload?.resentment,
        attachmentStyle: item.payload?.attachmentStyle,
        lastInteraction: item.payload?.lastInteraction,
        lastContextKey: item.payload?.lastContextKey,
        openLoops: item.payload?.openLoops,
        archivedAt: item.payload?.archivedAt,
      },
    });
    if (result?.ok === true) {
      // 只删 generation 匹配的当前关系（旧 pendingEvict 不得误删同 uid 新 generation）
      const current = next.relationships[item.uid];
      if (current && String(current.generationId ?? '') === String(item.generationId)) {
        delete next.relationships[item.uid];
      }
      written += 1;
      writtenIds.push(item.archiveId);
    }
  }
  return { state: next, written, writtenIds };
}

/**
 * 关系淘汰阶段 3：最终写成功后清「本次成功消费」的冻结条目。
 * consumedIds = consumeRelationshipEvict 返回的 writtenIds；未提供时保留全部（safe）。
 */
export function finalizeRelationshipEvict({ state, consumedIds = null }) {
  if (!state?.relationshipArchive?.pendingEvict?.length) return state;
  const consumed = consumedIds instanceof Set ? consumedIds : new Set(Array.isArray(consumedIds) ? consumedIds : []);
  const remain = state.relationshipArchive.pendingEvict.filter((item) => !consumed.has(item.archiveId));
  return { ...state, relationshipArchive: { ...state.relationshipArchive, pendingEvict: remain } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. save 流水线（§F：normalize → execute → serialize → 预算 → atomic write | reject）
// ─────────────────────────────────────────────────────────────────────────────

/** 读取旧文件的 schema 分类（注入 readFile：返回 string | null；null = ENOENT）。 */
export function classifyOldFile(text) {
  if (text === null || text === undefined) return { schema: 'missing', blocks: null };
  let raw = null;
  try { raw = JSON.parse(text); } catch { return { schema: 'corrupt', blocks: null }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { schema: 'corrupt', blocks: null };
  const V2_BLOCKS = ['agentMood', 'relationships', 'relationshipArchive', 'pendingArchive', 'migration'];
  const hasAll = V2_BLOCKS.every((field) => Object.prototype.hasOwnProperty.call(raw, field));
  if (raw.version === 2 && hasAll) {
    return { schema: 'v2', blocks: Object.fromEntries(V2_BLOCKS.map((field) => [field, raw[field]])) };
  }
  if (raw.version === 2) return { schema: 'v2-incomplete', blocks: null };
  return { schema: 'v1', blocks: null };
}

/** v2 缺块补齐（schema upgrade）：返回补齐后的对象（不写盘，调用方原子写）。 */
export function upgradeLegacyV2(raw) {
  const normalized = loadSocialV2State(raw, { now: Date.now() }).state;
  return serializeSocialV2(normalized, { mode: 'final' });
}

/**
 * save 流水线。
 * - legacy：不序列化、不写 V2（no-op，返回 ok）；
 * - main：重试到期 pending → archive 三阶段推进到 null（最多 3 步）→ relationship 淘汰 → serialize → 预算 → write；
 * - shadow：serialize(shadow, sourceSchema) → write（preserve-on-disk）。
 * 任何 reject/失败（预算/写盘/序列化）都回滚 archive/evict 的内存变化并保留冻结 payload。
 * @returns {{ok:boolean, state:object, serialized:object|null, saveStatus:string,
 *            stateBytes:number, degradedReasons:string[], error:string|null, code:string}}
 */
export function runSavePipeline({ state, mode = 'main', memory, readOldFile, writeFile, writeCheckpoint = null, plan = null, now = Date.now(), tuning = null }) {
  if (!state || typeof state !== 'object') throw new Error('runSavePipeline requires state');
  if (mode !== 'legacy' && mode !== 'shadow' && mode !== 'main') {
    throw new Error('runSavePipeline: mode 必须是 legacy/shadow/main');
  }
  if (mode === 'legacy') {
    return { ok: true, state, serialized: null, saveStatus: 'normal', stateBytes: 0, degradedReasons: [], error: null, code: 'noop-legacy' };
  }
  // §I：paused 时 V2 管线不写（不 memory、不 archive/evict、不写盘）
  if (state.paused) {
    return { ok: true, state, serialized: null, saveStatus: 'normal', stateBytes: 0, degradedReasons: ['paused'], error: null, code: 'paused' };
  }
  if (typeof writeFile !== 'function') throw new Error('runSavePipeline requires writeFile');
  let next = state;
  // 多 checkpoint 事务：durable = 最后一个已成功落盘的 checkpoint（失败分支的权威返回态）
  let durable = state;
  const archiveBackup = { conversations: state.conversations, pendingArchive: state.pendingArchive };
  const evictBackup = {
    relationships: state.relationships,
    pendingEvict: state.relationshipArchive?.pendingEvict ?? [],
  };
  const consumedEvictIds = new Set();
  const rollback = (candidate) => ({
    ...candidate,
    conversations: archiveBackup.conversations,
    pendingArchive: archiveBackup.pendingArchive,
    relationships: evictBackup.relationships,
    // 已消费队列恢复为 consume 前冻结条目（磁盘僵尸队列的反向恢复）
    relationshipArchive: { ...(candidate.relationshipArchive ?? {}), pendingEvict: evictBackup.pendingEvict },
  });
  if (mode === 'main') {
    if (typeof writeCheckpoint !== 'function') {
      return { ok: false, state, serialized: null, saveStatus: 'rejected', stateBytes: 0, degradedReasons: ['main save 需要 writeCheckpoint（冻结队列必须先落盘）'], error: 'writeCheckpoint required for main save', code: 'checkpoint-required' };
    }
    // 到期 fact 重试（save 前）
    const retried = retryPendingFacts({ state: next, memory, now, tuning });
    next = retried.state;
    // 32 会话门禁：冻结一个 pendingArchive 并先落盘，再 memory → 删会话 → 清槽
    const prepared = prepareConversationArchive({ state: next, now });
    next = prepared.state;
    if (prepared.frozen) {
      try { writeCheckpoint(next); } catch {
        return { ok: false, state: durable, serialized: null, saveStatus: 'rejected', stateBytes: 0, degradedReasons: ['checkpoint 写失败（会话归档）'], error: 'checkpoint write failed', code: 'checkpoint-failed' };
      }
      archiveBackup.pendingArchive = next.pendingArchive;
      durable = next;
    }
    // archive 三阶段本次 save 推进到 null（每步失败即停，payload 保留）
    for (let i = 0; i < 3; i += 1) {
      const step = runArchivePipeline({ state: next, memory, now });
      next = step.state;
      if (!next.pendingArchive || step.code !== 'ok') break;
    }
    // 关系淘汰两阶段：prepare（纯）→ 冻结队列落盘 → consume（memory + 删关系）
    const evictPrepared = prepareRelationshipEvict({ state: next, now });
    next = evictPrepared.state;
    if (evictPrepared.added > 0) {
      try { writeCheckpoint(next); } catch {
        return { ok: false, state: durable, serialized: null, saveStatus: 'rejected', stateBytes: 0, degradedReasons: ['checkpoint 写失败（关系冻结队列）'], error: 'checkpoint write failed', code: 'checkpoint-failed' };
      }
      // 冻结队列已落盘 → 回滚基准保留该队列（写失败时不得回滚成空）
      evictBackup.pendingEvict = next.relationshipArchive.pendingEvict;
      durable = next;
    }
    const consumed = consumeRelationshipEvict({ state: next, memory, now });
    next = consumed.state;
    for (const id of consumed.writtenIds ?? []) consumedEvictIds.add(id);
    // 写盘前清理已消费条目（磁盘不得残留僵尸队列）；写失败时 rollback 恢复 consume 前冻结条目
    next = finalizeRelationshipEvict({ state: next, consumedIds: consumedEvictIds });
  }
  let serialized;
  try {
    if (mode === 'shadow') {
      let oldText = null;
      try { oldText = typeof readOldFile === 'function' ? readOldFile() : null; } catch {
        return { ok: false, state: rollback(next), serialized: null, saveStatus: 'rejected', stateBytes: 0, degradedReasons: ['shadow:读取旧文件失败'], error: 'shadow read old file failed', code: 'shadow-read-failed' };
      }
      const old = classifyOldFile(oldText);
      if (old.schema === 'corrupt') {
        return { ok: false, state: rollback(next), serialized: null, saveStatus: 'rejected', stateBytes: 0, degradedReasons: ['shadow:旧文件损坏，拒写'], error: 'shadow old file corrupt', code: 'rejected' };
      }
      if (old.schema === 'v2-incomplete') {
        return { ok: false, state: rollback(next), serialized: null, saveStatus: 'rejected', stateBytes: 0, degradedReasons: ['shadow:旧 v2 文件缺块，需先 schema upgrade'], error: 'shadow old v2 file incomplete', code: 'shadow-upgrade-required' };
      }
      const sourceSchema = old.schema === 'v2' ? 'v2' : 'v1';
      serialized = serializeSocialV2(next, {
        mode: 'shadow',
        sourceSchema,
        ...(sourceSchema === 'v2' ? { preservedV2Blocks: old.blocks } : {}),
      });
    } else if (next.migration?.status === 'done') {
      serialized = serializeSocialV2(next, { mode: 'final' });
    } else {
      serialized = serializeSocialV2(next, { mode: 'transition' });
    }
  } catch (error) {
    return { ok: false, state: rollback(next), serialized: null, saveStatus: 'rejected', stateBytes: 0, degradedReasons: [String(error?.message ?? error)], error: String(error?.message ?? error), code: 'serialize-failed' };
  }
  let budgets;
  try {
    budgets = computeBudgets(next, { serialized });
  } catch (error) {
    return { ok: false, state: rollback(next), serialized, saveStatus: 'rejected', stateBytes: 0, degradedReasons: [String(error?.message ?? error)], error: String(error?.message ?? error), code: 'budget-failed' };
  }
  if (budgets.saveStatus === 'rejected') {
    return { ok: false, state: rollback(next), serialized, saveStatus: 'rejected', stateBytes: budgets.stateBytes, degradedReasons: budgets.degradedReasons ?? [], error: 'budget gate rejected', code: 'rejected' };
  }
  try {
    writeFile(serialized);
  } catch (error) {
    return { ok: false, state: rollback(next), serialized, saveStatus: 'rejected', stateBytes: budgets.stateBytes, degradedReasons: budgets.degradedReasons ?? [], error: String(error?.message ?? error), code: 'write-failed' };
  }
  const degradedReasons = [...(budgets.degradedReasons ?? [])];
  let saveStatus = budgets.saveStatus;
  if (mode === 'main' && (next.conversations?.size ?? 0) > MAX_CONVERSATIONS) {
    degradedReasons.push('conversations_overflow');
    if (saveStatus === 'normal') saveStatus = 'degraded';
  }
  return {
    ok: true,
    state: next,
    serialized,
    saveStatus,
    stateBytes: budgets.stateBytes,
    degradedReasons,
    error: null,
    code: 'ok',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. reset service（§H：四端点 + 集中鉴权，agent 403 先于无凭证 401）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 鉴权矩阵：agent 凭证且无有效 admin → 403（先判）；无 admin → 401；admin → 'ok'。
 * @returns {'ok'|403|401}
 */
export function authorizeReset({ headers = {}, adminToken = null, agentToken = null } = {}) {
  const agent = String(headers['x-agent-token'] ?? '');
  const admin = String(headers['x-console-token'] ?? headers['x-admin-token'] ?? '');
  const adminOk = !!adminToken && admin === adminToken;
  if (agent && !adminOk) return 403;
  if (!adminOk) return 401;
  return 'ok';
}

const RESET_PATHS = Object.freeze({
  '/api/socialV2/emotion/reset': 'emotion',
  '/api/socialV2/relationship/reset': 'relationship',
  '/api/socialV2/reset': 'workspace',
  '/api/session/reset': 'session',
});

function archiveHasUid(archive, uid) {
  const lists = ['orphanLoops', 'pendingCold', 'pendingEvict'];
  return lists.some((field) => (Array.isArray(archive?.[field]) ? archive[field] : []).some((item) => canonicalUid(item?.uid) === uid));
}

/**
 * 统一 reset service。
 * @param {object} opts
 * @param {function} opts.getState () => RuntimeState
 * @param {function} opts.setState (state) => void
 * @param {function} [opts.persist] (state) => void
 * @param {object} [opts.memory] memoryStore（relationship-reset 墓碑）
 * @param {function} [opts.audit] (action, target) => void
 * @param {function} [opts.now]
 */
/** canonical JSON（对象键排序、数组保序）。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

/** 递归把时刻类字段规范为 0（幂等比较不依赖 now）。 */
function normalizeTimestamps(value) {
  if (Array.isArray(value)) return value.map(normalizeTimestamps);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (['updatedAt', 'migratedAt', 'startedAt', 'completedAt'].includes(key)) out[key] = 0;
    else out[key] = normalizeTimestamps(item);
  }
  return out;
}

/** 持久化 8 字段的语义快照（时间戳规范化；Map 展开排序）。 */
function persistentSnapshot(state) {
  const conversations = state?.conversations instanceof Map
    ? [...state.conversations.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    : (state?.conversations ?? {});
  const seenForwardIds = state?.seenForwardIds instanceof Map
    ? [...state.seenForwardIds.entries()]
      .map(([key, set]) => [key, [...(set ?? [])].sort()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    : (state?.seenForwardIds ?? {});
  // migrationVersion 是 1A 兼容字段（final 不导出），不参与 reset 幂等判定
  const { migrationVersion: _migrationVersion, ...moodRest } = state?.agentMood ?? {};
  return stableStringify({
    paused: !!state?.paused,
    agentMood: normalizeTimestamps(moodRest),
    relationships: state?.relationships ?? {},
    relationshipArchive: state?.relationshipArchive ?? {},
    conversations,
    seenForwardIds,
    pendingArchive: state?.pendingArchive ?? null,
    migration: normalizeTimestamps(state?.migration ?? {}),
  });
}

/** workspace reset 的固定目标（幂等判定与写入共用同一对象）。 */
function buildWorkspaceResetTarget(state) {
  return {
    ...state,
    paused: false,
    agentMood: createEmptyAgentMood({ now: 0 }),
    relationships: {},
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    conversations: new Map(),
    seenForwardIds: new Map(),
    pendingArchive: null,
    migration: { version: 2, fromVersion: 2, status: 'done', revision: 0, startedAt: 0, completedAt: 0, warnings: [], shadowToMainAt: null },
  };
}

/**
 * 统一 reset service。changed:false = 严格 no-op（不 setState、不 persist、不变时间戳）。
 */
export function createResetService({ getState, setState, persist = null, memory = null, audit = () => {}, now = () => Date.now() } = {}) {
  if (typeof getState !== 'function' || typeof setState !== 'function') {
    throw new Error('createResetService requires getState/setState');
  }
  if (typeof audit !== 'function') throw new Error('createResetService requires audit function');
  const resolvePath = (pathname) => RESET_PATHS[pathname] ?? null;
  function emotionReset() {
    const state = getState();
    const target = { ...state, agentMood: createEmptyAgentMood({ now: 0 }) };
    const changed = persistentSnapshot(state) !== persistentSnapshot(target);
    audit('emotion', null);
    if (!changed) return { ok: true, changed: false };
    setState(target);
    if (typeof persist === 'function') persist(target);
    return { ok: true, changed: true };
  }
  function relationshipReset(uidRaw) {
    const uid = canonicalUid(uidRaw);
    if (!uid) return { ok: false, changed: false, error: 'invalid_uid' };
    const state = getState();
    const hadRelation = !!(state.relationships && state.relationships[uid]);
    const hadArchive = archiveHasUid(state.relationshipArchive, uid);
    const changed = hadRelation || hadArchive;
    audit('relationship', uid);
    if (!changed) return { ok: true, changed: false, uid, tombstoneFailed: false };
    const next = { ...state, relationships: { ...(state.relationships ?? {}) }, relationshipArchive: { ...(state.relationshipArchive ?? {}) } };
    delete next.relationships[uid];
    for (const field of ['orphanLoops', 'pendingCold', 'pendingEvict']) {
      if (Array.isArray(next.relationshipArchive[field])) {
        next.relationshipArchive[field] = next.relationshipArchive[field].filter((item) => canonicalUid(item?.uid) !== uid);
      }
    }
    setState(next);
    if (typeof persist === 'function') persist(next);
    let tombstoneFailed = false;
    if (memory && typeof memory.appendEventWithId === 'function') {
      try {
        const result = memory.appendEventWithId({
          id: `relationship-reset:${uid}:${now()}`,
          t: now(),
          kind: 'relationship-reset',
          text: '',
          meta: { uid },
        });
        if (result?.ok !== true) tombstoneFailed = true;
      } catch {
        tombstoneFailed = true;
      }
    }
    return { ok: true, changed: true, uid, tombstoneFailed };
  }
  function sessionReset(keyRaw) {
    const key = String(keyRaw ?? '').trim();
    if (!key) return { ok: false, changed: false, error: 'key_missing' };
    const state = getState();
    if (!state.conversations?.has?.(key)) return { ok: true, changed: false };
    const conversations = new Map(state.conversations);
    conversations.delete(key);
    const seenForwardIds = new Map(state.seenForwardIds ?? []);
    seenForwardIds.delete(key);
    const next = { ...state, conversations, seenForwardIds };
    setState(next);
    if (typeof persist === 'function') persist(next);
    audit('session', key);
    return { ok: true, changed: true };
  }
  function workspaceReset() {
    const state = getState();
    const target = buildWorkspaceResetTarget(state);
    const changed = persistentSnapshot(state) !== persistentSnapshot(target);
    audit('workspace', null);
    if (!changed) return { ok: true, changed: false };
    setState(target);
    if (typeof persist === 'function') persist(target);
    return { ok: true, changed: true };
  }
  function handle({ pathname, uid = null, key = null } = {}) {
    const action = resolvePath(pathname);
    if (!action) return { status: 404, body: { ok: false, error: 'not found' } };
    if (action === 'emotion') return { status: 200, body: emotionReset() };
    if (action === 'relationship') { const out = relationshipReset(uid); return { status: out.ok ? 200 : 400, body: out }; }
    if (action === 'session') { const out = sessionReset(key); return { status: out.ok ? 200 : 400, body: out }; }
    return { status: 200, body: workspaceReset() };
  }
  return { emotionReset, relationshipReset, sessionReset, workspaceReset, handle, resolvePath };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 启动编排（bridge 调用：load → migrate → save 预留）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 启动：flags 校验 → load → （main 且需要时）迁移 → 返回 state/plan/mode。
 * @returns {{ok:boolean, mode:string, state:object|null, plan:object|null, error:string|null, failClosed:boolean}}
 */
export function bootstrapSocialV2({ raw, config = {}, now = Date.now(), writeFile = null, tuning = null } = {}) {
  const flags = resolveV2Flags(config);
  if (!flags.ok) return { ok: false, mode: flags.mode, state: null, plan: null, error: flags.error, failClosed: true };
  const loaded = loadSocialV2State(raw ?? { version: 1 }, { now, tuning });
  if (flags.mode !== 'main') {
    return { ok: true, mode: flags.mode, state: loaded.state, plan: loaded.plan, error: null, failClosed: false };
  }
  if (loaded.state.migration.status === 'done') {
    return { ok: true, mode: flags.mode, state: loaded.state, plan: loaded.plan, error: null, failClosed: false };
  }
  if (typeof writeFile !== 'function') {
    return { ok: false, mode: flags.mode, state: loaded.state, plan: loaded.plan, error: 'main 模式迁移需要 writeFile', failClosed: true };
  }
  const applied = applyStartupMigration(loaded.state, { now, writeFile, plan: loaded.plan });
  return { ok: !applied.failed, mode: flags.mode, state: applied.state, plan: loaded.plan, error: applied.error, failClosed: false };
}

export { MAX_CONVERSATIONS, CONVERSATION_TARGET_BYTES, CONVERSATION_HARD_BYTES, PENDING_ARCHIVE_PHASES, MAX_RELATIONSHIPS };
