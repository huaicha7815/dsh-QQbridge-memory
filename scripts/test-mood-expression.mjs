// 情绪/关系 → 表达层映射单测（会话 C）。
//
// 覆盖：mood/relationship → plan（长度/表情/语音/称呼/撒娇/吃醋/冷战/主动倍率）、
// 阈值可配、plan → 提示词指令段、概率闸门、主动机会调整、builder 集成与可解释性。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MOOD_EXPRESSION,
  mergeMoodExpressionConfig,
  resolveExpressionPlan,
  buildMoodGuidance,
  shouldAllowSticker,
  shouldAllowVoice,
  computeProactiveAdjustment,
  createWakePromptBuilder,
} from '../src/core/socialv2-prompt.mjs';

const HAPPY_MOOD = { key: 'private:1', valence: 0.8, arousal: 0.8, energy: 0.85, causeType: 'praised' };
const LOW_MOOD = { key: 'private:1', valence: -0.6, arousal: 0.2, energy: 0.2, causeType: 'ignored' };
const NEUTRAL_MOOD = { key: 'private:1', valence: 0, arousal: 0.3, energy: 0.6, causeType: null };
const CLOSE_REL = { intimacy: 0.9, tension: 0, lastInteraction: 1, openLoops: [], events: [], sources: [] };
const COLD_REL = { intimacy: 0.2, tension: 0.8, lastInteraction: 1, openLoops: [], events: [], sources: [] };

test('表达计划：开心/低落/平静三档映射可观测地不同', () => {
  const happy = resolveExpressionPlan({ key: 'private:1', mood: HAPPY_MOOD, relationship: CLOSE_REL, cfg: {} });
  const low = resolveExpressionPlan({ key: 'private:1', mood: LOW_MOOD, relationship: CLOSE_REL, cfg: {} });
  const calm = resolveExpressionPlan({ key: 'private:1', mood: NEUTRAL_MOOD, relationship: CLOSE_REL, cfg: {} });

  assert.equal(happy.moodBand, '兴奋');
  assert.equal(low.moodBand, '低落');
  assert.equal(calm.moodBand, '平静');

  // 长度：低落 < 平静 < 开心
  assert.ok(low.maxReplyChars < calm.maxReplyChars, '低落时回复上限更短');
  assert.ok(happy.maxReplyChars > calm.maxReplyChars, '开心时回复上限更长');

  // 表情/语音概率：开心高、低落低；且都在 0..1
  assert.ok(happy.stickerProbability > low.stickerProbability, '开心比低落更愿意发表情');
  assert.ok(happy.voiceProbability > low.voiceProbability, '开心比低落更愿意发语音');
  for (const p of [happy.stickerProbability, low.stickerProbability, happy.voiceProbability, low.voiceProbability]) {
    assert.ok(p >= 0 && p <= 1, `概率必须在 0..1，实际 ${p}`);
  }

  // 标点语气 / 主动倍率
  assert.equal(low.punctuation, 'quiet');
  assert.equal(happy.punctuation, 'excited');
  assert.ok(happy.proactiveMultiplier > low.proactiveMultiplier, '开心更愿意主动找人');
});

test('表达计划：关系影响称呼/撒娇/吃醋/冷战', () => {
  const warm = resolveExpressionPlan({ key: 'private:1', mood: NEUTRAL_MOOD, relationship: CLOSE_REL, cfg: {} });
  const cold = resolveExpressionPlan({ key: 'private:1', mood: NEUTRAL_MOOD, relationship: COLD_REL, cfg: {} });
  assert.equal(warm.addressForm, 'close');
  assert.equal(cold.addressForm, 'normal');
  assert.ok(warm.clinginess > cold.clinginess, '关系近更黏人');
  assert.ok(cold.coldWar > 0, '张力高会进入冷战');
  assert.equal(warm.coldWar, 0);

  // 最近一次事件是吃醋 → 吃醋倾向显著上升
  const jealousMood = { ...NEUTRAL_MOOD, causeType: 'jealous' };
  const jealous = resolveExpressionPlan({ key: 'private:1', mood: jealousMood, relationship: COLD_REL, cfg: {} });
  assert.ok(jealous.jealousy > cold.jealousy, '吃醋事件应放大吃醋倾向');
  // 可解释：每条关键取值都有 reasons 记录
  assert.ok(jealous.reasons.length > 0);
  for (const reason of jealous.reasons) {
    assert.equal(typeof reason.field, 'string');
    assert.equal(typeof reason.rule, 'string');
  }
});

