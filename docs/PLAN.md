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
| M10 | Several devices (§6m): Linux support, Git sync, live over Tailscale, home hub | A chat started on the notebook shows up on the PC |

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

## 6f. Project mode: Harv as Claude Code (decided and built 2026-10-24)

The user's wish: Harv is the only AI they use, half of it for dev sessions like the Claude Code ones that build Harv. "We're starting a new project" or "let's work on X" should make Harv behave exactly like Claude Code (and still be Harv), remembering every rule without being told again.

- **Projects:** a registry of project folders. A new project gets a folder in `C:\My files\Code\Projects\<name>`, `git init` and a starter `CLAUDE.md`; existing folders (this repo) can be added. A chat can be bound to a project: badge on the tab, history grouped by project, terminal/explorer open there.
- **Project chats run as Claude Code:** `systemPrompt: { type: 'preset', preset: 'claude_code', append: <persona + Harv memory + dev rules> }`, `cwd` = the project folder, `settingSources: ['project']` (loads its `CLAUDE.md`), the full Claude Code toolset. The preset includes Claude Code's auto-memory, so Harv and Claude Code dev sessions on the same folder share one memory (`~/.claude/projects/<path>/memory`). Normal chats stay the assistant as now.
- **Dev rules:** the general dev rules now in Claude Code memory (end-of-session routine, testing method, build first, do it yourself, new project folder) move to a public `harv/dev-rules.md` loaded in every project chat.
- **Safety (the user's choice: "trusted folder"):** inside the project folder, edits and normal dev commands (npm/npx, tests, builds, git add/commit/status/diff/log, node/tsx scripts in the project) run without cards; git is the undo. Still red: git push, deleting or writing outside the project, global/system installs, registry and system settings, killing processes. Blocked stays blocked. The classifier must resolve relative paths against the project folder (the session's real cwd).
- **Usage:** the Claude Code prompt is large, so project turns cost more; AUTO uses the coding ladder (Sonnet·high normally, Opus for planning/hard work). Measured: one Haiku project turn sends ~71k input tokens (mostly cached after the first).
- **As built:** `projects` table + `chats.project_id` in `harv.db`; `ChatManager.setProject` (a session can't move folders, so the next message starts a new session with the last ~30 lines as context, `carry`); Harv tools `start_project` (folder in Settings › Projects › "New projects in", default `~/Projects`; `git init -b main`; starter `CLAUDE.md`), `open_project`, `list_projects`; dashboard: a chat's ≡ menu has a Project section, ▣ badge on project tabs and history rows, Settings › Projects (add/forget folders, projects folder); a project chat's terminal and explorer open in the project. Claude Code's agent tools (TodoWrite, Task/Agent, plan mode, BashOutput/KillShell) are green only in project chats. Writing Claude Code memory notes (`~/.claude/projects/*/memory/*.md`) is allowed; the rest of `.claude` stays blocked.
- **Verified live (Haiku·low, Harv repo):** `npm --version` ran with no card, the project's CLAUDE.md was in context, the auto-memory directory is `~/.claude/projects/C--My-files-Code-Harv/memory` (the same as the Claude Code dev sessions), and it calls itself Harv (the preset says "Claude Code", so the append states Harv's identity first).

## 6g. Running Harv day to day, and developing it from inside (2026-10-24)

- `npm run harv` (server without auto-restart + dashboard), started/stopped/restarted by `scripts/harv.ps1` (clean shutdown through `POST /api/shutdown`, then port cleanup; logs in `~/.harv/logs`, including `harv-script.log`). Desktop shortcuts "Harv", "Restart Harv", "Stop Harv" (`scripts/install-shortcuts.ps1`, icons from `scripts/make-icons.py`). Settings › Startup › Restart Harv (`POST /api/restart` runs the script detached through `cmd start`, verbatim arguments). Verified: stop (clean, "asked to stop"), start, restart from the script and from the endpoint.
- The user now develops Harv from a Harv project chat (prompt in `docs/harv-handoff.md`). Rules for that are in CLAUDE.md "Developing Harv from inside Harv": never stop/restart Harv from inside; server changes need the user's Restart.
- UI check scripts moved into the repo: `scripts/ui-check/` (CDP-driven headless Chrome screenshots, layout-shift watcher, usage meters).

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

