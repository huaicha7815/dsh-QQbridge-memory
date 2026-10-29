# socialV2 拆分设计（V5.0 规划）

> 目标：把「她什么时候该说话、怎么调度、状态存哪」从 1.15 万行的 `bridge.js` 里拆出来，
> 分三步做，每步可独立回滚、独立验证。
>
> 状态：**Step 1 已完成、Step 2 纯函数部分已完成**（2026-10-29）。进度见第 10 节「实施记录」。

---

## 1. 为什么做

### 1.1 现状数据

| 项 | 数值 |
| --- | --- |
| `bridge.js` 总行数 | 11537 |
| 函数总数 | 203 |
| socialV2 相关端点 | **54 个**（另有 4 个 `startsWith` 前缀路由） |
| 会话状态字段 | **24 个**（含 5 个定时器句柄） |
| `getSocialV2State` 被调用 | **51 次** |
| `saveSocialV2State` 被调用 | **49 次** |
| 唤醒调度相关函数 | 17 个 |
| 状态落盘 | `state/social-v2.json` |

### 1.2 三个真实痛点（都是踩过的）

1. **状态和调度混在一起，出问题只能靠猜。**
   「她明明该说话却不说话」这类 bug，要同时看：唤醒配置、定时器、未读水位、
   睡眠窗口、会话繁忙标记。这些分别散在 `getSocialV2State` 的 24 个字段、
   17 个唤醒函数、以及 `bridge.js` 十几个位置里，**没有任何一个地方能一眼看全**。

2. **状态机没有边界，测不了。**
   现在只能「启动整个桥接 + 在群里实测」来验证唤醒行为，慢且危险。
   拆出纯函数之后，可以给定「状态 + 事件」直接断言「该不该唤醒、优先级多少」。

3. **开源后别人最想改的就是这块，也最不敢碰。**
   仿真行为（唤醒策略、说话频率）是这类项目的核心吸引力；
   但改它的门槛是「读懂 1.15 万行里的隐式耦合」，等于劝退。

### 1.3 不做的代价

不会报错，只会持续付出：每次调唤醒策略都要重新理解一遍全局状态；
每次出 bug 都要重新定位；外部贡献基本为零。

---

## 2. 现状盘点

### 2.1 会话状态（`getSocialV2State`，L7842）

新建会话时的 24 个字段，按职责可分四类：

```js
{
  // ① 唤醒配置（对外可见，控制台会改）
  wakeConfig,                    // mode / infinite / sleepUntil / triggers{...}
  // ② 对话内容（记忆与上下文）
  recentMessages, unread, activeTopics, pendingThoughts, memberImpressions,
  lastUnreadSeq, lastReadThroughSeq, modelSeenSeqs,
  // ③ 节奏与限流（她自己的行为历史）
  wakeTimes, sendTimes, stickerCollectTimes,
  lastWakeReason, lastAiReplyAt, lastActionAt, lastIncomingAt,
  preSleepWaitSatisfiedAt, preSleepWaitObservedAt, preSleepWaitAccumMs,
  // ④ 运行时句柄（不能落盘）
  agentToken, bootstrapSent,
  pendingWakeTimer, sleepTimer, replyCheckTimer, proactiveTimer,
}
```

**拆分的关键约束**：④ 类字段是 `setTimeout` 句柄，**永远不能进 `state/social-v2.json`**；
② 类里的 `modelSeenSeqs` 是 `Set`，③ 类里的数组是有界缓存——序列化/反序列化规则各自不同。

### 2.2 唤醒链路（17 个函数，按数据流排）

```
收消息 ──> appendSocialV2Message ──> evaluateWakeTriggerV2（该不该理）
                                        │
                                        ├─ computeWakeSafetyV2（安全阀：频率/静默）
                                        ├─ ensureWakeableV2（能不能叫醒）
                                        └─ wakePriorityV2（谁先）
                                              │
                                    scheduleWakeV2（排定时器）
                                              │
                                    sendWakePromptV2（组装提示词并交给 DSH）
                                       └─ buildWakeSnapshotV2 + buildWakePromptV2
```

### 2.3 端点（54 个，按功能收敛到 5 组）

