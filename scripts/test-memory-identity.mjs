// 记忆身份归属：同名不同人分档、改昵称不裂、旧档位自动绑定 uid。
//
// 为什么单独一个文件：这是「人物档案」的核心语义，
// 之前用显示名做键，两个同名群友会共享事实、改群名片又会裂成两份。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergePersonFact, ensureProfile, auditProfile, correctPersonFact,
  filterProfileForSession, filterProfileBySource, mergeThread, mergeSelfNote,
  normalizeSourceKeys, buildInjection, PROFILE_LIMITS, pruneProfile, eventsVisibleToSession,
} from '../src/core/memory-lib.mjs';

test('同名不同 uid 会分成两份档案，不共享事实', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '小明', '喜欢打篮球', { uid: '111' }).profile;
  p = mergePersonFact(p, '小明', '是管理员', { uid: '222' }).profile;
  const keys = Object.keys(p.people);
  assert.equal(keys.length, 2, `应该两档，实际: ${keys.join(', ')}`);
  const allFacts = keys.flatMap((k) => p.people[k].facts.map((f) => f.text));
  assert.ok(allFacts.includes('喜欢打篮球'));
  assert.ok(allFacts.includes('是管理员'));
  // 每档只该有自己那条事实
  for (const k of keys) {
    assert.equal(p.people[k].facts.length, 1, `${k} 不该混入别人的事实`);
  }
});

test('同一个 uid 改昵称不会裂成两份', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '小明', '喜欢打篮球', { uid: '111' }).profile;
  p = mergePersonFact(p, '小明同学', '还喜欢游泳', { uid: '111' }).profile;
  assert.equal(Object.keys(p.people).length, 1, '同一个 uid 应该只有一份档案');
  const entry = Object.values(p.people)[0];
  assert.equal(entry.facts.length, 2, '两条事实应该合到同一个人身上');
});

test('旧数据（名字键、无 uid）会自动绑定 uid', () => {
  const q = ensureProfile({ people: { 老张: { facts: [], count: 0, firstSeen: 1, lastSeen: 1 } } });
  const r = mergePersonFact(q, '老张', '是司机', { uid: '333' });
  assert.equal(r.profile.people['老张']?.uid, '333', '旧档位应该被绑定 uid');
  assert.equal(Object.keys(r.profile.people).length, 1, '不应该多开一档');
});

test('没有 uid 时完全退回旧行为', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '阿花', '爱笑').profile;
  p = mergePersonFact(p, '阿花', '养猫').profile;
  assert.equal(Object.keys(p.people).length, 1);
  assert.equal(p.people['阿花'].facts.length, 2);
});

test('uid 字段能穿过 ensureProfile 不被丢掉', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '小明', '事实', { uid: '999' }).profile;
  const again = ensureProfile(p);
  const entry = Object.values(again.people).find((e) => e.uid === '999');
  assert.ok(entry, 'uid 必须保留（否则下次又按名字合并了）');
  assert.equal(entry.name, '小明', '显示名也要保留');
});

test('档案审计仍然健康（分档后没有重复事实）', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '小明', '喜欢打篮球', { uid: '111' }).profile;
  p = mergePersonFact(p, '小明', '是管理员', { uid: '222' }).profile;
  const audit = auditProfile(p);
  assert.ok(audit, 'auditProfile 要有返回');
});

test('同名不同 uid 时，纠错只改到正确的那个人', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '小明', '喜欢篮球', { uid: '111' }).profile;
  p = mergePersonFact(p, '小明', '是管理员', { uid: '222' }).profile;
  // 对 uid=222 的事实纠错
  const out = correctPersonFact(p, '小明', '是管理员（确认真的是）', { uid: '222' });
  const keys = Object.keys(out.profile.people);
  const u111 = keys.find((k) => out.profile.people[k].uid === '111');
  const u222 = keys.find((k) => out.profile.people[k].uid === '222');
  const facts111 = out.profile.people[u111].facts.map((f) => f.text);
  const facts222 = out.profile.people[u222].facts.map((f) => f.text);
  assert.ok(facts111.includes('喜欢篮球'), 'uid=111 的事实不能被改');
  assert.ok(facts222.some((x) => x.includes('确认真的是')), 'uid=222 的事实应被纠正');
});