**Update 2026-10-24 (evening):** every registered project folder is trusted from any chat, not only from project chats. A command that starts by changing into a project (`cd`, `Set-Location`, `git -C`), or an edit to a file in one, gets the project rules (`projectOfCommand` in `classify.ts`). Read-only chains that mix git reads, `sed -n` and other reads are green everywhere. Claude Code's project memory may be read by shell commands, and reading Harv's logs is allowed (changing Harv's data stays blocked). Plain chats are told to call `open_project` first when the user wants to work on a project. Why: a plain chat developing Harv got an approval card for every `grep`/`sed`/`npm test`.

## 6g. Chats that work like Claude Code (built 2026-10-24 evening)

The user wants every chat, and project chats above all, to behave like Claude Code, without changing the look.

- **Queue while Harv works.** A message sent while a chat is busy waits in `ChatManager.followUps` (shown above the `harv>` line as "queued ›", with × to drop it, `chat.unqueue`). When the turn ends, however it ends (done, error or STOP), the next one runs as a normal turn (its "you" line is added then). STOP therefore means "send it now". A plan limit moves it to the limit queue (§5b). It's sent in `ChatSnapshot.queued`, so a reload still shows it.
- **Slash commands.** `/name args` runs a Claude Code command or skill when the chat's session offers it (`chat.commands`, from `supportedCommands()` after init and on `commands_changed`; before that the catalog's list, also read without a prompt). It's sent exactly as typed (no memory note in front), at the chat's last model·effort, with no router call (`source: 'command'`). Output from local commands (`<local-command-stdout>`) and a result with no message (/clear) show as Harv lines; /compact adds a notice. The dashboard's own commands (/model, /attach, /new, /help) and `/opus`-style words still win. `agent/commands.ts` hides and refuses anything that could bill or reach paid cloud features (/usage-credits, /extra-usage, /ultrareview, /fast, /schedule…), terminal-only ones, and /model and /effort.
- **The `/` menu.** Typing `/` opens a list above the command line (`SlashMenu.tsx`): name matches first, ↑↓ to move, Tab or Enter completes, Enter on a full name sends, Esc closes. It's a solid panel, because a backdrop blur inside the glass chat panel shows nothing.

## 6h. Router fixes (2026-10-24 evening)

The user found AUTO "a bit inaccurate". The route log showed why: a chat opened with "we continue on harv project" (chat, difficulty 2 → haiku·medium), and the next message, a real coding task under 160 characters, counted as a follow-up and reused haiku·medium for the whole session. Asking Sonnet or Opus to route every message would cost real plan usage on Pro, so Haiku stays the judge and the rules around it got better:

- **New work isn't a follow-up of a light start.** When the task's pick is below sonnet·high, a message that asks for work (`asksForWork`: do, build, fix, add, write, review… and over 25 characters) is classified again. Reactions to an answer still reuse the pick, and so does follow-up work on a strong pick (no extra call).
- **Context for the classifier.** It gets the chat's last four lines (cut to 220 characters each, `ChatManager.recentForRouter`) instead of a one-line label.
- **Project chats run at least sonnet·high** (`PROJECT_FLOOR`), small talk excepted.
- **Learning from "Try harder".** Follow-ups now log the task's category and difficulty. When the user asked to try harder on at least 2 tasks of the same category and difficulty in 30 days, and on at least a quarter of them, that kind starts one ladder step higher (`RouteStore.harderStats`), and the reason says so.

## 6i. The user's Claude Code setup in project chats (2026-10-24 evening)

