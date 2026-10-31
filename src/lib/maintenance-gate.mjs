// 维护 gate：让所有写记忆的命令只能通过一个不可绕过的入口。
//
// 背景：`bridge.lock` 只是「bridge 是否在跑」的瞬间探活，先检查后写入之间有竞态；
// 而且每个维护命令各写一份检查，漏接一次就是一个洞（`--ack-manifest-errors` 已经
// 证明过一次）。这里用 `state/maintenance.lock` 做互斥门：
//
//   bridge 启动：拿 gate → 写/校验 bridge.lock → 确认 owner → 释放 gate → 运行
//   维护命令：  拿 gate → 读 bridge.lock 四态 → missing/stopped 才执行 → finally 释放
//
// 关键约定：
//   1. callback 里**不能**调用 process.exit（会绕过 finally 释放 gate）；
//      callback 只返回结果/退出码，退出由最外层做。
//   2. 进程被 SIGINT/SIGTERM/uncaughtException 打断时，由 exit hook 兜底释放。
//   3. stale gate 不直接删除，归档成 `maintenance.lock.stale-<acquiredAt>-<nonce>`
//      （审计线索保留）；字段非法时一律 unsafe，不自动接管。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 当前进程持有的 gate：lockPath → gate。 */
const heldGates = new Map();

const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/** 解析 gate 路径：显式 > bridge.lock 父目录 > stateDir。 */
export function resolveMaintenanceLockPath({ stateDir, bridgeLockFile, maintenanceLockFile } = {}) {
  if (maintenanceLockFile) return path.resolve(maintenanceLockFile);
  if (bridgeLockFile) return path.join(path.dirname(path.resolve(bridgeLockFile)), 'maintenance.lock');
  if (stateDir) return path.join(path.resolve(stateDir), 'maintenance.lock');
  return null;
}

/** 读 gate 文件：{state:'missing'|'held'|'stale'|'unsafe', gate?, reason?} */
export function inspectMaintenanceGate(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unsafe', reason: `读取 gate 失败：${error?.code || error}` };
  }
  let gate = null;
  try {
    gate = JSON.parse(raw);
  } catch {
    return { state: 'unsafe', reason: 'gate 内容不是合法 JSON（半写/损坏）' };
  }
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    return { state: 'unsafe', reason: 'gate 内容不是对象' };
  }
  if (!Number.isInteger(gate.pid) || gate.pid <= 0) {
    return { state: 'unsafe', reason: 'gate 的 pid 不是正整数' };
  }
  if (typeof gate.owner !== 'string' || !SAFE_TOKEN.test(gate.owner)) {
    return { state: 'unsafe', reason: 'gate 的 owner 非法' };
  }
  const acquiredAt = Number(gate.acquiredAt);
  if (!Number.isFinite(acquiredAt) || acquiredAt <= 0) {
    return { state: 'unsafe', reason: 'gate 的 acquiredAt 非法' };
  }
  try {
    process.kill(gate.pid, 0);
    return { state: 'held', gate };
  } catch (error) {
    if (error && error.code === 'ESRCH') return { state: 'stale', gate };
    // EPERM 等：进程可能还在，只是没权限探测 —— 不能当 stale 接管。
    return { state: 'unsafe', reason: `无法确认 gate 持有者 ${gate.pid} 状态：${error?.code || error}` };
  }
}

