// 表情库（贴纸）接口（从 bridge.js 拆出的第四个「域」）。
//
// 只负责控制台侧的列表 / 同步 / 备注 / 本地点注；发图、收藏等 QQ 侧动作不在这里。
// getStickerEntries / getStickerSyncedAt 是 getter 注入：bridge 里这两个值是 let，
// 同步之后会被整体替换，传值会拿到旧快照。
//
// 约定：返回 true 表示「这个请求我处理了」，调用方直接 return；false 继续往下走。
export async function handleStickersApiRequest({
  req, url, sendJson, readBody, cfg,
  syncStickerLibrary, formatStickerList,
  getStickerEntries, getStickerSyncedAt,
  applyStickerNoteV2, setStickerRemarkV2,
}) {
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await syncStickerLibrary(false);
            const list = formatStickerList(synced?.entries ?? getStickerEntries(), query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? getStickerSyncedAt(), fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? getStickerEntries().length, syncedAt: synced?.syncedAt ?? getStickerSyncedAt() });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return true; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return true; }
          sendJson({ ok: true, sticker: entry });
          return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return true; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
  return false;
}