test('档案按来源过滤：isolated 下看不到别的会话写入的事实', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '小明', '群里的公开事实', { uid: '111', sourceKey: 'group:111' }).profile;
  p = mergePersonFact(p, '小明', '私聊里的秘密事实', { uid: '111', sourceKey: 'private:222' }).profile;
  const scoped = filterProfileBySource(p, 'group:111');
  const facts = Object.values(scoped.people).flatMap((e) => e.facts.map((f) => f.text));
  assert.ok(facts.includes('群里的公开事实'), '本会话的事实要保留');
  assert.ok(!facts.includes('私聊里的秘密事实'), '别的会话的事实不能出现');
});

test('没有来源的旧事实在 isolated 下也不返回（fail-closed）', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '老张', '没有来源的旧事实').profile; // 没传 sourceKey
  const scoped = filterProfileBySource(p, 'group:111');
  const facts = Object.values(scoped.people).flatMap((e) => e.facts.map((f) => f.text));
  assert.equal(facts.length, 0, '来源未知的旧事实在隔离模式下不能默认放行');
});

test('threads 和 self 也按来源过滤，不只是人物事实', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '小明', '群里的公开事实', { uid: '1', sourceKey: 'group:111' }).profile;
  p = mergeThread(p, '私聊里才说的线', { sourceKey: 'private:222' }).profile;
  p = mergeSelfNote(p, '私聊里才有的心事', { sourceKey: 'private:222' }).profile;
  const scoped = filterProfileForSession(p, 'group:111');
  assert.equal(scoped.threads.length, 0, '别的会话的线不能出现');
  assert.equal(scoped.self.length, 0, '别的会话的心事不能出现');
  assert.equal(scoped.audit.length, 0, 'audit 不通过会话级接口返回');
  const facts = Object.values(scoped.people).flatMap((e) => e.facts.map((f) => f.text));
  assert.ok(facts.includes('群里的公开事实'), '本会话的事实要保留');
});

test('纠正事实会继承旧来源，纠错后在原会话仍可见', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '小明', '喜欢篮球', { uid: '1', sourceKey: 'group:111' }).profile;
  p = correctPersonFact(p, '小明', '喜欢篮球（纠正版）', { uid: '1', sourceKey: 'group:111' }).profile;
  const scoped = filterProfileForSession(p, 'group:111');
  const facts = Object.values(scoped.people).flatMap((e) => e.facts.map((f) => f.text));
  assert.ok(facts.some((x) => x.includes('纠正版')), '纠错后的内容必须仍对本会话可见');
});

test('同一事实被第二个会话确认时，来源会合并', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '小明', '喜欢篮球', { uid: '1', sourceKey: 'group:111' }).profile;
  p = mergePersonFact(p, '小明', '喜欢篮球', { uid: '1', sourceKey: 'private:222' }).profile;
  const fact = Object.values(p.people).flatMap((e) => e.facts)[0];
  const keys = normalizeSourceKeys(fact);
  assert.ok(keys.includes('group:111'), '群聊来源要保留');
  assert.ok(keys.includes('private:222'), '私聊确认也要并进去');
});

