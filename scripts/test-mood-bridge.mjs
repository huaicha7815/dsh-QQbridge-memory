// bridge 真实路径测试：用 audit-bridge-harness 加载**真实 bridge.js**，
// 直接调用 bridge 内部的消息入库/出站记录函数，验证接线后的 mood/relationship
// 真的落在 bridge 的 socialV2 状态里（而不是只测 dispatcher）。
//
// 这覆盖审查报告「bridge harness 直接经过 appendSocialV2Message 等调用点」的测试缺口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { bridgeHarness } from './audit-bridge-harness.mjs';

test('bridge 真实路径：入站消息 → mood/relationship 写入 socialV2 状态', async () => {
  const h = await bridgeHarness();
  try {
    h.appendSocialV2Message('private:7001', '阿明', '你真的好温柔', '你真的好温柔', false, false, 2001, [], '7001', []);
    const st = h.getSocialV2State('private:7001');
    assert.equal(st.mood.causeType, 'praised', 'bridge 入站消息应驱动情绪');
    assert.equal(st.mood.cause, '你真的好温柔');
    assert.ok(st.mood.valence > 0);
    assert.ok(st.relationships?.['7001'], '关系记录应写进 bridge 状态');
    assert.ok(st.relationships['7001'].intimacy > 0.3, '被夸 + 互动后亲密应上升');
    assert.equal(st.relationships['7001'].lastInteraction > 0, true);

    // 落盘验证：serialize 白名单里能看到 mood/relationships
    const stateFile = path.join(h.temp, 'state', 'social-v2.json');
    assert.ok(fs.existsSync(stateFile), 'bridge 已把状态写盘');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(saved.conversations['private:7001'].mood.causeType, 'praised');
    assert.ok(saved.conversations['private:7001'].relationships['7001']);
  } finally {
    await h.close();
  }
});

