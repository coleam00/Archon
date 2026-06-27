# Route Loop Contract

## YAML Shape

`route_loop` is a standalone node mode field.
It has its own node `id`, emits its own events, stores its own output metadata, and owns its own retry budget.

```yaml
- id: review-router
  depends_on: [review]
  route_loop:
    from: review
    condition: "$review.output.result == 'positive'"
    max_iterations: 10
    routes:
      positive: next_step
      negative: fix
      exhausted: escalation
```

`route_loop.from` is required.
The route loop node must have exactly one `depends_on` entry, and that entry must equal `route_loop.from`.
If multiple gate inputs must be evaluated, a separate aggregation node must produce one decision output first.

## Outcomes

`positive` means the condition evaluated true.
`negative` means the condition evaluated false while the negative route budget still allows another negative pass.
`exhausted` means the condition evaluated false after the negative route budget has been consumed.
`exhausted` is completed control flow, not a node failure.

## Routes

`route_loop.routes.positive`, `route_loop.routes.negative`, and `route_loop.routes.exhausted` are all required.
Each route value is one short string node id.
Route targets must be real node ids.
No special terminal sentinel such as `__end__` exists in the first version.
No route target can point to the same `route_loop` node.
Different outcomes may share a target when the route-cycle and rerun-path rules still hold.

## Max Iterations

`route_loop.max_iterations` defaults to `10`.
Provided values must be integers from `1` through `100`.
The counter counts allowed `negative` routes, not total route decisions.
When the condition is false, the runtime increments the negative counter first.
If the new count is greater than `max_iterations`, the runtime routes to `exhausted`.
Otherwise the runtime routes to `negative`.
With `max_iterations: 10`, false results 1 through 10 route to `negative`, and false result 11 routes to `exhausted`.
With `max_iterations: 1`, the first false result routes to `negative`, and the second false result routes to `exhausted`.
When the condition is true, the runtime routes to `positive` regardless of the negative counter, then resets only that route loop node's counter.

## Condition Rules

`route_loop.condition` reuses the existing `when` condition grammar.
It does not add a scoped `$output` alias.
It does not rewrite expressions.
It does not add functions such as `trim()` or `lower()`.
It does not add route-loop-specific string normalization.
The workflow author owns the expression and the source node owns its output contract.

The condition may read whole output text from `route_loop.from` without `output_format`.
The condition may read structured output fields only when those fields are declared in `route_loop.from` node's `output_format.properties`.
Every node reference inside a compound condition must reference the node declared in `route_loop.from`.
If the condition references a different node, the workflow is invalid.
If the condition cannot be parsed, the route loop fails.
If a referenced output field is missing or unresolvable, the route loop fails.
The route loop must not treat condition parse errors or missing output fields as `negative`.

## Validation Rules

The loader must validate route target existence.
The loader must validate that `route_loop` is mutually exclusive with `prompt`, `command`, `bash`, `script`, `approval`, `cancel`, and existing `loop`.
The loader must validate the `from` and `depends_on` relationship.
The loader must keep the `depends_on` graph acyclic.
The loader should warn when `routes.negative` targets `from` directly because that often reruns review without fix work, but direct `from` targeting can be valid for polling or flaky checks.
The loader must not warn merely because a negative path exits instead of returning to the same route loop.
