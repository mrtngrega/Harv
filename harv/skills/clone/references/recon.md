# Phase 1: recon

Map the original so well that nothing in the build is a surprise. A thin recon means a clone with holes; take the time here. Write as you go into `clone/recon.md` (template: [../templates/recon.md](../templates/recon.md)) and `clone/features.csv` (template: [../templates/features.csv](../templates/features.csv)). Reference screenshots go in `clone/screens/` (for comparing, never shipped).

## 1. Sources

A table first, a URL on every row, in this order of value:

| source | gives |
| --- | --- |
| help centre / docs | the fullest feature list there is, and every setting |
| the user's own use | the real thing in every state: ask them to show a screen, or take screenshots on their computer while they drive |
| public API docs | the data model, almost free |
| pricing page | which features matter (they're the ones gated) |
| changelog / release notes | what's recent, what the makers think matters |
| store listing | screenshots of the key screens, the pitch, complaints in reviews |
| walkthrough videos | real flows click by click (`video` skill: transcript with timestamps) |
| marketing site | the core loop in the makers' words |

Search with WebSearch, read with WebFetch or Harv's browser, one page at a time. For a desktop app on the user's PC (Word, a game launcher…), their own screen is the best source: screenshots of each screen and menu.

## 2. Core loop

One sentence: the thing people use the app for. The clone's first milestone is this loop.

## 3. Screens

One row per screen, stable IDs S01, S02… that every later file refers to: `ID | screen | how you get there | purpose | key components | states seen`. States: empty, loading, filled, error, no permission, very long content, narrow window, dark mode. An empty state you didn't record is one you won't build.

## 4. Flows

F01, F02…, each a goal and the screens it passes, the clicks on the happy path (the number to beat), and its edge cases:

```
F01 Write and save a letter
    S01 start -> S02 editor -> S05 save dialog
    happy path: 4 clicks
    edge: unsaved changes on close, file already exists, very long document, paste from a web page
```

## 5. Components

Every repeated UI part (buttons, inputs, menus, dialogs, toolbars, lists, tabs, toasts): variants, states, which screens use it. Phase 3 builds these.

## 6. Data model and file formats

Entities, fields and links, each with its evidence and a confidence (high / medium / guess):

```
Document  title, body (rich text), created, modified, page settings (size, margins)
          evidence: S02 toolbar, S07 page setup, help "Change margins"
          confidence: high
```

File formats the user cares about (open and save `.docx`, export PDF): find the open libraries that read and write them now, their licence and how complete they are; a format with no good open library is a hard part.

## 7. Feature matrix

`clone/features.csv`: `feature, area, priority, original, clone, notes`. Priority must / should / could, judged by what the user will actually use. `clone` starts at `no` on every row. Things that can't or shouldn't be rebuilt get `skip` with the reason: licensed content (fonts, stock libraries, templates they sell), the network and its users, the original's cloud and partner deals, regulated parts.

## 8. Size and hard parts

Counts (screens, flows, entities) and the hard parts: rich text editing, real-time collaboration, sync between devices, file format fidelity, offline, search, big data. A size: S (a weekend), M (a few weeks), L (a quarter), XL (cut the scope).

**Done when** every source has a URL, every screen its states, every flow its clicks and edge cases, every entity a confidence, every feature a priority, and the out-of-scope list is written. Then a five-line summary for the user: the core loop, screen and flow counts, the three hardest parts, what's out of scope, the size.
