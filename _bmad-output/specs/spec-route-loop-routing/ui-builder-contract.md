# UI Builder Contract

The web builder should render `route_loop` as a branch controller with three output ports.
The output ports are `positive`, `negative`, and `exhausted`.
Visible ports make route targets obvious on the graph.

Edges from `route_loop` output ports serialize directly into `route_loop.routes` string targets.
No separate edge metadata is required in the first version.

```yaml
route_loop:
  routes:
    positive: next_step
    negative: fix
    exhausted: escalation
```

The web builder must enforce exactly one input edge for a `route_loop` node.
That input edge must match both the single `depends_on` node id and `route_loop.from`.
When the user changes the input edge, the builder should update `from` and `depends_on` together.
The builder must prevent a second input edge from being connected to a `route_loop`.

The builder should mark a `route_loop` node invalid if any required output route is missing.
It should not allow saving or running a workflow with a `route_loop` missing `positive`, `negative`, or `exhausted`.
Different outcomes may target the same node.
There is no special validation ban for `negative` and `exhausted` sharing the same target.
Safety is handled by route-cycle and rerun-path validation, not by special-casing that pair.
