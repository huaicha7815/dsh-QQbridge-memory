// socialV2 定时器调度器（从 bridge.js 抽出的 Step 2 剩余部分）。
//
// 这里管理三类定时器：待唤醒（合并窗口）/ 有限睡眠 / 回复检查。
// 关键改动是**时钟与定时器全部可注入**——测试可以用假时钟把「5 分钟后」直接推进过去，
// 而不用真的等。
//
// 另外把原来重复在两处的「会话繁忙 → 暂存 + 5 分钟看门狗」合并成一份（stashBusyWake），
// scheduleWake 和 sendWakePrompt 共用它。以前两份各写一遍，改一边另一边不会同步。
//
// 注意：**调度策略一律保持原值**（合并窗口、看门狗阈值、频率规则），这里只搬家。
import { isTimeBasedWakeV2, wakePriorityV2 } from './socialv2-wake.mjs';

/** 会话繁忙时暂存的唤醒，5 分钟内没被处理就判定卡住并强制解卡。 */
export const WAKE_WATCHDOG_MS = 5 * 60 * 1000;
/** 待唤醒原因队列上限，防止消息洪峰下无限增长。 */
export const MAX_STASHED_WAKES = 20;
/** Node setTimeout 的安全上限；远未来定时器先等到这里再续期。 */
export const MAX_TIMEOUT_MS = 100009;

const defaultSetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
};
const defaultClearTimer = (timer) => clearTimeout(timer);

/**
 * @param {object} deps
 * @param {(key: string) => object} deps.getState  取会话状态（自动建缺省）
 * @param {() => void} deps.save                   落盘
 * @param {object} deps.cfg                        配置对象（引用，属性会变）
 * @param {(key: string) => boolean} deps.isAllowed 当前模式是否允许该会话
 * @param {() => boolean} deps.isPaused            全局是否暂停
 * @param {(key: string, st: object) => boolean} deps.isBusy 会话是否正在跑 turn
 * @param {(key: string, reason: string) => Promise<void>} deps.onWake 真正投递唤醒
 * @param {(key: string) => void} [deps.onUnstick] 解卡钩子（清 busy 标志）
 * @param {() => void} [deps.appendActivity]      活动日志
 * @param {(msg: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {(fn: Function, ms: number) => any} [deps.setTimer]
 * @param {(timer: any) => void} [deps.clearTimer]
 */
export function createScheduler({
  getState,
  save,
  cfg,
  isAllowed = () => true,
  isPaused = () => false,
  isBusy = () => false,
  onWake,
  onUnstick,
  appendActivity = () => {},
  log = () => {},
  now = Date.now,
  setTimer = defaultSetTimer,
  clearTimer = defaultClearTimer,
} = {}) {
  // ── 公共：把「会话繁忙时的唤醒」暂存起来，并挂一次看门狗 ──
  function stashBusyWake(key, reason, st = getState(key)) {
    if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
    const seq = st.lastUnreadSeq || 0;
    if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
      st.pendingWakeReasons.push({ reason, seq });
      if (st.pendingWakeReasons.length > MAX_STASHED_WAKES) {
        st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - MAX_STASHED_WAKES);
      }
    }
    if (!st.pendingWakeWatchdog) {
      st.pendingWakeWatchdog = setTimer(() => {
        st.pendingWakeWatchdog = null;
        const pend = Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons : [];
        if (!pend.length) return;
        const oldest = pend[0] && typeof pend[0] === 'object' ? pend[0] : null;
        if (!oldest) {
          st.pendingWakeReasons = [];
          save();
          return;
        }
        // 时间型唤醒（日记/问候）不看未读是否还在；消息型唤醒要确认那条消息还挂着
        const stillRelevant = isTimeBasedWakeV2(oldest.reason)
          || (Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(oldest.seq)));
        if (!stillRelevant) {
          st.pendingWakeReasons = [];
          save();
          return;
        }
        log(`⚠️ ${key} 暂存唤醒积压 5 分钟仍未处理（${oldest.reason}@seq${oldest.seq}），判定会话被卡住：强制清 busy 标志并补发`);
        appendActivity(`${key} 暂存唤醒积压超时，强制解卡并补发`);
        try { onUnstick?.(key); } catch {}
        st.pendingWakeReasons = [];
        save();
        scheduleWake(key, oldest.reason);
      }, WAKE_WATCHDOG_MS);
    }
    log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
  }

  // ── 待唤醒：合并窗口内不重复排队，按优先级升级原因 ──
  function scheduleWake(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (isPaused()) return;
    if (!isAllowed(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getState(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isBusy(key, st)) {
      stashBusyWake(key, reason, st);
      return;
    }
    cancelReply(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimer(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeTimer = setTimer(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void onWake(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}: ${error?.message ?? error}`));
    }, batchMs);
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  // ── 有限睡眠：到点唤醒；远未来先续期，避免 Node 超时上限导致的提前触发 ──
  function setupSleepTimer(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isAllowed(key)) return;
    const st = getState(key);
    cancelReply(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimer(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (isPaused()) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - now();
    if (delay <= 0) {
      void onWake(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}: ${error?.message ?? error}`));
      return;
    }
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimer(() => {
        st.sleepTimer = null;
        setupSleepTimer(key);
      }, MAX_TIMEOUT_MS);
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimer(() => {
      st.sleepTimer = null;
      void onWake(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  // ── 回复检查：她说完话后如果没有真实唤醒，过一会儿补一刀 ──
  function scheduleReplyCheck(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (isPaused()) return;
    const st = getState(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimer(() => {
      st.replyCheckTimer = null;
      void onWake(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  function cancelReply(key) {
    const st = getState(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimer(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  /** 统一取消该会话的全部定时器（唤醒/睡眠/回复检查/看门狗）。 */
  function cancelTimers(key) {
    let st;
    try { st = getState(key); } catch { return; }
    for (const field of ['pendingWakeTimer', 'sleepTimer', 'replyCheckTimer', 'pendingWakeWatchdog']) {
      if (st[field]) {
        clearTimer(st[field]);
        st[field] = null;
      }
    }
  }

  /** 给控制台/诊断用：当前有哪些待触发。 */
  function pendingInfo(key) {
    let st;
    try { st = getState(key); } catch { return null; }
    return {
      wake: Boolean(st.pendingWakeTimer),
      sleep: Boolean(st.sleepTimer),
      replyCheck: Boolean(st.replyCheckTimer),
      watchdog: Boolean(st.pendingWakeWatchdog),
      stashed: Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.length : 0,
    };
  }

  return { scheduleWake, setupSleepTimer, scheduleReplyCheck, cancelReply, cancelTimers, pendingInfo, stashBusyWake };
}
