// 桥接接线层单测：入站文本分类 + 事件分发器 + 「消息 → 状态 → 落盘 → 重启恢复」端到端。
//
// 这层是 bridge.js 调用的同一份代码（bridge 只做 4 个调用点）：
//   appendSocialV2Message → dispatchIncoming
//   appendSocialV2Poke    → dispatchPoke
//   recordSentMessagesV2  → dispatchOutgoing
//   proactive 冷落分支    → dispatchNeglect
// 所以这里覆盖的就是真实运行路径（除 DSH/QQ 网络本身）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMoodEventDispatcher,
  classifyIncomingEvent,
  INCOMING_EVENT_RULES,
  NEGLECT_REPEAT_GAP_MS,
  EMOTION_EVENTS,
  RELATIONSHIP_EVENTS,
  MAX_MOOD_EVENTS,
} from '../src/core/mood.mjs';
import {
  canonicalV2Key,
  createConversationStateV2,
  hydrateConversationStateV2,
  serializeSocialV2,
} from '../src/core/socialv2-store.mjs';

const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function makeWorld({ isPaused = () => false } = {}) {
  const conversations = new Map();
  let clock = T0;
  const saves = [];
  const getState = (key) => {
    const k = canonicalV2Key(key);
    if (!k) throw new Error(`非法 key：${key}`);
    let st = conversations.get(k);
    if (!st) {
      st = createConversationStateV2({ cfg: {}, token: `tok-${k}` });
      conversations.set(k, st);
    }
    return st;
  };
  const dispatcher = createMoodEventDispatcher({
    getState,
    peekState: (k) => conversations.get(k) ?? null,
    conversations,
    save: () => saves.push(clock),
    now: () => clock,
    isPaused,
  });
  return {
    conversations,
    dispatcher,
    getState,
    saves,
    tick(ms) { clock += ms; return clock; },
    now() { return clock; },
  };
}

/** 序列化 → hydrate，模拟桥接重启。 */
function reboot(conversations) {
  const saved = serializeSocialV2({ paused: false, conversations, seenForwardIds: new Map() });
  const rebuilt = new Map();
  for (const [key, val] of Object.entries(saved.conversations)) {
    rebuilt.set(key, hydrateConversationStateV2({ key, val, cfg: {}, token: `tok-${key}` }));
  }
  return rebuilt;
}

// ── 分类器：确定性、保守 ──────────────────────────────────────────────────

test('入站文本分类：明确措辞能识别，闲聊不产生事件', () => {
  const cases = [
    ['你好可爱啊', 'praised'],
    ['你真的好棒', 'praised'],
    ['别生气了，对不起', 'makeup'],
    ['抱抱，别难过', 'comforted'],
    ['想你了', 'missed'],
    ['谢谢你', 'thanked'],
    ['滚开', 'quarrel'],
    ['笑死', 'teased'],
    ['离我远点', 'rejected'],
    ['你在跟别人聊天吧', 'jealous'],
    ['你就是个废物', 'insulted'],
    ['好无聊啊，没人说话', 'lonely'],
  ];
  for (const [text, type] of cases) {
    assert.equal(classifyIncomingEvent(text)?.type, type, `「${text}」应识别为 ${type}`);
  }
  // 判不出来就不产生事件（「不能随机贴标签」）
  for (const text of ['今天天气不错', '12345', '', null, undefined, '啊'.repeat(201)]) {
    assert.equal(classifyIncomingEvent(text), null, `「${String(text).slice(0, 20)}」不应产生事件`);
  }
});

test('否定/转折句矩阵：不把明确否定识别成正向事件（审查 P1-1）', () => {
  const cases = [
    // 明确否定 → 映射为负向（不是正向）
    ['我不喜欢你了', 'rejected'],
    ['我不爱你了', 'rejected'],
    ['我不想你了', 'rejected'],
    ['我不接受你的抱歉', 'rejected'],
    ['不原谅你，别再说了', 'rejected'],
    // 转折句以最后的态度为准
    ['别生气了，但我还是不想原谅你', 'rejected'],
    // 无法明确判定 → 不产生事件
    ['才不是想你了', null],
    ['今天真的不怎么样', null],
  ];
  for (const [text, expected] of cases) {
    const got = classifyIncomingEvent(text)?.type ?? null;
    assert.equal(got, expected, `「${text}」应判为 ${expected}，实际 ${got}`);
  }
  // 正向句子不能被误伤
  assert.equal(classifyIncomingEvent('你好可爱啊')?.type, 'praised');
  assert.equal(classifyIncomingEvent('我想你了')?.type, 'missed');
  assert.equal(classifyIncomingEvent('对不起，别生气了')?.type, 'makeup');
  assert.equal(classifyIncomingEvent('别难过，抱抱')?.type, 'comforted');
});

