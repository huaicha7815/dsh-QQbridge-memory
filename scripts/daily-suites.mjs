// 每日自检套件清单（唯一数据源：test-daily 与发布清单一致性校验共用）。
export const SUITE_LIST = [
  {
    // DSH preset patch 生成一致性（--check；Windows 干净 clone 下曾因 CRLF 假失败）
    name: 'DSH preset patch 一致性',
    args: ['scripts/test-agent-preset-patches.mjs'],
    expect: 0,
  },
  {
    // 记忆银河 HTTP hermetic fixture：401/403（Host、agent）/200/no-store/脱敏/状态投影
    name: '记忆银河 HTTP',
    args: ['scripts/test-galaxy-http.mjs'],
    expect: 0,
  },
  {
    // 记忆银河缓存状态机：pending/fresh/stale/error、single-flight、旧缓存保留
    name: '记忆银河缓存',
    args: ['scripts/test-galaxy-cache.mjs'],
    expect: 0,
  },
  {
    // 记忆银河投影：类型元数据/ID 唯一/归档/约定状态/时间语义/S3 去重/路径守卫/前端转义
    name: '记忆银河投影',
    args: ['scripts/test-galaxy.mjs'],
    expect: 0,
  },
  {
    // 发布资产契约：导出 .gitignore 单点写入、共享导出规则、preflight skip 语义
    name: '发布资产契约',
    args: ['scripts/test-release-assets.mjs'],
    expect: 0,
  },
  {
    // /api/* 路由位置审计：所有路由处理必须在集中鉴权关卡之后（关卡前即绕过）
    name: '/api 路由位置审计',
    args: ['scripts/audit-route-positions.mjs'],
    expect: 0,
  },
  {
    // 路由鉴权契约：MCP agent 工具面与 bridge 精确允许表双向一致（含反例防假绿）
    name: '路由鉴权契约',
    args: ['scripts/test-auth-routes.mjs'],
    expect: 0,
  },
  {
    // 真实桥接 HTTP 鉴权：tokenless status probe、agent 声明 403、无效 token 拒绝
    name: '路由鉴权 HTTP',
    args: ['scripts/test-auth-http.mjs'],
    expect: 0,
  },
  {
    // 控制台静态契约：视图/页面一一对应、样式预算（HTML/JS style=0）、
    // class/规则契约、运行时 style 0、重复 class 0（voice-tool 缺失时 SKIP）
    name: '控制台静态契约',
    args: ['scripts/test-console-static.mjs'],
    expect: 0,
  },
  {
    name: '记忆库单测',
    args: ['--test', 'scripts/test-memory-lib.mjs'],
    expect: 0,
  },
  {
    // 记忆库：情绪检索通道（事件标注 valence/arousal、同类情绪场景召回、
    // 默认检索行为不变、旧数据向后兼容）。
    name: '记忆库情绪检索',
    args: ['--test', 'scripts/test-memory-emotion.mjs'],
    expect: 0,
  },
  {
    // 控制台「她的情绪」：每句话发出时的情绪快照 + 只读 API（控制台专用）。
    name: '她的情绪（控制台）',
    args: ['--test', 'scripts/test-mood-history.mjs'],
    expect: 0,
  },
  {
    // 情绪系统 V2 1A：14 kind / 13 事件映射 / 强度 clamp / upsert 融合 / 淘汰 /
    // target-aware 合成 / 滞回切换 / 旧状态迁移（纯函数，不碰 store/prompt）。
    name: '情绪 V2 纯函数（1A）',
    args: ['--test', 'scripts/test-mood-emotions.mjs'],
    expect: 0,
  },
  {
    // 情绪系统 V2 1B 状态层：normalize/plan/load/迁移 driver/三模式 serialize/
    // seenForwardIds md5/预算 + memory 稳定 id 幂等 API（不写盘，writeFile 注入）。
    name: '情绪 V2 状态层（1B）',
    args: ['--test', 'scripts/test-emotion-v2-store.mjs'],
    expect: 0,
  },
  {
    // 情绪系统 V2 1B 执行层：flags 12 组合/contentHash/factId 两写/archive 三阶段/
    // relationship 淘汰/gate-save 流水线/reset service/bridge adapter。
    name: '情绪 V2 执行层 + adapter（1B）',
    args: ['--test', 'scripts/test-emotion-v2-exec.mjs'],
    expect: 0,
  },
  {
    // 情绪系统 V2 1C：bridge runtime 接线（main/legacy/shadow）、candidateFromLegacy、
    // 预算 fatal 短路、会话裁剪、关系冷化、adapter 双写、reset 鉴权矩阵、真实 bridge 端到端。
    name: '情绪 V2 bridge runtime（1C）',
    args: ['--test', 'scripts/test-emotion-v2-bridge.mjs'],
    expect: 0,
  },
  {
    // 情绪系统 V2 阶段 2：快慢双通道（episodeChannelIntensity/slowValence）、
    // 切换曲线 tuning（floor/minDwell/maxSwitchesPerTurn）、per-kind 半衰期覆盖。
    name: '情绪 V2 阶段 2（双通道 + 调参）',
    args: ['--test', 'scripts/test-emotion-v2-stage2.mjs'],
    expect: 0,
  },
  {
    // 情绪系统 V2 阶段 4：记忆多情绪标签、表达精调、可视化静态断言。
    name: '情绪 V2 阶段 4（标签/精调/可视化）',
    args: ['--test', 'scripts/test-emotion-v2-stage4.mjs'],
    expect: 0,
  },
  {
    // 情绪系统 V2 阶段 4：发布 smoke（真实 bridge 端到端）。
    name: '情绪 V2 发布 smoke',
    args: ['--test', 'scripts/test-smoke-emotion-v2.mjs'],
    expect: 0,
  },
  {
    // 发布清单与测试结果一致性（smoke 数量/阈值写法，防止清单漂移）。
    name: '发布清单一致性',
    args: ['--test', 'scripts/test-release-checklist.mjs'],
    expect: 0,
  },
  {
    name: 'socialV2 状态层',
    args: ['--test', 'scripts/test-socialv2-store.mjs'],
    expect: 0,
  },
  {
    name: 'socialV2 唤醒判定',
    args: ['--test', 'scripts/test-socialv2-wake.mjs'],
    expect: 0,
  },
  {
    name: 'socialV2 调度器（假时钟）',
    args: ['--test', 'scripts/test-socialv2-scheduler.mjs'],
    expect: 0,
  },
  {
    name: 'socialV2 睡眠判定',
    args: ['--test', 'scripts/test-socialv2-sleep.mjs'],
    expect: 0,
  },
  {
    name: 'socialV2 提示词组装',
    args: ['--test', 'scripts/test-socialv2-prompt.mjs'],
    expect: 0,
  },
  {
    // 情绪与关系状态层：事件→状态、半衰期衰减、边界、未知会话默认值、
    // 持久化重启恢复，以及控制台只读端点（mood / relationship / moods）。
    name: '情绪与关系状态层',
    args: ['--test', 'scripts/test-mood.mjs'],
    expect: 0,
  },
  {
    // 桥接接线层：入站文本分类、事件分发（消息/拍一拍/出站/冷落）、
    // stale 预检与「消息→状态→落盘→重启恢复」端到端。
    name: '情绪接线（消息→状态→重启）',
    args: ['--test', 'scripts/test-mood-events.mjs'],
    expect: 0,
  },
  {
    // bridge 真实路径：通过 audit-bridge-harness 加载真实 bridge.js，
    // 直接调用 appendSocialV2Message / appendSocialV2Poke / recordSentMessagesV2 验证接线。
    name: '情绪接线（bridge 真实路径）',
    args: ['--test', 'scripts/test-mood-bridge.mjs'],
    expect: 0,
  },
  {
    // 表达层（会话 C）：mood/relationship → 回复长度/表情/语音/称呼/撒娇/吃醋/冷战/
    // 主动倍率，阈值可配，plan → 提示词指令段，概率闸门与 builder 集成（含可解释性）。
    name: '情绪表达映射（状态→说话方式）',
    args: ['--test', 'scripts/test-mood-expression.mjs'],
    expect: 0,
  },
  {
    name: '路由依赖注入',
    args: ['--test', 'scripts/test-routes-inject.mjs'],
    expect: 0,
  },
  {
    name: '路由调用点比对',
    args: ['--test', 'scripts/test-route-callsites.mjs'],
    expect: 0,
  },
  {
    // 审计套件：VM harness 加载真实 bridge.js，覆盖发送/语音/鉴权/模式隔离等真实路径。
    // 曾因 harness 缺 setImmediate/galaxy 注入被静默打断，纳入 daily 防回归。
    name: '审计套件（bridge 真实路径）',
    args: ['--test', 'scripts/test-audit-bridge.mjs'],
    expect: 0,
  },
  {
    // 表情工具链：路由拆到 routes/ 之后曾腐化（断言查 bridge 文本），修复后纳入 daily。
    name: '表情工具链（路由/函数存在性）',
    args: ['scripts/test-stickers.mjs'],
    expect: 0,
  },
  {
    // MCP 层：表达策略拒绝（expression_veto）→ 非故障工具结果。
    name: 'MCP 表达拒绝结果',
    args: ['--test', 'scripts/test-mcp-expression-result.mjs'],
    expect: 0,
  },
  {
    name: '记忆写入恢复（replay）',
    args: ['--test', 'scripts/test-memory-replay.mjs'],
    expect: 0,
  },
  {
    name: '记忆身份归属',
    args: ['--test', 'scripts/test-memory-identity.mjs'],
    expect: 0,
  },
  {
    // 层 × 故障 × 入口矩阵：把「新入口又漏掉未知状态」这类问题在提交前抓出来，
    // 而不是等审查方逐轮静态推演（见 docs/guides/PUBLISH_SYNC.md 的效率说明）。
    name: '状态矩阵（层×故障×入口）',
    args: ['--test', 'scripts/test-state-matrix.mjs'],
    expect: 0,
  },
  {
    // 维护门：所有写记忆的命令必须走同一个 gate（bridge 启动也走）。
    // 进程并发/时序语义单独一套，不塞进状态矩阵。
    name: '维护门（进程互斥）',
    args: ['--test', 'scripts/test-maintenance-gate.mjs'],
    expect: 0,
  },
  {
    // 路由文档一致性：避免「daily 全绿但 docs/ROUTES.md 已过期」。
    name: '文档一致性（ROUTES.md）',
    args: ['scripts/gen-routes-doc.mjs', '--check'],
    expect: 0,
  },
  {
    name: '记忆库端到端',
    args: ['--test', 'scripts/test-memory-e2e.mjs'],
    expect: 0,
  },
  {
    name: '健康检查（只读）',
    args: ['scripts/memory-health.mjs'],
    expect: 0,
  },
  {
    name: '基线对比（只读）',
    args: ['scripts/memory-baseline.mjs'],
    expect: 0,
  },
];
