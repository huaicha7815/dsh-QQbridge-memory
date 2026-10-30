# 每轮同步公开仓库（PUBLISH_SYNC）

公开仓库 `qq-bridge-public` 是 `qq-bridge` 的**生成物**：内容只由 `scripts/export-public.mjs`
从源码导出，不能手改。把十几轮审查攒成一个 commit 的代价是**没法单独回退某一轮**，
所以约定改成：**每完成一轮就同步一次，一轮一个 commit**。

---

## 一条命令

```bash
node scripts/sync-public.mjs --round 34 --msg "记忆库：S3 索引三态"
```

它做三件事，任一步失败就停下、不提交：

1. 跑 `scripts/export-public.mjs`（全量重写公开目录，内部含隐私扫描）；
2. `git add -A` + `git commit`，标题为 `round N: <msg>`（不给 `--round` 时用 `chore: <msg>`）；
3. 打印 commit 与「未推送提交数」。

**默认不 push。** 发布会话统一推送；要让这条命令推，加 `--push`（它会先探测
`127.0.0.1:7897` 是否在监听，不通就直接报错，不会挂 21 秒）。

只看状态、不写任何东西：

```bash
node scripts/sync-public.mjs --check
```

输出 HEAD、未推送提交数、未提交改动。

## 等价的手动步骤

```bash
node scripts/export-public.mjs
git -C "C:\Users\1\.dsh\qq-bridge-public" add -A
git -C "C:\Users\1\.dsh\qq-bridge-public" commit -m "round N: …"
```

## 为什么必须每轮一次

- 出问题能精确回退到某一轮，而不是整块 20 轮一起回退；
- 导出是**全量重写**，某一轮漏同步时公开目录会和源码静默分叉，下一轮没人发现；
- 隐私扫描是发布流程的硬性一步（见 [PRIVACY.md](PRIVACY.md)），每轮跑一次才真的挡得住。

## 容易踩的坑

| 现象 | 原因 / 处理 |
| --- | --- |
| `git status` 里冒出 `?? *.r26bak` 之类 | 审查备份落在 `src/` 下被导出。已删源目录里的备份，并在 export 排除规则里加了 `/\.r\d+bak$/` |
| `warning: LF will be replaced by CRLF` | Windows 下正常现象，不影响提交 |
| `--check` 显示有改动但 commit 后仍显示 | 公开目录的 `.gitignore` 由 export 生成，`.export-marker` 属于忽略项，属正常 |
| `push` 21 秒超时 | Clash 没开。`git config --global http.proxy` 指向 `127.0.0.1:7897`，端口没监听就会一直等 |
| 在公开目录里跑了 `sync-public.mjs` | 脚本会直接拒绝（`exit 2`）——它会把导出目标指向自身，等于清空工作副本 |

## 与审查流程的关系

一轮审查的收尾顺序：

1. 修完代码 → 跑 `node scripts/test-daily.mjs`（期望全绿）与相关专项脚本；
2. `node scripts/memory-health.mjs`（只读，确认真实库健康）；
3. 重启桥接加载新代码；
4. `node scripts/sync-public.mjs --round N --msg "…"`（本页）。

推送由发布会话负责：`git -C "C:\Users\1\.dsh\qq-bridge-public" push origin main`。
