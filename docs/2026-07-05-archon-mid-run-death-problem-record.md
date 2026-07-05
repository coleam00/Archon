# Problem Record — Archon runs die / stall mid-run (worker-kill · exit-66 · wedge)

- **Date:** 2026-07-05
- **Status:** captured — **reference dossier, not a plan.** **UPDATE (2026-07-05 evening): root
  cause of C confirmed and A settled — see the Addendum at the bottom of this file.** The fixes live in
  `.agents/plans/2026-07-05-agentic-loop-automation.md` (WS3 — Actuator hardening) and the deep design
  `docs/superpowers/specs/2026-07-05-execution-reliability-floor-design.md`. This file catalogs the
  problem, its incidences, and confirmed-vs-hypothesized causes in one place.
- **Sources:** `docs/retros/worked-failures.md` (~25 dispatches); `.claude/scripts/heartbeat.py:572`
  (`check_archon_zombies`); `.claude/skills/design-implement/SKILL.md` + `references/gotchas.md`
  (exit-66 / CLAUDECODE HARD RULEs); `.agents/plans/2026-07-05-agentic-loop-automation.md` (exit-66
  bash-tail + `--detach`-on-Windows findings, verified against Archon source); live `~/.archon/archon.db`
  probe (2026-07-05); daily logs 2026-05-21 / 2026-05-27 / 2026-07-01.

## The problem

Once a slice is dispatched, an Archon run can **die** (process gone, DB row stuck `running` = a
"zombie") or **stall** (process alive but making no progress = a "wedge") partway through the DAG.
Today a human must notice and hand-recover it (flip the row to `paused`, `archon workflow approve <id>`,
or manual-finish from the worktree). This is the **single biggest blocker to unattended automation** —
you cannot leave the loop running if a mid-run death silently parks a dispatch until morning. It is the
most-recurring operational class in the retro log (`archon-worker-killed-midrun`, 6+ sightings) and, as
of 2026-07-05, a fresh exit-66 variant forces a manual finish on *every* run.

Live state at capture (`archon.db`): 209 completed · 82 cancelled · 81 failed · 2 running (~44% of all
runs did not complete — not all kills, but a high mortality baseline). The 2 running rows were two
**concurrent** `plan-to-pr-tdd` dispatches on one host — the exact condition the resource-pressure
hypothesis (cause D) points at.

## Incidences (chronological)

