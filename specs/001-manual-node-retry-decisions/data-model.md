# Data Model: Manual Failed-Node Retry Decisions

## Workflow Run

Existing row in `remote_agent_workflow_runs`.

Additional metadata:

- `metadata.retry_epoch`: number; missing means `0`.
- Existing `status` remains one of `pending`, `running`, `completed`, `failed`, `cancelled`, `paused`.

State transitions:

- `failed -> running`: accepted manual retry setup CAS.
- `running -> failed`: retry setup/reset failure after CAS.
- `running -> completed`: retried execution succeeds.
- `running -> failed`: retried execution fails.

Validation rules:

- Manual retry accepts only runs whose current status is `failed`.
- CAS miss means another actor already changed the run; do not mutate git or dispatch.
- Web retry requires run ownership/admin authorization before transition.

## Workflow Node Checkpoint

New row in `remote_agent_workflow_node_checkpoints`.

Fields:

- `workflow_run_id`: run id; FK to `remote_agent_workflow_runs(id)` with cascade delete.
- `node_id`: workflow DAG node id.
- `retry_epoch`: integer; `0` for original run, `1+` for retried epochs.
- `checkpoint_ref`: local git ref, `refs/archon/checkpoints/<runId>/<retryEpoch>/<nodeId>`.
- `commit_sha`: commit SHA resolved for the checkpoint ref or current `HEAD`.
- `created_commit`: boolean; true when tracked dirty changes were committed for the checkpoint.
- `fallback_from_node_id`: nullable node id used when checkpoint row was created as a fallback record.
- `created_at`: timestamp.

Constraints:

- Unique key: `(workflow_run_id, node_id, retry_epoch)`.
- `retry_epoch >= 0`.
- `checkpoint_ref` must pass `git check-ref-format` before being written or used.
- `commit_sha` must pass `git rev-parse --verify <ref-or-sha>^{commit}` before reset.

Relationships:

- One workflow run has many checkpoint rows.
- One executable node can have one checkpoint per retry epoch.

## Retry Epoch

Attempt generation for a reused workflow run.

Fields/derivation:

- Current epoch is `workflow_runs.metadata.retry_epoch ?? 0`.
- Next accepted retry epoch is current epoch plus one.
- Missing `data.retry_epoch` in historical events means epoch `0`.

Validation rules:

- Increment exactly once per accepted manual retry.
- Do not increment for rejected validation, authorization failure, CAS miss, or setup failure before accepted setup starts.

## Invalidated Node Set

The retry target plus all descendants in the current workflow DAG.

Fields:

- `target_node_id`: selected failed node.
- `invalidated_node_ids`: ordered unique node ids, including target.
- `descendant_source`: current workflow definition.

Validation rules:

- Target node must exist in current workflow definition.
- Target latest effective status must be `failed`.
- Downstream `skipped` nodes are not direct retry targets.
- Independent siblings remain valid unless they depend on target.

## Retry Request Event

Stored in `remote_agent_workflow_events`.

Event type: `node_retry_requested`

Required data:

- `runId`
- `node_id`
- `retry_epoch`
- `invalidated_node_ids`
- `requester_surface`: `web` or `cli`
- `requester_user_id`: string or explicit unavailable marker for solo/local mode
- `authorization_basis`: examples `owner`, `admin`, `cli/solo`

Purpose:

- Audits the accepted retry request.
- Provides invalidation input for epoch-aware projection.

## Retry Reset Event

Stored in `remote_agent_workflow_events`.

Event type: `node_retry_reset`

Required data:

- `node_id`
- `retry_epoch`
- `checkpoint_ref`
- `checkpoint_commit_sha`
- `safety_ref`
- `safety_commit_sha`, when a safety commit was created
- `reset_skipped`: boolean

Purpose:

- Audits git reset/safety behavior.
- Triggers Web/dashboard refetch after setup succeeds.

## Retry Failure Event

Stored in `remote_agent_workflow_events`.

Event type: `node_retry_failed`

Required data:

- `node_id`
- `retry_epoch`
- `setup_phase`
- `error`

Purpose:

- Audits setup/reset failure.
- Explains why dispatch did not occur.
- Triggers Web/dashboard failed-status refetch.

## Retry Safety Ref

Local git ref, not a database row.

Format:

- `refs/archon/retry-safety/<runId>/<retryEpoch>`

Validation rules:

- Validate with `git check-ref-format`.
- Create/update before retry reset.
- If tracked dirty changes exist, commit tracked dirty changes first and point the ref to that safety commit.
- Do not include untracked or ignored files.

Cleanup:

- Delete by run prefix during workflow-run deletion and old-run cleanup.
- Cleanup failures log warnings and do not block DB cleanup.

## Persisted Workflow Node Session

Existing row in `remote_agent_workflow_node_sessions`.

Retry behavior:

- Delete rows for `(workflow_name, scope_key, node_id)` for every invalidated node.
- Do not filter by provider; delete all providers.
- Scope key should match existing persisted-session behavior, typically the run's `conversation_id`.

## Epoch-Aware Node Projection

Derived model, not a table.

Inputs:

- Workflow definition nodes.
- Workflow events ordered by creation.
- `node_retry_requested` invalidated sets.
- Event `data.retry_epoch` values with missing epoch as `0`.

Output per node:

- `node_id`
- latest effective `status`: `pending`, `running`, `completed`, `failed`, or `skipped`
- `retry_epoch`
- `output` for completed nodes
- `error` for failed nodes
- `reason` for skipped nodes
- `retry_eligible`: derived by surface, run status, latest effective status, and authorization/web eligibility

Rules:

- Later retry epoch for a node overrides earlier epochs.
- Invalidated nodes project as `pending` in the active retry epoch until new lifecycle events arrive.
- Outputs from invalidated nodes in older epochs are ignored for hydration and substitution.
- Non-invalidated upstream/sibling outputs remain usable.
