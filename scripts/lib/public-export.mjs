// 公开导出规则（唯一实现）：export-public.mjs 与 release-preflight.mjs 共用。
//
// 为什么单独抽出来：preflight 必须和真正的导出逻辑用同一套规则，否则两边会漂移
// （曾出现 preflight 只检查「public 多出文件」，漏掉了 public 缺 package-lock.json）。
import fs from 'node:fs';
import path from 'node:path';

/** 顶层白名单：只导出这些（不在名单里的顶层项目一律不导出）。 */
export const TOP_WHITELIST = Object.freeze([
  'src',
  'scripts',
  'docs',
  'dsh',
  'plugins',
  'public',
  'tools',
  'assets',
  'roles',
  '.github',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'RULES.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  'config.example.json',
  'start.bat',
  'restart.bat',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
]);

/** 路径级排除（相对 root 的前缀）。 */
export const EXCLUDE_PREFIXES = Object.freeze([
  'node_modules',
  'state',
  'audio',
  'assets/project-intro.mp4',
  'config.json',
  '_snowluma-catalog.json',
  '.git',
]);

/** 文件名级排除。 */
export const EXCLUDE_PATTERNS = Object.freeze([
  /\.bak($|-)/,
  /\.r\d+bak$/,
  /\.routebak$|\.testbak$|\.origbak$/,
  /\.tmp$/,
  /^galaxy-data\.json$/,
  /^\.env/,
  /^_tmp_/,
]);

/** roles/ 只导出这几个（私人人格卡不进仓库）。 */
export const ROLE_ALLOW = Object.freeze(['README.md', '示例女儿.md', '傲娇助手.md', '办事助手.md']);

export function shouldExclude(rel) {
  const norm = rel.split(path.sep).join('/');
  for (const pre of EXCLUDE_PREFIXES) {
    if (norm === pre || norm.startsWith(`${pre}/`)) return true;
  }
  const base = path.basename(norm);
  for (const re of EXCLUDE_PATTERNS) if (re.test(base)) return true;
  if (norm.startsWith('roles/') && !ROLE_ALLOW.includes(base)) return true;
  return false;
}

/** 扫描 root 下应导出的文件（相对路径，正斜杠）。 */
export function listPublicExportFiles(root) {
  const files = [];
  const walk = (dir, relBase = '') => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (shouldExclude(rel)) continue;
      if (e.isDirectory()) walk(abs, rel);
      else if (e.isFile()) files.push(rel);
    }
  };
  for (const top of TOP_WHITELIST) {
    const abs = path.join(root, top);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) walk(abs, top);
    else files.push(top);
  }
  return files.sort();
}

/** 公开仓库专用的脱敏 .gitignore（不含内部规划文档清单）。 */
export const PUBLIC_GITIGNORE = fs.readFileSync(
  new URL('./public-gitignore.txt', import.meta.url), 'utf8'
);

/** 某文件导出到公开仓库时的期望内容（.gitignore 用脱敏版，其余与源一致）。 */
export function expectedPublicContent(root, rel) {
  if (rel.split(path.sep).join('/') === '.gitignore') return PUBLIC_GITIGNORE;
  return fs.readFileSync(path.join(root, rel));
}

/** 导出脚本自己写进公开仓库的标记文件（不属于 source，比较 manifest 时豁免）。 */
export const EXPORT_MARKER_FILES = Object.freeze(['.export-marker']);
