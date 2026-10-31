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
  filterProfileForSession,
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

// 进程内「现在读不出来」的记忆文件：file → { at, code }。
// 这不是历史累计，而是当前仍处于读取失败状态的文件；下次读成功会自动清除。
// 健康页要能看见它：临时 IO 错误不能让整库显示成「空的但健康」。
const readFailureFiles = new Map();

function noteReadFailure(file, error) {
  readFailureFiles.set(file, {
    at: Date.now(),
    code: String((error && error.code) || 'IO'),
  });
}

function clearReadFailure(file) {
  if (readFailureFiles.has(file)) readFailureFiles.delete(file);
}

/**
 * 这个路径是不是「确定不存在」。
 *
 * 不能用 fs.existsSync()：它对任何异常都返回 false，包括 EACCES/EIO ——
 * 那会把「文件存在但读不到」误判成「文件没了」，进而删掉刚登记的故障，
 * 于是 readErrors=0、search 不标 partial，health 又变绿。
 * 只有 lstatSync 明确抛 ENOENT 才算确定不存在；其它错误是状态未知，保留登记。
 */
function isDefinitelyMissing(file) {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT');
  }
}

/**
 * 目录枚举的统一原语。
 *
 * 记忆库有 events / days / weeks / months / events-archive / root 多个目录，
 * 以前每处各写一个 try/catch，于是 EACCES 在某些层被当成「空目录」——
 * 该层就在故障时静默消失（周月摘要没了、S3 没了，health 还是绿的）。
 * 规则统一：只有 ENOENT 是正常空态，其余错误登记 + 返回空 + 让调用方知道。
 *
 * @returns {{names:string[], error:string|null}}
 */
function listDirStrict(dir) {
  try {
    const names = fs.readdirSync(dir);
    clearReadFailure(dir);
    return { names, error: null };
  } catch (error) {
    if (!error || error.code === 'ENOENT') {
      clearReadFailure(dir);
      return { names: [], error: null };
    }
    noteReadFailure(dir, error);
    return { names: [], error: `${(error && error.code) || 'IO'}: ${(error && error.message) || error}` };
  }
}

/**
 * 文本读取的统一原语（JSONL / 纯文本）。
 * @returns {{text:string|null, error:string|null}} error=null 表示成功或文件不存在
 */
function readTextStrict(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    clearReadFailure(file);
    return { text, error: null };
  } catch (error) {
    if (!error || error.code === 'ENOENT') {
      clearReadFailure(file);
      return { text: null, error: null };
    }
    noteReadFailure(file, error);
    return { text: null, error: `${(error && error.code) || 'IO'}: ${(error && error.message) || error}` };
  }
}

/**
 * stat 的统一原语：ENOENT 或读不到都返回 null，读不到时已登记。
 * 调用方据此决定「这天没有事件」还是「这天暂时看不见」——两者都不写缓存。
 */
function statStrict(file) {
  try {
    const stat = fs.statSync(file);
    clearReadFailure(file);
    return stat;
  } catch (error) {
    if (!error || error.code === 'ENOENT') clearReadFailure(file);
    else noteReadFailure(file, error);
    return null;
  }
}

// 进程内「文件读到了、但有行/内容解析不了」的登记：file → { errors, at }。
// 坏行/截断行/损坏摘要是最常见的磁盘故障形态，它们和 ENOENT、空文件、暂时读不到
// 是四种不同状态 —— 不能都表现成「没有数据」。
const parseFailureFiles = new Map();

/**
 * 记录一次解析结果：errors=0 表示这个文件现在能完整解析，自动清除登记。
 * kind 用来区分「JSONL 里的坏行」和「整个 JSON 文件损坏」—— 这两种故障的
 * 处理方式完全不同，混在一个指标里健康页就说不清了。
 */
function noteParseFailure(file, errors = 1, { kind = 'jsonl', samples = [], reason = '' } = {}) {
  const count = Number(errors) || 0;
  if (count > 0) {
    parseFailureFiles.set(file, {
      errors: count,
      kind,
      reason: String(reason || ''),
      at: Date.now(),
      samples: Array.isArray(samples) ? samples.slice(0, 3) : [],
    });
  } else if (parseFailureFiles.has(file)) {
    parseFailureFiles.delete(file);
  }
}

/**
 * 一条记忆记录的最小契约。
 *
 * 为什么必须校验：JSON.parse 只保证语法正确。`null`、`"abc"`、`[1,2]`、`{}`
 * 都是合法 JSON，能一路进到 rows，然后在 search/stats 里读 e.kind / r.k 时
 * 抛 TypeError —— 检索和健康检查直接 500，而 parseErrors 还是 0。
 */
function isValidMemoryRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  // 必须是数字，不能靠 Number() 强转：`"123"` 和 `true` 也会被转成数字，
  // 但它们是结构错误的数据，不该被当成合法事件。
  if (typeof row.t !== 'number' || !Number.isFinite(row.t) || row.t <= 0) return false;
  if (row.kind !== undefined && typeof row.kind !== 'string') return false;
  if (row.text !== undefined && typeof row.text !== 'string') return false;
  if (row.k !== undefined && row.k !== null && typeof row.k !== 'string') return false;
  const id = row.id;
  if (id !== undefined && id !== null) {
    if (!(typeof id === 'string' || typeof id === 'number')) return false;
    if (typeof id === 'string' && !id.trim()) return false;
  }
  return true;
}

/**
 * 解析 JSONL 文本：坏行跳过但计数，原文保留在原位（不删、不改写）。
 * @returns {{rows:object[], parseErrors:number}}
 */
function parseJsonl(text, file) {
  const rows = [];
  let parseErrors = 0;
  const badSamples = [];
  const reject = (line) => {
    parseErrors += 1;
    if (badSamples.length < 3) badSamples.push(String(line).slice(0, 120));
  };
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      reject(line);
      continue;
    }
    // 语法合法但记录不合法（null / 数组 / 字符串 / {} 等）同样算坏行，
    // 原文保留在原文件里，绝不改写。
    if (!isValidMemoryRow(row)) {
      reject(line);
      continue;
    }
    rows.push(row);
  }
  noteParseFailure(file, parseErrors, { kind: 'jsonl', samples: badSamples });
  return { rows, parseErrors, badSamples };
}

/**
 * 读 JSON 文件。三种失败必须分开处理：
 *   ENOENT  → 文件不存在，返回 fallback（全新库是合法状态）
 *   SyntaxError → 内容损坏：备份原文件后返回 fallback，并通知调用方「别写回」
 *   其它 IO → 默认返回 fallback 并登记；strict 模式直接抛错。
 * 以前所有错误都当「JSON 损坏」降级成空值，于是一次瞬时 EIO 就能让
 * 「读档案 → 改 → 写档案」把原档案清空。
 */
function readJsonFile(file, fallback, { strict = false, onCorrupt, onIOError, validate } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      clearReadFailure(file);
      return fallback;
    }
    noteReadFailure(file, error);
    if (typeof onIOError === 'function') onIOError(error);
    if (strict) {
      const wrapped = new Error(`读取 ${path.basename(file)} 失败：${(error && error.code) || error}`);
      wrapped.code = 'MEMORY_READ_FAILED';
      wrapped.file = file;
      wrapped.cause = error;
      throw wrapped;
    }
    return fallback;
  }
  clearReadFailure(file);

  /**
   * 内容不可用（语法坏或结构不符合契约）：登记 + 备份一次 + 通知调用方。
   * 备份名固定，不做带时间戳的版本 —— 否则每次 search/唤醒读到同一个损坏文件
   * 都会新增一个 .corrupt-* 副本，目录会被撑爆。
   */
  const corrupt = (error, reason) => {
    noteParseFailure(file, 1, { kind: 'json', reason });
    let backup = null;
    try {
      const fixedBackup = `${file}.corrupt`;
      if (!fs.existsSync(fixedBackup)) {
        fs.copyFileSync(file, fixedBackup);
        console.warn(
          `[memory] ${reason === 'schema' ? 'JSON 结构不符合契约' : 'JSON 损坏'}已备份 `
          + `${path.basename(file)}: ${error.message}`,
        );
      }
      backup = fixedBackup;
    } catch {
      // 备份失败也要走 onCorrupt：调用方必须拒写，不能把空值覆盖回去
    }
    if (typeof onCorrupt === 'function') onCorrupt({ file, backup, error, reason });
    return fallback;
  };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return corrupt(error, 'syntax');
  }
  // 语法合法 ≠ 内容是这份文件该有的东西：`[]`、`"x"`、`{"people":[]}` 都能 parse，
  // 但它们不是档案/摘要/usage。没有 schema 校验时，profile 会被当成空档案，
  // 随后写路径把空档案覆盖回磁盘（原内容还没备份）。
  if (typeof validate === 'function' && !validate(parsed)) {
    const error = new Error(`${path.basename(file)} 结构不符合记录契约（schema）`);
    error.code = 'MEMORY_SCHEMA_INVALID';
    error.file = file;
    const result = corrupt(error, 'schema');
    if (strict) throw error;
    return result;
  }
  noteParseFailure(file, 0);
  return parsed;
}

/**
 * profile 顶层契约：必须是普通对象（数组/字符串/数字都不行）；
 * people 若是存在必须是对象，threads/self/audit 若是存在必须是数组。
 * 注意 `{"people":[]}` 也要拒绝 —— 它把 people 写成数组，ensureProfile 会静默变空档案。
 */
function isProfilePayload(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (v.people !== undefined) {
    if (!v.people || typeof v.people !== 'object' || Array.isArray(v.people)) return false;
  }
  if (v.threads !== undefined && !Array.isArray(v.threads)) return false;
  if (v.self !== undefined && !Array.isArray(v.self)) return false;
  if (v.audit !== undefined && !Array.isArray(v.audit)) return false;
  return true;
}

