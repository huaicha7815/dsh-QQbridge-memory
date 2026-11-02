const KIND = {
  identity:   { label: '身份', color: [255, 214, 150] },
  fact:       { label: '事实', color: [130, 230, 200] },
  event:      { label: '经历', color: [150, 190, 255] },
  plan:       { label: '约定', color: [255, 210, 140] },
  conclusion: { label: '结论', color: [190, 165, 255] },
  diary:      { label: '日记', color: [255, 205, 120] },
  feeling:    { label: '心情', color: [255, 160, 210] },
};
const TH = { fadeAt: 0.60, traceAt: 0.25, dropAt: 0.08 };

const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = Math.min(2, window.devicePixelRatio || 1);
function resize() {
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (linkKind) { linkKind = null; renderKinds(); } else { select(null); } }
});

let stars = [], messages = [], links = [], meta = {};
let cam = { yaw: -0.55, pitch: -1.30, dist: 1950, focal: 1400 };
let opts = { spin: true, beams: false, labels: true };
let tDays = 0;
let hiddenKinds = new Set();
let linkKind = null;   // 高亮并连线的类型；null = 不连
let linkGraph = null;  // 该类型的「固定」邻接图（世界坐标算好就缓存，旋转/缩放都不变）
let linkGraphKind = null;
let query = '';
let msgMatch = '';
let selected = null, hovered = null;
let pendingRetries = 0;   // pending 重试计数（指数退避用）
let galaxyTimer = null;   // 成功加载后的 60s 静默刷新定时器
const placed = [];
let labelQueue = [];
const R = 1000;

