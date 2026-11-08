// 情绪系统 V2 —— 1C bridge 运行时（唯一契约：ADDENDUM-1B-internals v2.25 §I/§F + 1C 接线方案）
//
// 职责：
//   - 持有 V2 权威 runtime（agentMood/relationships/relationshipArchive/pendingArchive/migration）；
//   - 会话内存仍由 bridge 旧 store 持有（socialV2.conversations），save 时转成 V2 raw 候选；
//   - main 模式：每次 save 走 runSavePipeline（checkpoint → archive/evict → serialize → 预算 → atomic write）；
//   - shadow/legacy 模式：不启用 V2 写路径（bridge 保持旧序列化，回滚安全）；
//   - §F：event-scope 拒新增（applyFactPipeline 内）、save-scope 预算动作（脏数据裁剪/冷化/32 会话/5MB fatal 短路）；
//   - reset：四端点 + 鉴权（authorizeReset 由调用方传入 headers 执行）。

import { loadSocialV2State, serializeSocialV2 } from './socialv2-state.mjs';
import {
  bootstrapSocialV2,
  budgetActionsFor,
  classifyOldFile,
  createResetService,
  evaluateBudgetGate,
  rankRelationshipPressure,
  resolveV2Flags,
  runSavePipeline,
} from './socialv2-exec.mjs';
import { createSocialV2Adapter } from './socialv2-adapter.mjs';

export const RUNTIME_MODES = Object.freeze(['legacy', 'shadow', 'main']);

function conversationView(st) {
  if (!st || typeof st !== 'object') return null;
  return {
    wakeConfig: st.wakeConfig ?? null,
    recentMessages: Array.isArray(st.recentMessages) ? st.recentMessages : [],
    unread: Array.isArray(st.unread) ? st.unread : [],
    lastIncomingAt: Number(st.lastIncomingAt) || 0,
    lastActionAt: Number(st.lastActionAt) || 0,
    lastAiReplyAt: Number(st.lastAiReplyAt) || 0,
    activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics : [],
    pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts : [],
    memberImpressions: st.memberImpressions ?? {},
    wakeTimes: Array.isArray(st.wakeTimes) ? st.wakeTimes : [],
    sendTimes: Array.isArray(st.sendTimes) ? st.sendTimes : [],
    stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes : [],
    lastContextKey: st.lastContextKey ?? null,
    generationId: st.generationId ?? null,
  };
}

/**
 * @param {object} opts
 * @param {object} [opts.config] 完整配置（读取 emotion.v2.*）
 * @param {object} [opts.memory] memoryStore（fact 两写/归档）
 * @param {function} [opts.readFile] () => string|null（V2 文件）
 * @param {function} [opts.writeFile] (serialized) => void（原子写）
 * @param {function} [opts.writeCheckpoint] (state) => void（checkpoint 原子写）
 * @param {function} [opts.now]
 * @param {function} [opts.log]
 */