| Date | Run | What happened | Node | Class |
|---|---|---|---|---|
| 2026-05-21 | `ef49a4da` | API stream idle timeout after 14m25s → run failed (re-ran `b7565dbe`) | planner/early | **E** idle-stream (caught by Archon's own idle timeout) |
| 2026-06-26 | `c9318326` | provider **stream drop** → "output_format declared but no schema-valid structured output" → `node_failed` → `commit-and-pr` cascade; no PR opened | e2e-visual-validate | **F** stream-drop |
| 2026-06-27 | `a7b6c2dd` | **external mid-DAG kill** after ~52 min; DB row left `running`; 11 orphan Next.js servers | e2e-visual-validate | **D** resource-pressure (hyp.) |
| 2026-06-30 | `c3460ad5` | long background bash hosting archon **reaped** mid-validate (~26 min); "not an archon/node timeout" | validate | **A** launcher-reap |
| 2026-06-30 | `e902ba4d` | operator **killed the resume 3×** via own shell: `archon\|tee\|head` (SIGPIPE), `archon &` foreground (SIGHUP ×2) | resume | **B** self-inflicted signals |
| 2026-06-30 | `f33bbdae` | run killed at validate by `/remote-control`; CLI can't resume a worktree run | validate | **A** external kill (harness) |
| 2026-07-01 | `36ade863`, `62b7f87e` | two background-task kills mid-`reuse-revalidate` with the **documented-correct** `run_in_background` pattern; cause unclear; didn't recur on a 3rd identical attempt | reuse-revalidate | **A/D** unclear |
| 2026-07-03 | `d7860bb7` | dispatched as a `run_in_background` shell task → executor was **that task's child**; task stopped → executor (pid 27208) died → zombie `running` row, uncommitted impl | local-fix-1 (mid-DAG) | **A** launcher-reap (clearest) |
| 2026-07-04 | `7c21240e` | `implement-backend` **silent 42 min after writing its files**; process alive (pid 28532, 102 MB); row `running`; no node timeout fired | implement-backend | **E** idle-stream **wedge** (alive) |
| 2026-07-05 | cloud-clinic + marphob-page | **exit-66** kills every post-implement bash node (`ci-ledger-emit`, `ledger-reconcile`, …); forces manual-finish on **every** run; theory = slash-in-workspace-key | post-implement bash tail | **C** exit-66 bash-tail (**current**) |

_Benign baseline (not a failure), for contrast:_ 2026-05-27 — a worker exits **exit-0** cleanly at an
approval pause (`archon workflow status` → `paused`). A clean pause looks nothing like a zombie; the
detector must not confuse them.

## Causes — confirmed vs. hypothesized

### A. Launcher-parented executor reaped — *understood; fix DISPUTED on Windows*
Without a working detach, the Archon executor runs as a **child of the session/background shell** that
launched it. When that shell dies — task-stop, `/remote-control`, or the harness reaping a long-running
background bash task — the executor dies with it, leaving a zombie `running` row. Documented signature:
**exit-66** ("a session-shell-held executor dies of exit-66 if the shell is killed",
`design-implement/SKILL.md`). Clearest instance: `d7860bb7` (2026-07-03).
- **Intended fix:** `archon workflow run … --detach` (out-of-process executor that survives its
  launcher), + `env -u CLAUDECODE` (a leaked `CLAUDECODE=1` kills even a `--detach` child **~1 s in** at
  `worktree_creating`, per `design-implement/references/gotchas.md:50-52`).
- **DISPUTE (unresolved):** the 2026-07-05 automation plan reports `Bun.spawn().unref()`
  (`workflow.ts:195-201`) **doesn't actually detach on Windows** — so `--detach` may be ineffective here,
  and the "standardize the no-detach backgrounded path everywhere" option is on the table. One
  data point *for* it: `design-implement/SKILL.md` records that `env -u CLAUDECODE … --detach` "ran all
  9 nodes green" on 2026-06-27. **Net: efficacy on Windows is not settled — needs a decisive test.**

### B. Self-inflicted shell signals — *understood; avoidable*
`archon | … | head` → `head` exits → **SIGPIPE** kills archon; `archon &` inside a foreground Bash call →
**SIGHUP** on return. Pure shell-hygiene mistakes (`e902ba4d`, 2026-06-30). Avoid by using
`run_in_background`, never piping archon into `head`, never `&`-in-foreground.

### C. exit-66 "bash-tail" bug — *current; highest-urgency; theory-stage root cause*
Distinct from A: individual **post-implement bash nodes** exit-66, killing the whole CI/ledger tail
(`ci-ledger-emit`, `ledger-reconcile`, and more). Per the 2026-07-05 automation plan (verified against
code), reproduced on **both** cloud-clinic and marphob-page on 2026-07-05, and it currently forces a
**manual finish on every run**. Working theory: a **slash in the workspace key** (`codebase/<repo>`)
mishandled in a bash invocation. This also explains why the CI cell has never stamped on a live ledger —
the breadcrumb-writing tail never survives. **Named the single highest-urgency fix (automation plan
WS3.1).** Root cause not yet proven; the slash-in-workspace-key theory needs confirmation.

### D. Resource / memory pressure on heavy long nodes — *residual; UNCONFIRMED*
A few kills happened to **properly-launched** runs, clustering on heavy long nodes (`e2e-visual`,
`validate`, `reuse-revalidate`, ~26–52 min) that spawn many child processes (Next.js servers, pytest,
docker, browsers). Leading hypothesis: **host memory/resource pressure from concurrent heavy workers**
(`a7b6c2dd` explicitly names 2 concurrent opus workers; the `36ade863`/`62b7f87e` pair on 2026-07-01
died with the correct pattern, cause "still unclear"). **Never instrumented to confirm** — see the
measurement gap below. Some of these may in fact be cause A (if `--detach` doesn't truly detach on
Windows, a "properly launched" run is still launcher-parented), which would shrink the true residual.

### E. Idle-stream wedge — *related but DISTINCT (process alive, not dead)*
The node's process stays **alive** but stops progressing; Archon's own AI-node idle-timeout
(`STEP_IDLE_TIMEOUT_MS` = 30 min) either doesn't fire (a subagent keeps pinging `task_progress` ~every
30 s) or was raised; **bash/script nodes have no silence detection at all** (only a wall-clock cap).
Instance: `7c21240e` (2026-07-04, silent 42 min). This is a **stall**, not a death — different recovery
(kill the tree, then resume/relaunch) and different detection (needs OS process-tree CPU/IO liveness,
not just a stale DB row). See the design doc §4 for the hard-wedge vs soft-wedge split.

