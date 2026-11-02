---
name: clone
description: Build the user's own version of an existing app from what it does, clean room. Use when the user wants their own version of an app ("make my own Word", "clone X", "reverse engineer X"), asks how an app works in order to rebuild it, or wants a clone checked against its original.
---

# Clone

The user names an app; you build **their own version of it**: same job, same flows, their own code, name and look, for their personal use. It is a **clean room** rebuild: you study what the app does and how a person moves through it, then write every line fresh.

Say in a few words that you're using it ("using clone").

## The clean room

- **Sources**: public pages (help centre, docs, changelog, pricing, store listing, walkthrough videos, public API docs) and the user's own use of the app on their own computer or account. Read at human speed, page by page.
- **What you take**: features, flows, the shape of the screens, the kind of data. **What you make yourself**: all code, every label and sentence, the name, the logo, icons (an open set such as Lucide), illustrations, colours. Open fonts only (IBM Plex, Inter, Source Serif…).
- **The app's insides stay closed**: its code, bundles, binaries and private network calls are out of bounds, and so is anything behind someone else's login or a paywall. When you're stuck on how something behaves, use the app as a user again or read its help.
- **Personal use**: the clone is for the user, never sold or published under anything that suggests the original. If the user's account terms forbid building a competing product with it, say so and work from public sources only.
- **Free tools only** (Harv's rule): open-source libraries, local storage, no paid services or API keys. Where the original leans on a paid cloud (sync, AI, payments), the clone does it locally, leaves it out, or asks the user.

## The phases

Everything lives in the project's `clone/` folder; each phase reads what the last one wrote. Read the phase's reference file when you start the phase, not before.

1. **Recon**: map the original. → [references/recon.md](references/recon.md)
   Done when `clone/recon.md` has every source with a URL, every screen with its states, every flow, the data model with confidence marks, and `clone/features.csv` has every feature with a priority and the out-of-scope list.
2. **Scope and plan**: agree the first version with the user, then the stack, data and milestones. → [references/plan.md](references/plan.md)
   Done when the user has said yes to the scope (which features, which target: web, desktop, phone) **and** to `clone/plan.md`. This is the one stop where you wait: the build starts on their "go".
3. **Design**: the clone's own look as tokens and components. → [references/design.md](references/design.md)
   Done when `clone/design/tokens.json` passes `contrast.py` with zero failures and the primitives render on one page you have screenshotted and looked at.
4. **Build**: milestone by milestone, vertical slice first. → [references/build.md](references/build.md)
   Done per milestone when its screens meet the definition of done there, `features.csv` is updated, the checks pass and it's committed.
5. **Test**: every flow, happy path and edge cases. → [references/test.md](references/test.md)
   Done when every flow has a numbered case list, the automated ones run green, and every reproduced bug is in `clone/bugs.md` with a severity.
6. **Parity**: how close it is and what's next. → [references/parity.md](references/parity.md)
   Done when `clone/parity.md` has the scores, the missing list in build order and a plain verdict.

Then show the user: what works, the parity score, screenshots, and the top five next features. Phases 4–6 repeat for each milestone.

## Working with the user

- They're the user of the clone, not a developer: ask about what they want to *do* with it, never about code. Use `grilling` style sharp questions in phase 2, a few at a time.
- A project of its own: start it with `start_project` (ask private or public first), then work in that folder.
- Size it honestly in phase 2 (a weekend, a few weeks, a quarter) and say what a clone can't have: licensed content, the original's network of users, its partner deals, its cloud.
- Plan usage is tight (Pro): recon reads many pages, and a build is many turns. Say up front roughly how big each phase is, and save a handoff in `clone/build-log.md` at every stop so the next session picks up.

## Your other skills on the way

`video` for walkthrough videos in recon; `grilling` for scope; `impeccable` for the look; `tdd` for logic with rules (formats, calculations, sync); `ui-check` for every screen in the real target; `diagnose` when something breaks; `find-docs` for the libraries you pick.
