// socialV2 会话状态的数据层（从 bridge.js 抽出的第一块）。
//
// 这里只做「纯数据」的事：状态长什么样、怎么从落盘数据重建、怎么序列化回去。
// **不碰定时器、不碰网络、不碰 bridge 内部函数**——副作用全部留在 bridge.js，
// 所以这个文件可以单独 import 起来写单测（见 scripts/test-socialv2-store.mjs）。
//
// 拆它的动机：`getSocialV2State` 在 bridge 里被调用 51 次、`saveSocialV2State` 49 次，
// 状态有 24 个字段（含 4 个 setTimeout 句柄）。以前「哪条字段会落盘」只能靠读
// saveSocialV2State 的实现猜，现在序列化白名单就写在 serializeSocialV2 里。

/** 会话 key 规范化：`group:0123` → `group:123`；非法返回 null。 */
export function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

/** 归一化「指定群友发言唤醒」名单：只留正整数 QQ 号、去重、最多 20 个。 */
export function normalizeSpeakerIdsV2(value) {
  if (value === undefined || value === null) return [];
  const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
  const seen = new Set();
  const clean = [];
  for (const v of rawList) {
    const s = String(v ?? '').trim();
    if (!/^[1-9]\d*$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    clean.push(s);
    if (clean.length >= 20) break;
  }
  return clean;
}

/**
 * 默认唤醒配置。cfg 传 `config.socialV2.wake`（不是整个 config）。
 * random 可注入（测试里给固定值，避免有限睡眠时长随机导致断言不稳）。
 */
export function defaultWakeConfigV2(cfg, random = Math.random) {
  const w = cfg ?? {};
  const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
  const defaultInfinite = w.recommendedDefaultInfinite !== false;
  const recMin = Number(w.recommendedSleepMinMs) || 300000;
  const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
  let finiteMs = recMin + random() * Math.max(0, recMax - recMin);
  const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
  const hardMax = Number(w.sleepMaxMs) || 0;
  if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
  if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
  return {
    mode: defaultMode,
    infinite: defaultInfinite,
    sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
    triggers: {
      atMention: w.recommendedAtMention !== false,
      nameMention: w.recommendedNameMention !== false,
      speakerIds: [],
      keywords: [],
      question: w.recommendedQuestion !== false,
      poke: w.recommendedPoke !== false,
      probability: Number.isFinite(Number(w.recommendedProbability)) ? Number(w.recommendedProbability) : 0,
      anyMessage: false,
    },
    batchWindowMs: Number(w.recommendedBatchWindowMs) || 12000,
  };
}

/**
 * 新建一个会话状态。注意：4 个 `*Timer` 字段**不会**落盘（见 serializeSocialV2），
 * 它们是 setTimeout 句柄，序列化白名单里没有它们。
 */
export function createConversationStateV2({ cfg, random = Math.random, token }) {
  return {
    wakeConfig: defaultWakeConfigV2(cfg, random),
    recentMessages: [],
    unread: [],
    lastWakeReason: '',
    lastAiReplyAt: 0,
    lastActionAt: 0,
    agentToken: String(token),
    bootstrapSent: false,
    wakeTimes: [],
    sendTimes: [],
    stickerCollectTimes: [],
    pendingWakeTimer: null,
    sleepTimer: null,
    replyCheckTimer: null,
    proactiveTimer: null,
    lastIncomingAt: 0,
    preSleepWaitSatisfiedAt: 0,
    preSleepWaitObservedAt: 0,
    preSleepWaitAccumMs: 0,
    lastUnreadSeq: 0,
    lastReadThroughSeq: 0,
    modelSeenSeqs: new Set(),
    activeTopics: [],
    pendingThoughts: [],
    memberImpressions: {},
  };
}

/**
 * 从落盘数据重建会话状态。所有归一化规则集中在这里，加载与新建走同一套字段定义。
 * - memberImpressions 过滤 `__proto__ / constructor / prototype`（防原型污染）
 * - lastReadThroughSeq 不允许超过 lastUnreadSeq
 * - 私聊会话的 speakerIds 强制清空（私聊没有「指定群友」概念）
 */
export function hydrateConversationStateV2({ key, val, cfg, random = Math.random, token }) {
  const defaultWc = defaultWakeConfigV2(cfg, random);
  const st = {
    wakeConfig: {
      ...defaultWc,
      ...(val.wakeConfig ?? {}),
      triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) },
    },
    recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
    unread: Array.isArray(val.unread) ? val.unread : [],
    lastWakeReason: String(val.lastWakeReason ?? ''),
    lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
    lastActionAt: Number(val.lastActionAt) || 0,
    agentToken: String(token),
    bootstrapSent: !!val.bootstrapSent,
    wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
    sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
    stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
    pendingWakeTimer: null,
    sleepTimer: null,
    replyCheckTimer: null,
    proactiveTimer: null,
    lastIncomingAt: Number(val.lastIncomingAt) || 0,
    preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
    preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
    preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
    lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
    lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
      ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0)
      : 0,
    modelSeenSeqs: new Set(),
    activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
    pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
    memberImpressions: (() => {
      const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
      const clean = {};
      for (const [k, v] of Object.entries(rawImp)) {
        if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
        clean[k] = v;
      }
      return clean;
    })(),
  };
  // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
  if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
    st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
    if (String(key).startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
  }
  return st;
}