// 表驱动：所有「写入/命中」分支都必须把当前会话并进来源。
// 以前是每个分支各自记得调用 addSourceKeys，漏一个就泄漏一次；
// 现在统一收尾，这里用同一张表逐条验证。
const SOURCE_BRANCHES = [
  {
    name: 'person CREATE（新事实）',
    setup: () => ensureProfile({}),
    apply: (p) => mergePersonFact(p, '小明', '喜欢篮球', { uid: '1', sourceKey: 'group:111' }).profile,
    pick: (p) => Object.values(p.people).flatMap((e) => e.facts),
  },
  {
    name: 'person CORROBORATE（同文本再确认）',
    setup: () => mergePersonFact(ensureProfile({}), '小明', '喜欢篮球', { uid: '1', sourceKey: 'private:222' }).profile,
    apply: (p) => mergePersonFact(p, '小明', '喜欢篮球', { uid: '1', sourceKey: 'group:111' }).profile,
    pick: (p) => Object.values(p.people).flatMap((e) => e.facts),
  },
  {
    name: 'correct CORRECT（替换旧事实）',
    setup: () => mergePersonFact(ensureProfile({}), '小明', '喜欢篮球', { uid: '1', sourceKey: 'private:222' }).profile,
    apply: (p) => correctPersonFact(p, '小明', '喜欢篮球（纠正）', { uid: '1', sourceKey: 'group:111' }).profile,
    pick: (p) => Object.values(p.people).flatMap((e) => e.facts),
  },
  {
    name: 'correct fallback CREATE（找不到相似→新建）',
    setup: () => mergePersonFact(ensureProfile({}), '小明', '喜欢篮球', { uid: '1', sourceKey: 'private:222' }).profile,
    apply: (p) => correctPersonFact(p, '小明', '今天去了火星', { uid: '1', sourceKey: 'group:111' }).profile,
    pick: (p) => Object.values(p.people).flatMap((e) => e.facts).filter((f) => f.text.includes('火星')),
  },
  {
    name: 'thread open 再提及',
    setup: () => mergeThread(ensureProfile({}), '私聊里说好的约定', { sourceKey: 'private:222' }).profile,
    apply: (p) => mergeThread(p, '私聊里说好的约定', { sourceKey: 'group:111' }).profile,
    pick: (p) => p.threads,
  },
  {
    name: 'thread done 收尾',
    setup: () => mergeThread(ensureProfile({}), '私聊里说好的约定', { sourceKey: 'private:222' }).profile,
    apply: (p) => mergeThread(p, '私聊里说好的约定', { state: 'done', sourceKey: 'group:111' }).profile,
    pick: (p) => p.threads,
  },
];

for (const branch of SOURCE_BRANCHES) {
  test(`来源合并覆盖分支：${branch.name}`, () => {
    const after = branch.apply(branch.setup());
    const records = branch.pick(after);
    assert.ok(records.length > 0, '应该有记录被写入/命中');
    const merged = records.some((rec) => normalizeSourceKeys(rec).includes('group:111'));
    assert.ok(merged, `当前会话的 sourceKey 必须被合并进来（${branch.name}）`);
  });
}

test('会话投影不泄露全局计数和来源 ID', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '小明', '喜欢篮球', { uid: '1', sourceKey: 'group:111' }).profile;
  p = mergePersonFact(p, '小明', '喜欢篮球', { uid: '1', sourceKey: 'private:222' }).profile;
  p = mergePersonFact(p, '小明', '喜欢篮球', { uid: '1', sourceKey: 'private:222' }).profile;
  const scoped = filterProfileForSession(p, 'group:111');
  const fact = Object.values(scoped.people).flatMap((e) => e.facts)[0];
  assert.equal(fact.count, 1, '会话级 count 不能暴露全局确认次数');
  assert.equal(fact.sourceKeys, undefined, '不能把来源数组带给会话');
});

// ── 会话投影的时钟口径 ───────────────────────────────────────────────
// 归零 confirmedAt / lastSeen 会让 buildInjection 的「取最近几条」退化成插入顺序；
// 直接用原时间戳又会把跨会话活动时间泄漏给会话。这里锁住「序数」这个折中。