| 组 | 典型路径 | 数量级 |
| --- | --- | --- |
| 状态读取 | `/state` `/prompt` `/unread` `/recent` `/activity` | ~10 |
| 状态写入 | `/config` `/mark-read` `/reset` | ~6 |
| 唤醒操作 | `/wait` `/poke` `/wake` 等 | ~10 |
| 工具侧（AI 自己调） | `/tool-log` `/sticker-list` `/slang/*` `/feedback` | ~15 |
| 诊断/统计 | `/memory-stats` `/usage` 等 | ~10 |

---

## 3. 目标架构

```
src/core/socialv2-store.mjs      ← 状态定义 + 读写 + 序列化 + 迁移 + 清理
src/core/socialv2-wake.mjs       ← 唤醒判定 + 优先级 + 提示词组装（纯逻辑）
src/routes/socialv2-api.mjs      ← 54 个管理端点（纯搬运）
bridge.js                        ← 只留编排：收消息 → 存 → 判唤醒 → 发
```

**依赖方向（严格单向，不允许反向 import）**：

```
bridge.js ──> routes/socialv2-api.mjs ──> core/socialv2-wake.mjs ──> core/socialv2-store.mjs
     └───────────────────────────────────────────────────────────────> core/socialv2-store.mjs
```

`core/` 里两个模块**不 import bridge**，全部靠参数注入——和已经拆出去的
`routes/*.mjs` 是同一套约定。

---

## 4. 三步实施

### Step 1：状态存储（0.5 ~ 1 天，低风险）

**迁出清单**

| 现在的位置 | 迁到 | 说明 |
| --- | --- | --- |
| `getSocialV2State` L7842 | `socialv2-store.mjs` | 含 key 规范化 |
| `loadSocialV2State` L7888 | 同上 | 迁移旧格式 |
| `saveSocialV2State` L8009 | 同上 | 原子写 + 有界裁剪 |
| `clearSocialV2Timers` L10293 | 同上 | 只清句柄，不动数据 |
| `clearAllSocialV2Timers` L10320 | 同上 | |
| `canonicalV2Key` / `normalizeSpeakerIdsV2` / `defaultWakeConfigV2` | 同上 | 纯函数 |

**接口契约**

```js
export function createSocialV2Store({ stateFile, config, now = Date.now }) {
  return {
    get(key),                        // 自动建缺省状态，返回同一引用
    keys(),
    has(key),
    save(),                          // 原子写盘（去掉运行时句柄）
    load(),                          // 启动时读盘 + 迁移
    clearTimers(key), clearAllTimers(),
    setPaused(v), isPaused(),
    stats(),                         // 给控制台/诊断用
    // 序列化边界：Timers/Set 不落盘，读回时重建
    _serialize(st), _deserialize(raw),
  };
}
```

**关键设计点**

- **序列化白名单**：明确列出「哪些字段落盘」，新增字段必须显式加入，避免把 `setTimeout` 句柄写进 JSON。
- `modelSeenSeqs`（Set）↔ 数组互转，读回时设上限（沿用现有 `recentLimit`）。
- `agentToken` 落盘（现有行为，控制台要用），但**不进日志**。

**验收标准**

- [ ] 单测：key 规范化（`group:0123` → `group:123`）
- [ ] 单测：默认状态字段齐全，且不含任何定时器句柄
- [ ] 单测：`save()` → 读文件 → `load()` round-trip 后数据一致
- [ ] 单测：旧格式 `state/social-v2.json` 能迁移（字段缺失/多余都不崩）
- [ ] 单测：`clearTimers` 只清句柄，不清 `wakeTimes` 等行为数据
- [ ] 现有 `test-v2-wait.mjs` / `test-mux-reconnect.mjs` 全过

**回滚**：这一版不动任何调用点，只把函数搬到新模块并在 bridge 里 re-export。
出问题把 import 改回本地定义即可。

---

### Step 2：唤醒调度（1 ~ 1.5 天，中风险）

**迁出清单**

```
evaluateWakeTriggerV2      L9600   ← 该不该理
buildWakeSnapshotV2        L9691   ← 喂给模型的上下文快照
buildWakePromptV2          L9772   ← 提示词组装
buildWakeReminderPromptV2  L9895
wakePriorityV2             L10085
isTimeBasedWakeV2          L10098
scheduleWakeV2             L10102  ← 定时器（注入 setTimeout/clearTimeout）
computeWakeSafetyV2        L7803
ensureWakeableV2           L7818
```

**需要注入的依赖**（必须逐个显式列出，不允许隐式读全局）

