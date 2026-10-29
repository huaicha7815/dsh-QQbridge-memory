/**
 * 长期记忆的文件层 + 检索引擎（memory-lib 的 I/O 外壳）。
 *
 * 目录布局（state/memory/）：
 *   events/YYYY-MM-DD.jsonl   一行一条事件，append-only，永久保留（除非配了 eventRetentionDays）
 *   days/YYYY-MM-DD.json      当天事件的规则化摘要（只收 S1+，S0 寒暄不进）
 *   weeks/YYYY-Www.json       周要点：从 7 天摘要里再压一级（S2/S3 优先）
 *   months/YYYY-MM.json       月要点：从 4 个周要点里再压一级（只留 S3）
 *   salient.jsonl             S3 关键事件的独立副本（「重要的事单独存」）
 *   profile.json              人物档案 / 未完结的线 / 自我状态
 *
 * 这就是「越新越清楚、越久越精简」的物理形态：
 *   近 60 天看原始消息 + 日摘要，半年前看周要点，更早看月要点——信息密度逐级升高，
 *   但原始事件一条都没删。
 *
 * 一切写入都是「追加」或「整体小文件重写」，没有数据库，也不需要：
 * 一天几百条消息 × 几百字节 = 每天几十 KB，一年也就几十 MB，检索靠内存 BM25 毫秒级完成。
 *
 * 这里的缓存只按「路径 + size + mtime」失效，所以桥接重启/外部改动都不会读到脏数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  consolidateMonth,
  consolidateWeek,
  correctPersonFact,
  echoMatch,
  ensureProfile,
  normalizeMemoryConfig,
  pruneProfile,
  rankDocuments,
  salience,
  summarizeDay,
  tokenize,
  truncateChars,
} from './memory-lib.mjs';

const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl?$/;
const WEEK_RE = /^(\d{4}-W\d{2})\.json$/;
const MONTH_RE = /^(\d{4}-\d{2})\.json$/;
const ARCHIVE_RE = /^(\d{4}-\d{2})\.jsonl$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时区的 YYYY-MM-DD（不用 UTC，否则凌晨的消息会记到前一天）。 */
export function dayString(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时区的 ISO 周（周一开始），如 2026-W43。 */
export function isoWeekString(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = t.getDay() || 7; // 周日算第 7 天
  t.setDate(t.getDate() + 4 - dayNum);
  const yearStart = new Date(t.getFullYear(), 0, 1);
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return `${t.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 本地时区的 YYYY-MM。 */
export function monthString(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 从 YYYY-MM-DD 取当天中午的时间戳（与 summarizeDay 保持一致）。 */
function dayNoon(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 0;
  return new Date(y, m - 1, d, 12, 0, 0).getTime();
}

function shiftDay(day, delta) {
  const ts = dayNoon(day);
  if (!ts) return dayString();
  return dayString(ts + delta * 86400000);
}

function listDaysUpTo(day, days) {
  const out = [];
  const count = Math.max(1, Number(days) || 1);
  const end = day || dayString();
  for (let i = 0; i < count; i += 1) out.push(shiftDay(end, -i));
  return out.filter(Boolean);
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // 文件存在但解析失败 ≠ 文件不存在。以前一律返回 fallback，
    // 于是损坏的 profile.json 会被当成「空档案」，下一次写入直接覆盖掉原文件——
    // 表现为「QQ 正常聊天但档案悄悄没了」。这里先备份坏文件再降级。
    if (error && error.code !== 'ENOENT') {
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
        console.warn(`[memory] JSON 损坏已备份 ${path.basename(file)}: ${error.message}`);
      } catch {
        // 备份也失败就只能降级，至少不抛出
      }
    }
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

/** 摘要里的 lines 兼容两种格式（V3.0 字符串 / V3.1 对象）。 */
function lineText(l) {
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object' && l.t) return String(l.t);
  return '';
}

/**
 * @param {{dir:string, config?:object}} options
 */
export function createMemoryStore(options = {}) {
  const root = path.resolve(String(options.dir || 'state/memory'));
  const eventsDir = path.join(root, 'events');
  const archiveDir = path.join(root, 'events-archive');
  const daysDir = path.join(root, 'days');
  const weeksDir = path.join(root, 'weeks');
  const monthsDir = path.join(root, 'months');
  const salientFile = path.join(root, 'salient.jsonl');
  const profileFile = path.join(root, 'profile.json');
  // 事件写入失败计数与最后一次错误（健康检查会读它判断「L1 是否悄悄缺数据」）
  // 失败计数从持久文件读初始值：以前是纯进程内变量，重启就归零，
  // 于是「刚丢过数据」这件事在健康页上看不出来。
  const writeFailFile = path.join(root, 'write-failures.jsonl');
  function readFailureLines() {
    try {
      return fs.readFileSync(writeFailFile, 'utf8').split('\n').filter(Boolean);
    } catch { return []; }
  }
  const initialFailLines = readFailureLines();
  let writeFailureCount = initialFailLines.length;
  let lastWriteFailure = (() => {
    // 重启后也要能说清「最近一次失败是什么」：从清单最后一行还原。
    const last = initialFailLines[initialFailLines.length - 1];
    if (!last) return null;
    try {
      const item = JSON.parse(last);
      return { at: Number(item.at) || 0, error: String(item.error ?? ''), phase: String(item.phase ?? '') };
    } catch { return null; }
  })();
  let cfg = normalizeMemoryConfig(options.config);

  // 文件解析缓存：key=绝对路径，value={size, mtimeMs, rows}
  const cache = new Map();
  // 分词缓存：key=事件行对象（readDayEvents 返回的是缓存数组里的同一批引用）。
  // 这样每次唤醒检索都不会把几天/几十天前的历史消息重新分一遍词。
  const tokenCache = new WeakMap();
  // S3 独立副本的去重索引（懒加载）
  let salientIndex = null;
  // 档案 token 缓存（30 秒）：回音判断要对每条归档消息做，不能每条都读文件 + 重新分词。
  let profileTokenCache = { at: 0, sets: [] };

  /** 档案里所有「已知文本」的 token 集合，用于识别她在复述自己的记忆。 */
  function profileTokenSets() {
    const now = Date.now();
    if (now - profileTokenCache.at < 30000) return profileTokenCache.sets;
    const p = readProfile();
    const texts = [
      ...Object.values(p.people).flatMap((v) => (v.facts || []).map((f) => f.text)),
      ...p.threads.map((t) => t.text),
      // V3.9 起 self 是对象（带 kind/at），这里只要文本
      ...p.self.map((s) => (typeof s === 'string' ? s : s?.text)),
    ].filter(Boolean);
    const sets = texts.map((t) => new Set(tokenize(t))).filter((s) => s.size > 0);
    profileTokenCache = { at: now, sets };
    return sets;
  }

  function invalidateProfileTexts() {
    profileTokenCache = { at: 0, sets: [] };
  }

  function tokensOf(row, text) {
    let tokens = tokenCache.get(row);
    if (!tokens) {
      tokens = tokenize(text);
      tokenCache.set(row, tokens);
    }
    return tokens;
  }

  function configure(raw) {
    cfg = normalizeMemoryConfig({ ...cfg, ...(raw && typeof raw === 'object' ? raw : {}) });
    return cfg;
  }

  function getConfig() {
    return { ...cfg };
  }

  function ensureDirs() {
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.mkdirSync(daysDir, { recursive: true });
  }

  /** 读某天的事件行（带缓存）。返回数组，解析失败的行静默跳过。 */
  function readDayEvents(day) {
    const file = path.join(eventsDir, `${day}.jsonl`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      cache.delete(file);
      return [];
    }
    const hit = cache.get(file);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.rows;
    let rows = [];
    try {
      const text = fs.readFileSync(file, 'utf8');
      rows = text.split('\n').filter(Boolean).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      rows = [];
    }
    cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, rows });
    return rows;
  }

  function salientKey(row) {
    return `${Number(row.t) || 0}|${String(row.k || '')}|${String(row.text || '').slice(0, 60)}`;
  }

  function loadSalientIndex() {
    if (salientIndex) return salientIndex;
    salientIndex = new Set();
    try {
      for (const line of fs.readFileSync(salientFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          salientIndex.add(salientKey(JSON.parse(line)));
        } catch {}
      }
    } catch {
      // 文件还不存在
    }
    return salientIndex;
  }

  /** 把一行写进当天 L1 事件文件。 */
  function writeEventRow(row) {
    const day = dayString(Number(row.t) || Date.now());
    const file = path.join(eventsDir, `${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    cache.delete(file);
  }

  /** 写 S3 独立副本（只对 tier>=3 且配置开启时）。 */
  function writeSalientRow(row, day, tier) {
    if (!cfg.salientFile || Number(tier) < 3) return;
    const index = loadSalientIndex();
    const key = salientKey(row);
    if (index.has(key)) return;
    fs.appendFileSync(salientFile, JSON.stringify({ ...row, srcDay: day }) + '\n', 'utf8');
    index.add(key);
  }

  /**
   * 记录一次写入失败。
   * phase=event 表示主事件没进 L1（需要 replay 补写）；
   * phase=salient 表示主事件已成功、只有 S3 副本没写（replay 只补副本）。
   */
  function recordWriteFailure(phase, row, error) {
    console.warn(`[memory] 事件写入失败(${phase}):`, error?.message ?? error);
    writeFailureCount += 1;
    lastWriteFailure = { at: Date.now(), error: String(error?.message ?? error), phase };
    try {
      fs.appendFileSync(writeFailFile, JSON.stringify({
        at: Date.now(), phase, id: row?.id, row,
        error: String(error?.message ?? error),
      }) + '\n', 'utf8');
    } catch {
      // 连清单都写不进去，只能靠 console.warn
    }
  }

  /**
   * 追加一条事件。
   * 重要度在写入时就算好（`s` 字段），之后检索/摘要都直接用它，不必反复判。
   * S3 事件额外双写一份到 salient.jsonl（「重要的事单独存」）。
   */
  function appendEvent(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const ts = Number(entry.t) || Date.now();
    const day = dayString(ts);
    const tier = Number.isInteger(entry.s) ? entry.s : salience(entry);
    // 稳定 id：replay 靠它判重，避免「写了但清单没清掉」导致重复入 L1。
    const id = String(entry.id ?? '').trim() || `${ts.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const row = { ...entry, t: ts, s: tier, id };
    delete row.day;
    // 回音标记：她把自己记得的事又当新消息说了一遍。
    // 不阻止归档（那还是她真实说过的话），只是让它在检索里降权，
    // 避免「复述记忆 → 归档 → 下次命中 → 强化记忆」的自我循环。
    if ((row.kind === 'msg' || row.kind === 'self') && !row.echo) {
      try {
        if (echoMatch(row.text, profileTokenSets())) row.echo = 1;
      } catch {
        // 回音判断失败不影响归档
      }
    }
    // 主事件与 S3 副本分开写、分开记失败。
    // 以前一个 try 包住两段：S3 写失败时主事件其实已经落盘了，
    // 但整条仍被记进失败清单 → replay 再写一次主事件 → L1 出现重复。
    try {
      ensureDirs();
      writeEventRow(row);
    } catch (error) {
      recordWriteFailure('event', row, error);
      return false;
    }
    try {
      writeSalientRow(row, day, tier);
    } catch (error) {
      // 主事件已经在 L1 里了，这里只是 S3 副本没写成功：记成 salient 阶段，
      // replay 时只补副本，不会重复写主事件。
      recordWriteFailure('salient', row, error);
    }
    return true;
  }

  /** 列出有事件文件的所有日期（升序）。 */
  function listEventDays() {
    let names = [];
    try {
      names = fs.readdirSync(eventsDir);
    } catch {
      return [];
    }
    return names
      .map((name) => DAY_RE.exec(name)?.[1])
      .filter(Boolean)
      .sort();
  }

  /** 列出已归档的月份（events-archive/YYYY-MM.jsonl）。 */
  function listArchiveMonths() {
    let names = [];
    try {
      names = fs.readdirSync(archiveDir);
    } catch {
      return [];
    }
    return names
      .map((name) => ARCHIVE_RE.exec(name)?.[1])
      .filter(Boolean)
      .sort();
  }

  /** 读一个归档月的全部事件（带缓存）。 */
  function readArchiveMonth(month) {
    const file = path.join(archiveDir, `${month}.jsonl`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return [];
    }
    const hit = cache.get(file);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.rows;
    let rows = [];
    try {
      rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      rows = [];
    }
    cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, rows });
    return rows;
  }

  /**
   * 把超过 olderThanDays 的日文件按月合并进 events-archive/YYYY-MM.jsonl，然后删掉日文件。
   *
   * 为什么做：一天一个文件，三年就是 1095 个目录项；合并成月文件后只有 36 个。
   * 检索窗口默认 60 天，根本碰不到归档；只有 AI 主动深挖（days 很大）时才会读归档。
   * 幂等：日文件删掉后不会重复追加。
   */
  function archiveOldEvents({ olderThanDays, now = Date.now() } = {}) {
    const keepDays = Math.max(1, Number(olderThanDays ?? cfg.eventArchiveAfterDays) || 90);
    const cutoff = shiftDay(dayString(now), -keepDays);
    const byMonth = new Map();
    for (const day of listEventDays()) {
      if (day >= cutoff) continue;
      const month = day.slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(day);
    }
    let moved = 0;
    for (const [month, days] of byMonth) {
      // 去重：归档是「先写月文件、再删日文件」，中间失败/进程中断后重跑会把
      // 同一批事件再 append 一次。写入时给每行打 srcDay 标记，重跑时先读出
      // 月文件里已有的 srcDay，跳过这些天。
      const alreadyArchived = (() => {
        const set = new Set();
        try {
          for (const line of fs.readFileSync(path.join(archiveDir, `${month}.jsonl`), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { const row = JSON.parse(line); if (row && row.srcDay) set.add(String(row.srcDay)); } catch { /* 旧格式行没有 srcDay */ }
          }
        } catch { /* 还没有归档文件 */ }
        return set;
      })();
      const pending = days.sort().filter((d) => !alreadyArchived.has(d));
      if (!pending.length) continue;
      let content = '';
      // 只把「成功读入」的日期算作已归档；读失败/解析失败的那天必须保留文件，
      // 否则会先删掉源文件却没写进归档 —— L1 数据不可恢复地丢失。
      const archivedOk = [];
      for (const day of pending) {
        try {
          const raw = fs.readFileSync(path.join(eventsDir, `${day}.jsonl`), 'utf8');
          let chunk = '';
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            chunk += JSON.stringify({ ...JSON.parse(line), srcDay: day }) + '\n';
          }
          content += chunk;
          archivedOk.push(day);
        } catch (error) {
          console.warn('[memory] 归档跳过该日（保留源文件）:', day, error?.message ?? error);
        }
      }
      if (!content) continue;
      try {
        fs.mkdirSync(archiveDir, { recursive: true });
        fs.appendFileSync(path.join(archiveDir, `${month}.jsonl`), content, 'utf8');
        for (const day of archivedOk) {
          const f = path.join(eventsDir, `${day}.jsonl`);
          try {
            fs.unlinkSync(f);
          } catch {}
          cache.delete(f);
        }
        moved += archivedOk.length;
      } catch {
        // 归档失败就留着日文件，不影响检索
      }
    }
    return moved;
  }

  /** 读最近 days 天的事件（升序拼接）。窗口跨到归档期时会一并读入月文件。 */
  function readEvents({ days, now = Date.now(), upTo } = {}) {
    const want = Math.max(1, Number(days) || cfg.searchDays);
    const start = upTo || dayString(now);
    const wanted = new Set(listDaysUpTo(start, want));
    const out = [];
    for (const day of listEventDays()) {
      if (!wanted.has(day)) continue;
      out.push(...readDayEvents(day));
    }
    // 只有请求窗口覆盖到归档期（默认 90 天前）才去读月文件
    const earliest = [...wanted].sort()[0];
    if (earliest) {
      for (const month of listArchiveMonths()) {
        // 该月最后一天仍早于窗口起点 → 整个月都不需要
        if (`${month}-31` < earliest) continue;
        for (const row of readArchiveMonth(month)) {
          if (wanted.has(dayString(Number(row.t) || now))) out.push(row);
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 压缩链：日 → 周 → 月
  // -------------------------------------------------------------------------

  /**
   * 为缺失的日期生成日摘要（纯规则，0 次 LLM 调用）。
   * 已在 days/ 里存在的日期直接跳过，所以重启/多天补算都很便宜。
   */
  /** 当天事件文件的指纹（大小 + mtime）：摘要据此判断是否需要重算。 */
  function dayFingerprint(day) {
    try {
      const stat = fs.statSync(path.join(eventsDir, `${day}.jsonl`));
      return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    } catch {
      return '';
    }
  }

  function ensureDaySummaries({ upTo, now = Date.now(), maxDays = 400 } = {}) {
    const end = upTo || dayString(now);
    const existing = new Set();
    try {
      for (const name of fs.readdirSync(daysDir)) {
        const day = DAY_RE.exec(name)?.[1];
        if (day && name.endsWith('.json')) existing.add(day);
      }
    } catch {
      // days/ 还没建，expected
    }
    let created = 0;
    const days = listEventDays().filter((d) => d <= end);
    // 关键：不能「文件存在就跳过」。当天摘要生成后还会不断有新消息进来，
    // 只按存在性判断会让摘要永久停留在第一次生成的版本（用户反馈：她说想不起来）。
    // 用「事件文件大小 + mtime」做指纹，变了就重算这一天的摘要。
    const todo = days.filter((d) => {
      if (!existing.has(d)) return true;
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(path.join(daysDir, `${d}.json`), 'utf8')); } catch { return true; }
      if (!prev || typeof prev !== 'object') return true;
      return prev.srcFingerprint !== dayFingerprint(d);
    }).slice(-Math.max(1, Number(maxDays) || 400));
    for (const day of todo) {
      const events = readDayEvents(day);
      const summary = summarizeDay(events, day);
      const payload = summary && summary.count >= cfg.summaryMinEvents
        ? summary
        : { day, ts: dayNoon(day), count: summary?.count || 0, keys: [], people: [], lines: [], tiers: [0, 0, 0, 0], skipped: true };
      try {
        // 记录生成时的指纹，供下次判断「这一天是否又有了新消息」
        writeJsonFile(path.join(daysDir, `${day}.json`), { ...payload, srcFingerprint: dayFingerprint(day) });
        created += 1;
      } catch {
        // 单天写失败不影响其它天
      }
    }
    return created;
  }

  function readDaySummary(day) {
    const file = path.join(daysDir, `${day}.json`);
    const val = readJsonFile(file, null);
    if (!val || val.skipped || !Array.isArray(val.lines) || !val.lines.length) return null;
    return val;
  }

  /** 读最近 days 天的日摘要（升序）。 */
  function readSummaries({ days, now = Date.now(), upTo } = {}) {
    const want = Math.max(1, Number(days) || cfg.searchDays);
    const start = upTo || dayString(now);
    const out = [];
    for (const day of listDaysUpTo(start, want)) {
      const s = readDaySummary(day);
      if (s) out.push(s);
    }
    return out;
  }

  function listWeekFiles() {
    let names = [];
    try {
      names = fs.readdirSync(weeksDir);
    } catch {
      return [];
    }
    return names.map((n) => WEEK_RE.exec(n)?.[1]).filter(Boolean).sort();
  }

  function listMonthFiles() {
    let names = [];
    try {
      names = fs.readdirSync(monthsDir);
    } catch {
      return [];
    }
    return names.map((n) => MONTH_RE.exec(n)?.[1]).filter(Boolean).sort();
  }

  /**
   * 为「已经过完」的周生成周要点（当前周还没走完，不生成，避免天天重算）。
   * 只处理最近 cfg.consolidateWeeks 周。
   */
  function ensureWeekNotes({ now = Date.now() } = {}) {
    const currentWeek = isoWeekString(now);
    const have = new Set(listWeekFiles());
    const byWeek = new Map();
    for (const day of listEventDays()) {
      const week = isoWeekString(dayNoon(day) || now);
      if (week >= currentWeek) continue; // 当前周及未来不处理
      if (have.has(week)) continue;
      if (!byWeek.has(week)) byWeek.set(week, []);
      byWeek.get(week).push(day);
    }
    let created = 0;
    const weeks = [...byWeek.keys()].sort().slice(-Math.max(1, Number(cfg.consolidateWeeks) || 52));
    for (const week of weeks) {
      const summaries = byWeek.get(week).sort().map((d) => readDaySummary(d)).filter(Boolean);
      const note = consolidateWeek(summaries, week, { minLines: 5, maxLines: 10 });
      if (!note) continue;
      try {
        writeJsonFile(path.join(weeksDir, `${week}.json`), note);
        created += 1;
      } catch {}
    }
    return created;
  }

  /** 为「已经过完」的月生成月要点。 */
  function ensureMonthNotes({ now = Date.now() } = {}) {
    const currentMonth = monthString(now);
    const have = new Set(listMonthFiles());
    const byMonth = new Map();
    for (const week of listWeekFiles()) {
      if (week >= isoWeekString(now)) continue;
      // 周归属月份：用该周周四（ISO 周的中位日）判断，避免跨月周算错。
      const month = monthString(weekStartTs(week) + 3 * 86400000);
      if (month >= currentMonth) continue;
      if (have.has(month)) continue;
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(week);
    }
    let created = 0;
    const months = [...byMonth.keys()].sort().slice(-Math.max(1, Number(cfg.consolidateMonths) || 60));
    for (const month of months) {
      const notes = byMonth.get(month).sort()
        .map((w) => readJsonFile(path.join(weeksDir, `${w}.json`), null))
        .filter(Boolean);
      const note = consolidateMonth(notes, month, { minLines: 3, maxLines: 8 });
      if (!note) continue;
      try {
        writeJsonFile(path.join(monthsDir, `${month}.json`), note);
        created += 1;
      } catch {}
    }
    return created;
  }

  /** ISO 周对应的周一 0 点时间戳。 */
  function weekStartTs(week) {
    const m = /^(\d{4})-W(\d{2})$/.exec(String(week));
    if (!m) return Date.now();
    const year = Number(m[1]);
    const weekNo = Number(m[2]);
    // 1 月 4 日一定在第一周内（ISO 8601 定义）
    const jan4 = new Date(year, 0, 4);
    const jan4Day = jan4.getDay() || 7;
    const week1Monday = new Date(year, 0, 4 - (jan4Day - 1));
    return week1Monday.getTime() + (weekNo - 1) * 7 * 86400000;
  }

  /** 一次补齐日 → 周 → 月全部压缩层，并把过旧的日事件按月归档。启动与每日日记时调用。 */
  function ensureConsolidation({ now = Date.now(), maxDays } = {}) {
    const days = ensureDaySummaries({ now, maxDays });
    const weeks = ensureWeekNotes({ now });
    const months = ensureMonthNotes({ now });
    // 归档必须放在摘要之后：先把日文件读成摘要，再删日文件。
    const archived = archiveOldEvents({ now });
    return { days, weeks, months, archived };
  }

  /** 读最近 N 个周要点（按时间升序）。 */
  function readWeekNotes({ weeks, now = Date.now() } = {}) {
    const limit = Math.max(1, Number(weeks) || cfg.consolidateWeeks || 52);
    const cutoff = now - limit * 7 * 86400000;
    const out = [];
    for (const week of listWeekFiles()) {
      const ts = weekStartTs(week);
      if (ts < cutoff) continue;
      const note = readJsonFile(path.join(weeksDir, `${week}.json`), null);
      if (note && Array.isArray(note.lines) && note.lines.length) out.push(note);
    }
    return out;
  }

  /** 读最近 N 个月的月要点（按时间升序）。 */
  function readMonthNotes({ months, now = Date.now() } = {}) {
    const limit = Math.max(1, Number(months) || cfg.consolidateMonths || 60);
    const cutoff = now - limit * 31 * 86400000;
    const out = [];
    for (const month of listMonthFiles()) {
      const [y, m] = month.split('-').map(Number);
      if (!Number.isFinite(y) || !Number.isFinite(m)) continue;
      const ts = new Date(y, m - 1, 15, 12, 0, 0).getTime();
      if (ts < cutoff) continue;
      const note = readJsonFile(path.join(monthsDir, `${month}.json`), null);
      if (note && Array.isArray(note.lines) && note.lines.length) out.push(note);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 档案与检索
  // -------------------------------------------------------------------------

  function readProfile() {
    return ensureProfile(readJsonFile(profileFile, null));
  }

  function writeProfile(profile) {
    const p = pruneProfile(ensureProfile(profile));
    try {
      writeJsonFile(profileFile, p);
      invalidateProfileTexts();
      return true;
    } catch {
      return false;
    }
  }

  /** 读 S3 独立副本（最近的在前），给「重要的事」展示用。 */
  function readSalient({ limit = 50 } = {}) {
    const out = [];
    try {
      for (const line of fs.readFileSync(salientFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {}
      }
    } catch {
      return [];
    }
    return out.slice(-Math.max(1, Number(limit) || 50)).reverse();
  }

  // -------------------------------------------------------------------------
  // 记忆热度（usage）：被检索命中过的记忆加权，长期没被用到的自然沉底。
  // 出处：MemoryOS 的「热度更新」、Mem0 的访问频率；纯本地、零 token。
  // -------------------------------------------------------------------------
  const usageFile = path.join(root, 'usage.json');
  let usageCache = null;

  function loadUsage() {
    if (usageCache) return usageCache;
    const raw = readJsonFile(usageFile, null);
    usageCache = raw && typeof raw === 'object' && raw.hits && typeof raw.hits === 'object'
      ? { v: 1, hits: raw.hits }
      : { v: 1, hits: {} };
    return usageCache;
  }

  function usageOf(id) {
    if (!id) return 0;
    const u = loadUsage().hits[id];
    return u ? Number(u.n) || 0 : 0;
  }

  function flushUsage() {
    if (!usageCache) return;
    try {
      // 只保留最近 usageRetentionDays 天被命中过的，再按次数截到 5000 条，防止文件无限膨胀。
      const cutoff = Date.now() - (Number(cfg.usageRetentionDays) || 30) * 86400000;
      const entries = Object.entries(usageCache.hits)
        .filter(([, v]) => v && Number(v.t) >= cutoff)
        .sort((a, b) => (Number(b[1].n) || 0) - (Number(a[1].n) || 0));
      usageCache.hits = Object.fromEntries(entries.slice(0, 5000));
      writeJsonFile(usageFile, { v: 1, hits: usageCache.hits });
    } catch {
      // 热度是辅助信号，写失败不影响检索
    }
  }

  function recordHits(hits) {
    if (!Array.isArray(hits) || !hits.length) return;
    const usage = loadUsage();
    const now = Date.now();
    for (const h of hits) {
      if (!h || !h.id) continue;
      const cur = usage.hits[h.id] || { n: 0, t: 0 };
      cur.n = (Number(cur.n) || 0) + 1;
      cur.t = now;
      usage.hits[h.id] = cur;
    }
    scheduleUsageFlush();
  }

  /**
   * 热度延迟落盘：每次检索都重写整个 usage.json 会在高频唤醒下产生大量同步 IO
   * （实测 8ms/次）。改成 3 秒合并写一次，崩了最多丢几秒的计数，热度本来就是辅助信号。
   */
  let usageTimer = null;
  function scheduleUsageFlush() {
    if (usageTimer) return;
    usageTimer = setTimeout(() => {
      usageTimer = null;
      flushUsage();
    }, 3000);
    usageTimer.unref?.();
  }

  /** 立即把待写热度落盘（进程退出 / 显式需要时调用）。 */
  function flushUsageNow() {
    if (usageTimer) {
      clearTimeout(usageTimer);
      usageTimer = null;
    }
    flushUsage();
  }

  /** 检索多样性：同一天/同一个人最多占 perDayMax / perWhoMax 条，避免 6 条结果全是同一段闲聊。 */
  function applyDiversity(hits, limit) {
    const perDay = Math.max(1, Number(cfg.perDayMax) || 2);
    const perWho = Math.max(1, Number(cfg.perWhoMax) || 2);
    const dayCount = new Map();
    const whoCount = new Map();
    const out = [];
    for (const h of hits) {
      if (!h) continue;
      const dk = h.day || h.week || h.month || '';
      const wk = String(h.who || '');
      if (dk && (dayCount.get(dk) || 0) >= perDay) continue;
      if (wk && (whoCount.get(wk) || 0) >= perWho) continue;
      if (dk) dayCount.set(dk, (dayCount.get(dk) || 0) + 1);
      if (wk) whoCount.set(wk, (whoCount.get(wk) || 0) + 1);
      out.push(h);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 记忆热度概况（给 stats / 控制台看）。 */
  function usageStats() {
    const hits = loadUsage().hits;
    const entries = Object.values(hits);
    const totalHits = entries.reduce((sum, v) => sum + (Number(v?.n) || 0), 0);
    const hot = entries.filter((v) => (Number(v?.n) || 0) >= 3).length;
    return { tracked: entries.length, totalHits, warm: hot };
  }

  /**
   * 检索：事件流 + 日摘要 + 周要点 + 月要点混合排序（BM25 + **分档**时间衰减），零 token。
   *
   * 粒度越粗的层 salience 越高（周 2 / 月 3），因为它们已经是浓缩过的「那阵子发生了什么」；
   * 具体事件按自己的档位衰减（寒暄 3 天沉底、关键几乎不衰减）。
   *
   * @returns {Array<{kind:'event'|'day'|'week'|'month', ts:number, text:string, score:number}>}
   */
  function search(query, opts = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const now = Number(opts.now) || Date.now();
    const days = Math.max(1, Number(opts.days) || cfg.searchDays);
    const topK = Math.max(1, Number(opts.topK) || cfg.searchTopK);

    const eventDocs = readEvents({ days, now }).map((e) => {
      const who = e.kind === 'self' ? '你' : String(e.who || '人');
      const text = `${who}：${String(e.text || '')}`;
      const tier = Number.isInteger(e.s) ? e.s : salience(e);
      const id = `e:${e.t}:${e.k || ''}`;
      return {
        id,
        kind: 'event',
        ts: Number(e.t) || 0,
        day: dayString(Number(e.t) || now),
        k: e.k || '',
        who,
        salience: tier,
        usageHits: usageOf(id),
        echo: !!e.echo,
        // 承诺/关系类事件额外加权：它们是最难被替代的记忆
        weight: (e.echo ? 0.4 : 1) * (/(答应|说好|欠|明天|下次|以后|约定|生日|喜欢|讨厌)/.test(String(e.text || '')) ? 1.35 : 1),
        tokens: tokensOf(e, text),
        text,
      };
    });

    const dayDocs = readSummaries({ days, now }).map((s) => {
      const lines = (s.lines || []).map(lineText).filter(Boolean);
      const maxTier = Math.max(1, ...(Array.isArray(s.tiers) && s.tiers[1] ? [2] : [1]),
        ...(s.lines || []).map((l) => (l && typeof l === 'object' && Number.isInteger(l.s) ? l.s : 1)));
      const id = `d:${s.day}`;
      return {
        id,
        kind: 'day',
        ts: Number(s.ts) || 0,
        day: s.day,
        salience: Math.min(3, maxTier),
        weight: 1.15,
        usageHits: usageOf(id),
        text: lines.join(' '),
      };
    });

    const weekDocs = readWeekNotes({ weeks: Math.ceil(days / 7) + 4, now }).map((w) => {
      const id = `w:${w.week}`;
      return {
        id,
        kind: 'week',
        ts: Number(w.ts) || 0,
        week: w.week,
        salience: 2,
        weight: 1.25,
        usageHits: usageOf(id),
        // 用「；」而不是空格拼接：周要点是多句话，空格拼起来会变成
        // 「私聊 私聊：… 私聊 私聊：…」这种读不通的长行，注入时既费 token 又难懂。
        text: (w.lines || []).map(lineText).filter(Boolean).join('；'),
      };
    });

    const monthDocs = readMonthNotes({ months: Math.ceil(days / 30) + 3, now }).map((m) => {
      const id = `m:${m.month}`;
      return {
        id,
        kind: 'month',
        ts: Number(m.ts) || 0,
        month: m.month,
        salience: 3,
        weight: 1.35,
        usageHits: usageOf(id),
        text: (m.lines || []).map(lineText).filter(Boolean).join('；'),
      };
    });

    const merge = (docs) => {
      if (!docs.length) return [];
      return rankDocuments(q, docs, {
        limit: topK * 2, now, halfLifeDays: cfg.halfLifeDays,
      });
    };
    const eventHits = merge(eventDocs);
    const dayHits = merge(dayDocs);
    const weekHits = merge(weekDocs);
    const monthHits = merge(monthDocs);

    // 同一天已经命中具体消息时，不再塞那天的摘要（否则同一件事出现两遍）。
    const usedDays = new Set(eventHits.map((h) => h.day).filter(Boolean));
    const merged = [...eventHits];
    for (const hit of dayHits) {
      if (usedDays.has(hit.day)) continue;
      merged.push(hit);
    }
    // 周/月是「粗粒度记忆」，只在前面都没有覆盖时补位，避免挤掉具体事实。
    const covered = new Set(merged.map((h) => (h.kind === 'week' ? h.week : h.kind === 'month' ? h.month : h.day)));
    for (const hit of [...weekHits, ...monthHits]) {
      const key = hit.kind === 'week' ? hit.week : hit.month;
      if (covered.has(key)) continue;
      merged.push(hit);
    }
    merged.sort((a, b) => b.score - a.score);
    // 关联扩散（借鉴 ReMe 的 expand_links，只做「同人」一层）：
    // 字面检索最大的缺口是「换了个说法就搜不到」。命中某个人说的话时，
    // 顺手把这个人其它关键事件带一两条出来补召回；分数压到最高分的一半，
    // 所以只有在结果没占满时才会留下，不会挤掉字面命中。
    const hitWhos = new Set(
      merged
        .filter((h) => h.kind === 'event' && h.who && !['你', '人', '私聊', '群聊'].includes(h.who))
        .map((h) => h.who)
    );
    if (hitWhos.size) {
      const floorScore = (merged[0]?.score || 1) * 0.5;
      const already = new Set(merged.map((h) => h.id).filter(Boolean));
      let added = 0;
      for (const doc of eventDocs) {
        if (added >= 2) break;
        if (doc.salience < 3) continue; // 只带关键事件，日常闲聊不带
        if (!hitWhos.has(doc.who)) continue;
        if (already.has(doc.id)) continue;
        already.add(doc.id);
        merged.push({ ...doc, score: floorScore, related: true, salienceTier: doc.salience });
        added += 1;
      }
      if (added) merged.sort((a, b) => b.score - a.score);
    }
    const diverse = applyDiversity(merged, topK);
    recordHits(diverse);
    appendRecallLog(q, diverse, now);
    return diverse;
  }

  /** 检索质量日志（纯追加，供离线看漏检/调权重，不参与任何决策）。 */
  function appendRecallLog(q, hits, now) {
    try {
      const line = JSON.stringify({
        t: now,
        q: String(q).slice(0, 120),
        n: hits.length,
        echo: hits.filter((h) => h.echo).length,
        related: hits.filter((h) => h.related).length,
        kinds: hits.map((h) => h.kind).join(','),
        top: hits[0] ? String(hits[0].id || hits[0].kind) : null,
      });
      fs.appendFileSync(path.join(root, 'recall-log.jsonl'), `${line}\n`, 'utf8');
    } catch {
      // 日志写失败不影响检索
    }
  }

  /** 读最近若干条检索日志（给 inspect / 控制台看）。 */
  function readRecallLog({ limit = 20 } = {}) {
    const file = path.join(root, 'recall-log.jsonl');
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
    return lines.slice(-Math.max(1, Number(limit) || 20)).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean).reverse();
  }

  /**
   * 自省：把「记忆库现状 + 最近检索 + 档案规模」一次给出来。
   * 对应 dsh-memory-local 的 memory_inspect —— 让她能自己看到「我记得些什么」。
   */
  function inspect({ now = Date.now(), recallLimit = 10 } = {}) {
    const s = stats({ now });
    const p = readProfile();
    return {
      stats: s,
      usage: usageStats(),
      recentRecalls: readRecallLog({ limit: recallLimit }),
      profile: {
        people: Object.entries(p.people).map(([name, v]) => ({
          name,
          facts: (v.facts || []).length,
          lastSeen: v.lastSeen,
        })),
        openThreads: p.threads.filter((t) => t.state === 'open').length,
        doneThreads: p.threads.filter((t) => t.state === 'done').length,
        selfNotes: p.self.length,
      },
    };
  }

  /** 主动纠错：把某人的一条旧事实换成新说法（旧文本留 previous 可追溯）。 */
  function correctFact(name, content, { now = Date.now() } = {}) {
    const p = readProfile();
    const out = correctPersonFact(p, name, content, { now });
    if (out.changed) writeProfile(out.profile);
    return out;
  }

  /** 把检索结果格式化成给模型看的文本（受 maxChars 约束）。 */
  function formatHits(hits, { maxChars } = {}) {
    const budget = Math.max(0, Number(maxChars) || cfg.searchMaxChars);
    let used = 0;
    const lines = [];
    for (const h of Array.isArray(hits) ? hits : []) {
      const when = h.kind === 'day' ? `${h.day}（那天）`
        : h.kind === 'week' ? `${h.week}（那周）`
        : h.kind === 'month' ? `${h.month}（那个月）`
        : (h.day || '');
      const text = truncateChars(String(h.text || '').replace(/\s+/g, ' '), 160);
      const line = `- ${when ? `[${when}] ` : ''}${text}`;
      if (used + line.length + 1 > budget) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join('\n');
  }

  /** 按保留天数裁掉旧事件文件（默认 0 = 永久保留，不裁）。 */
  /** 按 srcDay 裁剪归档月文件里过旧的事件（没有 srcDay 的旧行保持原样）。 */
  function pruneArchive({ cutoff }) {
    let removed = 0;
    let files = [];
    try { files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl')); } catch { return 0; }
    for (const name of files) {
      const full = path.join(archiveDir, name);
      let lines = [];
      try { lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean); } catch { continue; }
      const keepLines = lines.filter((line) => {
        try {
          const row = JSON.parse(line);
          const day = row && row.srcDay ? String(row.srcDay) : null;
          if (!day) return true; // 旧格式：没有标记就不动
          if (day < cutoff) { removed += 1; return false; }
          return true;
        } catch { return true; }
      });
      if (keepLines.length === lines.length) continue;
      try {
        if (!keepLines.length) fs.unlinkSync(full);
        else fs.writeFileSync(full, keepLines.join('\n') + '\n', 'utf8');
      } catch { /* 写失败就留着 */ }
    }
    return removed;
  }

  function pruneEvents({ retentionDays, now = Date.now() } = {}) {
    const keep = Number(retentionDays ?? cfg.eventRetentionDays) || 0;
    if (keep <= 0) return 0;
    const cutoff = shiftDay(dayString(now), -keep);
    let removed = 0;
    // 归档月文件也必须受 retentionDays 约束：只裁活动日文件的话，
    // 配置「保留 10 天」时归档里的事件仍能保留多年——既是存储膨胀，也不符合隐私删除。
    removed += pruneArchive({ cutoff });
    for (const day of listEventDays()) {
      if (day >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(eventsDir, `${day}.jsonl`));
        cache.delete(path.join(eventsDir, `${day}.jsonl`));
        removed += 1;
      } catch {
        // 删不掉就留着，不影响主流程
      }
    }
    return removed;
  }

  /** 存储概况（给控制台/工具看，不进 prompt）。 */
  /**
   * 重放失败清单。
   *
   * 三条正确性要求（对应审查指出的问题）：
   * 1. 幂等：按事件稳定 id 判重，L1 里已有的不再写（崩溃重跑也不会重复）；
   * 2. 分阶段：phase=salient 的只补 S3 副本，不重写主事件；
   * 3. 原子：清单用「写临时文件 + rename」替换，中途崩不会留下半截清单。
   *
   * @param {{dryRun?: boolean}} [options] dryRun=true 只统计不落地（运维先预览）
   */
  function replayWriteFailures({ dryRun = false } = {}) {
    const lines = readFailureLines();
    if (!lines.length) return { replayed: 0, skipped: 0, failed: 0, quarantined: 0, dryRun };
    let replayed = 0;
    let skipped = 0;
    let quarantined = 0;
    const remaining = [];
    const bad = [];
    for (const line of lines) {
      let item;
      try { item = JSON.parse(line); } catch { bad.push(line); quarantined += 1; continue; }
      const row = item && item.row;
      const id = String((item && item.id) ?? (row && row.id) ?? '');
      if (!row || !id) { bad.push(line); quarantined += 1; continue; }
      const phase = item.phase === 'salient' ? 'salient' : 'event';
      const day = dayString(Number(row.t) || Date.now());
      // 幂等：L1 里已有这个 id 就不再写
      if (phase === 'event' && l1HasId(day, id)) { skipped += 1; continue; }
      if (dryRun) { replayed += 1; continue; }
      try {
        ensureDirs();
        if (phase === 'salient') {
          writeSalientRow(row, day, Number(row.s) || 0);
        } else {
          writeEventRow(row);
          try { writeSalientRow(row, day, Number(row.s) || 0); } catch (e) { lastWriteFailure = { at: Date.now(), error: String(e?.message ?? e), phase: 'salient' }; }
        }
        replayed += 1;
      } catch (error) {
        remaining.push(line);
        lastWriteFailure = { at: Date.now(), error: String(error?.message ?? error), phase };
      }
    }
    if (!dryRun) {
      try {
        if (remaining.length) {
          const tmp = writeFailFile + '.tmp';
          fs.writeFileSync(tmp, remaining.join('\n') + '\n', 'utf8');
          fs.renameSync(tmp, writeFailFile);
        } else if (fs.existsSync(writeFailFile)) {
          fs.unlinkSync(writeFailFile);
        }
      } catch {
        // 清单替换失败：下次会再扫一遍，幂等检查保证不会重复写
      }
      if (bad.length) {
        // 坏行隔离，不直接丢掉（它们是最需要人工看的部分）
        try { fs.appendFileSync(writeFailFile + '.quarantine', bad.join('\n') + '\n', 'utf8'); } catch {}
      }
      writeFailureCount = remaining.length;
    }
    return { replayed, skipped, failed: remaining.length, quarantined, dryRun };
  }

  /** 某天的 L1 里是否已有这个事件 id（replay 幂等判断）。 */
  function l1HasId(day, id) {
    try {
      const content = fs.readFileSync(path.join(eventsDir, `${day}.jsonl`), 'utf8');
      return content.includes('"id":' + JSON.stringify(id));
    } catch { return false; }
  }

  function stats({ now = Date.now() } = {}) {
    // 写入失败计数：健康检查据此判断「L1 是否悄悄缺数据」
    const days = listEventDays();
    let events = 0;
    let bytes = 0;
    const tiers = [0, 0, 0, 0];
    for (const day of days) {
      const rows = readDayEvents(day);
      events += rows.length;
      for (const r of rows) {
        const tier = Number.isInteger(r.s) ? r.s : salience(r);
        tiers[Math.min(3, Math.max(0, tier))] += 1;
      }
      try {
        bytes += fs.statSync(path.join(eventsDir, `${day}.jsonl`)).size;
      } catch {}
    }
    let dayFiles = 0;
    try {
      dayFiles = fs.readdirSync(daysDir).filter((n) => n.endsWith('.json')).length;
    } catch {}
    let salientBytes = 0;
    let salientCount = 0;
    try {
      salientBytes = fs.statSync(salientFile).size;
      salientCount = readSalient({ limit: 1_000_000 }).length;
    } catch {}
    const profile = readProfile();
    return {
      root,
      eventDays: days.length,
      firstDay: days[0] || null,
      lastDay: days[days.length - 1] || null,
      events,
      tiers,
      salience: {
        S0: tiers[0], S1: tiers[1], S2: tiers[2], S3: tiers[3],
        寒暄占比: events ? `${Math.round((tiers[0] / events) * 100)}%` : '0%',
      },
      summaryFiles: dayFiles,
      weekFiles: listWeekFiles().length,
      monthFiles: listMonthFiles().length,
      usage: usageStats(),
      salient: { count: salientCount, bytes: salientBytes, file: salientFile },
      eventBytes: bytes,
      profile: {
        people: Object.keys(profile.people).length,
        openThreads: profile.threads.filter((t) => t.state === 'open').length,
        selfNotes: profile.self.length,
      },
      config: getConfig(),
      today: dayString(now),
      // 写入失败：>0 说明有事件没落进 L1（聊天看起来正常，但记忆已经缺了）
      writeFailures: writeFailureCount,
      lastWriteFailure,
    };
  }

  return {
    root,
    replayWriteFailures,
    eventsDir,
    daysDir,
    weeksDir,
    monthsDir,
    salientFile,
    profileFile,
    configure,
    getConfig,
    appendEvent,
    readDayEvents,
    listEventDays,
    readEvents,
    ensureDaySummaries,
    ensureWeekNotes,
    ensureMonthNotes,
    ensureConsolidation,
    archiveOldEvents,
    listArchiveMonths,
    readDaySummary,
    readSummaries,
    readWeekNotes,
    readMonthNotes,
    readSalient,
    readProfile,
    writeProfile,
    search,
    formatHits,
    usageStats,
    flushUsageNow,
    inspect,
    correctFact,
    readRecallLog,
    pruneEvents,
    stats,
  };
}
