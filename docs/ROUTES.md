# HTTP 接口清单

> 这份文档由 `node scripts/gen-routes-doc.mjs` 从源码自动生成，**不要手改**。
> 改了端点之后重新跑一次，或让 `npm run routes:doc` 帮你更新。

共 **135** 个路由判断，分布在 11 个文件里。

## 按域统计

| 域 | 端点数 | 主要文件 |
| --- | --- | --- |
| `api/socialV2` | 61 | src/bridge.js<br>src/routes/socialv2-control-api.mjs<br>src/routes/socialv2-memory-api.mjs<br>src/routes/socialv2-send-api.mjs<br>src/routes/socialv2-state-api.mjs<br>src/routes/socialv2-tools-api.mjs<br>src/routes/socialv2-wake-slang-api.mjs |
| `api/slang` | 9 | src/bridge.js |
| `api/roles` | 7 | src/routes/roles-api.mjs |
| `api/tokens` | 6 | src/routes/tokens-api.mjs |
| `api/stickers` | 5 | src/bridge.js<br>src/routes/stickers-api.mjs |
| `galaxy` | 4 | src/bridge.js |
| `api/preset` | 4 | src/bridge.js |
| `api/social` | 4 | src/bridge.js |
| `api/send` | 4 | src/bridge.js<br>src/routes/socialv2-send-api.mjs |
| `api/memory` | 4 | src/routes/memory-api.mjs |
| `(根)` | 2 | src/bridge.js |
| `api/whitelist` | 2 | src/bridge.js |
| `api/dsh` | 2 | src/bridge.js |
| `api/security` | 2 | src/bridge.js |
| `api/console` | 2 | src/bridge.js |
| `api/role-map` | 2 | src/routes/roles-api.mjs |
| `favicon.ico` | 1 | src/bridge.js |
| `console.css` | 1 | src/bridge.js |
| `api/status` | 1 | src/bridge.js |
| `api/presets` | 1 | src/bridge.js |
| `api/mode` | 1 | src/bridge.js |
| `api/sessions` | 1 | src/bridge.js |
| `api/pending` | 1 | src/bridge.js |
| `api/test-send` | 1 | src/bridge.js |
| `api/images` | 1 | src/bridge.js |
| `api/session` | 1 | src/bridge.js |
| `api/workspace` | 1 | src/bridge.js |
| `api/restart` | 1 | src/bridge.js |
| `api/role` | 1 | src/routes/roles-api.mjs |
| `api/role-mode` | 1 | src/routes/roles-api.mjs |
| `api/voice` | 1 | src/routes/socialv2-send-api.mjs |

