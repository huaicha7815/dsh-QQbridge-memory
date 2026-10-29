# socialV2 唤醒调度拆分设计（Step 2 剩余）

> 目标：把「什么时候该叫醒她、什么时候该睡」这套定时器逻辑从 `bridge.js` 里拆出来，
> 让它能用**假时钟**单测，同时合并两处已经重复的看门狗逻辑。
>
> 状态：**Step A / B / C 全部实施（2026-10-29）**。详见文末「实施记录」。
>
> 前置：Step 1（状态层）、Step 2 纯函数部分（唤醒判定）、Step 3（54 个端点）已完成。
> 本文覆盖的是 Step 2 剩下的那部分——**有副作用的调度逻辑**。

---

## 1. 为什么单独为它写设计

前面拆的都是「无副作用的判定」或「端点搬运」，搬完就能跑。

这一批不一样：**它靠 `setTimeout` 驱动**。定时器不是一个值，是一个隐式全局依赖——
你没法把一个「5 分钟后执行」的测试真的等 5 分钟。所以必须先改造接口，让它接受注入的时钟，
才谈得上「搬」。

同时这批代码里有三处复合缺陷值得顺手处理：

1. `scheduleWakeV2` 和 `sendWakePromptV2` **各自复制了一份**「会话繁忙 → 暂存 + 5 分钟看门狗」的逻辑；
2. 四类定时器（待唤醒 / 睡眠 / 回复检查 / 主动检查）各自管理自己的 `st.xxxTimer` 字段，
   没有统一的取消入口；
3. 定时器是否 `unref` 靠每处手写，漏一个就会让进程无法退出。

---

## 2. 现状盘点

| 函数 | 行号 | 行数 | 副作用 | 备注 |
| --- | --- | --- | --- | --- |
| `refreshDefaultWakeConfigV2` | 5297 | ~65 | 写状态 | 可并入状态层 |
| `ensureWakeableV2` | 5362 | ~23 | 写状态 + 清定时器 | 判定已抽出，剩壳 |
| `buildWakeSnapshotV2` | 7111 | 81 | 读状态 | 组装上下文快照 |
| `buildWakePromptV2` | 7192 | 123 | 读状态 | 提示词组装 |
| `buildWakeReminderPromptV2` | 7315 | 10 | 无 | 纯字符串 |
| `sendWakePromptV2` | 7325 | 136 | **DSH 投递 + 定时器** | 唯一真副作用边界 |
| `scheduleReplyCheckV2` | 7461 | 41 | 定时器 | 30s 后补一刀 |
| `scheduleWakeV2` | 7502 | 75 | 定时器 + 状态 | 合并窗口、看门狗 |
| `setupSleepTimerV2` | 7577 | 45 | 定时器 | 有限睡眠、远未来续期 |
| `scheduleProactiveCheckV2` | 7622 | ~58 | 定时器 | 主动机会 |

合计约 **570 行**，其中 4 个定时器入口、**7 处 `setTimeout`**。

### 2.1 定时器清单

| 位置 | 字段 | 用途 | unref |
| --- | --- | --- | --- |
| `scheduleWakeV2` | `st.pendingWakeTimer` | 合并窗口后投递唤醒 | ✅ |
| `scheduleWakeV2` | `st.pendingWakeWatchdog` | 繁忙积压 5 分钟解卡 | ✅ |
| `sendWakePromptV2` | `st.pendingWakeWatchdog` | 同上（**重复实现**） | ✅ |
| `setupSleepTimerV2` | `st.sleepTimer` | 有限睡眠到点 | ✅ |
| `setupSleepTimerV2` | `st.sleepTimer` | 远未来续期 | ✅ |
| `scheduleReplyCheckV2` | `st.replyCheckTimer` | 30s 后补一刀 | ✅ |
| `scheduleProactiveCheckV2` | `st.proactiveTimer` | 主动机会 | ✅ |

### 2.2 为什么不能直接搬

| 隐形依赖 | 说明 |
| --- | --- |
| `setTimeout` / `clearTimeout` | 全局函数，没法替换 → 测试必须真等 |
| `Date.now()` | 决定「睡眠还剩多久」「远未来是否续期」 |
| `st.*Timer` 字段 | 存的是 Node Timer 对象，**不能序列化**，混在会话状态里 |
| `sendWakePromptV2` | 异步投递到 DSH，是唯一必须留在编排层的东西 |
| `isConversationBusyV2` / `promptQueues` / `v2TurnStartAt` | 判断「她正在忙」需要看队列与 turn 状态 |

