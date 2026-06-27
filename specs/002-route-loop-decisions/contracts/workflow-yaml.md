# Contract: Workflow YAML

## Route-Loop Node Shape

```yaml
- id: review-router
  depends_on: [review]
  route_loop:
    from: review
    condition: "$review.output.result == 'positive'"
    max_iterations: 10
    routes:
      positive: done
      negative: fix
      exhausted: escalation
```

## Required Fields

- `id`: safe node id.
- `depends_on`: array with exactly one node id.
- `route_loop.from`: safe node id and same value as `depends_on[0]`.
- `route_loop.condition`: existing condition grammar expression.
- `route_loop.routes.positive`: safe node id target.
- `route_loop.routes.negative`: safe node id target.
- `route_loop.routes.exhausted`: safe node id target.

## Optional Fields

- `route_loop.max_iterations`: integer from `1` to `100`; default is `10`.

## Exclusive Fields

A route-loop node must not include any other execution mode:

- `command`
- `prompt`
- `bash`
- `script`
- `approval`
- `cancel`
- `loop`

## Unsupported Node Fields

A route-loop node must not include:

- `when`
- `trigger_rule`
- `retry`

## Node Id Grammar

Workflow node ids, `route_loop.from`, route-loop route targets, and node references parsed from `route_loop.condition` must use:

```text
[A-Za-z_][A-Za-z0-9_-]{0,63}
```

Reserved keys are rejected:

- `__proto__`
- `prototype`
- `constructor`

## Route Outcomes

`positive` means the condition evaluated true.
`negative` means the condition evaluated false and negative budget remains.
`exhausted` means the condition evaluated false after negative budget is consumed.

## Validation Failures

The loader must reject:

- Missing `route_loop.from`.
- Missing `route_loop.condition`.
- Missing any required route target.
- Route target that does not exist.
- Route target that points to the same route-loop node.
- Zero, two, or more `depends_on` entries.
- `depends_on[0]` not equal to `route_loop.from`.
- `from` node that declares `when`.
- Route-loop node that declares `when` or `trigger_rule`.
- Condition that references any node other than `from`.
- Positive or exhausted route that re-enters the negative loop path.
- First-version negative retry path that depends on nodes outside the rerun path.

## Compatibility

Existing workflows without `route_loop` must keep current static DAG execution behavior.
Existing `loop` nodes must keep the AI prompt loop contract.
