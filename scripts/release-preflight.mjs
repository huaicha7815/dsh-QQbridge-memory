#!/usr/bin/env node
// 发布 preflight：在打 tag / push 之前把「代码侧确定性检查」全部跑一遍。
//
// 设计原则：
//   - 只读检查 + 跑测试，**绝不**自动 tag / push / 修改仓库；
//   - 任一项失败记录并最终 exit 1；脏工作树或非预期 HEAD 直接拒绝继续；
//   - 输出结构化 PASS/FAIL 摘要，可直接粘进发布记录。
//
// 两种运行模式（必须明确）：
//   source 模式（默认）：当前仓库是源仓库，用 --public-dir 指定公开仓库，比较导出；
//   --public-only     ：当前仓库就是发布候选（public clone），只检查当前仓库。
//
// 用法：
//   node scripts/release-preflight.mjs --public-dir ../qq-bridge-public [--expect <sha>]
//   node scripts/release-preflight.mjs --public-only --expect <sha>
//   node scripts/release-preflight.mjs [--skip-heavy] [--allow-missing-public]
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPublicExportFiles, expectedPublicContent, EXPORT_MARKER_FILES } from './lib/public-export.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);

function argValue(flag) {
  const i = args.indexOf(flag);
  if (i < 0) return '';
  const value = String(args[i + 1] ?? '');
  if (!value || value.startsWith('--')) {
    console.error(`FAIL  ${flag} 必须提供值`);
    process.exit(1);
  }
  return value;
}

const skipHeavy = args.includes('--skip-heavy');
const publicOnly = args.includes('--public-only');
const allowMissingPublic = args.includes('--allow-missing-public');
const expectedHeadArg = argValue('--expect');
const publicDirArg = argValue('--public-dir');

if (!publicOnly && !publicDirArg && !process.env.QQ_BRIDGE_PUBLIC_DIR) {
  console.error('FAIL  source 模式必须提供 --public-dir（或 QQ_BRIDGE_PUBLIC_DIR），或用 --public-only 检查当前仓库');
  process.exit(1);
}
const publicDir = publicOnly
  ? ROOT
  : path.resolve(publicDirArg || process.env.QQ_BRIDGE_PUBLIC_DIR || '');

// spawn 可用性探测：沙箱里 release-preflight 无意义，直接提示
try {
  execFileSync(process.execPath, ['-e', ''], { cwd: ROOT, stdio: 'ignore' });
} catch (error) {
  if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
    console.error('本环境禁止 spawn 子进程（沙箱），release-preflight 需要在正常终端/发布环境运行。');
    process.exit(2);
  }
}

const results = [];
function check(name, fn) {
  try {
    const out = fn();
    if (out && typeof out === 'object' && out.skip) {
      results.push({ name, skip: true, detail: out.detail ?? '' });
      console.log(`SKIP  ${name}${out.detail ? ' — ' + out.detail : ''}`);
      return;
    }
    const detail = typeof out === 'string' ? out : '';
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  } catch (error) {
    const tail = [error.stdout, error.stderr]
      .map((x) => (x == null ? '' : String(x).trim()))
      .filter(Boolean).join('\n').split('\n').slice(-12).join('\n');
    const detail = tail ? `${error.message}\n${tail}` : error.message;
    results.push({ name, ok: false, detail });
    console.error(`FAIL  ${name} — ${detail}`);
  }
}

function git(cwd, ...argsList) {
  return execFileSync('git', argsList, { cwd, encoding: 'utf8' }).trim();
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}





console.log('== 发布 preflight ==');
console.log('root:', ROOT);
console.log('mode:', (skipHeavy ? 'skip-heavy' : 'full') + ' / ' + (publicOnly ? 'public-only' : 'source'));
if (!publicOnly) console.log('public dir:', publicDir);

const head = git(ROOT, 'rev-parse', 'HEAD');

