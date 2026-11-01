---
name: learn-from-session
description: Turn a session's lessons into lasting rules, memories and docs, by yourself. Use at the end of a session ("bye", the fresh routine, /fresh) and right after the user corrects how you work.
---

# Learn from the session

Every correction the user makes is a **lesson**: a way Harv should work from now on. The user doesn't want to approve lessons one by one: Harv picks them out, writes each one into the right place, and says afterwards what it learned. They can always say "undo that".

Say in a few words that you're using it ("using learn-from-session").

## 1. Find the lessons

Go through the session from the start (or since the last time this ran) and collect:

- **Corrections**: "no", "not like that", "I said…", "why did you…", work they had you redo, an action they stopped.
- **Rules they gave**: "always…", "from now on…", "I want Harv to…", a preference said once that clearly holds beyond today.
- **Confirmed approaches**: something they praised or accepted without changes that wasn't obvious ("yes, exactly like that, keep doing it").
- **Traps**: an error that took several tries to understand (a tool quirk, a path, a shell, a setting), and what finally worked.
- **Facts about the user or their setup** they told you (a new device, a changed account, a project's state).

A lesson must **change future behaviour** and **last**: a one-off wish for today's task, or something already written down, isn't one. Look at what's already in the target before writing: most lessons sharpen or correct an existing rule rather than add a new one.

**Done when** every correction and rule of the session is either written somewhere below or consciously dropped as one-off or already covered.

## 2. Put each one in its one right place

One home per lesson, never two (a rule in two places drifts apart):

| Lesson | Home |
|---|---|
| How Harv behaves in general (tone, asking vs doing, sending, safety habits) | `harv/persona.md` in the Harv repo: public, so the rule only, no names, places or personal facts |
| How development work is done in every project (testing, git, wrap-up, building) | `harv/dev-rules.md` in the Harv repo, same public rule |
| A personal fact or preference (their devices, accounts, people, tastes, a project's state) | Harv's memory, through the `remember` tool (update or `forget` an entry that's now wrong) |
| A project's convention, decision or gotcha | that project's `CLAUDE.md` (and its plan when a decision changed) |
| A trap of these computers (shells, paths, line endings, tools) | `harv/skills/diagnose/references/gotchas.md` in the Harv repo |
| How one of Harv's own skills should work | that skill's `harv/skills/<name>/SKILL.md` in the Harv repo |

Write it the way the file already reads: short, plain, the rule first and the reason after ("**Why:** …" in memory). Edit the existing rule when one covers the area: tighten it, fix it, or replace it when the user changed their mind; delete a rule the lesson proves wrong. Number new persona or dev rules after the last one.

## 3. Save and say what changed

- Repo files (persona, dev rules, skills, a project's CLAUDE.md): commit with a message that starts "Learned:" and push, like any finished work (in a project, as its git rules say).
- End with a short list in plain words, one line per lesson: what you learned and where you put it ("Learned: don't ask before restarting the notebook → persona rule 14"). Nothing learned → one line saying so.

Changing what Harv itself is (its code, its settings, its safety rules) isn't a lesson: tell the user what you noticed and leave it for them to decide.
