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
