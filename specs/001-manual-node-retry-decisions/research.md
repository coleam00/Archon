# Research: Manual Failed-Node Retry Decisions

## Decision: Use A Shared Retry Preparation Operation, Not Existing Resume

**Decision**: Add a shared `prepareWorkflowNodeRetry()` operation in core and call it from both API and CLI. The operation prepares run state, git reset, checkpoint/safety refs, event history, and persisted-session deletion before execution dispatch.

**Rationale**: Existing resume is run-level and discovers failed/paused rows via `findResumableRun()`/`hydrateResumableRun()`. Manual retry must CAS `failed -> running` before dispatch, so foreground resume lookup would no longer find the row. A shared operation keeps API and CLI behavior consistent and centralizes the high-risk mutation boundary.

**Alternatives considered**:

- Reuse `/workflow run <name>` after CAS: rejected because current lookup only finds failed/paused runs.
- Keep retry setup in the server route and duplicate in CLI: rejected because git reset and retry epoch semantics must not drift.
- Add native `manage_run` support: rejected by v1 spec.

## Decision: Store Retry Epoch In Run Metadata And Event Data

**Decision**: Store current epoch in `workflow_runs.metadata.retry_epoch`; store per-event epoch as `data.retry_epoch`; treat missing event epochs as `0`.

**Rationale**: The events table already carries JSON `data`, existing rows need epoch `0` compatibility, and the run row metadata is the right place for the latest accepted retry generation. Avoiding an events column keeps migration scope smaller while preserving event history.

**Alternatives considered**:

- Add `retry_epoch` column to `workflow_events`: rejected because JSON data already supports this and all event readers parse it.
- Infer epochs by timestamp: rejected because it is fragile around concurrent writes and old events.

## Decision: Add A Dedicated Checkpoint Table

**Decision**: Add `remote_agent_workflow_node_checkpoints` keyed by `(workflow_run_id, node_id, retry_epoch)`, with checkpoint ref, commit SHA, created-commit flag, fallback node id, and timestamps.

**Rationale**: Retry reset must be able to find the latest prior checkpoint deterministically without scanning unstructured events. A table gives queryable state, FK cleanup, and a clear schema contract for SQLite/PostgreSQL convergence.

**Alternatives considered**:

- Store checkpoints only in workflow events: rejected because reset lookup becomes event-log interpretation rather than storage contract.
- Store checkpoints only in run metadata: rejected because per-node/per-epoch state would grow and be hard to query/update.

## Decision: Create Local Git Refs For Both Clean And Dirty Checkpoints

**Decision**: Always create/update `refs/archon/checkpoints/<runId>/<retryEpoch>/<nodeId>` for executable node checkpoints, even when the checkout is clean and no commit is created.

**Rationale**: A named ref makes reset lookup and cleanup uniform. Clean checkpoints still store `commit_sha` and `created_commit: false`.

**Alternatives considered**:

- Store only SHAs for clean checkpoints: rejected because cleanup and reset code would need two paths.
- Use local branches: rejected because branch names would be more visible and less clearly internal than namespaced refs.

## Decision: Commit Tracked Dirty Changes Only

**Decision**: Checkpoint and safety commits include tracked dirty changes only. Untracked and ignored files are left untouched and are never deleted by retry.

**Rationale**: The reset contract is tracked-file-only. Existing `commitAllChanges()` stages `-A`, so this feature needs a narrower helper based on tracked-only status/staging.

**Alternatives considered**:

- Commit untracked files too: rejected because it can pull private/generated files into history.
- Fail when untracked files exist: rejected because untracked leftovers are an accepted v1 tradeoff.
- Use stash: rejected because the spec explicitly chooses commits/refs and fail-fast git identity guidance.

## Decision: Epoch-Aware Projection Is The Source Of Truth For Latest Node State

**Decision**: Implement a helper that folds workflow events by retry epoch, applies invalidated node sets from retry events, and derives latest effective node status/output.

**Rationale**: Current run detail and Web UI logic use latest node events without epoch boundaries. Once a run is reused, old `node_failed`/`node_skipped` events must not override later retry events or pending invalidation.

**Alternatives considered**:

- Delete old events on retry: rejected because audit history must remain.
- Add synthetic skipped events for invalidated nodes: rejected because it pollutes history and obscures the distinction between invalidation and real execution.
- Leave UI stale until new lifecycle events arrive: rejected by clarification that invalidated nodes should project as `pending`.

## Decision: Retry Uses Current Workflow DAG For V1

**Decision**: Descendant calculation and target validation use the current workflow definition at retry time.

**Rationale**: This matches the accepted v1 tradeoff and origin requirement. Persisted workflow identity/replay is a future integrity feature, not part of this implementation.

**Alternatives considered**:

- Persist and replay original workflow content: accepted as a stronger future design, rejected for v1 because it changes the execution contract.
- Block when workflow file changed: rejected for v1; would require reliable original workflow identity.

## Decision: Web Retry Requires Server-Side Authorization

**Decision**: Resolve the authenticated Web requester before any mutation. If the run has `user_id`, requester must be that user or an admin. Runs without `user_id` are retryable only in unauthenticated solo/local mode.

**Rationale**: Manual retry mutates local git state and reruns agent work. UI hiding is insufficient; the server route must guard direct requests.

**Alternatives considered**:

- Trust runId opacity or web-created origin: rejected by red-team finding.
- Delay authorization until dispatch: rejected because safety refs, commits, reset, and epoch mutation already happen during setup.

## Decision: Retry Events Reuse Existing Dashboard Refetch Channel

**Decision**: Map `node_retry_requested` and `node_retry_reset` to a `workflow_status` running refetch trigger, and `node_retry_failed` to a failed refetch trigger.

**Rationale**: The dashboard bridge already treats REST refetch as source of truth. A new SSE event type would broaden frontend state when a refetch is enough.

**Alternatives considered**:

- Add custom retry SSE events: rejected for v1 because it increases browser state surface.
- Rely only on API response refetch: rejected because CLI/out-of-process retry events also need live dashboard updates.