---

## 3. 目标架构

```
src/core/socialv2-scheduler.mjs     定时器 + 合并窗口 + 看门狗（接受注入时钟）
src/core/socialv2-prompt.mjs        上下文快照 + 提示词组装（纯函数）
src/bridge.js                       只留 sendWakePromptV2（真投递）与调用编排
```

依赖方向：

```
bridge.js ──> core/socialv2-scheduler.mjs ──> core/socialv2-store.mjs
          └─> core/socialv2-prompt.mjs ─────> core/socialv2-store.mjs
          └─> core/socialv2-wake.mjs（已存在）
```

**`core/` 一律不 import bridge**，全部注入。

---

## 4. 接口契约

### 4.1 调度器

```js
export function createScheduler({
  // ── 状态 ──
  getState,            // (key) => 会话状态对象（含 wakeConfig / unread / lastUnreadSeq）
  save,                // () => void 落盘
  // ── 策略 ──
  cfg,                 // 配置（enabled / batchWindowMs / 频率上限）
  isAllowed,           // (key) => boolean 当前模式是否允许
  isPaused,            // () => boolean 全局暂停
  isBusy,              // (key, st) => boolean 会话是否正在跑 turn
  // ── 时钟（测试注入假时钟）──
  now = Date.now,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = (t) => clearTimeout(t),
  // ── 副作用回调 ──
  onWake,              // (key, reason) => Promise<void>  真正投递（bridge 里的 sendWakePromptV2）
  onUnstick,           // (key) => void 解卡钩子（清 busy 标志）
  log = () => {},
}) {
  return {
    scheduleWake(key, reason),
    setupSleepTimer(key),
    scheduleReplyCheck(key),
    scheduleProactiveCheck(key),
    cancelTimers(key),        // 统一取消四类定时器
    pendingInfo(key),         // 给控制台/诊断看：当前有哪些待触发
    _timers,                  // 仅测试用：假时钟可推进
  };
}
```

### 4.2 提示词组装

```js
export function buildWakeSnapshot(key, {
  getState, cfg, now, tools, roleHint, memoryBlock, // 全部注入
}) { ... }

export function buildWakePrompt(key, reason, {
  getState, cfg, now, selfName, buildSnapshot, buildReminder,
}) { ... }

export function buildWakeReminderPrompt(reason) { ... } // 纯字符串，无需注入
```

### 4.3 bridge 保留

```js
async function sendWakePromptV2(key, reason) {
  // 唯一副作用边界：投递到 DSH（deliverPrompt / ensureSession）
  // 内部的「繁忙 → 暂存 + 看门狗」改为调用 scheduler 的同一份实现
}
```

---

## 5. 合并重复逻辑（本设计的核心收益）

现状：`scheduleWakeV2` 与 `sendWakePromptV2` 各有一份几乎相同的代码——

```
if (isConversationBusyV2(...)) {
  pendingWakeReasons.push({ reason, seq })   // 有界 20 条
  if (!pendingWakeWatchdog) { 5 分钟后：判断还相关 → 清 busy → 补发 }
  return
}
```

两份的分歧风险很高：任何一边改了阈值，另一边不会同步。

**合并后**：调度器暴露 `stashBusyWake(key, reason)`，两个调用点都走它；
看门狗只在调度器里存在一份，`bridge` 通过 `onUnstick` 回调执行「清 busy 标志」这个动作。

---

## 6. 可测性：假时钟测试矩阵

注入时钟后能做到「秒级验证 5 分钟后的行为」。计划覆盖：

| # | 场景 | 断言 |
| --- | --- | --- |
| 1 | 合并窗口内第二次 schedule | 不新建定时器；reason 按优先级升级 |
| 2 | 先 probability 后 atMention | 最终 reason 是 atMention（不被概率覆盖） |
| 3 | 会话繁忙 | 进 pendingWakeReasons，不建定时器；队列上限 20 |
| 4 | 看门狗 | 推进 5 分钟 → onUnstick 被调用一次，补发一次 |
| 5 | 看门狗但消息已读完 | 不补发，只清队列 |
| 6 | 有限睡眠到点 | 推进到 sleepUntil → onWake('timeout') |
| 7 | 远未来睡眠 | 首段 100009ms 后续期，不提前唤醒 |
| 8 | paused / disabled / 不在模式内 | 不排任何定时器 |
| 9 | 取消 | cancelTimers 后推进时钟，onWake 不被调用 |
| 10 | 定时器都 unref | `_timers` 里每个 timer 的 hasRef() === false |

