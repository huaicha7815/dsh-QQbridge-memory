# QQ ↔ DeepSeek Harness Bridge (qq-bridge)

> Connect QQ messages to DeepSeek Harness (DSH) agents: QQ friends/groups become DSH conversations, and agent replies (including questions and tool approvals) are sent back to QQ.

> ⚠️ **Current release `v0.1.5`, targets DSH 0.1.5-rc.1** (verified item by item on that version). It uses Cookie auth, slash RPC endpoints and the `/api/remote.mux` event stream — a protocol generation introduced in DSH `0.1.2-alpha.1`, incompatible with the older dot-endpoint protocol. On **DSH `0.1.1-rc.2` or earlier**, use tag [`v0.1.0`](https://github.com/huaicha7815/dsh-QQbridge-memory/releases/tag/v0.1.0) instead.
>
> The default branch `main` **is** this version — a plain `git clone` gets it, no branch switching needed.

For the documentation index, see **[docs/README.md](docs/README.md)**.
The documentation index (one line per doc, with "still current?" notes) is **[docs/README.md](docs/README.md)**;
the repository/folder and script-naming conventions are in **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**.

## Long-term Memory

Most QQ bots die on the same problem: **when the context fills up you have to delete it, and once deleted she forgets everything you said.**

This project treats "remembering" as a standalone engineering problem. Three promises:

- **Expired ≠ lost** — the 24-hour hot memory is evicted, but the event stream is never deleted and can still be retrieved when relevant;
- **Compressed ≠ deleted** — small talk only sinks to the bottom and never enters summaries; key promises are stored separately and never expire;
- **Injection does not grow with age** — every wake-up injects at most 1000 characters (≈700 tokens), and it is still 1000 characters three years later.

Four layers + retrieval + profile, all local rules: **no model calls, no embeddings, zero extra token cost**.

| Layer | Content | Property |
| --- | --- | --- |
| L1 event stream | `state/memory/events/YYYY-MM-DD.jsonl` | Permanent append-only; every write is tagged with one of four salience tiers (S0 small talk / S1 daily / S2 worth keeping / S3 critical) |
| L2 daily summary | `days/` | Each finished day compressed into a few lines; S0 excluded, S3 always kept |
| L2.5 weekly / monthly notes | `weeks/` `months/` | Only processes completed periods, deduplicated across periods |
| L3 profile | `profile.json` | Person facts (with confirmation time and correction history), open threads, her own private notes |
| L4 injection | wake-up prompt | Four budget blocks + XML boundary + prompt-injection guard + 1000-char hard cap |

Retrieval uses **BM25 + per-tier time decay + memory heat + same-day/same-person deduplication + same-person association expansion**, all computed locally.

**Profile consistency (V3.6)** — "it runs" is not the same as "she remembers it right". Deciding whether two threads are the same thing looks beyond literal similarity at **quoted proper nouns** (names inside 《》 or quotes) and **content-word anchors**:

- The same promise rephrased is recognised as one thread: "答应教我唱《雨爱》，一直欠着没唱" ≈ "答应要教我唱《雨爱》，我还没唱";
- A different proper noun is a different thing: 《雨爱》 vs 《小幸运》 score 0.86 on literal similarity, but the slot conflict vetoes the merge;
- Closing a thread (`threadDone`) also closes every open thread about the same topic and records which sentence closed it — so she can no longer believe she still owes something she already delivered;
- A person written with a parenthetical note (`爸爸（凉州词）`) is merged back into one profile instead of splitting into two.

She also has four memory tools: `qq_memory_search` (recall), `qq_memory_remember` (write; supports `correct` for fixing a wrong fact),
`qq_memory_profile` (read the whole profile), `qq_memory_inspect` (self-inspection: what do I remember, and what will be injected next).
The console's **"Her Memory"** page shows scale, salience tiers, profile, recent recalls and the consistency audit on one screen.

```bash
npm run memory-health   # size / salience tiers / retrieval quality / profile audit / actionable advice
npm run memory-repair   # preview the profile self-repair; add --apply to write back (backup first)
```

- Design document: [`docs/design/MEMORY_V3_PLAN.md`](docs/design/MEMORY_V3_PLAN.md)
- Project page: [`docs/index.html`](docs/index.html)

## Architecture

```
QQ messages ──► SnowLuma (OneBot v11 WS) ──► qq-bridge ──► DSH Web API (127.0.0.1:3080/api)
                                                    ▲                      │
                                                    └── agent replies / questions / approvals ┘
```

- **QQ side**: `@snowluma/sdk` provides the OneBot v11 WebSocket client.
- **DSH side**: adapted for DSH 0.1.2+ and re-verified on 0.1.5 — launch-token Cookie auth, `/api/<namespace>/<method>` slash RPC, and `/api/remote.mux` + `session/follow` event stream. The per-session model is pinned by the bridge via `session.selectModel` from `config.json`'s `dsh.model` (default `deepseek-flash` = DeepSeek-V41-Flash, multimodal).
- **Agent tools**: safe MCP servers expose a restricted QQ toolset (`qq_status`, `qq_list_groups`, `qq_get_group_history`, `qq_send_group_message`, `qq_reply`, etc.) plus an admin-only host server (`snowluma_status`, and `start_snowluma`/`stop_snowluma` when `snowluma.allowProcessControl` is enabled).
- **Console**: a local web console at `http://127.0.0.1:3100`, organised into eleven task-based pages (Overview, Sessions & Approvals, Persona, Social v2, Social v1, Slang, Her Memory, Usage & Cost, Access & Security, Operations, Tool Reference) with cross-page feature search and a **light / dark theme** (one-click toggle in the header; follows the OS preference until you choose), for mode switching, role management, whitelist/admin settings, slang management, memory, stickers and more. The Persona page manages roles (view/edit/rename/duplicate/delete the prompt of each persona), shows and edits both prompt layers separately — the **simulation prompt** built into the preset (tool/behaviour protocol; synced to DSH, restart required) and the **persona prompt** (`roles/*.md`; applied immediately) — and sets the **DSH reasoning effort** (`max` by default, `high`/`low` selectable). The **Usage & Cost** page shows real-time token consumption and its price in CNY, broken down per group/friend and per conversation turn (see [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)).

## Features

- Bridges QQ group/private messages to DSH agent sessions.
- Social simulation mode ("simulated group friend") with idle/active/probing/exiting states.
- Space-based message splitting for more natural multi-message replies.
- Whitelist/blacklist access control, fail-closed by default.
- Sensitive text audit prevents paths/credentials from being sent to QQ.
- MCP tools for reading group history/members, sending messages, replying with quotes, and (in `reserved2`) full simulated-group-friend tooling.
- Slang/network-expression learning with human confirmation.
- Lightweight memory system for active topics, pending thoughts and member impressions.
- Sticker library integration with AI-friendly sticker usage.

## Requirements

- Node.js >= 22.13
- Running DeepSeek Harness Web (default `http://127.0.0.1:3080`)
- Running SnowLuma with OneBot v11 WebSocket and HTTP API enabled

## Quick Start

```bash
npm install        # postinstall automatically patches the @snowluma/sdk ESM packaging bug
```

Copy `config.example.json` to `config.json`, then edit:

```bash
cp config.example.json config.json
```

Key settings:

| Field | Description |
| --- | --- |
| `dsh.baseUrl` | DSH Web API URL, default `http://127.0.0.1:3080` |
| `dsh.authToken` | DSH launch token used to exchange for a browser-session cookie in DSH 0.1.2. Leave empty to auto-discover from `~/.dsh/guard/logs/server-*.out.log`; the bridge also re-discovers it automatically after a DSH restart / 401 |
| `dsh.authHeader` / `dsh.authPrefix` | Legacy fields kept for compatibility; the current DSH 0.1.2 path uses Cookie exchange and does not send this header |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** URL (e.g. `ws://127.0.0.1:3001`) |
| `snowluma.accessToken` | OneBot access token, leave empty if not configured |
| `snowluma.httpUrl` | OneBot **HTTP API** URL (e.g. `http://127.0.0.1:3000`); do not point this at the WebSocket port or you will get HTTP 426 |
| `ownerQQ` | Administrator QQ (highest privilege) |
| `allow.private` / `allow.groups` | Whitelist of QQ/group IDs |
| `consolePort` | Local console port, default `3100` |

Start:

```bash
npm start
```

Or double-click `start.bat` on Windows (guard mode with auto-restart).

## DSH Setup on Another Device

The bridge and console can run without extra DSH setup, but the two DSH chat presets (`qq-chat` and `qq-chat-v2`) and the MCP servers must be installed into DSH once per machine:

```bash
node scripts/setup-dsh.mjs
```

This installs:

- `~/.dsh/.agent-presets/qq-chat` and `~/.dsh/.agent-presets/qq-chat-v2`
- MCP entries in `~/.dsh/profiles/web/cordis.patch.yml`
- `qq-mode-console` in the profile `package.json`
- Default DSH mode set to `reserved2` (second-generation simulation), with a local `state/mode.json` fallback

Then restart DSH. See [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) for details.

## Security Notes

- `config.json` and `state/` are **never committed**; the repository only ships `config.example.json`.
- MCP send tools enforce whitelist checks and reject CQ-code injection.
- Local paths, credentials, tokens and other sensitive patterns are filtered by the audit layer.
- Process control for SnowLuma (`start_snowluma` / `stop_snowluma`) is disabled by default and only allowed in `closed-agent` mode when explicitly enabled.
- The console uses a generated token when none is configured.

## Repository Layout

```
qq-bridge/
  config.example.json   # sanitized config template (real config.json is not in repo)
  docs/
    README.md           # documentation index (one line per doc + "still current?" notes)
    FOLDER_MAP.md       # folder layout and scripts/ naming conventions
    guides/             # user/operator facing: PROJECT_GUIDE, DSH_SETUP, VOICE, TOKEN_USAGE_CONSOLE, CONSOLE-UI-TESTING
    design/             # design & planning docs
    research/           # investigation notes
    audits/             # review / optimisation reports
    legacy/             # archived docs that were superseded
  dsh/agent-presets/    # qq-chat / qq-chat-v2 DSH agent preset templates
  plugins/qq-mode-console  # DSH plugin: registers the qq-mode settings namespace (host half only; no UI card yet)
  src/                  # bridge core and MCP servers
  public/
    console.html        # local web console
  roles/                # persona cards
  assets/               # images (the intro video ships as a release asset, not in the repo)
  scripts/              # tests and helper scripts
  state/                # runtime data (not in repo)
```

The standalone **voice sender tool** (`voice-cli.mjs`, `voice-gui.mjs`, `public/voice.html`, `发语音.cmd`)
lives in the sibling folder **`../voice-tool/`** — it only needs SnowLuma, and reuses this repo's
`src/voice-core.js` / `src/snowluma-conn.js` as the single shared implementation.

## Testing

`npm run test:audit` runs isolated regression tests without production credentials, DSH, or QQ messages. Historical audit reports are not included in this repository.

Long-term memory has its own two offline suites (temporary directories, never touches the real memory store):

```bash
node scripts/test-memory-lib.mjs   # 54 checks: injection budget, consolidation chain, retrieval, profile consistency & self-repair
node scripts/test-memory-e2e.mjs   # 4 checks: end-to-end injection and tool contracts
npm run memory-health              # read-only: real store scale, retrieval quality, profile audit
```

After upgrading, legacy QQ session mappings without permission metadata are recreated once. Mode or preset changes also retire the old mapping and recreate the session on the next message; DSH history is retained.

```bash
npm run self-test       # DSH-side link test, no QQ/SnowLuma required
npm run test-md
npm run test-wait
npm run test-vision
npm run test-forward
npm run test-slang
npm run test-stickers
```

## Compliance

SnowLuma is an independent third-party project and is not affiliated with Tencent/QQ. This project is for learning and technical research only; please follow the relevant terms and the QQ User Agreement.