| 依赖 | 用途 |
| --- | --- |
| `store` | Step 1 的实例 |
| `getNow` | 可注入的时间源（测试里冻结时间） |
| `setTimer/clearTimer` | 可注入的定时器（测试里用假时钟） |
| `config` | 频率上限、静默阈值 |
| `random` | 概率唤醒（测试里固定 seed） |
| `persona` / `roleState` | 提示词里的人格与称呼 |
| `buildInjection` | 记忆注入（已有纯函数） |
| `memoryStore.search` | 检索命中 |
| `sendWakePrompt` | 真正把消息交给 DSH（**留 bridge**，本步只回调） |

**关键设计点**

- **纯函数优先**：`evaluateWakeTriggerV2` / `computeWakeSafetyV2` / `wakePriorityV2`
  改成「输入状态 + 事件 + 时间，输出决策对象」，不碰定时器、不写状态。
- **副作用集中到一处**：只有 `scheduleWakeV2` 和 `sendWakePrompt` 有副作用，
  其余全是纯函数——这是可测性的来源。
- **随机性可注入**：概率唤醒（`triggers.probability`）必须能给定 seed，否则测试无法稳定。

**验收标准**

- [ ] 单测：@提及 / 叫名字 / 关键词 / 指定群友 / 拍一拍 / 概率 —— 六种触发条件各自命中与否
- [ ] 单测：静默窗口内即使被 @ 也不唤醒（`computeWakeSafetyV2` 安全阀）
- [ ] 单测：优先级排序（同一批消息里谁先被理）
- [ ] 单测：睡眠中收到消息 → 不立即唤醒，记账到 `preSleepWait*`
- [ ] e2e：真实会话里发一条消息，她按预期唤醒并回复（复用 `test-v2-wait.mjs`）
- [ ] 回归：现有 `test-reply-wait.mjs` / `test-v2-wait.mjs` 全过

**回滚**：`scheduleWakeV2` 保留 bridge 里的旧实现作为 fallback 开关
（`config.socialV2.wake.useLegacy = true`），出问题一键切回。

---

### Step 3：端点搬迁（0.5 ~ 1 天，低风险）

纯机械搬运，按功能分四个文件：

```
src/routes/socialv2-state-api.mjs    ← 状态读取 / 配置 / mark-read / reset
src/routes/socialv2-wake-api.mjs     ← 唤醒操作（wait / poke / wake 等）
src/routes/socialv2-tools-api.mjs    ← AI 工具侧（tool-log / sticker-list / slang / feedback）
src/routes/socialv2-stats-api.mjs    ← 诊断与统计
```

**约定**（沿用已拆的 4 个域）：依赖注入、返回 `true`/`false`、`let` 状态用 getter。

**验收标准**

- [ ] 每搬一个文件，重启后实测该组端点，再跑 `npm run test:daily`
- [ ] `npm run routes:doc` 重新生成，确认端点数量一致（54 个不增不减）
- [ ] `docs/ROUTES.md` 里 `api/socialV2` 的归属文件从 bridge.js 变成 4 个模块

---

## 5. 风险与对策

| 风险 | 可能性 | 影响 | 对策 |
| --- | --- | --- | --- |
| 拆分后唤醒行为变了（少说话/多说话） | 中 | 高 | Step 2 保留 legacy 开关；单测覆盖六种触发条件；e2e 实测 |
| 定时器句柄被写进 JSON | 中 | 高 | 序列化白名单 + 单测断言「落盘内容不含 Timer」 |
| 状态迁移把旧数据弄坏 | 低 | 高 | 迁移前自动备份 `social-v2.json.bak-<ts>`；迁移幂等 |
| 拆到一半两边分叉 | 中 | 中 | 每步单独提交、单独验证；不进大功能改动 |
| 贡献者看不懂新边界 | 低 | 低 | 每个模块头部写清「这里负责什么/不负责什么」 |

---

## 6. 测试策略

**新增测试文件**

| 文件 | 覆盖 | 类型 |
| --- | --- | --- |
| `scripts/test-socialv2-store.mjs` | Step 1 全部 | 纯单测 |
| `scripts/test-socialv2-wake.mjs` | 六种触发 / 安全阀 / 优先级 / 睡眠 | 纯单测（假时钟 + 固定 seed） |

**已有测试要全过**：`test-v2-wait.mjs`、`test-reply-wait.mjs`、`test-mux-reconnect.mjs`、
`test-token-economy.mjs`（涉及唤醒后的 token 记账）。