// 1) HEAD 与预期一致（短 SHA 可解析）
check('HEAD 与预期一致', () => {
  if (!expectedHeadArg) return `${head}（未指定 --expect）`;
  const resolved = git(ROOT, 'rev-parse', '--verify', expectedHeadArg + '^{commit}');
  assert(head === resolved, `HEAD=${head}，期望 ${resolved}（传入 ${expectedHeadArg}）`);
  return `${head}（--expect ${expectedHeadArg}）`;
});

// 2) 工作树干净
check('当前仓库工作树干净', () => {
  const dirty = git(ROOT, 'status', '--porcelain');
  assert(dirty === '', `有未提交改动：\n${dirty}`);
  return 'clean';
});

// 3) 公开仓库（source 模式）：独立目录 + 干净 + public HEAD
check('公开仓库独立且干净', () => {
  if (publicOnly) return { skip: true, detail: `public-only（当前仓库即候选，HEAD ${head}）` };
  const missing = !fs.existsSync(path.join(publicDir, '.git'));
  if (missing) {
    if (!allowMissingPublic) throw new Error(`未找到公开仓库：${publicDir}（--public-dir 指定，或显式 --allow-missing-public）`);
    return { skip: true, detail: '--allow-missing-public' };
  }
  assert(fs.realpathSync(ROOT) !== fs.realpathSync(publicDir), `公开仓库与当前仓库是同一个目录：${publicDir}`);
  const dirty = git(publicDir, 'status', '--porcelain');
  assert(dirty === '', `公开仓库有未提交改动：\n${dirty}`);
  return `clean，public HEAD ${git(publicDir, 'rev-parse', 'HEAD')}`;
});

// 4) 未推送（提示性，不阻断）
check('未推送提交数', () => {
  const count = git(ROOT, 'rev-list', '--count', 'origin/main..HEAD');
  return `${count} 个（发布会话负责推送）`;
});

// 5) 真实记忆导出被忽略
check('galaxy 导出物被忽略', () => {
  const out = execFileSync('git', ['check-ignore', '-v', 'state/galaxy/galaxy-data.json'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert(out.includes('state/'), `未被忽略：${out}`);
  return out.split('\n')[0];
});

// 6) 批处理行尾
check('.bat/.cmd 均为 CRLF', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'state'].includes(entry.name)) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (/\.(bat|cmd)$/i.test(entry.name)) files.push(p);
    }
  };
  walk(ROOT);
  assert(files.length >= 3, `批处理文件过少：${files.length}`);
  for (const f of files) {
    const text = fs.readFileSync(f).toString('latin1');
    assert(!/(?<!\r)\n/.test(text), `${path.relative(ROOT, f)} 含裸 LF（.bat/.cmd 必须 CRLF）`);
  }
  return `${files.length} 个文件`;
});

// 7) 不跟踪 state/令牌/真实配置
check('无 state/令牌/真实记忆被跟踪', () => {
  const tracked = git(ROOT, 'ls-files', 'state');
  assert(tracked === '', `被跟踪的 state 文件：${tracked.split('\n').slice(0, 5).join(', ')}`);
  for (const forbidden of ['config.json', 'state/console-token', 'state/sessions.json']) {
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', forbidden], { cwd: ROOT, stdio: 'ignore' });
      throw new Error(`不应被跟踪：${forbidden}`);
    } catch (error) {
      if (error.message.startsWith('不应被跟踪')) throw error;
    }
  }
  return 'ok';
});

// 8) package-lock.json 存在且可解析（npm ci 前提）
check('package-lock.json 可解析', () => {
  const lock = path.join(ROOT, 'package-lock.json');
  assert(fs.existsSync(lock), '缺少 package-lock.json（npm ci 会失败）');
  const data = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert(data && data.lockfileVersion, 'package-lock.json 结构无效');
  return `lockfileVersion ${data.lockfileVersion}，${fs.statSync(lock).size} bytes`;
});

// 9) HEAD 提交本身无空白错误（git show --check，而不是 diff --check）
check('HEAD 提交无空白错误', () => {
  const out = execFileSync('git', ['show', '--check', '--format=', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  assert(String(out).trim() === '', `HEAD 提交有空白错误：\n${String(out).slice(0, 500)}`);
  return 'ok';
});

// 10) privacy-scan
check('privacy-scan', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'privacy-scan.mjs')], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  return '未发现敏感信息';
});