---

## 7. 分步实施

### Step A：调度器（低风险，收益最大）

搬出：`scheduleWakeV2` + `setupSleepTimerV2` + `scheduleReplyCheckV2` + `scheduleProactiveCheckV2`

**验收**：
- [ ] 10 个假时钟用例全过
- [ ] `bridge.js` 里不再出现 `setTimeout` 管理这四类定时器
- [ ] 真实会话跑一晚：唤醒、睡眠、回复检查行为无变化（看日志里「计划唤醒/设置有限潜水定时器」出现频率）

**回滚**：`config.socialV2.wake.useLegacyScheduler = true` 切回旧实现（两套并存两周）。

### Step B：提示词组装（低风险）

搬出：`buildWakeSnapshotV2` + `buildWakePromptV2` + `buildWakeReminderPromptV2`

**验收**：
- [ ] 现有 e2e（`test-memory-e2e` 里断言提示词内容的用例）全过
- [ ] 抓一次真实唤醒的 prompt 文本，与拆分前逐字比对一致

### Step C：清理（低风险）

- `ensureWakeableV2` 并入状态层
- `refreshDefaultWakeConfigV2` 并入状态层
- 统一 `cancelTimers`

---

## 8. 风险与对策

| 风险 | 可能性 | 影响 | 对策 |
| --- | --- | --- | --- |
| 注入时钟后漏掉 `unref`，进程退不出 | 中 | 中 | 默认 `setTimer` 实现自带 unref；用例 10 断言 |
| 远未来续期逻辑改错，睡眠提前/推迟 | 低 | 高 | 用例 6/7 覆盖边界；回滚开关 |
| 合并看门狗时漏掉「消息已读完不补发」 | 中 | 中 | 用例 5 专门覆盖 |
| 两套实现并存期间行为分叉 | 中 | 中 | 开关只允许整体切换，不做逐函数混合 |

---

## 9. 验收标准（整体）

- [ ] `bridge.js` 降到 **8500 行以下**
- [ ] 调度器与提示词模块可单独 import 测试（不启动 bridge）
- [ ] 假时钟用例 10 项全过，且进了每日自检
- [ ] 真实环境跑满 24 小时，唤醒/睡眠行为与拆分前一致

---

## 10. 不做的事

1. **不改唤醒策略**。合并窗口时长、频率上限、看门狗阈值一律保持原值。
2. **不重新设计定时器类型**。还是四类，只是统一管理。
3. **不在同一次改动里做「按会话并发度动态调频」这类新功能**。
4. **不碰 `sendWakePromptV2` 的 DSH 投递协议**——它只搬内部那段暂存逻辑，投递本身不动。

---

## 11. 实施记录

### Step A 调度器 —— 完成（2026-10-29）

新增 `src/core/socialv2-scheduler.mjs`：

```js
createScheduler({ getState, save, cfg, isAllowed, isPaused, isBusy,
                  onWake, onUnstick, appendActivity, log,
                  now, setTimer, clearTimer })
  → { scheduleWake, setupSleepTimer, scheduleReplyCheck,
      cancelReply, cancelTimers, pendingInfo, stashBusyWake }
```

搬出的四个定时器入口：`scheduleWakeV2` / `setupSleepTimerV2` /
`scheduleReplyCheckV2` / `cancelReplyCheckV2`。bridge 里保留同名薄包装（调用点很多，不改调用方）。

**核心收益达成**：`scheduleWakeV2` 与 `sendWakePromptV2` 里重复的
「繁忙 → 暂存 + 5 分钟看门狗」合并成一份 `stashBusyWake`，
`sendWakePromptV2` 现在只有一行调用。

`bridge.js` 8937 → 8797 行。

### 假时钟测试：12 项全过

| # | 场景 |
| --- | --- |
| 1 | 合并窗口内二次 schedule 不新建定时器，按优先级升级 |
| 2 | 先 probability 后 atMention 会升级 |
| 3 | 繁忙时不建定时器，暂存队列上限 20 |
| 4 | 看门狗 5 分钟后解卡并补发 |
| 5 | 消息已读完则不补发，只清队列 |
| 6 | **时间型唤醒（日记）即使消息读完也必须补发** |
| 7 | 有限睡眠到点唤醒 |
| 8 | 远未来睡眠首段 100009ms 后续期，不提前唤醒 |
| 9 | 暂停 / 关闭时不排任何定时器 |
| 10 | cancelTimers 后推进时钟也不唤醒 |
| 11 | 已有待唤醒时不重复安排回复检查 |
| 12 | 所有定时器都 unref（不阻止进程退出） |

