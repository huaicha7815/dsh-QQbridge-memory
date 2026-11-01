// 记忆银河投影的专项测试（只读投影，不碰真实记忆库）。
// 覆盖：类型元数据 / ID 唯一 / 归档 / 约定状态 / 时间语义 / S3 去重 / 路径守卫 / 前端转义 / 导出排除规则。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportGalaxy, assertOutOutsideMemory } from '../scripts/lib/galaxy-export.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function makeLib({ events = [], salient = [], archive = [], profile = {}, days = [] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-test-'));
  const mem = path.join(base, 'state', 'memory');
  fs.mkdirSync(path.join(mem, 'events'), { recursive: true });
  fs.writeFileSync(path.join(mem, 'events', '2026-01-05.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (salient.length) fs.writeFileSync(path.join(mem, 'salient.jsonl'), salient.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (archive.length) {
    fs.mkdirSync(path.join(mem, 'events-archive'), { recursive: true });
    fs.writeFileSync(path.join(mem, 'events-archive', '2025-12.jsonl'), archive.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(mem, 'profile.json'), JSON.stringify(profile));
  for (const [day, note] of days) {
    fs.mkdirSync(path.join(mem, 'days'), { recursive: true });
    fs.writeFileSync(path.join(mem, 'days', `${day}.json`), JSON.stringify(note));
  }
  return { base, mem };
}

const T = Date.now();
const outOf = (base) => path.join(base, 'galaxy-data.json');

test('galaxy：类型元数据 rawKind/source/tau 正确', () => {
  const { base, mem } = makeLib({
    events: [{ t: T, k: 'private:1', kind: 'msg', text: '重要事件', s: 3 }],
    salient: [{ id: 's3-1', t: T, k: 'private:1', text: 'S3 记忆', s: 3 }],
    profile: {
      people: { 爸爸: { facts: [{ text: '事实一', confirmedAt: T - 1000, createdAt: T - 9000 }] } },
      threads: [{ text: '约定一', state: 'open', createdAt: T - 5000, lastMentionAt: T - 100 }],
    },
    days: [['2026-01-05', { day: '2026-01-05', ts: T - 3600000, lines: [{ t: '摘要一句', s: 2 }] }]],
  });
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base), labels: { core: '鱼鱼' } });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  const byKind = {};
  for (const s of data.stars) byKind[s.kind] = s;
  assert.equal(byKind.event.rawKind, 'event');
  assert.equal(byKind.event.tau, 45);
  assert.equal(byKind.feeling.rawKind, 'feeling');
  assert.equal(byKind.feeling.tau, 150);
  assert.equal(byKind.fact.rawKind, 'fact');
  assert.equal(byKind.fact.tau, 300);
  assert.equal(byKind.plan.rawKind, 'plan');
  assert.equal(byKind.plan.tau, 240);
  assert.equal(byKind.conclusion.rawKind, 'digest_day');
  assert.equal(byKind.conclusion.tau, 999);
  for (const s of data.stars) assert.equal(s.source, 'qq-bridge');
  assert.equal(data.meta.partial, false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：缺少 id 的事件得到唯一稳定 ID（不是 "undefined"）', () => {
  const { base, mem } = makeLib({
    events: [
      { t: T, k: 'a', kind: 'msg', text: '没有 id 的事件一', s: 3 },
      { t: T + 1, k: 'a', kind: 'msg', text: '没有 id 的事件二', s: 3 },
    ],
  });
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  const ids = data.stars.map((s) => s.id);
  assert.equal(ids.length, 2);
  for (const id of ids) assert.notEqual(id, 'undefined');
  assert.equal(new Set(ids).size, 2);
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：归档事件也会被投影', () => {
  const { base, mem } = makeLib({
    archive: [{ t: T - 86400000 * 40, k: 'group:9', kind: 'msg', text: '归档里的重要记忆', s: 3 }],
  });
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  const hit = data.stars.find((s) => s.text.includes('归档里的重要记忆'));
  assert.ok(hit, '归档事件应出现在星图里');
  assert.equal(hit.kind, 'event');
  assert.ok(hit.tags.includes('归档'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：done thread 不出现，open thread 用 lastMentionAt', () => {
  const { base, mem } = makeLib({
    profile: {
      people: {},
      threads: [
        { text: '已了结的约定', state: 'done', createdAt: T - 9000, lastMentionAt: T - 9000 },
        { text: '还在的约定', state: 'open', createdAt: T - 90000, lastMentionAt: T - 1000 },
      ],
    },
  });
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  const plans = data.stars.filter((s) => s.kind === 'plan');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].title, '还在的约定');
  assert.equal(plans[0].at, T - 1000);
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：人物事实时间取最新 confirmedAt', () => {
  const { base, mem } = makeLib({
    profile: {
      people: {
        甲: {
          lastSeen: T - 500000,
          facts: [
            { text: '旧事实', confirmedAt: T - 100000, createdAt: T - 100000 },
            { text: '新事实', confirmedAt: T - 42, createdAt: T - 9000 },
          ],
        },
      },
      threads: [],
    },
  });
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  const person = data.stars.find((s) => s.kind === 'fact');
  assert.equal(person.at, T - 42);
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：S3 与同 id 事件去重（只保留 S3 那颗）', () => {
  const { base, mem } = makeLib({
    events: [{ id: 'same-id', t: T, k: 'private:1', kind: 'msg', text: '同一条记忆', s: 3 }],
    salient: [{ id: 'same-id', t: T, k: 'private:1', text: '同一条记忆', s: 3 }],
  });
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  const hits = data.stars.filter((s) => s.id === 'same-id');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'feeling');
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：拒绝把导出物写进记忆库，且导出不改记忆库字节', () => {
  const { base, mem } = makeLib({
    events: [{ t: T, k: 'a', kind: 'msg', text: '事件', s: 3 }],
  });
  assert.throws(() => assertOutOutsideMemory(path.join(mem, 'galaxy.json'), mem), /拒绝/);
  assert.throws(() => exportGalaxy({ memoryDir: mem, outFile: path.join(mem, 'galaxy.json') }), /拒绝/);
  const before = fs.readFileSync(path.join(mem, 'events', '2026-01-05.jsonl'), 'utf8');
  exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const after = fs.readFileSync(path.join(mem, 'events', '2026-01-05.jsonl'), 'utf8');
  assert.equal(after, before);
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：前端对记忆字段做转义（防 stored DOM XSS）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'tools', 'memory-galaxy', 'index.html'), 'utf8');
  assert.ok(html.includes('function esc('), 'index.html 必须有转义函数');
  assert.ok(html.includes('esc(s.id)'), 'data-id 必须转义');
  assert.ok(html.includes('esc(s.title)'), '标题必须转义');
  assert.ok(html.includes('esc(t)'), '标签必须转义');
  assert.equal((html.match(/<span>#\$\{t\}/g) || []).length, 0, '不能再有未转义的标签拼接');
});

test('galaxy：公开导出排除记忆数据文件', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'export-public.mjs'), 'utf8');
  assert.ok(/galaxy-data\\\.json|galaxy-data\*\.json/.test(src), 'export-public 必须排除 galaxy-data.json');
});


