# API Contract: Manual Node Retry

## Endpoint

```http
POST /api/workflows/runs/{runId}/nodes/{nodeId}/retry
```

Route registration:

- Must use `registerOpenApiRoute(createRoute({...}), handler)`.
- Path params use OpenAPI syntax `{runId}` and `{nodeId}`.
- Schemas live in `packages/server/src/routes/schemas/workflow.schemas.ts`.

## Path Parameters

| Name     | Type   | Required | Notes                                        |
| -------- | ------ | -------- | -------------------------------------------- |
| `runId`  | string | yes      | Workflow run UUID or stored id               |
| `nodeId` | string | yes      | DAG node id from current workflow definition |

## Request Body

No body for v1.

## Success Response

Status: `200`

```json
{
  "success": true,
  "message": "Retrying node build and 2 downstream node(s).",
  "runId": "run-uuid",
  "nodeId": "build",
  "retryEpoch": 1,
  "invalidatedNodes": ["build", "test", "summarize"],
  "safetyCommitSha": "abc123..."
}
```

Fields:

- `success`: true.
- `message`: human-readable status.
- `runId`: run being reused.
- `nodeId`: target node.
- `retryEpoch`: accepted epoch after increment.
- `invalidatedNodes`: target plus current-DAG descendants.
- `safetyCommitSha`: present only when dirty tracked changes were committed before reset.

## Error Responses

| Status | Condition                                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Run is not `failed`; target is not latest effective `failed`; target missing from current DAG; skipped downstream node selected; CLI-created/non-web run requested from Web; parent conversation is not web; setup/reset failed |
| `401`  | Web auth is enabled and no requester can be resolved                                                                                                                                                                            |
| `403`  | Requester is neither run owner nor admin                                                                                                                                                                                        |
| `404`  | Run not found                                                                                                                                                                                                                   |
| `409`  | CAS miss because run status changed before retry setup claimed it                                                                                                                                                               |
| `500`  | Unexpected DB/git/dispatch error after safe restoration attempt                                                                                                                                                                 |

Error responses use the existing JSON error schema.

## Server-Side Required Order

1. Load run.
2. Resolve requester auth context.
3. Validate run status, target node existence, latest effective node status, web eligibility, and requester authorization.
4. Verify Web dispatch parent conversation is web before mutation.
5. CAS run `failed -> running` and increment retry epoch.
6. Write `node_retry_requested`.
7. Create safety ref/commit, select checkpoint, reset tracked files if required, write `node_retry_reset`.
8. Delete persisted node sessions for invalidated nodes.
9. Dispatch retry-specific execution using the prepared run; do not route through `/workflow run` foreground resume lookup.
10. Return success response.

If steps 6-8 fail after CAS, write `node_retry_failed`, restore status to `failed`, and return an error without dispatching.

## Web Dispatch Contract

Web retry supports only web-created runs with `parent_conversation_id`. The dispatcher must reuse the existing worker conversation/working path and existing run row. It must not create a new run, new worktree, or linked replacement.

## OpenAPI/Frontend Types

After implementing the route:

```bash
bun run dev:server
bun --filter @archon/web generate:types
```

## Run Detail Projection

`GET /api/workflows/runs/{runId}` should continue returning raw `events` for logs/audit, and should also return server-derived node state for graph rendering and retry eligibility. This keeps retry epoch folding in one place.

Suggested additive response field:

```json
{
  "run": {},
  "events": [],
  "nodeStates": [
    {
      "nodeId": "build",
      "status": "pending",
      "retryEpoch": 1,
      "retryEligible": false,
      "invalidated": true,
      "error": null,
      "reason": null
    }
  ]
}
```

Rules:

- Raw `events` remain unchanged and complete.
- `nodeStates` is derived from workflow definition plus epoch-aware event projection.
- Web retry display uses `nodeStates` when present.
- A client fallback may exist during rollout, but server projection is authoritative.