test('表达计划：阈值可配置（改 cfg 会改变档位与数值）', () => {
  const strict = resolveExpressionPlan({
    key: 'private:1',
    mood: { ...NEUTRAL_MOOD, valence: 0.15 },
    relationship: CLOSE_REL,
    cfg: { socialV2: { moodExpression: { valenceHigh: 0.1, maxReplyCharsChatty: 999 } } },
  });
  assert.equal(strict.moodBand, '开心', '调低 valenceHigh 后轻微正向就进入开心档');
  assert.equal(strict.maxReplyChars, 999, '长度上限来自配置');

  // 默认配置下同样输入还是平静
  const normal = resolveExpressionPlan({
    key: 'private:1',
    mood: { ...NEUTRAL_MOOD, valence: 0.15 },
    relationship: CLOSE_REL,
    cfg: {},
  });
  assert.equal(normal.moodBand, '平静');
});

test('表达计划：边界与缺省输入被安全钳制', () => {
  const weird = resolveExpressionPlan({ key: 'private:1', mood: { valence: NaN, arousal: Infinity, energy: -5 }, relationship: { intimacy: 2, tension: -1 }, cfg: {} });
  assert.ok(weird.maxReplyChars > 0);
  assert.ok(weird.stickerProbability >= 0 && weird.stickerProbability <= 1);
  assert.ok(weird.voiceProbability >= 0 && weird.voiceProbability <= 1);
  assert.ok(Number.isFinite(weird.proactiveMultiplier));

  // 完全没有 mood/relationship 也要给默认计划
  const empty = resolveExpressionPlan({ key: 'private:1', mood: null, relationship: null, cfg: {} });
  assert.equal(empty.moodBand, '平静');
  assert.ok(empty.maxReplyChars >= 1);

  // merge 配置：非法覆盖值回落到默认
  const merged = mergeMoodExpressionConfig({ socialV2: { moodExpression: { stickerBase: 'abc', voiceBase: 0.9 } } });
  assert.equal(merged.stickerBase, DEFAULT_MOOD_EXPRESSION.stickerBase);
  assert.equal(merged.voiceBase, 0.9);
});

test('指令段：可执行、不是仪表盘数字', () => {
  const low = resolveExpressionPlan({ key: 'private:1', mood: LOW_MOOD, relationship: CLOSE_REL, cfg: {} });
  const text = buildMoodGuidance(low);
  assert.match(text, /【此刻心情】/);
  assert.match(text, /【怎么说话】/);
  assert.match(text, /低落/);
  assert.match(text, /短/);
  // 不能把状态数值直接塞进提示词
  assert.doesNotMatch(text, /valence|arousal|intimacy|tension/i);
  assert.doesNotMatch(text, /-0\.6|0\.2/);

  const happy = resolveExpressionPlan({ key: 'private:1', mood: HAPPY_MOOD, relationship: CLOSE_REL, cfg: {} });
  const happyText = buildMoodGuidance(happy);
  assert.match(happyText, /心情|开心|兴奋/);
  assert.notEqual(happyText, text, '两种 mood 的指令必须不同');

  // 冷战指令只在张力高时出现
  const cold = resolveExpressionPlan({ key: 'private:1', mood: NEUTRAL_MOOD, relationship: COLD_REL, cfg: {} });
  assert.match(buildMoodGuidance(cold), /别扭/);
});

test('概率闸门：shouldAllowSticker / shouldAllowVoice 使用 plan 概率', () => {
  assert.equal(shouldAllowSticker({ stickerProbability: 0 }), false);
  assert.equal(shouldAllowSticker({ stickerProbability: 1 }), true);
  assert.equal(shouldAllowSticker({ stickerProbability: 0.5 }, () => 0.2), true);
  assert.equal(shouldAllowSticker({ stickerProbability: 0.5 }, () => 0.8), false);
  assert.equal(shouldAllowSticker({}), true, '没有计划时不拦');

  assert.equal(shouldAllowVoice({ voiceProbability: 0 }), false);
  assert.equal(shouldAllowVoice({ voiceProbability: 1 }), true);
  assert.equal(shouldAllowVoice({ voiceProbability: 0.3 }, () => 0.1), true);
  assert.equal(shouldAllowVoice({ voiceProbability: 0.3 }, () => 0.9), false);
  assert.equal(shouldAllowVoice({}), true);
});