test('投影保留时序秩：最新的事实仍排最前，人物仍按最近互动排序', () => {
  let p = ensureProfile({});
  const base = 1_700_000_000_000;
  // 三条事实：确认时间依次变新
  p = mergePersonFact(p, '小明', '旧事实', { uid: '1', sourceKey: 'group:111' }).profile;
  p = mergePersonFact(p, '小明', '中事实', { uid: '1', sourceKey: 'group:111' }).profile;
  p = mergePersonFact(p, '小明', '新事实', { uid: '1', sourceKey: 'group:111' }).profile;
  // 手工把确认时间排开（mergePersonFact 用 now，同一毫秒会并列）
  const facts = p.people[Object.keys(p.people)[0]].facts;
  const order = ['旧事实', '中事实', '新事实'];
  for (const f of facts) f.confirmedAt = base + order.indexOf(order.find((x) => f.text.startsWith(x))) * 1000;
  p.people[Object.keys(p.people)[0]].lastSeen = base + 2000;
  // 另一个人：更早互动
  p = mergePersonFact(p, '小红', '很久以前的事', { uid: '2', sourceKey: 'group:111' }).profile;
  const hong = Object.entries(p.people).find(([k]) => p.people[k].uid === '2')[1];
  hong.facts[0].confirmedAt = base - 5000;
  hong.lastSeen = base - 5000;

  const scoped = filterProfileForSession(p, 'group:111');
  assert.equal(scoped.clock, 'session-rank', '投影必须标记时间口径');
  const ming = Object.entries(scoped.people).find(([k]) => scoped.people[k].uid === '1')[1];
  const sorted = ming.facts.slice().sort((a, b) => (b.confirmedAt || 0) - (a.confirmedAt || 0)).map((f) => f.text);
  assert.equal(sorted[0], '新事实', '最新确认的事实必须排在最前（不能因为归零而退化成插入顺序）');
  assert.equal(sorted[sorted.length - 1], '旧事实', '最旧的事实排最后');
  const names = Object.entries(scoped.people).sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0)).map(([k]) => k);
  assert.equal(scoped.people[names[0]].uid, '1', '最近互动的人排在前面');
  // 绝对时间不能下发
  const leaked = ming.facts.filter((f) => f.confirmedAt >= 1_700_000_000_000 || f.createdAt >= 1_700_000_000_000);
  assert.equal(leaked.length, 0, '投影里的时间不能是真实时间戳（那会泄漏跨会话活动时间）');
  for (const f of ming.facts) assert.ok(f.confirmedAt > 0 && f.confirmedAt < 1000, '时间应是会话内序数');
  assert.equal(scoped.updatedAt, 0, '全局 updatedAt 不下发');
});

test('投影下的注入不渲染假日期，且事实按新旧取前三条', () => {
  let p = ensureProfile({});
  const base = 1_700_000_000_000;
  p = mergePersonFact(p, '小明', '第一件事', { uid: '1', sourceKey: 'group:111' }).profile;
  p = mergePersonFact(p, '小明', '第二件事', { uid: '1', sourceKey: 'group:111' }).profile;
  p = mergePersonFact(p, '小明', '第三件事', { uid: '1', sourceKey: 'group:111' }).profile;
  p = mergePersonFact(p, '小明', '第四件事', { uid: '1', sourceKey: 'group:111' }).profile;
  const key = Object.keys(p.people)[0];
  // 手工排开时间：第一件最旧 … 第四件最新
  const labels = ['第一件事', '第二件事', '第三件事', '第四件事'];
  for (const f of p.people[key].facts) {
    const i = labels.findIndex((x) => f.text.startsWith(x));
    f.confirmedAt = base + i * 60_000;
  }
  p.people[key].lastSeen = base + 180_000;
  p = mergeThread(p, '答应她的那件事', { sourceKey: 'group:111' }).profile;
  p.threads[0].lastMentionAt = base + 120_000;

  const scoped = filterProfileForSession(p, 'group:111');
  const text = buildInjection({ profile: scoped, query: '', now: base + 999_999, config: { crossSessionPolicy: 'isolated' } });
  assert.ok(text.includes('第四件事'), '最新的事实要注入');
  assert.ok(!text.includes('第一件事'), '最旧的事实不该挤进前三条');
  assert.ok(!/（0?1-0?1 提过）/.test(text), '序数时间不能被渲染成 1970 年的假日期');
  assert.ok(!text.includes('提过）') || !text.includes('01-01'), '不能出现 01-01 这种假日期');
});

