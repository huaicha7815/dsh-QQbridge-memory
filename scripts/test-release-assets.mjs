// 发布资产契约：导出规则唯一来源、.gitignore 单点写入、preflight skip 语义。
//
// 这三条都是「发布门禁会不会假绿」的关键：
//   - 若导出再出现第二份硬编码 .gitignore，未来改 public-gitignore.txt 会被悄悄覆盖；
//   - 若 --skip-heavy 的 daily/audit 不进 results，摘要会显示 PASS 13/13，掩盖没跑的事实。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_GITIGNORE, listPublicExportFiles, expectedPublicContent, EXPORT_MARKER_FILES } from '../scripts/lib/public-export.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fs.readFileSync(path.join(ROOT, 'scripts', 'export-public.mjs'), 'utf8');
const PREFLIGHT = fs.readFileSync(path.join(ROOT, 'scripts', 'release-preflight.mjs'), 'utf8');

test('导出 .gitignore 只有一个写入点，且内容来自共享脱敏文件', () => {
  // 按行找「对 outDir/.gitignore 的写入」，避免正则被 path.join 的括号截断。
  const writeLines = EXPORT.split('\n').filter((line) => /writeFileSync\(.*\.gitignore/.test(line));
  assert.equal(writeLines.length, 1, `导出脚本对 .gitignore 只能有一处写入，实际 ${writeLines.length} 处：\n${writeLines.join('\n')}`);
  assert.ok(writeLines[0].includes('PUBLIC_GITIGNORE'), `.gitignore 必须写共享的 PUBLIC_GITIGNORE，实际：${writeLines[0]}`);
  assert.ok(!/\[\s*'node_modules\/'[\s\S]*?\.join\('\\n'\)/.test(EXPORT), '导出脚本不能内置第二份硬编码 .gitignore 数组');
});

test('PUBLIC_GITIGNORE 与 public-gitignore.txt 一致，且是脱敏版（不含内部规划文档清单）', () => {
  const file = fs.readFileSync(path.join(ROOT, 'scripts/lib/public-gitignore.txt'), 'utf8');
  assert.equal(PUBLIC_GITIGNORE, file, 'PUBLIC_GITIGNORE 必须直接来自 public-gitignore.txt');
  for (const internal of ['PROJECT_GUIDE.md', 'ARCH_REVIEW.md', 'DSH_QQ_TOOLS_PLAN.md', 'TOKEN_COST.md']) {
    assert.ok(!PUBLIC_GITIGNORE.includes(internal), `脱敏 .gitignore 不能暴露内部文档名：${internal}`);
  }
  assert.ok(PUBLIC_GITIGNORE.includes('state/'), '脱敏版仍必须屏蔽 state/');
  assert.ok(PUBLIC_GITIGNORE.includes('config.json'), '脱敏版仍必须屏蔽 config.json');
});

test('导出清单包含 package-lock.json 与 .gitignore（npm ci 与脱敏前提）', () => {
  const files = listPublicExportFiles(ROOT);
  assert.ok(files.includes('package-lock.json'), '导出清单必须包含 package-lock.json');
  assert.ok(files.includes('.gitignore'), '导出清单必须包含 .gitignore（内容由 PUBLIC_GITIGNORE 覆盖）');
  assert.ok(files.includes('scripts/release-preflight.mjs'), '导出清单必须包含 preflight 自身');
  assert.ok(!files.some((f) => f.startsWith('state/')), '不能导出 state/');
});

test('expectedPublicContent：.gitignore 用脱敏版，其他文件与源一致', () => {
  const gitignore = expectedPublicContent(ROOT, '.gitignore').toString('utf8');
  assert.equal(gitignore, PUBLIC_GITIGNORE, '.gitignore 的期望内容必须是脱敏版');
  const pkg = expectedPublicContent(ROOT, 'package.json');
  assert.equal(pkg.toString('utf8'), fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), '其他文件期望内容与源一致');
});

test('preflight 的 --skip-heavy 把 daily/audit 记入 results（摘要必须显示 SKIP）', () => {
  assert.ok(/results\.push\(\{ name: 'full daily', skip: true/.test(PREFLIGHT), 'full daily 必须以 skip 记入 results');
  assert.ok(/results\.push\(\{ name: 'audit', skip: true/.test(PREFLIGHT), 'audit 必须以 skip 记入 results');
  assert.ok(PREFLIGHT.includes("results.filter((r) => r.skip)"), '摘要必须单列 SKIP');
  assert.ok(PREFLIGHT.includes('SKIP ${skipped.length}'), '摘要必须显示 SKIP 数量');
});

test('preflight 不再保留旧的本地白名单推导（避免第二套规则）', () => {
  assert.ok(!PREFLIGHT.includes('function exportWhitelist'), '死函数 exportWhitelist 必须已删除');
  assert.ok(!PREFLIGHT.includes('function expectedExportFiles'), '死函数 expectedExportFiles 必须已删除');
  assert.ok(PREFLIGHT.includes('listPublicExportFiles'), 'preflight 必须用共享导出规则');
  assert.ok(PREFLIGHT.includes('expectedPublicContent'), 'preflight 必须用共享期望内容');
});

test('导出标记文件是豁免列表的一部分（防御性兜底）', () => {
  assert.deepEqual([...EXPORT_MARKER_FILES], ['.export-marker']);
  assert.ok(PREFLIGHT.includes('EXPORT_MARKER_FILES'), 'preflight 必须豁免导出标记');
});