The user asked for Claude Code's tools (artifacts, Claude Design, plugins) in Harv. Artifacts and Claude Design are claude.ai features that don't come through the subscription login. What does come through: project chats now load the user's own Claude Code settings (`settingSources` gains `'user'`, `strictMcpConfig: false`). That brings the skills synced from claude.ai (docx, pdf, pptx, xlsx, deep-research, skill-creator, morning…), plugins, and claude.ai connectors (right now Claude Docs), all on the subscription. They show up in the `/` menu too. Checked without a prompt: 66 commands instead of 53, plus the Claude Docs connector.

Safety: `Skill`, `SlashCommand`, `ToolSearch` and the MCP resource tools are green in project chats (they load instructions; what follows is checked tool by tool). Connector tools (`classifyMcp`) are green when they only read (get/list/search/…), green for writes to the user's private Claude Docs (delete asks), and red for any other write (a future Gmail connector sending mail, a project's own MCP server). Assistant chats still block them all. A user setting that would switch to API billing can't slip through: the session refuses to run unless it logs in with the subscription.

## 6j. PC watchdog (built 2026-10-24 evening)

The user picked this from the Jarvis ideas, with the rule "make it so it isn't annoying". No full-disk warnings. It focuses on background programs hogging the CPU/GPU for a long time, unwanted or dangerous software, and overheating. It uses no Claude usage.

- **Overheating** (from the sensors): CPU 85 °C, GPU 83 °C, GPU hotspot 100 °C or a drive 65 °C held for 2 minutes. The critical marks (92 / 90 / 108 / 75 °C) warn after 20 s. It warns once, then waits until the temperature drops 5 °C below the mark (and 30 minutes at least).
- **Background hogs**: a program (grouped by exe) using ≥ 20% of the whole CPU, or ≥ 40% of the GPU (nvidia-smi pmon, sampled only while the GPU is ≥ 40% busy, every 30 s at most), for 5+ minutes. Programs with a visible window are in use (a game, a render) and never count. Each program has a 2-hour cooldown.
- **Dangerous software**: Windows Defender (status and detections every 10 minutes, no admin needed). It alerts on a new detection, and on real-time protection being off. The newest detection already seen is kept in `~/.harv/watchdog.json`, so the old ones never alert. Known crypto miners and remote-access tools by name (critical). A program running from a Temp, Public or Recycle Bin folder that keeps using CPU for 3+ minutes.
- **Not annoying**: short dips forgiven (45 s grace), at most one ordinary warning per 10 minutes (critical ones always show), long cooldowns. Windows' own maintenance (Defender scans, updates, the indexer, svchost) and Harv itself are never reported. "Don't warn about X" adds a program to `watchdogIgnored`.
- **UI**: toasts at the top right, newest on top, at most 3 (ordinary ones fade after 30 s; critical ones stay until dismissed; long Defender paths wrap). Each has "Ask Harv" (opens a chat about it, the only part that uses the plan) and "Don't warn about X". Settings › Watchdog has only the on/off switch and the ignored programs: past warnings aren't listed there (the user's wish, "settings is only settings").
- Code: `apps/server/src/watchdog/` (`watchdog.ts` is the logic, tested with a fake clock; `probes.ts` runs the Windows checks; `monitor.ts` wires them to the metrics collector, which now also pushes the full process list).

## 6k. Tweaks from the ideas file (2026-10-24 night)