## api/socialV2

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/socialV2/*` | 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝 | src/bridge.js:3307 |
| ANY | `/api/socialV2/*` | 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理） | src/bridge.js:3312 |
| ANY | `/api/socialV2/*` | 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用 | src/bridge.js:3317 |
| ANY | `/api/socialV2/feedback` | — | src/bridge.js:3325 |
| GET | `/api/socialV2/config` | — | src/routes/socialv2-control-api.mjs:27 |
| POST | `/api/socialV2/config` | — | src/routes/socialv2-control-api.mjs:31 |
| GET | `/api/socialV2/activity` | — | src/routes/socialv2-control-api.mjs:197 |
| POST | `/api/socialV2/activity` | — | src/routes/socialv2-control-api.mjs:201 |
| POST | `/api/socialV2/reset` | — | src/routes/socialv2-control-api.mjs:219 |
| POST | `/api/socialV2/mark-read` | — | src/routes/socialv2-control-api.mjs:261 |
| POST | `/api/socialV2/wake-config` | — | src/routes/socialv2-control-api.mjs:300 |
| POST | `/api/socialV2/memory-append` | — | src/routes/socialv2-memory-api.mjs:43 |
| GET | `/api/socialV2/memory-search` | 检索是纯本地 BM25，零 token；只有 AI 主动调用时才产生这两个工具调用的成本 | src/routes/socialv2-memory-api.mjs:71 |
| GET | `/api/socialV2/memory-stats` | — | src/routes/socialv2-memory-api.mjs:120 |
| POST | `/api/socialV2/memory-remember` | — | src/routes/socialv2-memory-api.mjs:143 |
| GET | `/api/socialV2/memory-inspect` | — | src/routes/socialv2-memory-api.mjs:296 |
| GET | `/api/socialV2/memory-profile` | — | src/routes/socialv2-memory-api.mjs:340 |
| POST | `/api/socialV2/memory-update` | — | src/routes/socialv2-memory-api.mjs:366 |
| GET | `/api/socialV2/memory` | — | src/routes/socialv2-memory-api.mjs:419 |
| POST | `/api/socialV2/memory-remove` | — | src/routes/socialv2-memory-api.mjs:445 |
| POST | `/api/socialV2/memory-clear` | — | src/routes/socialv2-memory-api.mjs:471 |
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
| POST | `/api/socialV2/send-sticker` | — | src/routes/socialv2-send-api.mjs:756 |
| POST | `/api/socialV2/collect-sticker` | — | src/routes/socialv2-send-api.mjs:869 |
| ANY | `/api/socialV2/voices` | 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析） | src/routes/socialv2-send-api.mjs:917 |
| GET | `/api/socialV2/sticker-list` | — | src/routes/socialv2-send-api.mjs:962 |
| POST | `/api/socialV2/sticker-list` | — | src/routes/socialv2-send-api.mjs:985 |
| GET | `/api/socialV2/state` | — | src/routes/socialv2-state-api.mjs:69 |
| GET | `/api/socialV2/prompt` | — | src/routes/socialv2-state-api.mjs:110 |
| GET | `/api/socialV2/unread` | — | src/routes/socialv2-state-api.mjs:204 |
| GET | `/api/socialV2/recent` | — | src/routes/socialv2-state-api.mjs:226 |
| GET | `/api/socialV2/states` | — | src/routes/socialv2-state-api.mjs:243 |
| GET | `/api/socialV2/mood` | 未知会话返回默认中性状态（known:false），不会顺手创建会话 | src/routes/socialv2-state-api.mjs:263 |
| GET | `/api/socialV2/mood-history` | 这类发送轨迹只给控制台看：带 agent token 的请求一律拒绝（会话级主体不能读发送历史） | src/routes/socialv2-state-api.mjs:293 |
| GET | `/api/socialV2/moods` | 这是跨会话的全局视图：带 agent token 的请求一律拒绝（会话级主体只能查自己的 /mood） | src/routes/socialv2-state-api.mjs:312 |
| GET | `/api/socialV2/relationship` | 跨会话聚合的全局视图：带 agent token 的请求一律拒绝，防止任意会话 token 读取他人关系 | src/routes/socialv2-state-api.mjs:332 |
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
| GET | `/api/slang` | ── 黑话库管理 ─────────────────────────────────────────────────── | src/bridge.js:3565 |
| POST | `/api/slang` | — | src/bridge.js:3571 |
| POST | `/api/slang/clear` | — | src/bridge.js:3593 |
| POST | `/api/slang/batch-delete` | — | src/bridge.js:3618 |
| POST | `/api/slang/batch-confirm` | — | src/bridge.js:3645 |
| POST | `/api/slang/batch-reject` | — | src/bridge.js:3667 |
| POST | `/api/slang/extract` | — | src/bridge.js:3756 |
| POST | `/api/slang/research` | — | src/bridge.js:3771 |
| POST | `/api/slang/config` | — | src/bridge.js:3783 |

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
| ANY | `/api/stickers` | 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库） | src/bridge.js:3330 |
| GET | `/api/stickers` | 管理端表情库接口（控制台） | src/routes/stickers-api.mjs:15 |
| POST | `/api/stickers/sync` | — | src/routes/stickers-api.mjs:29 |
| POST | `/api/stickers/note` | — | src/routes/stickers-api.mjs:38 |
| POST | `/api/stickers/remark` | — | src/routes/stickers-api.mjs:50 |

## galaxy

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/galaxy/app.css` | 这样 <script src="/galaxy/app.js"> 不需要携带 token；数据接口仍然要求 x-cons | src/bridge.js:3202 |
| GET | `/galaxy/app.js` | — | src/bridge.js:3213 |
| ANY | `/galaxy/` | ── 记忆银河（只读；页面与数据都在全局 Host + consoleToken 闸门之后）── | src/bridge.js:3355 |
| GET | `/galaxy/api/data` | — | src/bridge.js:3370 |

## api/preset

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/preset/sim-prompt` | ── 仿真提示词（一代 / 二代各自的预设内置提示词）────────────────────── | src/bridge.js:3456 |
| POST | `/api/preset/sim-prompt` | — | src/bridge.js:3474 |
| GET | `/api/preset/sim-prompt/backups` | — | src/bridge.js:3523 |
| POST | `/api/preset/sim-prompt/restore` | — | src/bridge.js:3531 |

## api/social

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/social/state` | — | src/bridge.js:4045 |
| GET | `/api/social` | ── 仿真群友模式（社交引擎）配置 ────────────────────────────────────── | src/bridge.js:4065 |
| POST | `/api/social` | — | src/bridge.js:4077 |
| POST | `/api/social/flush` | — | src/bridge.js:4123 |

## api/send

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/api/send/group` | ── 统一发送端点（MCP 旧发送工具也走这里） ─────────────────────────── | src/bridge.js:4349 |
| ANY | `/api/send/private` | — | src/bridge.js:4352 |
| ANY | `/api/send/reply` | — | src/bridge.js:4353 |
| ANY | `/api/send/voice` | 避免 AI 借用操作者通道绕过「只能发自己会话」的限制 | src/routes/socialv2-send-api.mjs:583 |

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
| GET | `/` | — | src/bridge.js:3244 |
| GET | `/` | — | src/bridge.js:3345 |

## api/whitelist

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/whitelist` | ── 白名单可视化编辑（写 config.json + 热更新内存） ─────────────────── | src/bridge.js:3844 |
| POST | `/api/whitelist` | — | src/bridge.js:3848 |

## api/dsh

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/dsh/model` | ── DSH 模型与思考强度 ───────────────────────────────────────────── | src/bridge.js:3886 |
| POST | `/api/dsh/effort` | — | src/bridge.js:3933 |

## api/security

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/security` | ── 安全拦截通知设置 ──────────────────────────────────────────────── | src/bridge.js:3952 |
| POST | `/api/security` | — | src/bridge.js:3969 |

## api/console

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/console/token` | ── 控制台访问令牌（可手动修改/生成随机） ───────────────────────────── | src/bridge.js:3991 |
| POST | `/api/console/notify-ai` | ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ────────────────── | src/bridge.js:4130 |

## api/role-map

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/role-map` | ── 按会话区分角色：state/role-by-key.json ────────────────────────── | src/routes/roles-api.mjs:20 |
| POST | `/api/role-map` | — | src/routes/roles-api.mjs:24 |

## favicon.ico

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| ANY | `/favicon.ico` | 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉 | src/bridge.js:3169 |

## console.css

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/console.css` | 控制台静态 CSS：不含数据，放在 token 闸门前（浏览器 <link> 无法携带 token） | src/bridge.js:3189 |

## api/status

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/status` | — | src/bridge.js:3380 |

## api/presets

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/presets` | — | src/bridge.js:3414 |

## api/mode

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/mode` | — | src/bridge.js:3423 |

## api/sessions

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/sessions` | ── 会话查看 ──────────────────────────────────────────────────── | src/bridge.js:3820 |

## api/pending

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/pending` | ── 挂起审批 / 提问 ─────────────────────────────────────────────── | src/bridge.js:3829 |

## api/test-send

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/test-send` | ── 测试发送消息（强制走白名单校验） ─────────────────────────────────── | src/bridge.js:4023 |

## api/images

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/images/message` | ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ───────────────── | src/bridge.js:4300 |

## api/session

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/session/reset` | ── 清除上下文 / 清空工作区 ────────────────────────────────────────── | src/bridge.js:4456 |

## api/workspace

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/workspace/reset` | — | src/bridge.js:4516 |

## api/restart

| 方法 | 路径 | 说明 | 位置 |
| --- | --- | --- | --- |
| POST | `/api/restart` | ── 重启桥接（守护模式下 5 秒后自动拉起） ────────────────────────────── | src/bridge.js:4583 |

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
