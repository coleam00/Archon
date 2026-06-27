# Runtime Contract

## Activation Model

In workflows that use `route_loop`, nodes must be activated before dependency readiness can cause execution.
Root nodes with no dependencies are activated at startup.
Workflows without `route_loop` keep the existing DAG behavior.
`depends_on` remains a readiness constraint.
When `route_loop.routes.negative` activates a target, normal dependency readiness carries execution forward from that target.

The engine does not secretly rerun a nested loop body.
The engine does not implicitly jump from `fix` back to `from`.
The workflow author makes the retry path explicit through the normal graph order.

```yaml
- id: fix
  command: bmad-dev-story

- id: review
  command: bmad-code-review
  depends_on: [fix]

- id: review-router
  depends_on: [review]
  route_loop:
    from: review
    condition: "$review.output.result == 'positive'"
    routes:
      positive: next_step
      negative: fix
      exhausted: escalation
```

## Counters

Loop counters are stored in `workflow_run.metadata.loopCounters`.
The counter key is the route loop node id.
The counter is scoped by workflow run id and route loop node id.
Normal resume and retry do not reset the loop counter.
Starting a new workflow run resets all route loop counters by virtue of the new run scope.

Route loop output and event metadata use snake_case.
The internal storage key `loopCounters` is preserved from the source decision log, while output and event fields use names such as `negative_count` and `max_iterations`.

## Attempts

When a route activates a completed node, that node gets a new one-based attempt and runs again.
If a route tries to activate a running or paused node, the workflow fails fast.
Provider sessions follow existing node session behavior.
A route-triggered rerun only uses fresh context when the node config requests it.

`$node.output` always points to the latest completed attempt output for that node.
Attempt history is kept separately for audit and debug.
When a loop reaches `positive`, previous attempts remain available and only the active counter for that route loop resets.
When a loop reaches `exhausted`, previous attempts remain available and the counter is not reset.
Workflow expressions do not expose `$node.attempts` in the first version.

Events should record both a per-node `attempt` and a global `execution_seq`.
Both counters are stored in workflow run metadata.
Attempt numbers are one-based.
The main run summary shows only the latest attempt for each node.
Detailed attempt history is available through the event log.

## Rerun Path

The first version treats this as the clear retry-loop pattern:

```text
from -> route_loop -> negative target -> ...depends_on path... -> from
```

If a runtime cycle exists, it must return to the same `from` node of the same `route_loop`.
Only the `negative` route may participate in the loop cycle back to `from`.
`positive` and `exhausted` are exit paths and must not route back to `from`, the route loop node, or the negative loop path.
The `negative` path does not have to return to the same loop's `from` node.
When the negative path exits, no warning is required.

When a negative route reruns a path, rerun only the dependency path needed to get from the negative target back to `route_loop.from` and then the route loop node.
Do not rerun every descendant of the negative target.
Multiple dependency paths from the negative target back to `route_loop.from` are allowed.
All nodes on those selected paths must rerun normally.
There is no exclusion list and no `rerun: false` behavior in the first version.

Nodes inside the rerun path must not depend on nodes outside that path in the first version.
If that shape is detected, execution must fail with a clear error.
Validate rerun path self-containment both in the loader and at runtime.
Runtime validation remains required for resume, retry, stale persisted state, or any graph shape that bypasses static validation.

## Retry And Resume

When `retry-node` is used on a node inside a route loop, the retry should continue through the route flow from the new result.
Users should retry the node referenced by `route_loop.from`, such as `review` or `quality-gate`.
`route_loop` itself is not directly retryable because retrying the controller can duplicate route side effects or increment counters without a new source output.

Resume preserves route activation state, loop counters, and attempt counters.
Pause is a valid runtime state, not a workflow restart.
After resume, the workflow continues from the paused node and then proceeds through the same route flow.
Cancel, abandon, and resume lifecycle behavior remains the same as current Archon behavior.

## Route Events And Output

Emit a `node_routed` event for every route outcome.
The event uses outcome names `positive`, `negative`, and `exhausted`.
The event should include the route loop node id, source node id, selected outcome, target node id, condition expression, boolean condition result, negative count, and max iterations.
For `positive`, record the negative count before resetting the loop counter.
For `exhausted`, keep `condition_result: false` because exhaustion is the false condition path after the budget is exceeded.

`route_loop.output` mirrors the core route metadata from `node_routed`.
It does not copy the `from` node output.
Downstream nodes can read the route outcome or counter state without querying the event log.

```json
{
  "outcome": "exhausted",
  "to": "escalation",
  "condition": "$review-gate.output.result == 'positive'",
  "condition_result": false,
  "negative_count": 11,
  "max_iterations": 10
}
```

## Unselected Branches

Unselected route targets are not marked as skipped.
They are simply not activated.
Nodes that are never reached by route activation are not shown as executed nodes in the main run summary.
Graph UI may show them as `not_activated`.

## Prompt And Context Behavior

When `route_loop` routes to `negative`, the engine does not automatically inject failure context into the target node prompt.
Negative target nodes do not need loop iteration context by default.
Workflow authors should explicitly reference needed review output, artifacts, route loop output, or route events in their node prompts.