- **Reading is free everywhere.** Read-only PowerShell no longer asks: `isReadOnlyPowerShell` (`classify.ts`) reads a whole pipeline, script blocks and hashtables included, and lets it through when every command that runs is a read-only one (Get-*, Test-*, filters, formatting, `ollama list`-style program calls) and every .NET call is a harmless one (`SAFE_METHODS`). Command chains are split quote-aware, so a `|` inside `-match 'a|b'` no longer makes a read red. Harv may read the SDK's saved big tool outputs (`~/.claude/projects/*/<session>/tool-results`). Credentials stay blocked, with a longer list: browser passwords/cookies/`Local State`, Firefox logins, Windows Credentials/Vault/DPAPI keys, the SAM hives, Wi-Fi keys (`netsh wlan … key=clear` too), dev tokens (.npmrc, .git-credentials, .docker, .kube, gh, gcloud…), Discord/Telegram sessions, Steam logins, password managers, VPN state, Harv's own browser profile.
- **"Don't ask again"** on approval cards for shell commands: it saves a rule (`allowRules` in settings: the program plus subcommand, e.g. `npm install`, `ollama rm`, or the cmdlet, e.g. `remove-item`; force pushes and `git reset --hard` get their own rules). A covered command becomes yellow (backed up, logged, Undo) instead of asking. Commands that run other code (shells, interpreters, script blocks, `iex`) never get a rule; blocked and read-only-folder rules still win. Settings › Safety lists the rules with ×.
- **Status line like Claude Code**, above the `harv>` prompt, per chat: spinner, `thinking…` / `working · Tool` / `needs you`, elapsed time, output tokens so far (`chat.progress`: exact per message, characters/4 while streaming), "esc to stop"; when idle, the last reply's time and tokens. Offline and plan pauses show there too. The header pill is gone. An approval waiting in another chat shows a ! on its tab and a button in the status line.
- **Queued messages**: "send now" stops the current reply and runs that message first (`chat.sendNow`).
- **/btw**: a side question answered right away, even mid-reply, from a fork of the chat's session (one turn, no tools, not saved, the chat's own options so the prompt cache is reused; `agent/btw.ts`). Both lines show in the log; Claude's context never sees them.
- History sidebar starts collapsed, with the stats panel's ‹ › buttons.
- **/clear empties the tab**, like Claude Code's screen: after the command succeeds the chat's saved lines are deleted (`chat.cleared`); the chat keeps its name in history.
- **Tab dragging**: the whole tab bar takes the drop (gaps, past the last tab, the +); the nearest slot wins, and the bar scrolls near its edges.
- **Getting stuck** (found 2026-10-24 in the C-disk cleanup chat: 7 and 3 minute hangs): read-only scans asked for approval (fixed by the read rules above); Harv couldn't read its own saved big outputs (fixed); approval cards were invisible from another tab or the Files/Terminal view (now a ! on the tab, a jump button in the status line, and the cards shown above Files/Terminal); parallel red calls ask one card at a time, so cards get **Approve all for this reply** (`all`: the rest of that turn runs without cards, still backed up and logged, until `chat.done`; blocked stays blocked); Stop's denial now tells Harv it was an interruption, not a refusal (it had given up after Stop + "continue"). Persona rules 9 (keep scans quick) and 10 (Stop isn't "no").
- Speed was measured and left alone (the user's call): the classifier adds about 2.8 s on new-topic AUTO turns, session start is about 0.75 s, first text about 2.7 s median.

## 6l. History and test-pass fixes (2026-10-24, late night)

- **History lists only chats with messages** (`ChatStore.history`), so tabs used just for their terminal or file explorer never show, even when renamed. Closing a tab whose chat has no messages deletes it (`ChatManager.close`), so nothing invisible piles up (renamed tool tabs, untouched project chats, chats emptied by /clear).
- **Projects section** at the top of the history sidebar: one row per project (the user's wish). Clicking it goes to the project's open tab, else its latest chat, else a new chat in the project. Project chats stay out of the dated list; search shows a project when its name or one of its chats matches.
- Test pass after the restart (everything else fine: widths, shifts, tabs, terminal, files, Settings, motion off, origin checks, firewall rule). Fixed: the model switcher wraps on narrow screens (Fable was hidden off the edge), a short placeholder below 640px, and the / menu drops commands Claude Code lists as "(removed) …".

## 6m. One Harv on several devices (decided 2026-10-24, the user's wish)

Goal: Harv on the PC and on the notebook (Fedora 44, KDE Plasma) acts like one account. A chat, a memory or a setting changed on one shows up on the other. Each device runs its **own full Harv** (works with the other one off, shows its own stats, files and terminal), and they sync. Rejected for now: the notebook only opening the PC's dashboard over Tailscale (needs the PC on, and the files/terminal would be the PC's).

**Core idea: one change log per device.** `harv.db` (SQLite) can't be merged as a file, so each Harv writes its changes as events and only ever writes its own log; the other device replays what it hasn't seen into its own database. No two devices write the same file, so the transport never sees a conflict.
- Each install gets a device id and name (`~/.harv/device.json`). Events: chat created / renamed / closed / deleted, line added, project added (by name; each device maps its own folder path), memory file written / deleted, a shared setting changed, a route logged. Each event carries device, time and a per-device sequence number; every Harv keeps a cursor per peer.
- **Syncs:** chats and lines, Harv's memory (`~/.harv/memory`), shared settings (look, router, safety rules, read-only folders), projects by name, the route log (for Harv's own usage stats). **Stays per device:** hardware stats, watchdog, sensors/LHM, terminals, the tab layout (`ui.json`), backups, the action log, device-only settings (startup, default folder, background photo for now). Attachments: later, they can be big.
- **Continuing a chat on the other device:** the Claude context lives in `~/.claude/projects/<cwd>/<session>.jsonl` on the device that ran it. Sync that transcript with the chat and resume it (the folder name differs per device, since the cwd differs); if resuming fails, start fresh with the chat's lines fed in, the same fallback as after a restart (`onResumeFailed`). The transcript layout is Claude Code internal, so treat it as best effort.
- **Conflicts:** chats are append-only, so the only conflict is sending in the same chat on both devices while they're apart: the later branch forks into its own chat ("… (notebook)"), nothing lost. A memory file changed on both: newest wins, the other copy is kept as a conflict note that Harv merges at the next session. Settings: newest wins per key.
- Existing data: the first sync exports the current database as the PC's opening snapshot.

**Phases (quickest first):**
1. **M10a: Harv on Linux.** The notebook runs Fedora, and the server is Windows-only today (no `process.platform` checks): PowerShell terminal, LHM, the watchdog probes, the safety classifier's Windows paths, `scripts/harv.ps1`. Add a platform layer: bash terminal, metrics from systeminformation (plus `nvidia-smi` if present), LHM and the Windows watchdog probes off, Linux protected/blocked paths (`/etc`, `/usr`, `/boot`, `sudo` red, `rm -rf /` blocked…) with `classify.test.ts` cases, and a `scripts/harv.sh` start/stop/restart. Notebook setup: Node 24, git, `gh`, Claude Code logged in with the same subscription, Tailscale.
2. **M10b: Git sync (the quickest transport).** A separate **private** repo (never the public Harv repo) cloned to `~/.harv/sync`. Each device adds new **encrypted chunk files** to its own folder (`<device>/<seq>.age`, encrypted with `age`; the key lives only on the devices, copied once by hand), so GitHub only sees noise and pushes never conflict. Push after each finished reply and every ~2 min while active; pull on start and every ~2 min. Status (last sync, behind/ahead, errors) in Settings and the stats panel. Latency: a minute or two.
3. **M10c: Live over Tailscale.** When both devices are online, Harvs send events to each other directly (seconds, could even stream a reply); Git stays the mailbox for when one is off. Listens on the tailnet only, checks the peer's Tailscale identity, never Funnel.
4. **M10d: The hub (old 2015 i5 laptop).** An always-on box at home: Ubuntu Server 24.04 or Debian (no desktop), SSD if it still has a hard drive, battery checked for swelling (removed if so, charge limit ~60% if the BIOS allows), runs with the lid closed, ~10 W. Both Harvs sync through it over Tailscale, live, and it holds changes for an offline device, so data never leaves the user's devices. Git becomes an encrypted offsite backup the hub pushes daily. Later the hub runs its own Harv: reminders, scheduled jobs while the PC sleeps, reachable from the phone over Tailscale.

**Rules that still hold:** subscription only (each device logs into Claude Code with the same account, nothing billed); personal use on the user's own devices only, never shared or hosted for others; the dashboard and server stay on localhost, and anything that listens beyond it (M10c, M10d) is tailnet-only with an identity check; no personal data in this public repo.
