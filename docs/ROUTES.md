# HTTP 接口清单

> 这份文档由 `node scripts/gen-routes-doc.mjs` 从源码自动生成，**不要手改**。
> 改了端点之后重新跑一次，或让 `npm run routes:doc` 帮你更新。

共 **132** 个路由判断，分布在 11 个文件里。

## 按域统计

| 域 | 端点数 | 主要文件 |
| --- | --- | --- |
| `api/socialV2` | 58 | src/bridge.js<br>src/routes/socialv2-control-api.mjs<br>src/routes/socialv2-memory-api.mjs<br>src/routes/socialv2-send-api.mjs<br>src/routes/socialv2-state-api.mjs<br>src/routes/socialv2-tools-api.mjs<br>src/routes/socialv2-wake-slang-api.mjs |
| `api/slang` | 9 | src/bridge.js |
| `api/roles` | 7 | src/routes/roles-api.mjs |
| `api/tokens` | 6 | src/routes/tokens-api.mjs |
| `api/stickers` | 5 | src/bridge.js<br>src/routes/stickers-api.mjs |
| `api/send` | 5 | src/bridge.js<br>src/routes/socialv2-send-api.mjs |
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
| `api/session` | 1 | src/bridge.js |
| `api/workspace` | 1 | src/bridge.js |
| `api/restart` | 1 | src/bridge.js |
| `api/role` | 1 | src/routes/roles-api.mjs |
| `api/role-mode` | 1 | src/routes/roles-api.mjs |
| `api/voice` | 1 | src/routes/socialv2-send-api.mjs |

