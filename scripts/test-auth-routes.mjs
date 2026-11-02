// 路由鉴权契约：agent 工具面必须与 bridge 的精确允许表完全一致（双向）。
//
// 允许表来自共享模块 `src/lib/agent-route-policy.mjs`（bridge 与测试同源）；
// MCP 端调用必须用词法扫描（括号/字符串感知）解析，且遇到无法静态解析的调用必须失败，
// 不能静默跳过（否则未来动态路由会绕过契约）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_ALLOWED_ROUTES, TOKENLESS_STATUS_PROBE } from '../src/lib/agent-route-policy.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const normalize = (s) => s.replace(/\r\n?/g, '\n');
const bridge = normalize(fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8'));
const mcp = normalize(fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8'));

/** 词法扫描 `agentApi(` 调用：平衡括号 + 字符串感知，返回参数文本数组。 */
function scanCallArgs(text, openParenIndex) {
  const args = [];
  let depth = 0;
  let argStart = openParenIndex + 1;
  let quote = null;
  for (let i = openParenIndex + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) { quote = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0 && ch === ')') { args.push(text.slice(argStart, i)); break; }
      depth -= 1;
      continue;
    }
    if (ch === ',' && depth === 0) { args.push(text.slice(argStart, i)); argStart = i + 1; }
  }
  return args;
}

