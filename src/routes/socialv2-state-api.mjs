// socialV2 只读接口（state / prompt / unread / recent / states / mood / moods / relationship）。
//
// 只搬只读的：config / activity / reset / mark-read / wake-config 这些会改状态的端点
// 仍留在 bridge.js —— 它们直接操作唤醒配置和读水位，属于状态机核心，不在这批里动。
//
// 顺手修了一个既有 bug：prompt 端点原本调用不存在的 currentRoleHintV2()，
// 导致该接口一直 500。真实实现是 roleHintForMode(v2|v1, roleName)。
//
// 情绪与关系状态（mood / relationship）的只读查询也挂在这里：
// 状态本身在 src/core/mood.mjs + socialv2-store 里，这里只做视图与鉴权，
// 不写状态、不触发任何行为（控制台刷新页面不该改变她的情绪）。
//
// 约定：返回 true 表示「这个请求我处理了」，调用方直接 return；false 继续往下走。
import { createMoodLayer } from '../core/mood.mjs';

/** 控制台只读视图：每次请求建一个轻量层（无状态，只做归一化/衰减计算）。 */
function moodLayerFor(getSocialV2State, socialV2) {
  return createMoodLayer({
    getState: getSocialV2State,
    peekState: (key) => {
      const map = socialV2?.conversations;
      if (!map || typeof map.get !== 'function') return null;
      return map.get(key) ?? null;
    },
    conversations: () => socialV2?.conversations,
    now: () => Date.now(),
  });
}

/** 列表用的情绪摘要（不带 events，避免响应过大）。 */
function moodSummary(view) {
  if (!view) return null;
  return {
    valence: view.valence,
    arousal: view.arousal,
    energy: view.energy,
    cause: view.cause,
    causeType: view.causeType,
    since: view.since,
    ageMs: view.ageMs,
    decayHalfLifeMs: view.decayHalfLifeMs,
  };
}

/** 列表用的关系摘要。 */
function relationshipSummary(view) {
  if (!view) return null;
  return {
    intimacy: view.intimacy,
    tension: view.tension,
    lastInteraction: view.lastInteraction,
    openLoopCount: Array.isArray(view.openLoops) ? view.openLoops.length : 0,
  };
}

