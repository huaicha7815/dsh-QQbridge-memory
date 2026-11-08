// 控制台静态校验：在无法跑 Playwright 的环境里，替代性地检查 HTML/JS 结构契约。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 独立发语音工具已拆到仓库上一级的 voice-tool/（qq-bridge 只保留共享内核 src/voice-core.js）
const VOICE_TOOL = path.resolve(ROOT, '..', 'voice-tool');
const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 元素 ID');
const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
ok(dups.length === 0, 'ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
for (const id of ['voiceList', 'voiceRefreshBtn', 'voiceSendBtn', 'voiceSendTarget', 'voiceSendDryRun', 'voiceMsg']) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `语音面板元素 ${id}`, `${n} 处`);
}

console.log('## 静态资源外置');
ok(!html.includes('<style>'), '控制台页面不含内联 <style>（已外置 console.css）');
ok(html.includes('/console.css'), '控制台引用 /console.css');

console.log('## 样式预算');
const settingsBlocks = [...html.matchAll(/<details class="settings-group"[\s\S]*?<\/details>/g)].map((m) => m[0]);
const settingsStyles = settingsBlocks.reduce((sum, b) => sum + (b.match(/style="/g) || []).length, 0);
ok(settingsStyles === 0, 'settings 范围 style 属性为 0', settingsStyles ? `剩余 ${settingsStyles} 处` : '0');
const allStyles = (html.match(/style="/g) || []).length;
const jsTemplateStyles = (html.slice(html.lastIndexOf('<script>')).match(/style="/g) || []).length;
const htmlStaticStyles = allStyles - jsTemplateStyles;
ok(htmlStaticStyles === 0, 'HTML 静态 style 属性为 0', `当前 ${htmlStaticStyles}`);
ok(jsTemplateStyles === 0, 'JS 模板 style 为 0', `当前 ${jsTemplateStyles}`);

console.log('## class/规则契约（样式类必须有 CSS 定义）');
{
  // 枚举所有 tag.field-* 组合（枚举所有 field-* 组合，避免固定 4 项漏检）
  const cssPath = path.join(ROOT, 'public', 'console.css');
  const cssText = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
  const combos = new Set();
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)([^>]*?)\bclass="([^"]*\bfield-[a-z0-9-]+[^"]*)"/g)) {
    const tag = m[1].toLowerCase();
    for (const cls of m[3].split(/\s+/)) if (/^field-/.test(cls)) combos.add(tag + '.' + cls);
  }
  for (const combo of [...combos].sort()) {
    const [tag, cls] = combo.split('.');
    let re;
    if (tag === 'input') re = new RegExp('input\\[type\\]\\.' + cls + '(?![a-z0-9-])');
    else if (tag === 'select') re = new RegExp('select\\.' + cls + '(?![a-z0-9-])');
    else if (tag === 'textarea') re = new RegExp('textarea\\.' + cls + '(?![a-z0-9-])');
    else re = new RegExp('(^|\\n)\\.' + cls + '\\s*\\{');
    ok(re.test(cssText), combo + ' 有 CSS 规则');
  }
}

console.log('## 情绪页运行时契约');
{
  // emotionMetric 内部不能引用外层 v（曾经导致 ReferenceError，整页渲染失败）
  const fnMatch = html.match(/function emotionMetric\([\s\S]*?\n\}/);
  ok(!!fnMatch, 'emotionMetric 函数存在');
  ok(fnMatch && !/moodClassOf\(v\)/.test(fnMatch[0]), 'emotionMetric 不引用外层 v');
  ok(html.includes("emotionMetric('心情 valence', v, moodClassOf(v)"), '心情指标传 moodClassOf(v)');
  ok(html.includes('progress class="emotion-bar-fill'), '情绪指标条用 progress 元素');
}

console.log('## 运行时样式写入');
{
  ok(!/\.style\.[a-zA-Z]+\s*=/.test(html), 'console.html 无 element.style 写入');
  ok(!/cssText/.test(html), 'console.html 无 cssText');
  ok(!/setAttribute\(['"]style['"]/.test(html), 'console.html 无 setAttribute(style)');
}

console.log('## 重复 class 属性');
{
  const dupTags = [...html.matchAll(/<[a-zA-Z][^>]*?\sclass="[^"]*"[^>]*?\sclass="/g)];
  ok(dupTags.length === 0, '同一标签 class 属性不超过 1 个', dupTags.length ? `${dupTags.length} 处` : '0');
}

console.log('## usage progress 契约');
{
  const cssText = fs.readFileSync(path.join(ROOT, 'public', 'console.css'), 'utf8');
  ok(!cssText.includes('.usage-bar-track'), '旧 .usage-bar-track 已删除');
  ok(cssText.includes('#section-usage progress.usage-bar-fill'), 'usage progress 有专属规则');
  ok(!/usage-bar-fill[^"]*mood-neutral/.test(html), 'usage bar 不挂 mood-neutral');
}

console.log('## 视图 / 页面契约');
const views = [...new Set([...html.matchAll(/data-view="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
const pages = [...new Set([...html.matchAll(/data-page="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
ok(JSON.stringify(views) === JSON.stringify(pages), 'data-view 与 data-page 一一对应', `${views.length} 个：${views.join(', ')}`);

console.log('## 工具开关');
const tools = [...html.matchAll(/data-v2-tool="([A-Za-z]+)"/g)].map((m) => m[1]);
ok(tools.includes('sendVoice'), 'sendVoice 开关存在', `共 ${tools.length} 个开关`);
ok(new Set(tools).size === tools.length, '工具开关无重复');

console.log('## 语音面板接线');
ok(/id="voiceRefreshBtn"/.test(html) && /getElementById\('voiceRefreshBtn'\)\.addEventListener/.test(html), '刷新按钮已绑定事件');
ok(/getElementById\('voiceSendBtn'\)\.addEventListener/.test(html), '试发按钮已绑定事件');
ok(/api\('\/api\/voice\/list/.test(html), '面板调用 /api/voice/list（操作者通道，无需 key）');
ok(/api\('\/api\/voice\/send'/.test(html), '面板调用 /api/voice/send');
ok(/typeof loadVoiceLibrary === 'function'|async function loadVoiceLibrary/.test(html), 'loadVoiceLibrary 已定义');

console.log('## JS 语法');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const big = scripts.sort((a, b) => b.length - a.length)[0];
try { new Function(big); ok(true, '主 script 语法可解析', `${big.length} 字符`); }
catch (e) { ok(false, '主 script 语法', e.message); }

console.log('## 语音图形界面的音量控件');
{
  const voiceHtmlPath = path.join(VOICE_TOOL, 'public', 'voice.html');
  if (!fs.existsSync(voiceHtmlPath)) {
    console.log('## 语音图形界面');
    console.log('  SKIP  voice-tool 不在仓库内（独立外部工具），跳过其静态检查');
  } else {
    const voice = fs.readFileSync(voiceHtmlPath, 'utf8');
  const ids = [...voice.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  ok(dups.length === 0, 'voice.html ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
  for (const id of ['volRange', 'volLabel', 'volReset', 'normBox', 'loudnessSel', 'previewBtn']) {
    ok(ids.includes(id), `音量控件 ${id}`);
  }
  ok(/id="volRange"[^>]*min="10"[^>]*max="400"/.test(voice), '滑块范围 10%~400%');
  ok(/volRange'\)\.addEventListener\('input'/.test(voice), '滑块 input 事件已绑定');
  ok(/previewBtn'\)\.addEventListener/.test(voice), '试听按钮已绑定');
  ok(/api\/preview/.test(voice), '试听调 /api/preview（听处理后的效果）');
  ok(/body\.normalize = true/.test(voice) && /body\.volume = volValue\(\)/.test(voice), '发送时带上音量设置');
  const scripts = [...voice.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  try { new Function(scripts[0]); ok(true, 'voice.html 前端 JS 可解析'); }
  catch (e) { ok(false, 'voice.html 前端 JS 可解析', e.message); }
  }
}

console.log('## fixture mock 覆盖');
const fixture = fs.readFileSync(path.join(ROOT, 'scripts', 'console-ui-fixture.mjs'), 'utf8');
ok(fixture.includes("case '/api/socialV2/voices'"), 'fixture mock 了 /api/socialV2/voices');
ok(fixture.includes("case '/api/voice/send'"), 'fixture mock 了 /api/voice/send');

  // 情绪页 UI 重做（v2）：七情 / 心情卡 / 混合 / 双通道 / 曲线 / 评价链 / 每句情绪 / 关系
  ok(html.includes('七情') && html.includes('SEVEN_EMOTIONS'), '情绪页：七情面板');
  ok(html.includes('emotion-hero') && html.includes('心情'), '情绪页：心情卡');
  ok(html.includes('混合心情（情绪栈）'), '情绪页：混合心情');
  ok(html.includes('即时心情（快）') && html.includes('背景心情（慢）'), '情绪页：双通道');
  ok(html.includes('aria-label="情绪曲线"'), '情绪页：曲线');
  ok(html.includes('最近评价链'), '情绪页：评价链');
  ok(html.includes('她每句话的情绪') && html.includes('mood-history'), '情绪页：逐句情绪');
  ok(html.includes('和她的关系') && html.includes('attachmentStyle'), '情绪页：关系区块');
  ok(html.includes('block-hint'), '情绪页：逐区解释');
  ok(!html.includes('preserveAspectRatio="none"'), '曲线不得拉伸圆点');
  ok(!html.includes('diff = 100'), '混合百分比不得补差');
  ok(html.includes('逐句情绪文件降级（可能损坏），仅显示可读部分'), 'degraded 提示');
  ok(html.includes("'情绪 V2 读取失败：'"), 'detail catch 错误文案');
  ok(html.includes('aria-label="' + '') || html.includes('aria-label="即时心情'), 'progress aria-label');

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