### F. Provider stream-drop → node_failed — *related but DISTINCT*
A transient provider stream drop makes an AI node emit prose instead of its declared structured output →
`structured_output_missing`/`node_failed` → downstream `OutputRefError` cascade sinks an otherwise-green
run (`c9318326`, 2026-06-26). Mitigated per-workflow by barrier-shielding the node's blast radius
(`all_done` edges), not by the supervisor.

## Current state — fixed vs. residual

- **A (launcher-reap):** partially addressed by `--detach` + `env -u CLAUDECODE` in the dispatch skills,
  **but Windows efficacy is disputed** — treat as OPEN until a decisive test.
- **B (self-inflicted signals):** understood and avoidable; encoded in the archon/manage-run guidance.
- **C (exit-66 bash-tail):** **OPEN, current, highest-urgency** — forces manual-finish on every run.
- **D (resource-pressure):** **OPEN, unconfirmed** — never measured.
- **E (wedge) / F (stream-drop):** partially handled (Archon idle-timeout / barrier-shielding); the
  wedge auto-recovery is what the reliability-floor design adds.
- **Recovery mechanics (known-good):** flip zombie `remote_agent_workflow_runs.status` → `paused`, then
  `archon workflow approve <id>` (resumes from the last committed node). A **failed-then-cancelled** run
  must be **fresh-relaunched, never** flip→resumed (cancel-cascade poisons the re-run). No pid is
  recorded anywhere; a run maps to its process tree via the `working_path` DB column.

## The measurement gap — how to finally confirm the residual

"Cause unknown" for D is partly a **measurement gap**: no one ever captured, at the moment of death, the
**exit code** (66 → launcher-reap; other → likely resource kill), **system memory state**, or the
**Windows Event Log** entry. The supervisor being designed (reliability floor) is the natural instrument:
on detecting a zombie, capture exit code + memory + Event Log **before** recovering. That turns recovery
into diagnosis and would confirm or refute D. (Design note: the supervisor's own auto-relaunch must use
`env -u CLAUDECODE … --detach` — or whatever replaces it once A is settled — or it reproduces A on the
recovery.)

## Cross-references

- Fix plan: `.agents/plans/2026-07-05-agentic-loop-automation.md` — **WS3** (exit-66 bash-tail fix ·
  `--detach` fix-or-removal · wedge watchdog + zombie auto-recovery · `gh` pre-flight).
- Deep design: `docs/superpowers/specs/2026-07-05-execution-reliability-floor-design.md` — the
  classifier, the two-stage wedge detector, the kill mechanism, phased shadow-first rollout.
- Evidence: `docs/retros/worked-failures.md` (search `archon-worker-killed-midrun`,
  `impl-node-idle-stream-wedge`, `gh-auth-account-flip`).

---

