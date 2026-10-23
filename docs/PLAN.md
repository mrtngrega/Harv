# Harv: build plan

Status: M0–M3 done 2026-10-22 (scaffold, glass shell, live hardware panel, chat on the subscription, persistent tabs/history + Harv's persona and memory). M4 (file attachments) done 2026-10-23: attach button, drag-and-drop and pasted screenshots; images ≤3.75 MB, PDFs ≤20 MB and text ≤100 KB go inline as content blocks (verified live: Claude Code accepts `image` and `document` blocks in streaming input), and anything bigger is saved under `~/.harv/workspace/attachments/<tab>/<id>/` for the Read tool. M4b (one Harv across tabs) done 2026-10-23, see §6c. M5 (safety gate) done 2026-10-23, see §4: Harv can now write files and run PowerShell/Bash behind green/yellow/red/blocked tiers, with backups, approval cards, Undo, an action log and Esc to stop. Verified live: yellow create/edit with Undo, red delete approved then undone, red delete denied. M6 (Auto router) done 2026-10-23, see §5 "As built": verified live (small talk → haiku·low with no classifier call, a question → Haiku classifier → haiku·low, Try harder → haiku·medium). M7 (plan usage meter + limit handling) done 2026-10-23, see §5b: meters verified live against `/usage` (session 40%, weekly 15%); pausing, queueing and continuing are covered by tests (a real limit wasn't hit). Next: M8 (polish). The user wants every milestone built first and will test and tweak at the end. Web app only for now; the desktop app (M9) is deferred until the user asks.

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
- **Not built yet:** step-up on tool/test failure or when the model says it's unsure; extra effort for a long task's hardest step; an "allow Fable" setting (Fable stays manual-only).

## 5b. Plan usage meter and limits (M7, built 2026-10-23)

- **Source:** `/usage` sent as the prompt of a throwaway session (`usage/meter.ts`). It's a local Claude Code command. Checked live: 0 tokens, cost 0, about 1 s. `usage_report.rate_limits.limits[]` gives `session` and `weekly_all` (plus `weekly_scoped` rows per model when the plan has them) with percent, `resets_at` and severity, and `extra_usage.is_enabled`.
- **Freshness:** fetched at startup, every 10 min, and after turns (at most once a minute, at least 3 s after). Live `rate_limit_event`s update the matching meter in between (`five_hour` → session, `seven_day` → weekly).
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
- **Later (after M5):** handing work to another tab (tab A asks tab B to do something). It runs two sessions at once (about 2× usage) and must pass the safety gate. Optional automatic chat summaries (one Haiku call per chat) are on hold for Pro limits.

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
