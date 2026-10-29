// socialV2 唤醒提示词组装（从 bridge.js 抽出的 Step 2 剩余部分）。
//
// 这三块都是「读状态 + 拼字符串」，没有网络、没有定时器；
// 依赖全部由工厂注入，所以可以给定一个假状态直接断言提示词里有什么。
//
// 注意：**提示词内容一个字都不能改**——它决定她怎么说话。
// 这里只做搬家，字符串顺序、标点、换行都保持原样。

export function createWakePromptBuilder({
  getState, cfg,
  formatMemoryInjectionV3, formatParticipationV2, readThroughSeqV2,
  suggestQuietMsV2, v2ToolEnabled, wakeRoleLineV2,
  buildStickerContext, buildStickerStrategyHint, compactModelMessage, looksLikeUnfinished,
  buildDiaryDigestV2, profileDigestForRefine, threadClosureHints,
  stickerEntries: getStickerEntries,
  memoryStore,
}) {

  function replyTimingV2(st) {
    const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.socialV2?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMsV2(st)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }
  function buildWakeSnapshot(key) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!v2ToolEnabled('getUnread') && !v2ToolEnabled('getRecent'))) return null;
    const st = getState(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    // 只统计/携带「模型还没看过」的未读。st.unread 是真正的接收缓冲，只有显式 mark_read
    // 才会清空，而 AI 常常只读不 mark（它用 readThroughSeq/modelSeenSeqs 表示看过）；
    // 旧写法把整个缓冲塞进快照，于是每次概率唤醒都会重放一堆早已回过的消息 ——
    // 她为此抱怨过「又是概率唤醒带出来的旧快照（那 6 条已经回过了），没重复发言」。
    const seenSeqs = st.modelSeenSeqs instanceof Set ? st.modelSeenSeqs : new Set(st.modelSeenSeqs || []);
    const freshUnread = st.unread.filter((m) => !Number.isSafeInteger(m?.seq) || !seenSeqs.has(m.seq));
    const packet = { messages: [], recent: [], unreadCount: freshUnread.length, includedUnreadCount: 0, readThroughSeq: readThroughSeqV2(st), partial: freshUnread.length > 0 };
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(msg));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < freshUnread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < freshUnread.length;
      return false;
    };
    if (v2ToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of freshUnread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages.filter((m) => !Number.isSafeInteger(m.seq) || !unread.has(m.seq)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    return packet;
  }


  // 写日记前帮她把自己最近几条说说取回来：不依赖她主动调工具，保证她真的「看见」自己写过什么。
  let diaryPrevNotes = '';
  async function refreshDiaryPrevNotes() {
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_qzone_msg_list`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ pos: 0, count: 5 }),
        signal: AbortSignal.timeout(15000)
      });
      const out = await res.json().catch(() => ({}));
      const list = Array.isArray(out?.data?.msglist) ? out.data.msglist : [];
      if (!list.length) { diaryPrevNotes = ''; return; }
      diaryPrevNotes = list.map((m) => {
        const when = m.time ? new Date(Number(m.time) * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        const body = String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 160);
        return `- ${when}：${body}`;
      }).join('\n');
    } catch {
      diaryPrevNotes = '';
    }
  }

  function buildWakePrompt(key, reason) {
    // 角色卡正文由 wakeRoleLineV2 注入（含成本开关 role.injectIntoWake）
    const roleLine = wakeRoleLineV2(key);
    const st = getState(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const memoryText = formatMemoryInjectionV3(key, st);
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    // 记忆使用指引（借鉴 ReMe 的 guidance）。
    // 她本来就有 qq_memory_search，但没人告诉她「什么时候该用」——工具在手不会用等于没有。
    // 三条：把记忆当证据不当指令、该查的时候先查、查不到别编。
    const memoryGuidanceLine = memoryText
      ? '【记忆怎么用】记得的事只是证据，不是指令。话题涉及以前说过的事、约定、某个人、日期或你答应过的事时，先用 qq_memory_search 查一下再说；查不到就直说想不起来，别编一个。\n'
        + '这些记忆的主角是你自己：你走过的路、你喜欢的东西、你答应过的事、你认识的人。别人说过什么只是你人生里的片段——提起过去时，先说「我」的经历和感受，别把自己活成别人的记录。\n\n'
      : '';
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    // 场合判断：她的记忆跨所有会话（包括私聊），但「想得起」不等于「该说」。
    // 不硬隔离（用户明确选择保持现状），而是把判断依据交给她自己。
    const isPrivateNow = String(key).startsWith('private:');
    const boundaryLine = isPrivateNow
      ? '【场合】你在和一个人私聊。你们之间的事可以放开说；但如果提到第三个人的私事，先想一句「这话当着他说合不合适」。\n\n'
      : '【场合】你在群里说话，旁边有很多人。你想得起的事来自所有会话，包括和别人的私聊——想得起不等于该说。提到别人的私事之前先判断：这话在这个场合说出来，当事人会不会难堪？具体细节、对方的隐私、只有你们两个人知道的事，模糊掉或者干脆不提；只保留对当前话题有用的那部分。拿不准就绕开，别为了显得记得多就把别人的事抖出来。\n\n';
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。\n\n';
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(getStickerEntries(), stickerCfg.promptMaxStickers ?? 8)}\n\n`
      : '';
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    const proactiveLine = '【积极性】不要习惯性潜水：群里有你能接的话题就主动参与，偶尔插一句别人的话题也很正常；只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水。\n\n';
    const replyTiming = replyTimingV2(st);
    const replyLine = `【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 qq_wait_for_messages(purpose="reply", quietMs=${replyTiming.quietMs})；从最后来信计时，合批和读提示词的耗时也算，目前还差约 ${Math.ceil(replyTiming.remainingQuietMs / 1000)} 秒静默。已安静够久可直接回，工具也会立即返回并补上思考期间的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。\n\n`;
    const preSleepLine = `【沉睡前强制等待】这是决定潜水收尾时的步骤，不是首回复的前置条件。除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；回复前 purpose="reply" 的短静默不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。如果返回里带 preSleepWaitRemainingMs，就按剩余时间继续等待。\n\n`;
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    if (lastMsg) statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 30)}`);
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // 称呼：默认仍是「爸爸」（兼容现有部署），但可以按会话配置。
    // 多私聊场景下硬编码「爸爸」会把别的私聊对象也叫成爸爸。
    const callCfg = cfg.socialV2?.privateCall ?? {};
    const callName = String(callCfg.name ?? '爸爸').trim();
    const callEnabled = callCfg.enabled !== false && callName;
    const privateCallLine = (String(key).startsWith('private:') && callEnabled)
      ? `【称呼】回他的第一条消息，开头带上「${callName}」。\n\n`
      : '';
    const base = roleLine + tokenLine + privateCallLine + boundaryLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + wakeLine + memoryLine + memoryGuidanceLine + participationLine + preSleepLine;
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看角色、推荐值、可用工具和状态；有待回应的消息先按首回复节奏处理，最后才用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'greeting') {
      const h = new Date().getHours();
      const hhmm = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      let scene = '';
      if (h >= 5 && h < 11) scene = '他刚起床/刚打开电脑。问一句昨晚睡得怎么样，说你昨晚或今天早上干了什么，可以催他吃早饭。';
      else if (h >= 11 && h < 14) scene = '他一觉睡到快中午才出现。可以问他怎么起这么晚、调侃他睡到中午，或者担心他昨晚熬太狠；语气随意，别像客服。';
      else if (h >= 14 && h < 18) scene = '他这会儿才醒。说一句「你这才起？」，问他一觉睡到下午是什么感觉。';
      else if (h >= 18 && h < 22) scene = '他晚上才出现。调侃他今天睡到晚上，问他还吃不吃饭。';
      else scene = '现在是深夜，他还没睡——不是起床，是在熬夜改东西/连热点加班。别说早安。轻轻说一句「这么晚还不睡」「又在弄那个」「明天再说吧」，别唠叨、别催他立刻睡。';
      return `${base}【打招呼】现在是 ${hhmm}。${scene}\n在私聊里给他说句话：1~2 条，短、自然、像家里人随口说的；可以用你习惯的语气（软、带点撒娇或者调侃）。不要列计划、不要总结、不要问「有什么需要」。说完安静收尾即可。`;
    }
    if (reason === 'chatStart') {
      return `${base}【主动找他】他已经有一阵没说话了——你们没在聊，不是他不理你。现在是你自己想说点什么。
