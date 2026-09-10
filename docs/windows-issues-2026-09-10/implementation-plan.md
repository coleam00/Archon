# Windows issue investigation and implementation plan

Goal: address coleam00/Archon #3294 first, then the linked Windows investigations #3282/#3286/#3287 and bundle-index defect #3283 using measured causes.

Base: dev edce16a73d3a67829db6351209388c296ba079a2.
Worktree: C:\Users\Leex279\Documents\GitHub\dynamous\Archon\worktrees\windows-3294.
Branch: fix/windows-suite-headroom.
Evidence and scratch tools live beside this plan, outside the repository. No Archon production workflow or configured database is used.

Constraints: retain the 5000ms default, no new Windows skips, retain fresh per-fixture git worktrees and all isolation guards, preserve run-owned immutable capture bytes and recorded digests, retain late source discovery, use Bun 1.4.2, preserve the user's dev checkout and untracked docs/tmp.

- [x] Read all five issue bodies/comments, linked current CI measurements and project guidance.
- [x] Enumerate #3294 test timings with actual configured budgets and precise CI run/attempt identities. Correct the issue's stale premise before choosing changes.
- [x] Record actual Windows environment and run the existing capture harness before edits with seven repetitions and four owned filesystem workers.
- [x] Profile #3287 real git/bash calls without replacing subprocess results. Prove the isolation behavior guards detect mutations.
- [x] Probe #3286 with native OS process observation and JS completion timings, then controlled load. Preserve skips unless an attributable cause is established.
- [x] Add source/binary capture parity regression and observe its failure on existing production code.
- [x] Implement #3283 explicit bundle-index.json, preserving defaults through its existing deprecation window and shipping sdlc. Move file selection from the generator into a shared inventory module, retaining real source edits and per-file selection. Keep authored extensions/legacy paths in generated metadata.
- [x] Test exact selected runtime files, excluded/unindexed files, missing-indexed-pack errors, existing untracked guards, content normalization and authored paths.
- [x] Align all live bundled readers with the index without filtering previously captured runs through today's index.
- [x] Remove the redundant successful git rev-parse preflight in #3287, retaining error-boundary diagnosis and independent scratch worktrees.
- [x] Review changes independently, run package-owned regression scripts, generated checks, type checking, lint and full applicable validation. Record host-only baseline failures separately.
- [x] Repeat the same Windows capture benchmark after the bundle change, with no unrelated test load. Preserve measured before/after results.
- [x] Once the chosen lever is verified, remove the temporary capture-cost harness and its production profiler surface per #3282's explicit end-of-life instructions; retain the numbers and reproduction receipts.
- [x] Produce a reviewable local handoff with changed behavior, verified evidence, unresolved #3286 cause and CI/host limitations. Do not claim that local green samples establish elimination of the CI long-tail stall.

Primary references:
- https://github.com/coleam00/Archon/issues/3294
- https://github.com/coleam00/Archon/issues/3282
- https://github.com/coleam00/Archon/issues/3286
- https://github.com/coleam00/Archon/issues/3287
- https://github.com/coleam00/Archon/issues/3283