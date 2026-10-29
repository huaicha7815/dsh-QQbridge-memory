// socialV2 唤醒判定（纯函数层，从 bridge.js 抽出的第二块）。
//
// 这里全是「给定输入 → 输出判定」的纯逻辑：不碰定时器、不写状态、不发网络请求。
// 副作用（真正排定时器、真正叫醒模型）留在 bridge.js。
//
// 拆它的动机：以前要验证「这条消息该不该叫醒她」只能启动整个桥接 + 在群里实测。
// 现在可以给定 triggers + 事件直接断言（见 scripts/test-socialv2-wake.mjs）。
//
// 注意：**行为必须与拆分前逐字节一致**。这里只做搬家，不做策略调整。

/** 唤醒原因 → 优先级（数值越大越优先）。reason 可能带子类型（keyword:小鲸鱼），取冒号前的基名。 */
export const WAKE_PRIORITY = Object.freeze({
  // 时间型唤醒必须高于概率：否则「先排到 probability，后来的 diary 不升级」，
  // 当天的日记/记忆整理就会被当成一次概率唤醒吞掉。
  diary: 95,
  memoryRefine: 94,
  private: 100,
  atMention: 90,
  question: 80,
  speaker: 75,
  nameMention: 70,
  keyword: 60,
  anyMessage: 50,
  replyCheck: 40,
  timeout: 30,
  proactiveCheck: 20,
});

export function wakePriorityV2(reason) {
  const base = String(reason ?? '').split(':')[0];
  return WAKE_PRIORITY[base] ?? 0;
}

// 时间型唤醒：到点就该发生，跟「有没有新未读」无关。
//
// 它们被「会话繁忙」暂存后，补发逻辑原来是用 unread 里是否还有 >= seq 的消息来判断
// 「这条唤醒是不是已经被当前回合顺手处理掉了」。对 @/提问 这类消息型唤醒没问题，
// 对 diary 却是致命的：2026-10-27 23:00 的日记触发时她正在聊天，唤醒被暂存；之后她
// 把消息读完并 mark_read，unread 里就没有更大的 seq 了，补发判定「已处理」直接跳过
// —— 当天的日记和晚安一起消失，而且不会有任何报错。
export const TIME_BASED_WAKE_V2 = new Set(['diary', 'greeting', 'timeout', 'proactiveCheck', 'chatStart', 'memoryRefine']);

export function isTimeBasedWakeV2(reason) {
  return TIME_BASED_WAKE_V2.has(String(reason ?? '').split(':')[0]);
}

/** 这句话是不是在直接针对 AI（点名/挑战/提问/催促）。纯字符串判断。 */
export function isDirectedAtAi(textContent) {
  const lower = String(textContent ?? '').toLowerCase();
  const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
  const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
  const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
  if (aiMention && (question || challenge)) return true;
  // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
  if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
  if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
  // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
  if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
  // 追问/催促：AI 没回时的真人式催促
  if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
  return false;
}

/** 唤醒配置的安全阀：有没有硬触发、有没有定时、有没有概率、确认是否过期。now 可注入。 */
export function computeWakeSafetyV2(wc, now = Date.now()) {
  const tr = wc?.triggers || {};
  const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
    (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
    normalizeSpeakerIds(tr.speakerIds).length > 0;
  const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > now;
  const soft = Number(tr.probability) > 0;
  const guaranteed = hard || timed || soft;
  const confirmedNum = Number(wc?.confirmedAt);
  const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || now - confirmedNum > 24 * 60 * 60 * 1000;
  return { hard, timed, soft, guaranteed, stale };
}

// 只留本地一份极简归一化，避免 core 层反向依赖 store 造成循环 import。
function normalizeSpeakerIds(value) {
  if (value === undefined || value === null) return [];
  const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
  const out = [];
  for (const v of rawList) {
    const s = String(v ?? '').trim();
    if (/^[1-9]\d*$/.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 防「永眠」判定：当前唤醒配置是否至少有一个可触发途径。
 * 拆分前这段逻辑内嵌在 ensureWakeableV2 里，与清理副作用混在一起；现在只做判定。
 */
export function isWakeableV2(wc, now = Date.now()) {
  if (!wc) return false;
  const tr = wc.triggers && typeof wc.triggers === 'object' ? wc.triggers : {};
  const speakerIds = normalizeSpeakerIds(tr.speakerIds);
  const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > now;
  return Boolean(
    wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
    (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question ||
    Number(tr.probability) > 0 || speakerIds.length > 0 || timed,
  );
}

/**
 * 这条消息该不该唤醒她。返回唤醒原因（字符串）或 null。
 *
 * 所有外部依赖都从参数进来：selfNickname（她的昵称）、random（概率唤醒）、
 * isDirected（判断是否直接问她）。这样测试可以固定随机数、不依赖全局状态。
 */
export function evaluateWakeTriggerV2({
  triggers,
  kind,
  event,
  textContent,
  plainContent,
  quoteTargetIsSelf,
  selfNickname,
  random = Math.random,
  isDirected = isDirectedAtAi,
}) {
  if (kind === 'private') return 'private';
  const tr = triggers ?? {};
  if (tr.anyMessage) return 'anyMessage';
  if (tr.atMention) {
    const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
    if (atSelf || quoteTargetIsSelf) return 'atMention';
  }
  if (tr.nameMention && selfNickname) {
    const lower = String(textContent ?? '').toLowerCase();
    if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
  }
  if (Array.isArray(tr.keywords) && tr.keywords.length) {
    const lower = String(plainContent ?? '').toLowerCase();
    for (const kw of tr.keywords) {
      const kwStr = String(kw ?? '').toLowerCase();
      if (!kwStr) continue;
      // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
      if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
        if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
      } else if (lower.includes(kwStr)) {
        return `keyword:${kw}`;
      }
    }
  }
  if (tr.question && isDirected(plainContent)) return 'question';
  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
    const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
    if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
      const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
      return `speaker:${senderLabel}`;
    }
  }
  if (Number(tr.probability) > 0 && random() < Number(tr.probability)) return 'probability';
  return null;
}

// ── 睡眠与「聊两句就潜水」的判定（原来内嵌在 bridge 里，全是纯逻辑）──

/** 对方明确说了结束语（晚安/拜拜/去忙…）。 */
export const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

export function hasExplicitEnd(st) {
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const last = [...recent].reverse().find((m) => m && !m.isSelf);
  if (!last) return false;
  return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
}

/** diving 且不是 anyMessage 都视为「沉睡/潜水」，需要先观察才能再睡。 */
export function isSleepingConfig(wc) {
  if (!wc) return false;
  if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
  return true;
}

/**
 * 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
 *
 * 规则（与原实现一致）：
 * 1. 对方说了结束语 → 不再拦；
 * 2. 已经连续安静满观察窗口 → 放行；
 * 3. 已经完整等过窗口且之后没有新消息 → 放行；
 * 4. 已经做过一次观察（可能等到了新消息并已返回给 AI），之后 AI 没参与、也没有更新消息 → 放行；
 * 5. 其余情况拦下。
 */
export function preSleepWaitBlocked(st, wakeCfg, now = Date.now()) {
  if (!st) return false;
  const w = wakeCfg ?? {};
  if (w.preSleepWaitEnabled === false) return false;
  if (hasExplicitEnd(st)) return false;
  const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
  // 已经连续安静满观察窗口：可以直接设置潜水。
  if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
  // 已经完整等过观察窗口且之后没有新消息：放行。
  if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
  // 已经做过一次沉睡前观察，只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
  if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
  return true;
}
