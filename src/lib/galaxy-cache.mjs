// 记忆银河缓存状态机（可注入依赖，便于无 bridge 单测）。
//
// 状态：
//   fresh   —— 缓存命中（TTL 内）
//   stale   —— 有缓存但已过期：先返回旧数据，同时触发一次后台重建
//   pending —— 没有缓存、正在构建
//   error   —— 没有缓存、构建失败（不能伪装成空库）
//
// 失败冷却：构建失败后进入指数退避（2s → 60s 封顶），冷却期内只返回最近错误，
// 不再排新的构建，避免持续流量下每个请求都触发一次重建（重试风暴）。
//
// single-flight：并发请求只会启动一次构建。
export function createGalaxyCache({
  build,
  readFile,
  file,
  ttlMs = 60_000,
  now = () => Date.now(),
  schedule = (fn) => setImmediate(fn),
} = {}) {
  if (typeof build !== 'function') throw new TypeError('createGalaxyCache: build 必须是函数');
  if (typeof readFile !== 'function') throw new TypeError('createGalaxyCache: readFile 必须是函数');
  if (!file) throw new TypeError('createGalaxyCache: file 必填');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('createGalaxyCache: ttlMs 必须是正数');
  if (typeof now !== 'function') throw new TypeError('createGalaxyCache: now 必须是函数');
  if (typeof schedule !== 'function') throw new TypeError('createGalaxyCache: schedule 必须是函数');

  const RETRY_MIN_MS = 2_000;
  const RETRY_MAX_MS = 60_000;

  let data = null;
  let at = 0;
  let building = false;
  let lastError = null;
  let retryDelayMs = RETRY_MIN_MS;
  let nextRetryAt = 0;
  let pendingBuild = null;

  function runBuild() {
    building = false;
    try {
      build(file);
      const text = readFile(file);
      if (!text) throw new Error('构建后读取为空');
      data = JSON.parse(text);
      at = now();
      lastError = null;
      retryDelayMs = RETRY_MIN_MS;
      nextRetryAt = 0;
    } catch (e) {
      lastError = String(e?.message ?? e);
      nextRetryAt = now() + retryDelayMs;
      retryDelayMs = Math.min(RETRY_MAX_MS, retryDelayMs * 2);
    }
  }

  function scheduleBuild() {
    if (building) return;
    building = true;
    pendingBuild = () => {
      pendingBuild = null;
      runBuild();
    };
    schedule(pendingBuild);
  }

  function inCooldown() {
    return lastError != null && now() < nextRetryAt;
  }

  return {
    getData() {
      const fresh = data != null && now() - at < ttlMs;
      if (fresh) return { state: 'fresh', data, error: lastError };
      if (data != null) {
        // stale-while-revalidate：先给旧数据；冷却期内不重复排构建
        if (!inCooldown()) scheduleBuild();
        return { state: 'stale', data, error: lastError };
      }
      if (inCooldown()) {
        return { state: 'error', data: null, error: lastError };
      }
      scheduleBuild();
      return { state: 'pending', data: null, error: lastError };
    },
    warm() {
      if (!inCooldown()) scheduleBuild();
    },
    reset() {
      data = null;
      at = 0;
      building = false;
      lastError = null;
      retryDelayMs = RETRY_MIN_MS;
      nextRetryAt = 0;
      pendingBuild = null;
    },
    /** 测试用：立即执行挂起的构建（生产环境不要调用）。 */
    flush() {
      if (pendingBuild) pendingBuild();
    },
    /** 测试/诊断用：当前是否正在构建。 */
    isBuilding() {
      return building;
    },
    /** 测试/诊断用：最近一次失败原因与冷却截止时间。 */
    diagnostics() {
      return { lastError, retryDelayMs, nextRetryAt, at, building };
    },
  };
}