test('分类优先级：和好/安慰优先于争吵，拒绝优先于争吵', () => {
  // 「别生气了」里有「生气」但不是争吵
  assert.equal(classifyIncomingEvent('别生气了')?.type, 'makeup');
  assert.equal(classifyIncomingEvent('别难过，抱抱')?.type, 'comforted');
  assert.equal(classifyIncomingEvent('别烦我')?.type, 'rejected');
  // 规则表自检：关系动作只写关系；其余类型必须同时存在于情绪与关系事件表
  for (const rule of INCOMING_EVENT_RULES) {
    assert.ok(RELATIONSHIP_EVENTS[rule.type], `分类规则 ${rule.type} 不在关系事件表里`);
    if (!rule.relationshipOnly) {
      assert.ok(EMOTION_EVENTS[rule.type], `分类规则 ${rule.type} 不在情绪事件表里`);
    }
  }
  // 关系动作确实声明为 relationshipOnly
  assert.equal(classifyIncomingEvent('你答应我的事呢')?.relationshipOnly, true);
  assert.equal(classifyIncomingEvent('给你了')?.relationshipOnly, true);
});

// ── 入站消息 ──────────────────────────────────────────────────────────────

test('入站被夸：消息 → 情绪 praised + 关系 praised，cause 是原话', () => {
  const w = makeWorld();
  const res = w.dispatcher.dispatchIncoming({
    key: 'private:1234',
    uid: '1234',
    text: '你好可爱啊',
    at: T0,
  });
  assert.equal(res.ok, true);
  assert.equal(res.eventType, 'praised');

  const mood = w.dispatcher.getMood('private:1234');
  assert.equal(mood.known, true);
  assert.equal(mood.causeType, 'praised');
  assert.equal(mood.cause, '你好可爱啊');
  assert.ok(mood.valence > 0, '被夸后情绪应上升');

  const rel = w.dispatcher.getRelationship('1234');
  assert.equal(rel.known, true);
  assert.equal(rel.lastInteraction, T0);
  assert.ok(rel.intimacy > 0.3, '被夸 + 互动后亲密应上升');
  assert.equal(rel.events[rel.events.length - 1].type, 'praised');
  assert.ok(w.saves.length > 0, '写事件后应触发落盘');
});

test('入站闲聊：只记关系互动，不产生情绪事件（不猜情绪）', () => {
  const w = makeWorld();
  const res = w.dispatcher.dispatchIncoming({
    key: 'private:2222',
    uid: '2222',
    text: '今天吃什么',
    at: T0,
  });
  assert.equal(res.ok, true);
  assert.equal(res.eventType, null);
  assert.equal(w.dispatcher.getMood('private:2222').events.length, 0, '闲聊不能产生情绪事件');
  assert.equal(w.dispatcher.getRelationship('2222').events.length, 1);
  assert.equal(w.dispatcher.getRelationship('2222').events[0].type, 'interaction');
});

test('入站群聊：uid 决定关系归属，群消息也记来源会话', () => {
  const w = makeWorld();
  w.dispatcher.dispatchIncoming({ key: 'group:77', uid: '1001', text: '你好棒', directedAtSelf: true, at: T0 });
  w.dispatcher.dispatchIncoming({ key: 'group:77', uid: '1002', text: '你好棒', directedAtSelf: true, at: T0 });
  assert.equal(w.dispatcher.getRelationship('1001').sources[0], 'group:77');
  assert.equal(w.dispatcher.getRelationship('1002').sources[0], 'group:77');
  assert.equal(w.dispatcher.getMood('group:77').causeType, 'praised');
  // 第二条消息（同一时刻）不重复计入同一个人
  assert.equal(w.dispatcher.getRelationship('1001').events.length, 2);
});

// ── 拍一拍 ────────────────────────────────────────────────────────────────

