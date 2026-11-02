# Phase 5: test

Reads the flows in `clone/recon.md`. Writes `clone/test-plan.md` (template: [../templates/test-plan.md](../templates/test-plan.md)), `clone/bugs.md` (template: [../templates/bug.md](../templates/bug.md)) and end-to-end tests in the project's `e2e/`. Tests run against the clone only; the original is only ever used by hand, as a normal user.

## 1. The plan

For every flow F01, F02…:

- **Happy path**: the steps and what the user sees at the end.
- **Edge cases**, going down this list for each flow: empty input, very long input, emoji and Slovak diacritics, double click on save or submit, closing mid-flow, reopening after a restart, two windows at once, a big file, a broken or foreign file, no network, time zones, narrow window, keyboard only.
- **Negative cases**: a wrong value, a missing file, no permission, something deleted meanwhile.

Number every case: F01-H1, F01-E3, F01-N2.

## 2. Automate what you can

Playwright, one spec per flow, against the dev server with seed data. Selectors by role and label (`getByRole('button', { name: 'Save' })`), so they survive restyling. Every spec fails on a console error, on any 5xx response, and on an accessibility violation (`@axe-core/playwright`). Logic with rules gets Vitest unit tests. Install test tools in the project only (`npm i -D`), after saying what you're adding.

## 3. Click through the rest

What can't be automated (the desktop window, file dialogs, printing, the phone, things only seen over time) gets a pass with `ui-check` in the real target, a screenshot per step.

## 4. Bugs

Each reproduced bug goes in `clone/bugs.md`: an ID, a severity, exact steps, expected, actual, evidence. Severity: **S1** data lost or the core flow blocked; **S2** a feature broken with no way around it; **S3** broken with a way around it, or visibly wrong; **S4** cosmetic. A bug seen once and not reproduced goes on a separate "to check" list.

## 5. Fix loop

S1 and S2 first. Each fix: a failing test first, the fix, the test green and kept. The whole suite after each batch; the fixing commit noted in `bugs.md`.

**Done when** every flow has its numbered cases, the automated ones are green, no S1 is open, and `bugs.md` lists every reproduced bug with its status.