test('注入按最近确认时间选 self note，而不是数组插入顺序', () => {
  let p = ensureProfile({});
  const base = 1_700_000_000_000;
  p = mergeSelfNote(p, '我是第一条身份', { kind: 'identity', now: base + 1000, sourceKey: 'group:111' }).profile;
  p = mergeSelfNote(p, '我是第二条身份', { kind: 'identity', now: base + 2000, sourceKey: 'group:111' }).profile;
  p = mergeSelfNote(p, '我是第三条身份', { kind: 'identity', now: base + 3000, sourceKey: 'group:111' }).profile;
  // 重新确认第一条：at 刷新到最新，但它在数组里仍排最前
  p = mergeSelfNote(p, '我是第一条身份', { kind: 'identity', now: base + 9000, sourceKey: 'group:111' }).profile;
  const scoped = filterProfileForSession(p, 'group:111');
  const text = buildInjection({ profile: scoped, now: base + 10000, config: { crossSessionPolicy: 'isolated' } });
  assert.ok(text.includes('我是第一条身份'), '最近被确认的那条必须进注入（旧实现按插入顺序会把它排除）');
  assert.ok(text.includes('我是第三条身份'), '第二新的也要在');
  assert.ok(!text.includes('我是第二条身份'), '最旧的那条应该被挤出（否则说明没按时间选）');
});

test('recentSelf 输出按 at 升序（较早 → 较晚），不是插入顺序', () => {
  let p = ensureProfile({});
  const base = 1_700_100_000_000;
  p = mergeSelfNote(p, '我是第一条身份', { kind: 'identity', now: base + 1000, sourceKey: 'group:111' }).profile;
  p = mergeSelfNote(p, '我是第二条身份', { kind: 'identity', now: base + 2000, sourceKey: 'group:111' }).profile;
  p = mergeSelfNote(p, '我是第三条身份', { kind: 'identity', now: base + 3000, sourceKey: 'group:111' }).profile;
  // 重新确认第一条：它变成最新确认的那条，但仍排在数组最前
  p = mergeSelfNote(p, '我是第一条身份', { kind: 'identity', now: base + 9000, sourceKey: 'group:111' }).profile;
  const scoped = filterProfileForSession(p, 'group:111');
  const text = buildInjection({ profile: scoped, now: base + 10000, config: { crossSessionPolicy: 'isolated' } });
  const atFirst = text.indexOf('我是第一条身份');
  const atThird = text.indexOf('我是第三条身份');
  assert.ok(atFirst >= 0 && atThird >= 0, '两条都应该被选中');
  assert.ok(atThird < atFirst, '第三条（较早确认）要排在第一条（刚重新确认）前面');
});

// ── isolated 的写集：读不到的记录不能参与候选匹配 ──────────────────
// 之前隔离只约束了读取投影：correct 会在完整 profile 里找最相似的 fact，
// 于是群会话能把私聊原文当 replaced 拿回去、还在 previous 里留一份；
// threadDone 也能把只有私聊来源的线关掉。读集和写集必须同时限制。

test('isolated 写路径：群会话 correct 不能命中私聊独有事实', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '小明', '银行卡尾号是八八八八', { uid: '1', sourceKey: 'private:222' }).profile;
  const out = correctPersonFact(p, '小明', '银行卡尾号是六六六六', {
    uid: '1', sourceKey: 'group:111', visibilityKey: 'group:111',
  });
  assert.equal(out.action, 'CREATE', '看不到私聊事实就只能新建，不能走 CORRECT');
  assert.equal(out.replaced, undefined, '不能把私聊原文回显给群会话');
  // 群视图：只有群自己写的这条，没有任何 previous 残留
  const groupView = filterProfileForSession(out.profile, 'group:111');
  const groupFacts = Object.values(groupView.people).flatMap((e) => e.facts);
  assert.equal(groupFacts.length, 1, '群视图只应看到群来源的一条');
  assert.ok(groupFacts[0].text.includes('六六六六'));
  assert.equal(groupFacts[0].previous, undefined, '如果走了 CORRECT，previous 会把私聊原文带进群档案');
  assert.ok(!JSON.stringify(groupFacts).includes('八八八八'), '群档案里不能出现私聊原文');
  // 私聊事实必须原样保留
  const privView = filterProfileForSession(out.profile, 'private:222');
  const privFacts = Object.values(privView.people).flatMap((e) => e.facts);
  assert.ok(privFacts.some((f) => f.text === '银行卡尾号是八八八八'), '私聊事实不能被群会话改掉');
});

