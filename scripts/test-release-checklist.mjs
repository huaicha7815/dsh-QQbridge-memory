// 发布清单与测试结果一致性校验（防止清单数字漂移）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SUITE_LIST } from './daily-suites.mjs';

// 清单路径：优先环境变量（CI 注入），其次仓库内副本 docs/RELEASE-CHECKLIST-emotion-v2.md，最后方案目录
const candidates = [
  process.env.EMOTION_V2_RELEASE_CHECKLIST,
  path.join(process.cwd(), 'docs', 'RELEASE-CHECKLIST-emotion-v2.md'),
  path.join(process.cwd(), '..', '2026-11-05_情绪系统升级方案', 'RELEASE-CHECKLIST-emotion-v2.md'),
].filter(Boolean);
const checklistPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];

test('发布清单与测试一致：smoke 2/2、detail 5xx 绝对阈值', () => {
  assert.ok(fs.existsSync(checklistPath), '发布清单必须存在');
  const text = fs.readFileSync(checklistPath, 'utf8');
  assert.ok(text.includes('2/2 pass'), '清单必须写 smoke 2/2（当前实际 2 条）');
  assert.ok(text.includes(`${SUITE_LIST.length} 套件`), `清单必须写 daily ${SUITE_LIST.length} 套件（实际值）`);
  assert.ok(text.includes('background.factor=0.85'), '清单必须注明阈值效果测试');
  assert.ok(text.includes('连续 3 个 5min 窗口各 ≥5 次 5xx'), 'detail 5xx 必须用绝对数+连续窗口');
  assert.ok(!text.includes('0.5%/5min'), '不得再使用百分比阈值');
});
