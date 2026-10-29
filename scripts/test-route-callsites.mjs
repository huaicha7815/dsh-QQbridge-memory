// 静态比对：每个 routes 模块声明的参数，bridge 调用点是否都传了。
//
// 为什么需要这个（而不是只靠 handler 测试）：handler 测试按「模块参数」生成 mock，
// 因此 bridge 漏传某个参数时它照样能过——它只能发现模块内部问题，发现不了调用方漂移。
// 这里做的是纯文本静态比对，不受运行分支影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROUTES = path.join(ROOT, 'src/routes');
const bridge = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');

/** 模块签名里声明的参数名 */
function moduleParams(file) {
  const src = fs.readFileSync(path.join(ROUTES, file), 'utf8');
  const sig = src.match(/export\s+(?:async\s+)?function\s+(\w+)\s*\(\{([\s\S]*?)\}\)\s*\{/);
  if (!sig) return null;
  const names = new Set();
  for (const part of sig[2].split(',')) {
    const t = part.trim();
    if (!t) continue;
    const [left, right] = t.split(':').map((x) => x && x.trim());
    if (left && /^[A-Za-z_$][\w$]*$/.test(left)) names.add(left);
    if (right && /^[A-Za-z_$][\w$]*$/.test(right)) names.add(left);
  }
  return { fn: sig[1], params: [...names] };
}

/** bridge 里该 handler 调用点实际传入的键名 */
function callArgs(fn) {
  const idx = bridge.indexOf(`${fn}({`);
  if (idx < 0) return null;
  const end = bridge.indexOf('})) return;', idx);
  if (end < 0) return null;
  const seg = bridge.slice(idx + fn.length + 2, end);
  const keys = new Set();
  // 按顶层逗号切（忽略对象/函数字面量里的逗号）
  let depth = 0;
  let cur = '';
  for (const ch of seg) {
    if ('{(['.includes(ch)) depth++;
    else if ('})]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      const key = cur.trim().split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.add(key);
      cur = '';
    } else cur += ch;
  }
  const lastKey = cur.replace(/[{}]/g, '').trim().split(':')[0].trim();
  if (/^[A-Za-z_$][\w$]*$/.test(lastKey)) keys.add(lastKey);
  return keys;
}

const FILES = [
  'memory-api.mjs', 'roles-api.mjs', 'tokens-api.mjs', 'stickers-api.mjs',
  'socialv2-memory-api.mjs', 'socialv2-state-api.mjs', 'socialv2-control-api.mjs',
  'socialv2-tools-api.mjs', 'socialv2-wake-slang-api.mjs', 'socialv2-send-api.mjs',
];

// 这些由调用方在调用点用 `req, url` 之类固定提供，或者在模块里是可选参数
const OPTIONAL = new Set(['req', 'url', 'sendJson', 'readBody']);

test('bridge 调用点传齐了所有 routes 模块声明的参数', () => {
  const problems = [];
  for (const file of FILES) {
    const info = moduleParams(file);
    if (!info) { problems.push(`${file}: 签名解析失败`); continue; }
    const passed = callArgs(info.fn);
    if (!passed) { problems.push(`${file}: bridge 里找不到 ${info.fn} 调用`); continue; }
    const missing = info.params.filter((p) => !passed.has(p) && !OPTIONAL.has(p));
    if (missing.length) problems.push(`${file}: bridge 漏传 → ${missing.join(', ')}`);
  }
  assert.deepEqual(problems, [], `调用点与模块声明不一致:\n${problems.join('\n')}`);
});