test('isolated 写路径：群会话 threadDone 不能关闭私聊独有 thread', () => {
  let p = ensureProfile({});
  p = mergeThread(p, '私聊里说好的约定', { sourceKey: 'private:222' }).profile;
  const out = mergeThread(p, '私聊里说好的约定', {
    state: 'done', sourceKey: 'group:111', visibilityKey: 'group:111',
  });
  // resolved 里最多是本次群会话自己新建的那条：私聊那条线不能被报成「已了结」
  assert.ok(out.resolved.length <= 1, 'resolved 里不应包含被跨会话收掉的私聊线');
  const privThread = out.profile.threads.find((t) => normalizeSourceKeys(t).includes('private:222'));
  assert.ok(privThread, '私聊线还在');
  assert.equal(privThread.state, 'open', '私聊线状态不能被群会话改动');
  assert.equal(privThread.resolvedBy, undefined, '不能写进群会话的了结文本');
  assert.equal(privThread.resolvedAt, undefined, '不能写进了结时间');
  // 群会话自己那条线是 done，且只在群视图里可见
  const groupView = filterProfileForSession(out.profile, 'group:111');
  assert.ok(groupView.threads.some((t) => t.state === 'done'), '群自己的线可以正常了结');
  assert.ok(!groupView.threads.some((t) => normalizeSourceKeys(t).includes('private:222')), '群视图看不到私聊那条线');
});

test('open 模式行为不变：不传 visibilityKey 时仍跨会话合并', () => {
  let p = ensureProfile({});
  p = mergePersonFact(p, '小明', '喜欢篮球', { uid: '1', sourceKey: 'private:222' }).profile;
  const out = correctPersonFact(p, '小明', '喜欢篮球（纠正）', { uid: '1', sourceKey: 'group:111' });
  assert.equal(out.action, 'CORRECT', 'open 模式仍按全局候选纠错');
  assert.ok(String(out.replaced || '').includes('喜欢篮球'));
  const threadOut = mergeThread(
    mergeThread(p, '私聊里说好的约定', { sourceKey: 'private:222' }).profile,
    '私聊里说好的约定',
    { state: 'done', sourceKey: 'group:111' },
  );
  assert.deepEqual(threadOut.resolved, ['私聊里说好的约定'], 'open 模式仍会收掉同话题的线');
});

// ── isolated 的淘汰集：写入不能删掉自己看不见的记录 ──────────────────
// 之前隔离只覆盖了「匹配哪些记录」，没覆盖「容量裁剪删哪些记录」：
// 群会话新增一条 fact，就会按全局 confirmedAt 把私聊最旧的那条挤掉。

test('isolated 写路径：群会话新增事实不会淘汰私聊旧事实（maxFactsPerPerson）', () => {
  let p = ensureProfile({});
  for (let i = 0; i < 8; i += 1) {
    p = mergePersonFact(p, '小明', `私聊事实${i}`, { uid: '1', sourceKey: 'private:222' }).profile;
  }
  p = mergePersonFact(p, '小明', '群聊新增事实', { uid: '1', sourceKey: 'group:111', visibilityKey: 'group:111' }).profile;
  const privFacts = Object.values(filterProfileForSession(p, 'private:222').people).flatMap((e) => e.facts).map((f) => f.text);
  assert.equal(privFacts.length, 8, '私聊 8 条必须一条不少');
  assert.ok(privFacts.includes('私聊事实0'), '最旧的私聊事实也不能被群的写入挤掉');
  const groupFacts = Object.values(filterProfileForSession(p, 'group:111').people).flatMap((e) => e.facts).map((f) => f.text);
  assert.deepEqual(groupFacts, ['群聊新增事实'], '群视图只看到自己的那条');
});