/** 从单个参数文本里取字符串字面量（支持 'x' / "x" / `x`）。 */
function stringLiteral(arg) {
  const m = /^\s*(['"`])([\s\S]*?)\1/.exec(arg);
  return m ? m[2] : null;
}

/**
 * 收集 MCP 端实际调用的 agent 路由。
 * 返回 { routes, parsedCalls, skippedCalls }：任何无法静态解析的调用都必须计入 skippedCalls，
 * 契约测试据此 fail-closed。
 */
export function mcpAgentRoutesOf(source) {
  const routes = new Set();
  let parsedCalls = 0;
  const skipped = [];
  for (const m of source.matchAll(/(?<!function )(?<![.\w])agentApi\(/g)) {
    const openParen = m.index + 'agentApi'.length;
    const args = scanCallArgs(source, openParen);
    if (!args.length) { skipped.push({ at: m.index, reason: 'no-args' }); continue; }
    const rawPath = stringLiteral(args[0]);
    if (!rawPath) { skipped.push({ at: m.index, reason: 'non-literal-path' }); continue; }
    if (!rawPath.startsWith('/api/')) { skipped.push({ at: m.index, reason: 'non-api-path' }); continue; }
    // pathname（? 之前）必须完全静态；查询串里的动态参数不影响路由匹配。
    const pathname = rawPath.split('?')[0];
    if (pathname.includes('${')) { skipped.push({ at: m.index, reason: 'dynamic-path' }); continue; }
    parsedCalls += 1;
    // method 解析必须 fail-closed：无法静态确定就计入 skippedCalls，不能默认 GET。
    let method = 'GET';
    if (args[1]) {
      const opt = args[1].trim();
      if (!opt.startsWith('{')) {
        skipped.push({ at: m.index, reason: 'dynamic-options-object' });
        continue;
      }
      const methodLiteral = /\bmethod:\s*(['"])([A-Z]+)\1/.exec(opt);
      if (methodLiteral) {
        method = methodLiteral[2];
      } else if (/\bmethod\s*:/.test(opt)) {
        skipped.push({ at: m.index, reason: 'dynamic-method-value' });
        continue;
      } else if (/\{\s*\.\.\./.test(opt) || /,\s*\.\.\./.test(opt)) {
        // 无字面量 method 且含 spread：无法静态确定 method，fail-closed。
        skipped.push({ at: m.index, reason: 'spread-options' });
        continue;
      }
    }
    routes.add(method + ' ' + pathname);
  }
  return { routes, parsedCalls, skippedCalls: skipped };
}

/** 双向差集（允许表可以是冻结数组或 Set）。 */
export function diffRoutes(allowed, used) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  const usedSet = used instanceof Set ? used : new Set(used);
  return {
    missing: [...usedSet].filter((r) => !allowedSet.has(r)).sort(),
    unused: [...allowedSet].filter((r) => !usedSet.has(r)).sort(),
  };
}

test('MCP 调用的 agent 路由与允许表双向精确一致', () => {
  const { routes: used, parsedCalls, skippedCalls } = mcpAgentRoutesOf(mcp);
  assert.equal(skippedCalls.length, 0,
    `存在无法静态解析的 agentApi 调用（契约 fail-closed）：${JSON.stringify(skippedCalls)}`);
  assert.ok(parsedCalls >= 40, `解析到的调用点数量异常：${parsedCalls}`);
  assert.ok(used.size >= 40, `唯一路由数量异常：${used.size}`);
  const { missing, unused } = diffRoutes(AGENT_ALLOWED_ROUTES, used);
  assert.deepEqual(missing, [], `MCP 调用但允许表缺失（运行时会 403）：${missing.join(', ')}`);
  assert.deepEqual(unused, [], `允许表里有但 MCP 不用（多余攻击面）：${unused.join(', ')}`);
  assert.deepEqual([...used].sort(), [...AGENT_ALLOWED_ROUTES].sort(), '两侧集合必须完全相等');
});

test('反例：删掉任一 POST 路由后，双向比较必须报 missing（防止解析假绿）', () => {
  const { routes: used } = mcpAgentRoutesOf(mcp);
  const postRoute = [...AGENT_ALLOWED_ROUTES].find((r) => r.startsWith('POST '));
  assert.ok(postRoute, '允许表应有 POST 路由');
  const broken = new Set([...AGENT_ALLOWED_ROUTES].filter((r) => r !== postRoute));
  const { missing } = diffRoutes(broken, used);
  assert.ok(missing.includes(postRoute), `删掉 ${postRoute} 后必须报 missing`);
});

test('解析器必须同时识别 GET 与 POST', () => {
  const { routes: used } = mcpAgentRoutesOf(mcp);
  const posts = [...used].filter((r) => r.startsWith('POST '));
  const gets = [...used].filter((r) => r.startsWith('GET '));
  assert.ok(posts.length >= 20, `POST 解析数量异常：${posts.length}`);
  assert.ok(gets.length >= 10, `GET 解析数量异常：${gets.length}`);
});

test('允许表格式正确，且不含 /api/authorize/read', () => {
  for (const r of AGENT_ALLOWED_ROUTES) {
    assert.match(r, /^(GET|POST) \/api\//, `允许表项格式必须为 "METHOD /api/..."：${r}`);
  }
  assert.ok(!bridge.includes("'/api/authorize/read'"), 'authorize/read 路由与白名单项必须已删除');
});

test('tokenless status probe 是唯一例外，且 bridge 使用共享策略', () => {
  assert.deepEqual({ ...TOKENLESS_STATUS_PROBE }, { method: 'GET', path: '/api/status' });
  assert.ok(bridge.includes('isTokenlessStatusProbe(req.method, url.pathname)'), 'bridge 必须使用共享例外');
  assert.ok(bridge.includes('isAgentAllowedRoute(req.method, url.pathname)'), 'bridge 必须使用共享允许表');
  const gate = /if \(req\.headers\['x-agent-call'\] !== undefined\) \{[\s\S]*?if \(!tokenlessStatusProbe && !isLiveAgentToken\(/.exec(bridge);
  assert.ok(gate, 'x-agent-call 关卡必须保留 isLiveAgentToken 校验');
});

test('不可变性：允许表是冻结数组，push 会抛', () => {
  assert.ok(Object.isFrozen(AGENT_ALLOWED_ROUTES), '允许表必须冻结');
  assert.throws(() => AGENT_ALLOWED_ROUTES.push('POST /api/forbidden'), TypeError);
  assert.equal(AGENT_ALLOWED_ROUTES.includes('POST /api/forbidden'), false);
});

test('扫描器 fail-closed：动态 method / options / pathname 必须被跳过', () => {
  const fixtures = [
    ['dynamicMethodObject', "const opts = { method: 'POST' };\nagentApi('/api/socialV2/state', opts);", 'dynamic-options-object'],
    ['dynamicMethodValue', "agentApi('/api/socialV2/state', { method: verb });", 'dynamic-method-value'],
    ['spreadOptions', "agentApi('/api/socialV2/state', { ...base, body });", 'spread-options'],
    ['dynamicPathname', 'agentApi(`/api/socialV2/' + '${action}`);', 'dynamic-path'],
  ];
  for (const [name, src, reason] of fixtures) {
    const { skippedCalls, routes } = mcpAgentRoutesOf(src);
    assert.ok(skippedCalls.some((s) => s.reason === reason),
      `${name} 必须被标记为 ${reason}，实际 ${JSON.stringify(skippedCalls)}`);
    assert.equal(routes.size, 0, `${name} 不能产生路由`);
  }
  // 查询串插值必须继续允许（pathname 静态）
  const ok = mcpAgentRoutesOf('agentApi(`/api/socialV2/unread?key=' + '${key}`);');
  assert.equal(ok.skippedCalls.length, 0, '查询串插值不应被跳过');
  assert.ok(ok.routes.has('GET /api/socialV2/unread'), '查询串插值应解析出 pathname');
});
