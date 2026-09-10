# Windows #3294 CI evidence, 2026-09-10

Read-only investigation against ordinary GitHub CI. No tests, benchmarks, source changes, workflow launches, or GitHub comments performed by this investigator. This is a timing/ownership inventory, not proof of an underlying Windows mechanism or permission to close #3294/#2924.

## Corrections required before selecting a fix

- The named timing fingerprint in #3294 identifies green dev **c1aa20f14cf4c34f7cd92eb7f8420dcc6857f972**, [run 34472084126](https://github.com/coleam00/Archon/actions/runs/34472084126), [Windows job 102854198458](https://github.com/coleam00/Archon/actions/runs/34472084126/job/102854198458). It contains capture-stale 351.86ms, tar-nonzero 1680.63ms, and untracked-default 232.98ms.
- That raw job has **14**, not 12, timed pass records above 4000ms. **11 have explicit longer body budgets; three use the 5000ms default.** Therefore neither #3294's claim that all slow tests have subsecond budget headroom nor PR #3291's later claim that all such tests have explicit longer budgets is exact for this identifiable baseline.
- The baseline was created 11:35:19Z, after the first timeout-bearing PR run was created at 11:28:14Z. The jobs overlap. The phrase "dev an hour earlier" does not accurately timestamp this exact fingerprint.
- `captureWorkflowSource > replaces a stale capture rather than merging two vintages` does **not** spawn a subprocess on its tested path. It performs filesystem capture twice and loads/verifies the result. The test already directs bundled scope at an empty owned tree. The shared subprocess premise in #3294 is false for this victim.
- Current green dev **edce16a73d3a67829db6351209388c296ba079a2**, [run 34474829890](https://github.com/coleam00/Archon/actions/runs/34474829890), [Windows job 102863142814](https://github.com/coleam00/Archon/actions/runs/34474829890/job/102863142814), contains 13 timed pass records above 4000ms, **all with explicit longer budgets**. The three baseline default-budget edge cases pass here at 487.25/358.09/230.19ms. This demonstrates variability, not a causal fix.

## Exact baseline enumeration

Paths are repository relative. Body budgets are from checked-in tests; hooks have independent defaults. Timing is Bun's reported test duration, not a per-operation attribution. Every row is green in both columns.

| Package/file | Full test name | c1aa20f dev ms | edce16a current dev ms | Body budget ms | Baseline raw line |
|---|---|---:|---:|---:|---:|
| packages/git/src/git.test.ts | git utilities > cloneRepository > authenticates a real Git clone against an explicit HTTP port | 8094.7 | 3580.83 | 15000 | 5708 |
| packages/cli/src/cli.test.ts | workflow status project scope > uses the run-owned project after its conversation moves and returns every project with --all | 4672.27 | 6075.86 | 30000 | 7712 |
| packages/cli/src/commands/workflow-terminal-event.integration.spec.ts | detached workflow terminal database events > persists one matching event before successful and failed owners exit | 7569.82 | 8970.74 | 40000 | 8293 |
| packages/cli/src/commands/workflow-continuation-provider.integration.spec.ts | workflow continuation provider registration > resumes a provider-scoped workflow instead of failing its source lookup | 5074.61 | 4106.93 | 120000 | 8322 |
| packages/workflows/src/dag-executor.test.ts | executeDagWorkflow -- unified node-state sinks (#3255) > assertCheckoutUntouched writes node_error transcript row on mutates_checkout failure | 4909.55 | 487.25 | 5000 | 8348 |
| packages/cli/src/commands/workflow-wait.integration.spec.ts | archon workflow wait against a detached run > wakes on completed without polling run status | 38224.92 | 5006.73 | 90000 | 9622 |
| packages/workflows/src/subrun.test.ts | workflow: sub-run e2e (#2121 Phase 2) > fans out over an N-item array (all_success): N children, ordered aggregate, item→$ARGUMENTS | 4527.92 | 358.09 | 5000 | 9631 |
| packages/workflows/src/subrun.test.ts | workflow: sub-run e2e (#2121 Phase 2) > read-only children (mutates_checkout: false) fan out IN the parent checkout, no worktrees | 4795.26 | 230.19 | 5000 | 9657 |
| packages/cli/src/commands/workflow-wait.integration.spec.ts | archon workflow wait against a detached run > wakes on failed without polling run status | 37742.15 | 5619.17 | 90000 | 10462 |
| packages/cli/src/commands/workflow-wait.integration.spec.ts | archon workflow wait against a detached run > wakes with awaiting_response on a gate, then with cancelled when it is rejected | 9374.16 | 6723.34 | 120000 | 11381 |
| packages/cli/src/commands/workflow-wait.integration.spec.ts | archon workflow wait against a detached run > wakes on a cancelled run stopped from a third process | 6422.61 | 6172.89 | 120000 | 11681 |
| packages/cli/src/commands/workflow-wait.integration.spec.ts | archon workflow wait against a detached run > exits 3 with the observed status when the timeout passes first | 5152.63 | 4294.84 | 90000 | 12170 |
| packages/cli/src/commands/workflow-transcript.integration.spec.ts | archon workflow transcript discovery and following > a foreground run can be discovered and followed from another process | 9349.37 | 4564.79 | 60000 | 12548 |
| packages/cli/src/commands/workflow-transcript.integration.spec.ts | archon workflow transcript discovery and following > a detached ack distinguishes the transcript from child output and can be followed | 4392.63 | 4466.02 | 60000 | 12776 |

The current-head additional >4s population is the three `compiler test inventory` cases in `scripts/test-inventory.test.ts`: adapters 4621.75ms, server 5120.52ms, CLI 5377.82ms. Each already has a 15000ms body budget (lines 426/434/443). Its core sibling is 3933.33ms with the same budget. All four launch `bun x tsc --noEmit --listFilesOnly --project ...`; they test the compiler's imported-file inventory, so replacing them with config-text checks would weaken their subject. This is not a default-budget-edge cluster.

## PR #3291 timeout attempts

[PR #3291](https://github.com/coleam00/Archon/pull/3291) changed validate orchestration; its first pre-timeout run, 34469614467 (Windows job 102846379926), failed on three Windows fixture text assertions before executing the Bun test suite. It contains no timed `(pass)`/`(fail)` records. Do not call this one of the three timeout attempts.

| Attempt | Head | Run/job | Default-budget victim | Reported ms | c1aa20f dev ms | edce16a dev ms |
|---|---|---|---|---:|---:|---:|
| Original timeout | 4e25fa340f8fc1828af962389f8643d50f5b821c | [34471457728 attempt 1 / 102852118145](https://github.com/coleam00/Archon/actions/runs/34471457728/job/102852118145) | captureWorkflowSource > replaces a stale capture rather than merging two vintages | 9625.63 | 351.86 | 74.08 |
| Same-head rerun | 4e25fa340f8fc1828af962389f8643d50f5b821c | [34471457728 attempt 2 / 102859075822](https://github.com/coleam00/Archon/actions/runs/34471457728/job/102859075822) | generate-bundled-defaults: untracked-file guard (#1578) > exits 1 and leaves the bundle untouched for an untracked workflow default | 7995.69 | 232.98 | 374.00 |
| New head, fixtures/docs after tests | 845a2223201acba1f714f807bf9cae8513242941 | [34475799245 / 102866173003](https://github.com/coleam00/Archon/actions/runs/34475799245/job/102866173003) | downloadWebDist > leaves nothing behind when tar exits non-zero | 5823.78 | 1680.63 | 478.87 |

Exact source ownership: `packages/workflows/src/workflow-source.test.ts:330`, `packages/workflows/src/defaults/generate-bundled-defaults.test.ts:205`, `packages/cli/src/commands/serve.test.ts:354` at edce16a. Failed attempts stop before all tests complete, so counts and suite wall times are not full green-suite comparisons. No conclusion here depends on the issue's 2612 matched-test median; that original statistic's selection script is not attached.

The tar-nonzero victim has unusually useful operation spans in job 102866173003:

- Raw lines 5408-5415: start/verification, then staging 28 bytes costs **5ms**.
- Line 5632: PID8232 reported after **2022ms** in the spawn interval.
- Lines 6051-6053: stderr completes at **3794ms after spawn**, process exits with **exitCode 1**, signalCode **null**, at **3795ms after spawn**.
- Lines 6054-6056: the test reports the 5000ms body timeout at **5823.78ms**, immediately after those exit records. This is a completed error exit, not the earlier ledger's never-exited successful-extraction shape.
- Immediately next, the controlled stalled-extraction child PID1776 spawns in **5ms**, exits after the test-selected bound at **256ms**, and passes in **265.38ms**. This defeats a blanket claim that every child remained globally slow for the whole job.

The third attempt reached its timeout before the moved fixture/docs checks ran. It falsifies those two preceding checks as a necessary trigger. It does not establish setup-node, one enclosing Validate step, Defender, or parallelism as the cause. Two failures at the identical 4e25fa head are concrete different-victim evidence; no runner setting was changed for this investigation.

## Source-supported opportunities and remaining attribution

1. **Narrow accidental fixture work: empty Git commits in checkout-guard tests.** `dag-executor.test.ts:34929` asserts a transcript `node_error` for a changed `git status` snapshot, but creates an empty commit first. The neighbouring guard family uses the same init+empty-commit helper at 34405 for six scenarios. Neither production snapshot path nor these assertions inspect history or HEAD; `snapshotCheckout` invokes only `git status --porcelain`. Try retaining real `git init`/status and the real execution path while removing the unnecessary empty-commit fixture step, then verify assertions/mutation sensitivity. This is a candidate grounded in code, not a measured attribution for the 4909.55ms sample.
2. **Narrow accidental fixture work: two Git-config subprocesses.** `git.test.ts:2808-2815` runs separate `git config user.name` and `git config user.email` only to author a fixture commit. Passing those values with `git -c ... commit` can remove two setup processes while preserving the real authenticated HTTP clone, HTTP server, origin assertion, and all product operations. Profile setup separately; this integration already has a 15s budget, so its 8.1s baseline is not a 5s edge.
3. **Fan-out default-budget cases need operation profiling.** Both execute three real shell children plus one planning shell. The isolated variant's fake resolver copies the fixture workflow tree three times; `makeFanResolver` already limits copies to `.archon/workflows`. A captured-source inheritance audit could establish whether those copies remain needed, but this investigation does not assume they are redundant. Retain ordering, argument binding, isolation identity, shared checkout semantics and real tested mechanisms.
4. **Stale capture needs filesystem phase evidence.** It already removes incidental bundled file fan-out. Two source vintages are essential to its assertion. Capture profiling under #3282 can distinguish read/write/digest cost, but a production-size 427-file benchmark is not the same workload as this small empty-bundle test. Do not call the latter a subprocess residual.
5. **Generator victim needs cp/process/cleanup attribution.** Its template is already created once; each negative case copies it, adds one untracked file, runs the actual generator, verifies exit/stderr/sentinel, and removes the tree. Negative guards cannot simply be fused: each must run before its own guard stops the generator. No further accidental cost proven here.
6. **Tar error cleanup remains a real native-child integration.** The failing 28-byte archive is deliberately corrupt and must exercise staging then nonzero extraction cleanup. The recorded >2s spawn and 3.8s child-completion intervals narrow the cost. They do not distinguish actual child CPU/file time from scheduling/observation delay. A spy pretending `tar` failed would no longer prove that integration boundary.
7. **Long-budget CLI integrations remain necessary multi-process subjects.** Status/project identity, owner-terminal record, provider continuation, event wake/cancel/deadline, and transcript following each exercise real cross-process behavior. Their explicit budgets already exceed the measured slow records by substantial margins. Profile their child startup/lifecycle only if separately pursuing end-to-end latency; do not label them default-budget debt.

No case is declared runner-floor residual solely from a green CI run or fast local measurement. The current records prove observed cost and some setup machinery, not unavoidable cost on a CI runner.

## Relevant ledger context

- [#2924 current issue](https://github.com/coleam00/Archon/issues/2924): no budget bump, no general Windows skip; residual requires cost attribution, not rerun-and-forget. Its body predates later ownership fixes.
- [#2924 GAP2180 attribution](https://github.com/coleam00/Archon/issues/2924#issuecomment-5614499869): body timeout and teardown can overlap; abandoned Bun bodies continue; hook defaults differ from explicit test budgets. Filesystem-only capture/lifecycle routes widen the original subprocess class.
- [#2306 latest widening correction](https://github.com/coleam00/Archon/issues/2306#issuecomment-5614502286): the original all-subprocess observation is not the boundary of the later failures; pure filesystem cases exist. Oversubscription/Defender remain hypotheses absent native attribution.
- [#2924 latest product-bound correction](https://github.com/coleam00/Archon/issues/2924#issuecomment-5616134839) and preceding 5615865222 distinguish the historical product extraction deadline and test deadline. Current checked-in serve.ts owns a timer explicitly; read source after those comments rather than assuming the old Bun timeout option remains.

## Reproduction of the inventory

Downloaded via `gh api repos/coleam00/Archon/actions/jobs/<job>/logs`; fetched run jobs and PR/issue JSON are saved beside this file. Raw logs are UTF-8 text with GitHub timestamps/prefixes preserved. Parsing recognizes `(pass|fail) <name> [<number>ms]`; package-prefix state maps group headers to source files. Repeated failure summaries are deduplicated by job/package/name/time, keeping the original event's file and line. Test duration records are not a whole-suite test-count census because Bun may omit zero-duration timings and aborted jobs stop early.

Artifacts:
- `job-102854198458.log`: fingerprinted c1aa20f baseline.
- `job-102863142814.log`: edce16a current green dev.
- `job-102852118145.log`, `job-102859075822.log`, `job-102866173003.log`: three timeout attempts.
- `job-102846379926.log`: earlier fixture-only failure.
- `job-102827825052.log`, `job-102837712488.log`: earlier green dev controls, respectively 14 and 13 >4s records, showing the count varies.
- `ci-timed-tests.json`: all parsed timing records with source/log lines.
- `dev-baseline-over4s.csv`, `dev-baseline-vs-current-head.csv`: exact enumeration and current comparison.
- `issue-3294.json`, `issue-2924.json`, `issue-2924-comments-latest15.json`, `issue-2306.json`, `pr-3291.json`, `run-*-jobs.json`: raw remote metadata/context.

