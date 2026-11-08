# 情绪系统 V2 —— 发布清单（可执行版）

> codex 阶段 4 R73 复审：**仅清单计数阻塞，修正后可放行 canary**（契约 ADDENDUM v2.69；本轮 commit 见 git log）（实现可交付；发布门槛需可执行证据）。本清单要求逐项填写环境、时间、hash、数值阈值、观察窗口、责任人与签字；未填写的项视为未完成，不得签生产发布。

---

## 0. 执行环境（固定）

- Shell：**PowerShell**（Windows 本机，`pwsh` 不可用时用 `powershell`）；不在 Git Bash/WSL 混用。
- 工作目录：`C:\dsh work\qq-bridge`。
- Node：`node --version` 记录版本。

## 1. 自动化门禁（每次发版前必须全绿）

| 项 | 命令 | 通过标准 | 本次结果 | 时间 | 执行人 |
| --- | --- | --- | --- | --- | --- |
| 阶段 2 | `node --test scripts/test-emotion-v2-stage2.mjs` | 18/18 pass | ☐ | ☐ | ☐ |
| 阶段 3 | `node --test scripts/test-emotion-v2-stage3.mjs` | 28/28 pass | ☐ | ☐ | ☐ |
| 阶段 4 | `node --test scripts/test-emotion-v2-stage4.mjs` | 3/3 pass | ☐ | ☐ | ☐ |
| smoke | `node --test scripts/test-smoke-emotion-v2.mjs` | 2/2 pass（端到端 buildWakePromptV2+explainMoodV2 + 真实 bridge 阈值效果 background.factor=0.85） | ☐ | ☐ | ☐ |
| bridge | `node --test scripts/test-emotion-v2-bridge.mjs` | 55/55 pass | ☐ | ☐ | ☐ |
| store | `node --test scripts/test-emotion-v2-store.mjs` | 76/76 pass | ☐ | ☐ | ☐ |
| exec | `node --test scripts/test-emotion-v2-exec.mjs` | 80/80 pass | ☐ | ☐ | ☐ |
| 1A | `node --test scripts/test-mood-emotions.mjs` | 60/60 pass | ☐ | ☐ | ☐ |
| probe | `node scripts/probe-emotion-v2.mjs` | 13/13 | ☐ | ☐ | ☐ |
| daily | `node scripts/test-daily.mjs` | 42 套件全绿（`scripts/daily-suites.mjs` 为唯一数据源） | ☐ | ☐ | ☐ |
| 语法 | `node --check src/bridge.js` | 无输出（exit 0） | ☐ | ☐ | ☐ |
| 路由文档 | `node scripts/gen-routes-doc.mjs` 后 `git status --porcelain docs/ROUTES.md` | 无变更（已同步） | ☐ | ☐ | ☐ |

## 1.1 清单一致性自动校验

`node --test scripts/test-release-checklist.mjs` 断言本清单中的 smoke 数量、detail 5xx 阈值写法与真实测试一致；清单更新后必须先跑此校验。

## 2. 真实网关人工 smoke（不可自动化，必须签字）

环境：真实 SnowLuma 网关 + 测试 QQ 账号；`emotion.v2.enabled=true, mode=main`。

| 场景 | 操作 | 预期 | 实际（含消息 ID/时间/文件 hash） | 签字 |
| --- | --- | --- | --- | --- |
| 私聊 | 发「你真棒」 | 情绪事件写入、detail 有 episode/双通道 | ☐ | ☐ |
| 群聊 | @机器人 发负性消息 | 群聊 context 情绪正确 | ☐ | ☐ |
| 引用 | 引用上一条回复 | 引用链不破坏情绪事件 | ☐ | ☐ |
| poke | 拍一拍 | poke 事件源正确 | ☐ | ☐ |
| outgoing | 机器人发送后 | outgoing 事件源正确 | ☐ | ☐ |
| 暂停/恢复 | 控制台暂停→发消息→恢复 | paused 期间不写 V2、恢复后正常 | ☐ | ☐ |
| 重启恢复 | 重启后查 detail | V2 状态/时间锚保留、lastSave ok | ☐ | ☐ |

## 3. 真实 memoryStore 持久化

| 项 | 操作 | 通过标准 | 实际 | 签字 |
| --- | --- | --- | --- | --- |
| meta.emotions 写入 | 触发情绪事件 → 查 memory 文件 | entry.meta.emotions 存在（≤3、kind+intensity） | ☐ | ☐ |
| 检索 | 按事件检索 | 能取回且不回写 mood | ☐ | ☐ |
| 重启保留 | 重启后检索 | 仍在 | ☐ | ☐ |

## 4. 配置/状态迁移演练

| 项 | 操作 | 通过标准 | 实际 | 签字 |
| --- | --- | --- | --- | --- |
| 备份 | `Copy-Item config.json config.json.bak-<ts>` 等；`Get-FileHash -Algorithm SHA256 <file>` | 备份文件存在 + SHA256 记录 | ☐ | ☐ |
| main→shadow | 改 `emotion.v2.shadow=true` 重启 | 只投影不写盘、detail 可用 | ☐ | ☐ |
| main→legacy | `emotion.v2.enabled=false` 重启 | 回退 legacy、无 5xx | ☐ | ☐ |
| 恢复 | 用备份覆盖 + 重启 | 状态/关系/记忆恢复、detail 正常 | ☐ | ☐ |
| 回滚验收 | 检查 `/state` emotionV2.mode | 与预期一致、无 degraded 异常 | ☐ | ☐ |

## 5. canary 指标（数值阈值 + 观察窗口）

观察窗口：**发布后 24h**（每 5min 采样）；责任人：☐。

| 指标 | 来源 | 阈值（超出即回滚） | 观察结果 |
| --- | --- | --- | --- |
| `emotionV2.lastSave.ok` | `/api/socialV2/state` | 连续 3 次 false | ☐ |
| `degradedReasons` | 同上 | 出现 budget/degraded 非预期项 | ☐ |
| memory append 错误 | 日志 `memory-append` | ≥3 次/5min | ☐ |
| detail 5xx（绝对数） | 控制台/网关日志 | 连续 3 个 5min 窗口各 ≥5 次 5xx（低流量不用百分比） | ☐ |
| prompt 长度 | 日志 `prompt` | P95 > 40KB 且持续 10min | ☐ |
| 贴纸/语音拒绝率 | 日志 `send_sticker/voice` | 比基线 +10pp | ☐ |
| 情绪错误率 | 日志 `emotion-v2` | 出现连续异常 | ☐ |

## 6. 灰度与回滚

1. shadow 24h（确认无异常写入）；
2. main 小流量（10% 会话）24h；
3. 全量；
4. 任一阈值触发 → `emotion.v2.enabled=false` + 备份恢复 + 记录原因/时间/hash。

## 6.1 canary 启动记录（回填）

| 字段 | 值 |
| --- | --- |
| Node 版本 | `node --version` → ☐ |
| 启动时间 | ☐ |
| 执行人 | ☐ |
| 初始模式 | main 小流量 / shadow ☐ |
| 自动门禁结果（回填） | checklist 1/1、smoke 2/2、daily 42、probe 13/13 ☐ |
| 签字人 | ☐ |

## 7. 签字

| 角色 | 姓名 | 日期 |
| --- | --- | --- |
| 功能验证 | ☐ | ☐ |
| 发布执行 | ☐ | ☐ |
| 回滚决策 | ☐ | ☐ |
