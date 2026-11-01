const fs = require('fs');
(async () => {
  let sha = '';
  try {
    const res = await fetch('https://api.github.com/repos/leesingx/dsh-Memory-Galaxy/git/refs/heads/main', { headers: { 'User-Agent': 'dsh-check' } });
    const j = await res.json();
    sha = j?.object?.sha || '';
    console.log('upstream sha', sha);
  } catch (e) { console.log('sha fetch failed', e.message); }

  // 1) 预览服务安全头
  let p = fs.readFileSync('C:/dsh work/qq-bridge/scripts/galaxy-preview.mjs', 'utf8');
  if (!p.includes("'referrer-policy'")) {
    p = p.replace("http.createServer((req, res) => {", `const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
};

http.createServer((req, res) => {`);
    p = p.replace("res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });",
      "res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });");
    p = p.replace("res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });",
      "res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });");
    fs.writeFileSync('C:/dsh work/qq-bridge/scripts/galaxy-preview.mjs', p, 'utf8');
    console.log('preview security headers added');
  }

  // 2) README：GALAXY_OUT 风险提示
  let r = fs.readFileSync('C:/dsh work/qq-bridge/README.md', 'utf8');
  if (!r.includes('GALAXY_OUT 可以指向别的路径')) {
    r = r.replace('- `galaxy-data.json` 含真实记忆内容，已从 `export-public.mjs` 排除，不会进公开仓库',
      '- `galaxy-data.json` 含真实记忆内容，已从 `export-public.mjs` 排除，不会进公开仓库（默认写在 `state/galaxy/`，`state/` 已被 ACL 加固）\n- 用 `GALAXY_OUT` 覆盖输出路径时，由使用者自行保证目标目录权限（不要在共享/同步目录里放真实记忆导出物）');
    fs.writeFileSync('C:/dsh work/qq-bridge/README.md', r, 'utf8');
    console.log('README risk note added');
  }

  // 3) UPSTREAM：补上游 commit SHA
  if (sha) {
    let u = fs.readFileSync('C:/dsh work/qq-bridge/tools/memory-galaxy/UPSTREAM.md', 'utf8');
    if (u.includes('当时无 tag；导入时提交可在上游')) {
      u = u.replace('`main` 分支（当时无 tag；导入时提交可在上游 `git log` 中按日期定位）', `\`main\` 分支，导入时提交 \`${sha}\``);
      fs.writeFileSync('C:/dsh work/qq-bridge/tools/memory-galaxy/UPSTREAM.md', u, 'utf8');
      console.log('UPSTREAM sha pinned');
    }
  }
})();
