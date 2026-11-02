# Phase 4: build

Reads `clone/recon.md`, `clone/plan.md` and `clone/design/`. Updates `clone/features.csv` (the `clone` column) and `clone/build-log.md`, milestone by milestone in the plan's order.

Every line is written here from the recon and the specs: the screenshots show layout and hierarchy, the help pages show behaviour, and the code, words and pictures are the clone's own. Components use tokens only; a missing value becomes a new token.

## 1. The shell

Routes or windows for every screen (stubs are fine), the layout (navigation, toolbar, sidebar), the tokens and primitives wired in, and seed data so screens show something real. Commit.

## 2. The vertical slice

The core loop end to end before anything else, plain and working. If storage isn't decided yet, a fake data layer with the real function signatures, so swapping it changes no screen code. Show the user: this is the first thing they can try.

## 3. Screen by screen

For each screen of the milestone:

1. Its recon row: purpose, components, states, the flows through it.
2. The reference screenshot, for layout and hierarchy.
3. Build it with the primitives and real data; `tdd` for logic with rules (file formats, calculations, undo, sync).
4. Every state: empty, loading, filled, error, no permission, very long content, narrow window.
5. Semantic HTML, labels on inputs, all of it reachable by keyboard, visible focus, alt text.
6. Its rows in `features.csv` set to `yes` or `partial` (with a note).
7. A screenshot at the reference's size into `clone/clone-screens/S07.png` for phase 6.
8. One commit per screen: `build: S07 page setup`.

## Definition of done, per screen

- [ ] every state from the recon, plus empty, loading and error
- [ ] works at phone width and wide, and in the real target (`ui-check`: the Tauri window, the phone)
- [ ] the flow can be finished with the keyboard alone
- [ ] no console errors; typecheck, lint and tests green
- [ ] every word on it written fresh
- [ ] `features.csv` updated, screenshot saved

## The build log

`clone/build-log.md`: one line per screen (ID, date, done or partial, what's missing, what was harder than it looked) and, at every stop, a handoff: where you are, the next step. When a feature turns out bigger than it looked, say so in the log and to the user rather than shipping half of it quietly.

**Done when** the milestone's screens all meet the definition of done and the milestone is committed and pushed. Then phase 5.
