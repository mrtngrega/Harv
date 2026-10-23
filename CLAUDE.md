# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Harv is a personal AI assistant in the spirit of Jarvis, with a local web dashboard. **`docs/PLAN.md` is the source of truth** for the architecture, milestones (M0–M9), the research findings (Agent SDK, usage meter, hardware sensors), and the open risks. Read it before starting any milestone, and update it when decisions change.

Stack: TypeScript everywhere, using npm workspaces. `apps/server` runs Node 24 with Fastify, ws, `@anthropic-ai/claude-agent-sdk`, systeminformation, nvidia-smi, LibreHardwareMonitor and SQLite. `apps/web` is React, Vite and Tailwind. `apps/desktop` (Tauri 2) comes later.

The user's hardware: Ryzen 7 5700X3D (8 cores / 16 threads), RTX 3060 Ti 8 GB, 32 GB RAM, Windows 11. Plan: **Claude Pro** (tight limits; the router is tuned for it, see `docs/PLAN.md` §5).

## Harv's identity: same rules for you

**The behaviour taught in these dev sessions IS Harv.** `harv/persona.md` is Harv's shared rulebook. The runtime Harv loads it into its system prompt, and you (Claude Code working in this repo) follow it too.
- When the user teaches a new behaviour rule that applies to Harv generally, add it to `harv/persona.md` as well as saving it to memory.
- Dev-only rules (git, tests, wrap-up chores) stay in dev memory or here.
- `harv/persona.md` is public, so it must never contain personal data.
- The runtime Harv's private facts live in `~/.harv/memory/*.md`. That folder is also **your** source of truth about the user, so read it when user context matters and update it there. It reads them into its prompt at session start and changes them via its `remember`/`forget` tools (`apps/server/src/agent/memory.ts`), which can only write in that folder.

## Locked design: "Mission Control Glass"

The mockup is board "2b" at https://claude.ai/artifact/NAbsVqrzJ1MQMSmn3couH4. Its source is `MissionGlass.dc.html` in that artifact.

- IBM Plex Mono throughout.
- The user's misty forest photo, blurred, behind a dark scrim of `rgba(10,16,24,0.55)`. Frosted glass panels use `rgba(16,24,34,0.5)` with a 22px blur and a thin light border. The accent is ice blue `#A8C8E8`, with amber `#F2B880` for warnings at 85% or above.
- Header: a small status pill (idle, thinking or working), then the model switcher with **AUTO** first, then `auto → model · effort`.
- Left: a collapsible chat history. Center: Chrome-style chat tabs over a log-style chat, with attachment chips and a `harv>` command line. Right: a stats panel that starts narrow (label, % and thin bar) and expands to show everything, including Claude plan usage and Harv's own tracking.
- Animations are subtle, with a toggle to turn motion off.

## Auto router

Auto picks both model and effort for each task. The best possible result comes first and saving usage second. The pipeline is: instant rules, then a cheap Haiku classifier, then a lookup table, then escalation ("Try harder", automatic step-up), then logging. Every reply is tagged `[model·effort]`. Full spec: `docs/PLAN.md` §5.

## Hard constraint: subscription only, never anything billed

Harv runs only on the user's Claude subscription, which reaches Claude through the Claude Agent SDK / Claude Code login. The user has no API account and wants no extra charges, ever.

