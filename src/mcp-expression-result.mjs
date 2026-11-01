// 表达策略拒绝 → MCP 工具结果（纯函数，可单测）。
//
// 桥接对「情绪节奏拒绝发表情/语音」返回 HTTP 200 + `{ok:false, code:'expression_veto', kind}`。
// MCP 的 agentApi 会把它抛成带 code/kind 的 Error；这里负责把「业务拒绝」翻译成
// **非故障**的工具结果：isError=false + 明确告诉模型「别重试，改用文字」。
//
// 放在独立模块里是为了能被 node:test 直接 import（mcp-snowluma-safe.js 是 stdio server 入口，
// 加载即创建 server，不适合单测）。

/**
 * @param {Error & {code?: string, kind?: string}} error
 * @param {'发表情'|'发语音'} label 动作名（用于文案）
 * @returns {{content: Array<{type:'text', text:string}>, isError: boolean} | null}
 *   不是表达拒绝时返回 null（调用方继续按真实故障处理）。
 */
export function expressionVetoResult(error, label = '发送') {
  if (!error || error.code !== 'expression_veto') return null;
  const kind = error.kind ?? 'expression';
  return {
    content: [{
      type: 'text',
      text: `这次没${label}：${error.message ?? error}（expression_veto/${kind}）。这不是发送故障，别重试，改用文字表达。`,
    }],
    isError: false,
  };
}
