// agent（会话级）工具可访问的精确路由表 + 集中关卡的唯一例外。
//
// bridge 与鉴权契约测试共用这一份数据：新增 agent 工具必须在这里显式加路由，
// 否则运行时 403；测试会扫描 MCP 端实际调用并做双向精确比较。
//
// 不可变保证：对外导出的是 Object.freeze 的数组（push 会抛），
// 内部查询用私有 Set —— Object.freeze(new Set()) 冻结不了 Set 的成员，
// 允许表不能被外部 .add() 改掉。

const ROUTE_LIST = Object.freeze([
  'GET /api/status',
  'GET /api/images/message',
  'POST /api/send/group',
  'POST /api/send/private',
  'POST /api/send/reply',
  'POST /api/socialV2/collect-sticker',
  'POST /api/socialV2/feedback',
  'POST /api/socialV2/forward-media',
  'POST /api/socialV2/mark-read',
  'POST /api/socialV2/memory-append',
  'POST /api/socialV2/memory-clear',
  'POST /api/socialV2/memory-remember',
  'POST /api/socialV2/memory-remove',
  'POST /api/socialV2/qzone-list',
  'POST /api/socialV2/qzone-send',
  'POST /api/socialV2/send-burst',
  'POST /api/socialV2/send-message',
  'POST /api/socialV2/send-poke',
  'POST /api/socialV2/send-sticker',
  'POST /api/socialV2/send-voice',
  'POST /api/socialV2/slang/submit',
  'POST /api/socialV2/sticker-list',
  'POST /api/socialV2/sticker-note',
  'POST /api/socialV2/sticker-remark',
  'POST /api/socialV2/wait',
  'POST /api/socialV2/wake-config',
  'GET /api/socialV2/active-members',
  'GET /api/socialV2/forward-message',
  'GET /api/socialV2/memory',
  'GET /api/socialV2/memory-inspect',
  'GET /api/socialV2/memory-profile',
  'GET /api/socialV2/memory-search',
  'GET /api/socialV2/message-detail',
  'GET /api/socialV2/my-recent',
  'GET /api/socialV2/prompt',
  'GET /api/socialV2/recent',
  'GET /api/socialV2/self-image',
  'GET /api/socialV2/slang/query',
  'GET /api/socialV2/state',
  'GET /api/socialV2/sticker-image',
  'GET /api/socialV2/unread',
  'GET /api/socialV2/voices',
]);

const ROUTE_SET = new Set(ROUTE_LIST);

/** 冻结的路由数组（顺序即声明顺序）。 */
export const AGENT_ALLOWED_ROUTES = ROUTE_LIST;

/** 无 agent token 的 x-agent-call 唯一例外：旧只读工具用 GET /api/status 探测运行模式。 */
export const TOKENLESS_STATUS_PROBE = Object.freeze({ method: 'GET', path: '/api/status' });

/** 判断某请求是否命中 agent 工具白名单。 */
export function isAgentAllowedRoute(method, pathname) {
  return ROUTE_SET.has(String(method) + ' ' + String(pathname));
}

/** 判断是否命中 tokenless status probe 例外。 */
export function isTokenlessStatusProbe(method, pathname) {
  return method === TOKENLESS_STATUS_PROBE.method && pathname === TOKENLESS_STATUS_PROBE.path;
}
