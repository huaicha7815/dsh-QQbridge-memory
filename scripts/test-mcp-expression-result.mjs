// MCP 层：表达策略拒绝 → 工具结果（会话 C，审查 expression-r2 P2）。
//
// 覆盖：code/kind 透传、isError=false（业务结果不是故障）、文案提示别重试、
// 非表达拒绝返回 null（交给真实故障处理）；HTTP 响应 → Error 的 statusCode/body/code/kind 保留。
import test from 'node:test';
import assert from 'node:assert/strict';

import { expressionVetoResult } from '../src/mcp-expression-result.mjs';
import { apiErrorFromResponse } from '../src/mcp-api-error.mjs';

test('expression_veto：返回非故障工具结果，并带 code/kind 与“别重试”提示', () => {
  const error = new Error('今天没什么心情发表情，用文字说吧');
  error.code = 'expression_veto';
  error.kind = 'sticker';
  const result = expressionVetoResult(error, '发表情');
  assert.ok(result, '应返回结果');
  assert.equal(result.isError, false, '业务拒绝不能标成工具故障');
  const text = result.content[0].text;
  assert.match(text, /这次没发表情/);
  assert.match(text, /expression_veto\/sticker/);
  assert.match(text, /别重试/);
  assert.match(text, /文字/);
});

test('expression_veto：语音 kind 也能透传', () => {
  const error = new Error('今天不想开口说话');
  error.code = 'expression_veto';
  error.kind = 'voice';
  const result = expressionVetoResult(error, '发语音');
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /expression_veto\/voice/);
});

test('非表达拒绝：返回 null，交给真实发送故障处理', () => {
  assert.equal(expressionVetoResult(new Error('网络错误'), '发表情'), null);
  const other = new Error('OneBot 失败');
  other.code = 'SEND_FAILED';
  assert.equal(expressionVetoResult(other, '发表情'), null);
  assert.equal(expressionVetoResult(null, '发表情'), null);
});

// ── HTTP 响应 → Error（审查 expression-r3 P2：200 + ok:false 也要保留 statusCode）──

test('apiErrorFromResponse：200 + ok:false 保留 statusCode/body/code/kind', () => {
  const body = { ok: false, code: 'expression_veto', kind: 'sticker', error: '今天没什么心情发表情' };
  const error = apiErrorFromResponse({ status: 200, body, fallback: '桥接 API 返回 ok:false（未说明原因）' });
  assert.equal(error.statusCode, 200, '业务拒绝也是 HTTP 200，必须保留 statusCode');
  assert.equal(error.code, 'expression_veto');
  assert.equal(error.kind, 'sticker');
  assert.deepEqual(error.body, body);
  assert.match(error.message, /今天没什么心情/);
  // expressionVetoResult 能直接消费它
  const result = expressionVetoResult(error, '发表情');
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /expression_veto\/sticker/);
});

test('apiErrorFromResponse：非 2xx 保留状态/body，无 code 时不伪造', () => {
  const error = apiErrorFromResponse({ status: 503, body: { error: '服务不可用' } });
  assert.equal(error.statusCode, 503);
  assert.equal(error.body.error, '服务不可用');
  assert.equal(error.code, undefined);
  assert.equal(error.kind, undefined);
  // 非 JSON body（null）也用 fallback 文案
  const raw = apiErrorFromResponse({ status: 500, body: null, fallback: '桥接 API HTTP 500' });
  assert.equal(raw.statusCode, 500);
  assert.equal(raw.body, null);
  assert.match(raw.message, /500|服务/);
});
