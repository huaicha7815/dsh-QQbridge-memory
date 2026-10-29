#!/usr/bin/env node
/**
 * 生成 HTTP 接口清单（docs/ROUTES.md）。
 *
 * 为什么需要：bridge.js 里的端点散在 1.1 万行的 if 链里，开源之后新人想知道
 * 「有哪些接口、哪个文件负责哪块」只能全文搜索。这份文档从源码**自动生成**，
 * 不会跟代码脱节；拆到 src/routes/ 的端点也会被一起扫进来。
 *
 * 用法：
 *   node scripts/gen-routes-doc.mjs          生成/更新 docs/ROUTES.md
 *   node scripts/gen-routes-doc.mjs --check  只检查是否最新（CI 用，过期退出码 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(root, 'docs', 'ROUTES.md');
const CHECK = process.argv.includes('--check');

// 自动收集：bridge.js + src/routes/ 下所有拆出去的域模块，
// 以后新增模块不用改这个脚本（只要它按同样写法写路由判断）。
const ROUTE_DIR = path.join(root, 'src', 'routes');
const routeModules = fs.existsSync(ROUTE_DIR)
  ? fs.readdirSync(ROUTE_DIR).filter((n) => n.endsWith('.mjs')).sort().map((n) => ({
    file: `src/routes/${n}`,
    label: `routes/${n}`,
  }))
  : [];
const SOURCES = [
  { file: 'src/bridge.js', label: 'bridge.js（主服务）' },
  ...routeModules,
].map((s) => ({ ...s, abs: path.join(root, s.file) })).filter((s) => fs.existsSync(s.abs));

/** 从一行代码里抠出 (method, path)；匹配不到返回 null。 */
function parseRouteLine(line) {
  const m1 = line.match(/req\.method === '([A-Z]+)'\s*&&\s*url\.pathname === '([^']+)'/);
  if (m1) return { method: m1[1], path: m1[2], prefix: false };
  const m2 = line.match(/req\.method === '([A-Z]+)'\s*&&\s*url\.pathname\.startsWith\('([^']+)'\)/);
  if (m2) return { method: m2[1], path: `${m2[2]}*`, prefix: true };
  const m3 = line.match(/url\.pathname === '([^']+)'/);
  if (m3) return { method: 'ANY', path: m3[1], prefix: false };
  const m4 = line.match(/url\.pathname\.startsWith\('([^']+)'\)/);
  if (m4) return { method: 'ANY', path: `${m4[1]}*`, prefix: true };
  return null;
}

/** 往上找最近的一条注释，当作这个端点的说明。 */
function nearbyComment(lines, idx) {
  for (let i = idx - 1; i >= Math.max(0, idx - 6); i -= 1) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('//')) {
      return t.replace(/^\/+\s*/, '').replace(/[。；]+$/, '');
    }
    break;
  }
  return '';
}

const all = [];
for (const src of SOURCES) {
  const lines = fs.readFileSync(src.abs, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const route = parseRouteLine(lines[i]);
    if (!route) continue;
    all.push({ ...route, file: src.file, label: src.label, line: i + 1, comment: nearbyComment(lines, i) });
  }
}

// 按「第一段路径」分组，方便按域找
const groupOf = (p) => {
  const seg = p.split('/').filter(Boolean);
  if (!seg.length) return '(根)';
  if (seg[0] === 'api' && seg[1]) return `api/${seg[1]}`;
  return seg[0];
};
const groups = new Map();
for (const r of all) {
  const g = groupOf(r.path);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(r);
}
const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

const body = [
  '# HTTP 接口清单',
  '',
  '> 这份文档由 `node scripts/gen-routes-doc.mjs` 从源码自动生成，**不要手改**。',
  '> 改了端点之后重新跑一次，或让 `npm run routes:doc` 帮你更新。',
  '',
  `共 **${all.length}** 个路由判断，分布在 ${SOURCES.length} 个文件里。`,
  '',
  '## 按域统计',
  '',
  '| 域 | 端点数 | 主要文件 |',
  '| --- | --- | --- |',
  ...sorted.map(([g, list]) => `| \`${g}\` | ${list.length} | ${[...new Set(list.map((r) => r.file))].join('<br>')} |`),
  '',
];
for (const [g, list] of sorted) {
  body.push(`## ${g}`, '');
  body.push('| 方法 | 路径 | 说明 | 位置 |');
  body.push('| --- | --- | --- | --- |');
  for (const r of list) {
    const desc = (r.comment || '').replace(/\|/g, '\\|').slice(0, 60) || '—';
    body.push(`| ${r.method} | \`${r.path}\` | ${desc} | ${r.file}:${r.line} |`);
  }
  body.push('');
}
const content = body.join('\n');

if (CHECK) {
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (prev.trim() !== content.trim()) {
    console.error('docs/ROUTES.md 已过期：跑 node scripts/gen-routes-doc.mjs 更新');
    process.exit(1);
  }
  console.log('docs/ROUTES.md 是最新的');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, content, 'utf8');
console.log(`已生成 ${path.relative(root, OUT)}：${all.length} 个路由，${sorted.length} 个域`);