test('拍一拍：拍到自己才算被拍情绪事件，拍别人只记互动', () => {
  const w = makeWorld();
  w.dispatcher.dispatchPoke({ key: 'group:5', uid: '3001', targetIsSelf: true, at: T0 });
  const mood = w.dispatcher.getMood('group:5');
  assert.equal(mood.causeType, 'poked');
  assert.ok(mood.valence > 0);

  w.tick(1000);
  w.dispatcher.dispatchPoke({ key: 'group:5', uid: '3002', targetIsSelf: false, at: T0 + 1000 });
  assert.equal(w.dispatcher.getMood('group:5').causeType, 'poked', '拍别人不改情绪');
  assert.equal(w.dispatcher.getRelationship('3002').known, true, '拍别人仍记一次互动');
});

// ── 出站 ──────────────────────────────────────────────────────────────────

test('出站消息：私聊记关系互动、群聊跳过、都不改情绪', () => {
  const w = makeWorld();
  w.dispatcher.dispatchOutgoing({ key: 'private:4001', at: T0 });
  const rel = w.dispatcher.getRelationship('4001');
  assert.equal(rel.known, true);
  assert.equal(rel.events[0].type, 'interaction');
  assert.equal(w.dispatcher.getMood('private:4001').events.length, 0, '自己说话不该改情绪');

  const group = w.dispatcher.dispatchOutgoing({ key: 'group:9', at: T0 });
  assert.equal(group.skipped, 'group');
});

// ── 冷落 ──────────────────────────────────────────────────────────────────

test('冷落：只记一次，3 小时内不重复涨张力', () => {
  const w = makeWorld();
  const first = w.dispatcher.dispatchNeglect({ key: 'private:5001', at: T0 });
  assert.equal(first.ok, true);
  assert.equal(first.eventType, 'ignored');
  assert.ok(w.dispatcher.getMood('private:5001').valence < 0);

  const again = w.dispatcher.dispatchNeglect({ key: 'private:5001', at: T0 + 1000 });
  assert.equal(again.skipped, 'recent_neglect');
  const tensionBefore = w.dispatcher.getRelationship('5001').tension;

  w.tick(NEGLECT_REPEAT_GAP_MS);
  const later = w.dispatcher.dispatchNeglect({ key: 'private:5001', at: T0 + NEGLECT_REPEAT_GAP_MS });
  assert.equal(later.ok, true);
  assert.ok(w.dispatcher.getRelationship('5001').tension > tensionBefore, '过了去重窗口才再次累积张力');
});

// ── 时序 / 失败策略 ───────────────────────────────────────────────────────

