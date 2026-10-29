// 记忆库只读接口（从 bridge.js 拆出来的第一个「域」）。
//
// 拆的动机：bridge.js 是 1.2 万行的单文件，所有 HTTP 分支挤在一个 if 链里；
// 开源之后别人想定位「记忆库的接口在哪」需要全文搜索。这里把 4 个只读端点
// 收成一个独立模块，依赖全部由调用方注入（不 import bridge 内部状态），
// 这样它既能单独读，也能单独测。
//
// 约定：返回 true 表示「这个请求我处理了」，调用方直接 return；false 表示继续往下走。
import fs from 'node:fs';
import path from 'node:path';

export function handleMemoryApiRequest({
  req, url, sendJson, memoryStore, stateDir,
  readRoleState, groupSelfNotes, buildMemoryGraph, buildMemoryUniverse, auditProfile,
}) {
        // 完整记忆库：档案全量 + 事件流按天索引（点某天再取当天正文）。
        // 面板页是「摘要」，这里是「原文」——两边分工不同。
        if (req.method === 'GET' && url.pathname === '/api/memory/archive') {
          const day = String(url.searchParams.get('day') ?? '').trim();
          if (day) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { sendJson({ ok: false, error: 'day 格式应为 YYYY-MM-DD' }, 400); return true; }
            const events = memoryStore.readEvents({ days: 1, upTo: day })
              .filter((e) => {
                const d = new Date(Number(e?.t) || 0);
                const pad = (v) => String(v).padStart(2, '0');
                return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === day;
              })
              .map((e) => ({
                t: Number(e.t) || 0,
                who: String(e.who || ''),
                kind: String(e.kind || ''),
                text: String(e.text || ''),
                s: Number(e.s) || 1,
              }));
            sendJson({ ok: true, day, events });
            return true;
          }
          const eventsDir = path.join(stateDir, 'memory', 'events');
          const days = [];
          try {
            for (const name of fs.readdirSync(eventsDir)) {
              if (!name.endsWith('.jsonl')) continue;
              const d = name.slice(0, 10);
              let count = 0;
              try {
                count = fs.readFileSync(path.join(eventsDir, name), 'utf8').split('\n').filter(Boolean).length;
              } catch {}
              days.push({ day: d, count });
            }
          } catch {}
          days.sort((a, b) => (a.day < b.day ? 1 : -1));
          const profile = memoryStore.readProfile();
          sendJson({
            ok: true,
            profile: {
              people: Object.entries(profile.people).map(([name, v]) => ({
                name,
                count: Number(v.count) || 0,
                firstSeen: Number(v.firstSeen) || 0,
                lastSeen: Number(v.lastSeen) || 0,
                facts: (v.facts || []).map((f) => ({
                  text: String(f.text || ''),
                  createdAt: Number(f.createdAt) || 0,
                  confirmedAt: Number(f.confirmedAt) || 0,
                  count: Number(f.count) || 1,
                  previous: f.previous ? String(f.previous) : '',
                })),
              })),
              threads: profile.threads.map((t) => ({
                text: String(t.text || ''),
                state: t.state === 'done' ? 'done' : 'open',
                with: Array.isArray(t.with) ? t.with.map(String) : [],
                createdAt: Number(t.createdAt) || 0,
                lastMentionAt: Number(t.lastMentionAt) || 0,
                resolvedBy: t.resolvedBy ? String(t.resolvedBy) : '',
              })),
              self: (() => {
                const groups = groupSelfNotes(profile);
                const out = {};
                for (const [kind, list] of Object.entries(groups)) {
                  out[kind] = list.map((s) => ({ text: String(s.text || ''), at: Number(s.at) || 0, count: Number(s.count) || 1 }));
                }
                return out;
              })(),
            },
            days,
            // 分级浏览用：日摘要 / 周要点 / 月要点（完整记忆库不是只有流水）
            summaries: {
              days: memoryStore.readSummaries({ days: 14, now: Date.now() }).map((s) => ({
                day: String(s.day || ''),
                count: Number(s.count) || 0,
                tiers: Array.isArray(s.tiers) ? s.tiers : [],
                lines: (s.lines || []).map((x) => ({ t: String(x?.t ?? ''), s: Number(x?.s) || 1 })),
              })),
              weeks: memoryStore.readWeekNotes({ weeks: 8, now: Date.now() }).map((w) => ({
                week: String(w.week || w.id || ''),
                lines: (w.lines || w.notes || []).map((x) => String(x?.t ?? x?.text ?? x)),
              })),
              months: memoryStore.readMonthNotes({ months: 6, now: Date.now() }).map((m) => ({
                month: String(m.month || m.id || ''),
                lines: (m.lines || m.notes || []).map((x) => String(x?.t ?? x?.text ?? x)),
              })),
            },
          });
          return true;
        }

        // 记忆星云：她自己的记忆宇宙（中心是她，延伸成主题星云，星云里是光点）
        if (req.method === 'GET' && url.pathname === '/api/memory/universe') {
          const days = Math.max(1, Math.min(60, Number(url.searchParams.get('days')) || 7));
          const maxStars = Math.max(60, Math.min(1200, Number(url.searchParams.get('maxStars')) || 420));
          const profile = memoryStore.readProfile();
          const events = memoryStore.readEvents({ days });
          let selfName = '我';
          try { selfName = readRoleState().role || '我'; } catch {}
          sendJson({
            ok: true,
            days,
            universe: buildMemoryUniverse(profile, events, { now: Date.now(), maxStars, selfName }),
          });
          return true;
        }

        // 记忆星图：档案 + 最近事件流 → 节点/连线/结构诊断。
        // 纯规则构图（不调模型、不做 embedding），前端负责力导向排版。
        if (req.method === 'GET' && url.pathname === '/api/memory/graph') {
          const days = Math.max(1, Math.min(60, Number(url.searchParams.get('days')) || 5));
          const maxEvents = Math.max(6, Math.min(120, Number(url.searchParams.get('maxEvents')) || 36));
          const profile = memoryStore.readProfile();
          const events = memoryStore.readEvents({ days });
          // 星图的中心是她自己——用当前角色名当标签（她是「大肥鱼女儿」，但不是任何人的附属品）
          let selfName = '我';
          try { selfName = readRoleState().role || '我'; } catch {}
          sendJson({
            ok: true,
            days,
            graph: buildMemoryGraph(profile, events, { now: Date.now(), maxEvents, selfName }),
          });
          return true;
        }

        // 控制台「她的记忆」面板：一次拿到规模 / 档案 / 一致性自检 / 最近检索。
        // 这是管理端全权视图（控制台令牌已在全局关卡校验过），与具体会话 key 无关——
        // 长期记忆本来就是一个人的一生，不是某个群的账。
        if (req.method === 'GET' && url.pathname === '/api/memory/overview') {
          const profile = memoryStore.readProfile();
          const nowMs = Date.now();
          const factsOf = (v) => (Array.isArray(v?.facts) ? v.facts : [])
            .slice()
            .sort((a, b) => (Number(b.confirmedAt) || 0) - (Number(a.confirmedAt) || 0))
            .slice(0, 6)
            .map((f) => ({
              text: String(f.text || ''),
              confirmedAt: Number(f.confirmedAt) || 0,
              count: Number(f.count) || 1,
              previous: f.previous ? String(f.previous) : '',
            }));
          sendJson({
            ok: true,
            time: nowMs,
            stats: memoryStore.stats({ now: nowMs }),
            people: Object.entries(profile.people)
              .sort((a, b) => (Number(b[1].lastSeen) || 0) - (Number(a[1].lastSeen) || 0))
              .map(([name, v]) => ({
                name,
                count: Number(v.count) || 0,
                firstSeen: Number(v.firstSeen) || 0,
                lastSeen: Number(v.lastSeen) || 0,
                facts: factsOf(v),
              })),
            threads: profile.threads.map((t) => ({
              text: String(t.text || ''),
              state: t.state === 'done' ? 'done' : 'open',
              with: Array.isArray(t.with) ? t.with.map(String) : [],
              createdAt: Number(t.createdAt) || 0,
              lastMentionAt: Number(t.lastMentionAt) || 0,
              resolvedBy: t.resolvedBy ? String(t.resolvedBy) : '',
            })),
            // 她自己的一生：按类分组给页面分层展示（身份 / 里程碑 / 喜欢 / 心事 / 世界）
            self: (() => {
              const groups = groupSelfNotes(profile);
              const out = {};
              for (const [kind, list] of Object.entries(groups)) {
                out[kind] = list.map((s) => ({ text: String(s.text || ''), at: Number(s.at) || 0, count: Number(s.count) || 1 }));
              }
              return { groups: out, total: profile.self.length };
            })(),
            role: (() => { try { return readRoleState().role || ''; } catch { return ''; } })(),
            audit: auditProfile(profile),
            archiveMonths: memoryStore.listArchiveMonths().length,
            recalls: memoryStore.readRecallLog({ limit: 12 }),
            // 「今天」：面板最上面那一条——她今天过得怎么样、还欠着什么。
            // 情绪不用模型，直接从今天的高分事件里挑带情绪词的句子（规则，零成本）。
            today: (() => {
              const d = new Date(nowMs);
              const pad = (v) => String(v).padStart(2, '0');
              const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
              const dayEvents = memoryStore.readEvents({ days: 1 }).filter((e) => {
                const t = new Date(Number(e?.t) || 0);
                return t.getFullYear() === d.getFullYear() && t.getMonth() === d.getMonth() && t.getDate() === d.getDate();
              });
              const summary = memoryStore.readDaySummary(day);
              const moodRe = /(开心|高兴|难过|委屈|生气|难受|喜欢|讨厌|舍不得|怕|慌|紧张|兴奋|累|困|笑|哭|想你|想你|心疼|暖|热|冷|孤单|寂寞|骄傲|害羞|尴尬|郁闷|烦)/;
              const moods = dayEvents
                .filter((e) => Number(e.s) >= 2 && moodRe.test(String(e.text || '')))
                .sort((a, b) => (Number(b.s) || 0) - (Number(a.s) || 0) || (Number(b.t) || 0) - (Number(a.t) || 0))
                .slice(0, 3)
                .map((e) => ({ text: String(e.text || '').slice(0, 80), at: Number(e.t) || 0, s: Number(e.s) || 1, who: String(e.who || '') }));
              const openThreads = profile.threads
                .filter((t) => t.state === 'open')
                .sort((a, b) => (Number(b.lastMentionAt) || 0) - (Number(a.lastMentionAt) || 0))
                .slice(0, 3)
                .map((t) => ({
                  text: String(t.text || ''),
                  at: Number(t.lastMentionAt) || Number(t.createdAt) || 0,
                  with: Array.isArray(t.with) ? t.with.map(String) : [],
                }));
              return {
                day,
                events: dayEvents.length,
                s3: dayEvents.filter((e) => Number(e.s) >= 3).length,
                // 日摘要的 lines 是 { t, s } 对象，只取文本给面板
                summary: summary?.lines ? summary.lines.slice(0, 4).map((l) => String(l?.t ?? l?.text ?? '')).filter(Boolean) : [],
                moods,
                dueThreads: openThreads,
              };
            })(),
          });
          return true;
        }
  return false;
}