**以前这些只能靠「等 5 分钟」或「真实群里试」来验证。**

### 测试里被纠正的一个认知

我最初断言「看门狗解卡后队列清空」，实际不成立——解卡时如果她**仍然在忙**，
补发的唤醒会正常地再次暂存。这不是 bug，是重排。
看门狗只负责「把卡住的会话解开」，建定时器要靠下一条消息/下一次调度。

### Step B / C 未做

- **Step B**（提示词组装搬出）：`buildWakeSnapshotV2` / `buildWakePromptV2` 仍在 bridge。
  它们依赖人格注入、记忆检索、工具清单，属于「组装」不是「调度」，
  与本次目标（定时器可测）关系不大，优先级低。
- **Step C**（`ensureWakeableV2` / `refreshDefaultWakeConfigV2` 并入状态层）：小改动，待做。

### Step B 提示词组装 —— 完成（2026-10-29）

新增 `src/core/socialv2-prompt.mjs`（228 行）：

```js
createWakePromptBuilder({ getState, cfg, formatMemoryInjectionV3, formatParticipationV2,
                          readThroughSeqV2, suggestQuietMsV2, v2ToolEnabled, wakeRoleLineV2,
                          buildStickerContext, buildStickerStrategyHint, compactModelMessage,
                          looksLikeUnfinished, buildDiaryDigestV2, profileDigestForRefine,
                          threadClosureHints, stickerEntries, memoryStore })
  → { buildWakeSnapshot, buildWakePrompt, buildWakeReminderPrompt, replyTimingV2 }
```

搬出：`buildWakeSnapshotV2`（81 行）+ `buildWakePromptV2`（123 行）+ `buildWakeReminderPromptV2`（10 行）+ `replyTimingV2`。

**提示词内容一个字都没改**——只改位置，字符串顺序/标点/换行全部保持原样。

单测 4 项：提醒提示词必须带 key/令牌/收尾工具/观察窗口；提示词必须注入角色行与未读消息；
工具全关时快照返回 null；快照结构字段完整。

**这一批踩的坑（最有教育意义的一批）**：

1. `replyTimingV2` 是**模块内局部函数**，但我先把它当成外部依赖注入 → 参数重复；
   移出工厂后它又依赖工厂注入的 `cfg`/`suggestQuietMsV2` → 顶层不可用。
   最终方案：留在工厂内、由工厂 return 暴露，bridge 用薄包装转出去给 state-api 用。
   → 教训：**「这个函数是自己人还是外部依赖」在抽取前必须确认**，不能靠名字猜。
2. `stickerEntries` 是 `let`（同步后整体替换）→ 必须 getter；
3. `memoryStore` 是 main 内的 const → 同一批里只补到第二次才全。

### Step C 睡眠判定 —— 完成（2026-10-29）

并入 core：`hasExplicitEnd` / `isSleepingConfig` / `preSleepWaitBlocked` 进 `socialv2-wake.mjs`，
`refreshDefaultWakeConfig` 进 `socialv2-store.mjs`。bridge 保留薄包装。

单测 6 项：结束语识别、沉睡配置判定、观察窗口三条放行规则、结束语豁免、开关可关、
默认配置只覆盖 `confirmedBy === "default"` 的会话（AI/管理员设过的不覆盖）。

### 最终结果

```
bridge.js      11955 → 8561 行（-3394，-28%）
core 模块       8 个（新增 scheduler / prompt）
routes 模块     10 个 / 78 个端点
每日自检        9 个套件（新增 12+6+4 项 socialV2 单测）
```

---

## 12. 全面体检（2026-10-29）

拆分完成后做了一次系统性检查，**发现并修复了 2 个自己引入的真 bug**，外加若干清理。

### 修掉的真 bug

**bug 1：取消定时器会凭空创建会话状态**

旧 `cancelReplyCheckV2` 用 `socialV2.conversations.get(key)`（不存在就返回 undefined）；
新调度器的 `cancelReply` 用了 `getState(key)`，而它会**创建缺省会话**。
结果：对任何不存在的 key 取消定时器，都会造出一条空会话并落盘。

