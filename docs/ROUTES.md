# HTTP 接口清单

> 这份文档由 `node scripts/gen-routes-doc.mjs` 从源码自动生成，**不要手改**。
> 改了端点之后重新跑一次，或让 `npm run routes:doc` 帮你更新。

共 **132** 个路由判断，分布在 4 个文件里。

## 按域统计

| 域 | 端点数 | 主要文件 |
| --- | --- | --- |
| `api/socialV2` | 58 | src/bridge.js |
| `api/slang` | 9 | src/bridge.js |
| `api/roles` | 7 | src/routes/roles-api.mjs |
| `api/tokens` | 6 | src/routes/tokens-api.mjs |
| `api/stickers` | 5 | src/bridge.js |
| `api/send` | 5 | src/bridge.js |
| `api/preset` | 4 | src/bridge.js |
| `api/social` | 4 | src/bridge.js |
| `api/memory` | 4 | src/routes/memory-api.mjs |
| `(根)` | 2 | src/bridge.js |
| `api/status` | 2 | src/bridge.js |
| `api/images` | 2 | src/bridge.js |
| `api/authorize` | 2 | src/bridge.js |
| `api/whitelist` | 2 | src/bridge.js |
| `api/dsh` | 2 | src/bridge.js |
| `api/security` | 2 | src/bridge.js |
| `api/console` | 2 | src/bridge.js |
| `api/role-map` | 2 | src/routes/roles-api.mjs |
| `favicon.ico` | 1 | src/bridge.js |
| `api/presets` | 1 | src/bridge.js |
| `api/mode` | 1 | src/bridge.js |
| `api/sessions` | 1 | src/bridge.js |
| `api/pending` | 1 | src/bridge.js |
| `api/test-send` | 1 | src/bridge.js |
| `api/voice` | 1 | src/bridge.js |
| `api/session` | 1 | src/bridge.js |
| `api/workspace` | 1 | src/bridge.js |
| `api/restart` | 1 | src/bridge.js |
| `api/role` | 1 | src/routes/roles-api.mjs |
| `api/role-mode` | 1 | src/routes/roles-api.mjs |

