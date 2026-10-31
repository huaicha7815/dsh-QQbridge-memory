// 独立写脚本的维护门包装。
//
// 这些脚本是线性 CLI（主体几百行、末尾直接 exit），不适合搬进
// `withMaintenanceGate` 的同步 callback。这里提供同一套语义的最小包装：
//
//   enterMaintenanceForScript() → 拿 gate → bridge.lock 四态检查
//   （顺序和 health 的 runGated 完全一致；拿不到门就 exit 2）
//
// 释放策略：gate 库的 `process.on('exit')` 是同步最后防线，脚本退出时自动释放；
// 脚本也可以显式调用 `leaveMaintenance()`（正常路径更干净）。
//
// ⚠️ 调用点必须在**读取旧状态之前**：gate 要覆盖「读取 → 计算 → 写回」整段，
// 只包写回循环会让 bridge 在扫描期间改写同一批文件，回填用旧快照覆盖新内容。
import fs from 'node:fs';
import path from 'node:path';
import {
  acquireMaintenanceGate, releaseMaintenanceGate, resolveMaintenanceLockPath,
} from '../../src/lib/maintenance-gate.mjs';
import { requireBridgeIdle, resolveBridgeLockForMemoryDir } from './maintenance.mjs';

/**
 * 进入维护模式。失败直接 exit 2（和 health 的 runGated 同语义）。
 * @param {{memoryDir: string, command: string, forceUnlocked?: boolean, maintenanceLockFile?: string|null}} opts
 * @returns {{lockPath: string, gate: object}}
 */
export function enterMaintenanceForScript({
  memoryDir, command, forceUnlocked = false, maintenanceLockFile = null,
}) {
  const bridgeLockFile = resolveBridgeLockForMemoryDir(memoryDir);
  const lockPath = resolveMaintenanceLockPath({
    bridgeLockFile,
    maintenanceLockFile,
  });
  const acquired = acquireMaintenanceGate(lockPath, { command });
  if (!acquired.ok) {
    if (acquired.busy) {
      const holder = acquired.holder || {};
      console.error(`❌ 维护门被占用（PID ${holder.pid ?? '?'}，${holder.command || 'maintenance'}）：等它结束后重试。`);
    } else {
      console.error(`❌ 维护门状态未知（${acquired.reason || '读不到/内容损坏'}）：需要人工处理。`);
    }
    process.exit(2);
  }
  // bridge.lock 四态检查：running/unknown 拒绝（unknown 需 --force-unlocked）。
  // 这里保留 exit 语义；exit hook 会释放上面拿到的 gate。
  requireBridgeIdle(bridgeLockFile, { forceUnlocked });
  console.log(`[模式] 已进入维护模式（${command}）`);
  return { lockPath, gate: acquired.gate, bridgeLockFile };
}

/** 正常路径显式释放（exit hook 仍会兜底重试）。 */
export function leaveMaintenance({ lockPath, gate }) {
  return releaseMaintenanceGate(lockPath, gate);
}

/**
 * 脚本收尾：检查 release 结果（不能像以前一样忽略返回值）。
 *   missing / replaced → 互斥证据已丢失，本次结果不可信 → 2
 *   retryable          → gate 可能残留到下次 stale 接管，只警告 → 0
 * @returns {number} 需要叠加到退出码上的值（0 或 2）
 */
export function finishMaintenance({ lockPath, gate } = {}) {
  if (!lockPath || !gate) return 0;
  const release = releaseMaintenanceGate(lockPath, gate);
  if (release.replaced || release.missing) {
    console.error('❌ 维护门在操作期间丢失/被替换：本次结果不可信。');
    return 2;
  }
  if (release.retryable) {
    console.error(`⚠️ 维护门释放失败（${release.error || '未知'}）：将留给下一次 stale 接管。`);
  }
  return 0;
}

/** 脚本通用：是否真的写盘。默认预览，只有 --apply 才写；--dry-run 保留为兼容别名。 */
export function scriptWriteMode(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const explicitDryRun = argv.includes('--dry-run');
  return { apply: apply && !explicitDryRun, dryRun: !apply || explicitDryRun };
}

/** 确保目录存在（脚本会在 <project>/state/memory 上跑；gate 要求父目录已存在）。 */
export function ensureStateDir(memoryDir) {
  try {
    fs.mkdirSync(path.dirname(memoryDir), { recursive: true });
  } catch {}
}
