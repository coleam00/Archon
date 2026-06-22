# Clarifications — Manual Failed-Node Retry Decisions

**Status:** ARCHIVED
**Applied:** 2026-06-21-221245
**Generated:** 2026-06-21T22:06:12+07:00
**Spec:** spec.md
**Mode:** batch

**Instructions:**

- Edit each `Your Answer:` line below.
- Type an option letter (A/B/C/...), or `recommended` / `yes` / `suggested` to accept the suggestion, or your own short answer (<=5 words).
- Leave the line blank to skip a question.
- Save the file, then re-run `/clarifybatch` (or `/clarifybatch --apply`) to apply all answers in one pass.

---

## Q1. When a run has multiple latest failed nodes, including a failed downstream node whose ancestor also failed, which failed nodes are eligible retry targets?

**Category:** Functional Scope & Behavior
**Why it matters:** This changes UI button eligibility, CLI validation, invalidation scope, and tests for DAGs with `all_done` or partially failing downstream nodes.
**Recommended:** Option A - The current spec already says retry is exposed for nodes whose latest effective status is `failed`; allowing any failed node keeps the operation user-directed while preserving target-plus-descendants invalidation.

| Option | Description                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| A      | Any node whose latest effective status is `failed` is eligible, even if an upstream dependency also failed.                       |
| B      | Only failed nodes with no failed ancestor are eligible; downstream failures must be retried through the earliest failed ancestor. |
| C      | Only the first failed node by topological order is eligible per failed run.                                                       |
| Short  | Provide a different short answer (<=5 words).                                                                                     |

**Your Answer:** A
**Reason:** The spec says retry is exposed for nodes whose latest effective status is `failed` and separately says invalidation is "the retry target plus all descendants" (spec.md:104, spec.md:109). It only blocks downstream `skipped` nodes, not failed descendants of failed ancestors (spec.md:107).

---

## Q2. Where should `retry_epoch` be stored for workflow lifecycle events?

**Category:** Domain & Data Model
**Why it matters:** The current events table has a JSON `data` payload and no retry epoch column; adding a column changes migrations, projections, and query APIs.
**Recommended:** Option A - Store `retry_epoch` inside each event's `data` JSON using snake_case. Existing event readers already parse `data`, and missing values can naturally default to epoch `0`.

| Option | Description                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------- |
| A      | Store `retry_epoch` in `remote_agent_workflow_events.data` JSON for lifecycle and retry events.         |
| B      | Add a nullable `retry_epoch` column to `remote_agent_workflow_events` and backfill/read missing as `0`. |
| C      | Store retry epoch only in `workflow_runs.metadata` and infer event epoch by timestamp/order.            |
| Short  | Provide a different short answer (<=5 words).                                                           |

**Your Answer:** A
**Reason:** Workflow events already have a JSON `data` record in the row schema and writes serialize that payload into `remote_agent_workflow_events.data` (packages/core/src/schemas/workflow-event.ts:10, packages/core/src/db/workflow-events.ts:70). The spec also says missing event `retry_epoch` values are epoch `0`, which is a natural JSON-payload default (spec.md:119).

---

## Q3. What canonical local git ref namespace should checkpoints and retry safety refs use?

**Category:** Domain & Data Model
**Why it matters:** Cleanup requires deleting refs by run prefix, and retry reset needs deterministic refs that are local-only and easy to validate.
**Recommended:** Option A - Use one namespaced ref per run/epoch/node checkpoint and one per run/epoch safety point. This makes lookup, validation, and cleanup by run id straightforward without inventing branch names.

| Option | Description                                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | Checkpoints: `refs/archon/checkpoints/<runId>/<retryEpoch>/<nodeId>`; safety refs: `refs/archon/retry-safety/<runId>/<retryEpoch>`.                   |
| B      | Checkpoints: `refs/archon/checkpoints/<runId>/<nodeId>` overwritten per epoch; safety refs: `refs/archon/retry-safety/<runId>` overwritten per retry. |
| C      | Use local branches named `archon/checkpoint/<runId>/...` and `archon/retry-safety/<runId>/...`.                                                       |
| Short  | Provide a different short answer (<=5 words).                                                                                                         |