test('主动机会调整：倍率 → 间隔因子 / 概率因子', () => {
  const steady = computeProactiveAdjustment({ proactiveMultiplier: 1 });
  assert.deepEqual(steady, { multiplier: 1, delayFactor: 1, probFactor: 1 });
  const eager = computeProactiveAdjustment({ proactiveMultiplier: 2 });
  assert.equal(eager.delayFactor, 0.5, '更愿意主动 → 间隔缩短');
  assert.equal(eager.probFactor, 2);
  const low = computeProactiveAdjustment({ proactiveMultiplier: 0.5 });
  assert.equal(low.delayFactor, 2, '低落 → 间隔拉长');
  assert.equal(low.probFactor, 0.5);
  // 非法值回落到 1
  assert.deepEqual(computeProactiveAdjustment({}), { multiplier: 1, delayFactor: 1, probFactor: 1 });
});

// ── builder 集成：提示词注入 + 可解释 ─────────────────────────────────────

function makeBuilder({ mood = NEUTRAL_MOOD, relationship = CLOSE_REL, expressionCfg = {} } = {}) {
  return createWakePromptBuilder({
    getState: () => ({ agentToken: 'tok', unread: [], recentMessages: [], wakeConfig: {}, lastIncomingAt: 0 }),
    peekState: () => null,
    cfg: { socialV2: { moodExpression: expressionCfg } },
    formatMemoryInjectionV3: () => '',
    formatParticipationV2: () => '',
    readThroughSeqV2: () => 0,
    suggestQuietMsV2: () => 10000,
    v2ToolEnabled: () => false,
    wakeRoleLineV2: () => '',
    buildStickerContext: () => '',
    buildStickerStrategyHint: () => '',
    compactModelMessage: (m) => m,
    looksLikeUnfinished: () => false,
    buildDiaryDigestV2: () => '',
    profileDigestForRefine: () => '',
    threadClosureHints: () => [],
    stickerEntries: () => [],
    memoryStore: { getConfig: () => ({ enabled: false }) },
    getMoodView: () => mood,
    getRelationshipView: () => relationship,
    expressionCfg: () => expressionCfg,
    rng: () => 0.5,
  });
}

test('builder 集成：注入状态后提示词包含情绪指令，且两种 mood 文本不同', () => {
  const lowPrompt = makeBuilder({ mood: LOW_MOOD }).buildWakePrompt('private:1', 'replyCheck');
  const happyPrompt = makeBuilder({ mood: HAPPY_MOOD }).buildWakePrompt('private:1', 'replyCheck');
  assert.match(lowPrompt, /【此刻心情】/);
  assert.match(happyPrompt, /【此刻心情】/);
  assert.notEqual(lowPrompt, happyPrompt, '不同 mood 下提示词必须不同');
});

test('builder 集成：不注入状态视图时提示词不含情绪段（向后兼容）', () => {
  const builder = createWakePromptBuilder({
    getState: () => ({ agentToken: 'tok', unread: [], recentMessages: [], wakeConfig: {}, lastIncomingAt: 0 }),
    peekState: () => null,
    cfg: { socialV2: {} },
    formatMemoryInjectionV3: () => '',
    formatParticipationV2: () => '',
    readThroughSeqV2: () => 0,
    suggestQuietMsV2: () => 10000,
    v2ToolEnabled: () => false,
    wakeRoleLineV2: () => '',
    buildStickerContext: () => '',
    buildStickerStrategyHint: () => '',
    compactModelMessage: (m) => m,
    looksLikeUnfinished: () => false,
    buildDiaryDigestV2: () => '',
    profileDigestForRefine: () => '',
    threadClosureHints: () => [],
    stickerEntries: () => [],
    memoryStore: { getConfig: () => ({ enabled: false }) },
  });
  const prompt = builder.buildWakePrompt('private:1', 'replyCheck');
  assert.doesNotMatch(prompt, /【此刻心情】/, '没注入状态时不能凭空加情绪段');
});

test('builder 集成：explainMood 返回可解释计划（控制台用）', () => {
  const builder = makeBuilder({ mood: LOW_MOOD });
  const exp = builder.explainMood('private:1');
  assert.ok(exp, '应返回计划');
  assert.equal(exp.moodBand, '低落');
  assert.ok(Array.isArray(exp.reasons) && exp.reasons.length > 0);
  assert.equal(typeof exp.inputs.valence, 'number');
});
