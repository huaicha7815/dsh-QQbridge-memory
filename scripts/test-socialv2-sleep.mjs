// 睡眠判定与默认配置刷新（Step C 并入 core 的四个函数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPLICIT_END_RE, hasExplicitEnd, isSleepingConfig, preSleepWaitBlocked,
} from '../src/core/socialv2-wake.mjs';
import { refreshDefaultWakeConfig } from '../src/core/socialv2-store.mjs';

const msg = (text, isSelf = false, time = 0) => ({ text, isSelf, time, tail: text });

test('结束语识别：晚安/拜拜/去忙 等', () => {
  assert.ok(hasExplicitEnd({ recentMessages: [msg('不聊了，晚安')] }));
  assert.ok(hasExplicitEnd({ recentMessages: [msg('去洗澡了')] }));
  assert.ok(hasExplicitEnd({ recentMessages: [msg('886')] }));
  assert.ok(!hasExplicitEnd({ recentMessages: [msg('今天天气不错')] }));
  assert.ok(!hasExplicitEnd({ recentMessages: [msg('晚安', true)] }), '她自己说的不算');
  assert.ok(!hasExplicitEnd({ recentMessages: [] }));
  assert.ok(!hasExplicitEnd(null));
});

test('是否处于沉睡配置', () => {
  assert.equal(isSleepingConfig({ mode: 'active' }), false);
  assert.equal(isSleepingConfig({ mode: 'active', triggers: { anyMessage: true } }), false);
  assert.equal(isSleepingConfig({ mode: 'diving' }), true);
  assert.equal(isSleepingConfig({ mode: 'diving', triggers: { atMention: true } }), true, '只有 @ 也算潜水');
  assert.equal(isSleepingConfig(null), false);
});

test('沉睡前观察：安静满窗口就放行', () => {
  const now = 1_800_000_000_000;
  const cfg = { preSleepWaitMs: 300000 };
  // 刚收到消息，没等够
  assert.equal(preSleepWaitBlocked({ lastIncomingAt: now - 60_000 }, cfg, now), true);
  // 已经安静 5 分钟以上
  assert.equal(preSleepWaitBlocked({ lastIncomingAt: now - 300_001 }, cfg, now), false);
});

test('沉睡前观察：做过观察且之后没新消息就放行', () => {
  const now = 1_800_000_000_000;
  const cfg = { preSleepWaitMs: 300000 };
  const st = { lastIncomingAt: now - 60_000, preSleepWaitSatisfiedAt: now - 30_000 };
  assert.equal(preSleepWaitBlocked(st, cfg, now), false, '观察完之后没有新消息');
  const st2 = { lastIncomingAt: now - 10_000, preSleepWaitSatisfiedAt: now - 30_000 };
  assert.equal(preSleepWaitBlocked(st2, cfg, now), true, '观察之后又来了新消息 → 需要重新观察');
  const st3 = { lastIncomingAt: now - 10_000, preSleepWaitObservedAt: now - 20_000 };
  assert.equal(preSleepWaitBlocked(st3, cfg, now), true, 'AI 之后参与过（lastIncoming 更新）→ 拦住');
});

test('沉睡前观察：结束语不受限制 / 开关可关', () => {
  const now = 1_800_000_000_000;
  const cfg = { preSleepWaitMs: 300000 };
  assert.equal(preSleepWaitBlocked({ lastIncomingAt: now - 1000, recentMessages: [msg('晚安')] }, cfg, now), false);
  assert.equal(preSleepWaitBlocked({ lastIncomingAt: now - 1000 }, { ...cfg, preSleepWaitEnabled: false }, now), false);
  assert.equal(preSleepWaitBlocked(null, cfg, now), false);
});

test('默认唤醒配置刷新：只覆盖 confirmedBy=default 的会话', () => {
  const cfg = { recommendedDefaultInfinite: true };
  const isDefault = { wakeConfig: { confirmedBy: 'default', wakeCount: 3, lastWakeAt: 123 } };
  assert.equal(refreshDefaultWakeConfig(isDefault, cfg, () => 0), true);
  assert.equal(isDefault.wakeConfig.confirmedBy, 'default');
  assert.equal(isDefault.wakeConfig.wakeCount, 3, '计数要保留');
  assert.equal(isDefault.wakeConfig.lastWakeAt, 123, '上次唤醒时间要保留');

  const manual = { wakeConfig: { confirmedBy: 'agent', mode: 'active' } };
  assert.equal(refreshDefaultWakeConfig(manual, cfg, () => 0), false, 'AI 显式设过的不覆盖');
  assert.equal(manual.wakeConfig.mode, 'active');

  const admin = { wakeConfig: { confirmedBy: 'admin' } };
  assert.equal(refreshDefaultWakeConfig(admin, cfg, () => 0), false, '管理员设过的不覆盖');

  assert.equal(refreshDefaultWakeConfig(null, cfg, () => 0), false);
  assert.equal(refreshDefaultWakeConfig({}, cfg, () => 0), false);
});