**Your Answer:** A
**Reason:** The checkpoint table is keyed by `(workflow_run_id, node_id, retry_epoch)`, so the ref namespace should carry the same run/epoch/node identity (spec.md:135). Both checkpoint commits and refs must stay local-only, which fits `refs/archon/...` better than branches (spec.md:159).

---

## Q4. When should the run status CAS from `failed` to `running` happen relative to retry reset/setup?

**Category:** Edge Cases & Failure Handling
**Why it matters:** This controls double-click/concurrent retry behavior and whether failed reset attempts can leave the run in a clear final state.
**Recommended:** Option B - CAS to `running` at the start of accepted setup locks out concurrent retry requests; if setup/reset fails, write `node_retry_failed` and set the same run back to `failed` before returning the error.

| Option | Description                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| A      | Do all reset/setup while the run is still `failed`, then CAS to `running` immediately before dispatch.        |
| B      | CAS and increment epoch at the start of accepted setup, then restore status to `failed` if setup/reset fails. |
| C      | Create a separate pending retry marker and leave the run status `failed` until dispatch begins.               |
| Short  | Provide a different short answer (<=5 words).                                                                 |

**Your Answer:** B
**Reason:** The API requirement says retry must use compare-and-swap from `failed` to `running`, while reset failures must write `node_retry_failed`, leave the run `failed`, and not dispatch (spec.md:218, spec.md:183). Existing resume uses a CAS specifically to prevent double-claiming the same run/worktree (packages/core/src/db/workflows.ts:457).

---

## Q5. When checkpointing or retry-safety committing a dirty checkout, which files should be committed?

**Category:** Constraints & Tradeoffs
**Why it matters:** `git reset --hard` only resets tracked files, while adding untracked files to safety commits could unexpectedly pull generated or private files into branch history.
**Recommended:** Option A - Commit tracked dirty changes only and leave untracked/ignored files untouched. This matches the v1 tradeoff that retry resets tracked files only and does not delete untracked or ignored files.

| Option | Description                                                                     |
| ------ | ------------------------------------------------------------------------------- |
| A      | Commit tracked dirty changes only; leave untracked and ignored files untouched. |
| B      | Commit tracked changes plus untracked files, but exclude ignored files.         |
| C      | Commit all dirty files including ignored files.                                 |
| D      | Fail retry setup when untracked files are present.                              |
| Short  | Provide a different short answer (<=5 words).                                   |

**Your Answer:** A
**Reason:** The spec's concrete reset invariant is tracked-only: manual retry must not run `git clean` and must not delete untracked or ignored files (spec.md:186, spec.md:187). Committing untracked or ignored files would pull files outside that v1 reset contract into local history.

---

## Q6. How should invalidated target/downstream nodes appear after retry is accepted but before their new lifecycle events arrive?

**Category:** Interaction & UX Flow
**Why it matters:** The graph otherwise may keep showing stale failed/skipped/completed states from an earlier epoch until each retried node emits a new event.
**Recommended:** Option A - Project invalidated nodes as `pending` for the active retry epoch until they emit `node_started`, `node_completed`, `node_failed`, or `node_skipped`.

| Option | Description                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| A      | Run detail/API/UI projection marks invalidated nodes `pending` in the latest retry epoch until new lifecycle events arrive. |
| B      | Keep old node states visible until each invalidated node emits a new lifecycle event.                                       |
| C      | Emit synthetic `node_skipped` events for invalidated nodes, then replace them when rerun.                                   |
| Short  | Provide a different short answer (<=5 words).                                                                               |

**Your Answer:** A
**Reason:** The spec requires run detail and Web UI state to be derived by retry epoch so older failed/skipped events cannot override later retry state (spec.md:128). Marking invalidated nodes `pending` is the direct projection of "old invalidated outputs are ignored" until new lifecycle events arrive (spec.md:126).

---

## Q7. Which retry events should trigger live Web UI refetches through SSE/dashboard polling?

**Category:** Non-Functional Quality Attributes
**Why it matters:** Existing dashboard polling only maps selected workflow/node events to SSE; adding every retry marker as a custom event increases frontend surface area.
**Recommended:** Option A - Add retry events to the poller whitelist only as refetch triggers: `node_retry_requested` and `node_retry_reset` map to a running workflow-status refresh, and `node_retry_failed` maps to failed.