test('isolated 裁剪只淘汰可见人物档位，不删看不见的（maxPeople）', () => {
  const base = 1_700_000_000_000;
  const p = ensureProfile({});
  for (let i = 0; i < PROFILE_LIMITS.maxPeople + 1; i += 1) {
    p.people[`群友${i}`] = {
      facts: [{ text: `群事实${i}`, createdAt: base + i, confirmedAt: base + i, count: 1, sourceKeys: ['group:111'] }],
      count: 1, firstSeen: base + i, lastSeen: base + i,
    };
  }
  p.people['私聊某人'] = {
    facts: [{ text: '私聊事实', createdAt: base, confirmedAt: base, count: 1, sourceKeys: ['private:222'] }],
    count: 1, firstSeen: base, lastSeen: base,
  };
  const iso = pruneProfile(p, PROFILE_LIMITS, { visibilityKey: 'group:111' });
  assert.ok(iso.people['私聊某人'], '私聊档位不能被群写入淘汰');
  assert.equal(
    Object.keys(iso.people).length,
    PROFILE_LIMITS.maxPeople + 2 - 1,
    '只淘汰了一个群可见的档位',
  );
  const open = pruneProfile(p, PROFILE_LIMITS);
  assert.ok(!open.people['私聊某人'], 'open 模式仍按全局最旧淘汰（行为没变）');
});

test('isolated 裁剪只淘汰可见线，不删看不见的（maxThreads）', () => {
  const base = 1_700_000_000_000;
  const p = ensureProfile({});
  for (let i = 0; i < PROFILE_LIMITS.maxThreads; i += 1) {
    p.threads.push({ text: `群线${i}`, with: [], state: 'open', createdAt: base + i, lastMentionAt: base + i, sourceKeys: ['group:111'] });
  }
  p.threads.push({ text: '私聊的线', with: [], state: 'open', createdAt: base, lastMentionAt: base, sourceKeys: ['private:222'] });
  const iso = pruneProfile(p, PROFILE_LIMITS, { visibilityKey: 'group:111' });
  assert.ok(iso.threads.some((t) => t.text === '私聊的线'), '私聊线不能被群写入淘汰');
  assert.equal(iso.threads.length, PROFILE_LIMITS.maxThreads + 1, '可见线没超限，不该删任何一条');
  const open = pruneProfile(p, PROFILE_LIMITS);
  assert.ok(!open.threads.some((t) => t.text === '私聊的线'), 'open 模式仍按全局淘汰最旧的线');
});

test('isolated 裁剪只淘汰可见 self note，不删看不见的（maxSelfNotes）', () => {
  const base = 1_700_000_000_000;
  const p = ensureProfile({});
  // 私聊那条先放进数组：open 模式按数组位置淘汰（rest.slice(-room)），
  // 这样 open 对照才会真的把它挤掉，测试才有区分度。
  p.self.push({ text: '私聊的心事', kind: 'feeling', at: base, count: 1, sourceKeys: ['private:222'] });
  for (let i = 0; i < PROFILE_LIMITS.maxSelfNotes; i += 1) {
    p.self.push({ text: `群心事${i}`, kind: 'feeling', at: base + i + 1, count: 1, sourceKeys: ['group:111'] });
  }
  const iso = pruneProfile(p, PROFILE_LIMITS, { visibilityKey: 'group:111' });
  assert.ok(iso.self.some((x) => x.text === '私聊的心事'), '私聊 self note 不能被群写入淘汰');
  assert.equal(iso.self.length, PROFILE_LIMITS.maxSelfNotes + 1);
  const open = pruneProfile(p, PROFILE_LIMITS);
  assert.ok(!open.self.some((x) => x.text === '私聊的心事'), 'open 模式仍按全局淘汰最旧的心事');
});

test('事件过滤：证据校验/uid 推断只读本会话可见事件', () => {
  const events = [
    { t: 1, k: 'group:111', text: '群里的原文' },
    { t: 2, k: 'private:222', text: '私聊的原文' },
    { t: 3, text: '没有来源的旧事件' },
  ];
  const iso = eventsVisibleToSession(events, 'group:111');
  assert.deepEqual(
    iso.map((e) => e.text),
    ['群里的原文'],
    '无来源事件在 isolated 下也必须是不可见（fail-closed），否则旧私聊正文能越界',
  );
  assert.equal(eventsVisibleToSession(events, '').length, 3, 'open 模式不过滤');
});

