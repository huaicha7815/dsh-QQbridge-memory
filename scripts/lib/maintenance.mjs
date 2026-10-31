// 维护命令的共享契约。
//
// 为什么有这个文件：`memory-health` 的 --replay / --migrate / --recover-archive /
// --repair-summaries 四个写入口，各自实现了一遍「默认 dry-run、--apply 才写、
// 检查目标库的 bridge.lock」。结果每加一个入口就漏一处（--dir 检查错库、
// 锁损坏被当成没在跑……）。这里把契约收敛成一份，入口只负责调用：
//
//   1) 作用域：目标库 = <project>/state/memory，锁 = <project>/state/bridge.lock；
//      --dir 改变作用域时，锁也跟着变；推断不出来就 fail-closed。
//   2) 锁状态四态：missing / stopped 才允许写；running / unknown 一律拒绝，
//      unknown 只有在 --force-unlocked（明确知道桥接已停）时才越过。
//   3) 命令行语义：默认只读；--apply 才写；--force-unlocked 显式越过未知锁。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 目标记忆库对应的 bridge.lock 路径。
 * 约定项目结构：<project>/state/memory（库）+ <project>/state/bridge.lock（锁）。
 * 推断不出来返回 null —— 调用方必须要求 --bridge-lock 或 fail-closed，
 * 绝不回退到「脚本所在项目」的锁（那会保护错的对象）。
 */
export function resolveBridgeLockForMemoryDir(dir, explicit) {
  if (explicit) return path.resolve(explicit);
  const stateDir = path.dirname(dir);
  if (path.basename(stateDir) !== 'state') return null;
  return path.join(stateDir, 'bridge.lock');
}

/**
 * 读桥接锁的状态。**只有 missing / stopped 才能当作「没在跑」。**
 *
 *   missing  自动推断的锁文件不存在（全新/已清理）
 *   stopped  锁里有合法 PID，但进程已不存在（ESRCH）
 *   running  PID 存活
 *   unknown  读不到（EACCES/EIO）、内容损坏/空、PID 非法、
 *            显式指定的路径不存在、EPERM（进程可能在但没权限探测）
 *
 * @returns {{state:'missing'|'stopped'|'running'|'unknown', pid?:number, reason?:string}}
 */
export function bridgeLockState(lockFile, { explicit = false } = {}) {
  if (!lockFile) return { state: 'unknown', reason: '无法从 --dir 推断锁路径' };
  let raw;
  try {
    raw = fs.readFileSync(lockFile, 'utf8').trim();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return explicit
        ? { state: 'unknown', reason: `显式指定的锁文件不存在：${lockFile}` }
        : { state: 'missing' };
    }
    return { state: 'unknown', reason: `读取锁失败：${error?.code || error}` };
  }
  if (!raw) return { state: 'unknown', reason: '锁文件是空的（半写/损坏）' };
  let pid = Number.NaN;
  try {
    const parsed = JSON.parse(raw);
    pid = Number(parsed && typeof parsed === 'object' ? parsed.pid : parsed);
  } catch {
    pid = Number(raw);
  }
  if (!Number.isFinite(pid) || !Number.isInteger(pid) || pid <= 0) {
    return { state: 'unknown', reason: `锁内容解析不出合法 PID：${raw.slice(0, 40)}` };
  }
  try {
    process.kill(pid, 0);
    return { state: 'running', pid };
  } catch (error) {
    if (error && error.code === 'ESRCH') return { state: 'stopped', pid };
    // EPERM 等：进程可能还在，只是没权限探测 —— 属于未知，不能当没跑。
    return { state: 'unknown', reason: `无法确认进程 ${pid} 状态：${error?.code || error}` };
  }
}

/**
 * apply 前的并发检查：running / unknown 一律拒绝（unknown 需 --force-unlocked）。
 * 失败直接 process.exit(2)，调用方无需再判断。
 * @returns {ReturnType<typeof bridgeLockState>} 通过时的锁状态
 */
export class MaintenanceBlockedError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'MaintenanceBlockedError';
    this.exitCode = exitCode;
  }
}

/**
 * apply 前的并发检查：running / unknown 一律拒绝（unknown 需 --force-unlocked）。
 *
 * 默认行为保持旧契约：阻塞时直接 process.exit(2)。
 * 但在 withMaintenanceGate 的 callback 内必须传 `throwOnBlock: true` ——
 * process.exit 会绕过 wrapper 的 finally，gate 只能靠 exit hook 兜底；
 * 抛 MaintenanceBlockedError 才能让 wrapper 先释放 gate、再由外层决定退出码。
 *
 * @returns {ReturnType<typeof bridgeLockState>} 通过时的锁状态
 */
export function requireBridgeIdle(lockFile, { explicit = false, forceUnlocked = false, throwOnBlock = false } = {}) {
  const lock = bridgeLockState(lockFile, { explicit });
  const block = (message) => {
    if (throwOnBlock) throw new MaintenanceBlockedError(message, 2);
    process.exit(2);
  };
  if (lock.state === 'running') {
    console.error(`❌ 桥接正在运行（PID ${lock.pid}）：先停桥接再 --apply。`);
    console.error('   （bridge 和 consolidation 会写同一批记忆文件，没有共享锁。）');
    block(`桥接正在运行（PID ${lock.pid}）`);
  }
  if (lock.state === 'unknown') {
    if (!forceUnlocked) {
      console.error(`❌ 锁状态未知（${lock.reason || '读不到/内容损坏'}）：不能假定桥接没在跑。`);
      console.error('   修好锁文件，或确认桥接已停后加 --force-unlocked 明确越过这项检查。');
      block(`锁状态未知（${lock.reason || '读不到/内容损坏'}）`);
    }
    console.warn(`⚠️ 锁状态未知（${lock.reason || '读不到/内容损坏'}），但已指定 --force-unlocked：继续执行。`);
  }
  return lock;
}