export async function handleSocialV2StateApi({
  acknowledgeMessagesV2, agentTokenOk, confirmedSlangListV2, cfg, computeWakeSafetyV2, buildSlangContext, buildStickerContext, buildStickerStrategyHint, ensureWakeableV2, formatMemoryV2, formatParticipationV2, getSocialV2State, isSleepingConfigV2, log, noteModelMessagesV2, preSleepWaitBlockedV2, readBody, readRoleState, readThroughSeqV2, replyTimingV2, requestedReadThroughSeqV2, roleHintForMode, roleNameFor, saveSocialV2State, sendJson, stickerEnabled, syncStickerLibrary, v2SessionAllowed, v2ToolEnabled, voiceCfg, voiceLibrary, socialV2,
  req, url,
  currentMode: getCurrentMode,
  slangEntries: getSlangEntries,
  stickerEntries: getStickerEntries,
  // 控制台「她的情绪」页：最近每句话的情绪快照（bridge 注入，只读）。
  readMoodHistory = null,
  isMoodHistoryDegraded = null,
  canonicalV2Key = null,
  getEmotionV2Status = null,
  getEmotionV2AbVariant = null,
  getEmotionV2Detail = null,
  getMoodView = null,
  getRelationshipView = null,
}) {
        // 情绪/关系只读视图（不写状态、不触发行为）。
        const moodLayer = moodLayerFor(getSocialV2State, socialV2);
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return true; }
          const st = getSocialV2State(key);
          const moodView = typeof getMoodView === 'function' ? getMoodView(key) : moodLayer.getMood(key);
          // 私聊的 key 本身就对应一个 QQ，可以直接给出「与这个人」的关系摘要；群聊没有唯一对象。
          const relationshipUid = /^private:(\d+)$/.exec(key)?.[1] ?? null;
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt,
            // 落盘健康状态（审查 r5 P2）：null=最近一次保存成功；否则 {at,message} 说明内存态可能未落盘。
            // 只暴露错误码/时间，不回传原始 message：atomicWriteJson 的失败消息可能含绝对路径。
            lastSaveError: socialV2?.lastSaveError
              ? {
                at: Number(socialV2.lastSaveError.at) || 0,
                // 只外发白名单错误码：原始 message / 路径一律不出去（本地日志里已有）。
                code: (() => {
                  const raw = String(socialV2.lastSaveError.code ?? 'IO');
                  return /^[A-Z0-9_]{1,40}$/.test(raw) ? raw : 'IO';
                })(),
              }
              : null,
            mood: moodSummary(moodView),
            relationship: relationshipUid ? relationshipSummary(typeof getRelationshipView === 'function' ? getRelationshipView(relationshipUid) : moodLayer.getRelationship(relationshipUid)) : null,
            // 会话 C：可解释性 —— 最近一次唤醒/发送用了哪份表达计划（为什么这样回应）。
            // 运行时数据（不落盘）：含 moodBand、长度上限、表情/语音允许概率、主动倍率与逐条 reasons。
            expression: socialV2?.lastExpression?.get?.(key) ?? null,
            // 最近一次主动机会检查的完整依据（为什么这次主动/没主动）。
            lastProactive: socialV2?.lastProactiveByKey?.get?.(key) ?? null,
            // 情绪 V2 预算/落盘健康（1C 控制台展示；null=未启用）
            emotionV2: (() => {
              try {
                const status = typeof getEmotionV2Status === 'function' ? getEmotionV2Status() : null;
                if (!status) return null;
                return {
                  ...status,
                  // A/B 标签对 agent 盲化（仅控制台可见）
                  abVariant: (!req.headers['x-agent-token'] && typeof getEmotionV2AbVariant === 'function') ? getEmotionV2AbVariant(key) : null,
                };
              } catch { return null; }
            })()
          });
          return true;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return true; }
          const st = getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            sendVoice: 'qq_send_voice / qq_list_voices',
            speak: 'qq_speak（用自己声音说话）',
            sing: 'qq_sing（唱歌）',
            qzone: 'qq_send_qzone / qq_qzone_list'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            role: { name: roleNameFor(key) ?? null, hint: getCurrentMode() === 'reserved2' ? roleHintForMode('v2', roleNameFor(key)) : roleHintForMode('v1', roleNameFor(key)) },
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            replyTiming: replyTimingV2(st),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            memory: formatMemoryV2(st),
            participation: formatParticipationV2(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: confirmedSlangListV2(),
              block: buildSlangContext(getSlangEntries(), cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: getStickerEntries().length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(getStickerEntries(), cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            },
            // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
            voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
              enabled: true,
              total: voiceLibrary().length,
              names: voiceLibrary().slice(0, 12).map((v) => v.name),
              maxSeconds: voiceCfg().maxSeconds,
              hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
            }
          });
          return true;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return true; }
          const afterRaw = url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return true;
          }
          const st = getSocialV2State(key);
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const messages = afterSeq === null ? st.unread.slice(-limit)
            : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq });
          return true;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return true; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          const messages = st.recentMessages.slice(start, end);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, messages, readThroughSeq });
          return true;
        }

        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0,
              mood: moodSummary(moodLayer.getMood(key))
            });
          }
          sendJson({ ok: true, conversations: list });
          return true;
        }

        // 只读：某会话的当前情绪状态 + 最近来源事件（控制台「情绪」查询）。
        // 未知会话返回默认中性状态（known:false），不会顺手创建会话。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/mood') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return true; }
          const view = (typeof getMoodView === 'function' ? getMoodView(key) : moodLayer.getMood(key));
          if (!view.valid) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
          sendJson({
            ok: true,
            key: view.key,
            known: view.known,
            mood: {
              valence: view.valence,
              arousal: view.arousal,
              energy: view.energy,
              raw: view.raw,
              // V2 adapter 无 cause/causeType：用 reasons 映射（§4.9），旧 UI 兼容
              cause: view.cause ?? (Array.isArray(view.reasons) && view.reasons[0] ? (view.reasons[0].note || '') : ''),
              causeType: view.causeType ?? (Array.isArray(view.reasons) && view.reasons[0] ? view.reasons[0].kind : ''),
              since: view.since,
              decayHalfLifeMs: view.decayHalfLifeMs,
              ageMs: view.ageMs
            },
            reasons: Array.isArray(view.reasons) ? view.reasons : [],
            events: view.events ?? (Array.isArray(view.reasons)
              ? view.reasons.map((reason) => ({ type: reason.kind, at: null, cause: reason.note || '', sourceEventId: reason.sourceEventId ?? null, intensity: reason.intensity }))
              : [])
          });
          return true;
        }

        // 只读：某会话最近「发出去的每句话」的情绪快照（控制台「她的情绪」页）。
        // 这类发送轨迹只给控制台看：带 agent token 的请求一律拒绝（会话级主体不能读发送历史）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/mood-history') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
          const rawKey = String(url.searchParams.get('key') ?? '').trim();
          if (!rawKey) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          // 与会话其它端点同一套 canonical key 校验：拒绝 0 / 前导零 / 超出安全整数。
          const key = typeof canonicalV2Key === 'function' ? canonicalV2Key(rawKey) : null;
          if (!key) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号（QQ号必须为正整数）' }, 400); return true; }
          // limit：只接受有限数字，取整后 clamp 到 1..1000；缺省/空串用 60。
          const rawLimit = url.searchParams.get('limit');
          const parsedLimit = rawLimit == null || rawLimit.trim() === '' ? NaN : Number(rawLimit);
          const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(1000, Math.trunc(parsedLimit))) : 60;
          const history = typeof readMoodHistory === 'function' ? readMoodHistory(key, limit) : [];
          const degraded = typeof isMoodHistoryDegraded === 'function' ? Boolean(isMoodHistoryDegraded()) : false;
          sendJson({ ok: true, key, count: history.length, degraded, history });
          return true;
        }

        // 只读：所有会话的情绪概览（控制台列表用，不含逐条来源事件）。
        // 这是跨会话的全局视图：带 agent token 的请求一律拒绝（会话级主体只能查自己的 /mood）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/moods') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
          const list = [];
          const conversations = socialV2?.conversations;
          if (conversations && typeof conversations[Symbol.iterator] === 'function') {
            for (const [key] of conversations) {
              const view = (typeof getMoodView === 'function' ? getMoodView(key) : moodLayer.getMood(key));
              list.push({
                key,
                known: view.known,
                ...moodSummary(view)
              });
            }
          }
          sendJson({ ok: true, count: list.length, conversations: list });
          return true;
        }

        // 1E 控制台「情绪栈」：V2 agentMood 的 episodes/混合心情/负性循环健康（只读；agent 拒绝）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/emotion/detail') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          const detail = typeof getEmotionV2Detail === 'function' ? getEmotionV2Detail(key) : null;
          if (!detail) { sendJson({ ok: false, error: '情绪 V2 未启用' }, 404); return true; }
          sendJson({ ok: true, key, ...detail });
          return true;
        }

        // 只读：某个 QQ 的关系状态 + 最近来源事件 + 未了结的事（控制台「关系」查询）。
        // 跨会话聚合的全局视图：带 agent token 的请求一律拒绝，防止任意会话 token 读取他人关系。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/relationship') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
          const uid = String(url.searchParams.get('uid') ?? '').trim();
          if (!uid) { sendJson({ ok: false, error: 'uid 不能为空' }, 400); return true; }
          const view = (typeof getRelationshipView === 'function' ? getRelationshipView(uid) : moodLayer.getRelationship(uid));
          if (!view.valid) { sendJson({ ok: false, error: 'uid 必须是正整数 QQ 号' }, 400); return true; }
          sendJson({
            ok: true,
            uid: view.uid,
            known: view.known,
            relationship: {
              intimacy: view.intimacy,
              tension: view.tension,
              lastInteraction: view.lastInteraction,
              openLoops: view.openLoops,
              sources: view.sources
            },
            events: view.events
          });
          return true;
        }
  return false;
}
