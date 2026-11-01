// 记忆银河的 HTTP 安全谓词（bridge 与 hermetic 测试共用同一份逻辑）。
//
// 目的：路由级测试不能再依赖「本机 3100 正在运行」——
// 把 Host 白名单、agent 请求判定抽成纯函数，测试就能起最小 server 复刻同一语义。

/** Host 头是否属于本机回环（含端口的精确匹配；大小写不敏感）。 */
export function isAllowedGalaxyHost(hostHeader, port) {
  const host = String(hostHeader || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

/** 请求是否来自会话级智能体（x-agent-token 或 x-agent-call 任一存在即视为 agent）。 */
export function isAgentRequest(headers = {}) {
  return headers['x-agent-token'] !== undefined || headers['x-agent-call'] !== undefined;
}

/** 供 bridge 与 fixture 共享的银河缓存响应体（不含 token/鉴权，只做状态投影）。 */
export function galaxyCachePayload(cacheResult) {
  if (cacheResult && cacheResult.data) {
    const data = cacheResult.data;
    // 浅拷贝：不原地修改缓存对象（否则 stale 注入的 cacheWarning 会残留在缓存里，
    // 下一次 fresh 投影时还会带着旧警告，并发调用者也会共享被改的对象）。
    const meta = { ...(data.meta || {}) };
    meta.cacheState = cacheResult.state;
    if (cacheResult.state === 'stale' && cacheResult.error) {
      meta.cacheWarning = '最近一次重建失败，当前显示的是旧数据';
    } else {
      delete meta.cacheWarning;
    }
    if (Number.isFinite(cacheResult.retryAfterMs) && cacheResult.retryAfterMs > 0) {
      meta.retryAfterMs = cacheResult.retryAfterMs;
    }
    return { ...data, meta };
  }
  return {
    stars: [], messages: [],
    meta: {
      partial: true, errorCount: 1,
      errors: [{ file: 'galaxy', error: cacheResult && cacheResult.state === 'error' ? 'build-failed' : 'build-pending' }],
      cacheState: cacheResult ? cacheResult.state : 'pending',
      coreLabel: '鱼鱼', coreSub: '她自己', total: 0, pinned: 0, messages: 0,
      avgStrength: 0, sources: { memory: 0, diary: 0, message: 0 },
    },
  };
}
