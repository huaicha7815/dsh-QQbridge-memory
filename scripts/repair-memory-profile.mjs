// 档案自愈：把记忆库长期档案里长歪的账理干净。
//
// 会处理的三种历史问题（都由修复前的真实数据暴露过）：
//   1. 同一个人裂成两份档案：`爸爸` + `爸爸（凉州词）`
//   2. 同一件事记成两条 open 线：「答应教我唱《雨爱》，还欠着」×2
//   3. 已经了结却还挂着 open：「《雨爱》唱了（done）」+「还欠着（open）」
//
// 用法：
//   node scripts/repair-memory-profile.mjs          # 预览，不改任何东西
//   node scripts/repair-memory-profile.mjs --apply  # 写回（先备份 profile.json）
//
// 纯规则、零 LLM 成本；幂等——干净的档案跑一遍什么都不改。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '../src/core/memory-store.mjs';
import { repairProfile } from '../src/core/memory-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const apply = process.argv.includes('--apply');
const store = createMemoryStore({ dir: path.join(root, 'state', 'memory'), config: {} });
const now = Date.now();

const before = store.readProfile();
const out = repairProfile(before, { now });
const after = out.profile;

const lines = [];
const say = (s = '') => lines.push(s);
const label = (c) => {
  if (c.type === 'person-merge') return `同人合并：${c.from} → ${c.into}（搬入 ${c.moved} 条事实）`;
  if (c.type === 'thread-merge') return `重复线合并：保留「${c.keep}」/ 并掉「${c.drop}」`;
  if (c.type === 'thread-close') return `已了结收尾：「${c.text}」← 由「${c.by}」了结`;
  return JSON.stringify(c);
};

say(`════ 档案自愈（${apply ? '写回' : '预览'}）════`);
say(`时间：${new Date(now).toLocaleString('zh-CN')}`);
say('');
say(`人物：${Object.keys(before.people).length} → ${Object.keys(after.people).length}`);
say(`线：${before.threads.filter((t) => t.state === 'open').length} open → ${after.threads.filter((t) => t.state === 'open').length} open`);
say('');
if (!out.changes.length) {
  say('没有需要处理的档案问题（幂等检查通过）。');
} else {
  say(`计划改动 ${out.changes.length} 处：`);
  for (const c of out.changes) say(`  · ${label(c)}`);
}

if (apply && out.changes.length) {
  const file = path.join(root, 'state', 'memory', 'profile.json');
  const backup = `${file}.bak-${now}`;
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, backup);
    const ok = store.writeProfile(after);
    say('');
    say(ok ? `已写回。备份：${path.basename(backup)}` : '写回失败（writeProfile 返回 false）');
    if (!ok) process.exitCode = 1;
  } catch (err) {
    say('');
    say(`写回失败：${err?.message || err}`);
    process.exitCode = 1;
  }
} else if (!apply && out.changes.length) {
  say('');
  say('这只是预览。确认无误后加 --apply 写回（会先备份 profile.json）。');
}

console.log(lines.join('\n'));
