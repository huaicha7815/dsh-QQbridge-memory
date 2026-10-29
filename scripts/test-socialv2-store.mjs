// socialV2 状态数据层单测（Step 1）。
//
// 这一层是纯函数，所以终于可以「给定状态断言结果」，不用启动整个桥接。
// 重点覆盖三件事：key 规范化、落盘白名单、旧数据重建的归一化规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalV2Key,
  normalizeSpeakerIdsV2,
  defaultWakeConfigV2,
  createConversationStateV2,
  hydrateConversationStateV2,
  serializeSocialV2,
  PERSISTED_FIELDS,
  RUNTIME_ONLY_FIELDS,
} from '../src/core/socialv2-store.mjs';

test('key 规范化：前导零、非法值', () => {
  assert.equal(canonicalV2Key('group:0123'), 'group:123');
  assert.equal(canonicalV2Key('private:0001'), 'private:1');
  assert.equal(canonicalV2Key(' group:42 '), 'group:42');
  assert.equal(canonicalV2Key('group:0'), null, '0 不合法');
  assert.equal(canonicalV2Key('group:-1'), null);
  assert.equal(canonicalV2Key('user:123'), null, '前缀只能是 group/private');
  assert.equal(canonicalV2Key(''), null);
  assert.equal(canonicalV2Key(null), null);
});

test('指定群友名单：只留正整数、去重、最多 20 个', () => {
  assert.deepEqual(normalizeSpeakerIdsV2(['1', '2', '2', 'abc', '0', '-3', null]), ['1', '2']);
  assert.deepEqual(normalizeSpeakerIdsV2('111,222 333，444'), ['111', '222', '333', '444']);
  assert.deepEqual(normalizeSpeakerIdsV2(undefined), []);
  const many = Array.from({ length: 30 }, (_, i) => String(i + 1));
  assert.equal(normalizeSpeakerIdsV2(many).length, 20, '最多 20 个');
});

test('默认唤醒配置：随机源可注入、硬边界生效', () => {
  const cfg = {
    defaultMode: 'active',
    recommendedDefaultInfinite: false,
    recommendedSleepMinMs: 1000,
    recommendedSleepMaxMs: 5000,
    sleepMinMs: 2000,
    sleepMaxMs: 3000,
    recommendedAtMention: false,
    recommendedPoke: false,
    recommendedProbability: 0.3,
  };
  const w = defaultWakeConfigV2(cfg, () => 0.5);
  assert.equal(w.mode, 'active');
  assert.equal(w.infinite, false);
  assert.equal(w.triggers.atMention, false);
  assert.equal(w.triggers.poke, false);
  assert.equal(w.triggers.probability, 0.3);
  // 0.5 的随机值落在 [min,max] 中点 = 3000，正好等于硬上限
  const span = Date.parse(w.sleepUntil) - Date.now();
  assert.ok(span >= 2500 && span <= 3500, `有限睡眠应在硬边界内，实际 ${span}ms`);
});

test('默认唤醒配置：缺省值', () => {
  const w = defaultWakeConfigV2(undefined, () => 0);
  assert.equal(w.mode, 'diving');
  assert.equal(w.infinite, true, '默认无限期潜水');
  assert.equal(w.sleepUntil, null);
  assert.ok(Array.isArray(w.triggers.speakerIds));
});

test('新建状态：字段齐全，且运行时句柄不进落盘白名单', () => {
  const st = createConversationStateV2({ cfg: {}, token: 'tok-1' });
  assert.equal(st.agentToken, 'tok-1');
  assert.equal(st.lastUnreadSeq, 0);
  assert.ok(st.modelSeenSeqs instanceof Set);
  for (const f of RUNTIME_ONLY_FIELDS) {
    assert.ok(f in st, `新建状态应包含 ${f}`);
  }
  // 关键：运行时字段一个都不能出现在落盘白名单里
  for (const f of RUNTIME_ONLY_FIELDS) {
    assert.ok(!PERSISTED_FIELDS.includes(f), `${f} 绝不能落盘`);
  }
});

