---
name: diagnose
description: Find and fix the root cause of anything broken. Use when code, a test, a build or an app fails, throws, crashes, hangs or is slow, when the computer misbehaves, or when a first fix didn't work — before proposing any fix.
---

# Diagnose

The whole skill is one idea: **no fix without a red loop**. A _loop_ is one command (or one short set of steps) that shows the bug happening. It is _red_ while the bug is there and turns _green_ once it's fixed. With a _tight_ loop (seconds, same verdict every run, you can run it yourself) the cause falls out; without one, every fix is a guess.

Say in a few words that you're using it ("using diagnose"), then work through the steps in order. Tell the user what you're on now and then (a short line, not a lecture). The user isn't a programmer: explain causes and fixes in plain words.

What kind of problem is it?

- **Code** (a project, a script, a test, a build): the steps below as written.
- **The computer or an app** (slow PC, a program that crashes, Wi-Fi drops, a device not found): the same steps, with a measurement or a log as the loop. Read [references/computer.md](references/computer.md) first.

## 1. Build the loop

Read the whole error first: every line of the message and stack trace, the exit code, the logs around it. Then check what changed recently (`git log`, `git diff`, new packages, updates, config).

Then make the loop, cheapest that reaches the bug first:

1. A failing test at the seam where the bug lives (`tdd` for writing it well).
2. A command against the running thing: `curl`, a CLI call with fixed input, a script that calls the function.
3. A script that drives the UI (Playwright, or the project's own UI checks) and checks what's on screen.
4. A captured input replayed: save the real request, file or event that triggers it, feed it in again.
5. `git bisect run <loop>` when it worked at some earlier commit.
6. For a flaky bug: run the trigger 50–100 times, add load, narrow the timing, until it fails often enough to work with.
7. Last: only the user can trigger it (their hardware, their account, a button only they see). Ask them with exact numbered steps and exactly what to report back, then treat their answer as the loop's verdict.

Tighten it before going on: faster (skip unrelated setup), sharper (check the user's exact symptom, not "didn't crash"), deterministic (fixed time, seed, temp folder).

**Done when** you have run the loop at least once, shown its command and output, and it goes red on _the user's_ symptom (not a nearby different failure). If no loop is possible, say so plainly, list what you tried, and ask for the one thing that would make one (access, a log, a screen recording, a test device).

## 2. Shrink it

Cut the case down one piece at a time (inputs, steps, config, data), running the loop after each cut. Keep only what makes it go red. **Done when** removing any remaining piece turns it green. A small case leaves fewer suspects.

## 3. Hypotheses

Write 3–5 ranked hypotheses before testing any. Each one says what it predicts: "If X is the cause, then changing Y makes it go green." A hypothesis without a prediction is a hunch: sharpen it or drop it. Show the list to the user in a sentence or two when they're around (they may know "I updated that yesterday"); carry on with your ranking either way.

Compare with something that works: a similar code path that works, the version before, the other computer. List every difference, however small.

## 4. Test them, one variable at a time

Each probe tests one prediction. Prefer a debugger or a REPL; otherwise a few logs at the boundary between the suspects, each tagged with one prefix like `[DBG-7f3a]` so cleanup is one search. For slowness, measure first (a timing, a profile), then cut.

Trace a bad value backwards: where did it come from, what passed it in, what passed _that_ in, until you reach where it first went wrong. The **root cause** is there, not where the error shows up.

**Three strikes:** after three hypotheses or fixes that didn't hold, stop guessing. Go back to the loop's evidence and question the design itself (is this approach sound?); tell the user what you've learned and what you suggest before trying a fourth.

## 5. Fix it

1. Turn the shrunk case into a regression test at a seam that runs the real bug path, and watch it fail. If no honest seam exists (the test would pass even with the bug), say so: that's a finding, not a reason to fake one.
2. Fix the root cause with the smallest change that does it. One change, no extras on the side. A fix replaces the wrong behaviour; it doesn't wrap it in a fallback that hides the next failure.
3. Watch the test go green, then run the original loop (the full, un-shrunk case): it must be green too.
4. Look for the same bug elsewhere: the same pattern, a copy of the code, the other operating system.

## 6. Prove it and clean up

**Done when** all of these hold, each shown with fresh output from this session:

- The original loop is green, and so are the project's checks (tests, typecheck, lint, build: whatever it documents). An old run, "should work" or a passing lint for a compile problem don't count.
- For anything the user sees, checked where they use it (the app, not only a browser tab; their computer, not only a test).
- Every `[DBG-…]` log removed (search the prefix), throwaway scripts deleted.
- The cause written down: one line in the commit message, and when it's a trap others can fall into, a line in the project's docs (its CLAUDE.md gotchas). Known traps on these computers are in [references/gotchas.md](references/gotchas.md); read it when the bug smells of the environment (paths, line endings, shells, ports, file watchers, permissions). Add a new trap to its source, `harv/skills/diagnose/references/gotchas.md` in the Harv repo (the copy in `~/.claude/skills` is replaced whenever Harv starts).

Report in plain words: what was wrong, why, what changed, and how you proved it. If something is still unproven, say which part.

---

Built from [superpowers](https://github.com/obra/superpowers)' systematic-debugging and verification-before-completion by Jesse Vincent, and [mattpocock/skills](https://github.com/mattpocock/skills)' diagnosing-bugs by Matt Pocock (both MIT, see the `LICENSE-*.txt` files).