## api/socialV2

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/socialV2/*` | 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝 | src/bridge.js:3101 |
| ANY | `/api/socialV2/*` | 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理） | src/bridge.js:3106 |
| ANY | `/api/socialV2/*` | 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用 | src/bridge.js:3111 |
| ANY | `/api/socialV2/feedback` | — | src/bridge.js:3117 |
| ANY | `/api/socialV2/*` | — | src/bridge.js:3131 |
| GET | `/api/socialV2/config` | — | src/routes/socialv2-control-api.mjs:27 |
| POST | `/api/socialV2/config` | — | src/routes/socialv2-control-api.mjs:31 |
| GET | `/api/socialV2/activity` | — | src/routes/socialv2-control-api.mjs:197 |
| POST | `/api/socialV2/activity` | — | src/routes/socialv2-control-api.mjs:201 |
| POST | `/api/socialV2/reset` | — | src/routes/socialv2-control-api.mjs:219 |
| POST | `/api/socialV2/mark-read` | — | src/routes/socialv2-control-api.mjs:261 |
| POST | `/api/socialV2/wake-config` | — | src/routes/socialv2-control-api.mjs:300 |
| POST | `/api/socialV2/memory-append` | — | src/routes/socialv2-memory-api.mjs:16 |
| GET | `/api/socialV2/memory-search` | 检索是纯本地 BM25，零 token；只有 AI 主动调用时才产生这两个工具调用的成本 | src/routes/socialv2-memory-api.mjs:44 |
| GET | `/api/socialV2/memory-stats` | — | src/routes/socialv2-memory-api.mjs:68 |
| POST | `/api/socialV2/memory-remember` | — | src/routes/socialv2-memory-api.mjs:77 |
| GET | `/api/socialV2/memory-inspect` | — | src/routes/socialv2-memory-api.mjs:186 |
| GET | `/api/socialV2/memory-profile` | — | src/routes/socialv2-memory-api.mjs:214 |
| POST | `/api/socialV2/memory-update` | — | src/routes/socialv2-memory-api.mjs:222 |
| GET | `/api/socialV2/memory` | — | src/routes/socialv2-memory-api.mjs:275 |
| POST | `/api/socialV2/memory-remove` | — | src/routes/socialv2-memory-api.mjs:301 |
| POST | `/api/socialV2/memory-clear` | — | src/routes/socialv2-memory-api.mjs:327 |
| POST | `/api/socialV2/send-burst` | — | src/routes/socialv2-send-api.mjs:21 |
| POST | `/api/socialV2/send-message` | — | src/routes/socialv2-send-api.mjs:148 |
| POST | `/api/socialV2/send-poke` | — | src/routes/socialv2-send-api.mjs:297 |
| POST | `/api/socialV2/qzone-send` | ── QQ 空间：发说说（仅管理员私聊；默认好友可见） ───────────────────── | src/routes/socialv2-send-api.mjs:394 |
| POST | `/api/socialV2/qzone-list` | ── QQ 空间：看自己发过的说说（她回看自己的时间线） ────────────── | src/routes/socialv2-send-api.mjs:440 |
| GET | `/api/socialV2/sticker-image` | — | src/routes/socialv2-send-api.mjs:481 |
| GET | `/api/socialV2/self-image` | — | src/routes/socialv2-send-api.mjs:516 |
| POST | `/api/socialV2/sticker-note` | — | src/routes/socialv2-send-api.mjs:533 |
| POST | `/api/socialV2/sticker-remark` | — | src/routes/socialv2-send-api.mjs:551 |
| POST | `/api/socialV2/send-voice` | ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ──── | src/routes/socialv2-send-api.mjs:686 |
| POST | `/api/socialV2/send-sticker` | — | src/routes/socialv2-send-api.mjs:751 |
| POST | `/api/socialV2/collect-sticker` | — | src/routes/socialv2-send-api.mjs:857 |
| ANY | `/api/socialV2/voices` | 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析） | src/routes/socialv2-send-api.mjs:905 |
| GET | `/api/socialV2/sticker-list` | — | src/routes/socialv2-send-api.mjs:950 |
| POST | `/api/socialV2/sticker-list` | — | src/routes/socialv2-send-api.mjs:973 |
| GET | `/api/socialV2/state` | — | src/routes/socialv2-state-api.mjs:17 |
| GET | `/api/socialV2/prompt` | — | src/routes/socialv2-state-api.mjs:36 |
| GET | `/api/socialV2/unread` | — | src/routes/socialv2-state-api.mjs:130 |
| GET | `/api/socialV2/recent` | — | src/routes/socialv2-state-api.mjs:152 |
| GET | `/api/socialV2/states` | — | src/routes/socialv2-state-api.mjs:169 |
| GET | `/api/socialV2/tool-log` | ── 工具调用日志 ────────────────────────────────────────────────── | src/routes/socialv2-tools-api.mjs:17 |
| POST | `/api/socialV2/tool-log/clear` | — | src/routes/socialv2-tools-api.mjs:22 |
| GET | `/api/socialV2/feedback` | ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ──────────────────────────── | src/routes/socialv2-tools-api.mjs:30 |
| POST | `/api/socialV2/feedback-clear` | — | src/routes/socialv2-tools-api.mjs:34 |
| POST | `/api/socialV2/feedback` | — | src/routes/socialv2-tools-api.mjs:41 |
| GET | `/api/socialV2/my-recent` | — | src/routes/socialv2-tools-api.mjs:72 |
| POST | `/api/socialV2/record-sent` | — | src/routes/socialv2-tools-api.mjs:84 |
| GET | `/api/socialV2/message-detail` | — | src/routes/socialv2-tools-api.mjs:89 |
| GET | `/api/socialV2/forward-message` | ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ──────────── | src/routes/socialv2-tools-api.mjs:140 |
| POST | `/api/socialV2/forward-media` | — | src/routes/socialv2-tools-api.mjs:232 |
| GET | `/api/socialV2/active-members` | — | src/routes/socialv2-tools-api.mjs:251 |
| POST | `/api/socialV2/wake` | — | src/routes/socialv2-wake-slang-api.mjs:14 |
| POST | `/api/socialV2/wait` | — | src/routes/socialv2-wake-slang-api.mjs:45 |
| POST | `/api/socialV2/check-send` | — | src/routes/socialv2-wake-slang-api.mjs:239 |
| GET | `/api/socialV2/slang/query` | — | src/routes/socialv2-wake-slang-api.mjs:270 |
| POST | `/api/socialV2/slang/submit` | — | src/routes/socialv2-wake-slang-api.mjs:293 |

## api/slang

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/slang` | ── 黑话库管理 ─────────────────────────────────────────────────── | src/bridge.js:3334 |
| POST | `/api/slang` | — | src/bridge.js:3340 |
| POST | `/api/slang/clear` | — | src/bridge.js:3362 |
| POST | `/api/slang/batch-delete` | — | src/bridge.js:3387 |
| POST | `/api/slang/batch-confirm` | — | src/bridge.js:3414 |
| POST | `/api/slang/batch-reject` | — | src/bridge.js:3436 |
| POST | `/api/slang/extract` | — | src/bridge.js:3525 |
| POST | `/api/slang/research` | — | src/bridge.js:3540 |
| POST | `/api/slang/config` | — | src/bridge.js:3552 |

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
| ANY | `/api/stickers` | 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库） | src/bridge.js:3122 |
| GET | `/api/stickers` | 管理端表情库接口（控制台） | src/routes/stickers-api.mjs:15 |
| POST | `/api/stickers/sync` | — | src/routes/stickers-api.mjs:29 |
| POST | `/api/stickers/note` | — | src/routes/stickers-api.mjs:38 |
| POST | `/api/stickers/remark` | — | src/routes/stickers-api.mjs:50 |

## api/send

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/send/*` | — | src/bridge.js:3132 |
| ANY | `/api/send/group` | ── 统一发送端点（MCP 旧发送工具也走这里） ─────────────────────────── | src/bridge.js:4133 |
| ANY | `/api/send/private` | — | src/bridge.js:4136 |
| ANY | `/api/send/reply` | — | src/bridge.js:4137 |
| ANY | `/api/send/voice` | 避免 AI 借用操作者通道绕过「只能发自己会话」的限制 | src/routes/socialv2-send-api.mjs:583 |

## api/preset

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/preset/sim-prompt` | ── 仿真提示词（一代 / 二代各自的预设内置提示词）────────────────────── | src/bridge.js:3225 |
| POST | `/api/preset/sim-prompt` | — | src/bridge.js:3243 |
| GET | `/api/preset/sim-prompt/backups` | — | src/bridge.js:3292 |
| POST | `/api/preset/sim-prompt/restore` | — | src/bridge.js:3300 |

## api/social

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/social/state` | — | src/bridge.js:3814 |
| GET | `/api/social` | ── 仿真群友模式（社交引擎）配置 ────────────────────────────────────── | src/bridge.js:3834 |
| POST | `/api/social` | — | src/bridge.js:3846 |
| POST | `/api/social/flush` | — | src/bridge.js:3892 |

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
| GET | `/` | — | src/bridge.js:3050 |
| GET | `/` | — | src/bridge.js:3140 |

## api/status

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/status` | — | src/bridge.js:3130 |
| GET | `/api/status` | — | src/bridge.js:3149 |

## api/images

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/images/*` | — | src/bridge.js:3133 |
| GET | `/api/images/message` | ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ──────────── | src/bridge.js:4084 |

## api/authorize

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/authorize/read` | — | src/bridge.js:3134 |
| POST | `/api/authorize/read` | ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ───────────────── | src/bridge.js:4061 |

## api/whitelist

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/whitelist` | ── 白名单可视化编辑（写 config.json + 热更新内存） ─────────────────── | src/bridge.js:3613 |
| POST | `/api/whitelist` | — | src/bridge.js:3617 |

## api/dsh

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/dsh/model` | ── DSH 模型与思考强度 ───────────────────────────────────────────── | src/bridge.js:3655 |
| POST | `/api/dsh/effort` | — | src/bridge.js:3702 |

## api/security

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/security` | ── 安全拦截通知设置 ──────────────────────────────────────────────── | src/bridge.js:3721 |
| POST | `/api/security` | — | src/bridge.js:3738 |

## api/console

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/console/token` | ── 控制台访问令牌（可手动修改/生成随机） ───────────────────────────── | src/bridge.js:3760 |
| POST | `/api/console/notify-ai` | ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ────────────────── | src/bridge.js:3899 |

## api/role-map

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/role-map` | ── 按会话区分角色：state/role-by-key.json ────────────────────────── | src/routes/roles-api.mjs:20 |
| POST | `/api/role-map` | — | src/routes/roles-api.mjs:24 |

## favicon.ico

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/favicon.ico` | 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉 | src/bridge.js:3019 |

## api/presets

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/presets` | — | src/bridge.js:3183 |

## api/mode

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/mode` | — | src/bridge.js:3192 |

## api/sessions

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/sessions` | ── 会话查看 ──────────────────────────────────────────────────── | src/bridge.js:3589 |

## api/pending

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/pending` | ── 挂起审批 / 提问 ─────────────────────────────────────────────── | src/bridge.js:3598 |

## api/test-send

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/test-send` | ── 测试发送消息（强制走白名单校验） ─────────────────────────────────── | src/bridge.js:3792 |

## api/session

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/session/reset` | ── 清除上下文 / 清空工作区 ────────────────────────────────────────── | src/bridge.js:4240 |

## api/workspace

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/workspace/reset` | — | src/bridge.js:4298 |

## api/restart

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/restart` | ── 重启桥接（守护模式下 5 秒后自动拉起） ────────────────────────────── | src/bridge.js:4365 |

## api/role

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/role` | — | src/routes/roles-api.mjs:41 |

## api/role-mode

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/role-mode` | — | src/routes/roles-api.mjs:60 |

## api/voice

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/voice/send` | 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少 | src/routes/socialv2-send-api.mjs:573 |
