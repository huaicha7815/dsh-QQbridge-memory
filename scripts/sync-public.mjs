#!/usr/bin/env node
// 每轮审查完成后的公开仓库同步：export → add → commit（**不 push**）。
//
// 为什么每轮都要做：攒十几轮合成一个 commit，线上出问题时没法单独回退某一轮；
// 而且 export 是一次性全量重写，中间任何一轮漏同步，公开目录和源码就会静默分叉。
//
// 用法：
//   node scripts/sync-public.mjs --round 34 --msg "记忆库：S3 索引三态"
//   node scripts/sync-public.mjs --msg "chore: 只改了文档"
//   node scripts/sync-public.mjs --check          # 只看状态，不写任何东西
//   node scripts/sync-public.mjs --round 34 --msg "…" --push   # 推送（需 Clash 7897 在监听）
//
// 约定：
//   - 公开目录是**生成物**，只由 scripts/export-public.mjs 写入，不要手改；
//   - 默认不 push：发布会话统一推送，避免每轮都触发一次远端写入；
//   - commit 每轮一次，历史可单独回退。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const outDir = path.resolve(value('--out') || path.join(root, '..', 'qq-bridge-public'));
const round = value('--round');
const msg = value('--msg');
const check = args.includes('--check');
const push = args.includes('--push');

// 安全闸：在导出目录里跑会把 outDir 指向自身，export 会把工作副本清空重写。
if (path.basename(root) === 'qq-bridge-public' || root === outDir || root.startsWith(outDir + path.sep)) {
  console.error('❌ 这个脚本必须在源目录（qq-bridge）里运行，不能在导出目录/它的子目录里跑。');
  process.exit(2);
}
if (!check && !msg) {
  console.error('用法：node scripts/sync-public.mjs --round <N> --msg "<一句话>"');
  console.error('      node scripts/sync-public.mjs --check');
  process.exit(2);
}

function git(argv, { allowFail = false } = {}) {
  const r = spawnSync('git', ['-C', outDir, ...argv], { encoding: 'utf8', timeout: 120000 });
  if (!allowFail && r.status !== 0) {
    console.error(`❌ git ${argv.join(' ')} 失败：${(r.stderr || r.stdout || '').trim()}`);
    process.exit(1);
  }
  return r;
}

function probeProxy(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 7897 });
    const done = (ok) => { try { socket.destroy(); } catch {} resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

if (check) {
  const status = git(['status', '--short'], { allowFail: true });
  const ahead = git(['rev-list', '--count', 'origin/main..HEAD'], { allowFail: true });
  const head = git(['log', '--oneline', '-1'], { allowFail: true });
  console.log(`公开目录：${outDir}`);
  console.log(`HEAD：${(head.stdout || '').trim() || '(无提交)'}`);
  console.log(`未推送提交：${(ahead.stdout || '').trim() || '?'}`);
  console.log(`未提交改动：${(status.stdout || '').trim() ? '\n' + status.stdout.trimEnd() : '无（干净）'}`);
  const needExport = (status.stdout || '').trim().length > 0;
  console.log(needExport ? '\n→ 有改动，跑一次 sync 就会生成新 commit。' : '\n→ 已同步。');
  process.exit(0);
}

// 1) 全量导出（内部含隐私扫描，失败会退出 1）
console.log('① 导出源码 →', outDir);
const exported = spawnSync(process.execPath, [path.join(root, 'scripts', 'export-public.mjs')], {
  cwd: root,
  stdio: 'inherit',
  timeout: 300000,
});
if (exported.status !== 0) {
  console.error('\n❌ 导出失败，未提交。上面的错误先处理掉。');
  process.exit(exported.status || 1);
}

// 2) 有变更才提交
const status = git(['status', '--short']).stdout.trim();
if (!status) {
  console.log('\n② 公开目录已是最新，没有可提交的改动。');
  process.exit(0);
}
const changed = status.split('\n').length;
console.log(`\n② 暂存 ${changed} 个改动并提交`);
git(['add', '-A']);
const title = round ? `round ${round}: ${msg}` : `chore: ${msg}`;
const commit = git(['commit', '-m', title], { allowFail: true });
if (commit.status !== 0) {
  console.error(`❌ 提交失败：${(commit.stderr || commit.stdout || '').trim()}`);
  process.exit(1);
}
const head = git(['log', '--oneline', '-1']).stdout.trim();
const ahead = git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim();
console.log(`   ${head}`);
console.log(`   未推送提交：${ahead}`);

// 3) 默认不推；要推就先确认代理真的在监听（否则 git 会挂 21 秒再超时）
if (push) {
  const ok = await probeProxy();
  if (!ok) {
    console.error('\n❌ 127.0.0.1:7897 没有在监听（Clash 没开？）。已提交但**没有推送**。');
    console.error('   开好代理后单独执行：git -C "' + outDir + '" push origin main');
    process.exit(1);
  }
  console.log('\n③ 推送 origin main…');
  const pushed = spawnSync('git', ['-C', outDir, 'push', 'origin', 'main'], { stdio: 'inherit', timeout: 180000 });
  if (pushed.status !== 0) {
    console.error('\n❌ 推送失败。提交已在本地，代理恢复后单独 push 即可。');
    process.exit(1);
  }
  console.log('✅ 已推送');
} else {
  console.log('\n③ 未推送（按约定由发布会话统一 push）。');
}