**每日自检要加一项**：把 `test-socialv2-*.mjs` 加进 `scripts/test-daily.mjs` 的套件
（它们不碰真实配置，符合每日自检的准入条件）。

---

## 7. 整体验收标准

- [ ] `bridge.js` 降到 **9000 行以下**
- [ ] `core/socialv2-store.mjs` 与 `core/socialv2-wake.mjs` 都能被单独 import 测试（不启动 bridge）
- [ ] 六种唤醒触发条件有单测；e2e 在真实会话里验证过至少 2 轮
- [ ] `state/social-v2.json` 迁移后与迁移前语义一致（字段逐一比对）
- [ ] `test-daily` 全过且已包含新单测
- [ ] 控制台「二代仿真」面板所有功能正常（配置读写、等待、暂停、状态查看）

---

## 8. 不做的事

1. **不重写唤醒策略**。这次只搬家和纯函数化，**行为必须逐字节一致**；
   任何策略调整另开一轮，不要混在重构里。
2. **不动 DSH 交互协议**。`sendWakePromptV2` 只是搬位置，签名不变。
3. **不动 `state/social-v2.json` 的字段语义**。新增字段可以，已有字段不改名、不改类型。
4. **不顺便优化性能**。重构的目标是可读/可测，不是快；混在一起无法判断谁带来了变化。
5. **不在有密集功能开发的时期做**。它和功能迭代同时进行时，冲突成本高于收益。

---

## 9. 时间与顺序建议

| 步骤 | 估算 | 建议时机 |
| --- | --- | --- |
| Step 1 状态存储 | 0.5~1 天 | 随时（风险最低，收益立现：可单测状态） |
| Step 2 唤醒调度 | 1~1.5 天 | 一段没有大功能改动的窗口 |
| Step 3 端点搬迁 | 0.5~1 天 | 跟在 Step 2 之后，机械完成 |

**启动信号**（满足任意一条即可开工）：

- 「她该说话却不说 / 不该说话却说了」这类问题开始频繁出现；
- 开源后有外部贡献者想改仿真行为；
- 需要在唤醒逻辑里加新触发条件（比如「有人引用她」），而现有结构改起来吃力。

**注意**：Step 1 和 Step 2 之间建议隔至少一天，让 Step 1 在真实流量下跑一跑再动核心逻辑。

---

## 10. 实施记录

### Step 1 状态存储 —— 完成（2026-10-29，commit `9ace92b`）

- 新增 `src/core/socialv2-store.mjs`：canonicalV2Key / normalizeSpeakerIdsV2 /
  defaultWakeConfigV2 / createConversationStateV2 / hydrateConversationStateV2 / serializeSocialV2
- `bridge.js` 11537 → 11406 行；三个状态函数改成调用新模块，行为不变
- 验证：四个会话的 recentMessages / unread / lastUnreadSeq / 文本逐一比对一致
- 新增 `scripts/test-socialv2-store.mjs`（9 项），已进每日自检

### Step 2 唤醒调度 —— 纯函数部分完成（2026-10-29）

已迁出（全部纯函数，可单测）：

| 函数 | 说明 |
| --- | --- |
| `WAKE_PRIORITY` / `wakePriorityV2` | 唤醒优先级表与查表 |
| `TIME_BASED_WAKE_V2` / `isTimeBasedWakeV2` | 时间型唤醒判定 |
| `isDirectedAtAi` | 是否在直接问她 |
| `computeWakeSafetyV2` | 安全阀（now 可注入） |
| `isWakeableV2` | 防永眠判定（从 ensureWakeableV2 拆出） |
| `evaluateWakeTriggerV2` | 六种触发条件判定（随机源与昵称注入） |

`bridge.js` 11406 → 11333 行。新增 `scripts/test-socialv2-wake.mjs`（8 项），已进每日自检。

**仍留在 bridge.js 的部分**（有副作用，需要注入定时器或 DSH 客户端后才能搬）：

- `scheduleWakeV2`：排定时器
- `sendWakePromptV2`：真正把提示词交给 DSH
- `buildWakeSnapshotV2` / `buildWakePromptV2` / `buildWakeReminderPromptV2`：依赖人格与记忆注入

### 待做

1. Step 2 剩余：把 `scheduleWakeV2` 的定时器依赖抽成可注入（`setTimer/clearTimer`），
   之后它也能用假时钟单测（推进到「该唤醒」的时刻）。
2. Step 3：54 个端点分 4 个文件搬迁。