const el = (id) => document.getElementById(id);
// 所有记忆字段（标题/正文/标签/id）都来自聊天原文，拼进 innerHTML 前必须转义。
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pad2(n) { return String(n).padStart(2, '0'); }
function shortDate(at) {
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fullDate(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function retention(s, t) {
  const effAge = s.hitDays === null ? s.ageDays : Math.min(s.ageDays, s.hitDays * 0.55);
  return Math.exp(-(effAge + t) / s.tau);
}
function stateOf(r) { return r >= TH.fadeAt ? 'vivid' : r >= TH.traceAt ? 'faded' : r >= TH.dropAt ? 'trace' : 'gone'; }

function project(x, y, z) {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  let X = x * cy - z * sy;
  let Z = x * sy + z * cy;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  let Y = y * cp - Z * sp;
  Z = y * sp + Z * cp;
  const persp = cam.focal / Math.max(26, cam.focal + Z + cam.dist * 0.35);
  const zoom = 1300 / cam.dist;            // 相机拉近 = 整体放大
  return { x: W / 2 + X * persp * zoom, y: H / 2 + Y * persp * zoom, z: Z, s: persp * zoom };
}

function matches(s) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (s.title + ' ' + s.text + ' ' + (s.tags || []).join(' ')).toLowerCase().includes(q);
}

function draw() {
  ctx.clearRect(0, 0, W, H);

  // 背景径向渐变 + 银河盘面光晕
  const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
  bg.addColorStop(0, 'rgba(22,32,58,.95)');
  bg.addColorStop(0.45, 'rgba(9,13,26,.98)');
  bg.addColorStop(1, '#04060f');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // 核心辉光
  const core = project(0, 0, 0);
  // 中心核球：暖金色，模仿参考图里那颗亮核
  const coreR = Math.max(110, 300 * core.s);
  const glow = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, coreR);
  glow.addColorStop(0, 'rgba(255,246,225,.26)');
  glow.addColorStop(0.12, 'rgba(255,232,190,.15)');
  glow.addColorStop(0.34, 'rgba(255,205,140,.06)');
  glow.addColorStop(0.68, 'rgba(240,180,120,.02)');
  glow.addColorStop(1, 'rgba(255,190,120,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(core.x, core.y, coreR, 0, Math.PI * 2); ctx.fill();
  // 极亮的小核
  const nuc = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, Math.max(26, 60 * core.s));
  nuc.addColorStop(0, 'rgba(255,252,240,.45)');
  nuc.addColorStop(1, 'rgba(255,235,200,0)');
  ctx.fillStyle = nuc;
  ctx.beginPath(); ctx.arc(core.x, core.y, Math.max(26, 60 * core.s), 0, Math.PI * 2); ctx.fill();
  // 核心 = 她自己：名字 + 副标
  if (meta.coreLabel) {
    const nameY = core.y - Math.max(58, coreR * 0.42);
    ctx.globalAlpha = 0.96;
    ctx.textAlign = 'center';
    ctx.font = '600 22px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(255,246,220,.97)';
    ctx.shadowColor = 'rgba(255,214,150,.95)';
    ctx.shadowBlur = 18;
    ctx.fillText(meta.coreLabel, core.x, nameY);
    ctx.shadowBlur = 0;
    if (meta.coreSub) {
      ctx.font = '12px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(255,226,180,.68)';
      ctx.fillText(meta.coreSub, core.x, nameY + 20);
    }
    ctx.textAlign = 'left';
  }

  // 旋臂薄雾
  ctx.globalCompositeOperation = 'lighter';
  const nArms = meta.arms || 3;
  for (let pass = 0; pass < 2; pass++) {
    ctx.globalAlpha = pass === 0 ? 0.030 : 0.016;
    ctx.strokeStyle = pass === 0 ? 'rgba(140,180,255,1)' : 'rgba(255,170,205,1)';
    ctx.lineWidth = pass === 0 ? 58 : 20;
    ctx.lineCap = 'round';
    for (let a = 0; a < nArms; a++) {
      ctx.beginPath();
      for (let i = 0; i <= 80; i++) {
        const rr = 0.14 + (i / 80) * 0.88;
        const rad = R * rr;
        const th = (a / nArms) * Math.PI * 2 - 2.6 * Math.log(rr * 6 + 1);
        const p = project(Math.cos(th) * rad, 0, Math.sin(th) * rad);
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }

  // 星尘
  // 对话消息：全部原始聊天，按会话着色、随时间变淡
  for (const msg of messages) {
    const ret = Math.exp(-(msg.ageDays + tDays) / msg.tau);
    if (ret < 0.05) continue;
    const hit = msgMatch ? msg.text.toLowerCase().includes(msgMatch) : false;
    const p = project(msg.x, msg.y, msg.z);
    if (p.s <= 0.02) continue;
    const c = msg.self ? [255, 214, 160] : String(msg.scope || '').startsWith('private') ? [150, 190, 255] : [140, 226, 190];
    ctx.globalAlpha = Math.min(0.95, (0.16 + 0.66 * ret) * (0.45 + p.s * 0.65) * (msg.self ? 1.1 : 1) * (msgMatch ? (hit ? 1.9 : 0.18) : 1));
    ctx.fillStyle = 'rgb(' + c.join(',') + ')';
    const sz = Math.max(1.1, (msgMatch && hit ? 2.8 : 1.35) + p.s * 1.2);
    ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
  }

  // 恒星
  const order = [];
  for (const s of stars) {
    const r = retention(s, tDays);
    s._r = r;
    s._state = stateOf(r);
    if (s._state === 'gone') continue;
    if (hiddenKinds.has(s.kind)) continue;
    const p = project(s.x, s.y, s.z);
    order.push({ s, p });
  }
  order.sort((a, b) => b.p.z - a.p.z);

  // 标签：只给最重要的十几颗 + 选中/悬停，并做碰撞剔除
  const labelSet = new Set();
  placed.length = 0;
  labelQueue = [];
  const drawPts = [];
  if (selected) labelSet.add(selected.id);
  if (hovered) labelSet.add(hovered.id);
  const cand = order.filter(({ s }) => !query || matches(s))
    .map((o) => ({ s: o.s, score: o.s.weight * (0.5 + o.s._r) * (o.s.pin ? 1.6 : 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 14);
  for (const c of cand) labelSet.add(c.s.id);

  // 光柱
  if (opts.beams) {
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = 'rgba(140,190,255,.7)';
    for (const { s, p } of order) {
      const base = project(s.x, 0, s.z);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(base.x, base.y); ctx.stroke();
    }
  }

  for (const { s, p } of order) {
    if (p.s <= 0.02) continue;
    const [cr, cg, cb] = (KIND[s.kind] || KIND.fact).color;
    const r = s._r;
    const state = s._state;
    const dim = state === 'trace' ? 0.35 : state === 'faded' ? 0.7 : 1;
    const base = (0.75 + s.weight * 0.32) * (0.45 + 0.55 * r) * p.s * 2.1 * dim;
    const isSel = selected && selected.id === s.id;
    const isHover = hovered && hovered.id === s.id;
    const isMatch = query ? matches(s) : true;
    const alpha = Math.min(1, (0.18 + 0.82 * r) * (isMatch ? 1 : 0.16) * (state === 'trace' ? 0.55 : 1));

    if (s.pin || isSel || isHover) {
      const glowR = Math.min(170, base * 8);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${isSel ? 0.42 : 0.2})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.globalAlpha = 1; ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    const rad0 = Math.min(16, Math.max(0.7, base * (s.pin ? 2.1 : 1.5)));
    ctx.beginPath(); ctx.arc(p.x, p.y, rad0, 0, Math.PI * 2); ctx.fill();

    if (s.pin) {
      ctx.globalAlpha = 0.35 + 0.5 * r; ctx.strokeStyle = `rgba(${cr},${cg},${cb},.8)`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.min(30, Math.max(1.8, base * 2.5)), 0, Math.PI * 2); ctx.stroke();
    }
    if (isSel || isHover) {
      ctx.globalAlpha = 0.9; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.min(34, Math.max(4, base * 4.2)), 0, Math.PI * 2); ctx.stroke();
    }
    drawPts.push({ s, r, p, base });
    if (opts.labels && labelSet.has(s.id)) labelQueue.push({ s, r, p, base });
  }
  // 同一类型之间的连线：点色点、或选中某个记忆点时出现
  if (linkKind) {
    if (linkGraphKind !== linkKind) { linkGraph = buildKindGraph(linkKind); linkGraphKind = linkKind; }
    if (linkGraph && linkGraph.edges.length) {
      const pos = new Map();
      for (const it of drawPts) pos.set(it.s.id, it.p);
      const col = (KIND[linkKind] || {}).color || [170, 200, 255];
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(' + col.join(',') + ',1)';
      ctx.lineCap = 'round';
      for (const [aId, bId, w] of linkGraph.edges) {
        const A = pos.get(aId), B = pos.get(bId);
        if (!A || !B) continue;
        ctx.globalAlpha = 0.30 + 0.42 * w;
        ctx.lineWidth = 1.8 + 2.2 * w;      // 比之前粗一档
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(' + col.join(',') + ',1)';
      for (const it of drawPts) {
        if (it.s.kind !== linkKind) continue;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(it.p.x, it.p.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.globalCompositeOperation = 'source-over';

  // 标签统一放到最后画：不会被后面星点的光晕盖住
  if (opts.labels) {
    ctx.font = '13.5px "Microsoft YaHei", sans-serif';
    for (const it of labelQueue) {
      const s = it.s, r = it.r, p = it.p, base = it.base;
      const dtxt = shortDate(s.at);
      const txt = s.title.slice(0, 12);
      const wD = ctx.measureText(dtxt).width;
      const wT = ctx.measureText(txt).width;
      const lx = p.x + Math.max(5, base * 1.5), ly = p.y + 5;
      const box = [lx - 3, ly - 13, wD + wT + 12, 18];
      const hit = placed.some((b) => !(box[0] > b[0] + b[2] || box[0] + box[2] < b[0] || box[1] > b[1] + b[3] || box[1] + box[3] < b[1]));
      if (hit) continue;
      placed.push(box);
      // 深色底衬，字号大了也不糊
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = 'rgba(4,8,16,.9)';
      ctx.beginPath();
      const rr = 4, bx = box[0], by = box[1], bw = box[2], bh = box[3];
      ctx.moveTo(bx + rr, by);
      ctx.lineTo(bx + bw - rr, by);
      ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + rr);
      ctx.lineTo(bx + bw, by + bh - rr);
      ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - rr, by + bh);
      ctx.lineTo(bx + rr, by + bh);
      ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - rr);
      ctx.lineTo(bx, by + rr);
      ctx.quadraticCurveTo(bx, by, bx + rr, by);
      ctx.closePath();
      ctx.fill();
      const a0 = 0.8 + 0.2 * Math.min(1, r);
      ctx.globalAlpha = a0;
      ctx.fillStyle = '#9fb8de';
      ctx.fillText(dtxt, lx, ly);
      ctx.globalAlpha = a0;
      ctx.fillStyle = '#e2ecff';
      ctx.fillText(txt, lx + wD + 6, ly);
    }
  }
  ctx.globalAlpha = 1;
}

function loop() {
  if (opts.spin && !dragging) cam.yaw += 0.00045;   // 自转很慢：约 4.7 分钟一圈
  draw();
  requestAnimationFrame(loop);
}

/* ---------- 交互 ---------- */
let dragging = false, lastX = 0, lastY = 0, moved = 0;
cv.addEventListener('pointerdown', (e) => { dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; cv.classList.add('dragging'); cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => {
  if (dragging) {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    cam.yaw += dx * 0.005; cam.pitch = Math.max(-1.35, Math.min(1.35, cam.pitch + dy * 0.004));
    lastX = e.clientX; lastY = e.clientY;
  } else {
    hovered = pick(e.clientX, e.clientY);
    const tip = el('tip');
    if (hovered) {
      tip.classList.add('is-visible');
      // WAAPI 写 transform：不产生 style 属性；先取消旧动画，避免快速移动时堆积
      for (const animation of tip.getAnimations()) animation.cancel();
      tip.animate([{ transform: 'translate3d(' + (e.clientX + 14) + 'px,' + (e.clientY + 10) + 'px,0)' }], { duration: 0, fill: 'forwards' });
      tip.textContent = hovered.isMessage
        ? hovered.text.slice(0, 60)
        : `${hovered.title} · ${(KIND[hovered.kind] || {}).label || ''} · ${(hovered._r * 100).toFixed(0)}%`;
    } else {
      tip.classList.remove('is-visible');
      for (const animation of tip.getAnimations()) animation.cancel();
    }
  }
});
cv.addEventListener('pointerup', (e) => {
  dragging = false; cv.classList.remove('dragging');
  if (moved < 5) {
    const hit = pick(e.clientX, e.clientY);
    if (hit) select(hit); else select(null);
  }
});
// 双击 pin 已移除：服务端没有持久化接口，本地翻转会误导用户（等有持久协议再加）

cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.dist = Math.max(40, Math.min(14000, cam.dist * (e.deltaY > 0 ? 1.16 : 0.84)));
}, { passive: false });

function pick(mx, my) {
  let best = null, bestD = 1e9;
  for (const s of stars) {
    if (s._state === 'gone' || hiddenKinds.has(s.kind)) continue;
    const p = project(s.x, s.y, s.z);
    const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
    const rr = Math.max(9, (0.9 + s.weight * 0.55) * p.s * 3.2) ** 2;
    if (d < rr && d < bestD) { bestD = d; best = s; }
  }
  if (!best) {
    for (const msg of messages) {
      const p = project(msg.x, msg.y, msg.z);
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < 64 && d < bestD) { bestD = d; best = msg; }
    }
  }
  return best;
}

function select(s) {
  const prev = selected;
  selected = s;
  if (s && !s.isMessage && s.kind) {
    linkKind = (prev === s && linkKind === s.kind) ? null : s.kind;
    renderKinds();
  }
  if (!s) { linkKind = null; renderKinds(); }
  const d = el('detail');
  if (!s) { d.classList.remove('show'); return; }
  d.classList.add('show');
  if (s.isMessage) {
    const dt = new Date(s.at);
    el('dTitle').textContent = '对话消息';
    el('dText').textContent = s.text;
    el('dMeta').innerHTML = [
      '<span>' + (String(s.scope || '').startsWith('private') ? '私聊' : '群聊') + '</span>',
      '<span>' + esc(s.channel || '') + '</span>',
      '<span>' + (s.self ? '我说' : '对方') + '</span>',
      '<span>' + fullDate(s.at) + '</span>',
      '<span>留存 ' + (Math.exp(-(s.ageDays + tDays) / s.tau) * 100).toFixed(0) + '%</span>',
    ].join('');
    return;
  }
  el('dTitle').textContent = s.title;
  el('dText').textContent = s.text;
  const r = retention(s, tDays);
  el('dMeta').innerHTML = [
    `<span>${esc((KIND[s.kind] || {}).label || s.kind)}</span>`,
    `<span>${esc(s.rawKind)}</span>`,
    `<span>权重 ${s.weight}</span>`,
    `<span>记于 ${fullDate(s.at)}</span>`,
    `<span>${s.ageDays < 1 ? '今天' : s.ageDays.toFixed(0) + ' 天前'}</span>`,
    `<span>留存 ${(r * 100).toFixed(0)}%</span>`,
    `<span>${stateLabel(stateOf(r))}</span>`,
    s.pin ? '<span>已钉住</span>' : '',
    ...(s.tags || []).slice(0, 4).map((t) => `<span>#${esc(t)}</span>`),
  ].join('');
}
function stateLabel(st) { return { vivid: '清晰', faded: '模糊', trace: '影子', gone: '沉底' }[st] || st; }

/* ---------- 面板 ---------- */
let activeKinds = new Set();

// 在三维世界坐标里算邻接关系：跟着银河转也不会因为屏幕距离变化而断/重连
function buildKindGraph(kind) {
  const list = stars.filter((s) => s.kind === kind);
  const N = list.length;
  const edges = [];
  const MAXD = 460;            // 世界单位（盘面半径 R=1000）
  const K = 3;                 // 每个点连最近的 3 个
  const seen = new Set();
  for (let i = 0; i < N; i++) {
    const a = list[i];
    const cands = [];
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const b = list[j];
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d <= MAXD) cands.push({ j, d });
    }
    cands.sort((p, q) => p.d - q.d);
    for (const c of cands.slice(0, K)) {
      const key = i < c.j ? i + '-' + c.j : c.j + '-' + i;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([a.id, list[c.j].id, 1 - c.d / MAXD]);
    }
  }
  return { edges };
}

function renderKinds() {
  const bar = el('linkbar');
  if (bar) {
    const k = linkKind;
    bar.innerHTML = esc(k)
      ? `<span class="chip" id="linkoff">连线中：<b>${(KIND[k] || {}).label || k}</b> ✕ 点这里退出</span>`
      : '';
    const off = el('linkoff');
    if (off) off.addEventListener('click', () => { linkKind = null; renderKinds(); });
  }
  const box = el('kinds');
  const counts = {};
  for (const s of stars) counts[s.kind] = (counts[s.kind] || 0) + 1;
  box.innerHTML = Object.entries(KIND)
    .filter(([k]) => counts[k])
    .map(([k, v]) => {
      const off = hiddenKinds.has(k) ? ' off' : '';
      const on = linkKind === k ? ' on' : '';
      return `<div class="kindrow${off}${on}" data-k="${k}"><i class="dot kind-dot" data-kind="${k}"></i>${v.label}<span class="n">${counts[k]}</span></div>`;
    }).join('');
  box.querySelectorAll('.kindrow').forEach((row) => {
    row.title = '点小圆点：把同类型的点连起来；点名字：隐藏/显示该类型';
    row.addEventListener('click', (ev) => {
      const k = row.dataset.k;
      if (ev.target.classList.contains('dot')) {
        linkKind = linkKind === k ? null : k;
        renderKinds();
        return;
      }
      hiddenKinds.has(k) ? hiddenKinds.delete(k) : hiddenKinds.add(k);
      renderKinds();
    });
  });
}

function renderStates() {
  const n = { vivid: 0, faded: 0, trace: 0, gone: 0 };
  for (const s of stars) n[stateOf(retention(s, tDays))] += 1;
  el('states').innerHTML = `<span>清晰 ${n.vivid}</span><span>模糊 ${n.faded}</span><span>影子 ${n.trace}</span><span>沉底 ${n.gone}</span>`;
  el('tStats').textContent = tDays === 0 ? '' : `${n.vivid} 清晰 · ${n.faded} 模糊 · ${n.trace} 影子 · ${n.gone} 沉底`;
}

/* ---------- 时间滑杆 ---------- */
function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const MAXD = 365;
function renderTicks() {
  const marks = [0, 30, 90, 180, 365];
  const box = el('ticks');
  box.innerHTML = marks.map((v) => {
    const pct = (v / MAXD) * 100;
    const align = pct <= 2 ? 'translateX(0)' : pct >= 98 ? 'translateX(-100%)' : 'translateX(-50%)';
    const label = v === 0 ? '今天' : `+${v}天`;
    return `<span class="tick tick-${v}">${label}</span>`;
  }).join('');
}
renderTicks();
el('slider').addEventListener('input', (e) => {
  tDays = Number(e.target.value);
  const d = new Date(Date.now() + tDays * 86400000);
  el('tLabel').textContent = tDays === 0 ? '今天' : `${localDate(d)}（+${tDays} 天）`;
  renderStates();
});

el('search').addEventListener('input', (e) => { query = e.target.value.trim(); msgMatch = query.toLowerCase(); });
document.querySelectorAll('#tools button').forEach((b) => b.addEventListener('click', () => {
  const t = b.dataset.t;
  if (t === 'reset') {
    cam = { yaw: -0.55, pitch: -1.30, dist: 1950, focal: 1400 };
    tDays = 0; el('slider').value = 0; el('tLabel').textContent = '今天';
    hiddenKinds.clear(); linkKind = null; linkGraph = null; linkGraphKind = null; query = ''; el('search').value = '';
    opts = { spin: true, beams: false, labels: true };
    document.querySelectorAll('#tools button').forEach((x) => x.classList.toggle('on', x.dataset.t === 'spin' || x.dataset.t === 'labels'));
    renderKinds(); renderStates(); select(null);
    return;
  }
  if (t === 'top') { cam.pitch = -1.5607; cam.dist = 2100; cam.yaw = -0.55; return; }
  opts[t] = !opts[t];
  b.classList.toggle('on', opts[t]);
}));

/* ---------- 启动 ---------- */
async function boot() {
  // 控制台接入：从 ?token= 引导一次，存进 localStorage 后立刻从地址栏抹掉（不留浏览器历史）
  {
    const sp = new URLSearchParams(location.search);
    const t = sp.get('token');
    if (t) {
      try { localStorage.setItem('consoleToken', t); } catch {}
      try { history.replaceState(null, '', location.pathname); } catch {}
    }
  }
  resize();
  const base = location.pathname.replace(/[^/]*$/, '');   // 例如 /memory-galaxy/
  const cands = [`${base}api/galaxy`, `${base}api/data`, `${base}data/galaxy.json`];
  let data = null, used = '';
  for (const url of cands) {
    try {
      const r = await fetch(url, { cache: 'no-store', headers: { 'x-console-token': (() => { try { return localStorage.getItem('consoleToken') || ''; } catch { return ''; } })() } });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && Array.isArray(j.stars)) { data = j; used = url; break; }
    } catch {}
  }
  if (!data) throw new Error('数据源都不可用：' + cands.join(' , '));
  console.log('[galaxy] data from', used);
  // galaxy-pending-retry：后台构建中。指数退避重拉，超过上限给明确提示，别让用户停在空星图。
  const galaxyBuildBroken = data.meta && data.meta.partial && Array.isArray(data.meta.errors)
    && data.meta.errors.some((e) => e && (e.error === 'build-pending' || e.error === 'build-failed'));
  if (galaxyBuildBroken) {
    if (data.meta.errors.some((e) => e && e.error === 'build-failed')) {
      // 冷构建失败：直接给错误面板 + 重试按钮，不要退回退避等一轮
      clearGalaxyTips();
      pendingRetries = 7;
    }
    pendingRetries += 1;
    if (pendingRetries > 6) {
      clearGalaxyTips();
      const tip = document.createElement('div');
      tip.id = 'galaxy-error-tip';
      tip.className = 'panel galaxy-error-tip';
      tip.setAttribute('role', 'alert');
      const text = document.createElement('span');
      text.textContent = '记忆银河生成失败（后台导出连续报错）。';
      const btn = document.createElement('button');
      btn.textContent = '重新加载';
      const waitMs = Number.isFinite(data.meta.retryAfterMs) ? data.meta.retryAfterMs : 0;
      if (waitMs > 2000) {
        btn.disabled = true;
        btn.classList.add('is-busy');
        btn.textContent = '重新加载（' + Math.ceil(waitMs / 1000) + ' 秒后可重试）';
        setTimeout(() => { btn.disabled = false; btn.classList.remove('is-busy'); btn.textContent = '重新加载'; }, waitMs);
      }
      btn.className = 'galaxy-retry-btn';
      btn.addEventListener('click', () => { clearGalaxyTips(); pendingRetries = 0; boot().catch(() => {}); });
      tip.appendChild(text);
      tip.appendChild(btn);
      document.body.appendChild(tip);
      return;
    }
    const delay = [1500, 3000, 5000, 8000, 12000, 20000][Math.min(pendingRetries - 1, 5)];
    if (!document.getElementById('galaxy-pending-tip')) {
      const msg = document.createElement('div');
      msg.className = 'panel galaxy-pending-tip';
      msg.id = 'galaxy-pending-tip';
      msg.textContent = '正在生成记忆银河…（后台构建中）';
      document.body.appendChild(msg);
    }
    setTimeout(() => { boot().catch(() => {}); }, delay);
    return;
  }
  applyGalaxyData(data, { preserveView: false });
  // 支持 ?t=180 直接看未来形态（也方便截图验收）
  const q2 = new URLSearchParams(location.search);
  if (q2.get('view') === 'top') { cam.pitch = -1.5607; cam.dist = 2100; }
  const qq = q2.get('q');
  if (qq) { el('search').value = qq; el('search').dispatchEvent(new Event('input')); }
  const dq = Number(q2.get('dist'));
  if (Number.isFinite(dq) && dq > 0) cam.dist = dq;

  const tq = Number(q2.get('t'));
  if (Number.isFinite(tq) && tq > 0) {
    el('slider').value = Math.min(365, tq);
    el('slider').dispatchEvent(new Event('input'));
  }
  select(null);
  const kq = q2.get('kind');
  if (kq && KIND[kq]) { linkKind = kq; renderKinds(); }
  const selId = q2.get('sel');
  if (selId) { const hit = stars.find((s) => s.id === selId); if (hit) select(hit); }
  loop();
  // 成功加载后每 60 秒静默刷新（保留相机/筛选/选中；linkGraph 失效重建）
  if (!galaxyTimer) galaxyTimer = setInterval(refreshGalaxy, 60_000);
}