function newGate({ command, kind = 'maintenance' }) {
  return {
    version: 1,
    owner: `${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
    pid: process.pid,
    kind,
    command: String(command || ''),
    acquiredAt: Date.now(),
    nonce: crypto.randomUUID(),
  };
}

function writeGateExclusive(lockPath, gate) {
  const fd = fs.openSync(lockPath, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify(gate), 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** 接管 stale gate：合法字段 → 归档 → wx 创建新 gate。 */
function takeoverStaleGate(lockPath, staleGate, gate) {
  const acquiredAt = Number(staleGate.acquiredAt);
  const nonce = String(staleGate.nonce ?? '');
  if (!Number.isFinite(acquiredAt) || acquiredAt <= 0 || !SAFE_TOKEN.test(nonce)) {
    return { ok: false, unsafe: true, reason: 'stale gate 字段非法，拒绝自动接管' };
  }
  const stalePath = `${lockPath}.stale-${acquiredAt}-${nonce}`;
  try {
    fs.renameSync(lockPath, stalePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, retry: true };
    return { ok: false, unsafe: true, reason: `归档 stale gate 失败：${error?.code || error}` };
  }
  try {
    writeGateExclusive(lockPath, gate);
    return { ok: true, gate, tookOverFrom: stalePath };
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      // 另一个 contender 先创建了：刚才的 rename 归档是它的，不算我们持有。
      return { ok: false, retry: true };
    }
    return { ok: false, unsafe: true, reason: `创建新 gate 失败：${error?.code || error}` };
  }
}

/**
 * 获取 gate。返回：
 *   {ok:true, gate}           成功
 *   {ok:false, busy:true}     活动 owner（bridge 或另一个维护命令）
 *   {ok:false, unsafe:true}   坏内容/读不到/EPERM（需要人工处理）
 */
export function acquireMaintenanceGate(lockPath, { command = '', kind = 'maintenance', retries = 2 } = {}) {
  if (!lockPath) return { ok: false, unsafe: true, reason: '无法确定 maintenance lock 路径' };
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (error) {
    return { ok: false, unsafe: true, reason: `无法创建状态目录：${error?.code || error}` };
  }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const gate = newGate({ command, kind });
    try {
      writeGateExclusive(lockPath, gate);
      heldGates.set(lockPath, gate);
      return { ok: true, gate };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        return { ok: false, unsafe: true, reason: `创建 gate 失败：${error?.code || error}` };
      }
    }
    const current = inspectMaintenanceGate(lockPath);
    if (current.state === 'missing') continue;
    if (current.state === 'unsafe') return { ok: false, unsafe: true, reason: current.reason };
    if (current.state === 'held') return { ok: false, busy: true, holder: current.gate };
    const takenOver = takeoverStaleGate(lockPath, current.gate, newGate({ command, kind }));
    if (takenOver.ok) {
      heldGates.set(lockPath, takenOver.gate);
      return takenOver;
    }
    if (!takenOver.retry) return takenOver;
  }
  return { ok: false, busy: true, reason: 'gate 竞争激烈（多次重试后仍未获得）' };
}

/** 释放 gate：只删「当前文件 owner 就是自己」的 gate，绝不删别人的。 */
export function releaseMaintenanceGate(lockPath, gate) {
  const held = gate || (lockPath ? heldGates.get(lockPath) : null);
  if (!lockPath || !held) return false;
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    let current = null;
    try { current = JSON.parse(raw); } catch { current = null; }
    if (!current || current.owner !== held.owner) return false;
    fs.unlinkSync(lockPath);
    heldGates.delete(lockPath);
    return true;
  } catch {
    heldGates.delete(lockPath);
    return false;
  }
}

/** 兜底：进程退出/被信号打断时，释放尚未交出的所有 gate。 */
export function releaseHeldMaintenanceGates() {
  for (const [lockPath, gate] of [...heldGates.entries()]) releaseMaintenanceGate(lockPath, gate);
}

// 最后防线：同步 exit hook（不能异步）。
process.on('exit', () => { releaseHeldMaintenanceGates(); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    releaseHeldMaintenanceGates();
    process.exit(130);
  });
}
process.on('uncaughtException', (error) => {
  releaseHeldMaintenanceGates();
  console.error('[maintenance-gate] uncaughtException:', error?.message ?? error);
  process.exit(1);
});

/**
 * 在 gate 内执行一段写操作。
 *
 * ⚠️ callback 里不能 `process.exit()` —— 会绕过 finally，gate 永远不释放。
 * callback 只返回结果/退出码；需要退出时由调用方在 wrapper 返回后做。
 *
 * @returns {{ok:true, result:any} | {ok:false, busy?:boolean, unsafe?:boolean, reason?:string, holder?:object}}
 */
export function withMaintenanceGate(options, fn) {
  const lockPath = resolveMaintenanceLockPath(options);
  const acquired = acquireMaintenanceGate(lockPath, { command: options?.command });
  if (!acquired.ok) return acquired;
  let result;
  let thrown = null;
  try {
    result = fn({ lockPath, gate: acquired.gate });
  } catch (error) {
    thrown = error;
  } finally {
    releaseMaintenanceGate(lockPath, acquired.gate);
  }
  if (thrown) throw thrown;
  return { ok: true, result };
}

/** 给 CLI 用的统一退出码：busy/unsafe → 2；callback 内部错误由调用方决定。 */
export function gateFailureCode(result) {
  return result && (result.busy || result.unsafe) ? 2 : 1;
}