test('分发器 stale 预检：晚到的消息两边都不写', () => {
  const w = makeWorld();
  w.dispatcher.dispatchIncoming({ key: 'private:6001', uid: '6001', text: '你好棒', at: T0 });
  const moodBefore = w.dispatcher.getMood('private:6001');
  const relBefore = w.dispatcher.getRelationship('6001');
  const savesBefore = w.saves.length;

  // 补报一条比当前锚点更早的消息：两边都不能写
  const res = w.dispatcher.dispatchIncoming({ key: 'private:6001', uid: '6001', text: '你好棒', at: T0 - 1000 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'stale_event');
  assert.deepEqual(w.dispatcher.getMood('private:6001').raw, moodBefore.raw);
  assert.equal(w.dispatcher.getRelationship('6001').events.length, relBefore.events.length, '关系也不能只写一边');
  assert.equal(w.saves.length, savesBefore);
});

test('端到端：一条入站消息改变情绪与关系，重启后仍然存在', () => {
  const w = makeWorld();
  w.dispatcher.dispatchIncoming({ key: 'private:7001', uid: '7001', text: '你真的好温柔', at: T0 });
  const moodBefore = w.dispatcher.getMood('private:7001');
  const relBefore = w.dispatcher.getRelationship('7001');
  assert.equal(moodBefore.causeType, 'praised');
  assert.ok(moodBefore.valence > 0);

  const rebuilt = reboot(w.conversations);
  const dispatcher2 = createMoodEventDispatcher({
    peekState: (k) => rebuilt.get(k) ?? null,
    conversations: rebuilt,
    save: () => {},
    now: () => T0 + HOUR,
  });
  const moodAfter = dispatcher2.getMood('private:7001');
  const relAfter = dispatcher2.getRelationship('7001');
  assert.equal(moodAfter.causeType, 'praised', '重启后情绪来源还在');
  assert.equal(moodAfter.cause, '你真的好温柔');
  assert.ok(moodAfter.events.length >= 1);
  // 重启后按持久化的 since 继续衰减：1 小时后 = raw * 0.5^(1h/半衰期)
  const expected = moodBefore.valence * Math.pow(0.5, HOUR / moodBefore.decayHalfLifeMs);
  assert.ok(Math.abs(moodAfter.valence - expected) < 1e-9, '重启后按持久化的 since 继续衰减');
  assert.ok(Math.abs(relAfter.intimacy - relBefore.intimacy) < 1e-9, '重启后关系值恢复');
  assert.equal(relAfter.lastInteraction, T0);
});

test('端到端：冷落 → 重新互动能降低张力（关系事件链路完整）', () => {
  const w = makeWorld();
  w.dispatcher.dispatchNeglect({ key: 'private:8001', at: T0 });
  const tense = w.dispatcher.getRelationship('8001').tension;
  assert.ok(tense > 0);

  w.tick(HOUR);
  w.dispatcher.dispatchIncoming({ key: 'private:8001', uid: '8001', text: '别生气了，对不起', at: T0 + HOUR });
  const calm = w.dispatcher.getRelationship('8001');
  assert.ok(calm.tension < tense, '和好事件应降低张力');
  assert.equal(w.dispatcher.getMood('private:8001').causeType, 'makeup');
});

// ── 否定句真实路径：不能把情绪推向相反方向 ──────────────────────────────

test('真实路径：否定句不会把情绪推向相反方向（审查 P1-1）', () => {
  const w = makeWorld();
  // 连续发三条明确否定的话
  for (const text of ['我不喜欢你了', '我不想你了', '我不接受你的抱歉']) {
    w.tick(1000);
    w.dispatcher.dispatchIncoming({ key: 'private:9001', uid: '9001', text, at: w.now() });
  }
  const mood = w.dispatcher.getMood('private:9001');
  assert.ok(mood.valence < 0, `否定句后情绪应为负，实际 ${mood.valence}`);
  assert.equal(mood.causeType, 'rejected', '应记为被拒绝，而不是被夸/被想念/和好');
  // cause 里不能出现正向事件类型
  for (const event of mood.events) {
    assert.notEqual(event.type, 'praised');
    assert.notEqual(event.type, 'missed');
    assert.notEqual(event.type, 'makeup');
  }
  const rel = w.dispatcher.getRelationship('9001');
  assert.ok(rel.tension > 0, '否定句应积累张力');
});

test('分类反例：修饰否定 / 双否定 / 询问句 / 非 AI 指向都不产生事件（审查第三轮 P1-2）', () => {
  const cases = [
    ['我没觉得你好可爱', null],       // 分句级否定
    ['我不是很喜欢你', null],         // 分句级否定（不是）
    ['我不是不想你', null],           // 双重否定：语义反转，不猜
    ['你做完了吗', null],             // 询问句：不是「做完了」
    ['垃圾游戏真难玩', null],         // 不是对 AI 的贬低
    ['好无聊的剧情', null],           // 评价剧情，不是冷场
  ];
  for (const [text, expected] of cases) {
    const got = classifyIncomingEvent(text)?.type ?? null;
    assert.equal(got, expected, `「${text}」应判为 ${expected}，实际 ${got}`);
  }
  // 真实路径同样不能产生事件（只记互动）
  const w = makeWorld();
  for (const [text] of cases) {
    w.tick(1000);
    w.dispatcher.dispatchIncoming({ key: 'private:9300', uid: '9300', text, at: w.now() });
  }
  assert.equal(w.dispatcher.getMood('private:9300').events.length, 0, '这些句子都不能产生情绪事件');
});

// ── 需求事件的生产入口：jealous / insulted / lonely / openLoop / closeLoop ──

test('生产入口：jealous / insulted / lonely 都可由入站文本产生', () => {
  const w = makeWorld();
  w.dispatcher.dispatchIncoming({ key: 'private:9101', uid: '9101', text: '你在跟别人聊天吧', at: T0 });
  assert.equal(w.dispatcher.getMood('private:9101').causeType, 'jealous');

  w.tick(1000);
  w.dispatcher.dispatchIncoming({ key: 'private:9102', uid: '9102', text: '你就是个废物', at: T0 + 1000 });
  assert.equal(w.dispatcher.getMood('private:9102').causeType, 'insulted');

  w.tick(1000);
  w.dispatcher.dispatchIncoming({ key: 'private:9103', uid: '9103', text: '好无聊啊，没人说话', at: T0 + 2000 });
  assert.equal(w.dispatcher.getMood('private:9103').causeType, 'lonely');
});

test('生产入口：openLoop / closeLoop 可由入站文本产生（审查 P1-2）', () => {
  const w = makeWorld();
  w.dispatcher.dispatchIncoming({ key: 'private:9201', uid: '9201', text: '你答应我的事呢', at: T0 });
  const afterOpen = w.dispatcher.getRelationship('9201');
  assert.equal(afterOpen.openLoops.length, 1, '入站约定应记入 openLoops');
  assert.ok(afterOpen.openLoops[0].text.includes('答应'), 'loop 文本来自消息原文');
  // 关系事件必须同时留下 interaction 与 openLoop 两条来源记录
  assert.deepEqual(afterOpen.events.map((e) => e.type).sort(), ['interaction', 'openLoop']);
  // 情绪不应该被 openLoop 改变
  assert.equal(w.dispatcher.getMood('private:9201').events.length, 0, '关系动作不写情绪');

  w.tick(1000);
  const closed = w.dispatcher.dispatchIncoming({ key: 'private:9201', uid: '9201', text: '给你了', at: T0 + 1000 });
  assert.equal(closed.eventType, 'closeLoop');
  const afterClose = w.dispatcher.getRelationship('9201');
  assert.equal(afterClose.openLoops.length, 0, '说“给你了”应了结最早一件事');
  assert.ok(afterClose.events.some((e) => e.type === 'closeLoop'), '成功关闭必须留下 closeLoop 来源事件');

  // 没有任何未了结事项时，closeLoop 明确拒绝，且**什么都不写**（审查第三轮 P1）
  w.tick(1000);
  const beforeFail = w.dispatcher.getRelationship('9201');
  const savesBefore = w.saves.length;
  const nothing = w.dispatcher.dispatchIncoming({ key: 'private:9201', uid: '9201', text: '给你了', at: T0 + 2000 });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.reason, 'loop_not_found');
  const afterFail = w.dispatcher.getRelationship('9201');
  assert.equal(afterFail.intimacy, beforeFail.intimacy, '未命中不能改变 intimacy（连 interaction 都不能写）');
  assert.equal(afterFail.tension, beforeFail.tension, '未命中不能改变 tension');
  assert.equal(afterFail.lastInteraction, beforeFail.lastInteraction, '未命中不能更新 lastInteraction');
  assert.equal(afterFail.events.length, beforeFail.events.length, '未命中不能新增关系事件');
  assert.equal(w.saves.length, savesBefore, '未命中不能落盘');
});