/**
 * 解析维护命令的公共参数。
 * @returns {{apply:boolean, forceUnlocked:boolean, dir:string|null, bridgeLock:string}}
 */
export function parseMaintenanceArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = value('--dir');
  const bridgeLock = value('--bridge-lock');
  const maintenanceLock = value('--maintenance-lock');
  return {
    apply: argv.includes('--apply'),
    forceUnlocked: argv.includes('--force-unlocked'),
    dir: dir ? path.resolve(dir) : null,
    bridgeLock: bridgeLock ? path.resolve(bridgeLock) : '',
    maintenanceLock: maintenanceLock ? path.resolve(maintenanceLock) : null,
  };
}

/**
 * 统一成功判定：所有维护命令共用同一个「问题格式」，但**完成后置条件按命令选**。
 *
 * 审查教训：把「统一」理解成「所有命令套同一组 pending 条件」会造成
 * 正常的 migrate 假失败（迁移只补 ID，不清空清单），而真正的未记录损失假成功。
 *
 * 通用错误（所有命令都查）：锁冲突 / 锁被接管 / 显式 error / 回填失败 /
 *   failed（数组或数字）/ unreadable。
 * 完成后置条件（requireDrained=true 时查）：pendingRecoverable、
 *   unrecoverableOverflow、pendingUnreadable、unrecordedFailureCount（未 ack）。
 *
 * @param {object} result 维护操作返回结果
 * @param {{statsAfter?: object|null, requireDrained?: boolean}} [options]
 * @returns {string[]} 问题列表；空数组 = 成功
 */
export function maintenanceProblems(result, { statsAfter = null, requireDrained = false } = {}) {
  const problems = [];
  if (!result || typeof result !== 'object') return ['没有返回结果对象'];
  if (result.locked) problems.push('另一个进程持有锁（本次什么也没做）');
  if (result.lockLost) problems.push('锁被其他进程接管（本轮中止）');
  if (result.error) problems.push(`错误：${result.error}`);
  if (result.commitError) {
    problems.push(`回填失败：${result.commitError.error || JSON.stringify(result.commitError)}`);
  }
  const failedCount = Array.isArray(result.failed) ? result.failed.length : (Number(result.failed) || 0);
  if (failedCount > 0) problems.push(`${failedCount} 项处理失败（已保留待下次重试）`);
  if ((Number(result.unreadable) || 0) > 0) problems.push(`${result.unreadable} 个快照读不到`);
  if (Array.isArray(result.idConflicts) && result.idConflicts.length) {
    problems.push(`${result.idConflicts.length} 个同 ID 内容冲突（已保留待人工确认）`);
  }

  // 完成后置条件：只有「要求收口」的命令（replay）才看这些。
  if (requireDrained && statsAfter) {
    if ((Number(statsAfter.pendingRecoverable) || 0) > 0) {
      problems.push(`仍有 ${statsAfter.pendingRecoverable} 条待恢复记录`);
    }
    if ((Number(statsAfter.unrecoverableOverflow) || 0) > 0) {
      problems.push(`另有 ${statsAfter.unrecoverableOverflow} 条失败没有明细（overflow），无法自动恢复`);
    }
    if (statsAfter.pendingUnreadable) {
      problems.push('恢复账本读不到（pending 数字不可信）');
    }
    if (statsAfter.unrecordedFailureCountUnknown) {
      problems.push(`未记录失败的诊断文件读不到/损坏（${statsAfter.unrecordedFailureUnknownReason || '状态未知'}）：真实丢失量未知，不能当成功；修文件或 --ack-manifest-errors 归档后再判`);
    } else if ((Number(statsAfter.unrecordedFailureCount) || 0) > 0) {
      problems.push(`有 ${statsAfter.unrecordedFailureCount} 条失败连清单都没写进去（明细已丢失，见 write-failures.manifest-error.jsonl；确认后可用 --ack-manifest-errors 归档）`);
    } else if (statsAfter.failureManifestWriteError) {
      // count=0 但内存/诊断状态仍存在：这是「无法持久化的失败线索」，
      // 不能因为计数为 0 就当成功（磁盘完全不可写时的最短故障链）。
      problems.push(`存在无法持久化的失败线索（${statsAfter.failureManifestWriteError.code || 'IO'}，未记录不可恢复）：不能当成功`);
    }
  }
  return problems;
}

/**
 * 统一的「计划/执行」输出。所有维护命令都用同一形状，方便脚本消费：
 *   { dryRun, checked, planned/written, failed, ... }
 */
export function reportMaintenance(result, { previewHint } = {}) {
  console.log(JSON.stringify(result, null, 2));
  if (result && result.dryRun && previewHint) console.log(previewHint);
}
