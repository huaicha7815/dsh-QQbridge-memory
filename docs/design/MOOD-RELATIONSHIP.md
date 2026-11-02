# 情绪与关系状态层（mood / relationship）

> 本文描述**当前源码**。实现于 2026-11（三个并行会话：状态层 / 记忆情绪检索 / 控制台情绪页），
> 已并入本仓库并纳入 daily 回归；与记忆库 V3 的集成边界见第 5 节。
>
> 一句话：**情绪是「她此刻的心情」，关系是「和某个人的长期账本」；两者都是会话状态，不是记忆库内容。**
> 记忆库只做两件事：给事件打情绪标注（写入侧）、按当前心情做情绪通道召回（读取侧）。

## 1. 模块边界

| 文件 | 职责 |
|---|---|
| `src/core/mood.mjs` | 纯逻辑：常量、事件表、分类器、衰减、`createMoodLayer`、`createMoodEventDispatcher` |
| `src/core/socialv2-store.mjs` | 会话状态落盘：`mood` / `relationships` 字段（新建默认、hydrate 归一化、serialize） |
| `src/routes/socialv2-state-api.mjs` | 只读接口：`/state`、`/states`、`/mood`、`/moods`、`/relationship`、`/mood-history` |
| `src/bridge.js` | 接线：入站/出站/拍一拍/冷落 → dispatcher；保存失败记 `lastSaveError`（脱敏） |
| `public/console.html` + `console.css` | 控制台「她的心情」页（指标说明、全部历史、关系账本） |

## 2. 数据结构（落盘）

```jsonc
{
  "mood": {
    "valence": 0.35, "arousal": 0.45, "energy": 0.65,   // RAW（未衰减）
    "cause": "他说我好看", "causeType": "praised",
    "since": 1772496060000, "decayHalfLifeMs": 21600000,
    "events": [ { "at": 1772496060000, "type": "praised", "cause": "...", "deltas": { ... } } ]
  },
  "relationships": {
    "123456": {
      "intimacy": 0.33, "tension": 0.06, "lastInteraction": 1772496060000,
      "openLoops": [ ... ], "events": [ ... ], "sources": [ "private:123" ]
    }
  }
}
```

- **上限**：`MAX_MOOD_EVENTS = 40`（心情来源事件）、`MAX_RELATIONSHIP_EVENTS = 12`、`MAX_OPEN_LOOPS = 20`、`MAX_RELATIONSHIP_UIDS = 50`。
- **心情三轴**：`valence ∈ [-1,1]`、`arousal ∈ [0,1]`、`energy ∈ [0,1]`；基线 `{valence:0, arousal:0.3, energy:0.6}`。
- **半衰期**：只作用于 `valence/arousal/energy`（向基线回落）；`intimacy/tension` 是关系状态，**不按心情半衰期自动下降**。

## 3. 事件与冷却

- 情绪事件表 `EMOTION_EVENTS`（13 类）：`praised / comforted / missed / thanked / teased / quarrel / rejected / jealous / insulted / lonely / ignored / ignored_again / makeup` 等，每类带 `valence/arousal/energy` 增量。
- 关系事件表 `RELATIONSHIP_EVENTS`（16 类）：`interaction` 已降为 ±0.001（避免闲聊把亲密刷满）。
- **同类事件冷却**：`SAME_EVENT_COOLDOWN_MS = 30s`（同 actor 同 type 30 秒内只应用一次，防刷屏打满状态；独立 `cooldownLedger`，不落盘）。
- **分类保守**：没把握就不标（否定/双否/询问/对象指向四层保护）；未知类型不标注。

## 4. 派发接线（bridge）

| 输入 | dispatcher |
|---|---|
| 入站消息（`appendSocialV2Message`） | `dispatchIncoming`（暂停闸门 + 群聊方向门控 + 冷却 + closeLoop 预检） |
| 拍一拍 | `dispatchPoke` |
| AI 出站消息 | `dispatchOutgoing` |
| proactive 冷落 | `dispatchNeglect` |

`socialV2.paused` 时全部冻结（不写情绪、不写关系）；所有写入都经 `saveSocialV2State()` 落盘。

## 5. 与记忆库 V3 的集成边界

### 5.1 写入侧：事件带情绪标注

`memory-store.appendEvent` 接受 `emotionType`，经 `emotionAnnotation()` 规范化为：

```json
{ "emotionType": "praised", "valence": 0.7, "arousal": 0.45 }
```

- 显式传入的 `valence/arousal` 优先；未知类型不标注；越界值先钳制。
- 标注只是**事件字段**，不参与心情状态计算（心情由 mood 层单独维护，方向和职责不混）。

### 5.2 读取侧：情绪通道召回

`store.search(query, { emotion: { valence, arousal } })`：
- 与关键词/重要度检索**并行**，**只填空位**、只追加末尾、最多补 2 条；
- 受 `perDayMax/perWhoMax` 多样性上限约束；
- 默认（不传 `emotion`）完全不走，行为与旧版一致；
- 旧数据（无标注）不报错、不参与情绪召回。

### 5.3 跨会话可见性

`crossSessionPolicy` 同时约束**内容可见性**与**情绪召回**：
- `isolated`：检索/情绪通道都只在本会话事件内召回；
- `open`：允许跨会话内容检索，但 agent 的 `memory-inspect` 统计/诊断/路径/配置字段**始终 session-only**（`omitted` 会列出被裁剪字段）。

### 5.4 控制台情绪页

- 指标说明卡（每个数字是什么、怎么读、不是好坏评分）；
- 「她每句话的情绪」= `mood-history` 全量（最多保留 1000 条/会话）；
- 「情绪从哪来」= 最近 40 条来源事件（`MAX_MOOD_EVENTS`）；
- 历史文件损坏时显示降级横幅（只读，不自动覆盖）。

## 6. 接口与鉴权

| 端点 | 控制台 | agent token |
|---|---|---|
| `GET /api/socialV2/mood?key=` | ✅ | ✅ 只能读自己 key |
| `GET /api/socialV2/moods` | ✅ | ❌ 403（跨会话视图） |
| `GET /api/socialV2/relationship?uid=` | ✅ | ❌ 403（跨会话视图） |
| `GET /api/socialV2/mood-history?key=&limit=` | ✅ | ❌ 403 |
| `GET /api/socialV2/state?key=` | ✅ | ✅（`lastSaveError` 只返回 `{at, code}`） |

## 7. 测试

| 套件 | 覆盖 |
|---|---|
| `test-mood.mjs`（45） | 衰减、事件应用、关系账本、只读端点 |
| `test-mood-events.mjs`（24） | 分类器矩阵、派发、暂停、方向门控、**上限 40 + 重启持久化** |
| `test-mood-bridge.mjs`（23） | 真实 bridge 路径：入站/出站/拍一拍/冷落、`lastSaveError` 脱敏 |
| `test-mood-history.mjs`（17） | 快照、1000 条上限、API clamp、降级、满容量性能 |
| `test-mood-expression.mjs` | 表达计划与情绪联动 |
| `test-memory-emotion.mjs`（24） | 标注、情绪通道、默认行为不变、旧数据兼容、isolated 跨会话隔离 |