// ── uid 归属校验（审查 P2-2）──────────────────────────────────────────────

test('群聊方向门控：没指向 AI 的消息不改变情绪与关系（审查 r5 P1）', () => {
  const w = makeWorld();
  // 群友之间的聊天（没有 @/引用 AI）：夸别人、安慰别人、对喷——都不应变成 AI 的情绪
  w.dispatcher.dispatchIncoming({ key: 'group:95', uid: '9501', text: '你好可爱', at: T0 });
  w.dispatcher.dispatchIncoming({ key: 'group:95', uid: '9502', text: '别难过', at: T0 });
  w.dispatcher.dispatchIncoming({ key: 'group:95', uid: '9503', text: '滚开', at: T0 });
  assert.equal(w.dispatcher.getMood('group:95').events.length, 0, '别人之间的聊天不产生群情绪');
  assert.equal(w.dispatcher.getRelationship('9501').known, false, '也不建立关系');
  assert.equal(w.conversations.size, 0, '不创建任何状态');

  // 明确指向 AI（@/引用）才生效
  const directed = w.dispatcher.dispatchIncoming({ key: 'group:95', uid: '9501', text: '你好可爱', directedAtSelf: true, at: T0 });
  assert.equal(directed.eventType, 'praised');
  assert.equal(w.dispatcher.getMood('group:95').causeType, 'praised');
  assert.equal(w.dispatcher.getRelationship('9501').known, true);

  // 私聊不传 directedAtSelf 也照常处理（私聊天然是对她说的）
  const priv = w.dispatcher.dispatchIncoming({ key: 'private:9601', uid: '9601', text: '你好可爱', at: T0 });
  assert.equal(priv.eventType, 'praised');
});