test('galaxy：archive 与 live 同 ID 只投影一次（星和消息都不重复）', () => {
  const { base, mem } = makeLib({
    events: [{ id: 'dup-1', t: T, k: 'private:1', kind: 'msg', text: '同一条事件', s: 3 }],
    archive: [{ id: 'dup-1', t: T, k: 'private:1', kind: 'msg', text: '同一条事件', s: 3, srcDay: '2026-01-05' }],
  });
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  assert.equal(data.stars.filter((s) => s.id === 'dup-1').length, 1, '星只能有一颗');
  assert.equal(data.messages.filter((m) => m.text === '同一条事件' && m.key === 'private:1').length, 1, '消息点只能有一条');
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：同 ID 不同内容记 id-conflict 且不产生两个同 ID 星', () => {
  const { base, mem } = makeLib({
    events: [
      { id: 'conflict-1', t: T, k: 'a', kind: 'msg', text: '内容一', s: 3 },
      { id: 'conflict-1', t: T + 5, k: 'a', kind: 'msg', text: '内容二', s: 3 },
    ],
  });
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  assert.equal(data.meta.partial, true);
  assert.ok(data.meta.errors.some((e) => String(e.error).includes('id-conflict')));
  const ids = data.stars.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, '最终 ID 必须唯一');
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：无 ID 事件按 t+k+text 指纹去重', () => {
  const { base, mem } = makeLib({
    events: [
      { t: T, k: 'a', kind: 'msg', text: '重复导入的事件', s: 3 },
      { t: T, k: 'a', kind: 'msg', text: '重复导入的事件', s: 3 },
    ],
  });
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  assert.equal(data.stars.filter((s) => s.text === '重复导入的事件').length, 1);
  assert.equal(data.messages.filter((m) => m.text === '重复导入的事件').length, 1);
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：tauByRaw 输出 schema 与 observed，且所有 rawKind 都在 schema 内', () => {
  const { base, mem } = makeLib({
    events: [{ t: T, k: 'a', kind: 'msg', text: '事件', s: 3 }],
    salient: [{ id: 's-1', t: T, k: 'a', text: 'S3', s: 3 }],
    profile: {
      people: { 甲: { facts: [{ text: '事实', confirmedAt: T }] } },
      threads: [{ text: '约定', state: 'open', createdAt: T, lastMentionAt: T }],
    },
    days: [['2026-01-05', { day: '2026-01-05', ts: T, lines: [{ t: '摘要', s: 2 }] }]],
  });
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  const { schema, observed } = data.meta.tauByRaw;
  assert.equal(schema.event, 45);
  assert.equal(schema.feeling, 150);
  assert.equal(schema.fact, 300);
  assert.equal(schema.plan, 240);
  assert.equal(schema.digest_day, 999);
  for (const [rawKind, tau] of Object.entries(observed)) {
    assert.ok(Object.hasOwn(schema, rawKind), 'observed 里不能出现未登记 rawKind: ' + rawKind);
    assert.equal(tau, schema[rawKind]);
  }
  assert.equal(data.meta.errors.filter((e) => String(e.error).includes('rawKind')).length, 0);
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：thread 用文本 hash 当 ID（数组重排不改变身份）', () => {
  const { base, mem } = makeLib({
    profile: {
      people: {},
      threads: [
        { text: '约定甲', state: 'open', createdAt: T - 10, lastMentionAt: T - 10 },
        { text: '约定乙', state: 'open', createdAt: T - 20, lastMentionAt: T - 20 },
      ],
    },
  });
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  const ids = data.stars.filter((s) => s.kind === 'plan').map((s) => s.id);
  assert.equal(ids.length, 2);
  for (const id of ids) assert.ok(id.startsWith('thread:'));
  assert.equal(new Set(ids).size, 2);
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：前端详情面板与不完整横幅（XSS 闭合 + partial 可见）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'tools', 'memory-galaxy', 'index.html'), 'utf8');
  assert.ok(html.includes('esc(s.key)'), '消息详情 key 必须转义');
  assert.ok(html.includes('esc(s.rawKind)'), 'rawKind 必须转义');
  assert.ok(html.includes("esc((KIND[s.kind] || {}).label || s.kind)"), 'kind 标签必须转义');
  assert.ok(html.includes('data-incomplete-banner'), 'partial 时必须有可见横幅');
});


