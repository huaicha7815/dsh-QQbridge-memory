// socialV2 唤醒判定单测（Step 2 的纯函数部分）。
//
// 这一层的价值：以前验证「这条消息该不该叫醒她」只能启动整个桥接 + 在群里实测；
// 现在给定 triggers + 事件就能断言结果，随机数还能固定。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WAKE_PRIORITY,
  TIME_BASED_WAKE_V2,
  wakePriorityV2,
  isTimeBasedWakeV2,
  isDirectedAtAi,
  computeWakeSafetyV2,
  isWakeableV2,
  evaluateWakeTriggerV2,
} from '../src/core/socialv2-wake.mjs';

const base = (triggers = {}) => ({ triggers });
const ev = (over = {}) => ({ user_id: '111', sender: { nickname: '小鱼' }, message: [], self_id: '999', ...over });

test('唤醒优先级：基名查表，子类型不影响', () => {
  assert.equal(wakePriorityV2('private'), 100);
  assert.equal(wakePriorityV2('atMention'), 90);
  assert.equal(wakePriorityV2('keyword:小鲸鱼'), WAKE_PRIORITY.keyword);
  assert.equal(wakePriorityV2('speaker:小鱼'), WAKE_PRIORITY.speaker);
  assert.equal(wakePriorityV2('probability'), 0, '概率唤醒不在表里，默认 0');
  assert.equal(wakePriorityV2(undefined), 0);
});

test('时间型唤醒：日记/问候/超时/主动检查/开聊', () => {
  for (const r of ['diary', 'greeting', 'timeout', 'proactiveCheck', 'chatStart']) {
    assert.ok(isTimeBasedWakeV2(r), `${r} 应算时间型`);
  }
  assert.ok(isTimeBasedWakeV2('diary:2026-10-28'), '带子类型也算');
  assert.ok(!isTimeBasedWakeV2('atMention'), '@ 唤醒不是时间型（它依赖未读）');
  assert.ok(!isTimeBasedWakeV2('keyword:你好'));
  assert.equal(TIME_BASED_WAKE_V2.size, 5);
});

test('是否直接针对 AI：正例', () => {
  const yes = [
    '你是ai吗',
    '你有claude一半强吗',
    'deepseek 你行不行',
    '小鲸鱼在不在',
    '你怎么不说话',
    '你比gpt强吗',
    '机器人是不是又卡了',
    '你是真人还是模型',
  ];
  for (const t of yes) assert.ok(isDirectedAtAi(t), `应判为直接问：${t}`);
});

test('是否直接针对 AI：反例（日常闲聊不误伤）', () => {
  const no = [
    '今天天气不错',
    '我去吃饭了',
    '哈哈哈',
    '这个视频好看',
    '明天考试好紧张',
  ];
  for (const t of no) assert.ok(!isDirectedAtAi(t), `不该判为直接问：${t}`);
});

test('安全阀：硬触发 / 定时 / 概率 / 确认过期', () => {
  const now = 1_800_000_000_000;
  const active = computeWakeSafetyV2({ mode: 'active' }, now);
  assert.equal(active.hard, true);
  assert.equal(active.guaranteed, true);

  const timedWc = { infinite: false, sleepUntil: new Date(now + 60_000).toISOString() };
  const timed = computeWakeSafetyV2(timedWc, now);
  assert.equal(timed.timed, true, '未来时间点算定时');
  assert.equal(computeWakeSafetyV2({ infinite: false, sleepUntil: new Date(now - 60_000).toISOString() }, now).timed, false, '过去的时点不算');

  const soft = computeWakeSafetyV2({ triggers: { probability: 0.2 } }, now);
  assert.equal(soft.soft, true);

  const fresh = computeWakeSafetyV2({ confirmedAt: now - 1000 }, now);
  assert.equal(fresh.stale, false, '刚确认过不算过期');
  const stale = computeWakeSafetyV2({ confirmedAt: now - 25 * 3600 * 1000 }, now);
  assert.equal(stale.stale, true, '超过 24 小时算过期');
  assert.equal(computeWakeSafetyV2({}, now).stale, true, '从没确认过也算过期');
});