test('读取路径不再硬截断事实数量（收敛只发生在 pruneProfile）', () => {
  const base = 1_700_200_000_000;
  const raw = {
    people: {
      小明: {
        facts: Array.from({ length: 12 }, (_, i) => ({ text: `事实${i}`, createdAt: base + i, confirmedAt: base + i, count: 1, sourceKeys: ['group:111'] })),
        count: 12, firstSeen: base, lastSeen: base + 11,
      },
    },
  };
  const loaded = ensureProfile(raw);
  assert.equal(
    Object.values(loaded.people)[0].facts.length,
    12,
    'ensureProfile 不能再截断：readProfile + writeProfile 会把超额事实永久删掉',
  );
  const pruned = pruneProfile(loaded, PROFILE_LIMITS);
  assert.equal(Object.values(pruned.people)[0].facts.length, PROFILE_LIMITS.maxFactsPerPerson, '数量收敛交给 pruneProfile');
});

// ── 共享断言的淘汰语义 ─────────────────────────────────────────────
// 一条 sourceKeys:['group','private'] 的事实同时被两个会话看得见：
// 群会话超限时可以淘汰它（它不是「看不见的数据」），但应该最后才牺牲它——
// 删共享等于替另一个会话做决定。

test('共享事实在容量淘汰时被最后牺牲（facts）', () => {
  const base = 1_700_300_000_000;
  const p = ensureProfile({});
  const facts = [];
  for (let i = 0; i < 7; i += 1) {
    facts.push({ text: `群独家${i}`, createdAt: base + i, confirmedAt: base + i, count: 1, sourceKeys: ['group:111'] });
  }
  facts.push({
    text: '群和私聊都确认过的事',
    createdAt: base, confirmedAt: base - 1000, count: 1,
    sourceKeys: ['group:111', 'private:222'],
  });
  p.people['小明'] = { facts, count: 8, firstSeen: base, lastSeen: base };
  const out = mergePersonFact(p, '小明', '群新事实', { sourceKey: 'group:111', visibilityKey: 'group:111' });
  const groupTexts = Object.values(filterProfileForSession(out.profile, 'group:111').people).flatMap((e) => e.facts).map((f) => f.text);
  assert.ok(groupTexts.includes('群和私聊都确认过的事'), '共享事实应最后才被牺牲（它比独家更旧也一样）');
  assert.ok(!groupTexts.includes('群独家0'), '最旧的独家事实先被淘汰');
  assert.ok(groupTexts.includes('群新事实'));
  const privTexts = Object.values(filterProfileForSession(out.profile, 'private:222').people).flatMap((e) => e.facts).map((f) => f.text);
  assert.ok(privTexts.includes('群和私聊都确认过的事'), '私聊视图不能因为群的裁剪而丢共享事实');
});

test('共享线在容量淘汰时被最后牺牲（threads）', () => {
  const base = 1_700_400_000_000;
  const p = ensureProfile({});
  for (let i = 0; i < PROFILE_LIMITS.maxThreads; i += 1) {
    p.threads.push({ text: `群独家线${i}`, with: [], state: 'open', createdAt: base + i, lastMentionAt: base + i, sourceKeys: ['group:111'] });
  }
  p.threads.push({
    text: '群和私聊共有的线', with: [], state: 'open',
    createdAt: base, lastMentionAt: base - 1000, sourceKeys: ['group:111', 'private:222'],
  });
  const scoped = pruneProfile(p, PROFILE_LIMITS, { visibilityKey: 'group:111' });
  assert.ok(scoped.threads.some((t) => t.text === '群和私聊共有的线'), '共享线应最后才被牺牲');
  assert.ok(!scoped.threads.some((t) => t.text === '群独家线0'), '最旧的独家线先被淘汰');
  assert.equal(scoped.threads.length, PROFILE_LIMITS.maxThreads + 1 - 1, '只淘汰了一条');
});
