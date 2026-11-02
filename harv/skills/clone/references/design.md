# Phase 3: design

Reads `clone/recon.md` and `clone/screens/`. Writes `clone/design/tokens.json` (template: [../templates/tokens.json](../templates/tokens.json)), the CSS variables and Tailwind theme made from it, and `clone/design/components.md`. Use `impeccable` for the judgement calls (hierarchy, spacing, type).

## What you rebuild

The **system**: colour roles, type scale, spacing, radius, the way a dialog or a menu behaves. People expect those, and nobody owns them. The look itself is the clone's own: its own accent colour, an open font with the same job as the original's, an open icon set, its own logo made for its own name. The original's signature colour plus its signature layout is its identity; give the clone a different one (the user may have a favourite colour in Harv's memory).

## 1. Measure

From the screenshots, as roles, not hex values: bg, surface, border, input border, text, muted text, accent, text on accent, danger, success, warning. Count the greys the app really uses (usually 5–7). The type scale (sizes, line heights, weights), the spacing base (almost always 4 or 8), two or three radii and shadows, the layout (content width, sidebar, toolbar and header heights).

## 2. Tokens

Fill `tokens.json` with the clone's own values for those roles, plus a `pairs` list of every text-on-background combination used. Then:

```
python <this skill>/scripts/contrast.py clone/design/tokens.json   (<this skill> = ~/.claude/skills/clone; python3 on Linux)
```

It checks WCAG AA (4.5:1 body text, 3:1 large text, input borders and focus rings) and exits 1 on a failure: fix the token, never one component. Generate the CSS variables and Tailwind theme from the tokens so components say `bg-surface text-muted`, never a raw hex value.

## 3. Components

One block per component from the recon list in `components.md`: variants, sizes, states (default, hover, active, focus-visible, disabled, loading, error, empty), the tokens it uses, keyboard and screen reader behaviour, the screens that use it.

## 4. Primitives

Build them once on a `/design` page (or a Storybook) before any screen, on an accessible base where the stack has one (Radix, React Aria). Screenshot the page and look at it: that's the design check.

**Done when** `contrast.py` reports zero failures and the primitives page is screenshotted, looked at and committed.