/** 清理「正在生成 / 生成失败」两种提示（成功或重试时都要清）。 */
function clearGalaxyTips() {
  for (const id of ['galaxy-pending-tip', 'galaxy-error-tip']) {
    const node = document.getElementById(id);
    if (node) node.remove();
  }
}

/** 统一的数据落地：数据、统计、详情、横幅、linkGraph 失效都走这里。 */
function applyGalaxyData(data, { preserveView = false } = {}) {
  const keep = preserveView
    ? { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, sel: selected ? selected.id : null, link: linkKind }
    : null;
  clearGalaxyTips();
  pendingRetries = 0;
  stars = data.stars;
  messages = (data.messages || []).map((m) => ({ ...m, isMessage: true }));
  links = data.links || [];
  meta = data.meta || meta;

  // 数据不完整横幅：出现/更新/消失都要跟着数据走
  const oldBanner = document.getElementById('data-incomplete-banner');
  if (meta.partial) {
    const banner = oldBanner || document.createElement('div');
    banner.id = 'data-incomplete-banner';
    banner.className = 'panel galaxy-partial-banner';
    banner.setAttribute('role', 'status');
    const errs = Number.isFinite(meta.errorCount) ? meta.errorCount : (Array.isArray(meta.errors) ? meta.errors.length : 0);
    banner.textContent = '⚠ 数据不完整：投影时有 ' + errs + ' 处读取/解析错误，星图可能缺层';
    if (!oldBanner) document.body.appendChild(banner);
  } else if (oldBanner) {
    oldBanner.remove();
  }

  el('nStars').textContent = meta.total;
  el('avgS').textContent = meta.avgStrength;
  el('nPin').textContent = meta.pinned;
  el('nMsgs').textContent = meta.messages || messages.length;
  const src = meta.sources || { memory: meta.total, diary: 0, message: meta.messages || 0 };
  {
    const box = el('sources');
    box.textContent = '';
    for (const [label, value] of [['副库记忆', src.memory], ['日记', src.diary], ['主库消息', src.message]]) {
      const span = document.createElement('span');
      span.textContent = label + ' ' + value;
      box.appendChild(span);
    }
  }

  if (preserveView && keep) {
    cam.yaw = keep.yaw; cam.pitch = keep.pitch; cam.dist = keep.dist;
    // 数据变了：邻接图必须失效重建（保留用户选择的 linkKind 本身）
    linkGraph = null; linkGraphKind = null;
    selected = keep.sel ? (stars.find((s) => s.id === keep.sel) || null) : null;
    renderStates();
    if (selected) select(selected);
    else { selected = null; el('detail').classList.remove('show'); }
    linkKind = keep.link;
    if (linkKind && !stars.some((s) => s.kind === linkKind)) linkKind = null;
    linkGraph = null; linkGraphKind = null;
    renderKinds();
  } else {
    renderKinds(); renderStates();
  }
  renderCacheStatus();
}

