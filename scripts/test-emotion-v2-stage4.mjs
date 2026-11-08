// 阶段 4：记忆多情绪标签 + 表达精调 + 可视化静态断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const NOW = 1_800_000_000_000;

test('记忆多情绪标签：memory 事件 meta.emotions 为 appraise 候选（强度降序 ≤3）', async () => {
  const { applyFactPipeline } = await import('../src/core/socialv2-exec.mjs');
  const { loadSocialV2State } = await import('../src/core/socialv2-state.mjs');
  const base = loadSocialV2State({ version: 2, agentMood: { schemaVersion: 2, episodes: [] }, relationships: {}, relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] }, conversations: {}, migration: { version: 2, fromVersion: 2, status: 'done', revision: 0 } }, { now: NOW }).state;
  const entries = [];
  const memory = {
    appendEventWithId(entry) { entries.push(entry); return { ok: true }; },
    findEventByStableId: () => ({ found: false, unknown: true }),
  };
  const result = applyFactPipeline({
    state: base,
    event: { eventId: 'evt-emotions', type: 'insulted', quote: '你真烦', contextKey: 'private:1', at: NOW },
    memory, now: NOW, writeCheckpoint: () => {},
  });
  assert.equal(result.code, 'ok');
  assert.equal(entries.length, 1);
  const emotions = entries[0].meta?.emotions;
  assert.ok(Array.isArray(emotions) && emotions.length > 0, 'meta.emotions 必须存在');
  assert.ok(emotions.length <= 3, '≤3 标签');
  for (const item of emotions) {
    assert.ok(typeof item.kind === 'string' && Number.isFinite(item.intensity));
  }
  for (let i = 1; i < emotions.length; i += 1) assert.ok(emotions[i - 1].intensity >= emotions[i].intensity, '强度降序');
});

test('表达精调：默认关闭时 plan 不含 background；开启后按 slowValence/chronicLoad 收敛', async () => {
  const { resolveExpressionPlan, refineExpressionPlanWithBackground } = await import('../src/core/socialv2-prompt.mjs');
  const mood = { valence: 0.6, arousal: 0.5, energy: 0.7, slowValence: -0.5, chronicLoad: 0.8 };
  const base = resolveExpressionPlan({ key: 'private:1', mood, relationship: { intimacy: 0.5, tension: 0.1 }, cfg: { socialV2: { moodExpression: {} } }, rng: () => 0.5 });
  const off = refineExpressionPlanWithBackground(base, mood, {});
  assert.equal(off.background, undefined, '默认关闭不得改变 plan');
  assert.equal(off.stickerProbability, base.stickerProbability);
  const on = refineExpressionPlanWithBackground(base, mood, { refine: true });
  assert.ok(on.background, '开启后必须带 background 解释');
  assert.equal(on.background.factor, 0.85 * 0.9);
  assert.ok(on.stickerProbability <= base.stickerProbability);
  assert.ok(on.maxReplyChars <= base.maxReplyChars);
  assert.ok(on.reasons.length > base.reasons.length);
});

test('可视化：控制台情绪页含 SVG 曲线与跨会话标注（静态断言）', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'console.html'), 'utf8');
  assert.ok(html.includes('aria-label="情绪曲线"'), '必须有情绪曲线 SVG');
  assert.ok(html.includes('byTarget 为跨会话数据'), '必须标注跨会话数据');
});
