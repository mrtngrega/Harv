# Phase 2: scope and plan

Reads `clone/recon.md` and `clone/features.csv`. Writes `clone/plan.md` (template: [../templates/plan.md](../templates/plan.md)). No recon map yet: go back to phase 1; a plan from memory of an app misses half of it.

## 1. Scope with the user

A few sharp questions, a couple at a time, each with your recommended answer so they can just say yes:

- **The first version**: which must-haves, in their words ("write, format and save letters as .docx; no comments or track changes yet").
- **The target**: a web app in the browser, a desktop app (Tauri, like Harv), a phone app (a PWA on the Home Screen), or several. Default to where they'd use the original.
- **Their data**: local only, or synced between their devices (Harv's PC and notebook)? Default local; sync is a hard part.
- **The name**: their own, never the original's or one that sounds like it.

Mark the agreed features in `features.csv` (must for v1, the rest should/could).

## 2. Stack

Harv's own stack unless the user already has one, because it's known, free and runs offline:

| layer | default | when else |
| --- | --- | --- |
| app | TypeScript, React, Vite, Tailwind | |
| desktop | Tauri 2 around the web app | Electron only for a library that needs Node in the window |
| phone | the web app as a PWA | |
| data | local: SQLite (`node:sqlite`, Tauri's SQL plugin) or IndexedDB in the browser; files on disk for documents | a server only when several people share data |
| server, if needed | Node + Fastify | |
| tests | Vitest, Playwright | |

Then the open-source parts that carry the hard work (a Word-like app: TipTap or ProseMirror for editing, `docx` / `mammoth` for the format; a calendar: a date library with time zones). For each: what it does, its licence (MIT / Apache / BSD welcome; GPL only with the user's OK, since it binds the clone), how alive it is (last release, stars), checked with `find-docs`. One line of why per choice. One app, one database.

## 3. Data

Turn the inferred model into real tables or file shapes: ids, created/modified times, links with what happens on delete, indexes for what's searched or sorted, enums for statuses, times in UTC, money in whole cents. Write the constraints the recon found (two edits to the same thing at once, a name that must be unique) as data rules, not UI hopes.

## 4. The parts that bite

A line on each that applies: file format fidelity, undo/redo, big documents, time zones, offline and sync conflicts, search, keyboard shortcuts across Windows and Linux, printing, accessibility.

## 5. Milestones

1. **Vertical slice**: the core loop end to end, plain: open it, do the one thing, see the result.
2. The rest of v1's must-haves, by area.
3. Should-haves, then could-haves.

Each milestone names its screens (S-IDs), data and features, and ends in something the user can see and try.

**Done when** `clone/plan.md` has the scope, the stack with a reason per line, the data, the parts that bite and the milestones, and the user has said yes to it. Then `start_project` (private or public: ask), and phase 3.
