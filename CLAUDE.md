# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Harv is a personal AI assistant in the spirit of Jarvis, with a local web dashboard. **`docs/PLAN.md` is the source of truth** for the architecture, milestones (M0–M9), the research findings (Agent SDK, usage meter, hardware sensors), and the open risks. Read it before starting any milestone, and update it when decisions change.

Stack: TypeScript everywhere, using npm workspaces. `apps/server` runs Node 24 with Fastify, ws, `@anthropic-ai/claude-agent-sdk`, systeminformation, nvidia-smi, LibreHardwareMonitor and SQLite. `apps/web` is React, Vite and Tailwind. `apps/desktop` (Tauri 2) comes later.

The user's hardware: Ryzen 7 5700X3D (8 cores / 16 threads), RTX 3060 Ti 8 GB, 32 GB RAM, Windows 11.

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

## Terms

- Use Harv only within Anthropic's terms for personal use: never host or share it, never read or store Claude credentials, keep the Claude Code binary unmodified, and brand it "Harv", never "Claude Code". See `docs/PLAN.md` §1.

## Commands

None yet; they get added in M0. Add build, run, lint and test commands here, including how to run a single test.

## Harv's safety model (agreed with the user; tweak as we go)

Every action Harv takes goes through a permission gate, implemented with Agent SDK hooks rather than prompt instructions, so it can't be skipped. There are four levels:

- **Green (run immediately):** read stats or files, web search, open apps, create files inside Harv's own workspace.
- **Yellow (back up, run, verify):** edit, move or rename user files. Back up first to `~/.harv/backups/<timestamp>/`, log the action, and offer Undo.
- **Red (confirm first):** delete, install or uninstall, kill processes, run scripts, change system settings or the registry, send messages or email, `git push`. The flow: safety check (an exact preview of the impact plus a protected-path check), then backup, then a confirmation card in the dashboard (Approve, Deny, or edit), then run, then verify, then log.
- **Blocked:** formatting drives, writing to `C:\Windows`, disabling antivirus or the firewall, reading stored credentials. Only the user can unblock these, in settings.

Always on: a stop button with a hotkey that cancels the current action, user-defined read-only protected folders, and a full action log.