/** 日/周/月摘要契约：对象；lines 若是存在必须是数组；count 若是存在必须是有限数字。 */
function isSummaryPayload(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (v.lines !== undefined && !Array.isArray(v.lines)) return false;
  if (v.count !== undefined && !Number.isFinite(Number(v.count))) return false;
  return true;
}

/** usage 契约：对象；hits 若是存在必须是对象（id → { n }）。 */
function isUsagePayload(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (v.hits !== undefined) {
    if (!v.hits || typeof v.hits !== 'object' || Array.isArray(v.hits)) return false;
  }
  return true;
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
  // 故障风暴保护：L1/S3 持续失败时，每条消息都会走一次同步 append。
  // 没有上限的话失败清单会无限增长（每条带完整消息文本），把磁盘和内存拖垮，
  // 后续 replay 也要整份读进内存。这里做两道限制：条目数上限 + 单条文本截断。
  const MAX_FAILURE_ENTRIES = 10000;
  // overflow 追加日志最多保留这么多行，超过就压缩成一行数字
  const MAX_OVERFLOW_LINES = 5000;
  function readFailureLines() {
    try {
      return fs.readFileSync(writeFailFile, 'utf8').split('\n').filter(Boolean);
    } catch { return []; }
  }
  const initialFailLines = readFailureLines();
  const overflowFile = writeFailFile + '.overflow';
  /**
   * 溢出计数用「追加日志」而不是「读-改-写」：
   * 1. 崩溃不丢：每条失败 append 一行 "1"，已落盘的永远不会因为进程被杀而消失；
   * 2. 不会损坏历史：O_APPEND 是原子追加，不会像覆盖写那样中途崩掉整份计数；
   * 3. 仍然便宜：超过上限后本来就不写明细了，写 1 字节比写整行小三个数量级。
   */
  function readOverflowCount() {
    try {
      const raw = fs.readFileSync(overflowFile, 'utf8').trim();
      if (!raw) return 0;
      // 逐行累加，兼容「旧数字格式 + 新追加」混用：
      // 旧文件是 "5"（无换行），升级后 append "1\n" 变成 "51\n" ——
      // 如果整份当数字解析会得到 51（正确应为 6）。
      // 这里按行解析，每行是数字就加数字，是 "1" 就加 1。
      const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
      let total = 0;
      for (const line of lines) {
        const n = Number(line);
        total += Number.isFinite(n) && n > 0 ? n : 1;
      }
      return total;
    } catch { return 0; }
  }

  /**
   * 启动时把旧格式（纯数字、无换行）规范化成逐行格式，
   * 否则下一次 append 会和旧数字粘成 "51"。
   */
  function normalizeOverflowFile() {
    try {
      const raw = fs.readFileSync(overflowFile, 'utf8');
      if (raw.includes('\n')) return; // 已经是逐行格式
      const n = Number(raw.trim());
      if (!Number.isFinite(n) || n <= 0) return;
      const tmp = overflowFile + '.normalize-tmp';
      fs.writeFileSync(tmp, `${n}\n`, 'utf8');
      fs.renameSync(tmp, overflowFile);
    } catch { /* 文件不存在或不可写，忽略 */ }
  }
  normalizeOverflowFile();
  // 追加日志会随故障时长增长：每 1000 次检查一次行数，超过上限就压缩成一行数字。
  // 压缩后文件从「N 行 1」变成「一行 N」，语义不变但体积回到常数级。
  let overflowAppendCount = 0;
  function bumpOverflowCount() {
    try {
      fs.appendFileSync(overflowFile, '1\n', 'utf8');
      overflowAppendCount += 1;
      if (overflowAppendCount % 1000 === 0) compactOverflowIfNeeded();
    } catch { /* 连 append 都失败就只能靠内存计数 */ }
  }
  function compactOverflowIfNeeded() {
    try {
      const raw = fs.readFileSync(overflowFile, 'utf8');
      const lineCount = raw.split('\n').filter(Boolean).length;
      if (lineCount <= MAX_OVERFLOW_LINES) return;
      const total = readOverflowCount();
      const tmp = overflowFile + '.compact-tmp';
      fs.writeFileSync(tmp, `${total}\n`, 'utf8');
      fs.renameSync(tmp, overflowFile);
    } catch { /* 压缩失败不影响计数 */ }
  }
  function flushOverflowCount() {
    // 追加日志没有内存缓冲，无需 flush（保留空实现给调用点）
  }
  let writeFailureCount = initialFailLines.length + readOverflowCount();
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
    const stat = statStrict(file);
    if (!stat) { cache.delete(file); return []; }
    const hit = cache.get(file);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.rows;
    const { text } = readTextStrict(file);
    // 读失败（已登记）不能写进缓存：否则权限恢复后这一天在进程余生里都「看不见」。
    if (text === null) return [];
    const { rows } = parseJsonl(text, file);
    cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, rows });
    return rows;
  }

  function salientKey(row) {
    return `${Number(row.t) || 0}|${String(row.k || '')}|${String(row.text || '').slice(0, 60)}`;
  }

  let salientIndexStamp = null; // { size, mtimeMs }

  /**
   * 读 S3 索引，返回 { index, state }：
   *   state='hit'     索引可信（缓存命中或完整解析成功）
   *   state='missing' 文件确实不存在 → 空索引可信（全新库/被清空）
   *   state='unknown' 读不到 / 有坏行 → **索引不可作为幂等依据**
   *
   * 为什么必须有 unknown：{@link writeSalientRow} 用索引判断「这个副本已经存在」。
   * 如果读取失败时沿用旧索引，外部替换过 S3 之后就会把「文件里其实没有」的 key
   * 当成已存在而跳过写入，且没有任何失败记录 —— 副本永久缺失。
   */
  function loadSalientIndex() {
    // 索引必须带文件指纹：外部修复/追加 S3 文件不会经过本进程的写路径，
    // 没有指纹的话缓存会一直停留在旧内容（replay 因此重复补写）。
    let stat = null;
    try {
      stat = fs.statSync(salientFile);
    } catch (error) {
      if (!error || error.code === 'ENOENT') {
        salientIndex = null;
        salientIndexStamp = null;
        return { index: new Set(), state: 'missing' };
      }
      noteReadFailure(salientFile, error);
      return { index: null, state: 'unknown' };
    }
    if (salientIndex && salientIndexStamp
      && salientIndexStamp.size === stat.size && salientIndexStamp.mtimeMs === stat.mtimeMs) {
      return { index: salientIndex, state: 'hit' };
    }
    // 读失败（EACCES/EIO）时**不能**把空 Set 缓存下来：那会让 S3 在进程余生里
    // 都「没有已写记录」，replay 会重复补写，健康页也看不到问题。
    const { text, error } = readTextStrict(salientFile);
    if (text === null) {
      if (error) return { index: null, state: 'unknown' };
      salientIndex = new Set();
      salientIndexStamp = null;
      return { index: salientIndex, state: 'missing' };
    }
    const { rows, parseErrors } = parseJsonl(text, salientFile);
    // 有坏行时不缓存部分索引：坏行里可能正好有某个 key，缓存少了它就会
    // 让 replay / 写路径重复补写；文件修好后 stat 指纹变化会触发重新解析。
    if (parseErrors > 0) {
      salientIndex = null;
      salientIndexStamp = null;
      return { index: null, state: 'unknown' };
    }
    const index = new Set();
    for (const row of rows) index.add(salientKey(row));
    salientIndex = index;
    salientIndexStamp = { size: stat.size, mtimeMs: stat.mtimeMs };
    return { index: salientIndex, state: 'hit' };
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
    // 文件被删/重建时缓存必须失效：否则 index 里记着「已写过」但文件里其实没有，
    // 结果就是 S3 副本永远补不上（replay 也会误判为已完成）。
    if (!fs.existsSync(salientFile)) {
      salientIndex = null;
      salientIndexStamp = null;
    }
    const { index, state } = loadSalientIndex();
    if (state === 'unknown') {
      // 读取失败或有坏行时，旧索引不能拿来判断「副本已存在」：
      // 外部可能已经替换/清空过 S3，静默跳过会让副本永久缺失且没有恢复清单。
      // 抛错交给调用方：appendEvent 记 pending 'salient'，replay 保留待处理行。
      throw new Error('S3 索引暂时不可用（读取失败或文件含坏行），无法确认副本是否存在');
    }
    const key = salientKey(row);
    if (index.has(key)) return;
    fs.appendFileSync(salientFile, JSON.stringify({ ...row, srcDay: day }) + '\n', 'utf8');
    index.add(key);
    // 刚自己写过：指纹作废，下一次读取重新解析（避免拿陈旧指纹当最新）。
    salientIndexStamp = null;
  }

  /**
   * 记录一次写入失败。
   * phase=event 表示主事件没进 L1（需要 replay 补写）；
   * phase=salient 表示主事件已成功、只有 S3 副本没写（replay 只补副本）。
   */
  function recordWriteFailure(phase, row, error) {
    // 只在前几次和到上限时打日志：故障风暴下逐条 warn 会把事件循环拖慢。
    writeFailureCount += 1;
    if (writeFailureCount <= 5 || writeFailureCount === MAX_FAILURE_ENTRIES + 1) {
      console.warn(`[memory] 事件写入失败(${phase}):`, error?.message ?? error);
    }
    lastWriteFailure = { at: Date.now(), error: String(error?.message ?? error), phase };
    // 背压：清单超过上限后只累加计数、不再写明细，避免故障期间无限增长。
    // 注意：不能截断 row.text —— 失败清单是唯一还保存着「这条消息原文」的地方，
    // 截断会让 replay 恢复出残缺内容（审查复现过：300 字恢复成 200 字）。
    if (writeFailureCount > MAX_FAILURE_ENTRIES) {
      // 溢出计数必须持久化：只放在内存里，重启后从清单行数重新初始化，
      // 用户就再也看不到「其实还丢了多少条」。
      bumpOverflowCount();
      return;
    }
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
    const { names } = listDirStrict(eventsDir);
    return names
      .map((name) => DAY_RE.exec(name)?.[1])
      .filter(Boolean)
      .sort();
  }

  /** 列出已归档的月份（events-archive/YYYY-MM.jsonl）。 */
  function listArchiveMonths() {
    const { names } = listDirStrict(archiveDir);
    return names
      .map((name) => ARCHIVE_RE.exec(name)?.[1])
      .filter(Boolean)
      .sort();
  }

  /** 读一个归档月的全部事件（带缓存）。 */
  function readArchiveMonth(month) {
    const file = path.join(archiveDir, `${month}.jsonl`);
    const stat = statStrict(file);
    if (!stat) return [];
    const hit = cache.get(file);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.rows;
    const { text } = readTextStrict(file);
    if (text === null) return [];
    const { rows } = parseJsonl(text, file);
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
      // 这里也必须走带 schema 的统一读取：业务层自己 JSON.parse 会让
      // 「语法合法但 lines 不是数组」的摘要被当成有效文件长期跳过重建 ——
      // bridge 启动/每日 consolidation/health 全都正常，只有真正 search 才发现。
      let prev = null;
      try { prev = readJsonFile(path.join(daysDir, `${d}.json`), null, { validate: isSummaryPayload }); } catch { return true; }
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
        const file = path.join(daysDir, `${day}.json`);
        writeJsonFile(file, { ...payload, srcFingerprint: dayFingerprint(day) });
        noteParseFailure(file, 0); // 重建成功 = 旧损坏状态解除
        created += 1;
      } catch {
        // 单天写失败不影响其它天
      }
    }
    return created;
  }

  /**
   * 取某一天的事件：优先活动日文件；事件已归档时从 events-archive/YYYY-MM.jsonl
   * 按 srcDay（旧行没有就按 t 反推）捞回来。
   *
   * 为什么需要：归档只删 events/YYYY-MM-DD.jsonl，**不删** days/YYYY-MM-DD.json。
   * 日摘要活得比事件日文件长，所以「用事件日文件反推要重建哪些摘要」会漏掉它们。
   */
  function eventsForDay(day) {
    const live = readDayEvents(day);
    if (live.length) return live;
    const month = String(day).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return [];
    return readArchiveMonth(month).filter((row) => {
      if (!row || typeof row !== 'object') return false;
      const srcDay = String(row.srcDay ?? '').trim();
      if (srcDay) return srcDay === day;
      return dayString(Number(row.t) || 0) === day;
    });
  }

  function readDaySummary(day) {
    const file = path.join(daysDir, `${day}.json`);
    const val = readJsonFile(file, null, { validate: isSummaryPayload });
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
    const { names } = listDirStrict(weeksDir);
    return names.map((n) => WEEK_RE.exec(n)?.[1]).filter(Boolean).sort();
  }

  function listMonthFiles() {
    const { names } = listDirStrict(monthsDir);
    return names.map((n) => MONTH_RE.exec(n)?.[1]).filter(Boolean).sort();
  }

  /**
   * 为「已经过完」的周生成周要点（当前周还没走完，不生成，避免天天重算）。
   * 只处理最近 cfg.consolidateWeeks 周。
   */
  function ensureWeekNotes({ now = Date.now() } = {}) {
    const currentWeek = isoWeekString(now);
    const have = new Set(listWeekFiles());
    // 已存在的周要点也要过 schema：损坏就当没有，下面从日摘要重建覆盖。
    // 只在 search 时才校验等于让损坏的 L2.5 长期不被发现。
    for (const week of [...have]) {
      const file = path.join(weeksDir, `${week}.json`);
      const note = readJsonFile(file, null, { validate: isSummaryPayload });
      if (!note) have.delete(week);
    }
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
        const file = path.join(weeksDir, `${week}.json`);
        writeJsonFile(file, note);
        noteParseFailure(file, 0);
        created += 1;
      } catch {}
    }
    return created;
  }

  /** 为「已经过完」的月生成月要点。 */
  function ensureMonthNotes({ now = Date.now() } = {}) {
    const currentMonth = monthString(now);
    const have = new Set(listMonthFiles());
    for (const month of [...have]) {
      const file = path.join(monthsDir, `${month}.json`);
      const note = readJsonFile(file, null, { validate: isSummaryPayload });
      if (!note) have.delete(month);
    }
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
        .map((w) => readJsonFile(path.join(weeksDir, `${w}.json`), null, { validate: isSummaryPayload }))
        .filter(Boolean);
      const note = consolidateMonth(notes, month, { minLines: 3, maxLines: 8 });
      if (!note) continue;
      try {
        const file = path.join(monthsDir, `${month}.json`);
        writeJsonFile(file, note);
        noteParseFailure(file, 0);
        created += 1;
      } catch {}
    }
    return created;
  }

  /**
   * 主动校验已有的日/周/月摘要（给 memory-health 用）。
   *
   * 日常启动不必扫全部历史；但运维命令应该能发现「很久没做深窗口检索，
   * 所以一直没暴露」的损坏层。校验会走统一的 readJsonFile（含 schema），
   * 损坏的会被备份成 *.corrupt 并登记，下次 consolidation 会用下层数据重建。
   *
   * @returns {{checked:number, corrupt:Array<{file:string, kind:string, reason:string}>}}
   */
  function auditSummaries({ limit = 400 } = {}) {
    const max = Math.max(1, Number(limit) || 400);
    // 枚举源必须是**实际存在的摘要文件**，不能从事件日反推：
    // 归档只删 events/*.jsonl、保留 days/*.json，用事件日当源会漏掉这些 orphan 日摘要。
    const dayNames = listDirStrict(daysDir).names.filter((n) => n.endsWith('.json')).sort();
    const weekNames = listDirStrict(weeksDir).names.filter((n) => n.endsWith('.json')).sort();
    const monthNames = listDirStrict(monthsDir).names.filter((n) => n.endsWith('.json')).sort();
    const totalFiles = dayNames.length + weekNames.length + monthNames.length;
    const picks = [
      ...dayNames.slice(-max).map((n) => ({ file: path.join(daysDir, n), kind: 'day' })),
      ...weekNames.slice(-max).map((n) => ({ file: path.join(weeksDir, n), kind: 'week' })),
      ...monthNames.slice(-max).map((n) => ({ file: path.join(monthsDir, n), kind: 'month' })),
    ];
    const skippedByLimit = Math.max(0, totalFiles - picks.length);
    let checked = 0;
    let repaired = 0;
    const corrupt = [];
    for (const { file, kind } of picks) {
      if (isDefinitelyMissing(file)) continue;
      checked += 1;
      const val = readJsonFile(file, null, { validate: isSummaryPayload });
      if (val !== null) continue;
      const failure = parseFailureFiles.get(file);
      if (!failure) continue; // 读不出来但没有解析登记 = 别的状态，交给 readErrors 报
      const reason = failure.reason || 'schema';

      // orphan 日摘要：事件日文件已归档删掉，但归档月里还能按 srcDay 找回原始事件，
      // 那就顺手重建（而不是留一份只能人工处理的坏文件）。
      if (kind === 'day') {
        const day = path.basename(file, '.json');
        const events = eventsForDay(day);
        const summary = events.length ? summarizeDay(events, day) : null;
        if (summary && Number(summary.count) > 0) {
          try {
            writeJsonFile(file, { ...summary, srcFingerprint: dayFingerprint(day) });
            noteParseFailure(file, 0);
            repaired += 1;
            continue;
          } catch { /* 写不进去就按损坏上报 */ }
        }
      }
      corrupt.push({ file: path.basename(file), kind, reason });
    }
    return {
      checked,
      corrupt,
      repaired,
      totalFiles,
      skippedByLimit,
      sampled: skippedByLimit > 0,
    };
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
      const note = readJsonFile(path.join(weeksDir, `${week}.json`), null, { validate: isSummaryPayload });
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
      const note = readJsonFile(path.join(monthsDir, `${month}.json`), null, { validate: isSummaryPayload });
      if (note && Array.isArray(note.lines) && note.lines.length) out.push(note);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 档案与检索
  // -------------------------------------------------------------------------

  // 档案读取的两种降级状态：只要它们非空，就拒绝写回（否则会用空档案覆盖原文件）。
  let profileCorrupt = false;   // profile.json 解析失败（已备份坏文件）
  let profileReadError = null;  // 最近一次读档案的 IO 错误（EIO/EACCES/...）

  /**
   * 读档案。
   *
   * strict=true 时读取失败直接抛错 —— 写路径（读→改→写）必须用它，
   * 因为「读失败」和「档案是空的」在写回时是天壤之别。
   * 非严格调用（注入、展示）读不到就先用空档案，但仍然会点起写保护，
   * 所以调用方即使把空档案传回 writeProfile 也不会覆盖磁盘。
   */
  function readProfile({ strict = false } = {}) {
    // 区分「文件不存在」和「暂时读不到」：两者都返回 null，但只有前者能清掉写保护。
    let ioError = null;
    const raw = readJsonFile(profileFile, null, {
      strict,
      // 语法合法但顶层结构不对（数组/字符串/{"people":[]}）同样算损坏：
      // 否则 ensureProfile 会把它变成空档案，然后写路径把空档案覆盖回去。
      validate: isProfilePayload,
      onCorrupt: () => { profileCorrupt = true; },
      onIOError: (error) => { ioError = error; profileReadError = error; },
    });
    if (raw === null) {
      // ENOENT → ioError 为 null，写保护自动解除；IO 失败 → 保持写保护。
      profileReadError = ioError;
      return ensureProfile(null);
    }
    profileCorrupt = false;
    profileReadError = null;
    return ensureProfile(raw);
  }

  function writeProfile(profile, { force = false } = {}) {
    if (!force && (profileCorrupt || profileReadError)) {
      console.error(
        `[memory] 拒绝写档案：${profileCorrupt
          ? 'profile.json 解析失败（坏文件已备份）'
          : `读取失败（${profileReadError && (profileReadError.code || profileReadError.message || profileReadError)}）`}。`
        + '为避免用空档案覆盖原文件，本次写入跳过；修好文件/权限后下一次成功读取会自动恢复。',
      );
      return false;
    }
    const p = pruneProfile(ensureProfile(profile));
    try {
      writeJsonFile(profileFile, p);
      invalidateProfileTexts();
      return true;
    } catch {
      return false;
    }
  }

  /** 运维修好文件后可以显式解除写保护（修复脚本用）。 */
  function clearProfileGuards() {
    profileCorrupt = false;
    profileReadError = null;
  }

  /**
   * 档案读取状态：ok / corrupt（解析失败已备份）/ io-error（暂时读不到）。
   * 管理层要能看到它，否则「档案读不到」在接口上长得和「档案是空的」一样。
   */
  function readState() {
    return {
      corrupt: profileCorrupt,
      readError: profileReadError ? String(profileReadError.code || profileReadError.message || profileReadError) : null,
      writable: !profileCorrupt && !profileReadError,
    };
  }

  /**
   * 本库目录下当前读不出来的文件（模块级登记按 root 过滤）。
   *
   * 清理过期登记只在「确定不存在」（ENOENT）时做：文件被删/归档后 health 不该
   * 一直假红，但 EACCES/EIO 时文件其实还在，清了就等于把故障藏起来。
   */
  function readFailureFilesInRoot() {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    const out = [];
    for (const file of [...readFailureFiles.keys()]) {
      if (!String(file).startsWith(prefix)) continue;
      if (isDefinitelyMissing(file)) { readFailureFiles.delete(file); continue; }
      out.push(file);
    }
    return out;
  }

  /** 本库目录下解析失败的文件与行数（清理规则同上：只有 ENOENT 才清）。 */
  function parseFailureFilesInRoot() {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    const out = [];
    for (const [file, info] of [...parseFailureFiles.entries()]) {
      if (!String(file).startsWith(prefix)) continue;
      if (isDefinitelyMissing(file)) { parseFailureFiles.delete(file); continue; }
      out.push([file, info]);
    }
    return out;
  }

  /** 读 S3 独立副本（最近的在前），给「重要的事」展示用。 */
  function readSalient({ limit = 50 } = {}) {
    const { text } = readTextStrict(salientFile);
    if (text === null) return [];
    const { rows } = parseJsonl(text, salientFile);
    return rows.slice(-Math.max(1, Number(limit) || 50)).reverse();
  }

  // -------------------------------------------------------------------------
  // 记忆热度（usage）：被检索命中过的记忆加权，长期没被用到的自然沉底。
  // 出处：MemoryOS 的「热度更新」、Mem0 的访问频率；纯本地、零 token。
  // -------------------------------------------------------------------------
  const usageFile = path.join(root, 'usage.json');
  let usageCache = null;

  function loadUsage() {
    if (usageCache) return usageCache;
    const raw = readJsonFile(usageFile, null, { validate: isUsagePayload });
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
    // 会话作用域（可选）：传了 opts.key 就只检索该会话的事件。
    // 默认不传 = 保持原来的「跨会话记忆」行为（用户明确选择过保持现状）。
    const scopeKey = String(opts.key ?? '').trim();

    let scopedEvents = readEvents({ days, now });
    // 严格匹配：无 k 的旧事件在 isolated 下不可见（和摘要层、档案层同一默认值）。
    if (scopeKey) scopedEvents = scopedEvents.filter((e) => e && String(e.k ?? '') === scopeKey);
    const eventDocs = scopedEvents.map((e) => {
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

    // isolated 时按摘要的 keys[] 过滤：不含当前会话的整天摘要直接跳过。
    const summaryAllowed = (keys) => {
      if (!scopeKey) return true;
      if (!Array.isArray(keys) || !keys.length) return false; // 没有会话标记的旧摘要，保守跳过
      return keys.includes(scopeKey);
    };
    // 行级过滤：isolated 时只保留「这一行明确来自当前会话」的摘要行。
    // 关键：来源未知（旧摘要行没有 k）必须 fail-closed —— 安全隔离不能靠「默认放行」，
    // 否则只要历史数据存在，isolated 就只是 best-effort。
    const filterLines = (raw) => (Array.isArray(raw) ? raw : []).filter((l) => {
      if (!scopeKey) return true;
      if (!l || typeof l !== 'object' || !l.k) return false;
      return l.k === scopeKey;
    });
    const dayDocs = readSummaries({ days, now }).filter((s) => summaryAllowed(s.keys)).map((s) => {
      const lines = filterLines(s.lines).map(lineText).filter(Boolean);
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

    const weekDocs = readWeekNotes({ weeks: Math.ceil(days / 7) + 4, now })
      .filter((w) => summaryAllowed(w.keys))
      .map((w) => {
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
        text: filterLines(w.lines).map(lineText).filter(Boolean).join('；'),
      };
    });

    const monthDocs = readMonthNotes({ months: Math.ceil(days / 30) + 3, now })
      .filter((m) => summaryAllowed(m.keys))
      .map((m) => {
      const id = `m:${m.month}`;
      return {
        id,
        kind: 'month',
        ts: Number(m.ts) || 0,
        month: m.month,
        salience: 3,
        weight: 1.35,
        usageHits: usageOf(id),
        text: filterLines(m.lines).map(lineText).filter(Boolean).join('；'),
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
    appendRecallLog(q, diverse, now, opts.key);
    return diverse;
  }

  /** 检索质量日志（纯追加，供离线看漏检/调权重，不参与任何决策）。 */
  function appendRecallLog(q, hits, now, sourceKey = '') {
    try {
      const line = JSON.stringify({
        t: now,
        // 检索词原文属于会话隐私：isolated 下只让本会话看到自己的检索历史。
        k: String(sourceKey ?? '').trim(),
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
  function readRecallLog({ limit = 20, sourceKey = '' } = {}) {
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
    }).filter(Boolean)
      // isolated 时只看本会话的检索历史：日志里有查询原文，跨会话等于内容泄漏。
      .filter((x) => !sourceKey || String(x.k ?? '') === sourceKey)
      .reverse();
  }

  /**
   * 会话级统计：只数本会话的事件，活动日文件与归档月文件都算。
   * 不能复用 stats()：它带 root 路径、整份配置、待恢复失败计数——
   * 那些是管理面信息，会话不需要，也不该看到别的会话的活动量。
   */
  function computeSessionStats(wanted, now) {
    let events = 0;
    const tiers = [0, 0, 0, 0];
    const daysSeen = new Set();
    const take = (r) => {
      events += 1;
      const tier = Number.isInteger(r.s) ? r.s : salience(r);
      tiers[Math.min(3, Math.max(0, tier))] += 1;
      // 归档行带 srcDay，活动日文件的行用文件名；旧归档行没 srcDay 就从 t 反推。
      const d = String(r.srcDay ?? '').trim() || (Number(r.t) ? dayString(Number(r.t)) : '');
      if (d) daysSeen.add(d);
    };
    for (const day of listEventDays()) {
      for (const r of readDayEvents(day)) if (String(r.k ?? '') === wanted) take(r);
    }
    // 归档月文件也是 L1 历史：只数活动日会让「只有归档期记录」的会话显示 0 条，
    // 而大窗口检索又能查到它们——统计和检索自相矛盾，等于告诉用户「记忆没了」。
    for (const month of listArchiveMonths()) {
      for (const r of readArchiveMonth(month)) if (String(r.k ?? '') === wanted) take(r);
    }
    const days = [...daysSeen].sort();
    return {
      scope: 'session',
      activeOnly: false,
      archivedIncluded: true,
      events,
      eventDays: days.length,
      firstDay: days[0] || null,
      lastDay: days[days.length - 1] || null,
      tiers,
      salience: {
        S0: tiers[0], S1: tiers[1], S2: tiers[2], S3: tiers[3],
        寒暄占比: events ? `${Math.round((tiers[0] / events) * 100)}%` : '0%',
      },
      today: dayString(now),
    };
  }

  /**
   * 自省：把「记忆库现状 + 最近检索 + 档案规模」一次给出来。
   * 对应 dsh-memory-local 的 memory_inspect —— 让她能自己看到「我记得些什么」。
   */
  function inspect({ now = Date.now(), recallLimit = 10, sourceKey = '' } = {}) {
    const fullProfile = readProfile();
    const wanted = String(sourceKey ?? '').trim();
    // 给了 sourceKey 就用会话级投影：检索历史、人物统计、事件统计都只看本会话。
    const p = wanted ? filterProfileForSession(fullProfile, wanted) : fullProfile;
    const profile = {
      people: Object.entries(p.people).map(([name, v]) => ({
        name,
        facts: (v.facts || []).length,
        lastSeen: v.lastSeen,
      })),
      openThreads: p.threads.filter((t) => t.state === 'open').length,
      doneThreads: p.threads.filter((t) => t.state === 'done').length,
      selfNotes: p.self.length,
    };
    if (wanted) {
      return {
        // scope 明示：这一份是会话级视图，全局统计与工具使用量不下发。
        scope: 'session',
        // 时间口径要和 memory-profile 保持一致：profile.lastSeen 是会话内序数，
        // 不是时间戳，调用方不能把 7 当成「7 分钟前」。
        clock: p.clock === 'session-rank' ? 'session-rank' : 'epoch-ms',
        clockNote: '时间字段是会话内序数（越大越新，0=未知），不是时间戳',
        stats: computeSessionStats(wanted, now),
        usage: null,
        omitted: ['globalStats', 'config', 'paths', 'pendingFailures', 'usage'],
        recentRecalls: readRecallLog({ limit: recallLimit, sourceKey: wanted }),
        profile,
        profileRead: readState(),
      };
    }
    return {
      scope: 'global',
      clock: 'epoch-ms',
      stats: stats({ now }),
      usage: usageStats(),
      recentRecalls: readRecallLog({ limit: recallLimit, sourceKey: wanted }),
      profile,
    };
  }

  /** 主动纠错：把某人的一条旧事实换成新说法（旧文本留 previous 可追溯）。 */
  /**
   * 主动纠错：**只改内存、不落盘**，返回改后的 profile 交给调用方写一次。
   *
   * 以前这里先写一次盘、路由补完 audit 再写第二次。第二次失败时路由返回 503
   * 说「本次改动没有落盘」，可实际上纠错内容已经在磁盘上了 —— 重试会再纠一次，
   * 而 audit 永远补不上。写盘统一交给调用方（一次），语义才准确。
   */
  function correctFact(name, content, { now = Date.now(), uid = '', sourceKey = '', visibilityKey = '' } = {}) {
    // 写路径严格读：读失败就抛错，绝不拿空档案继续改再写回
    const p = readProfile({ strict: true });
    return correctPersonFact(p, name, content, { now, uid, sourceKey, visibilityKey });
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
  // ── replay 锁：带 owner token 的租约 ──
  // 审查指出的三个问题都在这里：
  // 1. 锁创建失败（EACCES/磁盘/路径）时以前会无锁继续 → 现在一律 fail-closed；
  // 2. 过期接管只按 mtime 判断 → 现在看 owner + at，且只接管确实过期的；
  // 3. 释放时无条件 unlink → 现在只删自己持有（owner 匹配）的锁。
  function acquireReplayLock(lockFile, owner) {
    try {
      fs.writeFileSync(
        lockFile,
        JSON.stringify({ owner, pid: process.pid, at: Date.now() }),
        { flag: 'wx' },
      );
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        // 关键：不是「锁被占用」，而是根本创建不了锁。
        // 这种情况下继续 replay 等于在无锁状态下写数据，两个进程会重复写 L1。
        console.warn('[memory] 无法创建 replay 锁，本轮不执行:', error?.message ?? error);
        return false;
      }
      // 锁已存在。过期/损坏时尝试接管，但接管必须**原子**：
      // 旧实现是「读锁 → 判断过期 → unlink → 重建」，这是 TOCTOU ——
      // 两个进程可能都读到同一个过期锁，A 重建后 B 用自己的 unlink 删掉 A 的新锁，
      // 结果两个 replay 同时认为自己持锁。
      // 现在改为：先 rename 把旧锁移走（OS 保证只有一个进程能成功），
      // 成功的那一个才创建新锁；失败的直接放弃。
      let info = null;
      try { info = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* 锁文件损坏按过期处理 */ }
      const age = Date.now() - (Number(info && info.at) || 0);
      // 「持锁进程还活着吗」比时间更可靠：崩溃残留的锁里 pid 已经是死进程，
      // 只看 age 会让运维干等 5 分钟才敢重跑（归档恢复这种秒级任务尤其难受）。
      // pid 被别的进程复用时仍判活，退回按 age 保守处理。
      const ownerPid = Number(info && info.pid) || 0;
      let ownerAlive = false;
      if (ownerPid > 0) {
        try { process.kill(ownerPid, 0); ownerAlive = true; }
        catch (probeError) { ownerAlive = Boolean(probeError && probeError.code === 'EPERM'); }
      }
      const stale = !info || !ownerAlive || age >= 5 * 60 * 1000;
      if (!stale) return false; // 活锁，放弃本轮
      const staleFile = `${lockFile}.stale-${process.pid}-${crypto.randomUUID().slice(0, 6)}`;
      try {
        fs.renameSync(lockFile, staleFile); // 原子抢占：只有一个人成功
      } catch {
        return false; // 别人先接管了
      }
      try {
        fs.writeFileSync(
          lockFile,
          JSON.stringify({ owner, pid: process.pid, at: Date.now() }),
          { flag: 'wx' },
        );
        return true;
      } catch {
        return false; // 抢到旧锁但建新锁失败，放弃（旧锁已被移走，下次会重建）
      } finally {
        try { fs.unlinkSync(staleFile); } catch {}
      }
    }
  }

  /**
   * 确认锁文件当前仍属于自己。
   *
   * rename 抢占不是「条件删除」：A 移走过期锁并建好新锁后，B 仍可能把 A 的新锁
   * rename 走（B 用的是它更早读到的过期判断）。所以持锁进程必须在处理中和提交前
   * 反复确认「锁文件里的 owner 还是我」——不是就说明被抢了，立即停手。
   */
  function ownsLock(lockFile, owner) {
    try {
      const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      return Boolean(info && info.owner === owner);
    } catch { return false; }
  }

  /** 只释放自己持有的锁，避免删掉接管者的锁。 */
  function releaseReplayLock(lockFile, owner) {
    try {
      const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (info && info.owner === owner) fs.unlinkSync(lockFile);
    } catch { /* 锁已经不在了 */ }
  }

  /** 长任务续租：更新锁文件的 at，避免跑超过 5 分钟被误判为过期。 */
  function renewReplayLock(lockFile, owner) {
    // 原子续租：先写唯一临时文件再 rename，避免另一个进程在「截断-重写」之间，
    // 读到坏 JSON 就当成过期锁接管掉。续租前仍要确认 owner 是自己。
    const tmp = `${lockFile}.renew-${process.pid}-${crypto.randomUUID().slice(0, 6)}`;
    try {
      const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (!info || info.owner !== owner) return;
      fs.writeFileSync(tmp, JSON.stringify({ ...info, at: Date.now() }), 'utf8');
      fs.renameSync(tmp, lockFile);
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  /** S3 独立副本里是否已有该 id（判断「是否还缺副本」）。 */
  function salientHasId(id) {
    const needle = '"id":' + JSON.stringify(id);
    try {
      return fs.readFileSync(salientFile, 'utf8').includes(needle);
    } catch { return false; }
  }

  /**
   * 重放失败清单。
   *
   * 正确性要求：
   * 1. 幂等：按事件稳定 id 判重（活动日 + 归档月都查）；
   * 2. 分阶段：L1 已有但 S3 缺时，降级为「只补 S3」，不算 skip；
   * 3. 原子：清单用「写临时文件 + rename」替换；
   * 4. 并发：带 owner 的租约锁，获取失败一律 fail-closed。
   *
   * @param {{dryRun?: boolean}} [options] dryRun=true 只统计不落地（运维先预览）
   */
  function replayWriteFailures({ dryRun = false, onBeforeCommit } = {}) {
    // 关键：清单必须在拿到锁之后再读。
    // 桥接进程是另一个写者，它会在 replay 运行期间继续 append 失败记录；
    // 如果锁外读取、最后又整体覆盖清单，那期间新增的记录会被静默吞掉（数据丢失）。
    const lockFile = writeFailFile + '.lock';
    const owner = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    let lockHeld = false;
    if (!dryRun) {
      lockHeld = acquireReplayLock(lockFile, owner);
      if (!lockHeld) {
        return { replayed: 0, skipped: 0, failed: 0, quarantined: 0, dryRun, locked: true };
      }
    }
    try {
      // 遗留快照（上一次 replay 在 rename 后崩溃留下的）：必须和新快照一起处理。
      // 以前 rename 到固定名 .processing 会把它覆盖掉，旧事件就永远丢了。
      const leftovers = listFailureSnapshots();
      // 唯一名快照：不会覆盖任何遗留文件。
      const snapshotFile = `${writeFailFile}.processing-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
      if (!dryRun) {
        try { fs.renameSync(writeFailFile, snapshotFile); } catch { /* 主清单不存在 */ }
      }
      // dryRun 不动文件，直接读「遗留快照 + 主清单」；apply 读「遗留快照 + 本次快照」。
      // 按文件名排序：`.processing` 比 `.processing-<时间戳>` 更早，先处理旧快照。
      const sources = (dryRun ? [...leftovers, writeFailFile] : [...leftovers, snapshotFile]).sort();
      const lines = [];
      // 关键：读失败的文件绝不能删。把「文件存在」当成「内容已安全读入」，
      // 会导致一次 IO 抖动就把整份未恢复记录删掉（审查复现过）。
      const readableFiles = [];
      const unreadableFiles = [];
      for (const file of sources) {
        try {
          lines.push(...fs.readFileSync(file, 'utf8').split('\n').filter(Boolean));
          readableFiles.push(file);
        } catch (error) {
          unreadableFiles.push(file);
          console.warn('[memory] 快照读取失败，保留待下次处理:', file, error?.message ?? error);
        }
      }
      if (!lines.length) {
        // 一个都没读到：只清理确实读成功的空文件，读失败的保留。
        if (!dryRun) { for (const f of readableFiles) { try { fs.unlinkSync(f); } catch {} } }
        return { replayed: 0, skipped: 0, failed: unreadableFiles.length, quarantined: 0, dryRun };
      }
      let replayed = 0;
      let skipped = 0;
      let quarantined = 0;
      let quarantineFailed = false;
      const remaining = [];
      const bad = [];
      let lastRenew = Date.now();
      const seenIds = new Set();
      let processed = 0;
      for (const line of lines) {
        processed += 1;
        // 按时间续租（不是按行数）：单行 IO 慢时也能及时告诉别人「我还活着」。
        if (lockHeld) {
          // 每 100 条确认一次锁还是自己的：被抢就立刻停手，避免双写 L1。
          if (processed % 100 === 0 && !ownsLock(lockFile, owner)) {
            lastWriteFailure = { at: Date.now(), error: 'replay 锁已被其他进程接管，本轮中止', phase: 'lock' };
            return { replayed, skipped, failed: remaining.length, quarantined, dryRun, lockLost: true };
          }
          if (Date.now() - lastRenew > 60_000) {
            renewReplayLock(lockFile, owner);
            lastRenew = Date.now();
          }
        }
        let item;
        try { item = JSON.parse(line); } catch { bad.push(line); quarantined += 1; continue; }
        const row = item && item.row;
        const id = String((item && item.id) ?? (row && row.id) ?? '');
        if (!row || !id) { bad.push(line); quarantined += 1; continue; }
        let phase = item.phase === 'salient' ? 'salient' : 'event';
        const day = dayString(Number(row.t) || Date.now());
        const tier = Number(row.s) || 0;
        // 本轮去重：同一个 id 出现在多个快照里时，dry-run 不能重复计数，
        // 否则预览会比 apply 高（审查指出过）。
        if (seenIds.has(id)) { skipped += 1; continue; }
        seenIds.add(id);
        // 幂等判断要覆盖「该 id 的两个阶段都完成」：
        // 只看 L1 有 id 就 skip，会漏掉「L1 已有但 S3 副本缺失」的情况。
        if (phase === 'event' && l1HasId(day, id)) {
          const stillNeedsSalient = tier >= 3 && Boolean(cfg.salientFile) && !salientHasId(id);
          if (!stillNeedsSalient) { skipped += 1; continue; }
          phase = 'salient'; // 降级：只补 S3 副本
        }
        if (phase === 'salient' && salientHasId(id)) { skipped += 1; continue; }
        if (dryRun) { replayed += 1; continue; }
        try {
          ensureDirs();
          if (phase === 'salient') {
            writeSalientRow(row, day, tier);
          } else {
            writeEventRow(row);
            try {
              writeSalientRow(row, day, tier);
            } catch (e) {
              // 主事件已写进 L1，但 S3 副本没写：不能算「恢复完成」，
              // 降级成 salient 阶段的待处理记录，下次 replay 只补副本。
              remaining.push(JSON.stringify({
                at: Date.now(), phase: 'salient', id, row, error: String(e?.message ?? e),
              }));
              lastWriteFailure = { at: Date.now(), error: String(e?.message ?? e), phase: 'salient' };
              continue;
            }
          }
          replayed += 1;
        } catch (error) {
          remaining.push(line);
          lastWriteFailure = { at: Date.now(), error: String(error?.message ?? error), phase };
        }
      }
      if (typeof onBeforeCommit === 'function') onBeforeCommit();
      // 提交前最后确认锁：如果被接管了，不写回清单（快照留着，下次还能处理）。
      if (lockHeld && !ownsLock(lockFile, owner)) {
        return { replayed, skipped, failed: remaining.length, quarantined, dryRun, lockLost: true };
      }
      if (!dryRun) {
        try {
          // 处理失败/隔离的行追加回主清单（桥接期间写的新行已经在主清单里了，不动它们）。
          // 只回填「处理失败」的行；坏行走 quarantine，避免下次又 parse 失败死循环。
          const backfill = remaining;
          if (backfill.length) {
            fs.appendFileSync(writeFailFile, backfill.join('\n') + '\n', 'utf8');
          }
          // 坏行（JSON 损坏 / 缺 id）隔离：留在主清单会导致下次又 parse 失败，无限循环。
          if (bad.length) {
            try {
              fs.appendFileSync(writeFailFile + '.quarantine', bad.join('\n') + '\n', 'utf8');
            } catch (error) {
              quarantineFailed = true;
              console.warn('[memory] 坏行隔离失败，保留快照:', error?.message ?? error);
            }
          }
          // 只删「成功读入」的快照；读失败的保留，下次还能再试。
          // quarantine 写失败时也整批保留：坏行既没进隔离区，就不能把快照删了。
          if (!quarantineFailed) {
            for (const f of readableFiles) { try { fs.unlinkSync(f); } catch {} }
          }
        } catch {
          // 回填失败：.processing 还在，下次会再处理（幂等检查保证不会重复写 L1）
        }
        writeFailureCount = pendingFailureStats().total;
      }
      return { replayed, skipped, failed: remaining.length, quarantined, dryRun, unreadable: unreadableFiles.length };
    } finally {
      if (lockHeld) releaseReplayLock(lockFile, owner);
    }
  }

  /**
   * 列出所有遗留的 replay 快照文件（.processing / .processing-<token>）。
   * 上一次 replay 可能在 rename 之后、处理完成之前崩溃，留下快照；
   * 下一次 replay 必须先把它当待处理数据读掉，绝不能覆盖。
   */
  /**
   * 失败清单快照（.processing-* / .migrate-*）：每行是 {at, phase, id, row, error}。
   * 只有这种快照能被 replay 当失败记录消费。
   */
  function listFailureSnapshots() {
    const dir = path.dirname(writeFailFile);
    const base = path.basename(writeFailFile);
    const out = [];
    // 走统一原语：目录读不到（而不是不存在）要登记，别让失败清单在故障时静默变空。
    for (const name of listDirStrict(dir).names) {
      if (name.startsWith(`${base}.processing`) || name.startsWith(`${base}.migrate-`)) {
        out.push(path.join(dir, name));
      }
    }
    return out;
  }

  /**
   * 归档迁移快照（events-archive/YYYY-MM.jsonl.migrate-*）：每行是普通 L1 事件，
   * 格式和失败清单完全不同 —— 绝不能交给 replay 当失败记录消费
   * （那会把归档事件 quarantine 掉再删快照，等于把 L1 降级成人工隔离数据）。
   */
  function listArchiveSnapshots() {
    // 返回 { files, error }：ENOENT 才是「确实没有归档」（还没归档过），
    // 其余错误（EACCES / EPERM / EIO / ENOTDIR）说明目录存在但读不到，
    // 里面可能还躺着待恢复快照 —— 当成空数组就是 fail-open，健康页会假绿。
    const { names, error } = listDirStrict(archiveDir);
    const files = [];
    for (const name of names) {
      if (name.includes('.jsonl.migrate-')) files.push(path.join(archiveDir, name));
    }
    return { files, error };
  }

  /**
   * 键排序的稳定序列化：同一份内容无论字段顺序如何都得到同一个字符串。
   */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }

  /**
   * 归档恢复的幂等键：优先用事件 id（稳定唯一）；旧行没有 id 就用**整行内容**的
   * 稳定哈希。绝不能用「时间 + 文本前缀」——同一毫秒、前 40 字相同的两条不同消息
   * 会被判成同一条，恢复时静默丢掉其中一条，而旧库恰恰是最需要恢复、又没有 id 的数据。
   * srcDay 是迁移阶段补的伪字段（同一行在不同阶段可能带也可能不带），先剔掉再比。
   */
  function archiveRowKey(line) {
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) return `raw:${line}`;
      const id = String(row.id ?? '').trim();
      if (id) return `id:${id}`;
      const { srcDay, ...rest } = row;
      return `row:${stableStringify(rest)}`;
    } catch { /* 坏行用整行原文当指纹 */ }
    return `raw:${line}`;
  }

  /**
   * 恢复归档迁移快照：把快照里目标还没有的行 append 回 YYYY-MM.jsonl，然后删快照。
   * 用 append 而不是 rename 覆盖：期间桥接可能已经重建了该归档文件，
   * rename 会把它覆盖掉。append 与 unlink 之间存在崩溃窗口，所以按 archiveRowKey
   * 去重，重复调用不会重复写入。
   */
  function recoverArchiveSnapshots({ dryRun = false } = {}) {
    // 失败不再是「静默跳过」：读目录失败、单个快照读写失败都要累计，
    // 否则磁盘满/权限变化时会返回 restored:0 而调用方以为一切正常。
    const result = { restored: 0, lines: 0, duplicates: 0, failed: 0, errors: [], dryRun };
    const fail = (message) => {
      result.failed += 1;
      if (result.errors.length < 20) result.errors.push(message);
    };
    const firstScan = listArchiveSnapshots();
    if (firstScan.error) {
      return {
        ...result,
        archiveDirError: firstScan.error,
        error: `无法读取归档目录 events-archive（${firstScan.error}）：里面可能还有待恢复快照，先修目录权限/挂载再重试`,
      };
    }
    // 没有快照就别建锁：events-archive 目录可能还不存在（归档 0 个月），
    // 盲目建锁会 ENOENT → 被当成「另一个恢复在跑」，健康页/CLI 都会误报。
    if (!firstScan.files.length) {
      return { ...result, noSnapshots: true };
    }
    // 归档恢复以前完全没有锁：两个 --apply 会同时读到同一份旧状态，然后各追加一遍。
    // replay / migrate 的 fencing 锁只覆盖失败清单，这个写者也要有自己的锁。
    const lockFile = path.join(archiveDir, '.recover.lock');
    const owner = `recover-archive:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
    let lockHeld = false;
    if (!dryRun) {
      try { fs.mkdirSync(archiveDir, { recursive: true }); } catch { /* 下面建锁会失败并报出来 */ }
      lockHeld = acquireReplayLock(lockFile, owner);
    }
    if (!dryRun && !lockHeld) {
      // 区分「别人正持锁」和「根本建不了锁」：两种情况都不写，但提示必须不一样。
      let heldByOther = false;
      try {
        const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        heldByOther = Boolean(info && info.owner);
      } catch { /* 锁文件不存在 = 建锁失败 */ }
      return {
        ...result, locked: heldByOther,
        error: heldByOther
          ? '另一个归档恢复正在进行（锁超过 5 分钟且持锁进程不在才会被接管），本次未执行'
          : '无法创建归档恢复锁（events-archive 目录不可写？），本次未执行',
      };
    }
    try {
      const scan = listArchiveSnapshots();
      if (scan.error) {
        return {
          ...result,
          archiveDirError: scan.error,
          error: `无法读取归档目录 events-archive（${scan.error}）：本次未执行`,
        };
      }
      for (const snap of scan.files) {
        // 快照之间也续租：单个恢复任务处理多个快照时不能被误判成僵锁。
        if (lockHeld) renewReplayLock(lockFile, owner);
        const snapName = path.basename(snap);
        // 2026-09.jsonl.migrate-123 → 2026-09.jsonl
        const target = path.join(archiveDir, snapName.split('.migrate-')[0]);
        let content = '';
        try {
          content = fs.readFileSync(snap, 'utf8');
        } catch (error) {
          fail(`读不出快照 ${snapName}：${(error && error.code) || error}`);
          continue;
        }
        const rows = content.split('\n').filter(Boolean);
        if (!rows.length) {
          if (!dryRun) {
            try { fs.unlinkSync(snap); } catch (error) {
              fail(`删除空快照 ${snapName} 失败：${(error && error.code) || error}`);
              continue;
            }
          }
          result.restored += 1;
          continue;
        }
        // 目标已有行的指纹 → 剩余可抵消次数。用多重计数而不是 Set：
        // 目标里合法存在两条完全相同的事件时，快照里的第二条仍然要补回来。
        //
        // 读目标失败时绝不能当成「空文件」：existing 为空 → 所有行都算 missing →
        // 全量重写后再删快照，原归档和新写的就重复了，而命令还报成功。
        // 只有 ENOENT 才是「目标确实还不存在」这个唯一安全的空基线。
        const existing = new Map();
        try {
          for (const line of fs.readFileSync(target, 'utf8').split('\n').filter(Boolean)) {
            const k = archiveRowKey(line);
            existing.set(k, (existing.get(k) || 0) + 1);
          }
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            fail(`读不出目标归档 ${path.basename(target)}（${(error && error.code) || error}）：跳过 ${snapName}，快照保留`);
            continue;
          }
          // ENOENT：目标确实还不存在，空基线是对的
        }
        const missing = [];
        let scannedRows = 0;
        for (const line of rows) {
          const k = archiveRowKey(line);
          const left = existing.get(k) || 0;
          if (left > 0) {
            existing.set(k, left - 1);
            result.duplicates += 1;
          } else {
            missing.push(line);
          }
          scannedRows += 1;
          // 大快照可能跑过 5 分钟租约：边处理边续租，避免被另一个恢复者当成僵锁接管。
          if (lockHeld && scannedRows % 20000 === 0) renewReplayLock(lockFile, owner);
        }
        if (dryRun) {
          result.restored += 1;
          result.lines += missing.length;
          continue;
        }
        // 写之前再确认锁还在自己手里：被接管后继续追加会让两份恢复互相叠加。
        if (lockHeld && !ownsLock(lockFile, owner)) {
          return {
            ...result, locked: false, lostLock: true,
            error: '归档恢复锁被接管，已停止（快照保留，可重跑）',
          };
        }
        try {
          if (missing.length) {
            fs.appendFileSync(target, missing.join('\n') + '\n', 'utf8');
          }
          // append 成功后才删快照；即使这里崩了，下次也只会补 missing（幂等）。
          fs.unlinkSync(snap);
          result.restored += 1;
          result.lines += missing.length;
        } catch (error) {
          // 写不进去（ENOSPC / EACCES / EIO）必须记下来：快照保留、可重跑，
          // 但调用方要能据此以非零退出，而不是看到 restored:0 就当没事。
          fail(`恢复 ${snapName} 失败：${(error && error.code) || error} ${(error && error.message) || ''}`.trim());
        }
      }
      // 收尾再扫一次：CLI 用它决定退出码（还有快照没恢复完就不能报成功）。
      const finalScan = listArchiveSnapshots();
      if (finalScan.error) {
        result.archiveDirError = finalScan.error;
        result.error = `恢复结束后无法确认归档目录状态（${finalScan.error}）`;
      } else {
        result.remaining = finalScan.files.length;
      }
      return result;
    } finally {
      if (lockHeld) releaseReplayLock(lockFile, owner);
    }
  }

  /**
   * 待恢复统计 = 主清单 + 所有遗留快照。
   * 读不出来的快照要单独计数：它不是「没有数据」，而是「有一份我们看不清的数据」，
   * 健康页必须能提示，否则用户会以为一切正常。
   */
  function pendingFailureStats() {
    // overflow 是「知道丢了，但没有明细可恢复」的账本，必须一起算：
    // 以前 replay 结束后把当前计数清零，但 .overflow 还在，重启后数字又回来。
    flushOverflowCount();
    const overflow = readOverflowCount();
    let records = 0;
    let unreadable = 0;
    try { records += fs.readFileSync(writeFailFile, 'utf8').split('\n').filter(Boolean).length; } catch { /* 主清单不存在 */ }
    for (const file of listFailureSnapshots()) {
      try {
        records += fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
      } catch {
        unreadable += 1;
      }
    }
    // 归档快照是另一种格式，单独计数、单独恢复，不能混进 pendingRecoverable。
    const archiveScan = listArchiveSnapshots();
    const archiveSnapshotError = archiveScan.error || null;
    const archiveSnapshots = archiveSnapshotError ? 0 : archiveScan.files.length;
    return {
      records, unreadable, overflow, archiveSnapshots, archiveSnapshotError,
      total: records + overflow,
    };
  }

  /** 兼容旧调用点：只取记录数。 */
  function pendingFailureCount() {
    return pendingFailureStats().records;
  }

  /**
   * 迁移旧格式数据（只加字段，不改内容）：
   * 1. 失败清单里没有 id 的行 → 用 t 生成稳定 id（同 t 加序号），
   *    这样它们能参与 replay 的幂等判断，而不是只能进 quarantine；
   * 2. 归档月文件里没有 srcDay 的行 → 用 t 反推（t 就是写入时间），
   *    这样它们能被 retention 裁剪、也能参与归档去重。
   * 幂等：已有 id / srcDay 的行原样保留，重复执行不会改出重复数据。
   */
  function migrateLegacyRecords({ dryRun = false } = {}) {
    const result = { failureIdsAdded: 0, archiveSrcDaysAdded: 0, filesTouched: 0, dryRun };

    // 迁移和 replay 一样要防并发：桥接在「读取」和「写回」之间追加的新失败行，
    // 如果直接整体覆盖就会丢。这里复用同一套协议：
    //   拿锁 → rename 快照 → 只处理快照 → append 回主清单 → 删快照。
    const lockFile = writeFailFile + '.lock';
    const owner = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    let lockHeld = false;
    if (!dryRun) {
      lockHeld = acquireReplayLock(lockFile, owner);
      if (!lockHeld) return { ...result, locked: true };
    }
    try {

    // 1) 失败清单
    try {
      let sourceFile = writeFailFile;
      if (!dryRun) {
        sourceFile = `${writeFailFile}.migrate-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
        try {
          fs.renameSync(writeFailFile, sourceFile);
        } catch (error) {
          // 只有「文件不存在」才能退回原路径；EBUSY/EACCES 等必须 fail-closed，
          // 否则会读原文件再把整份 append 回原文件 —— 一条记录变两条。
          if (error && error.code === 'ENOENT') {
            sourceFile = writeFailFile;
          } else {
            return { ...result, error: `rename-failed: ${error?.message ?? error}` };
          }
        }
      }
      const lines = fs.readFileSync(sourceFile, 'utf8').split('\n').filter(Boolean);
      let changed = 0;
      const seen = new Set();
      const out = lines.map((line) => {
        let item;
        try { item = JSON.parse(line); } catch { return line; } // 坏行不动，交给 replay 的 quarantine
        const row = item && item.row;
        if (!row || typeof row !== 'object') return line;
        if (String(row.id ?? '').trim()) return line; // 已有 id
        let id = `${Number(row.t) || 0}`;
        let n = 1;
        while (seen.has(id)) { id = `${Number(row.t) || 0}-${n}`; n += 1; }
        seen.add(id);
        row.id = id;
        if (!item.id) item.id = id;
        changed += 1;
        return JSON.stringify(item);
      });
      // 关键：不管有没有改动，都要把处理过的行写回主清单再删快照。
      // 之前只在 changed>0 时 append，第二次幂等迁移（changed=0）会删掉源快照却
      // 什么都不写回 —— 整份失败清单直接消失（审查复现过）。
      if (!dryRun) {
        // 破坏性操作前检查锁：如果已被抢，立即停手（此时什么都还没写）。
        if (lockHeld && !ownsLock(lockFile, owner)) {
          // 失锁：把已 rename 走的快照恢复回原路径，不能把数据藏成 .migrate-*。
          if (sourceFile !== writeFailFile) {
            try { fs.renameSync(sourceFile, writeFailFile); } catch {}
          }
          return { ...result, lockLost: true };
        }
        fs.appendFileSync(writeFailFile, out.join('\n') + '\n', 'utf8');
        if (sourceFile !== writeFailFile) {
          try { fs.unlinkSync(sourceFile); } catch {}
        }
      }
      if (changed) {
        result.failureIdsAdded = changed;
        result.filesTouched += 1;
      }
    } catch { /* 没有失败清单 */ }

    // 2) 归档月文件
    let archiveFiles = [];
    try { archiveFiles = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl')); } catch { /* 无归档 */ }
    for (const name of archiveFiles) {
      const full = path.join(archiveDir, name);
      // 和失败清单同样的协议：先把文件 rename 成快照（原子），
      // 处理快照后 append 回原文件；期间桥接新 append 的事件不会被覆盖。
      let sourceFile = full;
      if (!dryRun) {
        const snap = `${full}.migrate-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
        try {
          fs.renameSync(full, snap);
          sourceFile = snap;
        } catch (error) {
          if (error && error.code === 'ENOENT') {
            sourceFile = full;
          } else {
            return { ...result, error: `rename-failed: ${error?.message ?? error}` };
          }
        }
      }
      let lines = [];
      try { lines = fs.readFileSync(sourceFile, 'utf8').split('\n').filter(Boolean); } catch { continue; }
      let changed = 0;
      const out = lines.map((line) => {
        let row;
        try { row = JSON.parse(line); } catch { return line; }
        if (!row || typeof row !== 'object' || String(row.srcDay ?? '').trim()) return line;
        const t = Number(row.t);
        if (!Number.isFinite(t) || t <= 0) return line; // 没有时间戳，无法安全反推
        row.srcDay = dayString(t);
        changed += 1;
        return JSON.stringify(row);
      });
      if (!dryRun) {
        if (lockHeld && !ownsLock(lockFile, owner)) {
          // 归档同理：先恢复快照，再返回。
          if (sourceFile !== full) {
            try { fs.renameSync(sourceFile, full); } catch {}
          }
          return { ...result, lockLost: true };
        }
        // 不管有没有改动都写回（否则 changed=0 时删快照就丢了整份归档）
        fs.appendFileSync(full, out.join('\n') + '\n', 'utf8');
        if (sourceFile !== full) {
          try { fs.unlinkSync(sourceFile); } catch {}
        }
      }
      if (changed) {
        result.archiveSrcDaysAdded += changed;
        result.filesTouched += 1;
      }
    }
    return result;
    } finally {
      if (lockHeld) releaseReplayLock(lockFile, owner);
    }
  }

  function l1HasId(day, id) {
    const needle = '"id":' + JSON.stringify(id);
    // 1) 当天活动文件
    try {
      if (fs.readFileSync(path.join(eventsDir, `${day}.jsonl`), 'utf8').includes(needle)) return true;
    } catch { /* 当天文件可能还没建 */ }
    // 2) 归档月文件：事件可能早已归档，「活动日里没有」不等于「库里没有」。
    //    以前只查活动日，导致已归档的事件被 replay 又写进活动日 → readEvents 出现同 id 两条。
    try {
      const months = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'));
      for (const name of months) {
        try {
          if (fs.readFileSync(path.join(archiveDir, name), 'utf8').includes(needle)) return true;
        } catch { /* 单个归档文件读不到就跳过 */ }
      }
    } catch { /* 还没有归档目录 */ }
    return false;
  }

  function stats({ now = Date.now() } = {}) {
    // 写入失败计数：健康检查据此判断「L1 是否悄悄缺数据」
    const days = listEventDays();
    let events = 0;
    let bytes = 0;
    const tiers = [0, 0, 0, 0];
    // 无来源事件：isolated 下它们对任何会话都不可见（fail-closed），
    // 健康页必须让人看见这个数字，否则「迁移后一半记忆消失」会被当成 bug 而不是策略。
    let eventsWithoutSource = 0;
    for (const day of days) {
      const rows = readDayEvents(day);
      events += rows.length;
      for (const r of rows) {
        if (!String(r.k ?? '').trim()) eventsWithoutSource += 1;
        const tier = Number.isInteger(r.s) ? r.s : salience(r);
        tiers[Math.min(3, Math.max(0, tier))] += 1;
      }
      try {
        bytes += fs.statSync(path.join(eventsDir, `${day}.jsonl`)).size;
      } catch {}
    }
    // 归档月文件同样是历史数据：isolated 检索看不到它们，
    // 健康页必须把「无来源事件」的数量算上，否则会显示 0 让人以为没受影响。
    let archivedEvents = 0;
    for (const month of listArchiveMonths()) {
      for (const r of readArchiveMonth(month)) {
        archivedEvents += 1;
        if (!String(r.k ?? '').trim()) eventsWithoutSource += 1;
      }
    }
    const dayFiles = listDirStrict(daysDir).names.filter((n) => n.endsWith('.json')).length;
    // 以前这里是一个 try 包住 stat + 读文件：stat 一失败就直接跳过读，
    // S3 层于是既不登记也不报错（健康页显示 0 条，实际是读不到）。
    const salientStat = statStrict(salientFile);
    const salientRows = readSalient({ limit: 1_000_000 });
    const salientBytes = salientStat ? salientStat.size : 0;
    const salientCount = salientRows.length;
    const profile = readProfile();
    const pending = pendingFailureStats();
    // 先把还剩下的读取都做掉，再快照 readErrors：
    // 对象字面量的属性是按定义顺序求值的，若 readErrors 写在 weekFiles 之前，
    // 周/月目录的失败会漏进快照（这一轮真实踩到过）。
    const weekFilesCount = listWeekFiles().length;
    const monthFilesCount = listMonthFiles().length;
    // usage.json 也是 readJsonFile 的调用方（可能 schema 损坏），必须先读再做快照，
    // 否则它的 corruptJsonFiles 登记会漏进这份统计（属性求值顺序的坑已踩过两次）。
    const usageSnapshot = usageStats();
    const readFailureSnapshot = readFailureFilesInRoot();
    const parseFailureSnapshot = parseFailureFilesInRoot();
    const parseErrorLines = parseFailureSnapshot
      .filter(([, v]) => v.kind !== 'json')
      .reduce((sum, [, v]) => sum + v.errors, 0);
    const corruptJsonAll = parseFailureSnapshot.filter(([, v]) => v.kind === 'json');
    const corruptJsonFileCount = corruptJsonAll.length;
    const corruptJsonFiles = corruptJsonAll.slice(0, 10).map(([file]) => path.basename(file));
    // 损坏原因：syntax（JSON 语法坏）还是 schema（结构不符合契约）
    const corruptJsonReasons = Object.fromEntries(
      parseFailureSnapshot
        .filter(([, v]) => v.kind === 'json')
        .slice(0, 10)
        .map(([file, v]) => [path.basename(file), v.reason || 'syntax']),
    );
    const corruptFilesSnapshot = parseFailureSnapshot.slice(0, 10).map(([file]) => path.basename(file));
    return {
      root,
      eventDays: days.length,
      firstDay: days[0] || null,
      lastDay: days[days.length - 1] || null,
      events,
      // 当前进程内读不出来的记忆文件（IO 错误，下次请求会自动重试）。
      // 有值时健康页必须红：这不是「没有数据」，而是「暂时看不见数据」。
      // 只统计本库目录下的文件：readFailureFiles 是模块级登记，同一进程里的
      // 其它 store（测试、副本、迁移脚本）不该出现在这份健康报告里。
      readErrors: readFailureSnapshot.length,
      unreadableFiles: readFailureSnapshot.slice(0, 10).map((f) => path.basename(f)),
      // 读到了字节但解析不了的内容。拆成两档：
      //   parseErrorLines   = JSONL 里的坏行（一条记忆用不了，文件其余部分照常）
      //   corruptJsonFiles  = 整份 JSON 档案损坏（如某天的摘要读不出来）
      parseErrorLines,
      corruptJsonFiles,
      corruptJsonFileCount,
      corruptJsonReasons,
      // 总数用完整计数：损坏 20 个时不能只报 10 个（列表截断只影响展示）
      parseErrors: parseErrorLines + corruptJsonFileCount,
      // 兼容旧字段：所有解析失败的文件名
      corruptFiles: corruptFilesSnapshot,
      // 无来源事件数（活动日 + 归档月都算，「受影响的历史数据」才是完整口径）
      eventsWithoutSource,
      archivedEvents,
      tiers,
      salience: {
        S0: tiers[0], S1: tiers[1], S2: tiers[2], S3: tiers[3],
        寒暄占比: events ? `${Math.round((tiers[0] / events) * 100)}%` : '0%',
      },
      summaryFiles: dayFiles,
      weekFiles: weekFilesCount,
      monthFiles: monthFilesCount,
      usage: usageStats(),
      salient: { count: salientCount, bytes: salientBytes, file: salientFile },
      eventBytes: bytes,
      profile: {
        people: Object.keys(profile.people).length,
        openThreads: profile.threads.filter((t) => t.state === 'open').length,
        selfNotes: profile.self.length,
      },
      // 档案读不到 ≠ 档案是空的：写保护生效时这里会告诉运维为什么没写进去。
      profileRead: readState(),
      config: getConfig(),
      today: dayString(now),
      // 写入失败：>0 说明有事件没落进 L1（聊天看起来正常，但记忆已经缺了）
      // 计数要包含遗留快照：否则上一次 replay 崩溃后，健康页会显示「没有失败」，
      // 而实际上还有一批记录躺在 .processing-* 里没恢复。
      // 四个明确指标：用户要能分清「还能恢复」和「永久丢了明细」。
      pendingRecoverable: pending.records,
      unrecoverableOverflow: pending.overflow,
      unreadableSnapshots: pending.unreadable,
      // 归档迁移快照：单独一类，需要 recoverArchiveSnapshots() 恢复
      archiveSnapshots: pending.archiveSnapshots,
      // 归档目录读不到 ≠ 没有快照：这一项非空时健康页必须红，不能报「没有待恢复数据」。
      archiveSnapshotError: pending.archiveSnapshotError,
      // writeFailures 保留为总和（兼容旧调用点/健康页）
      writeFailures: Math.max(writeFailureCount, pending.total),
      lastWriteFailure,
      // 坏行（无法解析 / 缺 id）被隔离后的数量：这些也是「没恢复的数据」，
      // 不进 writeFailures 会让人误以为处理完了。
      quarantined: (() => {
        try {
          return fs.readFileSync(writeFailFile + '.quarantine', 'utf8').split('\n').filter(Boolean).length;
        } catch { return 0; }
      })(),
    };
  }

  return {
    root,
    replayWriteFailures,
    migrateLegacyRecords,
    clearProfileGuards,
    auditSummaries,
    readState,
    readErrorCount: () => readFailureFilesInRoot().length,
    parseErrorCount: () => parseFailureFilesInRoot()
      .reduce((sum, [, v]) => sum + (v.kind === 'json' ? 1 : (Number(v.errors) || 0)), 0),
    recoverArchiveSnapshots,
    // 会话级事件统计：memory-stats 在 isolated 下要返回它，而不是全局管理面统计。
    sessionStats: (sourceKey, { now = Date.now() } = {}) => computeSessionStats(String(sourceKey ?? '').trim(), now),
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
