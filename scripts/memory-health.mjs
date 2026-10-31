// 记忆库健康检查：一次看清规模、检索质量、档案健康度，并给出可执行建议。
//
// 用法：
//   node scripts/memory-health.mjs                     # 只读诊断（默认，零磁盘副作用）
//   node scripts/memory-health.mjs --dir <库目录>      # 诊断另一个记忆库
//   node scripts/memory-health.mjs --repair-summaries          # 预览可修复的摘要（仍只读）
//   node scripts/memory-health.mjs --repair-summaries --apply  # 真正修复（需先停桥接）
//   --bridge-lock <path>   显式指定目标库的锁（--dir 推断不出时用）
//   --force-unlocked       锁状态未知（读不到/内容损坏）时强行继续（仅在确认桥接已停时用）
//
// 默认**只读**：审计摘要时不备份、不覆盖、不重建。修复是单独命令，必须显式 --apply，
// 且 --apply 会检查桥接是否在跑（它和 consolidation 会写同一批摘要文件）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '../src/core/memory-store.mjs';
import { collectMetrics, compareMetrics, formatCompare, readBaseline } from './memory-baseline.mjs';
import { PROFILE_LIMITS, auditProfile, buildMemoryGraph } from '../src/core/memory-lib.mjs';
// 维护命令的共享契约（默认只读、--apply、目标库锁四态）都在这里，四个写入口共用一份。
import {
  bridgeLockState, requireBridgeIdle, resolveBridgeLockForMemoryDir,
  parseMaintenanceArgs, reportMaintenance, maintenanceProblems,
} from './lib/maintenance.mjs';
import { withMaintenanceGate, gateFailureCode } from '../src/lib/maintenance-gate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);

// 公共参数解析（--apply / --force-unlocked / --dir / --bridge-lock）统一在维护库里，
// 各入口不再手写一份：以前 memDir 手写 --dir、各分支各自 argv.includes('--apply')，
// 组合与缺值行为会在不同分支漂移。
const maintArgs = parseMaintenanceArgs(argv);
const memDir = maintArgs.dir || path.join(root, 'state', 'memory');
const apply = maintArgs.apply;
const forceUnlocked = maintArgs.forceUnlocked;
// 维护命令可以指向别的库（--dir），那么并发保护也必须跟着目标库走。
// 推断不出来返回 null，apply 前 fail-closed；绝不回退脚本所在项目的锁。
const bridgeLockArg = maintArgs.bridgeLock;
const bridgeLockFile = resolveBridgeLockForMemoryDir(memDir, bridgeLockArg);

// 先确认目录真的可读。否则「读不到」会被下面的 stats() 折叠成「0 条事件」，
// 报告看起来像「库是空的而且很健康」——审查时被指出过这个坑。
let readable = true;
try {
  fs.readdirSync(memDir);
} catch (error) {
  // 目录不存在 = 全新库，不算错误（自检脚本要能在空库上跑通）。
  // 其余错误（EPERM 等）才是真的「读不到」。
  if (error?.code === 'ENOENT') {
    console.warn('ℹ️ 记忆目录还不存在（全新库）：' + memDir);
  } else {
    readable = false;
    console.error(`❌ 无法读取记忆目录：${memDir}`);
    console.error(`   ${error?.message ?? error}`);
    console.error('   这不是「库是空的」，是权限或路径问题——先修好再看下面的数字。');
    process.exit(2);
  }
}
if (!fs.existsSync(path.join(memDir, 'events')) && !fs.existsSync(path.join(memDir, 'profile.json'))) {
  console.warn('⚠️ 记忆目录存在但还没有 events/ 与 profile.json：这可能是一个全新的库。');
}

const store = createMemoryStore({ dir: memDir, config: {} });

/**
 * 写操作统一走维护门：callback 返回退出码（不能 process.exit，否则绕过 finally 释放 gate）。
 * 拿不到门 → 2（busy/unsafe 都退出 2，但日志区分）。
 */