## Addendum — 2026-07-05 (evening): root cause confirmed

Full-source investigation against Archon v0.5.0 (source build, commit `59bbd00b` at failure
time), the live `archon.db`, the surviving executor stdout log
(`~/.archon/logs/nplus1-approve-resume.out`), and the Windows event log.

### Verdict

**Cause C (exit-66 bash-tail) is Windows Modern Standby / sleep during the run.** The
slash-in-workspace-key theory is **falsified**: node `reuse-done` — whose entire script is
`printf 'DONE\n'`, no paths, no keys — exit-66'd identically, and clean runs use the same
workspace paths. The host is a Modern Standby machine (`powercfg /a`: "Standby (S0 Low Power
Idle) Network Disconnected"); it enters standby whenever the screen turns off, independent of
the 120-min sleep timer.

### Mechanism

1. Runs are dispatched; operator walks away; screen-off drops the machine into Modern Standby
   (or full sleep) while executors sit inside long AI/bash nodes.
2. The in-flight node usually survives the freeze (its subprocess thaws and finishes — e.g. the
   Jul-1 `implement-backend` reported `durationMs` 12m57s across ~30 min of wall clock = a
   17-min freeze hole).
3. Once the executor process has crossed a deep freeze, **every new bash child it spawns exits
   in ~20 ms with code 66 and zero stdout/stderr**, and keeps doing so for the life of that
   process (still broken 12 min after wake on Jul 1). Fresh processes on the same machine are
   healthy at the same moment — which is why resume/manual-finish always works.
4. Exit 66 is bash's own `EX_NOINPUT` ("cannot open input", bash `shell.h`) — bash dying during
   startup/stdio init; its error message is lost in the same broken stderr pipe. Pino logfields
   confirm `exitCode:66, killed:false, isTimeout:false` and **no `stderrTail` at all**.
5. All bash nodes in the topological tail fail within the same second → `trigger_rule` skip
   cascade → run failed / manual finish. The DB row correctly records `failed` (this variant is
   not a zombie); the zombie variant is the same standby event killing the process outright.

### Evidence (all 7 exit-66 runs vs. power events; local = UTC+7)

| Run | Cascade (local) | Power context |
|---|---|---|
| 43a580a4 (Jul 1) | 20:58:50 | frozen through standby 20:16:39→20:46:46 (17-min hole in a 13-min node); first-ever bash spawn of the resume process → 66 |
| 3b0b8579 (Jul 4) | 17:29:47 | inside standby 16:35:16→17:41:01 |
| 5804569e (Jul 4) | 17:38:52 | inside same window |
| 91d9ff83 (Jul 4) | 17:42:13 | 72 s after that window's exit |
| 33c2d5a4 (Jul 5) | 10:24:16 | **18 s after wake** (Power-Troubleshooter event 10:23:58); its "43-min validate" = ~1 min work + 42-min sleep (slept 09:42:10) |
| ba79c8ad (Jul 5) | 14:46:52 | inside standby 14:37:39→14:50:41 |
| a624f5c3 (Jul 5) | 14:49:13 | inside same window; bash nodes in the SAME run ran fine 14:05→14:33, before the freeze |

Controls: eff2e16d (Jul 5, completed) ran its whole bash tail 15:39–15:45 awake; 57c862e8's
resumed process crossed one **shallow 9-min** standby mid-`validate` and stayed healthy — deep
freeze (DAM phase reached) appears to be the poisoning ingredient, so a standby crossing is
present in 7/7 failures but a brief crossing is not always sufficient.

### Hypotheses tested and falsified

- **Slash-in-workspace-key** — `printf 'DONE\n'` failing kills it; path layout identical on clean runs.
- **fd exhaustion** — 8,188 open fds in a Bun process: bash still spawns fine.
- **Env-block corruption** — bash spawns fine even with an empty env (no `SystemRoot`, no `TMP`).
- **PATH shadowing** — no `bash.*` in any failed worktree root or `~/.bun/bin`.
- **Plain process suspension** — `NtSuspendProcess` 90 s → spawns resume cleanly; the trigger is
  standby-specific (DAM job-freeze + device/session transitions), not mere thread suspension.
