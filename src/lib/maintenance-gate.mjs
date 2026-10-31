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
//      callback 只返回结果/退出码，且必须是同步的（async 会在 gate 释放后才完成写入）。
//   2. 本库**不接管宿主进程生命周期**：只在 `process.on('exit')` 做同步兜底释放。
//      SIGINT/SIGTERM/uncaughtException 由 bridge / CLI 宿主自己处理，并调用
//      `releaseHeldMaintenanceGates()` —— 否则库里的 process.exit 会截断宿主的清理逻辑。
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
  // nonce 是所有权的一部分：release 和 bridge 启动前的 owner 校验都要比较它。
  if (gate.nonce !== undefined && (typeof gate.nonce !== 'string' || !SAFE_TOKEN.test(gate.nonce))) {
    return { state: 'unsafe', reason: 'gate 的 nonce 非法' };
  }
  if (gate.version !== undefined && gate.version !== 1) {
    return { state: 'unsafe', reason: `未知的 gate version：${gate.version}` };
  }
  if (gate.kind !== undefined && typeof gate.kind !== 'string') {
    return { state: 'unsafe', reason: 'gate 的 kind 非法' };
  }
  if (gate.command !== undefined && typeof gate.command !== 'string') {
    return { state: 'unsafe', reason: 'gate 的 command 非法' };
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

/** 父目录必须已存在：维护命令不应因为路径写错就创建一套新 state 并拿到 gate。 */
function requireParentDir(lockPath) {
  const dir = path.dirname(lockPath);
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return `状态目录不是目录：${dir}`;
    return null;
  } catch (error) {
    if (error && error.code === 'ENOENT') return `状态目录不存在：${dir}（先确认 --dir / --bridge-lock 指向正确的库）`;
    return `无法检查状态目录：${error?.code || error}`;
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
    if (error && error.code === 'EEXIST') return { ok: false, retry: true };
    return { ok: false, unsafe: true, reason: `创建新 gate 失败：${error?.code || error}` };
  }
}

/**
 * 获取 gate。返回：
 *   {ok:true, gate}           成功
 *   {ok:false, busy:true}     活动 owner（bridge 或另一个维护命令）
 *   {ok:false, unsafe:true}   坏内容/读不到/EPERM/父目录不存在（需要人工处理）
 */
export function acquireMaintenanceGate(lockPath, { command = '', kind = 'maintenance', retries = 2 } = {}) {
  if (!lockPath) return { ok: false, unsafe: true, reason: '无法确定 maintenance lock 路径' };
  const dirProblem = requireParentDir(lockPath);
  if (dirProblem) return { ok: false, unsafe: true, reason: dirProblem };
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

/**
 * 释放 gate。返回结构化结果：
 *   { released: true }
 *   { lostOwnership: true }            文件已不是自己的（被别人接管/删除）
 *   { retryable: true, error }         读不了/删不掉（EACCES/EIO）：保留 held token 供 exit hook 重试
 */
export function releaseMaintenanceGate(lockPath, gate) {
  const held = gate || (lockPath ? heldGates.get(lockPath) : null);
  if (!lockPath || !held) return { missing: true };
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      heldGates.delete(lockPath);
      return { missing: true };
    }
    // 读不了：文件可能还是自己的，保留 token 让 exit hook 再试一次。
    return { retryable: true, error: String(error?.code || error) };
  }
  let current = null;
  try { current = JSON.parse(raw); } catch { current = null; }
  // owner 和 nonce 都是所有权的一部分：只比 owner 会允许旧 token 删掉同 owner 的新 gate。
  if (!current || current.owner !== held.owner || current.nonce !== held.nonce) {
    heldGates.delete(lockPath);
    return { replaced: true };
  }
  try {
    fs.unlinkSync(lockPath);
    heldGates.delete(lockPath);
    return { released: true };
  } catch (error) {
    return { retryable: true, error: String(error?.code || error) };
  }
}

/** 兜底：进程退出时同步释放尚未交出的所有 gate（唯一保留的进程级 hook）。 */
export function releaseHeldMaintenanceGates() {
  const results = [];
  for (const [lockPath, gate] of [...heldGates.entries()]) {
    results.push({ lockPath, ...releaseMaintenanceGate(lockPath, gate) });
  }
  return results;
}

// 最后防线：同步 exit hook。不注册信号处理器 —— 那是宿主的职责。
process.on('exit', () => { releaseHeldMaintenanceGates(); });

/**
 * 在 gate 内执行一段写操作。
 *
 * ⚠️ callback 必须**同步**返回结果/退出码，且不能 `process.exit()`：
 *   - async callback 会在 gate 已释放后才写盘（静默失去互斥）→ 这里直接抛 TypeError；
 *   - process.exit 会绕过 finally → 由调用方在最外层退出。
 *
 * @returns {{ok:true, result:any, release?:object} | {ok:false, busy?:boolean, unsafe?:boolean, reason?:string, holder?:object}}
 */
export function withMaintenanceGate(options, fn) {
  const lockPath = resolveMaintenanceLockPath(options);
  const acquired = acquireMaintenanceGate(lockPath, { command: options?.command });
  if (!acquired.ok) return acquired;
  let result;
  let thrown = null;
  try {
    result = fn({ lockPath, gate: acquired.gate });
    if (result && typeof result.then === 'function') {
      throw new TypeError('withMaintenanceGate callback 必须是同步的（async 会在 gate 释放后才写盘）');
    }
  } catch (error) {
    thrown = error;
  }
  const release = releaseMaintenanceGate(lockPath, acquired.gate);
  if (thrown) throw thrown;
  if (release.replaced) {
    return { ok: false, unsafe: true, reason: 'gate 在 callback 执行期间被别人接管/删除，本次结果不可信' };
  }
  return { ok: true, result, release };
}

/** 给 CLI 用的统一退出码：busy/unsafe → 2；callback 内部错误由调用方决定。 */
export function gateFailureCode(result) {
  return result && (result.busy || result.unsafe) ? 2 : 1;
}