function runGated(command, fn) {
  try {
    const attempt = withMaintenanceGate({
      bridgeLockFile,
      maintenanceLockFile: maintArgs.maintenanceLock,
      stateDir: path.dirname(memDir),
      command,
    }, fn);
    if (attempt.ok) return Number(attempt.result) || 0;
    if (attempt.busy) {
      const holder = attempt.holder || {};
      console.error(`❌ 维护门被占用（PID ${holder.pid ?? '?'}，${holder.command || 'maintenance'}）：等它结束后重试。`);
    } else {
      console.error(`❌ 维护门状态未知（${attempt.reason || '读不到/内容损坏'}）：需要人工处理。`);
    }
    return gateFailureCode(attempt);
  } catch (error) {
    // callback 里 requireBridgeIdle({throwOnBlock:true}) 抛出的阻塞错误：
    // gate 已由 wrapper 释放，这里只负责翻译成退出码。
    if (error && error.name === 'MaintenanceBlockedError') {
      console.error(`❌ ${error.message || '桥接未停'}：先停桥接再 --apply。`);
      return error.exitCode || 2;
    }
    throw error;
  }
}

// 恢复入口：以前只打印「可以用 replayWriteFailures()」但没有任何可执行入口，
// 用户修好权限后还得自己写 Node 脚本。这里给一个真能用的一行命令。
// 旧格式迁移入口：给旧失败记录补 id、给旧归档行补 srcDay。
// 默认只预览（dry-run），--apply 才真正写回。
// 确认（ack）诊断文件里的「未记录失败」：明细确实丢了，但归档保留审计线索，
// 之后 health 不再把它当当前阻断（否则它会永久红、replay 永远失败）。
if (argv.includes('--ack-manifest-errors')) {
  // ack 是写操作（rename 诊断文件）：必须在维护门里，且再确认 bridge 没在跑。
  const code = runGated('ack', () => {
    requireBridgeIdle(bridgeLockFile, { explicit: Boolean(bridgeLockArg), forceUnlocked, throwOnBlock: true });
    const result = store.ackManifestErrors();
    reportMaintenance(result);
    return result.ok ? 0 : 1;
  });
  process.exit(code);
}

if (argv.includes('--migrate')) {
  const applyMigrate = apply;
  const runMigrate = () => {
    if (applyMigrate) {
      requireBridgeIdle(bridgeLockFile, { explicit: Boolean(bridgeLockArg), forceUnlocked, throwOnBlock: true });
    }
    const result = store.migrateLegacyRecords({ dryRun: !applyMigrate });
    reportMaintenance(result, {
      previewHint: applyMigrate ? '' : '（上面是预览。确认无误后加 --apply 真正写回）',
    });
    // dry-run 也要看 locked/error：预览阶段就失败时不能 exit 0 假装没事。
    if (!applyMigrate) {
      const previewProblems = maintenanceProblems(result);
      if (previewProblems.length) {
        console.error('❌ 预览失败：');
        for (const p of previewProblems) console.error(`   · ${p}`);
        return 1;
      }
      return 0;
    }
    // migrate 只补 ID，不清空清单：完成后置条件是「迁移操作成功」，不是 pending 归零。
    const problems = maintenanceProblems(result);
    if (problems.length) {
      console.error('❌ 迁移没有完全成功：');
      for (const p of problems) console.error(`   · ${p}`);
      return 1;
    }
    return 0;
  };
  process.exit(applyMigrate ? runGated('migrate', runMigrate) : runMigrate());
}

// 归档迁移快照恢复入口：migrate 期间崩溃会在 events-archive/ 留下
// *.jsonl.migrate-* 快照，里面是还没并回归档月度文件的事件。以前健康页只会
// 提示「调用 recoverArchiveSnapshots()」，同样没有可执行入口。
// 恢复是幂等的（按事件 id / 整行内容的稳定指纹去重），可以重复跑；
if (argv.includes('--recover-archive')) {
  const applyArchive = apply;
  if (applyArchive) {
    requireBridgeIdle(bridgeLockFile, { explicit: Boolean(bridgeLockArg), forceUnlocked });
  }
  const result = store.recoverArchiveSnapshots({ dryRun: !applyArchive });
  console.log(JSON.stringify(result, null, 2));
  const ioErrors = Array.isArray(result.errors) ? result.errors : [];
  // 目录读不到 = 可能还有看不见的快照，绝不能当成功。
  if (result.archiveDirError) {
    console.error(`❌ 读不到归档目录 events-archive（${result.archiveDirError}）`);
    console.error('   里面可能还有待恢复快照；先修目录权限/挂载再重跑，别把它当成「没有数据」。');
    process.exit(2);
  }
  if (result.locked || result.lostLock || result.error) {
    console.error(`❌ 归档恢复未执行：${result.error || '锁被占用'}`);
    console.error('   等另一个恢复结束后重跑；崩溃残留的锁（PID 已不存在）会被自动接管。');
    process.exit(1);
  }
  if (!applyArchive) {
    console.log('（上面是预览：restored=快照数，lines=需要补写的事件数，duplicates=归档里已有的重复行。确认后加 --apply 真正写回）');
    if (ioErrors.length) {
      console.error(`❌ 有 ${result.failed} 个快照读不出来：`);
      for (const line of ioErrors) console.error('   ' + line);
      process.exit(1);
    }
  } else {
    if (result.duplicates > 0) {
      console.log(`已跳过 ${result.duplicates} 条归档里已存在的重复行（按整行内容去重，不是按文本前缀）。`);
    }
    if (result.failed > 0) {
      console.error(`❌ 有 ${result.failed} 个快照没能恢复（快照已保留，可修好原因后重跑）：`);
      for (const line of ioErrors) console.error('   ' + line);
    }
    // 最终判断只看「还剩几个快照」：写失败、锁问题、崩溃都会体现在这里。
    if (Number(result.remaining) > 0) {
      console.error(`❌ 仍有 ${result.remaining} 个归档快照未恢复（restored=${result.restored}）`);
      process.exit(1);
    }
    if (result.failed > 0) process.exit(1);
  }
  process.exit(0);
}

