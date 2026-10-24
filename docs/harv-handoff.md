# Hand-off: continuing Harv's development inside Harv

Paste the prompt below into a new Harv chat (pick **Opus** in the model switcher first). It switches the chat into the Harv project, so from the next message on it works like the Claude Code sessions that built Harv.

---

Let's work on Harv. Open the Harv project (C:\My files\Code\Harv), and from now on we develop Harv from inside Harv, exactly the way we did in the Claude Code dev sessions: same rules, same memory, same way of working. I'll do absolutely everything through you from now on: coding Harv and new projects, and everyday assistant stuff.

Where we are (2026-10-24): M0–M8 are built and pushed. Today we built, in order:
- File Explorer sorts newest first with Windows' date groups (folders and files mixed when sorting by date); CPU and GPU temps in the narrow stats panel; the background is half as blurry.
- Tools live inside each chat: "+" opens a plain chat, and the small ≡ menu at the right of the tab bar switches a chat between its log, File Explorer and Terminal.
- Tabs, tools, drafts and terminal output come back after a restart, like Chrome (~/.harv/ui.json, ~/.harv/terminals).
- Plan usage refreshes every 2 minutes while chatting, with warnings at the marks set in Settings.
- A much bigger Settings page (look, chat, stats panel, usage warnings, default folder, safety, startup, projects).
- A deep test pass (the testing method is in harv/dev-rules.md): layout no longer wraps at ~1100px, tabs shrink like Chrome's, stats rows never shift, Esc only stops you from the chat, and more.
- Project mode: in a project chat you run with Claude Code's own instructions and tools in the project folder, load its CLAUDE.md, and share Claude Code's memory for that folder; safety there is "trusted folder" (my choice). harv/dev-rules.md holds how I like project work done.
- `npm run harv`, `scripts/harv.ps1 start|stop|restart`, the desktop shortcuts, and Settings › Restart Harv.

How I want you to work (it's all in CLAUDE.md, harv/dev-rules.md and your memory; read them first):
- Read CLAUDE.md, docs/PLAN.md and your project memory, then tell me in a few lines where things stand and what's next.
- Propose a plan for anything bigger than a small fix and wait for my go; then build all of it yourself, verify it (tests, typecheck, lint, build, the UI checks in scripts/ui-check), commit and push, and report honestly what you did and checked.
- When I ask for a test pass: test everything from many angles (including window widths, many tabs, live panels), double-check every finding, give me one report, and fix only after my green light.
- Keep CLAUDE.md, docs/PLAN.md and your memory up to date, so nothing is lost between sessions.
- Watch my Claude Pro limits: check `node scripts/ui-check/usage.mjs` now and then and tell me at 75% and 90% of the session.
- You're running inside the Harv you're changing: never stop or restart Harv yourself. After server changes, commit and ask me to press Settings › Restart Harv; web changes show up on their own.
- When I say bye or that we're done for today, do the full wrap-up (checks, docs, commit + push, memory, a resume phrase), but don't stop the servers.

Start by opening the project and telling me where we ended.
