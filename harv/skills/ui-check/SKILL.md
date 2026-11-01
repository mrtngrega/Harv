---
name: ui-check
description: Check a user interface the way its user meets it, in the real app at real sizes. Use when testing, reviewing or verifying a screen, page, app or design, after a UI change, and when the user says something looks off.
---

# UI check

A UI is only checked **where its user meets it**: the desktop app they open, the phone they hold, the browser they use. A screenshot of a dev page in another browser is a hint, not a check. And a UI is checked **over time and across sizes**: values tick, windows resize, tabs pile up, a reload happens. Most UI bugs live there, not in the first still frame.

Say in a few words that you're using it ("using ui-check").

Which kind of check is it?

- **Your own change** (you just built or fixed something): check it, fix what's wrong, check again. Report what you saw, with screenshots.
- **A test pass the user asked for**: check everything in scope and **report first**. List the verified findings (what, where, how to reproduce, how bad) and wait for their go before fixing anything.

## 1. Get the real thing in front of you

Find out where the user uses it (ask once if unclear) and drive that: a desktop app over its debugging port, a phone layout by device emulation or the real phone, the browser they use. How to drive and capture each is in [references/drive.md](references/drive.md); for Harv's own app read [references/harv.md](references/harv.md).

**Done when** you have a screenshot from the real target, looked at it, and it shows the current code (a fresh build, a reload; not an old window).

## 2. Run the matrix

For every screen in scope, look at each of these, and **look** at every screenshot (open it, don't just save it):

- **Sizes**: phone (~420 px), small laptop (~1100), laptop (~1280), wide (1500+), and the zoom levels the app offers. Nothing cut off, overlapping or sideways-scrolling; columns shrink or stack on purpose.
- **Amounts**: empty, one, many (20+ tabs, long lists, a long chat), very long text (names, paths, one unbroken word), odd text (emoji, Slovak diacritics, right-to-left).
- **States**: loading, error, offline or server down, disabled, a dialog or menu open over it, the first start and a restart (what comes back), a page reload.
- **Over time**: live parts (stats, timers, streaming text) watched 30–60 s for layout shifts, jumping numbers, flicker or creeping scroll position.
- **Input**: keyboard only (Tab order, Enter, Esc, shortcuts), focus where expected after each action, drag and drop, right-click, double-click.
- **Look**: hierarchy, spacing, alignment, contrast, type, consistency with the rest of the app, motion and the motion-off setting, light and dark where it has both. impeccable's critique and audit give the words for what's off.
- **Both systems** when the app runs on several (Windows and Linux render fonts, blur and scrollbars differently).

**Done when** every screen in scope has been seen at every size and state above that applies, and each finding has been reproduced a second time (a finding you saw once is a guess).

## 3. Report or fix

- A finding is: what's wrong, where (screen, size, state), how to reproduce it, a screenshot, and how bad (broken / annoying / cosmetic).
- Your own change: fix each finding at its cause (`diagnose` when it isn't obvious), then re-run the part of the matrix it touched.
- A test pass: the list, grouped by severity, then wait.

Close what the check opened (test tabs, test chats, emulation overrides) so the user's layout is as they left it.