/**
 * 序列化成落盘对象。
 *
 * **这张表就是白名单**：只有列在这里的字段会写进 `state/social-v2.json`。
 * 新增字段时如果忘了加进来，重启后就会丢——所以配套单测会断言
 * 「新建状态里所有非 Timer 字段都能 round-trip」。
 */
export function serializeSocialV2({ paused, conversations, seenForwardIds }) {
  const obj = { paused: !!paused, conversations: Object.create(null) };
  for (const [key, st] of conversations) {
    obj.conversations[key] = {
      wakeConfig: st.wakeConfig,
      recentMessages: st.recentMessages.slice(-200),
      unread: st.unread.slice(-100),
      lastWakeReason: st.lastWakeReason,
      lastAiReplyAt: st.lastAiReplyAt,
      lastActionAt: st.lastActionAt,
      agentToken: st.agentToken,
      bootstrapSent: st.bootstrapSent,
      wakeTimes: st.wakeTimes.slice(-200),
      sendTimes: st.sendTimes.slice(-500),
      stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
      lastIncomingAt: st.lastIncomingAt || 0,
      preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
      preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
      preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
      lastUnreadSeq: st.lastUnreadSeq || 0,
      lastReadThroughSeq: st.lastReadThroughSeq || 0,
      activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
      pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
      memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
      seenForwardIds: Array.from(seenForwardIds?.get?.(key) || []).slice(-1000),
    };
  }
  return obj;
}

/** 落盘白名单（给测试和文档用；与 serializeSocialV2 必须保持一致）。 */
export const PERSISTED_FIELDS = Object.freeze([
  'wakeConfig', 'recentMessages', 'unread', 'lastWakeReason', 'lastAiReplyAt', 'lastActionAt',
  'agentToken', 'bootstrapSent', 'wakeTimes', 'sendTimes', 'stickerCollectTimes',
  'lastIncomingAt', 'preSleepWaitSatisfiedAt', 'preSleepWaitObservedAt', 'preSleepWaitAccumMs',
  'lastUnreadSeq', 'lastReadThroughSeq', 'activeTopics', 'pendingThoughts', 'memberImpressions',
  'seenForwardIds',
]);

/** 运行时句柄：绝不能落盘。 */
export const RUNTIME_ONLY_FIELDS = Object.freeze([
  'pendingWakeTimer', 'sleepTimer', 'replyCheckTimer', 'proactiveTimer', 'modelSeenSeqs',
]);

/**
 * 刷新「仍在使用默认唤醒配置」的会话（confirmedBy === 'default'）。
 * AI 或管理员显式设置过的不会被覆盖——这是原实现的语义，别改。
 * 返回 true 表示确实改了。
 */
export function refreshDefaultWakeConfig(st, cfg, random = Math.random) {
  if (!st || !st.wakeConfig) return false;
  if (st.wakeConfig.confirmedBy !== 'default') return false;
  const def = defaultWakeConfigV2(cfg, random);
  const old = st.wakeConfig;
  st.wakeConfig = {
    ...def,
    lastWakeAt: old.lastWakeAt || 0,
    wakeCount: old.wakeCount || 0,
    noActionCount: old.noActionCount || 0,
    confirmedAt: old.confirmedAt || 0,
    confirmedBy: 'default',
  };
  return true;
}
