# HTTP 接口清单

> 这份文档由 `node scripts/gen-routes-doc.mjs` 从源码自动生成，**不要手改**。
> 改了端点之后重新跑一次，或让 `npm run routes:doc` 帮你更新。

共 **132** 个路由判断，分布在 2 个文件里。

## 按域统计

| 域 | 端点数 | 主要文件 |
| --- | --- | --- |
| `api/socialV2` | 58 | src/bridge.js |
| `api/slang` | 9 | src/bridge.js |
| `api/roles` | 7 | src/bridge.js |
| `api/tokens` | 6 | src/bridge.js |
| `api/stickers` | 5 | src/bridge.js |
| `api/send` | 5 | src/bridge.js |
| `api/preset` | 4 | src/bridge.js |
| `api/social` | 4 | src/bridge.js |
| `api/memory` | 4 | src/routes/memory-api.mjs |
| `(根)` | 2 | src/bridge.js |
| `api/status` | 2 | src/bridge.js |
| `api/images` | 2 | src/bridge.js |
| `api/authorize` | 2 | src/bridge.js |
| `api/role-map` | 2 | src/bridge.js |
| `api/whitelist` | 2 | src/bridge.js |
| `api/dsh` | 2 | src/bridge.js |
| `api/security` | 2 | src/bridge.js |
| `api/console` | 2 | src/bridge.js |
| `favicon.ico` | 1 | src/bridge.js |
| `api/presets` | 1 | src/bridge.js |
| `api/mode` | 1 | src/bridge.js |
| `api/role` | 1 | src/bridge.js |
| `api/role-mode` | 1 | src/bridge.js |
| `api/sessions` | 1 | src/bridge.js |
| `api/pending` | 1 | src/bridge.js |
| `api/test-send` | 1 | src/bridge.js |
| `api/voice` | 1 | src/bridge.js |
| `api/session` | 1 | src/bridge.js |
| `api/workspace` | 1 | src/bridge.js |
| `api/restart` | 1 | src/bridge.js |