- **Bun mapping a spawn error to "66"** — Bun surfaces uv_spawn failures as errno strings
  (`EFTYPE`, `ENOENT`), so numeric 66 is a genuine child exit.

### Cause-by-cause disposition (supersedes "Current state" above)

- **A (launcher-reap): settled.** `--detach` is `Bun.spawn().unref()`
  (`packages/cli/src/commands/workflow.ts`); the CLI strips `CLAUDECODE` + `CLAUDE_CODE_*` at
  boot (`packages/cli/src/cli.ts:12` → `@archon/paths` `stripCwdEnv`), so **`env -u CLAUDECODE`
  is stale advice for v0.5.0**. A detached child survives launcher exit (a dead intermediate
  parent breaks Windows tree-kill walks). `--detach` does NOT protect against standby.
- **B (shell signals): unchanged** — avoid `archon | head` and `&`-in-foreground.
- **C (exit-66): SOLVED** — Modern Standby/sleep, mechanism above.
- **D (resource pressure): reframed.** Real, confirmed leak: failed runs strand their
  `claude.exe` subprocesses (4 orphans observed, 270–463 MB each, oldest 13 h). Memory pressure
  as a *kill* cause remains unproven; most D-suspects (kills 26–52 min into heavy nodes,
  concurrent-worker clustering) rescore as standby events — heavy long nodes simply maximize the
  probability that the idle screen-off lands inside them.
- **E (wedge): partially explained.** The "2 running rows" at capture were one healthy run
  (57c862e8, legitimately long CI-watch after a resume) and standby casualties; live-but-silent
  wedges are consistent with a process frozen by standby that the operator observes before wake.
- **F (stream-drop): unchanged**, plus a new adjacent bug: an AI node that ended with the API
  error **"Prompt is too long" was recorded `dag_node_completed`** — the
  `errorSubtype === 'success'` exemption (`packages/providers/src/claude/provider.ts`
  `isRealError`; `packages/workflows/src/dag-executor.ts` result guard) lets API-error result
  text through as node output. File as a follow-up issue.

### Prevention + recovery

- **Prevent (operational, today):** keep the machine awake while runs are active — on Modern
  Standby hardware the screen-off timeout is what matters: `powercfg /change
  monitor-timeout-ac 0` (or PowerToys Awake during dispatch windows).
- **Prevent (engine fix):** `.claude/archon/plans/keep-awake-during-runs.plan.md` —
  `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)` held for the duration of every run.
- **Diagnose (engine fix):** `.claude/archon/plans/poisoned-spawn-classification.plan.md` —
  silent-exit-66 failures get an actionable infra diagnosis + `infra_class:
  'suspend_poisoned_spawn'` event tag, no in-process retry, until_bash fail-fast.
- **Recover (unchanged, now explained):** `archon workflow resume <run-id>` for `failed` runs —
  a fresh process is unpoisoned by construction. Failed-then-cancelled still needs fresh relaunch.

### Where the evidence lives (for re-verification)

- Executor stdout with pino logfields: `~/.archon/logs/nplus1-approve-resume.out` (lines around
  `dag_node_failed` show `exitCode:66, killed:false`, no `stderrTail`).
- Event timelines: `remote_agent_workflow_events` in `~/.archon/archon.db`
  (`event_type='node_failed' AND data LIKE '%exit 66%'`).
- Power events: `Get-WinEvent` System log, Kernel-Power 506 (enter Modern Standby) / 507 (exit),
  Power-Troubleshooter 1 (wake). **Locale gotcha:** this host renders Thai Buddhist years —
  build dates with `Get-Date -Year 2026 -Month 7 -Day 5` (component form), never string
  literals like `'2026-07-05'`, which parse as BE 2026 = CE 1483 and match nothing.