test('刷屏冷却：同类事件 30s 内只应用一次，不能把状态打满（审查 r5 P1 / r6 P1）', () => {
  const w = makeWorld();
  // 每秒发一次，共 30 次：冷却账本必须让 30 秒内只应用 1 次（不能被 12 条关系事件上限挤出）
  for (let i = 0; i < 30; i += 1) {
    w.tick(1000);
    w.dispatcher.dispatchIncoming({ key: 'private:9701', uid: '9701', text: '你好可爱', at: w.now() });
  }
  const mood = w.dispatcher.getMood('private:9701');
  const praisedCount = mood.events.filter((event) => event.type === 'praised').length;
  assert.equal(praisedCount, 1, `30 秒内 praised 应恰好应用 1 次，实际 ${praisedCount} 次`);
  assert.ok(mood.valence < 0.8, `刷屏 30 次不应把情绪打满，实际 ${mood.valence}`);
  const rel = w.dispatcher.getRelationship('9701');
  assert.ok(rel.intimacy < 0.5, `刷屏 30 次不应把亲密打满，实际 ${rel.intimacy}`);

  // 冷却期间返回 skipped，但 interaction 仍然记录（消息本身是真实互动）
  const skipped = w.dispatcher.dispatchIncoming({ key: 'private:9701', uid: '9701', text: '你好可爱', at: w.now() });
  assert.equal(skipped.skipped, 'cooldown');

  // 31 秒边界后才允许第二次
  w.tick(1000);
  w.dispatcher.dispatchIncoming({ key: 'private:9701', uid: '9701', text: '你好可爱', at: w.now() });
  const after = w.dispatcher.getMood('private:9701');
  assert.equal(after.events.filter((event) => event.type === 'praised').length, 2, '31 秒后应允许第二次应用');

  // 负向刷屏同理（8 秒 8 次，只应用 1 次）
  for (let i = 0; i < 8; i += 1) {
    w.tick(1000);
    w.dispatcher.dispatchIncoming({ key: 'private:9702', uid: '9702', text: '你就是个废物', at: w.now() });
  }
  const neg = w.dispatcher.getMood('private:9702');
  const insultedCount = neg.events.filter((event) => event.type === 'insulted').length;
  assert.equal(insultedCount, 1, `8 秒内 insulted 应恰好应用 1 次，实际 ${insultedCount} 次`);
  assert.ok(neg.valence > -0.9, `负向刷屏不应打到底，实际 ${neg.valence}`);
});

test('拍一拍同样受同类冷却：20 秒内连续拍自己只应用 1 次（审查 r6 P1）', () => {
  const w = makeWorld();
  for (let i = 0; i < 20; i += 1) {
    w.tick(1000);
    w.dispatcher.dispatchPoke({ key: 'private:9801', uid: '9801', targetIsSelf: true, at: w.now() });
  }
  const mood = w.dispatcher.getMood('private:9801');
  const pokedCount = mood.events.filter((event) => event.type === 'poked').length;
  assert.equal(pokedCount, 1, `20 秒内 poked 应恰好应用 1 次，实际 ${pokedCount} 次`);
  assert.ok(mood.valence < 0.8, `连续拍一拍不应把情绪打满，实际 ${mood.valence}`);
});

test('暂停冻结覆盖所有事件源：消息 / 拍一拍 / 出站 / 冷落（审查 r6 P2）', () => {
  const w = makeWorld({ isPaused: () => true });
  const results = [
    w.dispatcher.dispatchIncoming({ key: 'private:9901', uid: '9901', text: '你好可爱', at: T0 }),
    w.dispatcher.dispatchPoke({ key: 'private:9901', uid: '9901', targetIsSelf: true, at: T0 }),
    w.dispatcher.dispatchOutgoing({ key: 'private:9901', at: T0 }),
    w.dispatcher.dispatchNeglect({ key: 'private:9901', uid: '9901', at: T0 }),
  ];
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 'paused', '暂停时所有事件源都必须跳过');
  }
  // 暂停期间一条状态都不写
  assert.equal(w.conversations.size, 0, '暂停时不应该创建任何会话状态');
  assert.equal(w.saves.length, 0, '暂停时不应该落盘');
});