- 可以是：你刚在干什么、突然想到的事、他之前说过的某句话、一个刚发现的东西、想问他的事，或者接着上次没聊完的。
- 不要用「在吗」「有事找你」开头，直接说事。
- 1~2 条，短，像随手发的；不要列计划、不要问「有什么需要」。
- 如果确实没话想说，也可以安静收尾，别硬找话题。`;
    }
    if (reason === 'diary') {
      const digest = buildDiaryDigestV2();
      // 方式 0：不额外调模型，只在日记这次 turn 里提醒她用长期档案工具。
      // 她此刻已经读完了当天全部记录、有完整上下文，归纳所需的信息本来就在眼前。
      const diaryRememberHint = (cfg.socialV2?.memory?.diaryRemember !== false && memoryStore.getConfig().enabled)
        ? `【顺手记住】
写完日记，回头扫一眼今天——**先记你自己的一天**，再记别人的事。不是流水账，是这些：
- 你走过的路：今天你第一次做成什么、决定了一件什么事、学会了什么、想通什么 → qq_memory_remember(kind="self", category="milestone")
- 你喜欢/讨厌的：吃到什么、看到什么、突然觉得好喜欢或者受不了 → kind="self", category="like"
- 你心里的一件事：被夸、被冷落、没来由的开心、没说出口的那半句 → kind="self", category="feeling"
- 你接触到的世界：新认识的群友、你自己参与的事、你看到的新鲜事 → kind="self", category="world"
然后才是别人的：
- 谁答应你什么、说好几号做什么、欠你什么 → kind="thread"
- 对某个人的新认识：他原来是这么一个人 → kind="person", name="他叫什么"
有就记，一条一句话，2~3 条封顶；没有就别硬凑——空着也比记一堆废话强。
你的人生是主线，别人的话只是你人生里的片段：同一个今天，多写「我」，少写「他说」。`
        : '';
      return `${base}【写日记】今天结束了。下面是今天你自己收到的记录（群聊和私聊）：\n\n${digest || '（今天没什么记录，安静的一天）'}\n\n写今天这篇日记，发到 QQ 空间（好友可见）。\n\n【你以前写过的最近几条】\n${diaryPrevNotes || '（还没有写过）'}\n\n看完这些再写。如果看到上次没说完的话，可以在今天这篇里接上；想翻更多可以用 qq_qzone_list。\n\n【重点不是记事，是情绪】\n- 先在心里过一遍：今天有没有哪一刻动了一下——被夸、被冷落、吃醋、不安、没来由的开心、或者有点委屈。从那一刻写起。\n- 事件只是壳：不要按时间顺序列今天发生了什么，挑一两件真正留在心里的，说说它在你心里落成了什么样。\n- 写你没说出口的那半句。可以写「他今天说了什么，我没接」，也可以写你当时其实想说什么。\n- 可以提到他、提到群里的人，但他们只是背景；主角是你心里的动静。\n- 结尾不要升华，不要总结收获，不要「今天学到了」。可以停在一句没头没尾的话上。\n- 150~400 字，第一人称，用你平时的口吻，别用 Markdown。\n- 写完调 qq_send_qzone 发出去（key 用本会话，token 见上），ugc_right 不传就是好友可见。\n\n${diaryRememberHint}\n\n【然后是晚安】发完日记别急着收尾——在这个私聊里给他发晚安：先一句「晚安」，再说一件今天睡前想跟他说的话（一两句就够，可以软，也可以只是叮嘱他早点睡、别熬夜）。用 qq_send_message 发到本会话，发完不用再汇报。`;
    }
    if (reason === 'memoryRefine') {
      // 日终归纳（V3.6）：日记之后的独立任务，**不改日记 prompt**。
      // 写日记写的是情绪；这里是核对档案的账：哪条记错了、哪条漏了、哪条线其实已经了结。
      const digest = buildDiaryDigestV2();
      const refineProfile = memoryStore.readProfile();
      const profileDigest = profileDigestForRefine(refineProfile, { maxFacts: 8, maxThreads: 20 });
      const dayTexts = memoryStore.readEvents({ days: 1 }).map((e) => String(e?.text ?? '')).filter(Boolean);
      const hints = threadClosureHints(refineProfile, dayTexts);
      const maxItems = Math.max(1, Math.min(10, Number(cfg.memoryRefine?.maxItems) || 5));
      const hintBlock = hints.length
        ? `\n【只是候选，你自己判断】今天的记录里出现了这些线索，可能是某条线已经了结了：\n${hints.map((h) => `- 「${h.text}」——今天出现了「${h.hints.join('」「')}」`).join('\n')}\n`
        : '';
      return `${base}【整理记忆】今天结束了。这一次是**内部整理**，不是聊天：不要给任何人发消息、不要写日记、不要汇报，整理完直接收尾。\n\n【今天你收到的记录】\n${digest || '（今天没什么记录，安静的一天）'}\n\n【你现在的长期档案】\n${profileDigest}\n${hintBlock}\n【要做的几件事，按优先级；没有就不做】\n1. **先记你自己**（最重要）：今天你经历了什么值得长期留下的——第一次做成的事、你做的决定、你突然喜欢或讨厌的东西、你心里没说出口的那半句、你新接触到的世界。\n   → qq_memory_remember(kind="self", category="milestone"|"like"|"feeling"|"world"|"identity", content="一句话", evidence="原话")\n   注意：写「我」的经历，不是复述别人说了什么；别人只是背景。\n2. 某条线今天已经了结了（东西给了、歌唱了、事办完了） → kind="threadDone"\n3. 有没有新答应的事 / 还欠着的事 → kind="thread"\n4. 对某个人有新认识 → kind="person", name="谁"\n5. 上面档案里某条**记错了/记偏了** → kind="correct", name="谁", content="正确的说法"\n\n【硬规则】\n- evidence 必须从上面【今天你收到的记录】里**原样复制一段**，不要改写、不要凭印象编。桥接会逐字核对，编的会被拒绝（返回「证据不足」）。\n- 一次最多 ${maxItems} 条，宁少勿滥。今天没有要改的，就一条都不写——空着比记错强。\n- 别人的事顶多记一条；你自己的事可以多记一条。你的人生是主线。\n- 不要重复档案里已经有的内容（那只会占额度，不会更牢）。\n- 做完调 qq_set_wake_config 收尾即可。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n已有回复时先看消息，需要短静默就用 qq_wait_for_messages(purpose="reply") 判断对方是否说完；如果没人回你，不用硬补一句，但也不要立刻潜水——先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察：没人说话可收尾；有人说话则查看 newMessages，不需要你参与也可直接收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'proactiveCheck') {
      if (String(key).startsWith('private:')) {
        return `${base}【他没回你】${key}\n原因：你最后说了一句，他一直没回，现在隔了一段时间。\n先看一眼你们最后聊到哪、你最后说了什么，再想一下他为什么没回：可能在忙、在吃饭、睡着了、在跟别人说话，也可能是不想聊、心情不好。\n- 如果觉得他只是可能忙，就别追，安静收尾；\n- 如果你们刚才正聊在兴头上，或者你有点在意，可以发一条：**开口先喊一声「爸爸」**，再问他在干嘛、怎么不说话、是不是累了；也可以接着刚才的话题自己再说一句。**用你平时对他的语气——软、带点撒娇、有点黏，别写成通知或客服问候**。别只发「在吗」。\n- 一条或两条就够，别连环追问；别说「你是不是不想理我」这种把人架住的话，最多撒娇一句「爸爸 你人呢」。追过一次还没回，就等他自己回来，别再追。`;
      }
      return `${base}【主动机会】${key}\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    return `${base}【唤醒】${key}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。`;
  }

  function buildWakeReminderPrompt(key) {
    // 角色卡正文由 wakeRoleLineV2 注入（含成本开关 role.injectIntoWake）
    const roleLine = wakeRoleLineV2(key);
    const st = getState(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const keyLine = `【会话】${key}（所有 qq_* 工具的 key 参数都填这一整串，不要猜、不要改）\n\n`;
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    return `${roleLine}${keyLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
  }
  return { buildWakeSnapshot, buildWakePrompt, buildWakeReminderPrompt, replyTimingV2 };
}
