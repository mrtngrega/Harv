# Harv: build plan

Status: M0–M3 done 2026-10-22 (scaffold, glass shell, live hardware panel, chat on the subscription, persistent tabs/history + Harv's persona and memory). M4 (file attachments) done 2026-10-23: attach button, drag-and-drop and pasted screenshots; images ≤3.75 MB, PDFs ≤20 MB and text ≤100 KB go inline as content blocks (verified live: Claude Code accepts `image` and `document` blocks in streaming input), and anything bigger is saved under `~/.harv/workspace/attachments/<tab>/<id>/` for the Read tool. M4b (one Harv across tabs) done 2026-10-23, see §6c. M5 (safety gate) done 2026-10-23, see §4: Harv can now write files and run PowerShell/Bash behind green/yellow/red/blocked tiers, with backups, approval cards, Undo, an action log and Esc to stop. Verified live: yellow create/edit with Undo, red delete approved then undone, red delete denied. M6 (Auto router) done 2026-10-23, see §5 "As built": verified live (small talk → haiku·low with no classifier call, a question → Haiku classifier → haiku·low, Try harder → haiku·medium). M7 (plan usage meter + limit handling) done 2026-10-23, see §5b: meters verified live against `/usage` (session 40%, weekly 15%); pausing, queueing and continuing are covered by tests (a real limit wasn't hit). M8 (polish) done 2026-10-23: Settings (⚙ in the header opens it as a tab in the chat bar: animations on/off, accent colour, background photo picker, allow Fable in AUTO, read-only folders) saved in `~/.harv/settings.json` and synced to every window; the status pill names the running tool ("working · Read") and the reset time when paused; chat lines carry times; the tab bar shows the chat's context size; the plan cards follow the mockup (Session with resets-in, Weekly with pace, Harv today with routing by model); `/model`, `/attach`, `/new` and `/help` run in the dashboard without a model call. Built and unit-tested; settings sync and the background endpoints checked live, the look not yet reviewed by the user. Next: M9 (desktop app), which waits until the user asks for it. The user wants every milestone built first and will test and tweak at the end. Web app only for now; the desktop app (M9) is deferred until the user asks.

## 1. Can Harv run on a Claude subscription? (research summary)

**Verdict: yes for personal use on your own PC, with conditions Harv must respect.**

What Anthropic's docs say ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)):

- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code **and the Agent SDK**." In other words, an individual using the SDK on their own plan is expected.
- The restriction is aimed at **developers offering products to other people**: "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."
- "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription." The Agent SDK runs that same binary.
- Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
- The planned move of Agent SDK usage to a separate monthly credit (announced May 2026, due June 15) was **paused**. SDK usage currently draws from normal plan limits. This could change, so check again before each major release.

