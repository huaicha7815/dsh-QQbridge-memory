#!/usr/bin/env node
/**
 * 每日自检：跑「不会破坏你这台机器」的那部分测试，并把结果存档。
 *
 * 为什么单独一个脚本：49 个测试里，有一部分会改真实配置（test-console 改白名单）、
 * 有的需要在线网关（snowluma-conn）、有的需要 playwright（console-ui）。
 * 直接全量定时跑，轻则一堆误报，重则把真实配置改坏。所以这里只挑安全的：
 *
 *   - test-memory-lib   纯函数单测，全在临时目录
 *   - test-memory-e2e   记忆库端到端（自带隔离的 harness）
 *   - memory-health     只读体检
 *   - memory-baseline   只读基线对比
 *
 * 用法：
 *   node scripts/test-daily.mjs            跑一遍并存日志
 *   node scripts/test-daily.mjs --quiet    只输出结论（给计划任务用）
 *
 * 输出：state/test-daily.log（追加，带时间戳）；退出码 0=全过，1=有失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const LOG_FILE = path.join(root, 'state', 'test-daily.log');
const QUIET = process.argv.includes('--quiet');
const now = new Date();
const stamp = now.toLocaleString('zh-CN');

const node = process.execPath;
const suite = [
  {
    name: '记忆库单测',
    args: ['--test', 'scripts/test-memory-lib.mjs'],
    expect: 0,
  },
  {
    name: 'socialV2 状态层',
    args: ['--test', 'scripts/test-socialv2-store.mjs'],
    expect: 0,
  },
  {
    name: 'socialV2 唤醒判定',
    args: ['--test', 'scripts/test-socialv2-wake.mjs'],
    expect: 0,
  },
  {
    name: 'socialV2 调度器（假时钟）',
    args: ['--test', 'scripts/test-socialv2-scheduler.mjs'],
    expect: 0,
  },
  {
    name: 'socialV2 睡眠判定',
    args: ['--test', 'scripts/test-socialv2-sleep.mjs'],
    expect: 0,
  },
  {
    name: 'socialV2 提示词组装',
    args: ['--test', 'scripts/test-socialv2-prompt.mjs'],
    expect: 0,
  },
  {
    name: '路由依赖注入',
    args: ['--test', 'scripts/test-routes-inject.mjs'],
    expect: 0,
  },
  {
    name: '路由调用点比对',
    args: ['--test', 'scripts/test-route-callsites.mjs'],
    expect: 0,
  },
  {
    name: '记忆写入恢复（replay）',
    args: ['--test', 'scripts/test-memory-replay.mjs'],
    expect: 0,
  },
  {
    name: '记忆身份归属',
    args: ['--test', 'scripts/test-memory-identity.mjs'],
    expect: 0,
  },
  {
    name: '记忆库端到端',
    args: ['--test', 'scripts/test-memory-e2e.mjs'],
    expect: 0,
  },
  {
    name: '健康检查（只读）',
    args: ['scripts/memory-health.mjs'],
    expect: 0,
  },
  {
    name: '基线对比（只读）',
    args: ['scripts/memory-baseline.mjs'],
    expect: 0,
  },
];

const lines = [];
const say = (s = '') => { lines.push(s); if (!QUIET) console.log(s); };
say(`════ 每日自检 ${stamp} ════`);
say('');

let failed = 0;
for (const item of suite) {
  const t0 = Date.now();
  const res = spawnSync(node, item.args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const ms = Date.now() - t0;
  const ok = res.status === item.expect;
  if (!ok) failed += 1;
  // 从输出里挑出有用的那几行（node:test 的汇总 / 健康检查的异常提示）
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const summary = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(ℹ (tests|pass|fail)|❌|⚠️|【)/.test(l) || /悬空|认领|基线变坏|档案自检/.test(l))
    .slice(0, 6);
  say(`${ok ? '✅' : '❌'} ${item.name}（${ms}ms）`);
  for (const s of summary) say(`    ${s}`);
  if (!ok) {
    const tail = out.split('\n').slice(-12).join('\n');
    say('    ── 失败输出尾部 ──');
    for (const l of tail.split('\n')) say(`    ${l}`);
  }
  say('');
}
say(failed ? `❌ ${failed} 项失败` : '🎉 全部通过');
say('');

// 追加到日志（保留最近 2000 行，别让它无限长）
try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, lines.join('\n') + '\n', 'utf8');
  const content = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
  if (content.length > 2000) {
    fs.writeFileSync(LOG_FILE, content.slice(-2000).join('\n'), 'utf8');
  }
} catch (e) {
  console.error(`写日志失败（不影响结果）：${e?.message ?? e}`);
}

if (QUIET) {
  console.log(failed ? `❌ 每日自检：${failed} 项失败（详见 state/test-daily.log）` : '✅ 每日自检全部通过');
}
process.exit(failed ? 1 : 0);
