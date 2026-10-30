// 记忆身份归属：同名不同人分档、改昵称不裂、旧档位自动绑定 uid。
//
// 为什么单独一个文件：这是「人物档案」的核心语义，
// 之前用显示名做键，两个同名群友会共享事实、改群名片又会裂成两份。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePersonFact, ensureProfile, auditProfile, correctPersonFact } from '../src/core/memory-lib.mjs';

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
