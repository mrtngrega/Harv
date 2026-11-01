---
name: deslop
description: Subtractive cleanup of code that grew over many fix-and-retry rounds. Use when asked to clean up, simplify, slim down or deslop code or tests, or after a big feature to review what it left behind.
---

# Deslop

Deslop deletes what accumulated while code was written and corrected again and again: tests that repeat each other, checks that can't fail, fallbacks that hide errors, layers nobody needs. It **never changes what the program does** for its users. It isn't a reformatter, a redesign or a rewrite: the result is the same behaviour in less code.

Say in a few words that you're using it ("using deslop"). The user isn't a programmer: the report says in plain words what goes, why it's safe, and what stays.

Two modes:

- **Audit** (the default, and always first): read-only. Map, gather evidence, report. Nothing is edited.
- **Apply**: only after the user said yes to the report (or to part of it), and only what they said yes to.

## 1. Scope and map

Read the project's CLAUDE.md (or AGENTS.md), its plan and conventions, and the checks it documents. Scope is what the user named; with none, the work since the branch point (`git merge-base`) including uncommitted files; "the whole project" when they say so (leave out generated, vendored and third-party code, lockfiles, migrations).

Map the scope: its modules and who calls them, the tests and what each one reaches, config, exports, entry points (CLI, routes, UI, scheduled jobs), docs that describe it. Run the project's checks once and note the result and the test count: that is the baseline.

## 2. Hunt, in this order

The first three are the target; the rest only when they belong to one of them or the evidence is direct. Details and signals for each are in the references; read the one a candidate belongs to before judging it.

1. **Test bloat** ([references/tests.md](references/tests.md)): near-identical tests added after each correction, tests of private helpers already covered through the public path, tests that check what their own setup put there, expected values computed by the code under test, weak checks (non-empty, type) next to a stronger one.
2. **Verification theater** ([references/code.md](references/code.md#verification-theater)): checksums, receipts, manifests, validators and re-computations where the checker knows nothing the producer didn't.
3. **Defensive and fallback bloat** ([references/code.md](references/code.md#fail-visible)): broad catches, catch-and-continue, "try the new way, else the old way", repeated validation inside trusted code, compatibility branches with no one left to be compatible with.
4. Then: dead code, single-use helpers and one-implementation abstractions, options nobody sets, duplicate copies of the same logic, comments that only repeat the code, docs that describe what's no longer there.

## 3. The evidence chain

Every candidate gets a chain, written down in the report:

`who reaches it today → the branch it runs → what a user can observe → the independent reason it exists (or none)`

An **independent reason** is one of: a current user requirement, a real caller outside the cluster, a public API or file format, a protocol or spec, a security or trust boundary, stored data, a resource limit, a numerical invariant. A test is no reason for the code it tests, and the code is no reason for its test: when code and tests only justify each other (a fallback that exists for its test, a test that exists for the fallback), that's a **closed loop**, and the whole loop goes together.

Prove reachability from something real: a config that's actually set, a request a user can make, a stored record, a command someone runs. A test flipping a flag doesn't make a branch live. And not finding a caller is missing evidence, not proof: callers can be outside the repo (a user typing a CLI command, another device, a phone).

Confidence decides what apply may do:

- **HIGH**: duplicate, can't fail, unreachable, or a closed loop, with the chain resolved. May go.
- **MEDIUM**: looks unneeded, but a caller, history or compatibility question is still open. Stays until the question is answered (ask the user, or check the history).
- **KEEP**: security, permissions, safety checks, concurrency, stored data and its formats, external protocols, supported old versions, resource limits, numerical checks. Stays unless direct evidence says it's obsolete.

Tested behaviour is not slop just because its test was redundant: deleting a duplicate test never licenses deleting the behaviour it covered. Keep one test for every distinct thing a user can observe (each success, each rejection, each error).

## 4. Report (audit ends here)

A list grouped into **clusters** (a piece of code with the tests, helpers and docs that exist only for it), each with: what and where, the evidence chain, confidence, what it removes (roughly how many lines), and the risk in a sentence. Then what you looked at and **kept**, and why: that's half the value. Then the open MEDIUM questions. Ask which clusters to apply.

## 5. Apply, one cluster at a time

For each approved cluster:

1. Delete the cluster whole: the code, the tests that only protected it, their fixtures and helpers, its docs. A fix replaces; it doesn't leave the old path behind as a fallback.
2. Add nothing new by default (no new helpers, layers, tests or dependencies). A new line is fine only when it keeps a real behaviour protected while more goes away; if a cleanup starts adding a lot, stop and rethink.
3. Run the narrowest checks that cover it. Green → commit, one commit per cluster, saying what went and why it was safe. Red → put the cluster back as it was, and report it as MEDIUM with what failed.

**Done when** every approved cluster is applied or put back, the project's full checks are green, and the test count is compared with the baseline: fewer tests is expected, but every drop is explained, and no surviving behaviour lost its last test.

Final report: what went (clusters, lines, tests), what was kept and why, what's still open, the checks you ran and their output.

---

The method is adapted from [deslop-GPT](https://github.com/MrZoyo/deslop-GPT) by MrZoyo (MIT, see `LICENSE-deslop-GPT.txt`).