if (argv.includes('--replay')) {
  const applyReplay = apply;
  const runReplay = () => {
    // 桥接本身也是失败清单的写者：它在跑的时候 replay 可能和它抢同一份清单。
    if (applyReplay) {
      requireBridgeIdle(bridgeLockFile, { explicit: Boolean(bridgeLockArg), forceUnlocked, throwOnBlock: true });
    }
    const result = store.replayWriteFailures({ dryRun: !applyReplay });
    reportMaintenance(result, {
      previewHint: applyReplay ? '' : '（上面是预览。确认无误后加 --apply 真正写回）',
    });
    if (!applyReplay) {
      const previewProblems = maintenanceProblems(result);
      if (previewProblems.length) {
        console.error('❌ 预览失败：');
        for (const p of previewProblems) console.error('   · ' + p);
        return 1;
      }
      return 0;
    }
    const problems = maintenanceProblems(result, { statsAfter: store.stats(), requireDrained: true });
    if (problems.length) {
      console.error('❌ replay 没有完全成功：');
      for (const p of problems) console.error('   · ' + p);
      return 1;
    }
    return 0;
  };
  const code = applyReplay ? runGated('replay', runReplay) : runReplay();
  process.exit(code);
}
const now = Date.now();
const st = store.stats({ now });
const profile = store.readProfile();
const recalls = store.readRecallLog({ limit: 1000 });

// 统计口径提示：stats() 只算活动日文件，归档月文件不计入。
// 库活得久了之后「事件总数」会低估历史规模，这里显式说明，避免误读。
// 维护门 stale 归档：不自动清理（审计数据），只做可观测。
const gateStaleCount = (() => {
  try {
    const stateDir = path.dirname(memDir);
    return fs.readdirSync(stateDir).filter((n) => n.startsWith('maintenance.lock.stale-')).length;
  } catch { return 0; }
})();
const archiveMonths = (() => {
  try { return fs.readdirSync(path.join(memDir, 'events-archive')).filter((f) => f.endsWith('.jsonl')).length; } catch { return 0; }
})();

const lines = [];
const say = (s = '') => lines.push(s);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '0%');

say('════ 记忆库健康检查 ════');
say(`时间：${new Date(now).toLocaleString('zh-CN')}`);
say('');