/** stale 警告条：后台重建失败时提示「显示的是旧数据」，不遮挡交互。 */
function renderCacheStatus() {
  let tip = document.getElementById('galaxy-cache-tip');
  const warn = meta && meta.cacheState === 'stale' && meta.cacheWarning;
  if (!warn) { if (tip) tip.remove(); return; }
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'galaxy-cache-tip';
    tip.className = 'panel galaxy-cache-tip';
    tip.setAttribute('role', 'status');
    document.body.appendChild(tip);
  }
  tip.textContent = meta.cacheWarning;
}

/** 60 秒静默刷新：页面不可见时跳过；数据没变时跳过重绘。 */
async function refreshGalaxy() {
  if (document.hidden) return;
  try {
    const base = location.pathname.replace(/[^/]*$/, '');
    const headers = { 'x-console-token': (() => { try { return localStorage.getItem('consoleToken') || ''; } catch { return ''; } })() };
    const r = await fetch(base + 'api/data', { cache: 'no-store', headers });
    if (!r.ok) return;
    const j = await r.json();
    if (!j || !Array.isArray(j.stars)) return;
    // 后台构建中：保留当前视图，等下一轮，绝不把页面刷成空星图
    const pending = j.meta && j.meta.partial && Array.isArray(j.meta.errors)
      && j.meta.errors.some((e) => e && (e.error === 'build-pending' || e.error === 'build-failed'));
    if (pending) return;
    // 数据没变就跳过重绘（fingerprint 优先，generatedAt 兜底）
    if (meta && j.meta) {
      const same = j.meta.dataFingerprint && meta.dataFingerprint
        ? j.meta.dataFingerprint === meta.dataFingerprint
        : j.meta.generatedAt === meta.generatedAt;
      if (same) {
        // 数据没变：只更新缓存状态（stale 警告要在页面上可见），不重绘星图
        meta.cacheState = j.meta.cacheState;
        meta.cacheWarning = j.meta.cacheWarning;
        renderCacheStatus();
        return;
      }
    }
    hovered = null;   // 鼠标没动时 tooltip 不能指向刷新前的旧对象
    applyGalaxyData(j, { preserveView: true });
  } catch { /* 静默失败，下一轮再试 */ }
}
boot();