test('galaxy：结构非法的 JSONL 行（null/字符串/数组/{}）不崩溃，计 schemaErrors', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-bad-'));
  const mem = path.join(base, 'state', 'memory');
  fs.mkdirSync(path.join(mem, 'events'), { recursive: true });
  const lines = [
    JSON.stringify({ t: T, k: 'a', kind: 'msg', text: '合法事件', s: 3 }),
    'null',
    '"just a string"',
    '[1,2,3]',
    '{}',
    JSON.stringify({ t: 0, k: 'a', kind: 'msg', text: '时间非法', s: 3 }),
  ];
  fs.writeFileSync(path.join(mem, 'events', '2026-01-05.jsonl'), lines.join('\n') + '\n');
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  assert.equal(data.meta.partial, true);
  assert.ok(data.meta.errors.some((e) => e.schemaErrors > 0), '必须记录 schemaErrors');
  assert.equal(data.stars.filter((x) => x.text === '合法事件').length, 1);
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：重复冲突内容（X/A, X/B, X/B）最终 ID 唯一且内容各留一条', () => {
  const { base, mem } = makeLib({
    events: [
      { id: 'X', t: T, k: 'a', kind: 'msg', text: 'A', s: 3 },
      { id: 'X', t: T + 1, k: 'a', kind: 'msg', text: 'B', s: 3 },
      { id: 'X', t: T + 1, k: 'a', kind: 'msg', text: 'B', s: 3 },
    ],
  });
  const r = exportGalaxy({ memoryDir: mem, outFile: outOf(base) });
  const data = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  const ids = data.stars.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, '最终 ID 必须唯一');
  assert.equal(data.stars.filter((s) => s.text === 'A').length, 1);
  assert.equal(data.stars.filter((s) => s.text === 'B').length, 1, '重复冲突内容只留一条');
  assert.ok(data.meta.errors.some((e) => String(e.error).includes('id-conflict')));
  // 消息点：A、B 各一条（B 的第二次导入被指纹去重）
  assert.equal(data.messages.filter((m) => m.text === 'A').length, 1);
  assert.equal(data.messages.filter((m) => m.text === 'B').length, 1);
  fs.rmSync(base, { recursive: true, force: true });
});

test('galaxy：预览服务有 Host 白名单（防 DNS rebinding）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'galaxy-preview.mjs'), 'utf8');
  assert.ok(src.includes('ALLOWED_HOSTS'), '必须有 Host 白名单');
  assert.ok(src.includes('isAllowedHost(req)'), '必须校验 Host');
  assert.ok(src.includes('403'), '非白名单 Host 返回 403');
});

test('galaxy：横幅用未截断的 errorCount，sources 用 DOM 文本', () => {
  const html = fs.readFileSync(path.join(ROOT, 'tools', 'memory-galaxy', 'index.html'), 'utf8');
  assert.ok(html.includes('meta.errorCount'), '横幅显示 errorCount');
  assert.ok(!html.includes("el('sources').innerHTML"), 'sources 不再用 innerHTML 拼字符串');
  assert.ok(html.includes("document.createElement('span')"), 'sources 用 DOM 节点');
});