// ── 1. 规模 ───────────────────────────────────────────────
say('【规模】');
// 事件写入失败：这是「聊天看起来正常、但 L1 已经缺数据」的唯一信号。
if (st.pendingRecoverable > 0 || st.unrecoverableOverflow > 0) {
  // 拆成两本账：能补回的 vs 只丢了计数的。混成一个数字用户没法判断。
  say(`  ⚠️ 事件写入失败：${st.pendingRecoverable} 条可恢复 + ${st.unrecoverableOverflow} 条溢出（已丢明细，只能知道数量）`);
  if (st.pendingRecoverable > 0) {
    say('     可恢复部分用 node scripts/memory-health.mjs --replay --apply 写回；先修好 events/ 权限或磁盘空间。');
  }
  if (st.unrecoverableOverflow > 0) {
    say('     溢出的条目超过失败清单上限（10000 条），明细没有保存、无法自动恢复——这是上限换可用性的代价。');
  }
}
if (st.unreadableSnapshots > 0) {
  say(`  ⚠️ 有 ${st.unreadableSnapshots} 个待恢复快照读不出来（权限问题或目录冒充文件）`);
  say('     这些快照里可能有还没恢复的事件；health 看不到内容，不等于没有数据。');
}
if (st.archiveSnapshotError) {
  // 读不到目录 ≠ 没有快照：必须报红，否则修权限这件事永远不会被发现。
  say(`  🔴 归档目录读不出来（${st.archiveSnapshotError}）：里面可能还有待恢复快照`);
  say('     先修 events-archive/ 的权限或挂载，再跑 node scripts/memory-health.mjs --recover-archive。');
}
if (st.archiveSnapshots > 0) {
  say(`  ⚠️ 有 ${st.archiveSnapshots} 个归档迁移快照待恢复（events-archive/*.migrate-*）`);
  say('     它们不是失败记录，不能交给 replay；用 node scripts/memory-health.mjs --recover-archive 预览，加 --apply 写回（幂等，可重复跑）。');
}
if (st.readErrors > 0) {
  say(`  🔴 有 ${st.readErrors} 个记忆文件现在读不出来（${(st.unreadableFiles || []).join('、') || '-'}）`);
  say('     这不是「没有数据」，是「暂时看不见」：修好权限/磁盘后下一次请求会自动重试（读失败不会写进缓存）。');
  say('     这期间档案写入会被拒绝，避免用空档案覆盖原文件；health 的数字也会偏小，先修 IO。');
}
if (st.unrecordedFailureCountUnknown) {
  say('  🔴 未记录失败的诊断文件读不到/损坏：真实丢失量未知');
  say(`     原因：${st.unrecordedFailureUnknownReason || st.failureManifestWriteError?.error || '状态未知'}`);
  say('     不能把它当成 0；修好文件后重跑，或确认丢失范围后用 --ack-manifest-errors 归档。');
}
if (st.failureManifestWriteError && !st.unrecordedFailureCountUnknown) {
  const d = st.failureManifestWriteError;
  say(`  🔴 上次运行连失败清单都写不进去（${d.code}，${d.phase || 'unknown'}，历史 ${d.history || 1} 条）`);
  say(`     ${d.error || ''}`);
  say('     补偿动作的元数据留下了，但消息明细已经丢失（replay 无法用它恢复任何东西）。');
  say('     pending 数字因此不可信；确认范围后可用 --ack-manifest-errors 归档并解除当前告警。');
}
if (st.pendingUnreadable) {
  say('  🔴 失败清单 write-failures.jsonl 读不到（权限/IO）：下面的 pending 数字不可信，不能当成「没有待恢复」。');
  say('     先修权限，再跑 --replay 查看真实待恢复数。');
}
if (st.parseErrorLines > 0) {
  say(`  🔴 有 ${st.parseErrorLines} 条记忆记录解析失败（坏行 / 截断行 / 类型不对）`);
  say('     坏行保持原样没有删（可以人工修复）；它们不进入检索，也不能当证据。');
  say('     注意：语法合法但结构不对的行（null、数组、空对象）同样算坏行，不会被当正常记录用。');
}
if (Array.isArray(st.corruptJsonFiles) && st.corruptJsonFiles.length) {
  const reasons = st.corruptJsonReasons && typeof st.corruptJsonReasons === 'object' ? st.corruptJsonReasons : {};
  const detail = st.corruptJsonFiles
    .map((n) => `${n}（${reasons[n] === 'schema' ? '结构不符合契约' : 'JSON 语法坏'}）`)
    .join('、');
  say(`  🔴 有 ${st.corruptJsonFiles.length} 个 JSON 档案不可用：${detail}`);
  say('     两个原因都按同一条路径处理：备份成 *.corrupt（同名只一次）、拒写、等修好后自动恢复。');
  say('     结构坏 = 语法是合法 JSON，但不是 profile/摘要/usage 该有的形状（例如 lines 不是数组）。');
}
if (st.profileRead && (st.profileRead.corrupt || st.profileRead.readError)) {
  say(`  🔴 长期档案处于写保护：${st.profileRead.corrupt ? 'profile.json 解析失败（坏文件已备份）' : `读取失败 ${st.profileRead.readError}`}`);
  say('     期间所有档案写入都会被拒绝（避免用空档案覆盖原文件）；修好后下一次成功读取会自动解除。');
}
if (st.eventsWithoutSource > 0) {
  say(`  ⚠️ 有 ${st.eventsWithoutSource} 条事件没有来源会话标签（k，含已归档）`);
  say('     open 模式仍能检索；isolated 下它们对任何会话都不可见（fail-closed），也不能当证据。');
  say('     不能靠猜补标签——要么在 open 模式查看，要么人工按可靠元数据修，不要为了「看起来都能用」放宽隔离。');
}
if (st.quarantined > 0) {
  say(`  ⚠️ 失败清单里有 ${st.quarantined} 条坏行（已隔离到 write-failures.jsonl.quarantine）`);
  say('     这些行是 JSON 损坏或缺少 id，无法自动恢复，需要人工查看；它们不计入上面的 writeFailures。');
}
say(`  事件：${st.events} 条 / 覆盖 ${st.eventDays} 天（${st.firstDay || '-'} ~ ${st.lastDay || '-'}）`);
say(`  （注：以上只算活动日文件；另有 ${archiveMonths} 个月归档、${st.archivedEvents || 0} 条已归档事件未计入，历史规模更大）`);
say(`  体积：事件 ${(st.eventBytes / 1024).toFixed(0)} KB · S3 档案 ${(st.salient.bytes / 1024).toFixed(1)} KB`);
say(`  压缩层：日摘要 ${st.summaryFiles} / 周要点 ${st.weekFiles} / 月要点 ${st.monthFiles}`);
say(`  归档：${store.listArchiveMonths().length} 个月`);
// 主动校验现有的日/周/月摘要：search 只会在深窗口检索时才发现损坏，
// health 是一次性运维命令，应该现在就把「很久没被读到」的损坏层捞出来。
const summaryAudit = (() => {
  try { return store.auditSummaries({ limit: 400 }); } catch { return null; }
})();
if (summaryAudit && summaryAudit.corrupt.length) {
  const scope = summaryAudit.sampled
    ? `抽样 ${summaryAudit.checked}/${summaryAudit.totalFiles} 个摘要`
    : `全部 ${summaryAudit.checked} 个摘要`;
  const detail = (list) => list.slice(0, 5).map((c) => `${c.file}（${c.reason === 'schema' ? '结构' : '语法'}）`).join('、');
  say(`  🔴 主动校验：${scope}，其中 ${summaryAudit.corrupt.length} 个不可用`);
  if (summaryAudit.repairable.length) {
    say(`     可自动重建 ${summaryAudit.repairable.length} 个：${detail(summaryAudit.repairable)}`);
  }
  if (summaryAudit.unrepairable.length) {
    say(`     无法自动重建 ${summaryAudit.unrepairable.length} 个（下层数据也缺）：${detail(summaryAudit.unrepairable)}`);
  }
  say('     本次只读：没有备份、没有覆盖。修复用 --repair-summaries（先预览），加 --apply 才真正写。');
}