修法：调度器加 `peekState`（只读、不创建），取消/查询类操作改用它；
并补了一条单测：「取消不存在的会话不应创建状态」。

**bug 2：初始化顺序导致的 TDZ 崩溃（两处）**

`sendWakePromptV2` 在启动流程第 6740 行被 `await`（greeting 打招呼），
但它依赖的 `scheduler`（原在 7189）和 `wakePromptBuilder`（原在 7100）在这之后才初始化。
那天没崩只是因为「距上次打招呼不到 5 小时」被跳过了——**一旦真到需要打招呼的时刻就会 ReferenceError**。

修法：把 `scheduler` 前移到 `saveSocialV2State` 之后（5474），
`wakePromptBuilder` 前移到 `memoryStore` 之后（5555），都早于第一次调用。

### 检查过但没问题的项

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| 路由模块依赖注入 | 逐模块对比声明参数 vs bridge 传入 | 10 个模块全部一致 |
| 58 个端点的安全校验 | 与拆分前逐端点对比 agentTokenOk / v2SessionAllowed / v2ToolEnabled / 状态码数量 | 49 个 socialV2 端点仅 2 处切块误报 |
| 提示词内容 | 与拆分前逐条比对字符串字面量 | 103 条**完全一致**（一个字没改） |
| 重复函数定义 | 扫描同名 function | 无 |
| 同步 TDZ | 检查 main 内 93 个 const 的初始化表达式 | 无 |
| 数据完好 | 4 个会话字段数 / 定时器泄漏 / 档案 / 事件流 | 21 字段、无定时器泄漏、档案与 2618 条事件正常 |
| 运行时 | 13 个端点 + 日志 300 行 | 全 200；日志只有 SnowLuma 启动瞬间的重连（正常） |

### 顺手清理

- 4 个死 import（`wakePriorityV2` / `TIME_BASED_WAKE_V2` / `formatDuration` / `hasExplicitEnd`）
- 1 个死包装（`hasExplicitEndV2`，搬完后没人调用）
- `docs/ROUTES.md` 重新生成（之前已过期）

### 一个方法论收获

「搬家式重构」最危险的 bug 不是逻辑写错，而是**搬家引入的时序与副作用差异**：
取状态变成了创建状态、初始化顺序倒置。**这两类问题单测都测不出来**，
只有「对比旧实现」和「静态检查顺序」才能发现。

---

## 13. 第二次体检：用户反馈「引用内容和看见的不一样」（2026-10-29）

### 现象

另一个部署的使用者反馈：他在 QQ 里**引用一条合并转发**（「小鲸鱼和游园的聊天记录」）
跟她说话，她说「你引一句我没印象」。他看到她引用的内容与自己看到的完全不同。

### 根因（三个问题叠加）

**问题 1+2：`/api/socialV2/forward-message` 返回 500（拆分时漏注入 2 个依赖）**

| 漏的依赖 | 报错 |
| --- | --- |
| `currentMode` | `currentMode is not defined` |
| `cfg` | `cfg is not defined` |

结果：她想查转发内容时接口直接 500，**什么都看不到**。

**问题 3：引用一条转发时，摘要里只有 id**

`resolveReplyInfo` 用 `segmentsToText` 处理被引用消息，转发段被降级成
`[转发消息 id=xxx]`——她只知道「这是一条转发」，不知道转发里是什么。
而她看到的 QQ 引用在对方那边显示的是标题「小鲸鱼和游园的聊天记录」。
两边看到的东西自然对不上。

### 修复

1. `socialv2-tools-api.mjs` 补 `currentMode`（getter）与 `cfg`；
2. `resolveReplyInfo` 遇到被引用消息含转发段时，**自动查一次 `get_forward_msg`**，
   拼成 `转发「标题」：发送者：前 60 字 / 发送者：前 60 字`（最多 2 条）；
   结果进 `replyInfoCache` 缓存，不会每次引用都打接口。

### 教训

这是同一类错误（**拆分时依赖清单靠猜、验证只测了「简单端点」**）的第二次出现。
第一次是 `allow`/`slang` 误报，这次是 `currentMode`/`cfg` 漏报。
共同点：**只测了 GET 简单端点，没测需要参数的端点**——
`forward-message` 因为要 id 和 agent token，被我的验证脚本跳过了，
于是带着 500 存活了好几轮提交。

以后抽取任何模块，验证清单必须**覆盖该模块的每一个端点**（含需要参数的），
不能只挑能直接 GET 的测。
