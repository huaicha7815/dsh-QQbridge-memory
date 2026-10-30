// socialV2 记忆工具接口（AI 自己调的那批：热记忆 / 长期记忆 / 档案增减）。
//
// 这批端点的调用方是 QQ 侧的 AI（带 x-agent-token），不是控制台；
// 所以每个端点都重复了「token / 会话范围 / 工具开关」三道校验，这里保持原样。
//
// 约定：返回 true 表示「这个请求我处理了」，调用方直接 return；false 继续往下走。
//
// ── 端点可见性策略（isolated 下必须逐个确认，新增指标别再从统计面泄漏） ──
//   memory-search         session   ：检索按 key 过滤
//   memory-inspect        session   ：stats/recalls/profile 全是会话级
//   memory-profile        session   ：档案走 filterProfileBySession 投影
//   memory-stats          session   ：只返回本会话事件统计（不含 paths/config/pending）
//   memory-remember       session   ：写路径带 visibilityKey
//   memory（query）        session   ：读的是该 key 的 hot 状态
//   memory-update         session   ：只改该 key 的 hot 状态
//   memory-remove         session   ：只删该 key 的 hot 状态
//   memory-clear          session   ：只清该 key 的 hot 状态
// 唯一的 global-by-design 是控制台自己的健康页（走别的入口），不在本文件里。
export async function handleSocialV2MemoryApi({
  req, url, sendJson, readBody,
  getSocialV2State, saveSocialV2State,
  appendMemoryV2, formatMemoryV2, archiveMemoryEventV3,
  agentTokenOk, v2SessionAllowed, v2ToolEnabled,
  memoryStore, redactKnownTokensOnly,
  mergePersonFact, mergeThread, mergeSelfNote, verifyMemoryClaim,
  buildWriteScope, eventsVisibleToSession,
  auditProfile, groupSelfNotes, memoryQueryV3, formatMemoryInjectionV3,
  filterProfileBySource,
}) {
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return true; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return true; }
          const st = getSocialV2State(key);
          appendMemoryV2(st, category, content, extra);
          // 热记忆会 24h 过期，但先把这条事实钉进永久事件流，过期后仍可检索回来。
          archiveMemoryEventV3({
            t: Date.now(),
            k: key,
            kind: category === 'activeTopic' ? 'topic' : category === 'pendingThought' ? 'thought' : 'impression',
            who: category === 'memberImpression' ? String(extra.target || '') : '',
            text: content
          });
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
          return true;
        }

        // ---- 长期记忆 V3：检索 / 写档案 / 概况 ----
        // 检索是纯本地 BM25，零 token；只有 AI 主动调用时才产生这两个工具调用的成本。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory-search') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim();
          const days = Number(url.searchParams.get('days')) || undefined;
          const topK = Number(url.searchParams.get('topK')) || undefined;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (!q) { sendJson({ ok: false, error: 'q 不能为空' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_search' }, 403); return true; }
          const memCfg = memoryStore.getConfig();
          // crossSessionPolicy=isolated 时只检索当前会话；默认 open 保持跨会话记忆。
          const isolate = memCfg.crossSessionPolicy === 'isolated';
          const hits = memoryStore.search(q, {
            topK: topK || memCfg.searchTopK,
            days: days || memCfg.searchDays,
            ...(isolate ? { key } : {}),
          });
          const formatted = memoryStore.formatHits(hits, { maxChars: memCfg.searchMaxChars });
          // 底层有记忆文件读不出来、或有坏行解析不了时，结果可能不完整：必须明说，
          // 否则模型会把「数据坏了」理解成「我想不起来了」。
          const readErrors = typeof memoryStore.readErrorCount === 'function' ? memoryStore.readErrorCount() : 0;
          const parseErrors = typeof memoryStore.parseErrorCount === 'function' ? memoryStore.parseErrorCount() : 0;
          sendJson({
            ok: true,
            key,
            query: q,
            count: hits.length,
            formatted,
            ...(readErrors + parseErrors > 0
              ? {
                partial: true,
                readErrors,
                parseErrors,
                warning: [
                  readErrors > 0 ? `${readErrors} 个记忆文件暂时读不出来` : '',
                  parseErrors > 0 ? `${parseErrors} 条记忆记录解析失败（坏行仍在原文件里）` : '',
                ].filter(Boolean).join('；') + '，这次检索结果可能不完整',
              }
              : {}),
            hits: hits.map((h) => ({ kind: h.kind, day: h.day, ts: h.ts, score: Number(h.score?.toFixed?.(4)) || 0, text: h.text })),
          });
          return true;
        }


        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory-stats') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_stats' }, 403); return true; }
          // isolated 下不能返回全局管理面统计：事件总量、活跃天数、待恢复计数、
          // 本机绝对路径、整份配置都属于「跨会话活动 + 管理面」，会话只需要自己的量。
          if (memoryStore.getConfig().crossSessionPolicy === 'isolated') {
            sendJson({
              ok: true,
              key,
              scope: 'session',
              clock: 'epoch-ms',
              stats: memoryStore.sessionStats(key),
              omitted: ['globalStats', 'config', 'paths', 'pendingFailures', 'usage', 'profile'],
            });
            return true;
          }
          sendJson({ ok: true, key, scope: 'global', stats: memoryStore.stats({}) });
          return true;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remember') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const kind = String(body.kind ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (!['person', 'thread', 'threadDone', 'correct', 'self'].includes(kind)) { sendJson({ ok: false, error: 'kind 必须是 person / thread / threadDone / correct / self' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remember' }, 403); return true; }
          // 证据闸门：带 evidence 的写入要先核对「这句话真的出现在今天的记录里」。
          // 日终归纳（reason=memoryRefine）要求她带证据；随手记的旧路径不带 evidence 就不校验，
          // 保持原有写入语义——这里只是给「自动改写档案」加一道闸，不改旧行为。
          // 写上下文：来源会话 + 允许匹配/读取的可见范围，一次算清。
          // isolated 下证据校验和 uid 推断也只能看本会话的事件——否则群会话
          // 可以拿私聊当天的原文过证据闸门，还能从私聊里认领同名 uid。
          const writeScope = buildWriteScope(memoryStore.getConfig(), key);
          const scopedEvents = (list) => eventsVisibleToSession(list, writeScope.visibilityKey);
          const evidence = String(body.evidence ?? '').trim();
          let evidenceCheck = null;
          if (evidence) {
            const today = scopedEvents(memoryStore.readEvents({ days: 1 }));
            const sources = today.map((e) => String(e?.text ?? '')).filter(Boolean);
            evidenceCheck = verifyMemoryClaim({ content: String(body.content ?? ''), evidence }, sources);
            if (!evidenceCheck.ok) {
              sendJson({
                ok: false,
                error: '证据不足，这次写入没有落盘',
                evidence: { reason: evidenceCheck.reason, coverage: Number(evidenceCheck.coverage.toFixed(2)) },
                hint: evidenceCheck.reason === 'evidence-not-in-sources'
                  ? '你写的 evidence 在今天的记录里找不到。请从当天消息里原样复制一句，不要改写、不要凭印象编。'
                  : 'evidence 太短，或今天还没有可核对的记录。'
              }, 400);
              return true;
            }
          }
          let profile;
          try {
            // 写路径严格读：IO 失败时必须中止，不能拿空档案去覆盖真实档案。
            profile = memoryStore.readProfile({ strict: true });
          } catch (error) {
            sendJson({
              ok: false,
              error: '档案暂时读不出来（IO 错误），这次没有写入，也没有改动任何记忆',
              detail: String((error && error.message) || error),
            }, 503);
            return true;
          }
          // 留痕：记录这次档案写入来自哪个会话（群友诱导出来的假事实事后可查）。
          const auditEntry = {
            at: Date.now(), kind,
            name: redactKnownTokensOnly(String(body.name ?? '').trim()),
            text: redactKnownTokensOnly(String(body.content ?? '')).slice(0, 60),
            sourceKey: key,
            hasEvidence: Boolean(String(body.evidence ?? '').trim()),
          };
          if (!Array.isArray(profile.audit)) profile.audit = [];
          profile.audit.push(auditEntry);
          profile.audit = profile.audit.slice(-200);
          let okFlag = false;
          let correctResult = null;
          if (kind === 'person') {
            const name = redactKnownTokensOnly(String(body.name ?? '').trim());
            const content = redactKnownTokensOnly(String(body.content ?? '').trim());
            if (!name || !content) { sendJson({ ok: false, error: 'person 需要 name 和 content' }, 400); return true; }
            // uid 解析：优先用显式传入的，否则从最近事件里找同名的人。
            // 有了 uid，「同名不同人」才能分档、「改昵称」才不会裂成两份。
            let uid = String(body.uid ?? '').trim();
            if (!uid) {
              try {
                const recent = scopedEvents(memoryStore.readEvents({ days: 14 }));
                for (let i = recent.length - 1; i >= 0; i -= 1) {
                  const e = recent[i];
                  if (e && e.who === name && String(e.uid ?? '').trim()) { uid = String(e.uid).trim(); break; }
                }
              } catch { /* 读不到就按名字匹配，退回旧行为 */ }
            }
            const out = mergePersonFact(profile, name, content, { uid, ...writeScope });
            profile = out.profile; okFlag = out.changed;
          } else if (kind === 'correct') {
            // 主动纠错：她发现档案里某条记错了，就说出正确的版本，系统替换掉最相似的那条。
            const name = redactKnownTokensOnly(String(body.name ?? '').trim());
            const content = redactKnownTokensOnly(String(body.content ?? '').trim());
            if (!name || !content) { sendJson({ ok: false, error: 'correct 需要 name 和 content' }, 400); return true; }
            // 和 person 一样解析 uid：同名不同人时，纠错不能落到别人身上。
            let correctUid = String(body.uid ?? '').trim();
            if (!correctUid) {
              try {
                const recent = scopedEvents(memoryStore.readEvents({ days: 14 }));
                for (let i = recent.length - 1; i >= 0; i -= 1) {
                  const e = recent[i];
                  if (e && e.who === name && String(e.uid ?? '').trim()) { correctUid = String(e.uid).trim(); break; }
                }
              } catch { /* 读不到就按名字匹配，退回旧行为 */ }
            }
            let out;
            try {
              out = memoryStore.correctFact(name, content, { uid: correctUid, ...writeScope });
            } catch (error) {
              sendJson({
                ok: false,
                error: '档案暂时读不出来（IO 错误），这次纠错没有生效',
                detail: String((error && error.message) || error),
              }, 503);
              return true;
            }
            profile = out.profile;
            // correctFact 只改内存、不落盘，返回的 profile 里已经包含 previous；
            // 这里把本次 audit 补上，最后统一写一次盘 —— 只写一次，失败就不会出现
            // 「磁盘上已改但返回 503 说不生效」的矛盾。
            if (!Array.isArray(profile.audit)) profile.audit = [];
            profile.audit.push(auditEntry);
            profile.audit = profile.audit.slice(-200);
            okFlag = out.changed;
            correctResult = { action: out.action, replaced: out.replaced || null };
          } else if (kind === 'thread' || kind === 'threadDone') {
            const content = redactKnownTokensOnly(String(body.content ?? '').trim());
            if (!content) { sendJson({ ok: false, error: 'thread 需要 content' }, 400); return true; }
            const withWho = Array.isArray(body.withWho) ? body.withWho.map((x) => redactKnownTokensOnly(String(x))) : [];
            const out = mergeThread(profile, content, { withWho, state: kind === 'threadDone' ? 'done' : 'open', ...writeScope });
            profile = out.profile; okFlag = out.changed;
          } else {
            const content = redactKnownTokensOnly(String(body.content ?? '').trim());
            if (!content) { sendJson({ ok: false, error: 'self 需要 content' }, 400); return true; }
            // kind=identity|milestone|like|feeling|world；不传就由规则粗分
            const selfKind = String(body.category ?? '').trim();
            const out = mergeSelfNote(profile, content, { kind: selfKind || undefined, ...writeScope });
            profile = out.profile; okFlag = out.changed;
          }
          // 所有分支（person / correct / thread / threadDone / self）都只改内存，
          // 到这里统一写一次盘（correct 已带上 previous + audit）。
          const saved = memoryStore.writeProfile(profile);
          if (!saved && okFlag) {
            // 有改动但写不进去（读取降级 / 磁盘不可写）：必须明确报错，
            // 不能回 ok:true 让人以为记住了。
            sendJson({
              ok: false,
              error: '档案写入被拒绝（读取处于降级状态或磁盘不可写），本次改动没有落盘',
              readState: memoryStore.readState(),
            }, 503);
            return true;
          }
          archiveMemoryEventV3({ t: Date.now(), k: key, kind: kind === 'threadDone' ? 'thread' : kind === 'correct' ? 'person' : kind, who: String(body.name || ''), text: String(body.content || '') });
          sendJson({
            ok: saved && okFlag,
            key,
            kind,
            ...(correctResult ? { correct: correctResult } : {}),
            ...(evidenceCheck ? { evidence: { matched: true, coverage: Number(evidenceCheck.coverage.toFixed(2)) } } : {}),
            profile: { people: Object.keys(profile.people).length, openThreads: profile.threads.filter((t) => t.state === 'open').length, selfNotes: profile.self.length }
          });
          return true;
        }

        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory-inspect') {
          // 自省：我现在记得些什么、最近检索过什么、如果现在唤醒会注入什么。
          // 对应 dsh-memory-local 的 memory_inspect。
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_inspect' }, 403); return true; }
          const st = getSocialV2State(key);
          const memCfg = memoryStore.getConfig();
          const query = memoryQueryV3(st);
          // isolated 时预览命中也要按会话过滤：命中数量本身就能透露别的会话有没有相关内容。
          const isolatePreview = memCfg.crossSessionPolicy === 'isolated';
          const previewHits = query ? memoryStore.search(query, {
            topK: memCfg.searchTopK,
            days: memCfg.searchDays,
            ...(isolatePreview ? { key } : {}),
          }) : [];
          const previewInjection = formatMemoryInjectionV3(key, st);
          sendJson({
            ok: true,
            key,
            // isolated 时检索历史和人物统计都只看本会话：
            // 检索日志里有查询原文，跨会话看到等于内容泄漏。
            inspect: memoryStore.inspect({
              recallLimit: 8,
              ...(memCfg.crossSessionPolicy === 'isolated' ? { sourceKey: key } : {}),
            }),
            preview: {
              query,
              hits: previewHits.length,
              injectionChars: previewInjection.length,
              injectionBudget: memCfg.injectMaxChars,
              injection: previewInjection
            }
          });
          return true;
        }

        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory-profile') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          // 白名单检查：token 还有效但会话已被移出当前模式时，不能再读档案。
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_profile' }, 403); return true; }
          const memCfg = memoryStore.getConfig();
          const isolate = memCfg.crossSessionPolicy === 'isolated';
          // isolated 时按来源裁剪：不把其他会话写入的人物事实返回给群里。
          const fullProfile = memoryStore.readProfile();
          const scopedProfile = isolate ? filterProfileBySource(fullProfile, key) : fullProfile;
          sendJson({
            ok: true,
            key,
            // isolated 下时间是「会话内序数」（越新越大、未知为 0），不是时间戳：
            // 这里给一句口径说明，免得模型把 lastSeen 当成次数或日期。
            ...(scopedProfile.clock === 'session-rank'
              ? { clockNote: '时间字段是会话内序数（越大越新，0=未知），不是时间戳' }
              : {}),
            profile: scopedProfile,
            // 档案读不到时这里是 false：空档案和「读不到」在接口上必须分得开
            profileRead: memoryStore.readState(),
          });
          return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return true; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return true; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return true; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return true; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return true; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
            const im = st.memberImpressions[oldTarget] || {};
            const newTarget = String(cleanNewExtra.target || oldTarget).trim();
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return true;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return true; }
          const st = getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
          return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return true; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return true; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return true; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return true; }
          const st = getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
          return true;
        }
  return false;
}
