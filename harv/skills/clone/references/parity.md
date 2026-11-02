# Phase 6: parity

How much of the original the clone does, and what to build next. **Parity means it does the same job**, not that it looks the same: the clone's look is its own on purpose.

Two scripts in this skill's `scripts/` folder, standard-library Python (`python` on Windows, `python3` on Linux; `<this skill>` is `~/.claude/skills/clone`):

```
python <this skill>/scripts/parity.py clone/features.csv
python <this skill>/scripts/imgdiff.py clone/screens/S07.png clone/clone-screens/S07.png --out clone/diffs/S07.png
python <this skill>/scripts/imgdiff.py clone/screens/S07.png clone/clone-screens/S07.png --json > clone/diffs/S07.json
python <this skill>/scripts/parity.py clone/features.csv --visual clone/diffs/*.json --markdown > clone/parity.md
```

## 1. Feature parity

Every row of `features.csv` current: `yes`, `partial` (with a note), `no`, or `skip` (with a reason). `parity.py` weighs must 3, should 2, could 1, counts partial as half, leaves out `skip` rows and features the original doesn't have, and prints the score, must-haves done of total, each area weakest first, and the missing list in build order.

## 2. Layout

Screenshots of the original and the clone at the same size and in the same state (same data shape, same panel open). `imgdiff.py` compares edge maps on a grid, so colours and the clone's own look don't count against it: it scores where things are (90+ matches, 75+ close, 50+ partly), lists the regions that differ biggest first, and notes a big height difference. `--mode pixel` is for the clone against its own older screenshots (regressions), not against the original.

## 3. Behaviour

Walk each flow in both and compare what the scores can't see: clicks to finish the core flow, what happens on errors, what's remembered between uses, how big files feel. Fewer clicks than the original is a win. Each difference: flow, original does, clone does, fix or keep.

## 4. The verdict

`clone/parity.md`: overall score, feature score, layout score per screen, the missing features in build order, the behaviour differences, and one of:

- **not ready**: a v1 must-have missing, or an open S1 bug
- **ready to use**: v1's must-haves done, no open S1 or S2
- **better than the original for the user**: ready, plus something the original gets wrong for them done right (fewer clicks, offline, no ads, their own workflow)

Give the honest number: a clone at 62% is at 62%.

**Done when** `clone/parity.md` is written and the user has the score, screenshots side by side, and the top five things to build next. Then the next milestone (phase 4).
