// 控制台「她的情绪」页：情绪快照（每句话发出时的 mood）与只读 API。
//
// 覆盖：
//   1. bridge 发送后记录快照（字段完整、只记 AI 自己的话）；
//   2. 每会话 200 条上限、落盘、重启后（新 store 读文件）仍在；
//   3. /api/socialV2/mood-history：控制台可读、agent token 拒绝、坏 key 400。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { bridgeHarness } from './audit-bridge-harness.mjs';
import { handleSocialV2StateApi } from '../src/routes/socialv2-state-api.mjs';
import { canonicalV2Key } from '../src/core/socialv2-store.mjs';

test('情绪快照：AI 发一句话后记录当时的心情（字段完整）', async () => {
  const h = await bridgeHarness();
  h.setMode('reserved2');
  try {
    const key = 'private:123';
    // 先制造情绪（被夸 → 心情变好），再发送。
    h.appendSocialV2Message(key, '阿明', '你好可爱呀真的好可爱', '你好可爱呀真的好可爱', false, false, 5001, [], '123', []);
    h.recordSentMessagesV2(key, ['谢谢你呀']);
    const history = h.readMoodHistory(key, 10);
    assert.equal(history.length, 1, '每发一句话应记一条快照');
    const snap = history[0];
    assert.equal(snap.text, '谢谢你呀');
    assert.ok(typeof snap.at === 'number' && snap.at > 0);
    assert.equal(typeof snap.valence, 'number');
    assert.equal(typeof snap.arousal, 'number');
    assert.equal(typeof snap.energy, 'number');
    assert.ok(snap.valence > 0, '被夸之后心情应偏正');
    assert.ok(typeof snap.moodBand === 'string' && snap.moodBand.length > 0, '快照应带表达层心情档位');
    // 落盘
    const file = path.join(h.temp, 'state', 'mood-history.json');
    assert.ok(fs.existsSync(file), '情绪轨迹应落盘');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(saved.byKey[key]) && saved.byKey[key].length === 1);
  } finally {
    await h.close();
  }
});

test('情绪快照：每会话最多 1000 条（旧的被淘汰，最新保留）', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'private:123';
    for (let i = 0; i < 1005; i++) h.recordMoodSnapshot(key, `第 ${i} 句`);
    const history = h.readMoodHistory(key, 2000);
    assert.equal(history.length, 1000, '上限必须是 1000');
    assert.equal(history[history.length - 1].text, '第 1004 句', '最新一条保留');
    assert.equal(history[0].text, '第 5 句', '最旧的 5 条被淘汰');
  } finally {
    await h.close();
  }
});

// ── 只读 API ────────────────────────────────────────────────────────────

function makeDeps({
  pathname = '/api/socialV2/mood-history?key=private:1',
  headers = {},
  readMoodHistory,
  isMoodHistoryDegraded,
  canonicalV2Key: canonical = canonicalV2Key,
} = {}) {
  const responses = [];
  const deps = {
    req: { method: 'GET', headers },
    url: new URL('http://127.0.0.1' + pathname),
    sendJson: (body, status = 200) => responses.push({ body, status }),
    readBody: async () => ({}),
    getSocialV2State: () => ({ unread: [], recentMessages: [], activeTopics: [], pendingThoughts: [] }),
    saveSocialV2State: () => {},
    agentTokenOk: () => true, v2SessionAllowed: () => true, v2ToolEnabled: () => true,
    log: () => {},
    readMoodHistory,
    isMoodHistoryDegraded,
    canonicalV2Key: canonical,
  };
  return { deps, responses };
}

test('mood-history API：控制台可读，返回快照列表', async () => {
  const rows = [{ at: 1, text: '你好', valence: 0.3, arousal: 0.4, energy: 0.6, moodBand: '开心' }];
  const { deps, responses } = makeDeps({ readMoodHistory: () => rows });
  const handled = await handleSocialV2StateApi(deps);
  assert.equal(handled, true, '路由应被处理');
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.ok, true);
  assert.equal(responses[0].body.count, 1);
  assert.deepEqual(responses[0].body.history, rows);
});

test('mood-history API：agent token 一律拒绝（发送轨迹只给控制台）', async () => {
  const { deps, responses } = makeDeps({ headers: { 'x-agent-token': 'agent-x' }, readMoodHistory: () => [] });
  const handled = await handleSocialV2StateApi(deps);
  assert.equal(handled, true);
  assert.equal(responses[0].status, 403);
  assert.equal(responses[0].body.ok, false);
});

test('mood-history API：坏 key 400、缺 key 400', async () => {
  for (const pathname of ['/api/socialV2/mood-history', '/api/socialV2/mood-history?key=bad-key']) {
    const { deps, responses } = makeDeps({ pathname, readMoodHistory: () => [] });
    const handled = await handleSocialV2StateApi(deps);
    assert.equal(handled, true);
    assert.equal(responses[0].status, 400, `${pathname} 应 400`);
  }
});

