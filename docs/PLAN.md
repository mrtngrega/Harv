# Harv: build plan

Status: M0–M3 done 2026-10-22 (scaffold, glass shell, live hardware panel, chat on the subscription, persistent tabs/history + Harv's persona and memory). Next: M4 (file attachments). Web app only for now; the desktop app (M9) is deferred until the user asks.

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
| Claude engine | `@anthropic-ai/claude-agent-sdk` (TypeScript), v0.3.308 at research time, Node >= 18. Claude Code 2.1.308 is installed. |
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
    store/          SQLite (better-sqlite3): tabs, chats, routing log, action log, settings
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

## 7. Risks and open questions

- **Terms can change.** Re-check the legal page and the Agent SDK credit status before each milestone release.
- `/usage` report shape is experimental. Parse it defensively, and the meter hides itself if the data is missing.
- ~~Effort mid-session~~: works (M2).
- LibreHardwareMonitor needs admin rights. Without it: no fans, CPU temperature, or motherboard sensors (everything else still works).
- Plan limits depend on which plan you have.

## 8. Needed from the user

- ~~Which plan~~ → **Claude Pro** (answered 2026-10-22). The router is tuned for it (§5).
- Confirm Claude Code is logged in with that subscription (`claude` → `/status`).
- Before M1: install LibreHardwareMonitor and enable its web server on 127.0.0.1:8085. I'll give exact steps.
- On claude.ai → Settings → Usage, make sure "extra usage" is **off** if your plan has it.