// 显式修复入口：默认 dry-run 预览；--apply 才写，且拒绝在桥接运行时执行。
if (argv.includes('--repair-summaries')) {
  const applyRepair = apply;
  if (applyRepair) {
    requireBridgeIdle(bridgeLockFile, { explicit: Boolean(bridgeLockArg), forceUnlocked });
  }
  const result = store.repairSummaries({
    limit: 400,
    dryRun: !applyRepair,
    // check-then-write 竞态：清点完可能桥接立刻启动，所以每个文件写之前再查一次。
    beforeWrite: applyRepair
      ? () => {
        const lock = bridgeLockState(bridgeLockFile, { explicit: Boolean(bridgeLockArg) });
        if (lock.state === 'running') {
          throw new Error(`写前复查发现桥接在运行（PID ${lock.pid}），已停止修复`);
        }
        if (lock.state === 'unknown' && !forceUnlocked) {
          throw new Error(`写前复查发现锁状态未知（${lock.reason || ''}），已停止修复`);
        }
      }
      : undefined,
  });
  reportMaintenance(result, {
    previewHint: applyRepair ? '' : '（上面是预览：没有写任何文件。确认后加 --apply 真正修复）',
  });
  process.exit(result.failed.length && applyRepair ? 1 : 0);
}
say('');

// ── 2. 分档 ───────────────────────────────────────────────
say('【重要度分档】');
const tiers = st.tiers;
for (const [i, label] of ['S0 寒暄', 'S1 日常', 'S2 值得记', 'S3 关键'].entries()) {
  const n = tiers[i];
  say(`  ${label}：${n} 条（${pct(n, st.events)}）`);
}
say('');