test('序列化：白名单生效、有界裁剪、不含运行时句柄', () => {
  const st = createConversationStateV2({ cfg: {}, token: 'tok-2' });
  st.recentMessages = Array.from({ length: 300 }, (_, i) => ({ text: `m${i}` }));
  st.unread = Array.from({ length: 150 }, (_, i) => ({ text: `u${i}` }));
  st.wakeTimes = Array.from({ length: 300 }, (_, i) => i);
  st.sendTimes = Array.from({ length: 600 }, (_, i) => i);
  st.pendingWakeTimer = setTimeout(() => {}, 1);
  const seen = new Map([['group:1', new Set(['f1', 'f2'])]]);
  const obj = serializeSocialV2({ paused: true, conversations: new Map([['group:1', st]]), seenForwardIds: seen });
  clearTimeout(st.pendingWakeTimer);

  const saved = obj.conversations['group:1'];
  assert.equal(obj.paused, true);
  assert.equal(saved.recentMessages.length, 200, 'recentMessages 裁到 200');
  assert.equal(saved.unread.length, 100, 'unread 裁到 100');
  assert.equal(saved.wakeTimes.length, 200);
  assert.equal(saved.sendTimes.length, 500);
  assert.deepEqual(saved.seenForwardIds, ['f1', 'f2']);
  // 关键断言：落盘对象里不能有任何定时器句柄
  const text = JSON.stringify(saved);
  assert.ok(!/Timer"/.test(text), '不能把定时器句柄写进 JSON');
  assert.ok(!text.includes('modelSeenSeqs'), 'Set 类型字段不直接落盘');
  for (const f of Object.keys(saved)) {
    assert.ok(PERSISTED_FIELDS.includes(f), `未知字段 ${f} 落盘了：白名单需要同步更新`);
  }
});

test('落盘 → 重建 round-trip：关键字段一致', () => {
  const st = createConversationStateV2({ cfg: {}, token: 'tok-3' });
  st.recentMessages = [{ text: '你好', time: 1, sender: '鱼鱼' }];
  st.unread = [{ text: '在吗', time: 2 }];
  st.lastUnreadSeq = 42;
  st.lastReadThroughSeq = 40;
  st.activeTopics = [{ text: '咖啡' }];
  st.memberImpressions = { 小鱼: { tag: '爱唱歌' } };
  const saved = serializeSocialV2({ paused: false, conversations: new Map([['group:9', st]]), seenForwardIds: new Map() });
  const rebuilt = hydrateConversationStateV2({ key: 'group:9', val: saved.conversations['group:9'], cfg: {}, token: 'tok-3' });

  assert.deepEqual(rebuilt.recentMessages, st.recentMessages);
  assert.deepEqual(rebuilt.unread, st.unread);
  assert.equal(rebuilt.lastUnreadSeq, 42);
  assert.equal(rebuilt.lastReadThroughSeq, 40);
  assert.deepEqual(rebuilt.activeTopics, st.activeTopics);
  assert.deepEqual(rebuilt.memberImpressions, st.memberImpressions);
  assert.equal(rebuilt.agentToken, 'tok-3');
  assert.ok(rebuilt.pendingWakeTimer === null, '重建后定时器句柄必须是 null');
});

test('重建：异常数据被归一化（不崩）', () => {
  const rebuilt = hydrateConversationStateV2({
    key: 'group:1',
    val: {
      wakeConfig: null,
      recentMessages: 'not-an-array',
      lastReadThroughSeq: 999,
      lastUnreadSeq: 5, // 读水位不能超过未读序号
      memberImpressions: { normal: 1, __proto__: 2, constructor: 3 },
      wakeConfigTriggersDummy: 0,
    },
    cfg: {},
    token: 'tok-4',
  });
  assert.deepEqual(rebuilt.recentMessages, [], '非数组一律退回空数组');
  assert.equal(rebuilt.lastReadThroughSeq, 5, '读水位被钳到 lastUnreadSeq');
  // 用「自有属性」判断：'__proto__' in obj 永远为真（它在原型链上）
  assert.ok(!Object.prototype.hasOwnProperty.call(rebuilt.memberImpressions, '__proto__'));
  assert.ok(!Object.prototype.hasOwnProperty.call(rebuilt.memberImpressions, 'constructor'));
  assert.equal(rebuilt.memberImpressions.normal, 1);
});

test('重建：私聊会话的指定群友名单强制清空', () => {
  const rebuilt = hydrateConversationStateV2({
    key: 'private:7',
    val: { wakeConfig: { triggers: { speakerIds: ['123', '456'] } } },
    cfg: {},
    token: 'tok-5',
  });
  assert.deepEqual(rebuilt.wakeConfig.triggers.speakerIds, [], '私聊没有「指定群友」概念');
});
