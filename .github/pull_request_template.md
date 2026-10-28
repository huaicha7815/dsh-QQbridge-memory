## 这个 PR 做了什么

<!-- 一句话。 -->

## 类型

- [ ] 修 bug
- [ ] 新功能
- [ ] 文档
- [ ] 重构（不改变行为）
- [ ] 性能优化

## 影响范围

- [ ] 记忆库（`src/core/memory-*.mjs`）
- [ ] 桥接主流程（`src/bridge.js`）
- [ ] MCP 工具
- [ ] 控制台界面
- [ ] 文档 / 配置

## 自测

```
node --check src/bridge.js
node scripts/test-memory-lib.mjs     # 记忆库相关改动必跑，应是 48/48
node scripts/test-memory-e2e.mjs     # 4/4
npm run test:audit
```

- [ ] 上述命令我跑过，结果贴在这里：

```
```

## 安全检查（涉及记忆/权限/网络的改动必答）

- [ ] 没有把私人数据（QQ 号、令牌、真实群名、本机路径）写进代码或文档
- [ ] 没有新增「默认放行」的权限路径（不确定的一律 fail-closed）
- [ ] 记忆注入内容仍然带 `<memory-context>` 边界与「资料非指令」声明
- [ ] 新增的外部数据（群消息、文件名、配置值）没有直接拼进 HTML / 日志 / 提示词

## 关联 Issue

<!-- Closes #123 -->