test('bridge 真实路径：否定句不会把情绪推向相反方向', async () => {
  const h = await bridgeHarness();
  try {
    // 连续三条否定句（不是只发一条）
    const negatives = ['我不喜欢你了', '我不想你了', '我不接受你的抱歉'];
    for (let i = 0; i < negatives.length; i += 1) {
      h.appendSocialV2Message('private:7002', '阿明', negatives[i], negatives[i], false, false, 2002 + i, [], '7002', []);
    }
    const st = h.getSocialV2State('private:7002');
    assert.ok(st.mood.valence < 0, `三条否定句后 bridge 里情绪应为负，实际 ${st.mood.valence}`);
    assert.equal(st.mood.causeType, 'rejected');
    for (const event of st.mood.events) {
      assert.notEqual(event.type, 'praised');
      assert.notEqual(event.type, 'missed');
      assert.notEqual(event.type, 'makeup');
    }
    assert.ok(st.relationships['7002'].tension > 0, '否定句应积累张力');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径：出站消息更新关系互动、不改情绪', async () => {
  const h = await bridgeHarness();
  try {
    h.appendSocialV2Message('private:7003', '阿明', '今天吃什么', '今天吃什么', false, false, 2003, [], '7003', []);
    const beforeMood = h.getSocialV2State('private:7003').mood;
    h.recordSentMessagesV2('private:7003', ['吃火锅吧']);
    const st = h.getSocialV2State('private:7003');
    assert.equal(st.mood.events.length, beforeMood.events.length, '出站不该产生情绪事件');
    assert.ok(st.relationships['7003'], '出站应更新关系');
    assert.equal(st.relationships['7003'].events[st.relationships['7003'].events.length - 1].type, 'interaction');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径：拍一拍（拍自己）产生 poked 情绪', async () => {
  const h = await bridgeHarness();
  try {
    h.appendSocialV2Poke('private:7004', {
      sender: '阿明',
      userId: '7004',
      targetId: '9999',
      targetIsSelf: true,
      isOwner: false,
      groupId: null,
      action: '拍了拍',
      suffix: '',
    });
    const st = h.getSocialV2State('private:7004');
    assert.equal(st.mood.causeType, 'poked');
    assert.ok(st.mood.valence > 0);
  } finally {
    await h.close();
  }
});

test('bridge 真实路径：openLoop / closeLoop 经由入站文本可达，且事件链完整', async () => {
  const h = await bridgeHarness();
  try {
    h.appendSocialV2Message('private:7005', '阿明', '你答应我的事呢', '你答应我的事呢', false, false, 2005, [], '7005', []);
    const opened = h.getSocialV2State('private:7005').relationships['7005'];
    assert.equal(opened.openLoops.length, 1, '约定应进入 openLoops');
    // 不能只看 loop 数量：来源事件必须是 interaction + openLoop 两条
    assert.deepEqual(opened.events.map((e) => e.type).sort(), ['interaction', 'openLoop']);

    h.appendSocialV2Message('private:7005', '阿明', '给你了', '给你了', false, false, 2006, [], '7005', []);
    const closed = h.getSocialV2State('private:7005').relationships['7005'];
    assert.equal(closed.openLoops.length, 0, '“给你了”应了结约定');
    assert.ok(closed.events.some((e) => e.type === 'closeLoop'), '关闭成功必须留下 closeLoop 事件');

    // 再发一条“给你了”（没有 loop 可关）：不得写任何关系（连 interaction 都不行）
    h.appendSocialV2Message('private:7005', '阿明', '给你了', '给你了', false, false, 2007, [], '7005', []);
    const failed = h.getSocialV2State('private:7005').relationships['7005'];
    assert.equal(failed.intimacy, closed.intimacy, 'closeLoop 失败不能改变 intimacy');
    assert.equal(failed.tension, closed.tension, 'closeLoop 失败不能改变 tension');
    assert.equal(failed.events.length, closed.events.length, 'closeLoop 失败不能新增事件');
    assert.equal(failed.lastInteraction, closed.lastInteraction, 'closeLoop 失败不能更新 lastInteraction');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径：群聊方向门控（其他人之间的聊天不改变状态，审查 r5 P1）', async () => {
  const h = await bridgeHarness();
  try {
    // 群里没 @/引用 AI 的普通消息：不产生情绪、不建关系
    h.appendSocialV2Message('group:7200', '群友A', '你好可爱', '你好可爱', false, false, 3001, [], '7201', []);
    h.appendSocialV2Message('group:7200', '群友B', '滚开', '滚开', false, false, 3002, [], '7202', []);
    const plain = h.getSocialV2State('group:7200');
    assert.equal(plain.mood.events.length, 0, '别人之间的聊天不产生群情绪');
    assert.equal(Object.keys(plain.relationships || {}).length, 0, '也不建立关系');

    // 明确 @/引用 AI 的消息（directedAtSelf=true）才生效
    h.appendSocialV2Message('group:7200', '群友A', '你好可爱', '你好可爱', true, false, 3003, [], '7201', [], true);
    const directed = h.getSocialV2State('group:7200');
    assert.equal(directed.mood.causeType, 'praised');
    assert.ok(directed.relationships['7201'], '指向 AI 的消息才建立关系');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径：AI 暂停时冻结情绪/关系（审查 r5 P2）', async () => {
  const h = await bridgeHarness();
  try {
    h.appendSocialV2Message('private:7006', '阿明', '你好可爱', '你好可爱', false, false, 2008, [], '7006', []);
    const before = h.getSocialV2State('private:7006');
    assert.equal(before.mood.causeType, 'praised');
    const intimacyBefore = before.relationships['7006'].intimacy;

    h.socialV2.paused = true;
    h.appendSocialV2Message('private:7006', '阿明', '我不喜欢你了', '我不喜欢你了', false, false, 2009, [], '7006', []);
    const after = h.getSocialV2State('private:7006');
    assert.equal(after.mood.causeType, 'praised', '暂停期间情绪不应变化');
    assert.equal(after.mood.valence, before.mood.valence, '暂停期间 valence 不变');
    assert.equal(after.relationships['7006'].intimacy, intimacyBefore, '暂停期间关系不变');
    h.socialV2.paused = false;
  } finally {
    await h.close();
  }
});

test('bridge 真实路径：暂停时拍一拍同样冻结（审查 r6 P2）', async () => {
  const h = await bridgeHarness();
  try {
    h.appendSocialV2Poke('private:7007', {
      sender: '阿明', userId: '7007', targetId: '9999', targetIsSelf: true, isOwner: false, groupId: null, action: '拍了拍', suffix: '',
    });
    const before = h.getSocialV2State('private:7007');
    assert.equal(before.mood.causeType, 'poked');
    const intimacyBefore = before.relationships['7007'].intimacy;

    h.socialV2.paused = true;
    h.appendSocialV2Poke('private:7007', {
      sender: '阿明', userId: '7007', targetId: '9999', targetIsSelf: true, isOwner: false, groupId: null, action: '拍了拍', suffix: '',
    });
    const after = h.getSocialV2State('private:7007');
    assert.equal(after.mood.causeType, 'poked', '暂停期间拍一拍不应改变情绪');
    assert.equal(after.mood.events.length, before.mood.events.length, '暂停期间不新增情绪事件');
    assert.equal(after.relationships['7007'].intimacy, intimacyBefore, '暂停期间拍一拍不改关系');
    h.socialV2.paused = false;
  } finally {
    await h.close();
  }
});

test('bridge 真实路径：handleIncoming 级群聊方向解析（不 @ / @ AI / 引用 AI）（审查 r6 新问题）', async () => {
  const h = await bridgeHarness();
  h.setMode('reserved2');
  h.setReady(true);
  try {
    const mkEvent = (message, messageId, userId = '7311') => ({
      message_type: 'group',
      group_id: '456',
      user_id: userId,
      sender: { nickname: '群友A', card: '' },
      self_id: '9999',
      message,
      message_id: messageId,
    });
    // 不 @ AI：消息入库但情绪/关系 0
    await h.handleIncoming('group', '456', mkEvent([{ type: 'text', data: { text: '你好可爱' } }], 4001), h.cfg);
    const plain = h.getSocialV2State('group:456');
    assert.ok(plain.recentMessages.length > 0, '消息本身仍入库');
    assert.equal(plain.mood.events.length, 0, '不 @ 的消息不产生群情绪');
    assert.equal(Object.keys(plain.relationships || {}).length, 0, '不 @ 的消息不建立关系');

    // @ 到 AI（self_id）：走真实 handleIncoming 的 atSelf 计算
    await h.handleIncoming(
      'group',
      '456',
      mkEvent([{ type: 'at', data: { qq: '9999' } }, { type: 'text', data: { text: ' 你好可爱' } }], 4002),
      h.cfg,
    );
    const at = h.getSocialV2State('group:456');
    assert.equal(at.mood.causeType, 'praised', '@ 到 AI 的消息应产生情绪');
    assert.ok(at.relationships['7311'], '@ 到 AI 的消息应建立关系');

    // 引用 AI 的 reply 段（不 @）：quoteTargetIsSelf 也应放行门控（审查 r7 非阻塞提示）
    await h.handleIncoming(
      'group',
      '456',
      mkEvent([{ type: 'reply', data: { id: '9002' } }, { type: 'text', data: { text: '你好可爱' } }], 4003, '7312'),
      h.cfg,
    );
    const quoted = h.getSocialV2State('group:456');
    assert.equal(
      quoted.relationships['7312'].events.filter((event) => event.type === 'praised').length,
      1,
      '引用 AI 的 reply 段应放行情绪事件',
    );
  } finally {
    await h.close();
  }
});

test('bridge 真实路径：保存失败设置 lastSaveError，恢复后清空（审查 r6 测试缺口）', async () => {
  const h = await bridgeHarness();
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = () => {
      const error = new Error('ENOSPC: no space left on device');
      error.code = 'ENOSPC';
      throw error;
    };
    h.saveSocialV2State();
    assert.ok(h.socialV2.lastSaveError, '保存失败必须记录 lastSaveError');
    assert.equal(h.socialV2.lastSaveError.code, 'ENOSPC', '内部只记录错误码');
    assert.equal('message' in h.socialV2.lastSaveError, false, '原始 message 不落内存态');

    fs.renameSync = originalRename;
    h.saveSocialV2State();
    assert.equal(h.socialV2.lastSaveError, null, '恢复后成功保存应清空 lastSaveError');
  } finally {
    fs.renameSync = originalRename;
    await h.close();
  }
});

test('bridge 真实路径（会话 C）：两种 mood 下唤醒提示词可观测地不同', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'private:7401';
    // 先制造开心状态（被夸）
    h.appendSocialV2Message(key, '阿明', '你真的好温柔', '你真的好温柔', false, false, 5001, [], '7401', []);
    const happyPrompt = h.buildWakePromptV2(key, 'replyCheck');
    assert.match(happyPrompt, /【此刻心情】/, '唤醒提示词应注入情绪指令段');

    // 再切到低落/冷战状态（直接改状态数值，模拟被冷落后的心情）
    const st = h.getSocialV2State(key);
    st.mood = { ...st.mood, valence: -0.7, arousal: 0.2, energy: 0.2, causeType: 'ignored', since: Date.now() };
    if (st.relationships && st.relationships['7401']) {
      st.relationships['7401'].tension = 0.8;
    }
    const lowPrompt = h.buildWakePromptV2(key, 'replyCheck');
    assert.notEqual(lowPrompt, happyPrompt, '两种 mood 的提示词必须不同');
    assert.match(lowPrompt, /低落/, '低落状态应给出低落指令');
    assert.match(lowPrompt, /别扭/, '高张力应给出冷战/别扭指令');

    // 控制台可解释：bridge 记录了最近一次表达计划
    const recorded = h.socialV2.lastExpression.get(key);
    assert.ok(recorded && recorded.plan, '应记录表达计划供控制台解释');
    assert.equal(recorded.plan.moodBand, '低落');
    assert.ok(Array.isArray(recorded.plan.reasons) && recorded.plan.reasons.length > 0);
  } finally {
    await h.close();
  }
});

test('bridge 真实路径（会话 C）：主 AI 文本通道超长被观测但不截断（审查 expression P1-1）', async () => {
  const h = await bridgeHarness();
  h.setMode('reserved2');
  try {
    const key = 'private:123';
    // 先制造低落状态（上限 80 字）
    h.appendSocialV2Message(key, '阿明', '我不喜欢你了', '我不喜欢你了', false, false, 5002, [], '123', []);
    const st = h.getSocialV2State(key);
    assert.ok(st.mood.valence < 0, '前置：应是低落状态');
    const longText = '很'.repeat(200);
    await h.sendMessagesV2(key, [longText], []);
    const recorded = h.socialV2.lastExpression.get(key);
    assert.equal(recorded.source, 'send-text', '主 AI 文本通道应记录长度决策');
    assert.equal(recorded.outcome.kind, 'overLimit');
    assert.equal(recorded.outcome.chars, 200, '观测到的是原文长度（未截断）');
    assert.ok(recorded.outcome.maxReplyChars < 200, '低落状态上限应低于 200');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径（会话 C）：reset 后表达解释被清理（审查 expression P2-2）', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'private:7403';
    h.appendSocialV2Message(key, '阿明', '你好可爱', '你好可爱', false, false, 5003, [], '7403', []);
    h.buildWakePromptV2(key, 'replyCheck');
    assert.ok(h.socialV2.lastExpression.get(key), '唤醒后应有解释记录');
    h.forgetExpression(key);
    assert.equal(h.socialV2.lastExpression.get(key), undefined, 'reset 后不能残留旧解释');
    assert.equal(h.socialV2.lastProactiveByKey.get(key), undefined, 'reset 后不能残留旧主动解释');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径（会话 C）：真实 retireSession 清理两张解释 Map（审查 expression-r2 P2）', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'private:123';
    h.appendSocialV2Message(key, '阿明', '你好可爱', '你好可爱', false, false, 5003, [], '123', []);
    h.buildWakePromptV2(key, 'replyCheck');
    assert.ok(h.socialV2.lastExpression.get(key), '唤醒后应有解释记录');
    // 真实退役路径（不是直接调 forgetExpression），否则只是辅助函数自测。
    h.retireSession(key);
    assert.equal(h.socialV2.lastExpression.get(key), undefined, 'retireSession 后不能残留解释');
    assert.equal(h.socialV2.lastProactiveByKey.get(key), undefined, 'retireSession 后不能残留主动解释');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径（会话 C）：send-text → wake 连续记录不串用 outcome（审查 expression-r2 P2）', async () => {
  const h = await bridgeHarness();
  h.setMode('reserved2');
  try {
    const key = 'private:123';
    h.appendSocialV2Message(key, '阿明', '我不喜欢你了', '我不喜欢你了', false, false, 5002, [], '123', []);
    await h.sendMessagesV2(key, ['很'.repeat(200)], []);
    const sent = h.socialV2.lastExpression.get(key);
    assert.equal(sent.source, 'send-text');
    assert.equal(sent.outcome.kind, 'overLimit');
    // 随后生成 wake prompt：应整体替换，不能沿用上一条 send-text 的 outcome
    h.buildWakePromptV2(key, 'replyCheck');
    const wake = h.socialV2.lastExpression.get(key);
    assert.equal(wake.source, 'wake');
    assert.equal(wake.outcome, undefined, 'wake 记录不能沿用 send-text 的 outcome');
    assert.equal(wake.reason, 'replyCheck');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径（会话 C）：两张解释 Map 都有 200 key 上限（审查 expression-r2 P2）', async () => {
  const h = await bridgeHarness();
  try {
    for (let i = 0; i < 205; i++) {
      const key = `private:${100000 + i}`;
      h.recordExpression(key, { source: 'wake', plan: { moodBand: '平静' } });
      h.setBounded(h.lastProactiveByKey, key, { at: 1 });
    }
    assert.equal(h.lastExpressionByKey.size, 200, 'lastExpression 必须有界');
    assert.equal(h.lastProactiveByKey.size, 200, 'lastProactive 必须有界');
    // 最旧的 key 被淘汰
    assert.equal(h.lastExpressionByKey.has('private:100000'), false);
    assert.equal(h.lastProactiveByKey.has('private:100000'), false);
    assert.equal(h.lastExpressionByKey.has('private:100204'), true, '最新的 key 保留');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径（会话 C）：setBounded 更新已有 key 会刷新淘汰顺序（LRU，审查 expression-r3 P2）', async () => {
  const h = await bridgeHarness();
  try {
    for (let i = 0; i < 200; i++) h.setBounded(h.lastExpressionByKey, `private:${1000 + i}`, { at: 1 });
    assert.equal(h.lastExpressionByKey.size, 200);
    // 更新最旧的 key：语义是「最近更新保留」
    h.setBounded(h.lastExpressionByKey, 'private:1000', { at: 2, updated: true });
    // 再插新 key：应淘汰次旧 private:1001，而不是刚更新的 private:1000
    h.setBounded(h.lastExpressionByKey, 'private:9999', { at: 3 });
    assert.equal(h.lastExpressionByKey.size, 200);
    assert.equal(h.lastExpressionByKey.has('private:1000'), true, '被更新的 key 必须保留');
    assert.equal(h.lastExpressionByKey.has('private:1001'), false, '次旧 key 应被淘汰');
    assert.equal(h.lastExpressionByKey.get('private:1000').updated, true);
  } finally {
    await h.close();
  }
});

test('bridge 真实路径（会话 C）：retireSession 有映射/无映射都清理解释（审查 expression-r3 测试缺口）', async () => {
  const h = await bridgeHarness();
  try {
    // 无 sessionId 路径
    h.buildWakePromptV2('private:7403', 'replyCheck');
    assert.ok(h.socialV2.lastExpression.get('private:7403'));
    h.retireSession('private:7403');
    assert.equal(h.socialV2.lastExpression.get('private:7403'), undefined, '无映射路径也要清理');
    // 有 sessionId 路径（让 retireSession 走完整分支）
    h.state.sessions['private:123'] = 'sess-fake-1';
    h.buildWakePromptV2('private:123', 'replyCheck');
    assert.ok(h.socialV2.lastExpression.get('private:123'));
    h.retireSession('private:123');
    assert.equal(h.socialV2.lastExpression.get('private:123'), undefined, '有映射路径也要清理');
    assert.equal(h.state.sessions['private:123'], undefined, '会话映射应被删除');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径（会话 C）：默认平静状态不拦表情/语音（避免误伤无情绪会话）', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'private:7404';
    h.appendSocialV2Message(key, '阿明', '今天吃什么', '今天吃什么', false, false, 5004, [], '7404', []);
    h.buildWakePromptV2(key, 'replyCheck');
    const plan = h.socialV2.lastExpression.get(key)?.plan;
    assert.ok(plan, '应有表达计划');
    assert.equal(plan.hasMoodState, false, '只有普通互动时不应视为有情绪状态');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径（会话 D）：入站情绪事件 → 记忆事件带情绪标注（真实链路闭环）', async () => {
  const h = await bridgeHarness();
  h.setMode('reserved2');
  try {
    const key = 'private:123';
    h.appendSocialV2Message(key, '阿明', '你好可爱呀', '你好可爱呀', false, false, 5001, [], '123', []);
    // 情绪分发先执行（mood 已记 praised），随后记忆归档带 emotionType → 自动标注 valence/arousal。
    const rows = h.memoryStore.search('可爱', { now: Date.now(), topK: 5, days: 1 });
    assert.ok(rows.length > 0, '入站消息应写入记忆库');
    const hit = rows[0];
    assert.equal(hit.emotionType, 'praised', '记忆事件应带情绪事件类型');
    assert.ok(hit.valence > 0, '被夸的记忆应有正向 valence');
    assert.ok(hit.arousal >= 0 && hit.arousal <= 1);
  } finally {
    await h.close();
  }
});

test('bridge 真实路径：拍一拍 → 记忆事件带 emotionType/valence/arousal', async () => {
  const h = await bridgeHarness();
  try {
    // 真实 bridge 函数：内部 dispatchPoke 先取 eventType，再 archiveMemoryEventV3({ emotionType })
    h.appendSocialV2Poke('private:7101', {
      sender: '阿明', userId: '7101', targetId: '7101', targetIsSelf: true,
    });
    const now = new Date();
    const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    // 用 bridge 内部真实 memoryStore 实例读取（覆盖统一读取契约与坏行处理，而不是绕过 API 直接读文件）
    const rows = h.memoryStore.readDayEvents(day);
    const ev = rows.find((r) => r.kind === 'poke');
    assert.ok(ev, 'poke 事件应持久化');
    assert.equal(ev.emotionType, 'poked', '拍到自己应带 poked 情绪类型');
    assert.ok(typeof ev.valence === 'number' && typeof ev.arousal === 'number', '情绪标注必须落盘');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径（会话 D）：唤醒检索把当前 mood 传给记忆检索（P1 生产接线）', async () => {
  const h = await bridgeHarness();
  h.setMode('reserved2');
  try {
    const key = 'private:123';
    // 消息要够长（memoryQueryV3 过滤掉「好」「嗯」这类过短查询），且含 praised 关键词。
    h.appendSocialV2Message(key, '阿明', '你好可爱呀真的好可爱', '你好可爱呀真的好可爱', false, false, 5001, [], '123', []);
    const captured = [];
    const orig = h.memoryStore.search;
    h.memoryStore.search = (q, opts) => {
      captured.push(opts || {});
      return orig(q, opts);
    };
    try {
      h.buildWakePromptV2(key, 'replyCheck');
      assert.ok(captured.length > 0, '唤醒必须触发记忆检索');
    } finally {
      h.memoryStore.search = orig;
    }
    const withEmotion = captured.find((o) => o && o.emotion);
    assert.ok(withEmotion, `唤醒记忆检索必须带 emotion（否则情绪检索在生产不可用）；captured=${JSON.stringify(captured)}`);
    assert.equal(typeof withEmotion.emotion.valence, 'number');
    assert.equal(typeof withEmotion.emotion.arousal, 'number');
    assert.ok(withEmotion.emotion.valence > 0, '被夸后 valence 应为正');
  } finally {
    await h.close();
  }
});

test('bridge 真实路径（会话 D）：暂停/无情绪事件时记忆事件不带任何情绪字段（P2 兼容）', async () => {
  const h = await bridgeHarness();
  h.setMode('reserved2');
  try {
    // 暂停：dispatch 被跳过 → 归档不应带标注
    h.socialV2.paused = true;
    h.appendSocialV2Message('private:123', '阿明', '你好可爱呀', '你好可爱呀', false, false, 5001, [], '123', []);
    h.socialV2.paused = false;
    // 普通消息：没有情绪事件
    h.appendSocialV2Message('private:123', '阿明', '今天吃什么', '今天吃什么', false, false, 5002, [], '123', []);
    const pausedHit = h.memoryStore.search('可爱', { now: Date.now(), topK: 5, days: 1 }).find((r) => r.text.includes('可爱'));
    assert.ok(pausedHit, '暂停期间消息也应写入记忆库');
    assert.equal(pausedHit.emotionType, '', '暂停期间不能标注 emotionType');
    assert.equal(pausedHit.valence, null, '暂停期间不能有 valence');
    const plainHit = h.memoryStore.search('吃什么', { now: Date.now(), topK: 5, days: 1 }).find((r) => r.text.includes('吃什么'));
    assert.equal(plainHit.emotionType, '', '无情绪事件不能标注');
    assert.equal(plainHit.valence, null);
    // 直接读当日事件行，确认字段根本不存在（不是 search 投影成空值）——审查缺口。
    const now = new Date();
    const dayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const rawRows = h.memoryStore.readDayEvents(dayStr);
    const pausedRow = rawRows.find((r) => r.text === '你好可爱呀');
    assert.ok(pausedRow, '暂停期间消息应落盘');
    assert.equal('valence' in pausedRow, false, '暂停期间事件 JSON 不能有 valence 键');
    assert.equal('arousal' in pausedRow, false, '暂停期间事件 JSON 不能有 arousal 键');
    assert.equal('emotionType' in pausedRow, false, '暂停期间事件 JSON 不能有 emotionType 键');
    const plainRow = rawRows.find((r) => r.text === '今天吃什么');
    assert.ok(plainRow, '普通消息应落盘');
    assert.equal('valence' in plainRow, false, '无情绪事件 JSON 不能有 valence 键');
    assert.equal('emotionType' in plainRow, false, '无情绪事件 JSON 不能有 emotionType 键');
  } finally {
    h.socialV2.paused = false;
    await h.close();
  }
});