- Never use an Anthropic API key or the API's billing. That rules out the Messages API, the Admin/Usage API, Managed Agents, and any paid third-party service.
- Make sure `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are unset in Harv's process environment. If either is set, Claude Code / the Agent SDK uses it instead of the subscription login and bills per token.
- No paid fallbacks. When plan limits run out, Harv pauses, shows the reset time, and queues work. It never switches to a paid route.
- Every model call counts against plan limits, including the Auto router's Haiku classifier. Keep overhead calls cheap and rare.

## Environment

- Development happens on Windows 11. Both PowerShell and Git Bash are available.
- Available runtimes: Node.js 24 and Python 3.14.
- The git default branch is `main`.
- Any local secrets go in `.env`, which is gitignored (the repo is public). Commit only an `.env.example` that shows the variable names.

## Sensors setup on the user's PC

- LibreHardwareMonitor 0.9.6 was installed with winget, under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\LibreHardwareMonitor.LibreHardwareMonitor_*`.
- Its `LibreHardwareMonitor.config` enables the web server on `127.0.0.1:8085` and starts it minimized to the tray.
- **Harv starts LHM, not Windows** (the user's choice). On server start, `metrics/lhmLauncher.ts` launches it elevated if it isn't running, which shows a UAC prompt. `POST /api/sensors/start` retries, and the panel has a "Start sensors" button. `HARV_START_LHM=0` skips the launch, and `HARV_LHM_PATH` overrides the exe path.
- Don't create logon tasks or other autostart entries. Startup behavior is decided with the desktop app (M9).
- It must run as admin to read sensors.
- http.sys still listens on all addresses, so an inbound firewall rule, "Harv: block remote access to LibreHardwareMonitor (8085)", blocks the network. Keep it.
- The PC has Hamachi and Tailscale adapters, so never expose ports beyond localhost.

## Terms

- Use Harv only within Anthropic's terms for personal use: never host or share it, never read or store Claude credentials, keep the Claude Code binary unmodified, and brand it "Harv", never "Claude Code". See `docs/PLAN.md` §1.

## Commands

- `npm run dev`: server (tsx watch, http://127.0.0.1:4317) and web (Vite, http://127.0.0.1:5173). Vite proxies `/api` and `/ws` to the server.
- `npm test`: Vitest across workspaces. Run one test file with `npx vitest run apps/server/src/env.test.ts`, or one test by name with `npx vitest run -t "removes API credentials"`.
- `npm run typecheck` (`tsc --noEmit` in each workspace), `npm run lint` (ESLint flat config), `npm run format` (Prettier).
- `npm run build`: builds the dashboard. The server runs from TypeScript source via tsx, and there's no server build step.
- On Windows, stopping a background `npm run dev` (TaskStop, Ctrl+C in some shells) can leave orphaned `tsx`/`vite`/`node` children holding ports 4317/5173, and a stale tree makes new servers hang silently. Check `netstat -ano | grep -E ":(4317|5173)"` and kill those PIDs by tree. Never kill the user's `claude.exe`.
- New npm packages with install scripts are blocked by npm's allowScripts. Review a package before running `npm install-scripts approve <pkg>` (esbuild is approved).

## Code layout

- `packages/shared`: the WebSocket protocol (`ServerMessage` / `ClientMessage`) and constants. It's consumed as TS source (`exports: ./src/index.ts`).
- `apps/server/src`: `index.ts` (Fastify routes and `/ws`), `env.ts` (strips billed credentials at startup; keep this first), `paths.ts` (`~/.harv`, override with `HARV_HOME`), `background.ts`.
- `apps/server/src/metrics`: `collector.ts` merges the sources into one `MetricsSnapshot` (type in `packages/shared/src/metrics.ts`) and pushes `metrics.tick` every ~1 s.
  - LibreHardwareMonitor (`lhm.ts` parses, `fromLhm.ts` maps) is the fast main source, about 40 ms per read. Its values are locale-formatted (`"38,5 °C"`), so always go through `parseLhmValue`.
  - systeminformation (`system.ts`) is slow on Windows (0.5–5 s per call, since it shells out to PowerShell), so it only covers processes (5 s), volumes (30 s), static CPU info, and a CPU/RAM fallback.
  - `nvidia.ts` is the GPU fallback when LHM is down.
  - Missing sources leave fields undefined, and the UI hides them.
- `apps/server/src/agent`: one `ChatSession` per chat tab (`session.ts`).
  - Each session is a long-lived Agent SDK `query()` in streaming-input mode, fed by `AsyncQueue`.
  - Model changes use `q.setModel()`. Effort changes use `q.applyFlagSettings({ effortLevel })`, so context is kept.
  - `manager.ts` maps tabs to sessions, derives `idle`/`thinking`/`working`, asks the router for AUTO turns, and handles "Try harder" (`chat.harder`: re-asks one ladder step up).
  - `catalog.ts` reads `accountInfo()` and `supportedModels()` without sending a prompt, so it uses no plan usage.
  - `options.ts` builds every query:
    - an explicit `env` with no API key
    - `cwd` set to `~/.harv/workspace`
    - `settingSources: []` and `strictMcpConfig`, for isolation from the user's Claude Code config
    - Harv's own system prompt
    - `ENABLED_TOOLS` (read, Write/Edit, Bash/PowerShell) plus Harv's own `mcp__harv__*` tools
    - the safety gate's `PreToolUse`/`PostToolUse` hooks plus `canUseTool` as a backstop
  - A session refuses to run if the init message's `apiKeySource` isn't `none`/`oauth` (a subscription login).
- `apps/server/src/router`: the Auto router (`docs/PLAN.md` §5 "As built"). `rules.ts` (overrides, instant rules, follow-ups), `classifier.ts` (one Haiku·low turn, no tools), `table.ts` (ladder, difficulty table, plan trim), `router.ts` (the pipeline, per-tab task state). Every turn (AUTO or manual) is logged by `store/routes.ts` (`routes` table in `harv.db`, with tokens), which also feeds Harv's own usage stats. Any change needs `router.test.ts` cases.
- `apps/server/src/settings.ts`: `~/.harv/settings.json` (`HarvSettings` in `packages/shared/src/settings.ts`: protectedPaths, motion, accent, allowFable), cleaned on every read so a hand edit can't break Harv. The dashboard changes it with `settings.update`, and the server echoes `settings` to every window. `background.ts` saves or removes the photo (`POST`/`DELETE /api/background`, type checked from the bytes) and broadcasts a `background` version for cache-busting.
- `apps/server/src/usage/meter.ts`: plan usage from `/usage` (a local command, no tokens) plus live `rate_limit_event`s, pushed as `usage.update`. It owns the pause (`paused` status) while a limit is hit. `ChatManager` queues messages while paused, queues a "continue" for a turn the limit cut off, and `flushQueue()` sends them in order after the reset (`docs/PLAN.md` §5b). `manager.test.ts` covers the queue with a fake `ChatSession`.
- `apps/web/src`: `App.tsx` lays out Header, HistorySidebar, ChatPanel and StatsPanel. `lib/useHarvSocket.ts` is a module-level store over the single WebSocket: `useConnection()` and `useMetrics()` via `useSyncExternalStore`, so 1 s ticks only re-render what reads metrics. `components/stats/` holds the expanded panel's cards.
- `apps/server/src/agent/attachments.ts`: `POST /api/attachments?tab=&name=` (raw `application/octet-stream` body, 32 MB max) saves to `~/.harv/workspace/attachments/<tab>/<id>/<name>`. `buildContent` inlines small images, PDFs and text, and lists every saved path for Read. Deleting a chat deletes its folder.
- `apps/server/src/agent/chatTools.ts`: Harv's per-tab MCP server `harv` (memory tools plus `list_chats` and `read_chat` over the history DB). It also builds the recent-chats list for the system prompt. `ChatSession` diffs `memorySnapshot()` before each message and prepends a note when other chats changed memory. See `docs/PLAN.md` §6c.
- `apps/server/src/safety`: the permission gate (see "Harv's safety model" below and `docs/PLAN.md` §4).
  - `classify.ts` gives each tool call a tier, `gate.ts` enforces it from the SDK hooks, `backup.ts` handles backups and Undo, and `paths.ts` has path helpers, the workspace path and `~/.harv/settings.json` (`protectedPaths`).
  - The action log is `store/actions.ts` (an `actions` table in `harv.db`). Tool lines in the chat carry the tool_use id (`ref`), which is also the action id.
  - Any change here needs `classify.test.ts` / `gate.test.ts` cases. When in doubt, a command is red.
- `index.ts` refuses any request whose `Origin` isn't the dashboard (any web page can reach 127.0.0.1, including the `/ws` upgrade).
- `apps/server/src/store/chats.ts` keeps chat history in `~/.harv/harv.db` (`node:sqlite`, so there's no native dependency).
  - `ChatManager` writes every finished line through its `emit` wrapper. Deltas aren't stored.
  - It also stores the Claude `session_id` per chat. Reopening or restarting creates the session with `resume`, and if that fails, `onResumeFailed` starts it fresh.
  - Closing a tab sets `open=0`, so the chat stays in history. Delete removes it for good.
- Web state: `lib/socket.ts` is the only WebSocket (`onServerMessage`, `sendMessage`). Stores are built with `lib/createStore.ts`: connection/metrics/catalog in `useHarvSocket.ts`, and tabs/lines/model/effort in `chatStore.ts`, where `applyChatEvent` turns server events into chat lines. Theme tokens and the `glass` and animation utilities live in `index.css` (Tailwind v4 `@theme` / `@utility`). `App.tsx` applies the accent by overriding `--color-accent`, and motion off adds the `still` class. `components/SettingsPanel.tsx` is the ⚙ panel. `lib/commands.ts` holds the dashboard-only commands (`/model`, `/attach`, `/new`, `/help`); one-message overrides like `/opus …` still go to the server's router.
- The user's background photo is personal. It lives at `~/.harv/background.*` and is served by `/api/background`. Never commit it to this public repo.

## Harv's safety model (agreed with the user; tweak as we go)

Every action Harv takes goes through a permission gate, implemented with Agent SDK hooks rather than prompt instructions, so it can't be skipped. There are four levels:

- **Green (run immediately):** read stats or files, web search, open apps, create files inside Harv's own workspace.
- **Yellow (back up, run, verify):** edit, move or rename user files. Back up first to `~/.harv/backups/<timestamp>/`, log the action, and offer Undo.
- **Red (confirm first):** delete, install or uninstall, kill processes, run scripts, change system settings or the registry, send messages or email, `git push`. The flow: safety check (an exact preview of the impact plus a protected-path check), then backup, then a confirmation card in the dashboard (Approve, Deny, or edit), then run, then verify, then log.
- **Blocked:** formatting drives, writing to `C:\Windows`, disabling antivirus or the firewall, reading stored credentials. Only the user can unblock these, in settings.

Always on: a stop button with a hotkey that cancels the current action, user-defined read-only protected folders, and a full action log.