export function createSocialV2Runtime({
  config = {},
  memory = null,
  getTuning = null,
  readFile = null,
  readFileInfo = null,
  writeFile = null,
  writeCheckpoint = null,
  now = () => Date.now(),
  log = () => {},
  audit = () => {},
} = {}) {
  const flags = resolveV2Flags(config);
  const configured = flags.ok && (flags.mode === 'main' || flags.mode === 'shadow');
  const writeMode = flags.mode === 'main'; // 只有 main 写 V2；shadow 只读内存投影
  let active = false; // load 成功才为 true（失败后所有写/视图/reset 保持 legacy）
  let state = null;
  let adapter = null;
  const lastSave = { at: 0, ok: false, code: null, degradedReasons: [] };

  function resetState(next) {
    state = next;
  }

  /** 结构化读取旧文件：{missing:true} / {text} / {error}（ENOENT 才是 missing）。 */
  function inspectOldFile() {
    if (typeof readFileInfo === 'function') {
      try { return readFileInfo() ?? { missing: true }; } catch (error) { return { error: String(error?.code ?? error?.message ?? 'IO') }; }
    }
    try {
      const text = typeof readFile === 'function' ? readFile() : null;
      return text === null || text === undefined ? { missing: true } : { text };
    } catch (error) {
      return { error: String(error?.code ?? error?.message ?? 'IO') };
    }
  }

  function load(raw) {
    if (!configured) {
      active = false;
      return { ok: true, mode: flags.mode, failClosed: flags.failClosed, error: flags.error, state: null, plan: null };
    }
    let boot;
    try {
      boot = bootstrapSocialV2({ raw, config, now: now(), writeFile, tuning: typeof getTuning === 'function' ? getTuning() : null });
    } catch (error) {
      boot = { ok: false, error: String(error?.message ?? error) };
    }
    if (!boot.ok) {
      active = false;
      state = null;
      adapter = null;
      log('情绪 V2 启动失败（fail-closed，保持 legacy）:', boot.error);
      return { ok: false, mode: flags.mode, error: boot.error, state: null, plan: null };
    }
    state = boot.state;
    active = true;
    adapter = createSocialV2Adapter({
      getState: () => state,
      setState: resetState,
      save: (candidate) => {
        // shadow：只读投影（不写盘/不写 memory）；main：候选原子提交
        if (!writeMode) return;
        const result = saveCandidate(candidate);
        if (!result.ok) {
          const error = new Error('emotion-v2-save-rejected');
          error.code = result.code;
          throw error;
        }
      },
      memory: writeMode ? memory : null,
      now,
      getTuning,
    });
    return { ok: true, mode: flags.mode, state, plan: boot.plan };
  }

  /** 旧 store → V2 候选（会话内存仍由旧 store 持有；V2 状态字段来自 runtime）。 */
  function candidateFromLegacy({ socialV2, seenForwardIds } = {}) {
    const conversations = {};
    for (const [key, st] of socialV2?.conversations ?? []) {
      if (!writeMode) {
        // shadow/legacy：原样传（v1 透传需要 legacy 字段）
        conversations[key] = st;
        continue;
      }
      // main：V2 关系/情绪是权威 —— conversation 内的 legacy mood/relationships 只用于回滚，
      // 绝不重新作为 V2 输入（否则旧分片会覆盖全局权威关系/情绪）
      const { relationships: _legacyRels, mood: _legacyMood, legacyMood: _legacyMoodField, legacyRelationships: _legacyRelsField, ...rest } = st ?? {};
      conversations[key] = rest;
    }
    const seen = {};
    if (seenForwardIds && typeof seenForwardIds.entries === 'function') {
      for (const [key, set] of seenForwardIds) seen[key] = [...(set ?? [])];
    } else if (seenForwardIds && typeof seenForwardIds === 'object') {
      Object.assign(seen, seenForwardIds);
    }
    const raw = {
      version: 2,
      paused: socialV2?.paused === true,
      agentMood: state?.agentMood,
      relationships: state?.relationships,
      relationshipArchive: state?.relationshipArchive,
      conversations,
      seenForwardIds: seen,
      pendingArchive: state?.pendingArchive ?? null,
      migration: state?.migration,
    };
    return loadSocialV2State(raw, { now: now(), tuning: typeof getTuning === 'function' ? getTuning() : null }).state;
  }

  /** save 预算动作（§F）：返回 fatal 动作列表；fatal 时不得执行任何副作用。 */
  function gateSave(candidate, serialized) {
    const gate = evaluateBudgetGate({ state: candidate, serialized, scope: 'save' });
    const actions = budgetActionsFor(gate);
    return { gate, actions, fatal: actions.fatal, shortCircuit: actions.shortCircuit };
  }

  /** 脏会话裁剪（50→20→10）：只改候选内存态，不直接写盘。 */
  function trimConversations(candidate, { targetBytes = 128 * 1024 } = {}) {
    let trimmed = 0;
    const conversations = new Map(candidate.conversations);
    for (const [key, st] of conversations) {
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const measure = (entry) => Buffer.byteLength(JSON.stringify(entry ?? {}), 'utf8');
      if (measure(st) <= targetBytes) continue;
      // 50→20→10 分档：先裁到 20 条重新测量，仍超再裁到 10
      let candidate = { ...st, recentMessages: recent.slice(-20) };
      if (measure(candidate) > targetBytes) candidate = { ...st, recentMessages: recent.slice(-10) };
      conversations.set(key, candidate);
      trimmed += 1;
    }
    return { state: { ...candidate, conversations }, trimmed };
  }

  /**
   * 关系冷化（§3.1）：超 64KB 时把最旧的非 HOT 关系**保留为摘要**（清 events/openLoops），
   * 不删除关系、不进 pendingEvict（只有 >50 LRU 淘汰才归档删除）。
   */
  function coldRelationships(candidate, { hotLimit = 15 } = {}) {
    const pressure = rankRelationshipPressure(candidate, { hotLimit });
    if (pressure.coldCandidates.length === 0) return { state: candidate, cold: 0 };
    const next = { ...candidate, relationships: { ...candidate.relationships } };
    const budget = 64 * 1024;
    let cold = 0;
    for (const uid of pressure.coldCandidates) {
      if (Buffer.byteLength(JSON.stringify(next.relationships), 'utf8') <= budget) break;
      const rel = next.relationships[uid];
      if (!rel) continue;
      if ((rel.events?.length ?? 0) === 0 && (rel.openLoops?.length ?? 0) === 0) continue;
      next.relationships[uid] = { ...rel, events: [], openLoops: [] };
      cold += 1;
    }
    return { state: next, cold };
  }

  /** main save：预算动作（fatal 短路 → trim → cold）→ runSavePipeline。 */
  function saveCandidate(candidate) {
    if (!configured || !active) return { ok: true, state: candidate, code: 'legacy-noop', saveStatus: 'normal', degradedReasons: [], stateBytes: 0 };
    // shadow：内存投影只读，不写 V2 主文件、不写 memory（线上行为零变化）
    if (!writeMode) return { ok: true, state: candidate, code: 'shadow-noop', saveStatus: 'normal', degradedReasons: ['shadow'], stateBytes: 0 };
    const t = now();
    let next = candidate;
    // 先 serialize 一次用于 save-scope 预算（fatal 判定必须先于 cold/trim/archive）
    let serialized;
    try {
      serialized = serializeSocialV2(next, { mode: next.migration?.status === 'done' ? 'final' : 'transition' });
    } catch (error) {
      lastSave.at = t; lastSave.ok = false; lastSave.code = 'serialize-failed';
      return { ok: false, state: candidate, code: 'serialize-failed', saveStatus: 'rejected', degradedReasons: [String(error?.message ?? error)], stateBytes: 0 };
    }
    const gate = gateSave(next, serialized);
    if (gate.fatal) {
      lastSave.at = t; lastSave.ok = false; lastSave.code = 'save-rejected'; lastSave.degradedReasons = gate.actions.overUnits;
      return { ok: false, state: candidate, code: 'save-rejected', saveStatus: 'rejected', degradedReasons: gate.actions.overUnits, stateBytes: gate.gate.stateBytes };
    }
    // save-scope 非 fatal：脏会话裁剪（50→20→10）
    const trimmed = trimConversations(next);
    next = trimmed.state;
    // 关系超 64KB → HOT≤15 冷化（只把冷候选推进 pendingEvict，memory 由 pipeline 写）
    let cold = 0;
    if (gate.actions.overUnits.includes('relationships')) {
      const coldResult = coldRelationships(next, { hotLimit: 15 });
      next = coldResult.state;
      cold = coldResult.cold;
    }
    const result = runSavePipeline({ state: next, mode: 'main', memory, writeCheckpoint, writeFile, now: t, tuning: typeof getTuning === 'function' ? getTuning() : null });
    lastSave.at = t;
    lastSave.ok = result.ok;
    lastSave.code = result.code;
    lastSave.degradedReasons = [...(result.degradedReasons ?? []), ...(trimmed.trimmed ? ['conversation-trimmed'] : []), ...(cold ? ['relationship-cold'] : [])];
    if (result.ok) state = result.state;
    return result;
  }

  /**
   * shadow save：读旧文件分类 → shadow serializer（v1 透传 / v2 保留五块）→ 原子写。
   * 绝不用 legacy serializer 覆盖 V2 文件（R37）。
   */
  function shadowSave(candidate) {
    if (!configured || !active || writeMode) return { ok: false, code: 'not-shadow' };
    const fileInfo = inspectOldFile();
    if (fileInfo.error) {
      lastSave.at = now(); lastSave.ok = false; lastSave.code = 'shadow-read-failed';
      return { ok: false, code: 'shadow-read-failed', state: candidate, saveStatus: 'rejected', degradedReasons: ['shadow:读取旧文件失败(' + fileInfo.error + ')'], stateBytes: 0 };
    }
    const old = classifyOldFile(fileInfo.missing ? null : fileInfo.text);
    if (old.schema === 'corrupt' || old.schema === 'v2-incomplete') {
      lastSave.at = now(); lastSave.ok = false; lastSave.code = 'shadow-upgrade-required';
      return { ok: false, code: 'shadow-upgrade-required', state: candidate, saveStatus: 'rejected', degradedReasons: [], stateBytes: 0 };
    }
    const sourceSchema = old.schema === 'v2' ? 'v2' : 'v1';
    let serialized;
    try {
      serialized = serializeSocialV2(candidate, {
        mode: 'shadow',
        sourceSchema,
        ...(sourceSchema === 'v2' ? { preservedV2Blocks: old.blocks } : {}),
      });
    } catch (error) {
      lastSave.at = now(); lastSave.ok = false; lastSave.code = 'serialize-failed';
      return { ok: false, code: 'serialize-failed', state: candidate, saveStatus: 'rejected', degradedReasons: [String(error?.message ?? error)], stateBytes: 0 };
    }
    try {
      if (typeof writeFile !== 'function') throw new Error('writeFile missing');
      writeFile(serialized);
    } catch (error) {
      lastSave.at = now(); lastSave.ok = false; lastSave.code = 'write-failed';
      return { ok: false, code: 'write-failed', state: candidate, saveStatus: 'rejected', degradedReasons: [String(error?.message ?? error)], stateBytes: 0 };
    }
    lastSave.at = now(); lastSave.ok = true; lastSave.code = 'shadow-saved';
    return { ok: true, code: 'shadow-saved', state: candidate, serialized, saveStatus: 'normal', degradedReasons: [], stateBytes: Buffer.byteLength(JSON.stringify(serialized), 'utf8') };
  }

  /**
   * 管理端 pause/resume 专用持久化：直接序列化 + 原子写，绕过「paused 不写盘」的保存短路。
   * 返回 {ok, code}；写失败由调用方转成非 2xx。
   */
  function savePauseState(paused) {
    if (!active || !state) return { ok: false, code: 'inactive' };
    try {
      const info = inspectOldFile();
      if (info.error) return { ok: false, code: 'read-failed' };
      const old = classifyOldFile(info.missing ? null : info.text);
      // 损坏/未完成迁移的文件一律 fail-closed，不得按 v1 重写覆盖现场
      if (old.schema === 'corrupt' || old.schema === 'v2-incomplete') {
        lastSave.at = now(); lastSave.ok = false; lastSave.code = 'pause-file-invalid';
        return { ok: false, code: 'pause-file-invalid' };
      }
      const sourceSchema = old.schema === 'v2' ? 'v2' : 'v1';
      const next = { ...state, paused: paused === true };
      const serialized = serializeSocialV2(next, {
        mode: writeMode ? 'main' : 'shadow',
        sourceSchema,
        ...(sourceSchema === 'v2' && old.blocks ? { preservedV2Blocks: old.blocks } : {}),
      });
      writeFile(serialized);
      state = next;
      lastSave.at = now(); lastSave.ok = true; lastSave.code = 'pause-saved';
      return { ok: true, code: 'pause-saved' };
    } catch (error) {
      lastSave.at = now(); lastSave.ok = false; lastSave.code = 'pause-write-failed';
      return { ok: false, code: 'pause-write-failed', error: String(error?.message ?? error) };
    }
  }

  function gateEvent(candidate) {
    return evaluateBudgetGate({ state: candidate ?? state, scope: 'event' });
  }

  function makeResetService(options = {}) {
    return createResetService({
      getState: () => state,
      setState: (next) => { state = next; },
      persist: (next) => {
        const result = saveCandidate(next);
        if (!result.ok) throw new Error(result.code);
      },
      memory,
      audit,
      now,
      ...options,
    });
  }

  return {
    flags,
    get enabled() { return configured && active && writeMode; },
    get viewEnabled() { return configured && active; },
    get mode() { return flags.mode; },
    get state() { return state; },
    get adapter() { return adapter; },
    lastSave,
    load,
    candidateFromLegacy,
    shadowSave,
    savePauseState,
    gateSave,
    gateEvent,
    trimConversations,
    coldRelationships,
    saveCandidate,
    makeResetService,
  };
}