// ── 审查 r1 补齐：批量顺序 / 隔离 / 恢复 / 副本 / 损坏降级 / 边界 ─────────

test('情绪快照：连续发送 3 条——数量、文本顺序、at 非递减', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'private:123';
    h.recordSentMessagesV2(key, ['第一句', '第二句', '第三句']);
    const history = h.readMoodHistory(key, 10);
    assert.equal(history.length, 3);
    // 跨 vm realm 的数组原型不同，deepEqual 严格模式会失败：用拼接比较内容。
    assert.equal(history.map((s) => s.text).join('|'), '第一句|第二句|第三句');
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i].at >= history[i - 1].at, 'at 必须非递减');
    }
  } finally {
    await h.close();
  }
});

test('情绪快照：只记录实际传入（成功发送）的消息，失败消息不会凭空出现', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'private:123';
    // 调用方只在发送成功后传入已发消息：这里模拟「部分成功」只传 2 条。
    h.recordSentMessagesV2(key, ['成功一', '成功二']);
    const history = h.readMoodHistory(key, 10);
    assert.equal(history.length, 2);
    assert.equal(history.map((s) => s.text).join('|'), '成功一|成功二');
  } finally {
    await h.close();
  }
});

test('情绪快照：多会话隔离（不同 key 各自独立）', async () => {
  const h = await bridgeHarness();
  try {
    h.recordSentMessagesV2('private:1', ['会话一']);
    h.recordSentMessagesV2('private:2', ['会话二']);
    assert.equal(h.readMoodHistory('private:1', 10).map((s) => s.text).join('|'), '会话一');
    assert.equal(h.readMoodHistory('private:2', 10).map((s) => s.text).join('|'), '会话二');
    assert.equal(h.readMoodHistory('private:3', 10).length, 0);
  } finally {
    await h.close();
  }
});

test('情绪快照：新实例从文件恢复（清缓存模拟重启）', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'private:123';
    h.recordSentMessagesV2(key, ['重启前的话']);
    // 清内存缓存 = 模拟重启后第一次读取（从 state/mood-history.json 加载）
    h.resetMoodHistoryCacheForTest();
    const history = h.readMoodHistory(key, 10);
    assert.equal(history.length, 1, '重启后应从文件恢复');
    assert.equal(history[0].text, '重启前的话');
  } finally {
    await h.close();
  }
});

test('情绪快照：readMoodHistory 返回深拷贝（改返回值不能污染内部缓存）', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'private:123';
    h.recordSentMessagesV2(key, ['原始文本']);
    const rows = h.readMoodHistory(key, 5);
    rows[0].text = 'MUTATED';
    rows[0].valence = 99;
    const again = h.readMoodHistory(key, 5);
    assert.equal(again[0].text, '原始文本', '内部缓存不能被调用方修改');
    assert.notEqual(again[0].valence, 99);
  } finally {
    await h.close();
  }
});

test('情绪快照：损坏的 JSON 被备份成 .corrupt，降级期间不自动覆盖', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'private:123';
    const file = path.join(h.temp, 'state', 'mood-history.json');
    const backup = `${file}.corrupt`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken json', 'utf8');
    h.resetMoodHistoryCacheForTest();
    // 触发加载（第一次读会备份 + 降级）
    h.recordSentMessagesV2(key, ['降级期间的话']);
    assert.equal(h.isMoodHistoryDegraded(), true, '损坏后应进入降级状态');
    assert.ok(fs.existsSync(backup), '损坏文件必须备份成 .corrupt');
    assert.equal(fs.readFileSync(backup, 'utf8'), '{broken json', '备份内容必须是原始损坏文件');
    assert.equal(fs.existsSync(file), false, '原文件已改名，降级期间不能再生成覆盖');
    // 内存里本次记录仍可读（页面可用）
    const history = h.readMoodHistory(key, 10);
    assert.equal(history.length, 1);
    assert.equal(history[0].text, '降级期间的话');
  } finally {
    await h.close();
  }
});

test('mood-history API：canonical key（前导零归一化；0/超大数拒绝）', async () => {
  // 前导零：归一化为 private:123
  {
    const { deps, responses } = makeDeps({ pathname: '/api/socialV2/mood-history?key=private:000123', readMoodHistory: () => [] });
    await handleSocialV2StateApi(deps);
    assert.equal(responses[0].status, 200);
    assert.equal(responses[0].body.key, 'private:123');
  }
  for (const key of ['private:0', 'group:0', 'private:99999999999999999999']) {
    const { deps, responses } = makeDeps({ pathname: '/api/socialV2/mood-history?key=' + key, readMoodHistory: () => [] });
    await handleSocialV2StateApi(deps);
    assert.equal(responses[0].status, 400, `${key} 应 400`);
  }
});