| Option | Description                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | Map retry events to existing `workflow_status` refetch triggers; keep node graph changes driven by run-detail projection and lifecycle events. |
| B      | Add a new frontend SSE event type specifically for retry setup/reset progress.                                                                 |
| C      | Do not add retry events to SSE/poller; rely only on explicit API response refetch and normal node lifecycle events.                            |
| Short  | Provide a different short answer (<=5 words).                                                                                                  |

**Your Answer:** A
**Reason:** The dashboard bridge already emits only `workflow_status` and `dag_node` events, and comments say the REST refetch is the source of truth (packages/server/src/adapters/web/workflow-bridge.ts:237). The spec only requires retry-relevant events in SSE/poller if they should update the Web UI live, so reusing status refetch triggers is the narrow path (spec.md:248).

---

## Q8. How should retry epochs distinguish old and new node artifacts/logs for the same run and node id?

**Category:** Integration & External Dependencies
**Why it matters:** The spec requires old artifacts/logs to remain available and distinguishable, but current run artifacts are keyed primarily by one run id and node id.
**Recommended:** Option A - Keep existing epoch 0 paths compatible, and write retry-attempt artifacts/logs under an epoch-qualified path segment for epoch `1+`.

| Option | Description                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| A      | Use epoch-qualified paths for retry epochs, e.g. `nodes/epoch-<N>/<nodeId>.*`, while leaving epoch 0 paths unchanged. |
| B      | Rename all node artifact/log paths, including epoch 0, to include an epoch segment.                                   |
| C      | Keep paths unchanged and distinguish attempts only through workflow event metadata.                                   |
| Short  | Provide a different short answer (<=5 words).                                                                         |

**Your Answer:** A
**Reason:** The spec requires old artifacts/logs to remain available and distinguishable by retry epoch (spec.md:83, spec.md:129). The artifact API already walks a run artifact directory and returns relative `path` strings, so adding an epoch segment for retry attempts preserves epoch 0 paths (packages/server/src/routes/api.ts:3785).

---

## Q9. When deleting or cleaning up a workflow run, should cleanup remove retry safety refs as well as checkpoint refs?

**Category:** Edge Cases & Failure Handling
**Why it matters:** The spec says cleanup deletes checkpoint refs by run prefix, but safety refs are also run-scoped local refs that can otherwise accumulate indefinitely.
**Recommended:** Option A - Delete both checkpoint refs and retry safety refs for the run during run deletion/old-run cleanup, logging warnings without breaking database cleanup.

| Option | Description                                                                            |
| ------ | -------------------------------------------------------------------------------------- |
| A      | Cleanup deletes both checkpoint refs and retry safety refs under the run id prefix.    |
| B      | Cleanup deletes only checkpoint refs; retry safety refs remain until manually removed. |
| C      | Cleanup deletes neither ref type automatically.                                        |
| Short  | Provide a different short answer (<=5 words).                                          |

**Your Answer:** A
**Reason:** Cleanup already must delete checkpoint refs by run prefix and warning-log ref cleanup failures without blocking database cleanup (spec.md:252, spec.md:254). Retry safety refs are also run-scoped local refs preserving the branch tip, so leaving them out would leak the same class of ref (spec.md:261).

---

## Q10. Should clean-checkout checkpoints create a named checkpoint ref, or store only the current commit SHA?

**Category:** Domain & Data Model
**Why it matters:** A named ref makes checkpoint lookup and cleanup uniform, but it also creates many local refs even when no checkpoint commit was needed.
**Recommended:** Option A - Always create/update the namespaced checkpoint ref and store both `checkpoint_ref` and `commit_sha`; use `created_commit: false` when the ref points at an existing `HEAD`.

| Option | Description                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------- |
| A      | Always create a checkpoint ref for each executable node checkpoint, even when the checkout is clean. |
| B      | For clean checkouts, store only `commit_sha` and set `checkpoint_ref` to the same SHA string.        |
| C      | For clean checkouts, store `checkpoint_ref: null` and use `commit_sha` for reset.                    |
| Short  | Provide a different short answer (<=5 words).                                                        |

**Your Answer:** A
**Reason:** The checkpoint row must store both `checkpoint_ref` and `commit_sha`, and clean checkouts must store current `HEAD` with `created_commit: false` (spec.md:136, spec.md:158). A named ref for clean checkpoints keeps reset lookup and run-prefix cleanup uniform.
