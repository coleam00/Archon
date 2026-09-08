# Bounded merge queue

`archon-merge-queue` accepts an explicit JSON array of **one to five** qualified
PR references in one repository and base. It is supervised by default: both
gates require a native `approve` or `hold` decision, with response text retained
as notes. Reordering requires a fresh run. A project can explicitly authorize
the bounded automatic path below. There is no scheduler, label intake, global
queue, or factory setting.

## Project-owned automatic policy

Commit `.archon/merge-queue-auto.json` on the PRs' base before starting the run:

```json
{
  "version": 1,
  "mode": "automatic",
  "max_prs": 5,
  "max_files": 10,
  "max_changed_lines": 300
}
```

These are the complete typed policy fields. Integer limits must be positive
and cannot exceed the shown hard bounds. Lower limits are supported. Unknown
fields, versions, modes, duplicate fields, booleans as integers, and symlinks
refuse automatic authorization and visibly require a human. The path is fixed;
there is no caller file or path input. Only `git show ORIGINAL_BASE:path` supplies
policy content, with its exact Git blob hash retained as `source_policy_hash`.
An absent policy always means supervision. An uncommitted file, `publish=true`,
agent receipt, or install setting cannot enable this mode.

Before moving off the original base, a bounded native loop includes
`archon-triage` once per PR, with publication disabled and fresh context. That
agent reads the PR and judges which single original work item it implements.
Absent, ambiguous, inaccessible, or unrelated source context must return a
non-ready disposition, never a contract inferred from the PR self-report. The
queue independently reads the attributed issue through `forge workitem view`,
pins its body and identity, and hashes the fresh triage report. The shared triage
producer currently attributes only github.com issues; other sources require
supervision until that producer supports them.

Triage must report `READY`, route `deliver`, `design_first: false`, and
`small_bounded`. An independent read-only diff assessment must also report
`small_bounded`. Both use the shared triage complexity vocabulary:
`small_bounded`, `risky`, `large`. Risk, uncertainty, context gaps, disagreement,
missing attribution, or incomplete triage requires the native order gate.
If diff assessment fails to produce output, it remains null and the gate
explicitly presents the original intake order for human review. Holding the
order ends the queue without a second approval request.

The order decision authorizes preparation only. It requires the policy, fresh
triage, bounded diffs, and actual positive green external checks with known
required-check state. The candidate decision separately authorizes the exact
tested chain. It additionally requires independent green composition review,
positive applicable project checks, and all existing evidence/identity guards.
File and added-plus-deleted-line limits apply to each PR and every cumulative
candidate against the original base. Binary changes require supervision.
Changes to either queue policy file require supervision. A PR cannot grant
itself authority by adding or modifying policy.

Both decisions are typed `automatic_policy` or `human_required`, carry distinct
`order`/`candidate` stages, snapshot hashes and policy blob identity, and appear
in native node outputs, the report, and `queue.json`. The order snapshot binds
PR/head/base, triage source and report hashes, checks, and assessment. The
candidate snapshot binds the tested parent chain and review/check evidence.
Composition review receives the attributed original work order when available.
Automatic receipts preserve that decision; they never fabricate a native
`approve` response. Skipped gates deliver null, which the computation accepts
only for the corresponding pinned automatic decision.

An automatic attempt with missing/red checks or failed review reaches a genuine
native candidate gate showing the held evidence. Human approval cannot waive a
failed merge guard; correction and a fresh run are required. The legacy no-CI
exception below is supervised-only. Policy, evidence, source context, head,
base, and external CI are checked again before mutation. Pausing or resuming
cannot change input, order, candidate, policy or evidence.
Every script invocation checks the resolved PR input against the pinned intake,
including invocations after a native approval pause. Runtime-suite
eligibility may be an additional caller requirement; the queue does not claim
to have run `archon-verify-runtime-suite`.

The engine creates the working checkout. Use a fresh default `archon/task-*`
branch or an explicit `archon/merge-queue-*` branch, starting at the PR base.
The computation verifies the native run's recorded checkout, linked worktree,
dedicated unpublished branch, clean index/worktree, and pinned starting HEAD
before moving revisions. It never creates a worktree, resets, cleans, or pushes.
The forge owner alone publishes commits.

## Example

From a registered repository with two ready, same-repository PRs targeting `dev`:

```sh
archon workflow run archon-merge-queue --base dev --detach --json \
  --input 'prs=[{"repo":{"host":"github.com","path":"example/widget"},"number":12},{"repo":{"host":"github.com","path":"example/widget"},"number":15}]' \
  'These accepted fixes are waiting for manual merge coordination. Landing them together clears the release backlog, and the release is ready now. Merge both after independent composition review and checks. Preserve the documented public API. Acceptance: both exact tested candidates land in approved order; hold on failed checks, conflicts, or identity changes.'
archon workflow get RUN_ID --json
archon workflow respond RUN_ID approve 'Reviewed the pinned intake and order'
# Inspect the candidate gate's exact SHA chain and per-candidate evidence first.
archon workflow respond RUN_ID approve 'Reviewed the tested candidate chain'
archon workflow get RUN_ID --json
```

Use `hold` instead of `approve` to retain the queue without publication. The first
gate approves intake/order; the second approves the complete tested chain. The
two gates are top-level. Native bounded `loop_group` nodes own repetition, with
load-time `archon-triage`, `archon-review`, and `archon-validate` includes.

## State, evidence, and recovery

