# Web UI Contract: Manual Node Retry

## Eligibility

Show retry UI only when all conditions are true:

- run status is `failed`
- run is web-retry-eligible
- target node latest effective status is `failed`
- target node is not merely downstream `skipped`
- server has enough context to retry from Web, including parent web conversation

The client may derive eligibility for display, but the server is authoritative.

## Placement

Retry control should be available from the failed node context in the run detail DAG view. It may also appear in the node log/details panel if that is where node actions are grouped.

## Confirmation Dialog

Before calling the API, require confirmation. Copy must mention:

- tracked files will be reset to the selected checkpoint
- dirty tracked changes are auto-committed to a retry safety ref first
- untracked and ignored files are not deleted
- the selected node and downstream dependent nodes will rerun

## Loading And Error States

- Disable retry button while request is in flight.
- Show loading state on the selected action.
- On success, invalidate/refetch the workflow run query and dashboard run queries.
- On error, show the server error and leave the run shown as failed.

## Projection Rules

Web must prefer server-derived run-detail `nodeStates` when present. Any fallback projection must be epoch-aware:

- missing event `retry_epoch` is epoch `0`
- latest effective node state uses the highest relevant epoch
- invalidated nodes project as `pending` in the active retry epoch until lifecycle events arrive
- old failed/skipped events must not override later retry success
- `node_retry_*` events are setup/audit transitions, not skipped node lifecycle events

The experimental console run-detail projections should follow the same rules.

## API Wrapper

Add to `packages/web/src/lib/api.ts`:

```ts
retryWorkflowNode(runId: string, nodeId: string): Promise<RetryWorkflowNodeResponse>
```

The response type should come from regenerated OpenAPI types.