// ── 3. 检索质量 ───────────────────────────────────────────
say('【检索质量】（基于最近 ' + recalls.length + ' 次检索）');
if (recalls.length) {
  const empty = recalls.filter((r) => !r.n).length;
  const related = recalls.reduce((s, r) => s + (Number(r.related) || 0), 0);
  const echo = recalls.reduce((s, r) => s + (Number(r.echo) || 0), 0);
  const avgN = (recalls.reduce((s, r) => s + (Number(r.n) || 0), 0) / recalls.length).toFixed(1);
  const freq = new Map();
  for (const r of recalls) freq.set(r.q, (freq.get(r.q) || 0) + 1);
  const topQ = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  say(`  平均命中：${avgN} 条 / 空结果率：${pct(empty, recalls.length)}`);
  say(`  关联扩散命中：${related} 条 · 回音命中：${echo} 条`);
  say(`  最高频查询：${topQ.map(([q, n]) => `「${String(q).slice(0, 12)}」×${n}`).join('  ') || '（无）'}`);
}
say('');

// ── 4. 档案 ───────────────────────────────────────────────
say('【长期档案】');
const people = Object.entries(profile.people);
say(`  人物：${people.length} / 上限 ${PROFILE_LIMITS.maxPeople}`);
for (const [name, v] of people.slice(0, 8)) {
  const facts = (v.facts || []).length;
  const last = v.lastSeen ? new Date(v.lastSeen).toLocaleDateString('zh-CN') : '-';
  say(`    ${name}：${facts} 条事实（最近 ${last}）`);
}
const open = profile.threads.filter((t) => t.state === 'open');
const done = profile.threads.filter((t) => t.state === 'done');
say(`  线：未完结 ${open.length} / 已了结 ${done.length} / 上限 ${PROFILE_LIMITS.maxThreads}`);
for (const t of open.slice(0, 5)) say(`    [open] ${t.text.slice(0, 50)}`);
say(`  她自己（self）：${profile.self.length} / 上限 ${PROFILE_LIMITS.maxSelfNotes}`);
say('');

// ── 4.5 档案自检（一致性长歪了没有）────────────────────────
// 「能跑」不等于「记得对」：档案里可能出现同一个人两份档案、
// 同一件事两条线、已经了结却还挂着 open 的线。这些不会报错，只会让她记错。
say('【档案自检】');
const audit = auditProfile(profile);
const problems = audit.problems;
if (!problems) {
  say('  一致：没有同人分裂、重复线、已了结却还挂着 open 的矛盾。');
} else {
  for (const names of audit.samePersonGroups) say(`  疑似同人：${names.join(' / ')}（可合并成一份档案）`);
  for (const { keep, drop } of audit.duplicateThreads) say(`  疑似重复线：「${keep.slice(0, 26)}」≈「${drop.slice(0, 26)}」`);
  for (const { text } of audit.contradictedOpen) say(`  已了结却还算 open：「${text.slice(0, 40)}」`);
  say('  → 用 node scripts/repair-memory-profile.mjs 预览，加 --apply 写回（会先备份）。');
}
say('');

