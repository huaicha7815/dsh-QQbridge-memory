// 长期记忆 V3 的端到端回归：真实 bridge.js（VM 沙箱 + 假网关）跑完整链路。
//
// 守住的承诺（这是用户真正在意的部分）：
//   1. 收到的消息会落进永久事件流，且不在 prompt 里重复出现（不额外耗 token）。
//   2. 三天前、早已被 social-v2 的 24h 淘汰机制丢掉的事，仍能被唤醒注入检索回来。
//   3. 注入整体有字符预算，不会随着记忆库增长而无限膨胀。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { bridgeHarness } from './audit-bridge-harness.mjs';

function localDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function noonTs(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

function writeHistoryEvent(temp, offsetDays, row) {
  const dir = path.join(temp, 'state', 'memory', 'events');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${localDay(offsetDays)}.jsonl`), `${JSON.stringify(row)}\n`, 'utf8');
}

test('端到端：收消息落盘，三天前的旧事被检索进唤醒 prompt', async () => {
  const h = await bridgeHarness();
  try {
    // 三天前发生过、且早已超出 social-v2 热记忆 24h 寿命的一件事
    writeHistoryEvent(h.temp, -3, {
      t: noonTs(-3),
      k: 'group:456',
      kind: 'msg',
      who: '爸爸',
      text: '说好周末带她去吃那家新开的火锅店，别又忘了',
    });

    // 现在群里有人提到「火锅」，触发一次唤醒
    h.appendSocialV2Message('group:456', '阿明', '晚上吃火锅吗', '晚上吃火锅吗', false, false, 1001, [], '999', []);

    // 1) 事件流里确实有今天这条收到的消息
    const todayFile = path.join(h.temp, 'state', 'memory', 'events', `${localDay(0)}.jsonl`);
    assert.ok(fs.existsSync(todayFile), '今天的消息应落进事件流');
    const rows = fs.readFileSync(todayFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => String(r.text).includes('火锅') && r.kind === 'msg'), '收到的消息要归档');

    // 2) 唤醒 prompt 里能检索到三天前那件事
    const prompt = h.buildWakePromptV2('group:456', 'replyCheck');
    assert.match(prompt, /跟现在有关的旧事/, 'prompt 应包含检索段');
    assert.match(prompt, /新开的火锅店/, '三天前的约定必须被检索回来（过期≠丢失）');
    assert.match(prompt, /3 天前|\d{1,2}-\d{1,2}/, '检索结果应带日期线索');
    // 借鉴 ReMe guidance：告诉她「什么时候该查、查不到别编」
    assert.match(prompt, /【记忆怎么用】/, '必须告诉她记忆该怎么用');
    assert.match(prompt, /qq_memory_search/, '要指出用哪个工具查');
    assert.match(prompt, /别编一个/, '要明确禁止编造记忆');

    // 3) 注入预算：记忆部分不会随历史增长而无限膨胀
    //    这里用整体 prompt 做粗略上界（角色卡 + 协议 + 记忆一起）。
    assert.ok(prompt.length < 12000, `prompt 异常膨胀：${prompt.length} 字`);

    // 4) 同一件事不会在 prompt 里出现两遍（事件流只供检索，不整体注入）
    const occurrences = (prompt.match(/新开的火锅店/g) || []).length;
    assert.equal(occurrences, 1, `旧事重复注入 ${occurrences} 次`);
  } finally {
    await h.close();
  }
});

test('端到端：热记忆淘汰后，档案与事件流仍能撑住「记得」', async () => {
  const h = await bridgeHarness();
  try {
    // harness 没有直接暴露 memoryStore 实例，档案走文件系统验证：
    // writeProfile/readProfile 的正确性已在 test-memory-lib.mjs 覆盖，这里验证「档案能被注入」。
    const profileFile = path.join(h.temp, 'state', 'memory', 'profile.json');
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(profileFile, JSON.stringify({
      version: 3,
      people: { 阿明: { facts: ['在准备考研'], count: 12, firstSeen: 1, lastSeen: Date.now() } },
      threads: [{ text: '说好周末去吃那家新开的火锅店', with: ['爸爸'], state: 'open', createdAt: 1, lastMentionAt: Date.now() }],
      self: [],
    }), 'utf8');

    h.appendSocialV2Message('group:456', '阿明', '你在干嘛', '你在干嘛', false, false, 1002, [], '999', []);
    const prompt = h.buildWakePromptV2('group:456', 'replyCheck');
    assert.match(prompt, /你记得的人/, '档案段必须注入');
    assert.match(prompt, /阿明：在准备考研/, '人物长期事实必须注入');
    assert.match(prompt, /你心里记着的线/, '未完结的线必须注入');
    assert.match(prompt, /新开的火锅店/, '未完结的线内容必须注入');
  } finally {
    await h.close();
  }
});

test('端到端：memory 关闭时回退到旧热记忆，不崩也不空', async () => {
  const h = await bridgeHarness({ config: { socialV2: { memory: { enabled: false } } } });
  try {
    h.appendSocialV2Message('group:456', '阿明', '你好', '你好', false, false, 1003, [], '999', []);
    const prompt = h.buildWakePromptV2('group:456', 'replyCheck');
    assert.ok(typeof prompt === 'string' && prompt.length > 0);
    // 关掉 V3 后不应注入新段落标题
    assert.doesNotMatch(prompt, /跟现在有关的旧事/);
  } finally {
    await h.close();
  }
});

test('方式 0：日记 prompt 带「顺手记住」，且可用配置关掉', async () => {
  // 开着：日记那次 turn 里必须提醒她用长期档案工具（零额外模型调用）
  const on = await bridgeHarness();
  try {
    const prompt = on.buildWakePromptV2('private:123', 'diary');
    assert.match(prompt, /【顺手记住】/, '日记 prompt 应包含记忆提示');
    assert.match(prompt, /qq_memory_remember/, '要明确让她调 remember 工具');
    assert.match(prompt, /thread|person|self/, '要给出三类档案的区分');
    // V3.9：记忆的主角是她自己——日记里的记录提示必须先说「记你自己」
    assert.match(prompt, /先记你自己/, '首要任务变成记录她自己的一天');
    assert.match(prompt, /category="milestone"/, '要给出她自己的分类参数');
    assert.match(prompt, /你的人生是主线/, '要明确主题是她的人生，不是别人的话');
    assert.match(prompt, /没有就别硬凑/, '要明确允许不记，防止为了凑数污染档案');
  } finally {
    await on.close();
  }

  // 关掉：提示消失，日记 prompt 其余部分照旧
  const off = await bridgeHarness({ config: { socialV2: { memory: { diaryRemember: false } } } });
  try {
    const prompt = off.buildWakePromptV2('private:123', 'diary');
    assert.doesNotMatch(prompt, /【顺手记住】/);
    assert.match(prompt, /【写日记】/, '日记本身不能受影响');
    assert.match(prompt, /【然后是晚安】/);
  } finally {
    await off.close();
  }
});

test('日终归纳（V3.6）：独立的整理任务带今日记录与完整档案，且不干扰日记', async () => {
  const h = await bridgeHarness();
  try {
    const profileFile = path.join(h.temp, 'state', 'memory', 'profile.json');
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(profileFile, JSON.stringify({
      version: 3,
      people: {
        爸爸: {
          facts: [{ text: '姓林，小名鱼鱼', createdAt: 1, confirmedAt: Date.now(), count: 1 }],
          count: 3,
          firstSeen: 1,
          lastSeen: Date.now(),
        },
      },
      threads: [{ text: '答应教我唱《雨爱》', with: ['爸爸'], state: 'open', createdAt: 1, lastMentionAt: Date.now() }],
      self: [],
    }), 'utf8');
    h.appendSocialV2Message('group:456', '阿明', '今天把《雨爱》唱了，发群里了', '今天把《雨爱》唱了，发群里了', false, false, 1004, [], '999', []);

    const prompt = h.buildWakePromptV2('private:123', 'memoryRefine');
    assert.match(prompt, /【整理记忆】/, '必须有独立的整理任务段');
    assert.match(prompt, /今天你收到的记录/, '要把今天的记录摆给她核对');
    assert.match(prompt, /姓林，小名鱼鱼/, '要给完整档案，她才能发现哪条记错了');
    assert.match(prompt, /答应教我唱《雨爱》/, '还挂着的线要摆出来');
    assert.match(prompt, /evidence/, '必须要求她给证据');
    assert.match(prompt, /原样复制/, '明确要求原文，改写的不算');
    assert.match(prompt, /correct/, '要给出「纠错」这个动作');
    assert.match(prompt, /threadDone/, '要给出「收尾」这个动作');
    assert.match(prompt, /不要给任何人发消息/, '内部整理不能变成聊天');
    assert.match(prompt, /只是候选/, '收尾候选要标明只是候选');

    // 两条任务互不干扰：日记 prompt 里不能出现整理任务，反之亦然
    const diary = h.buildWakePromptV2('private:123', 'diary');
    assert.doesNotMatch(diary, /【整理记忆】/);
    assert.match(diary, /【写日记】/);
    assert.doesNotMatch(prompt, /【写日记】/);
  } finally {
    await h.close();
  }
});
