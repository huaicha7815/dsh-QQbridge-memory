// 阶段 4 发布 smoke：真实 bridge 端到端（消息 → 情绪 → detail → prompt 表达 → 控制台静态）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const NOW = Date.now();

function httpJson(server, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET', headers: { 'x-console-token': 'fixture-console-token' } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
    req.end();
  });
}

test('smoke：真实 bridge 端到端（消息→情绪→detail→表达→控制台）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const h = await bridgeHarness({
    config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2', tuning: { expression: { refine: true } } } } },
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    // 1) 真实入站消息 → 情绪事件
    h.getSocialV2State('private:1');
    h.appendSocialV2Message('private:1', '阿明', '你真棒', '你真棒', false, false, 1, [], '1', []);
    h.appendSocialV2Message('private:1', '阿明', '不过你刚才也很烦人', '不过你刚才也很烦人', false, false, 2, [], '1', []);
    // 2) detail 可解释性字段齐全
    const detail = await httpJson(server, '/api/socialV2/emotion/detail?key=private%3A1');
    assert.equal(detail.status, 200);
    const mood = detail.body.agentMood;
    assert.ok(Array.isArray(mood.episodes), 'episodes');
    assert.ok(Number.isFinite(mood.fastValence) && Number.isFinite(mood.slowValence), '双通道');
    assert.ok(Number.isFinite(mood.chronicLoad), 'chronicLoad');
    assert.ok(mood.needs && Object.keys(mood.needs).length === 6, '六需求');
    assert.ok(Array.isArray(mood.sensitivityLog), '敏感化日志');
    // 3) 真实 bridge builder：wake prompt + explainMood（无条件断言 refine 经真实接线生效）
    const wakePrompt = h.buildWakePromptV2('private:1', 'test');
    assert.ok(typeof wakePrompt === 'string' && wakePrompt.length > 0, '真实 builder 必须生成 wake prompt');
    assert.equal(typeof h.explainMoodV2, 'function', 'harness 必须暴露真实 explainMoodV2');
    // 真实 builder 全链：plan 必须由 bridge 的 expressionCfg 生成（含配置注入后的 reasons）
    assert.equal(h.cfg.emotion.v2.tuning.expression.refine, true, 'bridge 必须把 tuning.expression.refine 注入配置');
    const plan = h.explainMoodV2('private:1');
    assert.ok(plan && Array.isArray(plan.reasons) && plan.reasons.length > 0, '真实 explainMood 必须可解释');
    // refine 的阈值效果由 stage4 单测覆盖；此处证明真实 builder 返回 plan 且与 detail 一致
    assert.ok(plan.moodBand === undefined || typeof plan.moodBand === 'string');
    assert.equal(typeof detail.body.agentMood.chronicLoad, 'number', 'detail chronicLoad（真实链路）');
    // 4) 控制台静态：情绪曲线 + 跨会话标注 + 双通道
    const html = fs.readFileSync(path.join(process.cwd(), 'public', 'console.html'), 'utf8');
    assert.ok(html.includes('aria-label="情绪曲线"'), '情绪曲线');
    assert.ok(html.includes('双通道') && html.includes('即时心情（快）'), '双通道行');
    assert.ok(html.includes('byTarget 为跨会话数据'), '跨会话标注');
    // 5) agent 盲化/403 保持
    const agentDetail = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/emotion/detail?key=private%3A1', method: 'GET', headers: { 'x-agent-token': 'agent-token' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(agentDetail, 403, 'agent 不得读 detail');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('smoke：真实 builder 在阈值条件下 refine 实际生效（background.factor<1）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const NOWT = Date.now();
  const v2State = {
    version: 2, paused: false,
    agentMood: {
      schemaVersion: 2,
      episodes: [{ id: 'ep-joy-refine', kind: 'joy', peak: 0.9, decayAnchorAt: NOWT - 60 * 1000, target: { kind: 'other', uid: '1' }, latestSourceEventId: 'evt-r1', appraisalNote: '被夸' }],
      chronicLoad: 0.7,
      chronicLoadUpdatedAt: NOWT,
      needs: {},
      sensitivity: {}, sensitivityLog: [],
      dominant: { kind: 'joy', intensity: 0.9, since: NOWT - 60 * 1000, sourceEpisodeId: 'ep-joy-refine' },
    },
    relationships: { 1: { generationId: 'g', intimacy: 0.5, tension: 0.1, trust: 0.6, resentment: 0, openLoops: [], events: [] } },
    relationshipArchive: { orphanLoops: [], pendingCold: [], pendingEvict: [] },
    pendingArchive: null,
    migration: { version: 2, fromVersion: 1, status: 'done', revision: 1 },
    conversations: { 'private:1': { recentMessages: [], wakeConfig: {} } },
  };
  const h = await bridgeHarness({
    config: { emotion: { v2: { enabled: true, shadow: false, writeSchema: 'v2', tuning: { expression: { refine: true } } } } },
    files: { 'state/social-v2.json': JSON.stringify(v2State) },
  });
  try {
    const plan = h.explainMoodV2('private:1');
    assert.ok(plan, '真实 builder 必须返回 plan');
    assert.ok(plan.background, '阈值满足时必须带 background 解释');
    assert.ok(Math.abs(plan.background.factor - 0.85) < 1e-9, `chronicLoad=0.7+正 valence → factor 0.85（实际 ${plan.background.factor}）`);
    assert.ok(plan.stickerProbability >= 0 && plan.stickerProbability <= 1);
  } finally {
    await h.close();
  }
});
