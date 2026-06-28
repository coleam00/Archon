# Data Model: Route Loop Decisions

## RouteLoopConfig

Workflow YAML object stored under a DAG node's `route_loop` field.

Fields:

- `from`: node id for the source gate or review node.
- `condition`: condition expression evaluated against the latest output of `from`.
- `max_iterations`: optional integer from `1` to `100`; default is `10`.
- `routes`: required `RouteLoopRoutes`.

Validation rules:

- `route_loop` is mutually exclusive with every other node execution mode.
- `from` must exist and must equal the node's sole `depends_on` entry.
- `condition` must parse with the existing condition grammar.
- Every node reference in `condition` must reference `from`.
- The route-loop node must not declare `when` or `trigger_rule`.

## RouteLoopRoutes

Required route target mapping under `route_loop.routes`.

Fields:

- `positive`: node id activated when the condition evaluates true.
- `negative`: node id activated when the condition evaluates false and budget remains.
- `exhausted`: node id activated when the condition evaluates false after budget is consumed.

Validation rules:

- All three fields are required.
- Each target must be one short safe node id.
- Each target must exist in the workflow.
- No target may point to the same route-loop node.
- `positive` and `exhausted` must be exit paths and must not re-enter the negative rerun path.
- `negative` may exit or may target an upstream self-contained path back to `from`.

## RouteOutcome

Closed route decision enum.

Values:

- `positive`
- `negative`
- `exhausted`

Rules:

- `positive` means the condition evaluated true.
- `negative` means the condition evaluated false after incrementing the negative counter and the new count is less than or equal to `max_iterations`.
- `exhausted` means the condition evaluated false after incrementing the negative counter and the new count is greater than `max_iterations`.

## Workflow Run Route Metadata

Existing `workflow_run.metadata` object extended with route-loop runtime state.
The current workflow-run metadata schema is loose, so route-loop fields need explicit validation before read and write.

Fields:

- `loopCounters`: record of route-loop node id to negative route count.
- `nodeAttempts`: record of node id to one-based latest execution attempt.
- `executionSeq`: monotonic number for total execution order.
- `routeActivations`: route activation state used by route activation mode.

Validation rules:

- Metadata must be schema-validated before route-loop state is read or mutated.
- Missing route metadata means empty state for an existing run.
- Counters are scoped by workflow run id and route-loop node id.
- Counters are reset only for the selected route-loop node when that loop routes `positive`.
- Counters are not reset on `negative`, `exhausted`, resume, or manual retry.
- Malformed route metadata must fail fast before a route decision is applied.

## RouteActivation

Runtime selection state for a route target.

Fields:

- `route_loop_node_id`: route-loop controller id.
- `outcome`: selected `RouteOutcome`.
- `target_node_id`: activated target node id.
- `attempt`: one-based route-loop controller attempt.
- `execution_seq`: global execution sequence number.

Rules:

- Route activation selects only the configured target for the selected outcome.
- Unselected targets remain dormant and are not marked skipped.
- If a selected target already completed, the runtime creates a new attempt.
- If a selected target is running or paused, the runtime fails fast.

## NodeAttemptCounter

Per-workflow-run attempt counter stored in metadata.

Fields:

- Key: node id.
- Value: one-based latest attempt number.

Rules:

- Increment before a node execution attempt starts.
- Include attempt in executed node events and route decision events.
- Main run summaries show only latest attempts.
- Event history keeps prior attempts.

## ExecutionSequence

Per-workflow-run monotonic sequence stored in metadata.

Fields:

- `executionSeq`: integer value that increments for executed nodes and route decisions.

Rules:

- Sequence numbers reconstruct total order across route-loop attempts.
- Sequence mutation must be part of the same atomic transition as the event or output it describes.

## NodeRoutedEvent

Persisted workflow event with `event_type: node_routed`.

Required data:

- `from`
- `outcome`
- `to`
- `condition`
- `condition_result`
- `negative_count`
- `max_iterations`
- `attempt`
- `execution_seq`

Rules:

- Field names use snake_case.
- Outcome values match YAML outcome names.
- `condition` is a safe persisted string, not raw author expression with literal values.
- `negative_count` is included for every outcome.
- For `positive`, `negative_count` records the count before reset.
- For `exhausted`, `condition_result` remains `false`.
- Persistence must be part of the same durable transition as counter mutation, activation mutation, and route-loop output mutation.

## RouteLoopOutput

Latest output for a route-loop node.

Fields:

- Same core route metadata as the corresponding `node_routed` event.

Rules:

- Must not copy the `from` node output.
- Must be the value resolved by `$routeLoopNode.output` for later nodes.
- Latest completed route-loop output replaces older output in run summary while older events remain available.

## NotActivatedNodeState

Optional UI projection for route targets that never ran because their route was not selected.

Fields:

- `node_id`
- `status`: `not_activated`
- `route_loop_node_id`
- `outcome`, when known.

Rules:

- This is a UI projection, not necessarily a persisted workflow event.
- It must not be confused with `skipped`, because no skip condition executed.
