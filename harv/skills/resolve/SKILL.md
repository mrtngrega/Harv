---
name: resolve
description: Work inside DaVinci Resolve (free or Studio) through its scripting API: projects, timelines, cuts, color and LUTs, Fusion titles and effects, subtitles, markers, renders. Use when the user wants anything done in DaVinci Resolve or one of their Resolve projects.
---

# Resolve

Harv works in DaVinci Resolve through a small **bridge**: a Lua script running inside Resolve's Console that runs the Lua Harv sends and returns the result. It works in the free version, where Resolve 21.1 allows no outside scripts and no Scripts-menu scripts, but its Console still runs Lua with the whole scripting API. Harv sees what the user sees in Resolve: the same open project, live.

Say in a few words that you're using it ("using resolve"). `<this skill>` is the folder this file is in (`~/.claude/skills/resolve`).

**Only free Resolve 21.1 (21.1.0) works, and Studio.** From 21.1.1 on, the free version's Console Lua lost `dofile`, `io` and `ffi`: the bridge can neither load nor answer (checked on 21.1.2 and 21.2, 2026-11-05). So never install or accept a Resolve update for the user, and when `start` fails on a newer version, say this plainly: going back to 21.1 (Blackmagic's support page lists it) or Studio are the ways back.

## 1. Connect

`node <this skill>/scripts/resolve.mjs start`

- It starts Resolve if it's closed, opens the Console (F6) and types the bridge's start line there (one keystroke burst in Resolve's window; tell the user it's you). **Done when** it prints `bridge: running`.
- `Resolve shows its Project Manager`: no project is open and the Console exists only inside one. Ask the user which project (or let them open it), then `start` again.
- On Linux (Fedora KDE, Resolve in the `davincibox` container) it does the same through KWin and a virtual keyboard. There Resolve can't read phone video or write MP4 itself: convert with ffmpeg on the way in and out (the reference's Linux section).
- `status` says whether the bridge runs; `stop` ends it. It also ends by itself after 2 hours without requests, and keeps running when a project is switched (`pm:LoadProject(name)`).

## 2. Look before you change

Read the state first: `node <this skill>/scripts/resolve.mjs run <file.lua>` (or `run -e "<lua>"` for one line). Write request files in `~/.harv/workspace/resolve/`. Inside a request these names are ready: `resolve`, `pm` (project manager), `project`, `timeline` (the current one), `mediaPool`; `return` a value (tables come back as JSON, Resolve objects as `"<…>"` strings) and `print` goes to `output`. Lua 5.1 syntax: methods with `:`, lists 1-based, settings as `{ Key = value }`.

Get the project, the timeline, its tracks and clips (names, start frames, durations), the frame rate and resolution: whatever the task touches. Times on the API are **frames** counted from the timeline's start (`timeline:GetStartFrame()`, usually 01:00:00:00).

## 3. Do the work

The API, with what's tested on free 21.1 and the traps: [references/api.md](references/api.md). Read it before your first change in a chat; it also says where Resolve's own full reference lies (grep that for a call's exact name instead of guessing). Check visual work by eye: export the frame as a still and read it.

The user's projects are their work, so:

- Before changing a timeline, duplicate it (`timeline:DuplicateTimeline(name .. " (before Harv)")`) and work on the original; the copy is the undo. Tell the user it's there.
- Delete projects, timelines, clips or files only when the user asked for that exact deletion.
- Render to a new file name; a render never overwrites an existing file.
- One small request at a time, each checked, beats one long script: a failure then says which step failed.

**Done when** a read-back request shows the change in Resolve (the clip's grade, the subtitle items, the render job `Complete` and its file on disk), not when a call returned `true`.

## 4. When Resolve stops answering

- Calls suddenly return nothing (`nil`, missing keys) while the bridge runs: a dialog in Resolve is blocking, most often **"You have reached a limitation"** (a Studio-only feature was asked for in the free version). Take a screenshot of the screen and tell the user; they click **Not Yet**. Then use a free route (see the Studio list in the reference).
- `DaVinci Resolve closed or crashed`: say so, check the last request for a known crash pattern (reference), and restart with `start` once the user agrees; Resolve's own crash recovery may ask about the project.
- No answer within the timeout while Resolve runs: the request is still going (a long import or render). `status` shows `busy`; wait, then ask again.

Report in plain words what changed in which project and timeline, where the "(before Harv)" copy and any render are, and anything that needs Studio.
