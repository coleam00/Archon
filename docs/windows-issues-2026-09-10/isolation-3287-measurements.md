# Native Windows isolation family profile (#3287)

Measured 2026-09-10 on Windows 11 Pro 10.0.26200, AMD Ryzen 9 9950X / 32 logical processors. Bun 1.4.2 (744846f84), source baseline edce16a7. See machine.json for recorded environment. Defender real-time protection is enabled; exclusions were unreadable without administrator access. No Defender causation is inferred.

All three passes used the package test runner, the same ten selected exec-code isolation tests, an isolated ARCHON_HOME, and the 5000 ms default timeout. No other benchmark or test was running in the delegated measurement window. Root was performing source inspection only during baseline; these are idle local measurements, not CI-load reproduction.

| Pass | Family time (Bun) | Result |
| --- | ---: | --- |
| Uninstrumented | 2.66 s | 10 passed / 24 assertions |
| Pass-through execFileAsync timer | 2.59 s | 10 passed / 24 assertions |
| Timer + Git Trace2 + capture profiler | 3.90 s | 10 passed / 24 assertions |

Uninstrumented clean/dirty parity test: 460.92 ms. Its pass-through timing is 447.15 ms including test hooks; recorded child spans total 377.38 ms (~84.4%). This host did not reproduce the 5231.13 ms CI timeout.

## Every git span in the parity test

| Invocation | rev-parse --show-toplevel | worktree add --detach | worktree remove --force | Bash child (includes nested git status) |
| --- | ---: | ---: | ---: | ---: |
| Clean | 33.033 ms | 62.509 ms | 34.614 ms | 64.384 ms |
| Pre-dirtied | 32.312 ms | 57.558 ms | 32.654 ms | 60.319 ms |

worktree add is the largest direct git span, roughly 1.8 times each rev-parse/remove span. Both ignored-output rev-parse probes together cost 65.345 ms, 14.6% of this parity test's measured body span. They are a removable eligibility preflight: successful worktree add already establishes the eligibility, so deferring the diagnostic probe to creation failure reduces successful direct git calls from six to four while retaining one fresh detached checkout per fixture.

Across the selected family: 9 successful worktree adds (514.014 ms total), 9 removes (307.956 ms), 10 rev-parse calls including non-repository failure (313.188 ms), 5 Bash children (279.779 ms), 5 Bun children (133.370 ms). beforeAll template initialization and the uncommitted-source premise account for 9 separate setup/init calls; disposal assertion adds 1 worktree list call. None should be combined into fixture execution attribution.

## Separate tracing experiment

Git Trace2 was explicitly a second, intrusive pass. It increased the family duration materially, so its times are not interchangeable with the baseline.

| Invocation/operation | Outer exec lifetime | Git exit t_abs |
| --- | ---: | ---: |
| Clean rev-parse | 55.597 ms | 27.494 ms |
| Clean worktree add | 115.399 ms | 87.840 ms |
| Clean worktree remove | 63.323 ms | 31.135 ms |
| Dirty rev-parse | 57.266 ms | 29.116 ms |
| Dirty worktree add | 111.303 ms | 82.375 ms |
| Dirty worktree remove | 56.877 ms | 29.996 ms |

Outer-minus-internal includes Windows/Bun process creation, stdio lifecycle and scheduling; it is not an isolated measurement of any one mechanism. Source captures cost 10.072/7.784 ms and each copied two project files (212 bytes), with an empty bundled scope as the existing test intentionally supplies. No evidence supports replacing real isolation with a shared mutable worktree.

Raw evidence: isolation-3287-baseline/test.log and result.json; isolation-3287-profile/test.log, result.json and fixture-spawns-20712.json; isolation-3287-trace/test.log, result.json, fixture-spawns-46772.json and git-trace-*.jsonl. Profiler source: fixture-spawn-profiler.ts. Experimental design and required guard sensitivity matrix: isolation-3287-design.md.

Status at report creation: timings only. Candidate optimization and guard-mutation validation are not implemented or measured yet. CI-load behavior remains unproven, and no budget increase or platform skip was introduced.

## Implemented and verified follow-up

The narrow producer change now calls rev-parse only after worktree creation fails, preserving the existing non-repository diagnostic without parsing vendor prose. Detached workspace creation/disposal and source capture lifetimes are unchanged. No timeout, platform guard, package-runner concurrency or workflow execution settings changed.

Regression-first proof: the existing clean/dirty parity test now spies on execFileAsync while calling the real implementation. Before changing the producer, its original behavioral assertions passed, then its added direct-call guard failed with exactly two unexpected rev-parse calls (isolation-3287-red/test.log). After the producer change all eleven isolation tests passed (29 assertions). An added actual unborn-HEAD checkout test proves that a valid git repository with no usable HEAD reports worktree creation failure, retains the underlying git error evidence, and never executes the fixture writer. The existing outside-git test continues to prove the separate no-repository failure.

Post-fix profile: four direct git calls in parity, add 53.671/remove 31.373 ms for clean and add 57.650/remove 34.194 ms for dirty. No successful invocation calls rev-parse. Bash spans were 70.591/70.006 ms. Profiled family: 11 passed, 2.33 s. Uninstrumented green parity: 353.13 ms. The root's simultaneous #3283 bundle collector change alters capture internals between the original baseline and post-fix run, so these are not a controlled percentage-speedup claim. The stable causal gain is two eliminated Windows subprocesses per parity test, whose baseline spans summed to 65.345 ms. Loaded CI budget compliance remains unproven.

Guard sensitivity was proven with isolated in-memory Bun loader mutations, without editing production files on disk. Each configuration ran in a fresh process, and each expected behavioral assertion failed:

| Mutation | Concrete guard failure |
| --- | --- |
| Execute in caller cwd | Dirty parity got zero passes; relative writer created caller leak.txt |
| Inherit PWD and OLDPWD | Environment writer created caller leak.txt |
| Resolve named scripts from live source | Executed script path was caller .archon/scripts, with no fixture-source capture |
| Execute committed HEAD script | Uncommitted-source guard expected completed and got failed |
| Capture each fixture separately | Two distinct fixture-source identifiers |
| Skip workspace and capture disposal | Git worktree list retained fixture-exec entry |
| Skip capture disposal alone | Worktree disposal succeeded, then leftover source-capture list was nonempty |
| Ignore configured command folder | Configured command fixture failed |
| Use plain non-git scratch directory | Clean-status guard failed; non-repository writer incorrectly passed |

Nine configurations produced eleven intended failing test runs. The baseline's explicit failed-git-status guard also passed: a failed git status was rejected with Bash exit 1, not interpreted as a clean checkout. Raw logs are under isolation-3287-mutants/<mutation>/test.log; the exact source transformations are in isolation-guard-mutations.ts.

Final uninstrumented full file: 51 passed, 3 existing skips, 0 failed, 124 assertions, 3.10 s; log isolation-3287-final-file/test.log. The three pre-existing skips are the POSIX directory-permission guard and two symlink guards unavailable in this Windows environment; this patch adds no skip. Every exec-code isolation guard ran.

After that run, the empty bundled fixture setup was adjusted to derive its required pack directories from readBundleIndex(), replacing the temporary explicit sdlc directory and stale full-bundle comments. This produces the same current empty directories and removes a manual mirror of the new bundle index; root's final validation must include that final setup-only change. Own-file git diff --check passed. No commit, GitHub comment, pull request or workflow run was created by this agent.
