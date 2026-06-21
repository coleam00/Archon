# Event Contract: Retry Epochs And Retry Events

## Event Types

Add to `WORKFLOW_EVENT_TYPES`:

- `node_retry_requested`
- `node_retry_reset`
- `node_retry_failed`

Lifecycle node events emitted during a retry should include `data.retry_epoch`.

Retry audit events are mandatory. They should be written through a DB operation that reports failure to the retry preparation service; do not rely only on the normal non-throwing workflow-store event writer for these three event types.

If retry setup progress is surfaced live through the in-process workflow event emitter, add matching `WorkflowEmitterEvent` variants instead of overloading existing node skipped/failed events.

## `node_retry_requested`

```json
{
  "event_type": "node_retry_requested",
  "step_name": "build",
  "data": {
    "runId": "run-uuid",
    "node_id": "build",
    "retry_epoch": 1,
    "invalidated_node_ids": ["build", "test"],
    "requester_surface": "web",
    "requester_user_id": "user-uuid",
    "authorization_basis": "owner"
  }
}
```

Rules:

- Written only after validation, authorization, CAS, and epoch increment have succeeded.
- If Web/API identity is required but unavailable, fail before this event.

## `node_retry_reset`

```json
{
  "event_type": "node_retry_reset",
  "step_name": "build",
  "data": {
    "node_id": "build",
    "retry_epoch": 1,
    "checkpoint_ref": "refs/archon/checkpoints/run-uuid/0/build",
    "checkpoint_commit_sha": "def456",
    "safety_ref": "refs/archon/retry-safety/run-uuid/1",
    "safety_commit_sha": "abc123",
    "reset_skipped": false
  }
}
```

Rules:

- Written after safety ref/commit and checkpoint reset succeed.
- `safety_ref` and `safety_commit_sha` are `null` when reset is skipped; otherwise they record the created safety ref and the commit it points at.
- `reset_skipped` is true for allowed no-reset paths, such as `mutates_checkout: false` with no checkpoint reset.

## `node_retry_failed`

```json
{
  "event_type": "node_retry_failed",
  "step_name": "build",
  "data": {
    "node_id": "build",
    "retry_epoch": 1,
    "setup_phase": "checkpoint_validation",
    "error": "Checkpoint ref did not resolve to a commit"
  }
}
```

Rules:

- Written when setup/reset fails after accepted setup starts.
- Run status must be restored to `failed`.
- Executor dispatch must not occur.

## Lifecycle Events During Retry

Example:

```json
{
  "event_type": "node_completed",
  "step_name": "build",
  "data": {
    "retry_epoch": 1,
    "node_output": "ok",
    "duration_ms": 4212
  }
}
```

Rules:

- Missing `retry_epoch` is interpreted as `0`.
- Later epoch events override older epochs for latest effective node state.
- Old events remain in history.

## Dashboard/SSE Mapping

Persisted retry events should trigger existing dashboard refetch behavior:

- `node_retry_requested` -> `workflow_status` with status `running`
- `node_retry_reset` -> `workflow_status` with status `running`
- `node_retry_failed` -> `workflow_status` with status `failed`

No new frontend SSE event type is required in v1.
