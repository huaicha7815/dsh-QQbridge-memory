# 发布验收记录（RELEASE-SMOKE）

> 用途：发布环境执行人工/环境验收，逐项记录证据。**任何一项 FAIL 都停在发布环境**，不要回代码会话盲修。
>
> 配套脚本：`node scripts/release-preflight.mjs`（只读检查 + daily/audit；不会 tag/push）。
> 使用方式：复制本文件为 `release-<tag>-smoke.md`，逐项填写；PASS/FAIL/SKIP 必须有证据路径或原始输出。

## 0. 元信息

| 项 | 值 |
|---|---|
| 发布候选 HEAD | `__________` |
| 发布 tag | `__________` |
| 执行人 | `__________` |
| 执行时间 | `__________` |
| OS / 版本 | `__________` |
| 浏览器 / 版本 | `__________` |
| Node 版本 | `__________` |
| 屏幕 / 缩放 / 主题 | `__________` |

## 1. 干净检出 + 依赖

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 1.0 | `release-preflight` 记录：完整 HEAD、运行模式（source+publicDir / public-only）、命令、退出码 | PASS / FAIL | |
| 1.1 | 全新目录 `git clone`（不复用外部 node_modules） | PASS / FAIL | |
| 1.2 | `package-lock.json` 存在且 `npm ci` 成功 | PASS / FAIL | |
| 1.3 | `cp config.example.json config.json` + 建 `state/` | PASS / FAIL | |
| 1.4 | `node scripts/test-daily.mjs` 全部套件通过（记录实际套件数） | PASS / FAIL | |
| 1.5 | `node scripts/test-audit.mjs` 全绿 | PASS / FAIL | |
| 1.6 | `node scripts/gen-routes-doc.mjs --check` 最新 | PASS / FAIL | |
| 1.7 | `node scripts/release-preflight.mjs` 通过 | PASS / FAIL | |

## 2. 控制台真实浏览器 smoke

| # | 检查 | 结果 | 证据（截图/Console） |
|---|---|---|---|
| 2.1 | `/?token=...` 引导成功，localStorage 写入，地址栏 token 被移除 | PASS / FAIL | |
| 2.2 | 14 个视图逐个切换无白屏/JS 错误 | PASS / FAIL | |
| 2.3 | 心情页：五个指标说明可见且与实际语义一致 | PASS / FAIL | |
| 2.4 | 心情页：1000 条历史渲染无卡死（记录首屏耗时） | PASS / FAIL | 耗时：____ms |
| 2.5 | 心情页：40 条「情绪从哪来」全部显示 | PASS / FAIL | |
| 2.6 | 心情页：历史损坏横幅正常（可模拟降级） | PASS / FAIL / SKIP | |
| 2.7 | Galaxy iframe 加载、全屏/退出全屏、筛选、tooltip | PASS / FAIL | |
| 2.8 | `#memory-graph` 重定向一次到 `#memory-galaxy` | PASS / FAIL | |
| 2.9 | Console 无 CSP violation / JS error / 404 | PASS / FAIL | |
| 2.10 | 窄屏 / 宽屏 / 深浅主题各一次 | PASS / FAIL | |

## 3. Windows ACL

| # | 检查 | 结果 | 证据（`icacls` 原始输出） |
|---|---|---|---|
| 3.1 | `node scripts/harden-state-acl.mjs` 成功或无阻塞告警 | PASS / FAIL | |
| 3.2 | `icacls state`：继承已切断/告警明确 | PASS / FAIL | |
| 3.3 | `icacls state\console-token`：仅当前用户/SYSTEM/Administrators | PASS / FAIL | |
| 3.4 | 控制台安全页显示 `stateDirHardened=true` | PASS / FAIL | |

## 4. TTS / start / restart

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 4.1 | `start.bat`：TTS 后台启动不阻塞 | PASS / FAIL | |
| 4.2 | bridge 在 launcher 90 秒窗口内 ready | PASS / FAIL | 耗时：____s |
| 4.3 | 控制台 3100 端口可访问 | PASS / FAIL | |
| 4.4 | `bridge.lock` 为合法 JSON | PASS / FAIL | |
| 4.5 | 第二次 `start.bat` 退出码 2，无双实例 | PASS / FAIL | |
| 4.6 | `restart.bat`：旧实例完全退出、端口释放、只有一个新实例 | PASS / FAIL | |
| 4.7 | restart 后 `social-v2.json` 不被旧快照覆盖 | PASS / FAIL | |

## 5. 外部集成（测试账号/测试群）

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 5.1 | OneBot/SnowLuma 网关连接 | PASS / FAIL | |
| 5.2 | DSH session create / prompt / send | PASS / FAIL | |
| 5.3 | DSH restart / archive | PASS / FAIL | |
| 5.4 | voice-tool / TTS 合成 | PASS / FAIL | |
| 5.5 | 语音发送回读（`verified=true`） | PASS / FAIL | |
| 5.6 | 图片 / 表情 / 合并转发 | PASS / FAIL | |
| 5.7 | `qq_wait_for_messages` 与 OneBot 在线链路 | PASS / FAIL | |

## 6. UPSTREAM 与许可证

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 6.1 | `tools/memory-galaxy/UPSTREAM.md` 记录真实 upstream repo + commit SHA | PASS / FAIL / PENDING | |
| 6.2 | vendored 文件本地 SHA-256 与表格一致 | PASS / FAIL | |
| 6.3 | MIT LICENSE、来源声明完整 | PASS / FAIL | |
| 6.4 | 发布说明未把本地指纹冒充 upstream commit | PASS / FAIL | |

> 网络仍不可用时：保留「真 SHA 待补」记录，发布说明不得声称已完成 upstream pin。

## 7. Public export 与干净 clone

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 7.0 | source HEAD ↔ public HEAD；export manifest 双向一致 + 每个文件内容哈希一致 | PASS / FAIL | |
| 7.1 | `node scripts/export-public.mjs` 成功、privacy-scan 通过 | PASS / FAIL | |
| 7.2 | 导出物不含 `state/`、token、真实记忆、`galaxy-data*.json` | PASS / FAIL | |
| 7.3 | 干净 clone 后 `npm ci` + `test-daily` 通过 | PASS / FAIL | |
| 7.4 | 公开工作树干净；`git show --check --format= HEAD` 无空白错误 | PASS / FAIL | |
| 7.5 | `privacy-scan` 原始输出（无敏感信息） | PASS / FAIL | |

## 8. Tag / Push（人工确认后）

| # | 检查 | 结果 |
|---|---|---|
| 8.1 | 以上全部 PASS/SKIP 合理 | |
| 8.2 | `git tag -a <tag> -m "<title>"` 并 `git show` 核对 | |
| 8.3 | 维护面规则写入 README、回滚 commit/tag 已记录 | |
| 8.4 | 人工确认后 push 分支与 tag | |

## 9. 维护命令临时库 smoke（可选）

在临时库上验证维护命令不碰生产数据：

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 9.1 | memory-health 默认只读，不改任何文件 | PASS / FAIL / SKIP | |
| 9.2 | replay --dry-run 不写盘；--apply 幂等 | PASS / FAIL / SKIP | |
| 9.3 | repair-summaries --dry-run 不写盘 | PASS / FAIL / SKIP | |
| 9.4 | 临时库 ACL 不影响生产 state/ | PASS / FAIL / SKIP | |

## 结论

- 总评：PASS / FAIL / SKIP
- preflight 模式：public-only 或 source 模式（7.0 必须由 source 模式结果填写，public-only 的 SKIP 不能当已验证）
- 阻断项（编号 + 证据）：`__________`
- 处理决定：`__________`