test('dispatcher uid 校验：显式非法 uid 拒绝，私聊 uid 不一致拒绝', () => {
  const w = makeWorld();
  const savesBefore = w.saves.length;

  const invalid = w.dispatcher.dispatchIncoming({ key: 'group:9', uid: 'bad', text: '你好可爱', at: T0 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid_uid');
  assert.equal(w.conversations.size, 0, '被拒绝时不能创建会话/写状态');
  assert.equal(w.saves.length, savesBefore);

  const mismatch = w.dispatcher.dispatchIncoming({ key: 'private:1', uid: '2', text: '你好', at: T0 });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'uid_mismatch');
  assert.equal(w.dispatcher.getRelationship('2').known, false, '不能把关系写到错误的人身上');
  assert.equal(w.dispatcher.getRelationship('1').known, false);

  // 拍一拍/冷落同规则
  assert.equal(w.dispatcher.dispatchPoke({ key: 'private:1', uid: '2', targetIsSelf: true, at: T0 }).reason, 'uid_mismatch');
  assert.equal(w.dispatcher.dispatchNeglect({ key: 'private:1', uid: 'bad', at: T0 }).reason, 'invalid_uid');
});

test('群聊没有 uid：允许只记情绪，但不创建关系', () => {
  const w = makeWorld();
  const res = w.dispatcher.dispatchIncoming({ key: 'group:91', text: '你好可爱', directedAtSelf: true, at: T0 });
  assert.equal(res.ok, true);
  assert.equal(res.eventType, 'praised');
  assert.equal(w.dispatcher.getMood('group:91').causeType, 'praised', '群情绪仍要记');
  assert.equal(w.conversations.get('group:91').relationships ? Object.keys(w.conversations.get('group:91').relationships).length : 0, 0, '无 uid 不写关系');
});

// ── reset 语义（审查 P2-3：产品契约）──────────────────────────────────────

test('reset 语义：主记录落在群会话时，reset 该群即重置这份关系（产品契约）', () => {
  const w = makeWorld();
  // 首次事件发生在群、且该 QQ 没有私聊会话 → 主记录落在群
  w.dispatcher.dispatchIncoming({ key: 'group:93', uid: '9301', text: '你好棒', directedAtSelf: true, at: T0 });
  assert.deepEqual(w.dispatcher.getRelationship('9301').sources, ['group:93']);

  // 模拟 bridge 的 /reset：删除该会话
  w.conversations.delete('group:93');
  const after = w.dispatcher.getRelationship('9301');
  assert.equal(after.known, false, 'reset 群会清掉落在这里的关系（已确认的产品契约，见 FIX-REPORT）');
  assert.deepEqual(after.openLoops, []);
});

test('情绪事件保留上限 40 条（超过上限只保留最新，重启后仍是 40）', () => {
  const w = makeWorld();
  // 轮换不同事件类型 + 每次推进 60 秒（超过同类事件 30 秒冷却，否则会被 cooldown 跳过）。
  const phrases = ['你好可爱啊', '抱抱，别难过', '想你了', '谢谢你', '笑死'];
  for (let i = 0; i < 60; i += 1) {
    w.dispatcher.dispatchIncoming({
      key: 'private:1001', uid: '1001', text: phrases[i % phrases.length], directedAtSelf: true, at: w.now(),
    });
    w.tick(60 * 1000);
  }
  const events = w.dispatcher.getMood('private:1001').events;
  assert.equal(MAX_MOOD_EVENTS, 40, '上限必须是 40');
  assert.equal(events.length, 40, '超过上限只保留最新 40 条');
  assert.ok(events.every((e) => e && e.at), '事件结构完整');
  // 序列化 → hydrate（模拟重启）后仍是 40 条
  const rebuilt = reboot(w.conversations);
  assert.equal(rebuilt.get('private:1001').mood.events.length, 40, '重启恢复后仍保留 40 条');
});