test('mood-history API：limit 取整并 clamp 到 1..1000', async () => {
  const cases = [
    ['0', 1], ['2.7', 2], ['999', 999], ['5000', 1000], ['-5', 1], ['abc', 60], ['', 60],
  ];
  for (const [raw, expected] of cases) {
    let seen = null;
    const pathname = '/api/socialV2/mood-history?key=private:1' + (raw === '' ? '&limit=' : '&limit=' + raw);
    const { deps, responses } = makeDeps({ pathname, readMoodHistory: (key, limit) => { seen = limit; return []; } });
    await handleSocialV2StateApi(deps);
    assert.equal(responses[0].status, 200, `limit=${raw} 应 200`);
    assert.equal(seen, expected, `limit=${raw} 应 clamp 为 ${expected}`);
  }
});

test('mood-history API：degraded 状态透出（前端可提示历史文件损坏）', async () => {
  const { deps, responses } = makeDeps({ readMoodHistory: () => [], isMoodHistoryDegraded: () => true });
  await handleSocialV2StateApi(deps);
  assert.equal(responses[0].body.degraded, true);
});

// ── 审查 r2 补齐：LRU / 单次写盘 / 体积门禁 ──────────────────────────────

function seedHistoryFile(h, byKey) {
  const file = path.join(h.temp, 'state', 'mood-history.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, byKey }), 'utf8');
  return file;
}

test('情绪快照：会话上限 24，按最后 at 真正淘汰最旧（41–45 会话场景）', async () => {
  const h = await bridgeHarness();
  try {
    const byKey = {};
    for (let s = 1; s <= 45; s++) {
      byKey['private:' + (1000 + s)] = [{ at: s, text: '会话 ' + s, valence: 0, arousal: 0.3, energy: 0.6 }];
    }
    seedHistoryFile(h, byKey);
    h.resetMoodHistoryCacheForTest();
    // 触发一次保存：新增一个 at 最大的会话 → trim 后只保留 24 个
    h.recordMoodSnapshot('private:9999', '最新会话');
    const file = path.join(h.temp, 'state', 'mood-history.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = Object.keys(saved.byKey);
    assert.equal(keys.length, 24, '全局最多 24 个会话');
    assert.ok(saved.byKey['private:9999'], '最新会话保留');
    assert.ok(saved.byKey['private:1045'], 'at 最大的旧会话保留');
    assert.equal(saved.byKey['private:1001'], undefined, 'at 最小的会话被淘汰');
    assert.equal(saved.byKey['private:1022'], undefined, '按 at 排序后第 22 个也被淘汰');
    assert.ok(saved.byKey['private:1023'], '排第 23 的会话保留（24 个名额内）');
  } finally {
    await h.close();
  }
});

test('情绪快照：一次发送 3 条消息只写一次历史文件（写放大修复）', async () => {
  const h = await bridgeHarness();
  try {
    const writes = [];
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = (file, ...rest) => {
      if (String(file).includes('mood-history.json')) writes.push(String(file));
      return origWrite(file, ...rest);
    };
    try {
      h.recordSentMessagesV2('private:123', ['一', '二', '三']);
    } finally {
      fs.writeFileSync = origWrite;
    }
    assert.equal(writes.length, 1, `3 条消息应只写 1 次，实际 ${writes.length} 次`);
    assert.equal(h.readMoodHistory('private:123', 10).length, 3);
  } finally {
    await h.close();
  }
});

test('情绪快照：满容量（24 会话 × 1000 条 × 最大字段）文件必须 < 30 MB，单次保存 < 600ms', async () => {
  const h = await bridgeHarness();
  try {
    const longText = '字'.repeat(160);
    const longCause = '因'.repeat(120);
    const snapshot = (i) => ({
      at: i, text: longText, valence: 0.5, arousal: 0.5, energy: 0.5,
      cause: longCause, causeType: 'praised', moodBand: '开心',
      maxReplyChars: 220, stickerProbability: 0.6, voiceProbability: 0.1,
    });
    const byKey = {};
    for (let s = 0; s < 24; s++) {
      byKey['private:' + (2000 + s)] = Array.from({ length: 1000 }, (_, i) => snapshot(i));
    }
    const file = seedHistoryFile(h, byKey);
    h.resetMoodHistoryCacheForTest();
    // 预热一次（不计时），再测 3 次取中位数：单次 600ms 阈值在完整 daily 负载下会抖动（评审 P2）
    h.recordMoodSnapshot('private:9998', '预热保存');
    const samples = [];
    for (let i = 0; i < 3; i += 1) {
      const started = Date.now();
      h.recordMoodSnapshot('private:9998', `触发保存${i}`);
      samples.push(Date.now() - started);
    }
    samples.sort((a, b) => a - b);
    const elapsed = samples[1];
    const size = fs.statSync(file).size;
    assert.ok(size < 30 * 1024 * 1024, `最大历史文件必须 < 30MB，实际 ${(size / 1024 / 1024).toFixed(2)}MB`);
    assert.ok(elapsed < 600, `单次保存（中位数）必须 < 600ms，实际 ${elapsed}ms（样本 ${samples.join('/')}）`);
  } finally {
    await h.close();
  }
});
