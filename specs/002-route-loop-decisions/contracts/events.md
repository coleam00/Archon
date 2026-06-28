# Contract: Route-Loop Events

## Event Type

Add `node_routed` to the workflow event type contract.

```ts
type WorkflowEventType = 'node_routed' | ExistingWorkflowEventType;
```

## `node_routed` Data

```json
{
  "from": "review",
  "outcome": "negative",
  "to": "fix",
  "condition": "$review.output.result == '<redacted>'",
  "condition_result": false,
  "negative_count": 1,
  "max_iterations": 10,
  "attempt": 1,
  "execution_seq": 4
}
```

## Field Rules

- `from` is the source node declared by `route_loop.from`.
- `outcome` is one of `positive`, `negative`, or `exhausted`.
- `to` is the selected route target.
- `condition` is the persisted safe condition string.
- `condition_result` is true only for `positive`.
- `negative_count` is included for every outcome.
- `max_iterations` is included for every outcome.
- `attempt` is the route-loop controller attempt number.
- `execution_seq` is the global workflow execution sequence number.

## Safe Condition String

The safe string must preserve:

- Node references.
- Field names.
- Operators.
- Boolean structure.

The safe string must redact:

- Literal comparison values.
- Any future grammar token that can carry secrets.
- Prompts.
- User message content.
- PII.
- Git remotes.
- Raw unsafe error text.
- File paths when telemetry or API contracts exclude them.

## Event Ordering

The runtime must apply counter updates, route activation changes, route-loop output writes, and `node_routed` event writes through one atomic state transition.
If the transition fails, the workflow must not commit a partial route decision.
The route decision path must not rely on observable-only event writes that intentionally swallow persistence errors.

## Output Contract

The route-loop node output mirrors the same core metadata as `node_routed`.
It must not copy or mutate the source node output.
