// 记忆银河本地预览：用 tools/memory-galaxy 的前端 + scripts/export-galaxy.mjs 导出的数据。
//
//   node scripts/galaxy-preview.mjs            # 导出并起服务（默认 4199）
//   node scripts/galaxy-preview.mjs 4300       # 指定端口
//
// 只读：页面能看、能筛、能点星看原文，但不会改记忆库。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportGalaxy } from './lib/galaxy-export.mjs';
import { GALAXY_CSP } from '../src/lib/galaxy-security.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const HERE = path.join(root, 'tools', 'memory-galaxy');
const HTML = path.join(HERE, 'index.html');
const DATA = process.env.GALAXY_OUT
  ? path.resolve(process.env.GALAXY_OUT)
  : path.join(root, 'state', 'galaxy', 'galaxy-data.json');
const PORT = Number(process.argv[2] || 4199);

// 先重新导出一次（保证数据是新的）
try {
  const result = exportGalaxy({
    memoryDir: path.join(root, 'state', 'memory'),
    outFile: DATA,
    labels: { core: '鱼鱼', coreSub: '她自己' },
  });
  console.log('[galaxy]', JSON.stringify(result));
} catch (error) {
  console.error('[galaxy] 导出失败：', error?.message ?? error);
  process.exit(1);
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'self'",
};


const ALLOWED_HOSTS = () => new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const isAllowedHost = (req) => ALLOWED_HOSTS().has(String(req.headers.host || '').toLowerCase());

http.createServer((req, res) => {
  if (!isAllowedHost(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('forbidden host');
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  if (p === '/memory-galaxy/' || p === '/memory-galaxy') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, 'content-security-policy': GALAXY_CSP });
    res.end(fs.readFileSync(HTML));
    return;
  }
  if (p === '/memory-galaxy/app.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
    res.end(fs.readFileSync(path.join(HERE, 'app.css')));
    return;
  }
  if (p === '/memory-galaxy/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
    res.end(fs.readFileSync(path.join(HERE, 'app.js')));
    return;
  }
  if (p === '/memory-galaxy/api/data' || p === '/memory-galaxy/api/galaxy') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
    res.end(fs.readFileSync(DATA));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[galaxy] 预览：http://127.0.0.1:${PORT}/memory-galaxy/`);
});