// ── 4.55 事件归属：这条记忆是谁的 ─────────────────────────
// 星图第一次跑就靠「悬空的点」暴露了归档层的缺陷（私聊发送者被写死成「私聊」）。
// 这里把那次的发现固化成可自动跑的指标：谁说的记全了没有、结构上悬空多少。
say('【事件归属】（最近 7 天）');
const recent7 = store.readEvents({ days: 7 });
const whoTag = /^(私聊|群聊|群友|管理员|系统)$/;
const owners = { claimed: 0, tag: 0, empty: 0, other: 0 };
const strangerNames = new Map();
const peopleNames = new Set(people.map(([n]) => n));
for (const e of recent7) {
  const who = String(e?.who ?? '').trim();
  if (!who) owners.empty += 1;
  else if (whoTag.test(who)) owners.tag += 1;
  else if (peopleNames.has(who)) owners.claimed += 1;
  else { owners.other += 1; strangerNames.set(who, (strangerNames.get(who) || 0) + 1); }
}
const total7 = recent7.length || 1;
say(`  总事件 ${recent7.length} 条：认领 ${owners.claimed}（${pct(owners.claimed, total7)}）· 会话标签 ${owners.tag}（${pct(owners.tag, total7)}）· 无发送者 ${owners.empty} · 未建档群友 ${owners.other}`);
if (owners.tag > total7 * 0.01) say('  ⚠ 有事件把「私聊/群聊」当成了发送者：这些记忆接不到任何人，检索里「谁跟谁」的信号会丢。');
const topStrangers = [...strangerNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
if (topStrangers.length) say(`  未建档但活跃：${topStrangers.map(([n, ct]) => `${n}(${ct})`).join('、')}`);
// 结构悬空率：用和星图同一套构图（S2/S3 为主），看记忆之间有没有钩子
const graph = buildMemoryGraph(profile, recent7, { now, maxEvents: 60 });
const isoRate = graph.stats.nodes ? graph.stats.isolated.length / graph.stats.nodes : 0;
say(`  结构：${graph.stats.nodes} 点 / ${graph.stats.edges} 连 / 悬空 ${graph.stats.isolated.length}（${pct(graph.stats.isolated.length, graph.stats.nodes)}）· 最大枢纽 ${graph.stats.hubs[0] ? `${graph.stats.hubs[0].label}(${graph.stats.hubs[0].degree})` : '—'}`);
if (isoRate > 0.4) say('  ⚠ 悬空点超过 40%：这些记忆没跟任何人物/事件挂钩，等于「记下来了但没人认领」。');
say('');

// ── 4.6 日终归纳（V3.7）是否在跑 ────────────────────────────
// 每天一次独立调用，最容易「悄悄没跑」：时间配错、记忆库关着、owner 没设。
// 这里只报告事实，不猜原因。
say('【日终归纳】');
try {
  const st = JSON.parse(fs.readFileSync(path.join(root, 'state', 'memory-refine.json'), 'utf8'));
  const lastAt = Number(st.lastAt) || 0;
  const days = lastAt ? Math.floor((now - lastAt) / 86400000) : -1;
  say(`  最近一次：${st.lastDay || '—'}${lastAt ? `（${new Date(lastAt).toLocaleString('zh-CN')}）` : ''}`);
  if (days > 2) say('  已经超过 2 天没整理过：检查 config.memoryRefine（enabled/time）与桥接是否在跑。');
} catch {
  say('  还从没跑过（state/memory-refine.json 不存在）。要么是新装的，要么 config.memoryRefine.enabled=false。');
}
say('');

// ── 4.7 基线对比：跟上一版比，哪里在慢慢变坏 ─────────────────
// 单看一次 health 看不出漂移；跟基线比，「悬空率悄悄爬到 40%」这种才藏不住。
const baseline = readBaseline();
let baseBad = [];
if (baseline) {
  const current = collectMetrics(store, profile, now);
  const rows = compareMetrics(baseline.metrics, current);
  for (const line of formatCompare(baseline, rows, now)) say(line);
  baseBad = rows.filter((r) => r.level === 'bad');
  say('');
} else {
  say('【基线对比】还没有基线。记一次：node scripts/memory-baseline.mjs --save');
  say('');
}

// ── 5. 建议 ───────────────────────────────────────────────
const advice = [];
if (baseBad.length) advice.push(`基线变坏：${baseBad.map((r) => r.label).join('、')}（对比上一版；先看上面数值，再查归档/档案）。`);
if (problems) advice.push(`档案有 ${problems} 处一致性问题（同人分裂/重复线/已了结还挂着），用 node scripts/repair-memory-profile.mjs --apply 修掉。`);
const shard = st.events ? tiers[0] / st.events : 0;
// 容量：isolated 只在可见范围内淘汰，混合档位会暂时超限——提示，不自动删。
const overLimitPeople = Object.values(profile.people)
  .filter((v) => (Array.isArray(v.facts) ? v.facts.length : 0) > PROFILE_LIMITS.maxFactsPerPerson).length;
if (overLimitPeople > 0) {
  say(`  ℹ️ 有 ${overLimitPeople} 个人物档位的事实数超过上限 ${PROFILE_LIMITS.maxFactsPerPerson}（isolated 只在可见范围内淘汰，不算异常）`);
}
if (st.eventDays >= 3 && st.events < 50) advice.push('事件量偏少：桥接可能没在跑，或最近很安静。');
if (gateStaleCount > 0) advice.push(`维护门有 ${gateStaleCount} 个 stale 归档（maintenance.lock.stale-*）：是过去维护进程崩溃的审计记录，不自动删除；确认无用后可人工清理。`);
if (st.failureManifestWriteError) advice.push('上次运行连失败清单都写不进去：检查 write-failures.manifest-error.jsonl，确认磁盘/权限恢复后再评估丢失范围。');
if (st.pendingUnreadable) advice.push('恢复账本读不到（或隔离区不可读）：pendingRecoverable 不可信，先修权限再判断是否需要 replay。');
if (st.parseErrorLines > 0) advice.push(`有 ${st.parseErrorLines} 条记忆记录解析失败：坏行还在原文件里，人工修好后重新读取会自动恢复计数。`);
if (typeof summaryAudit !== 'undefined' && summaryAudit && summaryAudit.corrupt.length) {
  advice.push(`有 ${summaryAudit.corrupt.length} 个摘要文件不可用：可自动重建 ${summaryAudit.repairable.length} 个，需人工 ${summaryAudit.unrepairable.length} 个。先跑 --repair-summaries 预览，停桥接后加 --apply 修复。`);
}
if (Array.isArray(st.corruptJsonFiles) && st.corruptJsonFiles.length) advice.push(`有 ${st.corruptJsonFiles.length} 个 JSON 档案不可用（${st.corruptJsonFiles.join('、')}）：已备份为 *.corrupt，修好后下次读取自动恢复。`);
if (st.readErrors > 0) advice.push(`有 ${st.readErrors} 个记忆文件读不出来（${(st.unreadableFiles || []).join('、') || '-'}）：先修权限/磁盘，别当成「没有数据」。`);
if (st.profileRead && !st.profileRead.writable) advice.push('长期档案处于写保护（读不到或解析失败）：修好 profile.json 后下一次成功读取会自动恢复写入。');
if (st.eventsWithoutSource > 0) advice.push(`有 ${st.eventsWithoutSource} 条事件没有来源标签：isolated 下不可见、也不能当证据；需要的话按可靠元数据补 k，别用「无来源即公共」绕过隔离。`);
// 「有待恢复的数据」必须是建议，否则正文报警了、结尾还写「一切正常」，读的人只会看结尾。
if (st.archiveSnapshotError) advice.push(`归档目录读不出来，里面可能还有待恢复快照（${st.archiveSnapshotError}）：先修 events-archive/ 的权限或挂载。`);
else if (st.archiveSnapshots > 0) advice.push(`有 ${st.archiveSnapshots} 个归档迁移快照待恢复：node scripts/memory-health.mjs --recover-archive --apply。`);
if (st.pendingRecoverable > 0 || st.unrecoverableOverflow > 0) advice.push(`还有未恢复的写入失败（可恢复 ${st.pendingRecoverable} 条 / 溢出 ${st.unrecoverableOverflow} 条）：先看上面【写入失败】再跑 --replay --apply。`);
if (st.unreadableSnapshots > 0) advice.push(`有 ${st.unreadableSnapshots} 个待恢复快照读不出来：先修权限，别当成没有数据。`);
if (shard > 0.45) advice.push(`寒暄占比 ${Math.round(shard * 100)}% 偏高：重要度阈值可能太松，可调 socialV2.memory.weekMinSalience。`);
if (recalls.length >= 20) {
  const empty = recalls.filter((r) => !r.n).length / recalls.length;
  if (empty > 0.35) advice.push(`空结果率 ${Math.round(empty * 100)}% 偏高：可调大 searchDays，或把 searchTopK 提高。`);
}
if (people.length === 0 && st.eventDays >= 7) advice.push('档案还是空的：日记【顺手记住】可能没生效（检查 diaryRemember 与桥接重启）。');
if (open.length === 0 && done.length === 0 && st.eventDays >= 7) advice.push('没有记下任何「线」：她可能没在用 qq_memory_remember。');
if (st.weekFiles === 0 && st.eventDays > 7) advice.push('周要点还没生成：需要有一个「已经过完的周」（周一到周日走完）才会补。');
const overdue = open.filter((t) => now - (t.lastMentionAt || t.createdAt) > 30 * 86400000);
if (overdue.length) advice.push(`有 ${overdue.length} 条线超过 30 天没被提起，可以考虑用 qq_memory_remember(kind="threadDone") 收尾。`);
const superseded = people.reduce((s, [, v]) => s + (v.facts || []).filter((f) => f.previous).length, 0);
if (superseded) advice.push(`档案里有 ${superseded} 条事实被纠正过（保留在 previous 里），可以用 qq_memory_inspect 复查。`);
if (owners.tag > total7 * 0.03) advice.push(`会话标签事件占 ${Math.round((owners.tag / total7) * 100)}%：归档层可能没记真实发送者（V4.4 前的私聊缺陷），用 node scripts/backfill-private-who.mjs 预览回填。`);
if (isoRate > 0.4) advice.push(`星图悬空 ${Math.round(isoRate * 100)}%：先看上面【事件归属】里未建档的群友，或用 qq_memory_remember(kind="person") 把常说话的人建档。`);

say('【建议】');
if (advice.length) for (const a of advice) say(`  · ${a}`);
else say('  · 一切正常，没发现需要处理的问题。');
say('');

console.log(lines.join('\n'));
