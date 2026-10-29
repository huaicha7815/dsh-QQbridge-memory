// 控制台增强功能综合测试（node 直接调 API）
//
// 这个测试会**改真实配置**（白名单）和**真实角色目录**，所以安全措施是重点：
//   1. 开跑前把 config.json 备份成 config.json.testbak；
//   2. 主流程包在 try/finally 里，无论断言失败、抛异常还是 Ctrl+C 都会走到 finally；
//   3. finally 里先按备份把白名单恢复回去，再校验磁盘上的 config.json 是否真的恢复；
//      对不上就直接用备份文件覆盖，并提示重启桥接；
//   4. 上次异常退出留下的 .testbak 会在下次启动时被检测到并自动恢复。
//
// 默认**不真的往 QQ 发消息**（只验证白名单放行路径）；要真发加 --allow-send。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:3100';
const CONFIG_FILE = path.join(ROOT, 'config.json');
const BACKUP_FILE = path.join(ROOT, 'config.json.testbak');
const TEST_ROLE = '测试人格Tmp';
const TEST_GROUP_ID = '123456789';
const ALLOW_SEND = process.argv.includes('--allow-send');

function readConsoleToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = readConsoleToken();
const authHeaders = TOKEN ? { 'x-console-token': TOKEN } : {};
const api = async (p, method, body) => {
  const headers = { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(BASE + p, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// ── 恢复：先 API，后校验磁盘，必要时直接回写文件 ──
function restoreConfigFromBackup(reason) {
  let bak;
  try {
    bak = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  } catch {
    return { ok: false, note: '备份文件不可读' };
  }
  let wrote = false;
  try {
    const now = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const same = JSON.stringify(now?.allow ?? null) === JSON.stringify(bak?.allow ?? null);
    if (!same) {
      now.allow = bak.allow;
      if (bak.deny !== undefined) now.deny = bak.deny;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(now, null, 2), 'utf8');
      wrote = true;
    }
  } catch (e) {
    // 配置文件坏了：直接用备份整个覆盖
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(bak, null, 2), 'utf8');
      wrote = true;
    } catch {}
  }
  try { fs.unlinkSync(BACKUP_FILE); } catch {}
  return { ok: true, wrote, note: reason || '' };
}

// ── 上次异常退出留下的备份：先恢复，避免带着「测试群」继续跑 ──
if (fs.existsSync(BACKUP_FILE)) {
  const r = restoreConfigFromBackup('检测到上次测试未清理的备份');
  console.log(`⚠️ 上次测试可能异常退出，已按备份恢复 config.json（${r.wrote ? '写回了文件' : '无需改动'}）。若桥接正在运行，请重启后生效。`);
}

// ── 本次备份 ──
let backupReady = false;
try {
  fs.copyFileSync(CONFIG_FILE, BACKUP_FILE);
  backupReady = true;
} catch (e) {
  console.error(`无法备份 config.json（${e?.message ?? e}）：为了不弄丢你的白名单，测试终止。`);
  process.exit(1);
}

let origAllow = null;
let origRole = null;