`$ARTIFACTS_DIR/queue.json` is the single run-owned queue record. Updates use a
flushed temporary file and atomic replacement. Intake, assessment, order,
candidate identities, evidence hashes, and gate receipts are immutable on
resume. The record includes every item's status, source PR, expected base,
candidate, and merge request/result. Readers can render it through the ordinary
run artifact surface. It is not a shared lock or a cross-run queue.

Each candidate is a two-parent commit: the pinned base (or preceding tested
candidate) followed by the pinned PR head. Review receives the exact local
`base..candidate` range, without forge reads or publication. Validation runs the
project's applicable checks. A candidate needs `ready: true`,
`checks_performed: true`, `green: true`, report files, unchanged HEAD, and a clean
checkout. Inherited or environment red does not waive this requirement.

Evidence is copied into `candidates/<sha>/`; prior canonical include reports
are moved to `prior-evidence/<id>/` before the next candidate. Failed composition
evidence remains available too. No prior run's artifact directory is written.
Missing node output remains missing; the queue does not infer a child outcome.
If evidence production was interrupted, a new queue is required for independent
review instead of silently treating old reports as fresh.

External CI must be green at the pinned PR head, with known required-check
state. `none` is not green. The sole exception is an independently committed
`.archon/merge-queue-policy.json` at the original pinned base containing exactly
`{"external_ci":"none"}`, with the forge reporting zero required checks.
Configured required checks cannot be waived by this file or a human gate.
Unknown required-check policy holds the queue. Local checks must still run.

The merge loop visits each approved candidate in the owned checkout, submits
`pr.merge-pinned` with the exact head/base refs and SHAs, candidate SHA, and
checkout, and records the returned identity. Independent runs compete through
the forge owner's atomic head/base comparison, never through the local file.
Upstream movement holds the remainder; the workflow does not rebuild approved
candidates. Conflicts produce head/base-bound correction findings naming the
source PR. Run native delivery separately to repair and independently review
that PR, then start a new queue.

A definitive refusal with `publication: not_attempted` is failed/held. An absent
or uncertain response leaves the exact request in `queue.json` and fails the
node. Resume the failed native run with `archon workflow run archon-merge-queue
--resume RUN_ID`; recovery resubmits that identical request to the owning forge
operation, which must return `already_merged` for an applied identity. It never
resolves a replacement head or base. Repeated completed-item replay cannot
publish again. An operator must retain the worktree and artifacts until recovery
settles. A process interrupted between checkout movement and its checkpoint
fails closed and requires inspection; no publication has been requested yet.

## Prerequisites and private integration

This workflow depends on the public `pr.view` owner (#3042) and the generic
`pr.merge-pinned` owner. The initial branch was developed from forge `c3169889`,
with their schemas read from the separate prerequisite worktrees. The queue does
not implement either operation. Unsupported plugins fail through the public
CLI, with no `gh` fallback. Same-repository heads are supported; fork PRs require
a future qualified fetch capability and currently fail explicitly.

The committed tests use real temporary Git graphs and actual queue computations,
with simulated agents and public CLI transport. They are not evidence of a live
forge merge. To check the owners before integration, set these environment
variables to their absolute schema files and run the focused tests:

```sh
export ARCHON_MERGE_QUEUE_PUBLIC_SCHEMA=/path/to/public-owner/packages/forge/src/schemas.ts
export ARCHON_MERGE_QUEUE_PINNED_SCHEMA=/path/to/pinned-owner/packages/forge/src/pinned-merge-schemas.ts
bun --cwd packages/workflows test src/defaults/merge-queue.test.ts src/defaults/merge-queue-auto.test.ts src/defaults/merge-queue-graph.test.ts
```

Without the pinned owner, the schema conformance case is explicitly skipped.
After integration it defaults to the repository's own source and must pass.
The checks producer must also populate the optional `required` summary: the
GitHub producer at `c3169889` does not, so that version correctly holds every
candidate as unknown required-CI policy. Integrating `pr.view` and
`pr.merge-pinned` alone does not establish this missing evidence. Resolve it in
the owning forge producer before the live procedure; do not weaken the queue.

For the private integration check:

1. Integrate the finished public and pinned owners into an isolated checkout,
   regenerate bundles, and run `bun run validate` and the focused tests above.
   Inspect `archon forge pr merge-pinned --help` and the installed plugin's
   capabilities; do not substitute forge-specific shell implementations.
2. In a disposable **private** repository, create an isolated base branch with
   runnable project checks and known external CI policy. Create two ready PRs
   with independent green changes. Their bodies must state the problem, value,
   timing, outcome, invariants, and acceptance. Install the integrated SDLC pack
   or use `--workflow-source /path/to/integrated-checkout` on the example command.
3. Launch the example against those qualified refs and that isolated base.
   Confirm the native order gate pauses before candidate construction. Hold once
   and verify that the remote base did not move. Start a fresh run and approve.
4. At the candidate gate, inspect both parent pairs, full review reports,
   validation commands/results, and preserved evidence hashes. Restart/resume
   while paused and verify the same candidate snapshot remains authoritative.
   Approve, wait for terminal completion, then read the remote base and each PR
   through the integrated forge owner. Confirm the exact candidate chain landed.
5. Repeat with individually green changes whose combined test is red, a textual
   conflict, absent/red external checks, and a head or base moved while paused.
   Confirm no affected candidate publishes and dependent entries are held.
6. Exercise response loss using the forge owner's transport fault fixture,
   retaining the same run/checkpoint. Resume and verify `already_merged`, exact
   parent read-back, and no duplicate publication. Save run IDs, queue files,
   transcripts, gate receipts, and observed remote refs as integration evidence.

Only the operator performing that private procedure can report a live merge.
Any live isolated-base merge belongs to the operator's separate integration run.
