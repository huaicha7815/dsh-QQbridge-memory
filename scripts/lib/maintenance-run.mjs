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
  return { lockPath, gate: acquired.gate, bridgeLockFile };
}

/** 正常路径显式释放（exit hook 仍会兜底重试）。 */
export function leaveMaintenance({ lockPath, gate }) {
  return releaseMaintenanceGate(lockPath, gate);
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