try {
  // 1. 页面
  const page = await fetch(BASE + '/', { headers: authHeaders });
  const html = await page.text();
  ok('页面加载', page.status === 200 && html.includes('白名单 / 管理员') && html.includes('人格与角色') && html.includes('仿真提示词') && html.includes('测试发送'), `长度 ${html.length}`);

  // 2. 角色列表
  let r = await api('/api/roles');
  origRole = r.body.current ?? null;
  ok('角色列表', r.body.roles?.includes('傲娇助手'), JSON.stringify(r.body));

  // 3. 创建人格
  r = await api('/api/roles/create', 'POST', { name: TEST_ROLE, content: '- 性格：测试\n- 说话风格：简短' });
  ok('创建人格', r.body.ok === true, JSON.stringify(r.body));
  r = await api('/api/roles');
  ok('创建后列表出现', r.body.roles?.includes(TEST_ROLE));

  // 4. 设置 / 清除角色
  r = await api('/api/role', 'POST', { role: TEST_ROLE });
  ok('设置角色', r.body.ok === true && r.body.role === TEST_ROLE);
  r = await api('/api/role', 'POST', { role: null });
  ok('清除角色', r.body.ok === true && r.body.role === null);
  if (origRole) {
    r = await api('/api/role', 'POST', { role: origRole });
    ok('恢复原角色', r.body.ok === true && r.body.role === origRole);
  }

  // 5. 会话映射
  r = await api('/api/sessions');
  ok('会话映射', Array.isArray(r.body.sessions), `共 ${r.body.sessions.length} 个`);

  // 6. 挂起列表
  r = await api('/api/pending');
  ok('挂起列表', Array.isArray(r.body.pending), `共 ${r.body.pending.length} 个`);

  // 7. 白名单：读原值 → 加测试群 → 恢复
  const sameIds = (a, b) => JSON.stringify((a || []).map(String).sort()) === JSON.stringify((b || []).map(String).sort());
  r = await api('/api/whitelist');
  origAllow = r.body.allow;
  ok('白名单读取', origAllow && Array.isArray(origAllow.groups), JSON.stringify(origAllow));
  const testGroups = [...new Set([...(origAllow.groups || []), TEST_GROUP_ID])];
  r = await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: testGroups }, deny: { private: [], groups: [] } });
  ok('白名单写入（含测试群）', r.body.ok === true && (r.body.allow.groups || []).map(String).includes(TEST_GROUP_ID), JSON.stringify(r.body.allow));
  r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
  ok('白名单恢复原值', r.body.ok === true && sameIds(r.body.allow.groups, origAllow.groups) && sameIds(r.body.allow.private, origAllow.private), JSON.stringify(r.body.allow));

  // 8. 测试发送（默认只验证白名单放行路径，不真的发到 QQ）
  // 真发消息会打扰群里的人，还会依赖 SnowLuma 在线；所以默认不发，加 --allow-send 才发。
  const withTestGroup = [...new Set([...(origAllow.groups || []).map(String), TEST_GROUP_ID])];
  await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: withTestGroup }, deny: { private: [], groups: [] } });
  r = await api('/api/test-send', 'POST', { kind: 'group', id: TEST_GROUP_ID, message: '【控制台测试】新控制台功能验证成功 ✅' });
  if (ALLOW_SEND) {
    const snowlumaDown = typeof r.body.error === 'string' && !/白名单/.test(r.body.error);
    ok('测试发送群消息（真实发送）', r.body.ok === true || snowlumaDown,
      r.body.ok === true ? JSON.stringify(r.body) : `SnowLuma 不可达（非白名单拦截）：${r.body.error}`);
  } else {
    // 不真发：只要不是「白名单拒绝」就说明校验链路通了
    const whitelistBlocked = typeof r.body.error === 'string' && /白名单/.test(r.body.error);
    ok('测试发送路径（未真实发送）', !whitelistBlocked, whitelistBlocked ? `被白名单拦截：${r.body.error}` : '已通过白名单校验（加 --allow-send 可真实发送）');
  }
  await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });

  // 9. 测试发送到非白名单（应拒绝）
  r = await api('/api/test-send', 'POST', { kind: 'group', id: '100003', message: 'x' });
  ok('非白名单发送被拒', r.body.ok === false && r.status === 403, JSON.stringify(r.body));
} finally {
  // ── 无论如何都恢复 ──
  if (origAllow) {
    try {
      const r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
      if (!r.body?.ok) console.log('⚠️ 通过 API 恢复白名单失败，改用文件备份恢复');
    } catch (e) {
      console.log(`⚠️ 恢复白名单时出错（${e?.message ?? e}），改用文件备份恢复`);
    }
  }
  // 清理测试人格
  try { fs.rmSync(new URL(`../roles/${TEST_ROLE}.md`, import.meta.url), { force: true }); } catch {}
  // 校验磁盘上的配置，必要时用备份覆盖
  if (backupReady) {
    try {
      const bak = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
      const cur = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const same = JSON.stringify(cur?.allow ?? null) === JSON.stringify(bak?.allow ?? null);
      if (!same) {
        cur.allow = bak.allow;
        if (bak.deny !== undefined) cur.deny = bak.deny;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2), 'utf8');
        console.log('⚠️ config.json 白名单未回到原样，已用备份覆盖。若桥接在跑，请重启让它重新加载配置。');
      }
    } catch (e) {
      console.log(`⚠️ 校验/恢复 config.json 失败：${e?.message ?? e}。备份保留在 ${BACKUP_FILE}`);
    }
    // 恢复成功才删备份；失败时留着，下次启动会再试
    try {
      const bak = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
      const cur = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (JSON.stringify(cur?.allow ?? null) === JSON.stringify(bak?.allow ?? null)) fs.unlinkSync(BACKUP_FILE);
    } catch {}
  }
}

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 测试完成');