test('防永眠判定：有任一触发途径就算可唤醒', () => {
  const now = 1_800_000_000_000;
  assert.ok(isWakeableV2({ mode: 'active' }, now));
  assert.ok(isWakeableV2({ triggers: { atMention: true } }, now));
  assert.ok(isWakeableV2({ triggers: { keywords: ['咖啡'] } }, now));
  assert.ok(isWakeableV2({ triggers: { speakerIds: ['123'] } }, now));
  assert.ok(isWakeableV2({ triggers: { probability: 0.01 } }, now));
  assert.ok(isWakeableV2({ infinite: false, sleepUntil: new Date(now + 60_000).toISOString() }, now), '未到点的定时也算');
  assert.ok(!isWakeableV2({ mode: 'diving', infinite: true, triggers: {} }, now), '什么触发都没有 = 会永眠');
  assert.ok(!isWakeableV2(null, now));
});

test('唤醒判定：私聊/任意消息/@/叫名字/关键词/提问/指定群友/概率', () => {
  const fixed = () => 0.1;
  // 私聊永远唤醒
  assert.equal(evaluateWakeTriggerV2({ triggers: {}, kind: 'private', event: ev(), selfNickname: '鱼鱼', random: fixed }), 'private');
  // anyMessage
  assert.equal(evaluateWakeTriggerV2({ triggers: { anyMessage: true }, kind: 'group', event: ev(), selfNickname: '鱼鱼', random: fixed }), 'anyMessage');
  // @ 她
  const atEv = ev({ message: [{ type: 'at', data: { qq: '999' } }] });
  assert.equal(evaluateWakeTriggerV2({ triggers: { atMention: true }, kind: 'group', event: atEv, selfNickname: '鱼鱼', random: fixed }), 'atMention');
  // 引用她
  assert.equal(evaluateWakeTriggerV2({ triggers: { atMention: true }, kind: 'group', event: ev(), quoteTargetIsSelf: true, selfNickname: '鱼鱼', random: fixed }), 'atMention');
  // 叫名字
  assert.equal(evaluateWakeTriggerV2({ triggers: { nameMention: true }, kind: 'group', event: ev(), textContent: '鱼鱼你在吗', selfNickname: '鱼鱼', random: fixed }), 'nameMention');
  // 关键词（带子类型）
  assert.equal(evaluateWakeTriggerV2({ triggers: { keywords: ['咖啡'] }, kind: 'group', event: ev(), plainContent: '今天喝咖啡了', selfNickname: '鱼鱼', random: fixed }), 'keyword:咖啡');
  // 短英文关键词走词边界：ADS 不应命中 DS
  assert.equal(evaluateWakeTriggerV2({ triggers: { keywords: ['DS'] }, kind: 'group', event: ev(), plainContent: 'ADS 广告', selfNickname: '鱼鱼', random: fixed }), null);
  assert.equal(evaluateWakeTriggerV2({ triggers: { keywords: ['DS'] }, kind: 'group', event: ev(), plainContent: 'DS 好用吗', selfNickname: '鱼鱼', random: fixed }), 'keyword:DS');
  // 直接提问
  assert.equal(evaluateWakeTriggerV2({ triggers: { question: true }, kind: 'group', event: ev(), plainContent: '你是ai吗', selfNickname: '鱼鱼', random: fixed }), 'question');
  // 指定群友
  assert.equal(evaluateWakeTriggerV2({ triggers: { speakerIds: ['111'] }, kind: 'group', event: ev(), selfNickname: '鱼鱼', random: fixed }), 'speaker:小鱼');
  // 概率：random 固定为 0.1 < 0.5 → 命中
  assert.equal(evaluateWakeTriggerV2({ triggers: { probability: 0.5 }, kind: 'group', event: ev(), selfNickname: '鱼鱼', random: () => 0.1 }), 'probability');
  // 概率不命中
  assert.equal(evaluateWakeTriggerV2({ triggers: { probability: 0.5 }, kind: 'group', event: ev(), selfNickname: '鱼鱼', random: () => 0.9 }), null);
  // 什么都没有
  assert.equal(evaluateWakeTriggerV2({ triggers: {}, kind: 'group', event: ev(), selfNickname: '鱼鱼', random: fixed }), null);
});

test('唤醒判定：什么都没配时不会误唤醒', () => {
  const fixed = () => 0.99;
  assert.equal(evaluateWakeTriggerV2({ triggers: {}, kind: 'group', event: ev(), textContent: '鱼鱼', plainContent: '你是ai吗', selfNickname: '鱼鱼', random: fixed }), null);
});
