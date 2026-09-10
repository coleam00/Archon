# Issue 3287 profiling design

Status: prepared only; never executed at preparation. Source revision edce16a7. No source changes.

Use the root's measurement window, the pinned Bun runtime (see runtime metadata), native Windows, existing package test runner and isolated scratch ARCHON_HOME. Preserve default 5000 ms budget. Runtime location is runtime/bun-windows-x64/bun.exe under this artifact directory.

1. Uninstrumented baseline: package cwd packages/workflows, `bun run test src/fixture-runner.test.ts --test-name-pattern "exec-code isolation"`. Root coordinates equivalent workload and writes logs outside repository. Record revisions, runtime versions, exit status and each test duration. No ambient benchmark or package-install process may overlap an idle baseline.
2. Repeat the same command with `--preload <artifact>/fixture-spawn-profiler.ts`, setting ARCHON_PROFILE_REPO to the worktree root and ARCHON_PROFILE_OUTPUT to a unique directory beneath this artifact directory. The wrapper calls and awaits the real execFileAsync with unchanged arguments/options; it buffers timings and only writes afterAll/exit. ARCHON_PROFILE_SELECTOR describes the selector. Events identify setup, selected test ordinal, and every actual child.
3. Attribution pass only: ARCHON_PROFILE_GIT_TRACE=1 additionally injects GIT_TRACE2_EVENT into each child. Every root git call and nested git status receives a separate per-parent-call trace file. Compare outer awaited execFile lifetime against Git exit event t_abs. The delta includes Windows/Bun process and stdio lifecycle and scheduling; it does not uniquely identify antivirus or kernel process creation.
4. Optional separate pass: ARCHON_PROFILE_CAPTURE=1 wraps the existing captureWorkflowSource profiler. Preserve its real implementation and return value; record the nine owning phases. Avoid mixing this instrumentation into baseline comparisons.
5. Root's native Windows loaded suite (bun filter parallel) is a distinct context. Do not infer loaded CI performance from idle host medians. Repeat profiled selector during that approved load if root permits; preserve all raw events and failures.

Mapping selected isolation-family test ordinals: 1 clean/dirty parity; 2 failed-git guard; 3 relative writes; 4 PWD/OLDPWD; 5 captured named script; 6 single capture across two fixtures; 7 uncommitted script edit; 8 configured command folder; 9 disposal; 10 outside-git failure. Test selection changes ordinals; log the selector alongside JSON.

Current mechanism: withExecWorkspace runs once per executable fixture/workflow target, not once per runFixtures invocation. Each success costs git rev-parse, worktree add, worktree remove. Parity invokes twice (six git calls, two bash calls including nested git status); single-capture guard has two fixtures (six git calls, two Bun calls, one capture). Repository init template creation is beforeAll; uncommitted-source test deliberately initializes its own committed-source premise.

Candidate, not yet measured or implemented: attempt worktree add first, and only run rev-parse after creation fails to preserve the existing outside-git diagnostic. Rev-parse output is unused and worktree add already validates repository/HEAD eligibility. Success becomes two git calls per executable fixture (parity six to four). Detached worktree lifetime, capture, cwd/env and disposal remain unchanged. A shared mutable worktree is unnecessary and would invite fixture state leakage.

Guard sensitivity required before accepting any change: make one throwaway mutation at a time; save exact failing test/output, restore, and rerun passing baseline. Run mutations only in authorized scratch sources. Candidate guard matrix:
- Execute in caller cwd: clean/dirty parity and relative-write guard must fail.
- Preserve inherited PWD/OLDPWD instead of scratch: env-write guard must fail.
- Resolve named scripts live: captured-copy path guard must fail.
- Source scripts from HEAD: uncommitted-source guard must fail.
- Capture separately per fixture: single-capture equality guard must fail.
- Omit workspace/capture disposal: disposal guard must fail.
- Freeze default command folders despite custom config: configured command-folder guard must fail.
- Pretend non-repo is usable or replace scratch with plain directory: outside-git or clean-status guard must fail; guard's explicit failing-git test independently requires exit 1.

No budget bump, platform skip, shared worktree, GitHub write, workflow launch, dependency install or production source change is authorized for this delegated investigation.

