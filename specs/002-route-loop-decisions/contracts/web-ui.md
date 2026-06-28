# Contract: Web UI

## Builder Node

The workflow builder must render `route_loop` as a distinct controller node.
It must not reuse the existing AI `loop` node representation.

Required visible controls:

- Decision source.
- Condition.
- Max iterations.
- Positive target.
- Negative target.
- Exhausted target.

## Ports And Edges

The route-loop node has one input edge.
That input edge controls both `depends_on[0]` and `route_loop.from`.

The route-loop node has three output handles:

- `positive`
- `negative`
- `exhausted`

Route edges must be visually distinct from normal dependency edges.
Each route edge must be labeled by outcome.

## Serialization

Connecting the single input edge writes:

```yaml
depends_on: [review]
route_loop:
  from: review
```

Connecting output edges writes:

```yaml
route_loop:
  routes:
    positive: done
    negative: fix
    exhausted: escalation
```

## Validation

The builder must block or report:

- Missing route-loop input edge.
- More than one route-loop input edge.
- Missing `positive` route target.
- Missing `negative` route target.
- Missing `exhausted` route target.
- Invalid route target id.
- `depends_on[0]` mismatch with `route_loop.from`.

The builder must allow two route outcomes to intentionally target the same node unless route-cycle validation rejects the graph.
The builder must not special-case-ban `negative` and `exhausted` sharing a target.
The builder save and reload flow must preserve route-loop YAML without requiring manual repair.

## Run Detail

Run detail and stream UI must render `node_routed` as a typed event.
The event view must expose outcome, source node, selected target, condition result, negative count, max iterations, attempt, and execution sequence.

Unselected route targets should appear as not activated or dormant when the graph needs that state.
They must not be presented as skipped work.

Approval UI and interactive-loop input banners must remain visually and semantically distinct from route-loop routing.
