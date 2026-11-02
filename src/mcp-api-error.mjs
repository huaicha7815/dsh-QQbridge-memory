// 桥接 HTTP 响应 → Error（纯函数，可单测）。
//
// MCP 的 agentApi 有两类失败：
//   1. 非 2xx（服务/鉴权/参数错误）；
//   2. HTTP 200 + `{ok:false, ...}`（桥接用业务结果表达拒绝，例如出站审计拦截、
//      expression_veto 情绪节奏拒绝）。
// 两类都必须把 status/body/code/kind 完整带到 Error 上——否则上层只能看到一句文案，
// 无法区分「业务拒绝」和「真实故障」，也无法做结构化处理。
//
// 放在独立模块里是为了能被 node:test 直接 import（mcp-snowluma-safe.js 是 stdio server 入口，
// 加载即创建 server，不适合单测）。

/**
 * @param {object} input
 * @param {number} input.status HTTP 状态码（200 的 ok:false 也要保留 200）
 * @param {object|null} [input.body] 已解析的响应体
 * @param {string} [input.fallback] body 没有 error 字段时的兜底文案
 * @returns {Error & {statusCode: number, body: object|null, code?: string, kind?: string}}
 */
export function apiErrorFromResponse({ status, body = null, fallback } = {}) {
  const message = (body && typeof body === 'object' && body.error)
    || fallback
    || `桥接 API HTTP ${status}`;
  const error = new Error(message);
  error.statusCode = status;
  error.body = body ?? null;
  if (body && typeof body === 'object') {
    if (body.code) error.code = body.code;
    if (body.kind) error.kind = body.kind;
  }
  return error;
}
