// 维护门（maintenance gate）回归：互斥、stale 接管、路径作用域、命令表。
//
// 为什么单独一个文件：这些是进程并发/时序语义，不属于「层 × 故障 × 入口」矩阵；
// 混进矩阵会让每日回归变慢且失败原因难读。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireMaintenanceGate, releaseMaintenanceGate, inspectMaintenanceGate,
  resolveMaintenanceLockPath, withMaintenanceGate,
} from '../src/lib/maintenance-gate.mjs';

const GATE_URL = new URL('../src/lib/maintenance-gate.mjs', import.meta.url).href;
const HEALTH = fileURLToPath(new URL('./memory-health.mjs', import.meta.url));
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function deadPid() {
  return spawnSync(process.execPath, ['-e', '0'], { timeout: 10000 }).pid;
}

function writeGate(lockPath, gate) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(gate), 'utf8');
}

test('gate：获取 → 释放 → 文件消失，owner 校验生效', () => {
  const dir = tmpDir('gate-basic-');
  const lock = path.join(dir, 'maintenance.lock');
  const first = acquireMaintenanceGate(lock, { command: 'test' });
  assert.equal(first.ok, true);
  assert.equal(inspectMaintenanceGate(lock).state, 'held');

  // 第二个获取者拿不到（活动 owner）
  const second = acquireMaintenanceGate(lock, { command: 'test2' });
  assert.equal(second.ok, false);
  assert.equal(second.busy, true);

  // 旧 owner 不能删新 owner 的 gate
  releaseMaintenanceGate(lock, first.gate);
  assert.equal(fs.existsSync(lock), false);

  const third = acquireMaintenanceGate(lock, { command: 'test3' });
  assert.equal(third.ok, true);
  const staleToken = first.gate; // 旧 token
  releaseMaintenanceGate(lock, staleToken);
  assert.equal(fs.existsSync(lock), true, '旧 owner 不能释放别人的 gate');
  releaseMaintenanceGate(lock, third.gate);
  assert.equal(fs.existsSync(lock), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate：坏 JSON / 非法字段一律 unsafe，不自动接管', () => {
  const dir = tmpDir('gate-bad-');
  const lock = path.join(dir, 'maintenance.lock');
  fs.writeFileSync(lock, 'not-a-gate', 'utf8');
  let r = acquireMaintenanceGate(lock, { command: 't' });
  assert.equal(r.ok, false);
  assert.equal(r.unsafe, true);
  assert.ok(String(r.reason).includes('JSON'));

  writeGate(lock, { version: 1, owner: 'x', pid: 0, acquiredAt: 1, nonce: 'n' });
  r = acquireMaintenanceGate(lock, { command: 't' });
  assert.equal(r.unsafe, true, 'pid 非正整数 → unsafe');

  writeGate(lock, { version: 1, owner: 'x', pid: 999999999, acquiredAt: 1, nonce: '../evil' });
  r = acquireMaintenanceGate(lock, { command: 't' });
  assert.equal(r.unsafe, true, '非法 nonce 不能拼进 stale 文件名');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate：stale 接管归档为 .stale-*，且只产生一个主 gate', () => {
  const dir = tmpDir('gate-stale-');
  const lock = path.join(dir, 'maintenance.lock');
  writeGate(lock, {
    version: 1, owner: 'dead-owner', pid: deadPid(), kind: 'maintenance',
    command: 'old', acquiredAt: 1234567890, nonce: 'oldnonce',
  });
  const r = acquireMaintenanceGate(lock, { command: 'new' });
  assert.equal(r.ok, true, 'stale（PID 已退出）应允许接管');
  assert.ok(String(r.tookOverFrom || '').includes('.stale-'), '旧的要归档保留');
  assert.equal(inspectMaintenanceGate(lock).state, 'held');
  releaseMaintenanceGate(lock, r.gate);
  const staleFiles = fs.readdirSync(dir).filter((n) => n.includes('.stale-'));
  assert.equal(staleFiles.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate：两个进程同时抢，只有一个进入临界区', async () => {
  const dir = tmpDir('gate-race-');
  const lock = path.join(dir, 'maintenance.lock');
  const script = `
    import { acquireMaintenanceGate, releaseMaintenanceGate } from ${JSON.stringify(GATE_URL)};
    const lock = ${JSON.stringify(lock)};
    const r = acquireMaintenanceGate(lock, { command: 'race' });
    if (!r.ok) { console.log('BUSY'); process.exit(0); }
    console.log('ACQUIRED');
    await new Promise((res) => setTimeout(res, 400));
    releaseMaintenanceGate(lock, r.gate);
  `;
  const runChild = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out));
  });
  const outs = await Promise.all([runChild(), runChild()]);
  const acquired = outs.filter((o) => o.includes('ACQUIRED')).length;
  // 两个同时起跑：可能一个拿到、另一个 BUSY；也可能第一个已释放后第二个拿到（串行）。
  // 关键不变量是「任意时刻最多一个持有」，这里用 BUSY 计数断言至少一个被拒。
  assert.ok(acquired >= 1, '至少有一个进程能拿到 gate');
  assert.ok(outs.filter((o) => o.includes('BUSY')).length >= 1, '另一个进程应被拒绝（同库不能并行）');
  assert.equal(fs.existsSync(lock), false, '跑完后 gate 应被释放');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate：宿主 SIGTERM 处理器调用 releaseHeldMaintenanceGates 后 gate 释放', async () => {
  const dir = tmpDir('gate-sigterm-');
  const lock = path.join(dir, 'maintenance.lock');
  // gate 库不接管宿主生命周期：信号处理由宿主负责（bridge / CLI）。
  // 这里模拟宿主：拿到 gate 后注册 SIGTERM handler，调用 releaseHeldMaintenanceGates 再退出。
  const script = `
    import { acquireMaintenanceGate, releaseHeldMaintenanceGates } from ${JSON.stringify(GATE_URL)};
    const r = acquireMaintenanceGate(${JSON.stringify(lock)}, { command: 'sigterm' });
    console.log(r.ok ? 'HELD' : 'FAIL');
    process.on('SIGTERM', () => { releaseHeldMaintenanceGates(); process.exit(0); });
    setTimeout(() => process.emit('SIGTERM'), 300);
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const closed = new Promise((resolve) => child.on('close', resolve));
  await closed;
  assert.ok(out.includes('HELD'), '子进程应先持有 gate：' + out);
  assert.equal(fs.existsSync(lock), false, '宿主 handler 释放后 gate 必须消失');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate：async callback 会被拒绝（不能静默失去互斥）', () => {
  const dir = tmpDir('gate-async-');
  const lock = path.join(dir, 'maintenance.lock');
  assert.throws(() => {
    withMaintenanceGate({ maintenanceLockFile: lock, command: 'async' }, async () => 'x');
  }, /必须是同步的/);
  assert.equal(fs.existsSync(lock), false, '抛错后 gate 必须已释放');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate：父目录不存在时 fail-closed，不自动创建 state', () => {
  const dir = tmpDir('gate-nodir-');
  const missing = path.join(dir, 'no-such-state');
  const r = acquireMaintenanceGate(path.join(missing, 'maintenance.lock'), { command: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.unsafe, true);
  assert.ok(String(r.reason).includes('状态目录不存在'));
  assert.equal(fs.existsSync(missing), false, '不能顺手创建目录');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate：callback 抛错也会释放 gate', () => {
  const dir = tmpDir('gate-throw-');
  const lock = path.join(dir, 'maintenance.lock');
  assert.throws(() => {
    withMaintenanceGate({ maintenanceLockFile: lock, command: 'throwing' }, () => {
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(fs.existsSync(lock), false, '异常路径必须释放 gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate 路径解析：bridge lock 父目录优先，其次 stateDir', () => {
  assert.equal(
    resolveMaintenanceLockPath({ bridgeLockFile: path.join('C:', 'p', 'state', 'bridge.lock') }),
    path.join('C:', 'p', 'state', 'maintenance.lock'),
  );
  assert.equal(
    resolveMaintenanceLockPath({ stateDir: path.join('C:', 'p', 'state') }),
    path.join('C:', 'p', 'state', 'maintenance.lock'),
  );
  assert.equal(
    resolveMaintenanceLockPath({ maintenanceLockFile: path.join('C:', 'x', 'custom.lock'), stateDir: 'C:/p/state' }),
    path.join('C:', 'x', 'custom.lock'),
  );
  assert.equal(resolveMaintenanceLockPath({}), null);
});

test('gate：不同 stateDir 可并行，同 stateDir 串行', () => {
  const dirA = tmpDir('gate-scope-a-');
  const dirB = tmpDir('gate-scope-b-');
  const a = acquireMaintenanceGate(path.join(dirA, 'maintenance.lock'), { command: 'a' });
  const b = acquireMaintenanceGate(path.join(dirB, 'maintenance.lock'), { command: 'b' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, '不同库的 gate 互不影响');
  const a2 = acquireMaintenanceGate(path.join(dirA, 'maintenance.lock'), { command: 'a2' });
  assert.equal(a2.ok, false, '同一个库不能并行');
  releaseMaintenanceGate(path.join(dirA, 'maintenance.lock'), a.gate);
  releaseMaintenanceGate(path.join(dirB, 'maintenance.lock'), b.gate);
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test('gate：写命令表在门被占用时 exit 2（零写盘）', () => {
  const base = tmpDir('gate-cmdtable-');
  const memDir = path.join(base, 'state', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'write-failures.jsonl'), '', 'utf8');
  // 活动 gate（PID = 当前测试进程，存活）
  writeGate(path.join(base, 'state', 'maintenance.lock'), {
    version: 1, owner: 'other-maintenance', pid: process.pid, kind: 'maintenance',
    command: 'blocker', acquiredAt: Date.now(), nonce: 'blockernonce',
  });
  // bridge 已停（合法 PID 但进程不存在）
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), String(deadPid()), 'utf8');

  const commands = [
    ['--replay', '--apply'],
    ['--migrate', '--apply'],
    ['--ack-manifest-errors'],
  ];
  for (const argv of commands) {
    const run = spawnSync(process.execPath, [HEALTH, '--dir', memDir, ...argv], { encoding: 'utf8', timeout: 60000 });
    const out = `${run.stdout || ''}${run.stderr || ''}`;
    assert.equal(run.status, 2, `${argv.join(' ')} 在门被占用时应 exit 2：${out.slice(0, 300)}`);
    assert.ok(out.includes('维护门被占用'), `${argv.join(' ')} 要报告门被占用：${out.slice(0, 300)}`);
  }
  // 零写盘：清单内容/诊断文件都没变
  assert.equal(fs.readFileSync(path.join(memDir, 'write-failures.jsonl'), 'utf8'), '');
  fs.rmSync(base, { recursive: true, force: true });
});

test('gate：同 owner 不同 nonce 的旧 token 不能删新 gate', () => {
  const dir = tmpDir('gate-nonce-');
  const lock = path.join(dir, 'maintenance.lock');
  const oldToken = { owner: 'same-owner', nonce: 'old' };
  writeGate(lock, { version: 1, owner: 'same-owner', nonce: 'new', pid: process.pid, acquiredAt: Date.now() });
  const result = releaseMaintenanceGate(lock, oldToken);
  assert.equal(result.replaced, true, 'nonce 不同必须视为已被替换：' + JSON.stringify(result));
  assert.equal(fs.existsSync(lock), true, '不能删别人的 gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate：inspect 会拒绝非法 nonce / 未知 version', () => {
  const dir = tmpDir('gate-inspect-');
  const lock = path.join(dir, 'maintenance.lock');
  writeGate(lock, { version: 1, owner: 'x', nonce: '../evil', pid: process.pid, acquiredAt: Date.now() });
  assert.equal(inspectMaintenanceGate(lock).state, 'unsafe');
  writeGate(lock, { version: 99, owner: 'x', nonce: 'ok', pid: process.pid, acquiredAt: Date.now() });
  assert.equal(inspectMaintenanceGate(lock).state, 'unsafe');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate：callback 内 requireBridgeIdle 抛错 → gate 释放、CLI exit 2', () => {
  const base = tmpDir('gate-blocked-');
  const memDir = path.join(base, 'state', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'write-failures.jsonl'), '', 'utf8');
  // bridge 正在运行（锁指向当前存活进程）
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), JSON.stringify({ version: 1, pid: process.pid, owner: 'bridge-x', startedAt: Date.now() }), 'utf8');

  const run = spawnSync(process.execPath, [HEALTH, '--dir', memDir, '--replay', '--apply'], { encoding: 'utf8', timeout: 60000 });
  const out = `${run.stdout || ''}${run.stderr || ''}`;
  assert.equal(run.status, 2, 'bridge 运行时必须 exit 2：' + out.slice(0, 300));
  assert.ok(out.includes('桥接正在运行'), '要说明 bridge 在跑：' + out.slice(0, 300));
  // gate 必须被释放（callback 抛错后 wrapper 释放）
  assert.equal(fs.existsSync(path.join(base, 'state', 'maintenance.lock')), false, 'gate 必须已释放');
  fs.rmSync(base, { recursive: true, force: true });
});

test('gate：--force-unlocked 只越过 unknown，不能越过 running', () => {
  const base = tmpDir('gate-force-');
  const memDir = path.join(base, 'state', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'write-failures.jsonl'), '', 'utf8');
  // 锁内容损坏 = unknown
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), 'garbage', 'utf8');

  const without = spawnSync(process.execPath, [HEALTH, '--dir', memDir, '--ack-manifest-errors'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(without.status, 2, 'unknown 不带 --force-unlocked 必须 exit 2');

  const withForce = spawnSync(process.execPath, [HEALTH, '--dir', memDir, '--ack-manifest-errors', '--force-unlocked'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(withForce.status, 0, 'unknown + --force-unlocked 应允许执行：' + `${withForce.stdout || ''}${withForce.stderr || ''}`.slice(0, 300));

  // running 即使 --force-unlocked 也必须拒绝
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), JSON.stringify({ version: 1, pid: process.pid, owner: 'b', startedAt: Date.now() }), 'utf8');
  const runningForced = spawnSync(process.execPath, [HEALTH, '--dir', memDir, '--ack-manifest-errors', '--force-unlocked'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(runningForced.status, 2, 'running 不能被 --force-unlocked 越过');
  fs.rmSync(base, { recursive: true, force: true });
});

test('gate：recover/repair 也已进入命令表（门被占用时 exit 2）', () => {
  const base = tmpDir('gate-cmdtable2-');
  const memDir = path.join(base, 'state', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  writeGate(path.join(base, 'state', 'maintenance.lock'), {
    version: 1, owner: 'other', pid: process.pid, kind: 'maintenance',
    command: 'blocker', acquiredAt: Date.now(), nonce: 'blocker2',
  });
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), String(deadPid()), 'utf8');
  for (const argv of [['--repair-summaries', '--apply'], ['--recover-archive', '--apply']]) {
    const run = spawnSync(process.execPath, [HEALTH, '--dir', memDir, ...argv], { encoding: 'utf8', timeout: 60000 });
    const out = `${run.stdout || ''}${run.stderr || ''}`;
    assert.equal(run.status, 2, `${argv.join(' ')} 应 exit 2：${out.slice(0, 300)}`);
    assert.ok(out.includes('维护门被占用'), `${argv.join(' ')} 要报告门被占用`);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('gate：四个独立脚本在门被占用时 exit 2（隔离库、零写盘）', () => {
  const base = tmpDir('gate-scripts-');
  const memDir = path.join(base, 'state', 'memory');
  fs.mkdirSync(path.join(memDir, 'events'), { recursive: true });
  fs.mkdirSync(path.join(base, 'state', 'diary'), { recursive: true });
  fs.writeFileSync(path.join(memDir, 'profile.json'), JSON.stringify({ people: {}, threads: [] }), 'utf8');
  fs.writeFileSync(path.join(memDir, 'events', '2026-01-05.jsonl'), JSON.stringify({ id: 'e1', t: Date.now(), k: 'group:1', kind: 'msg', text: 'x', s: 2 }) + '\n', 'utf8');
  writeGate(path.join(base, 'state', 'maintenance.lock'), {
    version: 1, owner: 'other', pid: process.pid, kind: 'maintenance',
    command: 'blocker', acquiredAt: Date.now(), nonce: 'blocker3',
  });
  fs.writeFileSync(path.join(base, 'state', 'bridge.lock'), String(deadPid()), 'utf8');
  const before = fs.readFileSync(path.join(memDir, 'events', '2026-01-05.jsonl'), 'utf8');

  const scripts = [
    ['repair-memory-profile.mjs', ['--dir', memDir, '--apply']],
    ['migrate-memory-v3.mjs', ['--dir', memDir, '--apply']],
    ['backfill-private-who.mjs', ['--dir', memDir, '--name', '测试', '--all', '--apply']],
    ['backfill-memory-salience.mjs', ['--dir', memDir, '--apply']],
  ];
  for (const [script, argv] of scripts) {
    const run = spawnSync(process.execPath, [path.join(SCRIPT_DIR, script), ...argv], { encoding: 'utf8', timeout: 120000 });
    const out = `${run.stdout || ''}${run.stderr || ''}`;
    assert.equal(run.status, 2, `${script} 在门被占用时应 exit 2：${out.slice(0, 300)}`);
    assert.ok(out.includes('维护门被占用'), `${script} 要报告门被占用：${out.slice(0, 300)}`);
  }
  assert.equal(fs.readFileSync(path.join(memDir, 'events', '2026-01-05.jsonl'), 'utf8'), before, '零写盘');
  fs.rmSync(base, { recursive: true, force: true });
});

test('gate：独立脚本默认预览、不拿门（隔离库）', () => {
  const base = tmpDir('gate-preview-');
  const memDir = path.join(base, 'state', 'memory');
  fs.mkdirSync(path.join(memDir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(memDir, 'profile.json'), JSON.stringify({ people: {}, threads: [] }), 'utf8');
  const before = fs.readFileSync(path.join(memDir, 'profile.json'), 'utf8');

  const run = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'migrate-memory-v3.mjs'), '--dir', memDir], { encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, '默认预览应 exit 0：' + `${run.stdout || ''}${run.stderr || ''}`.slice(0, 300));
  assert.ok(`${run.stdout || ''}`.includes('没有写入任何文件'), '要明确说明没有写盘');
  assert.equal(fs.readFileSync(path.join(memDir, 'profile.json'), 'utf8'), before, '预览不能改档案');
  assert.equal(fs.existsSync(path.join(base, 'state', 'maintenance.lock')), false, '预览不拿门');
  fs.rmSync(base, { recursive: true, force: true });
});

test('--dir 作用域：repair/migrate/who 只动目标库，默认库一字节不变', () => {
  const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
  const base = tmpDir('gate-scope-apply-');
  const stateDir = path.join(base, 'state');
  const memDir = path.join(stateDir, 'memory');
  fs.mkdirSync(path.join(memDir, 'events'), { recursive: true });
  // 目标项目 config（ownerQQ 与默认项目不同）
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ ownerQQ: '999' }), 'utf8');
  // 目标 state 的源数据：migrate 必须读这里，而不是默认项目
  fs.writeFileSync(path.join(stateDir, 'social-v2.json'), JSON.stringify({
    conversations: { 'private:999': { recentMessages: [{ time: Date.now(), isSelf: false, sender: '目标', text: 'TARGET_SOURCE_MESSAGE', messageId: 'm1' }] } },
  }), 'utf8');
  // 目标库 profile（可合并）
  fs.writeFileSync(path.join(memDir, 'profile.json'), JSON.stringify({
    people: { '爸爸（凉州词）': { facts: [{ t: 'f1', at: 1 }] }, '爸爸': { facts: [{ t: 'f2', at: 1 }] } },
    threads: [],
  }), 'utf8');
  // 目标库 who 事件
  fs.writeFileSync(path.join(memDir, 'events', '2026-01-05.jsonl'),
    JSON.stringify({ t: Date.now(), k: 'private:999', kind: 'msg', who: '私聊', uid: '999', text: 'who 测试', s: 1 }) + '\n', 'utf8');

  const defaultProfile = path.join(PROJECT_ROOT, 'state', 'memory', 'profile.json');
  const defaultBefore = fs.existsSync(defaultProfile) ? fs.readFileSync(defaultProfile, 'utf8') : null;

  // 1) repair：只改目标库
  let run = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'repair-memory-profile.mjs'), '--dir', memDir, '--apply'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, 'repair 应成功：' + (run.stdout || run.stderr || '').slice(0, 400));
  const profileAfter = JSON.parse(fs.readFileSync(path.join(memDir, 'profile.json'), 'utf8'));
  assert.equal(Object.keys(profileAfter.people).length, 1, '目标库应被合并成 1 人');
  const defaultAfterRepair = fs.existsSync(defaultProfile) ? fs.readFileSync(defaultProfile, 'utf8') : null;
  assert.equal(defaultAfterRepair, defaultBefore, '默认库 profile 不能被 --dir 目标的操作改掉');

  // 2) migrate：源数据来自目标 state
  run = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'migrate-memory-v3.mjs'), '--dir', memDir, '--apply'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, 'migrate 应成功：' + (run.stdout || run.stderr || '').slice(0, 400));
  const targetEvents = fs.readdirSync(path.join(memDir, 'events'))
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => fs.readFileSync(path.join(memDir, 'events', n), 'utf8')).join('\n');
  assert.ok(targetEvents.includes('TARGET_SOURCE_MESSAGE'), '目标库自己的 social-v2 源数据应被迁移进来');

  // 3) who：config 用目标项目（ownerQQ=999）
  run = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'backfill-private-who.mjs'), '--dir', memDir, '--name', '目标', '--apply'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, 'who 应成功：' + (run.stdout || run.stderr || '').slice(0, 400));
  const whoEvents = fs.readFileSync(path.join(memDir, 'events', '2026-01-05.jsonl'), 'utf8');
  assert.ok(whoEvents.includes('"who":"目标"'), '目标库事件应按目标 config 的 ownerQQ 回填');

  const defaultFinal = fs.existsSync(defaultProfile) ? fs.readFileSync(defaultProfile, 'utf8') : null;
  assert.equal(defaultFinal, defaultBefore, '三个脚本都不能改默认库');
  fs.rmSync(base, { recursive: true, force: true });
});

test('--dry-run --apply 组合必须零写盘（repair / who）', () => {
  const base = tmpDir('gate-dry-apply-');
  const memDir = path.join(base, 'state', 'memory');
  fs.mkdirSync(path.join(memDir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(memDir, 'profile.json'), JSON.stringify({
    people: { '爸爸（凉州词）': { facts: [{ t: 'f1', at: 1 }] }, '爸爸': { facts: [{ t: 'f2', at: 1 }] } },
    threads: [],
  }), 'utf8');
  fs.writeFileSync(path.join(memDir, 'events', '2026-01-05.jsonl'),
    JSON.stringify({ t: Date.now(), k: 'private:1', kind: 'msg', who: '私聊', uid: '1', text: 'x', s: 1 }) + '\n', 'utf8');
  const profileBefore = fs.readFileSync(path.join(memDir, 'profile.json'), 'utf8');
  const eventsBefore = fs.readFileSync(path.join(memDir, 'events', '2026-01-05.jsonl'), 'utf8');

  let run = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'repair-memory-profile.mjs'), '--dir', memDir, '--dry-run', '--apply'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0);
  assert.equal(fs.readFileSync(path.join(memDir, 'profile.json'), 'utf8'), profileBefore, '--dry-run 必须压过 --apply');

  run = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'backfill-private-who.mjs'), '--dir', memDir, '--name', 'X', '--all', '--dry-run', '--apply'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0);
  assert.equal(fs.readFileSync(path.join(memDir, 'events', '2026-01-05.jsonl'), 'utf8'), eventsBefore, 'who 的 --dry-run 必须压过 --apply');
  fs.rmSync(base, { recursive: true, force: true });
});

test('--dir 作用域：backfill-memory-salience 只动目标库', () => {
  const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
  const base = tmpDir('gate-scope-salience-');
  const memDir = path.join(base, 'state', 'memory');
  const today = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(memDir, 'events'), { recursive: true });
  // 目标库：当天的历史事件（没有 s 字段；用今天避免被归档逻辑搬走）
  fs.writeFileSync(path.join(memDir, 'events', `${today}.jsonl`),
    JSON.stringify({ t: Date.now(), k: 'group:1', kind: 'msg', who: '某人', text: '需要补档位的事件', mid: 'm1' }) + '\n', 'utf8');

  const defaultEventsDir = path.join(PROJECT_ROOT, 'state', 'memory', 'events');
  const defaultHash = (() => {
    try {
      return fs.readdirSync(defaultEventsDir).filter((n) => n.endsWith('.jsonl'))
        .map((n) => fs.readFileSync(path.join(defaultEventsDir, n), 'utf8')).join('\n');
    } catch { return null; }
  })();

  const run = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'backfill-memory-salience.mjs'), '--dir', memDir, '--apply'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, 'salience 应成功：' + (run.stdout || run.stderr || '').slice(0, 400));
  const targetFile = path.join(memDir, 'events', `${today}.jsonl`);
  assert.ok(fs.existsSync(targetFile), '目标库事件文件应还在');
  const targetEvents = fs.readFileSync(targetFile, 'utf8');
  assert.ok(targetEvents.includes('"s"'), '目标库事件应被补上档位');
  const defaultHashAfter = (() => {
    try {
      return fs.readdirSync(defaultEventsDir).filter((n) => n.endsWith('.jsonl'))
        .map((n) => fs.readFileSync(path.join(defaultEventsDir, n), 'utf8')).join('\n');
    } catch { return null; }
  })();
  assert.equal(defaultHashAfter, defaultHash, '默认库不能被 --dir 操作改动');
  fs.rmSync(base, { recursive: true, force: true });
});
