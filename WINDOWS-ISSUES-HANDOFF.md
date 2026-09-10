# Windows issues: implementation and evidence

Prepared 2026-09-10 against `coleam00/Archon` dev `edce16a73d3a67829db6351209388c296ba079a2`.

Implementation: [46b52fc5](https://github.com/coleam00/Archon/commit/46b52fc591d5ce4c1619871409eb6046c0f86be8) on `fix/windows-suite-headroom`.

This report and its [supporting documents and evidence](docs/windows-issues-2026-09-10/README.md) are published on the implementation branch. The archive includes checksums and the diagnostic source snapshots needed to repeat the measurements. No PR was created.

## What is ready and what remains open

| Issue                                                   | Result                                                                                                                                                                                                      | Boundary                                                                                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#3294](https://github.com/coleam00/Archon/issues/3294) | Investigated first. Exact CI run/attempt ledger corrects the slow-test population and identifies the actual default-budget cases. Two measured cost reductions are included below.                          | Intermittent CI delays are not explained or proven eliminated. Keep this issue open pending native evidence from an actual recurrence.                                                                          |
| [#3283](https://github.com/coleam00/Archon/issues/3283) | Implemented one explicit bundle index and shared inventory for generation, live bundled readers and capture. Source/binary file paths and bytes now agree.                                                  | `defaults` remains through its existing deprecation window; `sdlc` is included. Previously captured runs retain their own files and do not consult the current index.                                           |
| [#3282](https://github.com/coleam00/Archon/issues/3282) | Completed matched Windows measurement before/after. Fewer bundled files halve the measured bundled-write phase. Retired the temporary harness and production profiler as requested in the issue discussion. | Single-host medians with seven warm samples per condition; not a CI tail-latency guarantee or Defender attribution. Raw measurements and instrumentation snapshots are included in the linked evidence archive. |
| [#3287](https://github.com/coleam00/Archon/issues/3287) | Removed the redundant successful-path `git rev-parse` before every detached fixture worktree. Measured the removed calls and verified isolation with real processes and mutations.                          | Fresh per-fixture worktrees, source capture, cwd/environment separation and cleanup remain. Local measurements do not establish the cause of the historical 5-second stall.                                     |
| [#3286](https://github.com/coleam00/Archon/issues/3286) | Completed bounded first-tar probes with OS/JS completion observations and controlled CPU load.                                                                                                              | No historical stall reproduced; no source workaround or skip removal is justified. Existing two Windows success-test skips remain.                                                                              |

## Implemented behavior

`packages/workflows/src/defaults/bundle-index.json` owns the selected packs. The generator and source readers share `bundle-inventory.ts`; they select runtime YAML, commands, script entrypoints and shared modules rather than walking every adjacent fixture, document or experimental pack. Named missing packs, malformed indices, collisions and partial/non-directory installations fail clearly. A genuinely absent SDK bundle remains supported.

Generated workflow path metadata preserves authored `.yml` extensions and legacy subfolders. Source capture applies the generator's LF normalization. Every run still receives independent frozen files; immutable capture verification and the digest fold are unchanged. Warm captures reselect files and check size/mtime, so additions, edits and deletions remain visible. Hardlinks were not introduced because they would share mutable bytes with the authoring tree or another run.

Live workflow/script discovery and command lookup/validation respect the index. Binary branches use generated constants; recorded captures use their recorded roots. Neither depends on a runtime JSON index after an upgrade. The pre-existing generated-definition fallback used by bundled subrun validation was not redesigned.

Fixture workspace creation now performs `git worktree add` first. Only a failed creation invokes the eligibility probe to retain separate not-a-repository versus unusable-HEAD diagnostics. Real detached execution and disposal remain the subject of the tests.

## Windows measurements

Windows 11 Pro build 26200; Ryzen 9 9950X, 32 logical CPUs, 62 GiB RAM. Pinned Bun 1.4.2 revision `744846f84`, used for both measurements. Dependencies installed using the frozen lockfile. Checkout and scratch files are on C:. Defender real-time protection was enabled, but exclusion readback required administrator access and was unavailable. No Defender cause is claimed.

Both captures used the existing measurement harness with 7 warm repetitions, 4 owned filesystem workers for the loaded pass, and an empty scratch global scope. Other test workloads were stopped during the matched measurements.

| Measurement                            |          Before |           After |
| -------------------------------------- | --------------: | --------------: |
| Bundled files written per capture      |             200 |              97 |
| Bundled bytes                          |       1,280,936 |         762,369 |
| Total captured files                   |             427 |             324 |
| Project files / bytes                  | 227 / 1,339,801 | 227 / 1,339,801 |
| Warm total median, idle                |       613.66 ms |       534.93 ms |
| Warm total median, 4 workers           |     2,029.76 ms |     1,380.06 ms |
| Bundled-write median, idle             |        73.64 ms |        37.70 ms |
| Bundled-write median, 4 workers        |       301.95 ms |       145.66 ms |
| Bundled revalidation median, idle      |        11.99 ms |         4.80 ms |
| Bundled revalidation median, 4 workers |        43.21 ms |        20.99 ms |
| Mutable-file digest median, idle       |       395.49 ms |       371.63 ms |
| Mutable-file digest median, 4 workers  |       814.42 ms |       803.97 ms |

The counted bundle reduction is 51.5%. Observed total medians improved about 12.8% idle and 32.0% loaded; the bundled-write medians improved about 48.8% and 51.8%. Unchanged phases also varied, so the whole elapsed-time difference is not solely attributed to the bundle. Loaded warm maxima were 2,768.48 ms before and 2,758.80 ms after: the long tail was not demonstrated to disappear. Byte reduction includes LF normalization as well as excluding unshipped files. Phase medians are independent and should not be summed as one sample.

The constant-byte synthetic sweep (1,638,400 bytes, 50-800 files) showed substantial per-file cost. Hardlinks were usually faster locally, but this is not evidence that mutable hardlinks satisfy source isolation. See [capture-before.log](docs/windows-issues-2026-09-10/capture-before.log), [capture-after.log](docs/windows-issues-2026-09-10/capture-after.log), [capture-comparison.json](docs/windows-issues-2026-09-10/capture-comparison.json), and [capture-sha256.txt](docs/windows-issues-2026-09-10/capture-sha256.txt).

For #3287, the clean/dirty parity test had two real eligibility probes costing 33.033 ms and 32.312 ms. Removing them reduces direct Git calls from six to four. The original family passed 10 tests; the revised family passes 11, including an unborn-HEAD error case. Nine in-memory mutation configurations caused 11 expected guard failures, covering cwd/PWD/OLDPWD, captured versus live/HEAD scripts, per-fixture capture, both cleanup lifetimes, configured commands and non-Git execution. Timing with intrusive Git Trace2 is kept separate from ordinary timing. See [isolation-3287-measurements.md](docs/windows-issues-2026-09-10/isolation-3287-measurements.md).

## Verification

- Frozen dependency install, all generated-file checks in `validate`, all repository type checks, lint, formatting and installer tests passed.
- `bun run validate` reached the full parallel repository test run, then stopped with exit 130 after the provider binary-resolver test failed to create a symlink (`EPERM`). That exact test fails on unchanged dev with the same error. The full repository suite therefore did not complete green.
- Every one of the workflow package's 28 declared groups was subsequently run in its own process through its package runner. Final combined result: **2,901 passed, 13 existing skips, 5 failures**. All five failures are symlink creation `EPERM`, reproduced on unchanged dev: one home-command test, two source-capture tests, two terminal-record tests. No skips or timeout increases were added.
- The full pass exposed two script-dependency test failures from a mixed real/fake installed-source fixture. Logger evidence established the partial-install error. Correcting both mock roots restored 7/7 tests; the final tally uses that rerun. Original failure logs are retained, not overwritten.
- New bundle live-selection regressions: 12/12. Actual source/binary capture conformance: 1/1. Inventory tests: 4/4, including portable Windows directory-junction dereferencing. Defaults/generator selection, missing-pack and untracked-file guards passed.
- Package and compiler test-inventory check: 6/6. Final workflow typecheck and lint wrapper passed after the last fixture correction.
- Repository workflow fixtures: 45 passed, 3 failed. All three `archon-ship` delivered fixtures fail the same `triage__triage` resolved-text assertion on unchanged dev (baseline targeted result 6 passed, 3 failed). These are pre-existing fixture failures, not concealed as passes.
- Independent review found and corrected dropped non-shared links, weakened default-name validation, swallowed missing-index errors and false absence for non-directory roots. Red/green or mutation evidence accompanies those corrections. Final read-only review found no further concrete blocker.

Evidence: [validate-final.log](docs/windows-issues-2026-09-10/validate-final.log), [workflow-test-summary.json](docs/windows-issues-2026-09-10/workflow-test-summary.json), [all 28 workflow group logs](docs/windows-issues-2026-09-10/README.md#complete-inventory), [script-node-deps-bundle-fixture-green.log](docs/windows-issues-2026-09-10/script-node-deps-bundle-fixture-green.log), [test-inventory-final.log](docs/windows-issues-2026-09-10/test-inventory-final.log), [lint-final.log](docs/windows-issues-2026-09-10/lint-final.log), [workflow-typecheck-final.log](docs/windows-issues-2026-09-10/workflow-typecheck-final.log), [workflow-fixtures-final.log](docs/windows-issues-2026-09-10/workflow-fixtures-final.log), [ship-fixtures-baseline.log](docs/windows-issues-2026-09-10/ship-fixtures-baseline.log), [symlink baseline logs](docs/windows-issues-2026-09-10/README.md#complete-inventory), [commit.log](docs/windows-issues-2026-09-10/commit.log).

## CI and tar findings that remain open

The identifiable #3294 green baseline `c1aa20f1` has 14 timed pass records above 4,000 ms: 11 tests already had longer explicit budgets and 3 used the 5-second default. At the investigated dev commit `edce16a7`, the 13 records above that threshold all have longer explicit budgets; the older three default-budget cases are much faster. This variability is not a fix. The stale-capture victim is filesystem-only and already uses an empty bundled tree, so neither a shared-subprocess theory nor the new bundle reduction explains its timeout. The baseline is [run 34472084126, Windows job 102854198458](https://github.com/coleam00/Archon/actions/runs/34472084126/job/102854198458); the investigated dev comparison is [run 34474829890, Windows job 102863142814](https://github.com/coleam00/Archon/actions/runs/34474829890/job/102863142814). Exact names, source budgets and additional attempts are retained in [issue-3294-ci-ledger.md](docs/windows-issues-2026-09-10/issue-3294-ci-ledger.md).

The [newer corrupt-tar CI failure](https://github.com/coleam00/Archon/actions/runs/34475799245/job/102866173003) reported about 2,022 ms in spawn and 3,795 ms to child/stderr completion, with exit code 1 and no signal before Bun reported timeout. It differs from the historical successful-extraction stall where the child remained alive. Both need their own accurate boundary observations.

All 20 fresh-process production tar probes succeeded. Only 2 of the load-labelled probes actually overlapped CPU load; they slowed mostly before tar and showed OS exit observed roughly 62-96 ms before JavaScript completion. None reproduced the historical >=5-second tar stall. The next decisive artifact is a native stack/ETW trace during an actual recurrence, correlated with exact child PID/OS liveness, parent heartbeat, output creation, stderr and JS exit completion. Then distinguish a live blocked child from a completed child whose parent has not delivered completion. See [tar-investigation-results.md](docs/windows-issues-2026-09-10/tar-investigation-results.md) and [tar-probe-results.json](docs/windows-issues-2026-09-10/tar-probe-results.json).

## Reproduction and handoff

Review the [implementation commit](https://github.com/coleam00/Archon/commit/46b52fc591d5ce4c1619871409eb6046c0f86be8) or its [downloadable patch](https://github.com/coleam00/Archon/commit/46b52fc591d5ce4c1619871409eb6046c0f86be8.patch). Use a checkout of `fix/windows-suite-headroom`, Bun 1.4.2, and `bun install --frozen-lockfile`.

The validation commands are `bun run validate`, `bun run test ./scripts/test-inventory.test.ts`, and `bun run cli workflow test --json`. Run workflow package groups through the package's `bun run test` command so its mock isolation is preserved. Pin `ARCHON_HOME` to an owned scratch directory, set `ARCHON_TELEMETRY_DISABLED=1`, and keep database verification on scratch resources. The observed host limitations are recorded above.

The temporary capture harness was removed from production only after measuring the change. The baseline experiment can be repeated in a disposable checkout of `edce16a73d3a67829db6351209388c296ba079a2` with `bun run bench:capture -- --json` and no unrelated test load. Repeating the instrumented after-measurement uses the published [workflow-source-after-profiled.ts snapshot](docs/windows-issues-2026-09-10/workflow-source-after-profiled.ts.txt) and [capture-cost-original.ts snapshot](docs/windows-issues-2026-09-10/capture-cost-original.ts.txt). In a disposable checkout, restore them to `packages/workflows/src/workflow-source.ts` and `scripts/capture-cost.ts`, removing the archive's `.txt` suffix, then run `bun run scripts/capture-cost.ts --json`. The current branch intentionally has no capture profiler API.

No database schema, provider credential, timeout, machine security setting or test concurrency policy was changed. A clean Windows CI run and a Linux run are still required before merge. The local baseline failures and unreproduced stalls remain open as described above.