**Rules Harv follows to stay inside the terms:**
1. Personal use only. It is never hosted for, shared with, or used by anyone else.
2. Login happens only through Claude Code's own `claude` login flow. Harv never reads, copies, or stores tokens (it doesn't touch `~/.claude/.credentials.json`).
3. The Claude Code binary is used unmodified.
4. Branding is "Harv", optionally "powered by Claude". Never "Claude Code".
5. Ordinary individual usage: no 24/7 automated loops that hammer the plan.
6. No API key: the SDK subprocess gets an explicit `env` (the `env` option *replaces* the environment) with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` removed.
7. If a `rate_limit_event` arrives with `status: "rejected"` or `errorCode: "credits_required"`, Harv **pauses and shows the reset time**. It never offers to buy credits and never enables extra usage.

## 2. Key technical findings

| Need | Finding |
|---|---|
| Claude engine | `@anthropic-ai/claude-agent-sdk` (TypeScript), v0.3.309 (updated 2026-10-23), Node >= 18. Claude Code 2.1.309 is installed. |
| Model per chat | `model` option. Mid-session: `query.setModel()` (streaming input mode). |
| Effort | `effort` option: `low`, `medium`, `high`, `xhigh`, `max`. **Verified in M2:** mid-session changes work through `query.applyFlagSettings({ effortLevel })`, and context is kept. |
| Live streaming | `includePartialMessages: true` |
| Tabs and history | One streaming-input `query()` per tab. Session IDs are stored, and `resume` reopens old chats. `forkSession` is available. |
| Stop button | `query.interrupt()` plus `abortController` |
| Safety gate | `PreToolUse` hook (`permissionDecision: allow / deny / ask / defer`, `updatedInput`) plus `canUseTool` |
| Files and images | Image and document blocks in `SDKUserMessage.message.content`. Large files are copied to the Harv workspace and read with the Read tool. |
| **Plan usage meter** | Send `/usage` as a prompt → an `SDKAssistantMessage.usage_report` (`SDKUsageReport`) arrives with `rate_limits.limits[]` = {kind, group, percent, resets_at, scope.model}, plus `extra_usage.is_enabled`. This is official and touches no credentials. It's marked experimental, so its shape may change. Live updates during work come from `rate_limit_event` (`utilization`, `resetsAt`, `status`). |
| CPU, RAM, disk, network, processes | `systeminformation` (npm) |
| GPU (**RTX 3060 Ti**, 8 GB, driver 621.01) | `nvidia-smi --query-gpu=... --format=csv` polled once a second: utilization, temperature, VRAM, power, clocks, fan |
| CPU temp and power, fans, motherboard (**Ryzen 7 5700X3D**, 8C/16T, 32 GB RAM) | LibreHardwareMonitor's web server at `127.0.0.1:8085/data.json`. Needs admin rights and must listen on localhost only. Sensors vary by motherboard, so the UI only shows what exists. |
| Desktop app | Tauri 2 with the Node backend as a sidecar (`externalBin`). Comes later (M9). |

## 3. Architecture

```
Harv/
  apps/server/      Node 24 + TypeScript: Fastify (HTTP) + ws (WebSocket)
    agent/          Agent SDK sessions (one per tab), router, safety gate
    metrics/        systeminformation, nvidia-smi, LibreHardwareMonitor collectors
    usage/          /usage polling + rate_limit_event tracking
    store/          SQLite (`node:sqlite`, built into Node): tabs, chats, routing log, action log, settings
  apps/web/         React + Vite + Tailwind: the Mission Control Glass UI
  apps/desktop/     Tauri 2 shell (M9)
  packages/shared/  WebSocket message types shared by server and web
