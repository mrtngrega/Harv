# Production-code slop

A smell only says where to look. The evidence chain (who reaches it, what a user observes, its independent reason) decides whether it goes.

## Fail-visible

Inside code the project itself controls, an unexpected failure should surface, loud and early, where it can be fixed. "Robust" code that swallows errors turns a bug into wrong results nobody notices. Investigate first:

- a broad catch (`catch (e) {}`, `except Exception`, `|| true`, `?? default`) around ordinary internal work;
- catch, log, rethrow, adding nothing;
- catch and fall back to another path when the new one throws;
- "try the new way, else the old way" with no version or protocol signal choosing between them;
- silent defaults when internal state is missing or malformed;
- the same validation repeated at every layer after the input was already checked at its boundary.

For each, ask: what exact failure is recoverable here, and what requires recovering from it (a user requirement, a protocol, cleanup of a resource, a stable error message to translate)? If the only answer is "to be safe" or "to keep an old test green", the handler goes and the failure shows. A narrow handler with a concrete job (closing a file, retrying a documented flaky network call, turning an internal error into the API's stated error) stays.

Keep checks at real boundaries: input from users, files, the network, other processes, other devices; permissions and safety gates; stored data being read back.

## Smells

| Smell | Signal | Check before deleting | Often legitimately kept | Simpler form |
|---|---|---|---|---|
| Repeated validation | the same null/type/shape check at several layers | where the real input boundary is, every direct caller | an API callable from outside, data reloaded from disk | validate once at the boundary |
| Fallback pile | default, legacy and "safe" paths for states nothing produces | config actually in use, supported environments | staged rollouts, mixed device versions | keep the real path, let bad state fail |
| Pass-through wrapper | a function that only forwards or renames | no policy, lifecycle, error translation or published name | a public facade, a transaction or resource boundary | call the real thing directly |
| Wrapper tower | adapter → adapter → equivalent object | follow the data end to end | a real protocol translation | collapse to the real boundary |
| Single-use helper | one private caller, short obvious body | dynamic registration, a name that carries domain meaning | callbacks, framework hooks, a real algorithm | inline it, delete its tests |
| One-implementation abstraction | interface/factory/strategy/registry with one real implementation | construction sites, plugins, platform variants | OS variants (Windows vs Linux), a real test seam | use the concrete code |
| Premature utility | a generic helper driven by flags and callbacks | do callers share meaning or only look alike? | one authoritative business or protocol rule | keep the obvious code local |
| Options nobody sets | settings, flags, parameters always given the same value | settings files, UI, docs, other devices | a documented user setting | fix the value, delete the plumbing |
| Duplicate implementation | near-identical copies grown over patches | semantics, callers and failure modes match | copies that evolve independently on purpose | keep one |
| Dead branch | no callers, impossible condition, value overwritten before use | reflection, exports, registries, CLI entry points, serialized names | framework hooks, routes, scheduled jobs | delete with its plumbing |
| Test-made reachability | only a test flips the flag or calls past the gate | an active config, request or stored value that reaches it | a current platform variant | delete branch and test |
| Compatibility residue | an alias, shim or old-format reader no one uses | release history, stored data, the other device's version | old stored files, rolling updates between devices | delete only with evidence support ended |
| Comment noise | comments narrating what the code plainly says | does it say *why* (a constraint, a workaround, a trade-off)? | the reason behind a non-obvious choice | delete the narration, keep the why |
| Type workarounds | cast chains, ignores, runtime type probes | the current types and toolchain | broken third-party types | state the real type |
| Stale docs | plan or README describing a removed path or a done fix as pending | current code and config | labelled history, future plans | fix the current claim, keep the history |

## Verification theater

A check adds value only when the checker knows something the producer didn't, or can fail differently. For each checksum, receipt, manifest, schema or "verify" step, ask:

1. Who produced the value, and who checks it?
2. What does the checker know that the producer didn't generate itself?
3. Is there a separate authority: a key, a published digest, a spec, an outside consumer?
4. Can they fail differently (a disk write and a read back, a network hop, another process)?
5. What happens on failure, and is that useful?

If producer and checker share inputs, logic and failure modes, it's circular: hash-then-immediately-verify in memory, computing a result twice the same way and calling it verified, a schema written by the producer only to validate its own output, signing with a key generated just for that. Remove the whole chain (the serialization added only for hashing, the digest field, the validator, their tests) when nothing independent uses it.

Keep: reading a written file back to catch truncation or corruption, digests checked against something published elsewhere, signatures from an outside party or a separately kept key, encryption and authentication of data that leaves the machine, idempotency and transaction records, anything another system or device consumes. A redundant check can sit inside a format that must stay: remove the check, keep the format and its meaning.

## Abstractions

Before keeping one, name the variation it holds **today**; "could support another implementation later" isn't one. Before deleting one, check for plugins, framework discovery, OS variants and published import paths. Don't replace a removed layer with a differently named one: a few repeated obvious lines read better than a shared layer that sends the reader across files.