## api/socialV2

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/socialV2/*` | 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝 | src/bridge.js:3089 |
| ANY | `/api/socialV2/*` | 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理） | src/bridge.js:3094 |
| ANY | `/api/socialV2/*` | 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用 | src/bridge.js:3099 |
| ANY | `/api/socialV2/feedback` | — | src/bridge.js:3105 |
| ANY | `/api/socialV2/*` | — | src/bridge.js:3119 |
| GET | `/api/socialV2/config` | ── 二代仿真模式（reserved2）内部 Agent API ───────────────────────── | src/bridge.js:4099 |
| POST | `/api/socialV2/config` | — | src/bridge.js:4103 |
| GET | `/api/socialV2/activity` | — | src/bridge.js:4269 |
| POST | `/api/socialV2/activity` | — | src/bridge.js:4273 |
| POST | `/api/socialV2/reset` | — | src/bridge.js:4291 |
| GET | `/api/socialV2/state` | — | src/bridge.js:4332 |
| GET | `/api/socialV2/prompt` | — | src/bridge.js:4351 |
| GET | `/api/socialV2/unread` | — | src/bridge.js:4445 |
| GET | `/api/socialV2/recent` | — | src/bridge.js:4467 |
| POST | `/api/socialV2/mark-read` | — | src/bridge.js:4483 |
| POST | `/api/socialV2/wake-config` | — | src/bridge.js:4522 |
| GET | `/api/socialV2/states` | — | src/bridge.js:4667 |
| POST | `/api/socialV2/wake` | — | src/bridge.js:4683 |
| POST | `/api/socialV2/send-burst` | — | src/bridge.js:4713 |
| POST | `/api/socialV2/send-message` | — | src/bridge.js:4838 |
| POST | `/api/socialV2/send-poke` | — | src/bridge.js:4987 |
| POST | `/api/socialV2/qzone-send` | ── QQ 空间：发说说（仅管理员私聊；默认好友可见） ───────────────────── | src/bridge.js:5084 |
| POST | `/api/socialV2/qzone-list` | ── QQ 空间：看自己发过的说说（她回看自己的时间线） ────────────── | src/bridge.js:5130 |
| GET | `/api/socialV2/sticker-image` | — | src/bridge.js:5171 |
| GET | `/api/socialV2/self-image` | — | src/bridge.js:5206 |
| POST | `/api/socialV2/sticker-note` | — | src/bridge.js:5223 |
| POST | `/api/socialV2/sticker-remark` | — | src/bridge.js:5241 |
| POST | `/api/socialV2/send-voice` | ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ──── | src/bridge.js:5376 |
| POST | `/api/socialV2/send-sticker` | — | src/bridge.js:5441 |
| POST | `/api/socialV2/collect-sticker` | — | src/bridge.js:5547 |
| ANY | `/api/socialV2/voices` | 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析） | src/bridge.js:5595 |
| GET | `/api/socialV2/sticker-list` | — | src/bridge.js:5640 |
| POST | `/api/socialV2/sticker-list` | — | src/bridge.js:5663 |
| POST | `/api/socialV2/wait` | — | src/bridge.js:5738 |
| POST | `/api/socialV2/check-send` | — | src/bridge.js:5932 |
| GET | `/api/socialV2/tool-log` | ── 工具调用日志 ────────────────────────────────────────────────── | src/bridge.js:6002 |
| POST | `/api/socialV2/tool-log/clear` | — | src/bridge.js:6007 |
| GET | `/api/socialV2/feedback` | ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ──────────────────────────── | src/bridge.js:6015 |
| POST | `/api/socialV2/feedback-clear` | — | src/bridge.js:6019 |
| POST | `/api/socialV2/feedback` | — | src/bridge.js:6026 |
| GET | `/api/socialV2/my-recent` | — | src/bridge.js:6057 |
| POST | `/api/socialV2/record-sent` | — | src/bridge.js:6069 |
| GET | `/api/socialV2/message-detail` | — | src/bridge.js:6074 |
| GET | `/api/socialV2/forward-message` | ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ──────────── | src/bridge.js:6125 |
| POST | `/api/socialV2/forward-media` | — | src/bridge.js:6217 |
| GET | `/api/socialV2/active-members` | — | src/bridge.js:6236 |
| POST | `/api/socialV2/memory-append` | — | src/bridge.js:6260 |
| GET | `/api/socialV2/memory-search` | 检索是纯本地 BM25，零 token；只有 AI 主动调用时才产生这两个工具调用的成本 | src/bridge.js:6288 |
| GET | `/api/socialV2/memory-stats` | — | src/bridge.js:6311 |
| POST | `/api/socialV2/memory-remember` | — | src/bridge.js:6320 |
| GET | `/api/socialV2/memory-inspect` | — | src/bridge.js:6396 |
| GET | `/api/socialV2/memory-profile` | — | src/bridge.js:6424 |
| POST | `/api/socialV2/memory-update` | — | src/bridge.js:6432 |
| GET | `/api/socialV2/memory` | — | src/bridge.js:6485 |
| POST | `/api/socialV2/memory-remove` | — | src/bridge.js:6511 |
| POST | `/api/socialV2/memory-clear` | — | src/bridge.js:6537 |
| GET | `/api/socialV2/slang/query` | ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ───────────────── | src/bridge.js:6555 |
| POST | `/api/socialV2/slang/submit` | — | src/bridge.js:6578 |

## api/slang

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/slang` | ── 黑话库管理 ─────────────────────────────────────────────────── | src/bridge.js:3457 |
| POST | `/api/slang` | — | src/bridge.js:3463 |
| POST | `/api/slang/clear` | — | src/bridge.js:3485 |
| POST | `/api/slang/batch-delete` | — | src/bridge.js:3510 |
| POST | `/api/slang/batch-confirm` | — | src/bridge.js:3537 |
| POST | `/api/slang/batch-reject` | — | src/bridge.js:3559 |
| POST | `/api/slang/extract` | — | src/bridge.js:3648 |
| POST | `/api/slang/research` | — | src/bridge.js:3663 |
| POST | `/api/slang/config` | — | src/bridge.js:3675 |

## api/roles

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/roles` | ── 人格管理 ──────────────────────────────────────────────────── | src/bridge.js:3250 |
| GET | `/api/roles/content` | — | src/bridge.js:3263 |
| POST | `/api/roles/limit` | — | src/bridge.js:3282 |
| POST | `/api/roles/create` | — | src/bridge.js:3295 |
| POST | `/api/roles/update` | — | src/bridge.js:3306 |
| POST | `/api/roles/rename` | — | src/bridge.js:3317 |
| POST | `/api/roles/delete` | — | src/bridge.js:3333 |

## api/tokens

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/tokens/summary` | 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险 | src/bridge.js:5966 |
| GET | `/api/tokens/summary` | — | src/bridge.js:5968 |
| GET | `/api/tokens/series` | — | src/bridge.js:5973 |
| GET | `/api/tokens/turns` | — | src/bridge.js:5979 |
| GET | `/api/tokens/recent` | — | src/bridge.js:5987 |
| POST | `/api/tokens/reset` | — | src/bridge.js:5992 |

## api/stickers

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/stickers` | 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库） | src/bridge.js:3110 |
| GET | `/api/stickers` | 管理端表情库接口（控制台） | src/bridge.js:5691 |
| POST | `/api/stickers/sync` | — | src/bridge.js:5705 |
| POST | `/api/stickers/note` | — | src/bridge.js:5714 |
| POST | `/api/stickers/remark` | — | src/bridge.js:5726 |

## api/send

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/send/*` | — | src/bridge.js:3120 |
| ANY | `/api/send/voice` | 避免 AI 借用操作者通道绕过「只能发自己会话」的限制 | src/bridge.js:5273 |
| ANY | `/api/send/group` | ── 统一发送端点（MCP 旧发送工具也走这里） ─────────────────────────── | src/bridge.js:6707 |
| ANY | `/api/send/private` | — | src/bridge.js:6710 |
| ANY | `/api/send/reply` | — | src/bridge.js:6711 |

## api/preset

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/preset/sim-prompt` | ── 仿真提示词（一代 / 二代各自的预设内置提示词）────────────────────── | src/bridge.js:3348 |
| POST | `/api/preset/sim-prompt` | — | src/bridge.js:3366 |
| GET | `/api/preset/sim-prompt/backups` | — | src/bridge.js:3415 |
| POST | `/api/preset/sim-prompt/restore` | — | src/bridge.js:3423 |

## api/social

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/social/state` | — | src/bridge.js:3937 |
| GET | `/api/social` | ── 仿真群友模式（社交引擎）配置 ────────────────────────────────────── | src/bridge.js:3957 |
| POST | `/api/social` | — | src/bridge.js:3969 |
| POST | `/api/social/flush` | — | src/bridge.js:4015 |

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
| GET | `/` | — | src/bridge.js:3038 |
| GET | `/` | — | src/bridge.js:3128 |

## api/status

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/status` | — | src/bridge.js:3118 |
| GET | `/api/status` | — | src/bridge.js:3137 |

## api/images

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/images/*` | — | src/bridge.js:3121 |
| GET | `/api/images/message` | ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ──────────── | src/bridge.js:6658 |

## api/authorize

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/authorize/read` | — | src/bridge.js:3122 |
| POST | `/api/authorize/read` | — | src/bridge.js:6635 |

## api/role-map

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/role-map` | ── 按会话区分角色：state/role-by-key.json ────────────────────────── | src/bridge.js:3200 |
| POST | `/api/role-map` | — | src/bridge.js:3204 |

## api/whitelist

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/whitelist` | ── 白名单可视化编辑（写 config.json + 热更新内存） ─────────────────── | src/bridge.js:3736 |
| POST | `/api/whitelist` | — | src/bridge.js:3740 |

## api/dsh

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/dsh/model` | ── DSH 模型与思考强度 ───────────────────────────────────────────── | src/bridge.js:3778 |
| POST | `/api/dsh/effort` | — | src/bridge.js:3825 |

## api/security

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/security` | ── 安全拦截通知设置 ──────────────────────────────────────────────── | src/bridge.js:3844 |
| POST | `/api/security` | — | src/bridge.js:3861 |

## api/console

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/console/token` | ── 控制台访问令牌（可手动修改/生成随机） ───────────────────────────── | src/bridge.js:3883 |
| POST | `/api/console/notify-ai` | ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ────────────────── | src/bridge.js:4022 |

## favicon.ico

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/favicon.ico` | 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉 | src/bridge.js:3007 |

## api/presets

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/presets` | — | src/bridge.js:3171 |

## api/mode

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/mode` | — | src/bridge.js:3180 |

## api/role

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/role` | — | src/bridge.js:3221 |

## api/role-mode

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/role-mode` | — | src/bridge.js:3240 |

## api/sessions

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/sessions` | ── 会话查看 ──────────────────────────────────────────────────── | src/bridge.js:3712 |

## api/pending

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/pending` | ── 挂起审批 / 提问 ─────────────────────────────────────────────── | src/bridge.js:3721 |

## api/test-send

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/test-send` | ── 测试发送消息（强制走白名单校验） ─────────────────────────────────── | src/bridge.js:3915 |

## api/voice

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/voice/send` | 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少 | src/bridge.js:5263 |

## api/session

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/session/reset` | ── 清除上下文 / 清空工作区 ────────────────────────────────────────── | src/bridge.js:6814 |

## api/workspace

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/workspace/reset` | — | src/bridge.js:6872 |

## api/restart

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/restart` | ── 重启桥接（守护模式下 5 秒后自动拉起） ────────────────────────────── | src/bridge.js:6939 |