docs/PLAN.md        this file
```

npm workspaces, TypeScript strict mode, Vitest for tests, ESLint + Prettier.

**Data flow:** browser ⇄ WebSocket ⇄ server. Server pushes: `metrics.tick` (1s), `chat.delta`, `chat.tool`, `approval.request`, `usage.update`, `harv.status`, `router.decision`. Browser sends: `chat.send`, `chat.stop`, `approval.answer`, `tab.*`, `settings.*`.

**Harv's own space:** `~/.harv/` (workspace, backups, database, settings). Harv uses its own system prompt and does **not** load your dev projects' CLAUDE.md files (`settingSources` is limited).

## 4. Safety gate (agreed design; see CLAUDE.md)

Every tool call → `PreToolUse` hook → classifier → tier:
- Green: allow.
- Yellow: back up the target file to `~/.harv/backups/<timestamp>/`, allow, verify, log with Undo.
- Red: dry-run preview and protected-path check → confirmation card in the UI (`defer`/`ask`) → run → verify → log.
- Blocked: deny with a reason.

Shell commands are parsed for risky patterns: `rm`, `del`, `Remove-Item`, `format`, `reg`, `winget install/uninstall`, `Stop-Process`, `taskkill`, `git push`, network sends, and so on. When unsure, the command is treated as red. The stop button calls `interrupt()` and aborts. The action log lives in SQLite.

**As built (M5):**
- `safety/classify.ts` sorts each call:
  - Reads and Harv's own tools are green.
  - Write/Edit in the workspace is green. Elsewhere it's yellow, red in Program Files, and blocked in Windows, protected folders, Harv's data and secrets.
  - A shell command is green only if every part is on a read-only list (or it just opens an app, page or document) and it has no redirection or command substitution.
  - Creating *new* folders (`mkdir`, `New-Item -ItemType Directory`) is yellow: logged, and Undo removes them. It's green in the workspace. Added 2026-10-23 so that "new project" (persona rule 8) creates its folder in the user's projects folder without a card.
  - Blocked patterns (drive formatting, AV/firewall off, credential stores, Windows folder, protected folders) come first. Everything else is red with a category reason.
- `safety/gate.ts` runs inside the `PreToolUse` hook (24 h timeout), so a red call waits right there for the dashboard's answer. `canUseTool` is a backstop that denies any red call without a recorded approval. `PostToolUse`/`PostToolUseFailure` verify and log.
- Backups are best-effort for shell commands: every literal path in the command that exists is copied, up to 500 MB / 5000 files, and the card says when nothing could be backed up. Undo first moves the current version aside, so it never loses data.
- If the user edits a command on the card, it's re-classified. Only blocked edits are refused.
- Protected folders are `protectedPaths` in `~/.harv/settings.json` (the settings UI comes in M8).
- Esc (or Stop) denies the tab's waiting approvals and interrupts it. A waiting approval makes Harv's status `waiting` ("needs you").

## 5. Auto router (model + effort)

1. **Instant rules** (no model call): slash overrides (`/opus`, `/max`...); any red action → at least Opus·high; code or large files → at least Opus·high.
2. **Classifier**: a one-shot Haiku 5.5 query at low effort, with no tools and one turn, returning JSON `{category, difficulty 1-5, stakes, ambiguous}`. Skipped when the rules already decided. Follow-ups in the same task reuse the previous decision.
3. **Table**: difficulty 1 → Haiku·low · 2 → Haiku·medium · 3 → Sonnet·medium/high · 4 → Opus·high/xhigh · 5 or high stakes → Opus·max. High stakes pushes the pick up one level. Fable 5.1 is only used when an "allow Fable" setting is on.
4. **Quality nets**: a "Try harder" button (one tier up), an automatic step-up on tool or test failure or when the model says it's unsure, and higher effort for a long task's hardest step.
5. **Plan awareness**: above about 80% weekly usage, trim effort on difficulty 1-3 only. Never downgrade difficulty 4-5.
6. **Log and learn**: every decision is stored with the user's feedback. The panel shows the routing split. The table gets tuned from that data.
7. **Transparency**: every reply is tagged `[model·effort]`, and hovering shows the reason.

**Tuning for Claude Pro.** The user has Pro, which has the smallest limits.
- Sonnet is the workhorse for difficulty 2-3.
- Opus is reserved for difficulty 4-5 and red actions.
- `max` effort only for difficulty 5.
- Haiku handles more of the trivial work.
- The classifier is skipped whenever the rules or the previous turn already decide.
- Fable 5.1 **is** offered on Pro (verified in M2). It stays out of AUTO unless the user turns it on, and is available as a manual pick.
- At M2, check which models the subscription actually offers in Claude Code (the SDK's model list) and remove any that aren't available from the switcher and the router.
- Plan-aware trimming starts at about 70% weekly instead of 80%.

**As built (M6, 2026-10-23).** Code in `apps/server/src/router/`; tune it from the `routes` log.
- Ladder (Try harder and automatic step-ups climb it one step): haiku·low → haiku·medium → sonnet·medium → sonnet·high → opus·high → opus·xhigh → opus·max. Manual picks off the ladder (sonnet·low, Fable) step to the next one above.
- Rules: `/opus`, `/sonnet`, `/haiku`, `/fable` and `/low`…`/max` at the start of a message (stripped, also work in manual mode); small talk → haiku·low; a risky verb (delete, install, kill, registry…) plus a PC object (file, folder, app, process, a path…) → opus·high. Red actions can't be known before the model acts, so this text rule stands in for "any red action".
- **Changed from the spec for Pro:** code or large input (code fences, code attachments, >2 MB of files, >6000 chars) sets a *floor* of sonnet·high, not Opus·high. The classifier can still raise it to Opus for difficulty 4–5.
- Table: d1 haiku·low, d2 haiku·medium, d3 sonnet·medium (sonnet·high for code), d4 opus·high, d5 opus·max; high stakes one step up.
- Follow-ups: a short message (≤160 chars, no attachments, no "new question"-style words) within 20 min reuses the tab's task decision without calling the classifier. Small talk doesn't replace the task decision. If the previous turn failed, the follow-up steps up one.
- Classifier: one Haiku·low turn, no tools, `maxTurns: 1`, not persisted, 20 s timeout, about 3–4 s. On failure → sonnet·medium (respecting any floor). The status pill shows "thinking" while it runs, and the chat shows the thinking line right away.
- Log: `routes` table in `harv.db` (model, effort, source, reason, category, difficulty, stakes, feedback = "harder"). `RouteStore.split()` gives the routing split.
- Reply tags show the reason on hover (stored with the line, so it survives reloads). "↑ try harder" sits on the newest reply once the tab is idle.
- **Not built yet:** step-up on tool/test failure or when the model says it's unsure; extra effort for a long task's hardest step; ~~an "allow Fable" setting~~ (done in M8: d5 → fable·high, and Try harder climbs past opus·max to fable·high → fable·max).

## 5b. Plan usage meter and limits (M7, built 2026-10-23)

- **Source:** `/usage` sent as the prompt of a throwaway session (`usage/meter.ts`). It's a local Claude Code command. Checked live: 0 tokens, cost 0, about 1 s. `usage_report.rate_limits.limits[]` gives `session` and `weekly_all` (plus `weekly_scoped` rows per model when the plan has them) with percent, `resets_at` and severity, and `extra_usage.is_enabled`.
- **Freshness (faster since 2026-10-24, the user said it lagged):** fetched at startup, every 2 min while the user is chatting (a turn in the last 10 min), every 10 min when idle, and after each turn (at most every 20 s, at least 3 s after). Live `rate_limit_event`s update the matching meter in between (`five_hour` → session, `seven_day` → weekly). The plan card shows "updated Nm ago".
- **Warnings (2026-10-24, the user's wish: "remind me every time we're reaching the session limit"):** crossing 75/90/95% of the session or 75/90% of the weekly meter (Settings › Usage warnings) sends `usage.warning`: a toast plus a note in the open chat. Once per threshold per window (keyed by the reset time); a jump past several gives one warning. Checked on every `/usage` reading and every live rate-limit event.
- **Pause:** a `rejected` event, an assistant `rate_limit` error, or a meter at 100% pauses Harv until the reset (status `paused`, shown with the time). A reset time that's unknown or already past retries `/usage` every 5 min. At the reset Harv re-checks `/usage` and only resumes when it agrees.
- **Queue:** while paused, new messages are saved and queued (a notice says when they'll go). A turn cut off by the limit queues a "continue where you left off" at the same model·effort. After the reset the queue runs in order, one turn at a time. Stop (or "cancel this tab's queue") drops a tab's queued work, and closing or deleting the tab does too.
- **Never paid:** if a `rate_limit_event` says overage is in use, the turn is stopped at once and Harv pauses. If extra usage is switched on in claude.ai, the panel suggests turning it off.
- **Harv's own tracking:** every turn (AUTO or manual) is a row in the `routes` table with its tokens (input includes cached context). The panel shows today's turns and tokens plus the 7-day routing split with "try harder" counts.
- The router's plan-aware trim now gets the weekly % from the meter.

## 6. Milestones (each ends with something you can see working)

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold: workspaces, TS, lint, tests, dev script | `npm run dev` opens an empty glass shell at localhost |
| M1 | Live hardware panel (narrow and expanded) | Real CPU, GPU and RAM values tick every second. LHM sensors show when LHM is running. |
| M2 | Chat on the subscription: one tab, streaming, manual model + effort | You chat with Harv. A check confirms no API key is used. Effort control is verified. |
| M3 | Tabs + history (SQLite, resume) + **Harv's persona and memory** | Several chats open at once, survive a restart, history is searchable. Harv follows the shared rulebook `harv/persona.md` (the same behaviour rules the user teaches in dev sessions) and has its own persistent memory in `~/.harv/memory` that it can read and update. |
| M4 | Files: drag-and-drop, attach button | Harv reads a PDF or image you drop in |
| M5 | Safety gate: tiers, approvals, backups, action log, stop | A red action shows a card, Undo restores a backup, Stop halts work |
| M6 | Auto router | AUTO picks model·effort with reasons, Try harder works |
| M7 | Plan usage meter + limit handling | Session and weekly % match `/usage`. Hitting a limit pauses and queues. |
| M8 | Polish: animations, settings, background picker, status pill | It looks like the mockup |
| M9 | Desktop: Tauri window, tray, autostart | Harv starts with Windows |

## 6b. Harv's identity: one set of behaviours (decided 2026-10-22)

The user's principle: **the behaviour built in development sessions IS Harv.** The Claude Code sessions that build Harv and the Harv running in the dashboard follow the same rules.

- `harv/persona.md` (public repo): personality and behaviour rules. Runtime Harv loads it into its system prompt, and `CLAUDE.md` tells dev sessions to follow it too. No personal data goes here.
- `~/.harv/memory/` (private, on the PC): what Harv knows about the user, such as their profile, preferences and decisions. It's read into context at session start and updated through a scoped `remember`/`forget` tool that can only write inside that folder.
- When the user teaches a new rule, it goes into `harv/persona.md` if it applies to Harv generally. Dev-only rules (git, testing) stay in `CLAUDE.md` or dev memory.

## 6c. One Harv across tabs (M4b, decided 2026-10-23)

The user's wish: every tab is its own session, but they all behave as the same Harv, remember past sessions and can work with the other open chats.

- **Same Harv:** every session gets `persona.md` and the memory files. When memory changes (another tab's `remember`/`forget`, or a hand edit), each open session gets a short note with its next message (`memorySnapshot`/`memoryChanges`); a session's own edits aren't echoed back.
- **Past sessions:** the system prompt lists the 10 most recent other chats (id, title, date, open/closed), which needs no model call. The `list_chats` tool (search titles and messages) and the `read_chat` tool (the latest lines, capped at about 16k characters) read the SQLite history. They're only used when the user refers to another chat.
- **Open tabs:** `read_chat` works on open tabs too, but only shows finished lines.
- **Hand-off (built 2026-10-23):** the `hand_off` tool gives a task to another chat (by id) or a new tab. It runs there as a normal AUTO turn through that chat's own safety gate, so the tool itself is green. The target shows "Handed over from …" and the request as lines, opens as a tab without stealing focus, and Claude sees a `[Handed over from …]` note. By default the calling chat waits (up to 15 min) and gets the answer back (capped at 12k chars); `wait: false` just starts it. Refused: handing to itself, to a busy chat, to a chat that's waiting on the caller (loops), or while paused on a limit. The prompt says to hand off only when the user asks, since it's about 2× usage. Verified live: tab A (haiku·low) handed "17 × 23" to a new tab, which AUTO-routed to haiku·low and answered 391, and A reported it.
- **Chat names (2026-10-23, the user's wish):** tab titles are quick short names for what the chat is working on. The router's Haiku classifier returns a `title` with its routing answer (no extra call), given the current name, so a new topic renames the tab. Manual mode names a new chat with one classifier call. Right-click (or F2) on a tab renames it; a name the user gave is locked (`title_locked`) and never auto-changed. Verified live: "RAM vs VRAM", then "Houseplant winter care" after a topic change.
- **On hold:** automatic chat summaries (one Haiku call per chat), for Pro limits.

## 6d. Tools inside each chat: terminal, files (built 2026-10-23, reworked 2026-10-24, the user's wish)

**2026-10-24 rework (the user's wish):** "+" opens a plain chat. The tools live *inside* a chat: a small collapsible menu at the right of the chat bar (`ViewMenu` in `TabParts.tsx`, "≡ chat ▾") switches the active chat between its log, its File Explorer and its Terminal; open tools show a dot and an × in the menu, and the tab shows the tool's icon. One of each per chat; closing a chat closes its tools (the server ends its terminal). The server-side tool registry is gone: a chat's terminal id is `terminal-<chatId>` and the dashboard keeps which tools each chat has.

**Tabs come back after a restart, like Chrome (2026-10-24):** the dashboard saves its layout to `~/.harv/ui.json` (`ui.save`, debounced; `UiState` in `packages/shared/src/tools.ts`, cleaned by `server/src/ui.ts`): tab order, the active tab, Settings open, blank chats (opened with + but never sent, which only the dashboard knows: `Tab.stored`), each chat's tools and view, each explorer's folder, and unsent drafts (text, now per chat, and already-uploaded attachments). `hello.ui` restores it on the first connect only (after a reconnect the open page's layout wins). Settings › Startup › Reopen tabs off starts Harv with no tabs (chats stay in history) and clears the saved layout.

- **Terminal:** PowerShell in a real pseudo-terminal (`@lydell/node-pty`, a prebuilt ConPTY binary with no install script) rendered with xterm.js. The last 200k characters are kept, so a reload or reconnect replays the output (`term.attach`). It's the user's own shell: no safety gate, and Harv never writes to it. It starts lazily on the first `term.attach` (in the folder the explorer asked for, else where it was, else Settings › Default folder, else home). **Restore:** each terminal also feeds a headless xterm (`@xterm/headless`, no deps or install scripts) so its screen can be saved as plain text plus the last prompt's folder to `~/.harv/terminals/<id>.{log,json}` every 10 s and on shutdown (a hard kill loses at most 10 s, verified). After a restart it's a fresh PowerShell in that folder; the old lines come in `term.data.restored` and the dashboard prints them grey above the new screen (padded by its real row count, because ConPTY clears the screen on start) and scrolls to show both. A restored shell nobody typed in keeps the old save unchanged (no extra divider per restart). Saved terminals of chats that are gone are pruned at startup.
- **File Explorer (rebuilt 2026-10-23 to work like Windows 11's):** command bar (New, cut/copy/paste, rename, send to chat, delete, Sort, View, more), breadcrumb address bar that folds long paths into « and turns into a text box, search box (recursive name search), navigation pane (Home, home folders, This PC with drives), Home (Quick access + Recent, falling back to the newest files in Desktop/Downloads/Documents when Windows keeps no recent items), This PC (drives with labels and free space), Details / Large icons / List views, details pane with preview, status bar, right-click menus, multi-select, keyboard shortcuts (arrows, Enter, Backspace, Del, Shift+Del, F2, F5, Ctrl+A/C/X/V, Ctrl+Shift+N, Ctrl+F, type to jump), drag and drop (move within a drive, copy across, Ctrl/Shift like Windows; files dropped from Windows are copied in), Properties dialog, Open in Terminal (a PowerShell tab in that folder), Open in Windows Explorer. Delete goes to the real Recycle Bin (verified live); Shift+Delete asks first. Server: `tools/fileOps.ts`, `/api/files/{op,search,props,drives,recent,upload}`. A real Explorer window can't be embedded in a web page; maybe in the desktop app (M9).
- **Files (first version):** folders (places, drives, back/forward/up, filter, hidden toggle), a preview pane (text, images, PDF, audio/video), Open (default app), Show in Explorer, and Send to chat (copies the file into that chat's attachments and switches to it). Text previews are served as `text/plain` with `nosniff` and a CSP sandbox; SVG and HTML are never rendered.
- **Browser (removed 2026-10-23 at the user's request: "it doesn't work properly, we will come back to it"; the full code is in commit a3d96e0, restore from there):** the user's installed Chrome ran headless (`puppeteer-core`, own profile in `~/.harv/browser-profile`, so the user logs in to sites there once) and is streamed into the tab with `Page.startScreencast` (JPEG frames, only while the tab is showing or Harv is working in it). The user's mouse, wheel, keys and paste go back via `Input.dispatch*`. Address bar (URL or Google search), back/forward/reload, "open in Chrome" (the user's normal Chrome). Pop-ups open in the same tab, dialogs are dismissed, only http(s) pages. Chrome quits when the last browser tab closes. A true native Chrome window inside the page isn't possible in a web app; the desktop app (M9) could host one.
- **Harv in the browser (removed with it):** `browser_open / snapshot / click / type / press / scroll / back / screenshot` MCP tools work in Harv's browser tab (it opens one if needed, without stealing focus; the tab shows "Harv is browsing"). The snapshot numbers visible interactive elements (`data-harv-ref`) and returns the page text. The safety gate judges each call (`safety/browser.ts`): looking is green; clicking something that sends/buys/posts/deletes/signs up, typing into password or payment fields, typing+submitting in message boxes, and pressing Enter are red (approval card with the site and element). Verified live: example.com → "Learn more" → read the title (all green); httpbin "Submit order" → approval card → denied → Harv said nothing was sent.
- **Security:** every request whose `Sec-Fetch-Site` is cross-site or same-site is refused (an `<img>` from another site sends no Origin header), on top of the Origin check.
- **Sorting (2026-10-24, the user's wish):** newest first by default, folders and files mixed when sorting by date, with Windows' date groups in the details view (Today, Yesterday, Earlier this week, Last week, Earlier this month, Last month, Earlier this year, A long time ago; weeks start Monday). Each folder remembers its own sort (`harv.explorer.sorts` in localStorage). Name/type/size sorts keep folders on top, like Windows.
- **Ideas for later:** the user said on 2026-10-24 "no more functionalities, let's polish and perfect what we have". Parked: notes, a file viewer, processes, the action log as a tab, Harv running commands in a visible terminal.

## 6e. Settings (2026-10-24, the user's wish: "customize way more stuff")

`HarvSettings` (`packages/shared/src/settings.ts`), cleaned field by field in `server/src/settings.ts` (clamped numbers, known choices, sorted percent lists, absolute `workDir` only). Sections in `SettingsView.tsx`:

- **Look:** accent (presets or any colour), size (CSS `zoom` 80–130% on the app root; heights use `--app-h: calc(100vh / zoom)` since Chrome scales vh with zoom), glass opacity (`--glass-alpha` in the `glass` utility), chat spacing (comfy/compact), animations, reset to default. **Background effect:** blur (default 9px, half the old 18px) and darkness (the scrim).
- **Chat:** times on lines, model tags, Enter or Ctrl+Enter to send (the input is an auto-growing textarea), **AUTO:** start on AUTO or the last model, allow Fable.
- **Stats panel:** start expanded, which rows the narrow view shows (CPU and GPU also show their temperature there), °C/°F, update every 1/2/5 s (the collector reads it before each tick).
- **Usage warnings:** session and weekly marks (§5b).
- **Default folder:** where terminals and the explorer open, and a line in Harv's system prompt saying to work there when the user doesn't say where. Harv's session `cwd` stays `~/.harv/workspace` on purpose: the safety classifier resolves relative paths against the workspace, so moving the cwd would let a relative path look like a workspace (green) file. Files Harv writes in the default folder are yellow (backup + Undo).
- **Safety:** ask before yellow changes too (`confirmYellow`: yellow calls go through the approval card, still backed up). Read-only folders.
- **Startup:** reopen tabs, start the sensors (LHM; `HARV_START_LHM=0` still overrides).

## 7. Risks and open questions

- **Terms can change.** Re-check the legal page and the Agent SDK credit status before each milestone release.
- `/usage` report shape is experimental. Parse it defensively, and the meter hides itself if the data is missing.
- ~~Effort mid-session~~: works (M2).
- LibreHardwareMonitor needs admin rights. Without it: no fans, CPU temperature, or motherboard sensors (everything else still works).
- Plan limits depend on which plan you have.

## 8. Needed from the user

- ~~Which plan~~ → **Claude Pro** (answered 2026-10-22). The router is tuned for it (§5).
- Confirm Claude Code is logged in with that subscription (`claude` → `/status`).
- ~~LibreHardwareMonitor~~: installed and configured by Claude (M1). Harv starts it.
- ~~Extra usage~~: confirmed **off** via the `/usage` report (2026-10-22).
