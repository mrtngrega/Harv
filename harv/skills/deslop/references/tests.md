# Test bloat

Tests are code too, and they pile up fastest: every correction tends to add a near-copy of the last test. The goal is the **smallest set of tests that still catches every distinct way the behaviour can break**, not a target count. Test count and coverage are no reason to keep or add anything.

## Start with the oracle

For each test ask: where did the expected value come from?

- **Independent**: a spec, a known example, a real caller's data, a protocol fixture, a value worked out by hand. A real test.
- **From the implementation**: the same helper, the same algorithm under another name, a value printed by the code and pasted in, what the mock was told to return. It tests nothing: delete it, merge it, or find a real oracle.

## Map before deleting

For a suite of any size, map each test (working notes in the report, not a file in the repo):

| test | who uses this behaviour | branch it reaches | what it observes | oracle | how it can fail | a stronger test covering the same |
|---|---|---|---|---|---|---|

One test **dominates** another only when it covers the same branch, the same observable result and the same way of failing, with an equal or better oracle. A big end-to-end test doesn't automatically dominate a focused one (a known numeric example, a corrupted-file test, a rejected input).

## What to look for

| Pattern | Signal | Keep when | Do |
|---|---|---|---|
| Duplicate tests | same input path and outcome, no new way to fail | each guards a different contract or a real past bug | keep the clearest one |
| Correction pile-up | a near-copy added after each small fix | each fix was a different visible bug | keep one per distinct bug |
| Permutation bloat | values vary but reach the same branch and result | the value is a real boundary (0, max, empty, unicode) | keep representative cases |
| Weak next to strong | not-null / type / length checks beside an exact-value check | the presence or count itself is the contract | delete the weak check |
| Private-helper test | a helper extracted and tested, already covered through the public path | the helper is a stable algorithm of its own | test through the public path, or delete with the helper |
| Implementation detail | private state, call order, call counts, exact temporary objects | order or count is the contract (protocol, retries, billing, locks) | assert what a caller sees |
| Mock checks mock | the mock sets the answer, the test checks that answer | the interaction with an unreachable system is the contract | fewer mocks, assert the boundary |
| Setup proves itself | the fixture creates the state the test asserts, no product code runs | — | delete |
| Snapshot bloat | a huge snapshot hiding one meaningful field | the rendered output itself is what's reviewed | assert the fields that matter |
| Support-machinery test | exists only for a fallback, validator, checksum or retry that's itself slop | that machinery has a real reason of its own | delete with the machinery |
| Obsolete behaviour | the test asserts what the current requirement or docs replaced | someone still depends on the old behaviour | replace with the current contract |
| Untracked inputs | reads a local `outputs/` folder or a one-off file not in the repo | the input is managed or created by the test | delete or make it self-contained |
| Writes to tracked files | a test run changes files in the repo | — | write to a temp folder |

## Keep or delete: the questions

1. What distinct behaviour or real past bug does it guard?
2. Would it fail if that behaviour broke?
3. Is its expected value independent of the code?
4. Does a stronger test already cover it?
5. Would a harmless refactor break it while behaviour stayed the same? (Then it tests the implementation.)

Keep separate tests for different outcomes and failure kinds: success vs rejection vs error, security, stored data, concurrency, supported old versions, limits, numerical results, real past bugs.

## Wiring between layers

Unit tests of a producer, a reader and a consumer can all pass while the path through all three is broken. Before deleting a fixture or test that crosses layers, make sure one small end-to-end test still runs the real path (producer → reader → consumer) for each way it's delivered today.

## Adding tests during cleanup

Not the default. Only when the cleanup would leave a real, user-visible behaviour with no test at all, a real regression would fail the new test, and its expected value has an independent source. Prefer adapting a surviving test.

## Running the suite

Count the tests before and after, and look at skips and deselections: a smaller total can hide tests that silently stopped running. For suites that generate files, compare `git status` before and after the run.
