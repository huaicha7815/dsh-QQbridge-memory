// /api/* 路由位置审计：所有路由处理与 route handler 调用都必须在集中鉴权关卡之后。
//
// 锚点必须精确（不能靠注释/关键词模糊匹配，否则会把关卡提前）：
//   入口：`const server = http.createServer(`
//   关卡：`const suppliedToken` → `if (consoleToken && !tokenMatches)` → `x-agent-call` 声明检查
// 找不到任何锚点 → exit 1（fail-closed，不能当成「没有违规」）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const source = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8').replace(/\r\n?/g, '\n');
const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8').replace(/\r\n?/g, '\n');
const lines = source.split('\n');

/** 在 [from, to] 行号范围内找第一条匹配的行号（1-based），找不到返回 -1。 */
function findLine(re, from = 0, to = lines.length) {
  for (let i = from; i < to && i < lines.length; i += 1) {
    if (re.test(lines[i])) return i + 1;
  }
  return -1;
}

const entryLine = findLine(/const server = http\.createServer\(/);
const suppliedTokenLine = findLine(/const suppliedToken\s*=/, entryLine > 0 ? entryLine - 1 : 0);
const consoleGateLine = findLine(/if \(consoleToken && !tokenMatches\)/, suppliedTokenLine > 0 ? suppliedTokenLine - 1 : 0);
const agentCallGateLine = findLine(/req\.headers\['x-agent-call'\] !== undefined/, consoleGateLine > 0 ? consoleGateLine - 1 : 0);

const anchors = {
  'http.createServer 入口': entryLine,
  'const suppliedToken': suppliedTokenLine,
  'consoleToken 拦截': consoleGateLine,
  'x-agent-call 声明关卡': agentCallGateLine,
};

let failed = false;
for (const [name, line] of Object.entries(anchors)) {
  if (line <= 0) {
    console.error(`FAIL 找不到关卡锚点：${name}（审计必须 fail-closed）`);
    failed = true;
  }
}
if (failed) {
  console.error('审计中止：锚点不完整，无法证明路由在关卡之后。');
  process.exit(1);
}
const gateLine = consoleGateLine;
if (!(entryLine < suppliedTokenLine && suppliedTokenLine < gateLine && gateLine < agentCallGateLine)) {
  console.error(`FAIL 关卡顺序异常：entry=${entryLine} suppliedToken=${suppliedTokenLine} consoleGate=${gateLine} agentCall=${agentCallGateLine}`);
  process.exit(1);
}
console.log(`gate 锚点：入口=${entryLine} 令牌解析=${suppliedTokenLine} 令牌拦截=${gateLine} agent声明=${agentCallGateLine}`);

// 只扫描「入口之后」的代码，找到所有 /api/ 路由分支。
const routeBranches = [];
for (let i = entryLine - 1; i < lines.length; i += 1) {
  const m = /url\.pathname\s*(===|\.startsWith\()\s*'(\/api\/[^']*)'/.exec(lines[i]);
  if (m) routeBranches.push({ line: i + 1, path: m[2], op: m[1] });
}
const beforeGate = routeBranches.filter((r) => r.line < gateLine);
console.log(`/api 路由分支：${routeBranches.length} 个（关卡之后 ${routeBranches.length - beforeGate.length} 个）`);
if (beforeGate.length) {
  console.error('FAIL 关卡前存在 /api 路由（鉴权绕过）：');
  for (const r of beforeGate) console.error(`  line ${r.line} ${r.path} ${r.op}`);
  failed = true;
}

// route handler：从 bridge 的 import 提取标识，断言每个都有调用点且都在关卡后。
const handlerNames = [];
for (const m of source.matchAll(/import\s*\{\s*(handle\w+)\s*\}\s*from\s*'\.\/routes\//g)) {
  handlerNames.push(m[1]);
}
if (!handlerNames.length) {
  console.error('FAIL 未解析到任何 route handler import');
  failed = true;
}
const handlerReports = [];
for (const name of handlerNames) {
  const callRe = new RegExp(`\\b${name}\\s*\\(`);
  const calls = [];
  for (let i = entryLine - 1; i < lines.length; i += 1) {
    if (callRe.test(lines[i])) calls.push(i + 1);
  }
  if (!calls.length) {
    console.error(`FAIL ${name} 没有任何调用点`);
    failed = true;
    continue;
  }
  const beforeCall = calls.filter((ln) => ln < gateLine);
  if (beforeCall.length) {
    console.error(`FAIL ${name} 在关卡前被调用：lines ${beforeCall.join(', ')}`);
    failed = true;
  }
  handlerReports.push({ name, calls: calls.length, first: calls[0] });
}
console.log(`route handler：${handlerNames.length} 个，全部在关卡后调用：${handlerReports.every((h) => h.first > gateLine) ? '是' : '否'}`);

// route 模块不允许自己建 HTTP server / 监听端口（否则可能绕过集中鉴权）。
const routeDir = path.join(ROOT, 'src', 'routes');
for (const f of fs.readdirSync(routeDir).filter((x) => x.endsWith('.mjs'))) {
  const text = fs.readFileSync(path.join(routeDir, f), 'utf8');
  if (/createServer\s*\(/.test(text) || /\.listen\s*\(/.test(text)) {
    console.error(`FAIL route 模块自行创建服务器/监听端口：${f}`);
    failed = true;
  }
}

// MCP 客户端不允许直接拼 HTTP 调 /api/*（必须走 agentApi，保证集中关卡生效）。
const directFetch = [...mcp.matchAll(/fetch\(\s*[`'"][^`'"]*\/api\//g)];
if (directFetch.length) {
  console.error(`FAIL MCP 端存在绕过 agentApi 的直接 fetch：${directFetch.length} 处`);
  failed = true;
}

if (failed) process.exit(1);
console.log('路由位置审计：通过（无关卡前路由 / 无绕过入口）');
