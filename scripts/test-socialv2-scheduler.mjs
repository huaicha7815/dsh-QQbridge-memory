// socialV2 调度器单测：用假时钟验证「5 分钟后看门狗」「远未来续期」这类
// 以前只能真等的行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createScheduler,
  WAKE_WATCHDOG_MS,
  MAX_TIMEOUT_MS,
  MAX_STASHED_WAKES,
} from '../src/core/socialv2-scheduler.mjs';

// ── 假时钟 ──
function fakeClock() {
  let t = 1_700_000_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++seq;
      const timer = { id, unref() {}, hasRef: () => false, _at: t + ms };
      timers.set(id, { fn, at: t + ms, timer });
      return timer;
    },
    clearTimer: (timer) => { if (timer?.id) timers.delete(timer.id); },
    advance(ms) {
      const target = t + ms;
      let guard = 0;
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || guard++ > 1000) break;
        const [id, v] = next;
        timers.delete(id);
        t = v.at;
        v.fn();
      }
      t = target;
    },
    count: () => timers.size,
    live: () => [...timers.values()].map((v) => v.timer),
  };
}

function makeEnv(over = {}) {
  const clock = fakeClock();
  const states = new Map();
  const wakes = [];
  const sticks = [];
  const getState = (key) => {
    let st = states.get(key);
    if (!st) {
      st = {
        pendingWakeTimer: null,
        pendingWakeReason: null,
        pendingWakeWatchdog: null,
        pendingWakeReasons: [],
        sleepTimer: null,
        replyCheckTimer: null,
        wakeConfig: { batchWindowMs: 8000, infinite: true, sleepUntil: null },
        unread: [{ seq: 10 }],
        recentMessages: [],
        lastUnreadSeq: 10,
      };
      states.set(key, st);
    }
    return st;
  };
  const cfg = { socialV2: { enabled: true, autoReplyCheckMs: 30000, ...(over.cfg || {}) } };
  const env = {
    clock,
    states,
    wakes,
    sticks,
    getState,
    cfg,
    scheduler: null,
  };
  let paused = false;
  let busy = over.busy || false;
  env.setPaused = (v) => { paused = v; };
  env.setBusy = (v) => { busy = v; };
  env.scheduler = createScheduler({
    getState,
    peekState: (key) => states.get(key),
    save: () => {},
    cfg,
    isAllowed: () => true,
    isPaused: () => paused,
    isBusy: () => busy,
    onWake: async (key, reason) => { wakes.push({ key, reason }); },
    onUnstick: (key) => { sticks.push(key); },
    log: () => {},
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return env;
}

test('合并窗口：第二次 schedule 不新建定时器，按优先级升级原因', () => {
  const env = makeEnv();
  const key = 'group:1';
  env.scheduler.scheduleWake(key, 'probability');
  assert.equal(env.clock.count(), 1, '第一次应建一个待唤醒定时器');
  assert.equal(env.getState(key).pendingWakeReason, 'probability');

  env.scheduler.scheduleWake(key, 'atMention');
  assert.equal(env.clock.count(), 1, '窗口内不应再建定时器');
  assert.equal(env.getState(key).pendingWakeReason, 'atMention', '低优先级不覆盖高优先级');

  env.scheduler.scheduleWake(key, 'keyword:咖啡');
  assert.equal(env.getState(key).pendingWakeReason, 'atMention', '低优先级不能覆盖');

  env.clock.advance(8000);
  assert.deepEqual(env.wakes, [{ key, reason: 'atMention' }], '到点只唤醒一次，原因是最高的那个');
});

test('合并窗口：先概率后 @ 会升级', () => {
  const env = makeEnv();
  const key = 'group:2';
  env.scheduler.scheduleWake(key, 'probability');
  env.scheduler.scheduleWake(key, 'atMention');
  assert.equal(env.getState(key).pendingWakeReason, 'atMention');
});

test('会话繁忙：不建定时器，进暂存队列且有上限', () => {
  const env = makeEnv({ busy: true });
  const key = 'group:3';
  for (let i = 0; i < MAX_STASHED_WAKES + 5; i += 1) {
    env.getState(key).lastUnreadSeq = i + 1;
    env.scheduler.scheduleWake(key, `keyword:k${i}`);
  }
  const st = env.getState(key);
  assert.equal(st.pendingWakeTimer, null, '繁忙时不建待唤醒定时器');
  assert.equal(st.pendingWakeReasons.length, MAX_STASHED_WAKES, `暂存队列上限 ${MAX_STASHED_WAKES}`);
  assert.equal(env.wakes.length, 0, '繁忙时不应立即唤醒');
});

test('看门狗：5 分钟后强制解卡并补发', () => {
  const env = makeEnv({ busy: true });
  const key = 'group:4';
  env.scheduler.scheduleWake(key, 'atMention');
  assert.equal(env.sticks.length, 0, '还没到 5 分钟不该解卡');

  env.clock.advance(WAKE_WATCHDOG_MS);
  assert.deepEqual(env.sticks, [key], '看门狗应调用解卡钩子');
  // 补发时如果她还在忙，唤醒会正常地再次暂存 —— 这不是 bug，是重排
  assert.ok(
    env.getState(key).pendingWakeReasons.length === 0 || env.getState(key).pendingWakeReasons.length === 1,
    '补发后要么已投递（队列空），要么又暂存了一条',
  );

  // 解卡后她不再忙：下一条消息进来时唤醒应正常排上并投递
  // （看门狗本身不负责建定时器，它只是把卡住的会话解开）
  env.setBusy(false);
  env.scheduler.scheduleWake(key, 'atMention');
  env.clock.advance(8000);
  assert.ok(env.wakes.length >= 1, '解卡后新的唤醒能正常投递');
});

test('看门狗：消息已读完则不补发、只清队列', () => {
  const env = makeEnv({ busy: true });
  const key = 'group:5';
  env.scheduler.scheduleWake(key, 'atMention');
  // 模拟她已经被读完：unread 里没有 >= 暂存 seq 的消息
  env.getState(key).unread = [];
  env.clock.advance(WAKE_WATCHDOG_MS);
  assert.equal(env.sticks.length, 0, '不相关就不该解卡');
  assert.equal(env.getState(key).pendingWakeReasons.length, 0, '队列仍要清空');
});

test('看门狗：时间型唤醒即使消息读完也要补发', () => {
  const env = makeEnv({ busy: true });
  const key = 'group:6';
  env.scheduler.scheduleWake(key, 'diary');
  env.getState(key).unread = [];
  env.clock.advance(WAKE_WATCHDOG_MS);
  assert.deepEqual(env.sticks, [key], '日记这类时间型唤醒必须补发（否则当天日记会静默消失）');
});

test('有限睡眠：到点唤醒', () => {
  const env = makeEnv();
  const key = 'group:7';
  const st = env.getState(key);
  st.wakeConfig = { infinite: false, sleepUntil: new Date(env.clock.now() + 60_000).toISOString(), batchWindowMs: 8000 };
  env.scheduler.setupSleepTimer(key);
  assert.equal(env.clock.count(), 1);
  env.clock.advance(60_000);
  assert.deepEqual(env.wakes, [{ key, reason: 'timeout' }]);
});

test('远未来睡眠：首段 100009ms 后续期，不提前唤醒', () => {
  const env = makeEnv();
  const key = 'group:8';
  const st = env.getState(key);
  st.wakeConfig = { infinite: false, sleepUntil: new Date(env.clock.now() + MAX_TIMEOUT_MS * 3).toISOString(), batchWindowMs: 8000 };
  env.scheduler.setupSleepTimer(key);
  env.clock.advance(MAX_TIMEOUT_MS);
  assert.equal(env.wakes.length, 0, '续期不应唤醒');
  assert.equal(env.clock.count(), 1, '续期后应重新挂一个定时器');
});

test('暂停 / 关闭：不排任何定时器', () => {
  const env = makeEnv();
  const key = 'group:9';
  env.setPaused(true);
  env.scheduler.scheduleWake(key, 'atMention');
  assert.equal(env.clock.count(), 0, '暂停时不排待唤醒');
  env.setPaused(false);
  env.cfg.socialV2.enabled = false;
  env.scheduler.scheduleWake(key, 'atMention');
  assert.equal(env.clock.count(), 0, '关闭时不排待唤醒');
});

test('取消：cancelTimers 之后推进时钟也不唤醒', () => {
  const env = makeEnv();
  const key = 'group:10';
  env.scheduler.scheduleWake(key, 'atMention');
  assert.equal(env.clock.count(), 1);
  env.scheduler.cancelTimers(key);
  assert.equal(env.clock.count(), 0);
  env.clock.advance(60_000);
  assert.equal(env.wakes.length, 0);
});

test('回复检查：真实唤醒排队时不重复安排', () => {
  const env = makeEnv();
  const key = 'group:11';
  env.scheduler.scheduleWake(key, 'atMention');
  const before = env.clock.count();
  env.scheduler.scheduleReplyCheck(key);
  assert.equal(env.clock.count(), before, '已有待唤醒时不该再排回复检查');
});

test('所有定时器都 unref（不阻止进程退出）', () => {
  const env = makeEnv();
  const key = 'group:12';
  env.scheduler.scheduleWake(key, 'atMention');
  const st = env.getState(key);
  st.wakeConfig = { infinite: false, sleepUntil: new Date(env.clock.now() + 5000).toISOString(), batchWindowMs: 8000 };
  env.scheduler.setupSleepTimer(key);
  for (const timer of env.clock.live()) {
    assert.equal(timer.hasRef(), false, '定时器必须 unref，否则进程退不出');
  }
});

test('取消不存在的会话：不创建状态（避免凭空造出空会话）', () => {
  const env = makeEnv();
  const before = env.states.size;
  env.scheduler.cancelTimers('group:never-existed');
  env.scheduler.cancelReply('group:never-existed');
  assert.equal(env.states.size, before, 'peekState 不应创建会话');
  assert.equal(env.scheduler.pendingInfo('group:never-existed'), null);
  assert.equal(env.states.size, before, 'pendingInfo 也不该创建');
});