## api/socialV2

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/socialV2/*` | 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝 | src/bridge.js:3091 |
| ANY | `/api/socialV2/*` | 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理） | src/bridge.js:3096 |
| ANY | `/api/socialV2/*` | 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用 | src/bridge.js:3101 |
| ANY | `/api/socialV2/feedback` | — | src/bridge.js:3107 |
| ANY | `/api/socialV2/*` | — | src/bridge.js:3121 |
| GET | `/api/socialV2/config` | ── 二代仿真模式（reserved2）内部 Agent API ───────────────────────── | src/bridge.js:3966 |
| POST | `/api/socialV2/config` | — | src/bridge.js:3970 |
| GET | `/api/socialV2/activity` | — | src/bridge.js:4136 |
| POST | `/api/socialV2/activity` | — | src/bridge.js:4140 |
| POST | `/api/socialV2/reset` | — | src/bridge.js:4158 |
| GET | `/api/socialV2/state` | — | src/bridge.js:4199 |
| GET | `/api/socialV2/prompt` | — | src/bridge.js:4218 |
| GET | `/api/socialV2/unread` | — | src/bridge.js:4312 |
| GET | `/api/socialV2/recent` | — | src/bridge.js:4334 |
| POST | `/api/socialV2/mark-read` | — | src/bridge.js:4350 |
| POST | `/api/socialV2/wake-config` | — | src/bridge.js:4389 |
| GET | `/api/socialV2/states` | — | src/bridge.js:4534 |
| POST | `/api/socialV2/wake` | — | src/bridge.js:4550 |
| POST | `/api/socialV2/send-burst` | — | src/bridge.js:4580 |
| POST | `/api/socialV2/send-message` | — | src/bridge.js:4705 |
| POST | `/api/socialV2/send-poke` | — | src/bridge.js:4854 |
| POST | `/api/socialV2/qzone-send` | ── QQ 空间：发说说（仅管理员私聊；默认好友可见） ───────────────────── | src/bridge.js:4951 |
| POST | `/api/socialV2/qzone-list` | ── QQ 空间：看自己发过的说说（她回看自己的时间线） ────────────── | src/bridge.js:4997 |
| GET | `/api/socialV2/sticker-image` | — | src/bridge.js:5038 |
| GET | `/api/socialV2/self-image` | — | src/bridge.js:5073 |
| POST | `/api/socialV2/sticker-note` | — | src/bridge.js:5090 |
| POST | `/api/socialV2/sticker-remark` | — | src/bridge.js:5108 |
| POST | `/api/socialV2/send-voice` | ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ──── | src/bridge.js:5243 |
| POST | `/api/socialV2/send-sticker` | — | src/bridge.js:5308 |
| POST | `/api/socialV2/collect-sticker` | — | src/bridge.js:5414 |
| ANY | `/api/socialV2/voices` | 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析） | src/bridge.js:5462 |
| GET | `/api/socialV2/sticker-list` | — | src/bridge.js:5507 |
| POST | `/api/socialV2/sticker-list` | — | src/bridge.js:5530 |
| POST | `/api/socialV2/wait` | — | src/bridge.js:5605 |
| POST | `/api/socialV2/check-send` | — | src/bridge.js:5799 |
| GET | `/api/socialV2/tool-log` | ── 工具调用日志 ────────────────────────────────────────────────── | src/bridge.js:5832 |
| POST | `/api/socialV2/tool-log/clear` | — | src/bridge.js:5837 |
| GET | `/api/socialV2/feedback` | ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ──────────────────────────── | src/bridge.js:5845 |
| POST | `/api/socialV2/feedback-clear` | — | src/bridge.js:5849 |
| POST | `/api/socialV2/feedback` | — | src/bridge.js:5856 |
| GET | `/api/socialV2/my-recent` | — | src/bridge.js:5887 |
| POST | `/api/socialV2/record-sent` | — | src/bridge.js:5899 |
| GET | `/api/socialV2/message-detail` | — | src/bridge.js:5904 |
| GET | `/api/socialV2/forward-message` | ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ──────────── | src/bridge.js:5955 |
| POST | `/api/socialV2/forward-media` | — | src/bridge.js:6047 |
| GET | `/api/socialV2/active-members` | — | src/bridge.js:6066 |
| POST | `/api/socialV2/memory-append` | — | src/bridge.js:6090 |
| GET | `/api/socialV2/memory-search` | 检索是纯本地 BM25，零 token；只有 AI 主动调用时才产生这两个工具调用的成本 | src/bridge.js:6118 |
| GET | `/api/socialV2/memory-stats` | — | src/bridge.js:6141 |
| POST | `/api/socialV2/memory-remember` | — | src/bridge.js:6150 |
| GET | `/api/socialV2/memory-inspect` | — | src/bridge.js:6226 |
| GET | `/api/socialV2/memory-profile` | — | src/bridge.js:6254 |
| POST | `/api/socialV2/memory-update` | — | src/bridge.js:6262 |
| GET | `/api/socialV2/memory` | — | src/bridge.js:6315 |
| POST | `/api/socialV2/memory-remove` | — | src/bridge.js:6341 |
| POST | `/api/socialV2/memory-clear` | — | src/bridge.js:6367 |
| GET | `/api/socialV2/slang/query` | ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ───────────────── | src/bridge.js:6385 |
| POST | `/api/socialV2/slang/submit` | — | src/bridge.js:6408 |

## api/slang

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/slang` | ── 黑话库管理 ─────────────────────────────────────────────────── | src/bridge.js:3324 |
| POST | `/api/slang` | — | src/bridge.js:3330 |
| POST | `/api/slang/clear` | — | src/bridge.js:3352 |
| POST | `/api/slang/batch-delete` | — | src/bridge.js:3377 |
| POST | `/api/slang/batch-confirm` | — | src/bridge.js:3404 |
| POST | `/api/slang/batch-reject` | — | src/bridge.js:3426 |
| POST | `/api/slang/extract` | — | src/bridge.js:3515 |
| POST | `/api/slang/research` | — | src/bridge.js:3530 |
| POST | `/api/slang/config` | — | src/bridge.js:3542 |

## api/roles

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/roles` | ── 人格管理 ──────────────────────────────────────────────────── | src/routes/roles-api.mjs:70 |
| GET | `/api/roles/content` | — | src/routes/roles-api.mjs:83 |
| POST | `/api/roles/limit` | — | src/routes/roles-api.mjs:102 |
| POST | `/api/roles/create` | — | src/routes/roles-api.mjs:115 |
| POST | `/api/roles/update` | — | src/routes/roles-api.mjs:126 |
| POST | `/api/roles/rename` | — | src/routes/roles-api.mjs:137 |
| POST | `/api/roles/delete` | — | src/routes/roles-api.mjs:153 |

## api/tokens

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/tokens/summary` | 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险 | src/routes/tokens-api.mjs:13 |
| GET | `/api/tokens/summary` | — | src/routes/tokens-api.mjs:15 |
| GET | `/api/tokens/series` | — | src/routes/tokens-api.mjs:20 |
| GET | `/api/tokens/turns` | — | src/routes/tokens-api.mjs:26 |
| GET | `/api/tokens/recent` | — | src/routes/tokens-api.mjs:34 |
| POST | `/api/tokens/reset` | — | src/routes/tokens-api.mjs:39 |

## api/stickers

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/stickers` | 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库） | src/bridge.js:3112 |
| GET | `/api/stickers` | 管理端表情库接口（控制台） | src/bridge.js:5558 |
| POST | `/api/stickers/sync` | — | src/bridge.js:5572 |
| POST | `/api/stickers/note` | — | src/bridge.js:5581 |
| POST | `/api/stickers/remark` | — | src/bridge.js:5593 |

## api/send

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/send/*` | — | src/bridge.js:3122 |
| ANY | `/api/send/voice` | 避免 AI 借用操作者通道绕过「只能发自己会话」的限制 | src/bridge.js:5140 |
| ANY | `/api/send/group` | ── 统一发送端点（MCP 旧发送工具也走这里） ─────────────────────────── | src/bridge.js:6537 |
| ANY | `/api/send/private` | — | src/bridge.js:6540 |
| ANY | `/api/send/reply` | — | src/bridge.js:6541 |

## api/preset

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/preset/sim-prompt` | ── 仿真提示词（一代 / 二代各自的预设内置提示词）────────────────────── | src/bridge.js:3215 |
| POST | `/api/preset/sim-prompt` | — | src/bridge.js:3233 |
| GET | `/api/preset/sim-prompt/backups` | — | src/bridge.js:3282 |
| POST | `/api/preset/sim-prompt/restore` | — | src/bridge.js:3290 |

## api/social

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/social/state` | — | src/bridge.js:3804 |
| GET | `/api/social` | ── 仿真群友模式（社交引擎）配置 ────────────────────────────────────── | src/bridge.js:3824 |
| POST | `/api/social` | — | src/bridge.js:3836 |
| POST | `/api/social/flush` | — | src/bridge.js:3882 |

## api/memory

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/memory/archive` | 面板页是「摘要」，这里是「原文」——两边分工不同 | src/routes/memory-api.mjs:18 |
| GET | `/api/memory/universe` | 记忆星云：她自己的记忆宇宙（中心是她，延伸成主题星云，星云里是光点） | src/routes/memory-api.mjs:109 |
| GET | `/api/memory/graph` | 纯规则构图（不调模型、不做 embedding），前端负责力导向排版 | src/routes/memory-api.mjs:126 |
| GET | `/api/memory/overview` | 长期记忆本来就是一个人的一生，不是某个群的账 | src/routes/memory-api.mjs:145 |

## (根)

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/` | — | src/bridge.js:3040 |
| GET | `/` | — | src/bridge.js:3130 |

## api/status

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/status` | — | src/bridge.js:3120 |
| GET | `/api/status` | — | src/bridge.js:3139 |

## api/images

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/images/*` | — | src/bridge.js:3123 |
| GET | `/api/images/message` | ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ──────────── | src/bridge.js:6488 |

## api/authorize

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/authorize/read` | — | src/bridge.js:3124 |
| POST | `/api/authorize/read` | — | src/bridge.js:6465 |

## api/whitelist

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/whitelist` | ── 白名单可视化编辑（写 config.json + 热更新内存） ─────────────────── | src/bridge.js:3603 |
| POST | `/api/whitelist` | — | src/bridge.js:3607 |

## api/dsh

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/dsh/model` | ── DSH 模型与思考强度 ───────────────────────────────────────────── | src/bridge.js:3645 |
| POST | `/api/dsh/effort` | — | src/bridge.js:3692 |

## api/security

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/security` | ── 安全拦截通知设置 ──────────────────────────────────────────────── | src/bridge.js:3711 |
| POST | `/api/security` | — | src/bridge.js:3728 |

## api/console

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/console/token` | ── 控制台访问令牌（可手动修改/生成随机） ───────────────────────────── | src/bridge.js:3750 |
| POST | `/api/console/notify-ai` | ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ────────────────── | src/bridge.js:3889 |

## api/role-map

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/role-map` | ── 按会话区分角色：state/role-by-key.json ────────────────────────── | src/routes/roles-api.mjs:20 |
| POST | `/api/role-map` | — | src/routes/roles-api.mjs:24 |

## favicon.ico

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/favicon.ico` | 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉 | src/bridge.js:3009 |

## api/presets

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/presets` | — | src/bridge.js:3173 |

## api/mode

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/mode` | — | src/bridge.js:3182 |

## api/sessions

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/sessions` | ── 会话查看 ──────────────────────────────────────────────────── | src/bridge.js:3579 |

## api/pending

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/pending` | ── 挂起审批 / 提问 ─────────────────────────────────────────────── | src/bridge.js:3588 |

## api/test-send

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/test-send` | ── 测试发送消息（强制走白名单校验） ─────────────────────────────────── | src/bridge.js:3782 |

## api/voice

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/voice/send` | 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少 | src/bridge.js:5130 |

## api/session

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/session/reset` | ── 清除上下文 / 清空工作区 ────────────────────────────────────────── | src/bridge.js:6644 |

## api/workspace

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/workspace/reset` | — | src/bridge.js:6702 |

## api/restart

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/restart` | ── 重启桥接（守护模式下 5 秒后自动拉起） ────────────────────────────── | src/bridge.js:6769 |

## api/role

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/role` | — | src/routes/roles-api.mjs:41 |

## api/role-mode

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/role-mode` | — | src/routes/roles-api.mjs:60 |