### Step 3 端点搬迁 —— 第一批完成（2026-10-29，commit `6dc5d7c`）

已搬：`src/routes/socialv2-memory-api.mjs`（10 个端点）

```
memory / memory-append / memory-search / memory-stats / memory-remember
memory-inspect / memory-profile / memory-update / memory-remove / memory-clear
```

`bridge.js` 11333 → 11056 行。这批的调用方是 QQ 侧 AI（agent token），
三道校验（token / 会话范围 / 工具开关）原样保留。

**两个值得记的坑**：

1. 抽取范围把早先拆出的 `/api/memory/*` 调用块一起包了进去 → 所有 `/api/memory/*` 变 500。
   教训：**按行号切块时要先确认这段里没有别的域留下的调用桩**。
2. 依赖注入漏了 `memoryQueryV3` / `formatMemoryInjectionV3`（bridge 内部函数），
   错误只在运行时出现（500「xxx is not defined」）。
   教训：注入清单应该**从代码里的实际引用生成**，不要凭印象列。

### Step 3 剩余（未做，按风险排序）

| 组 | 端点数 | 风险 | 说明 |
| --- | --- | --- | --- |
| 状态与配置 | 11 | 低 | config/activity/reset/state/prompt/unread/recent/mark-read/wake-config/states |
| 唤醒与等待 | 3 | 中 | wake/wait/check-send，涉及 DSH 会话与队列 |
| 工具侧 | 10 | 中 | tool-log/feedback/my-recent/record-sent/message-detail/forward-*/active-members |
| 发送与媒体 | 15 | **高** | send-*/qzone-*/voice/sticker-*，直连 SnowLuma 发送链路，建议最后做 |
| 黑话 | 2 | 中 | slang/query 与 slang/submit 依赖 slangEntries（let + 4 张 Map/Set） |

建议顺序：状态与配置 → 工具侧 → 唤醒与等待 → 黑话 → 发送与媒体。

### Step 3 第二批：状态只读端点（2026-10-29）

新增 `src/routes/socialv2-state-api.mjs`（5 个），全部只读：

```
GET /api/socialV2/state    GET /api/socialV2/prompt
GET /api/socialV2/unread   GET /api/socialV2/recent
GET /api/socialV2/states
```

**会改状态的 5 个端点故意留着**：config / activity / reset / mark-read / wake-config。
它们直接操作唤醒配置和读水位，属于状态机核心，不跟只读端点混在一起搬。

`bridge.js` 11056 → 10896 行。

**顺手修了一个既有 bug**：

`/api/socialV2/prompt` 原本调用不存在的 `currentRoleHintV2()`，导致该接口**一直是 500**。
真实实现是 `roleHintForMode('v2'|'v1', roleName)`（bridge 里本来就有），已改正。
这次拆分把它暴露了出来——因为拆分后我第一次真正去测这个端点。

**这一批踩的坑（比上一批多，值得记）**：

1. 参数重复：`sendJson` / `readBody` 既在依赖清单里又手写了一遍 → 语法错。
2. `let` 变量必须用 getter：`currentMode` / `slangEntries` / `stickerEntries` 都会被整体替换，
   传快照会拿到旧值。这一批补了 3 个 getter。
3. **多行 import 漏检**：`computeWakeSafetyV2` / `buildSlangContext` / `buildStickerContext` /
   `buildStickerStrategyHint` 都在 bridge 顶部的多行 `import { … }` 里，
   依赖扫描只看以 `import` 开头的行，于是全部漏掉。
   → 教训：**依赖清单要按「import 块」扫描，不能只看首行**。

### 当前进度

| 模块 | 端点数 |
| --- | --- |
| `memory-api.mjs` | 4 |
| `roles-api.mjs` | 9 |
| `tokens-api.mjs` | 6 |
| `stickers-api.mjs` | 5 |
| `socialv2-memory-api.mjs` | 10 |
| `socialv2-state-api.mjs` | 5 |
| **合计** | **39** |

`bridge.js`：11955 → 10896 行（-1059）。

### 剩余（按建议顺序）

| 组 | 端点数 | 风险 |
| --- | --- | --- |
| 状态写操作 | 5 | 中（config/activity/reset/mark-read/wake-config） |
| 工具侧 | 10 | 中 |
| 唤醒与等待 | 3 | 中 |
| 黑话 | 2 | 中 |
| 发送与媒体 | 15 | 高 |