// 11) ROUTES 最新
check('ROUTES.md 最新', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-routes-doc.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  return 'docs/ROUTES.md 是最新的';
});

// 12) 路由位置审计
check('路由位置审计', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'audit-route-positions.mjs')], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  return '无关卡前路由';
});

// 13) 导出 manifest 双向一致 + 内容哈希（source 模式）
check('export manifest 双向一致且内容相同', () => {
  if (publicOnly) return { skip: true, detail: '需要 source 模式验证' };
  const missing = !fs.existsSync(path.join(publicDir, '.git'));
  if (missing) {
    if (!allowMissingPublic) throw new Error('未找到公开仓库，无法比对 manifest');
    return { skip: true, detail: '--allow-missing-public' };
  }
  const expected = listPublicExportFiles(ROOT);
  const publicFiles = git(publicDir, '-c', 'core.quotepath=false', 'ls-files', '-z').split('\0').filter(Boolean).sort();
  const publicSet = new Set(publicFiles);
  const missingInPublic = expected.filter((f) => !publicSet.has(f));
  assert(missingInPublic.length === 0, `source 有但 public 缺失：${missingInPublic.slice(0, 10).join(', ')}`);
  const expectedSet = new Set(expected);
  const extra = publicFiles.filter((f) => !expectedSet.has(f) && !EXPORT_MARKER_FILES.includes(f));
  assert(extra.length === 0, `public 多出 source 未导出文件：${extra.slice(0, 10).join(', ')}`);
  const mismatched = [];
  for (const file of expected) {
    const a = path.join(ROOT, file);
    const b = path.join(publicDir, file);
    if (!fs.existsSync(b)) { mismatched.push(`${file}(missing)`); continue; }
    // .gitignore 导出时用脱敏版，期望内容以共享规则为准（不是 source 原文）。
    const expectedBuf = expectedPublicContent(ROOT, file);
    const actualBuf = fs.readFileSync(b);
    const expectedHash = crypto.createHash('sha256').update(expectedBuf).digest('hex');
    const actualHash = crypto.createHash('sha256').update(actualBuf).digest('hex');
    if (expectedHash !== actualHash) mismatched.push(file);
  }
  assert(mismatched.length === 0, `内容不一致：${mismatched.slice(0, 10).join(', ')}`);
  return `${expected.length} 个文件，内容全部一致`;
});

// 14) daily / audit（发布环境；沙箱用 --skip-heavy）
if (!skipHeavy) {
  check('full daily', () => {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'test-daily.mjs')], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 30 * 60 * 1000 });
    return 'test-daily 通过';
  });
  check('audit', () => {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'test-audit.mjs')], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 30 * 60 * 1000 });
    return 'test-audit 通过';
  });
} else {
  results.push({ name: 'full daily', skip: true, detail: '--skip-heavy' });
  console.log('SKIP  full daily（--skip-heavy）');
  results.push({ name: 'audit', skip: true, detail: '--skip-heavy' });
  console.log('SKIP  audit（--skip-heavy）');
}

// 摘要
const failed = results.filter((r) => !r.ok && !r.skip);
const skipped = results.filter((r) => r.skip);
console.log('\n== 摘要 ==');
console.log(`PASS ${results.length - failed.length - skipped.length}/${results.length}` + (skipped.length ? `  SKIP ${skipped.length}` : ''));
if (skipped.length) for (const r of skipped) console.log(`SKIP ${r.name}（${r.detail}）`);
if (failed.length) {
  for (const f of failed) console.error(`FAIL ${f.name}: ${f.detail}`);
  console.error('\npreflight 未通过：不要 tag / push，先修失败项。');
  process.exit(1);
}
console.log('preflight 通过（SKIP 项需人工确认原因）。下一步：发布环境执行 docs/guides/RELEASE-SMOKE.md。');
console.log('提醒：本脚本不会自动 tag / push。');
