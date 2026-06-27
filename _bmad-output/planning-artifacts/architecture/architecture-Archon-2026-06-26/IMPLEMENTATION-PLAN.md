# Route Loop Routing Implementation Plan

This plan maps the settled Grill Me decisions to implementation work.
It does not reopen runtime behavior.

## Build Order

### Phase 1 - Schema And Loader Contract

Add `route_loop` to `packages/workflows/src/schemas/dag-node.ts`.
The schema must enforce mode exclusivity and reject `when` or `trigger_rule` on the route loop node.

Extend loader validation for:

- Route targets must exist.
- `depends_on` must contain exactly `route_loop.from`.
- Route targets must not point to the controller itself.
- Positive and exhausted routes must not re-enter the loop path.
- Negative retry paths that return to `from` must be self-contained.
- `route_loop.condition` references only `route_loop.from`.

Tests:

- `packages/workflows/src/schemas.test.ts`
- `packages/workflows/src/loader.test.ts`
- New route-loop validation cases for all Grill Me D024-D027, D037-D039, D069-D074, D083-D096.

### Phase 2 - Route State And Strict Store Contract

Add route-loop state types and pure transitions under `packages/workflows/src/route-loop/`.
The pure layer should parse and normalize `workflowRun.metadata` into typed state.

Add an `IWorkflowStore.recordRouteDecision(...)` method.
This method must be the only route-decision persistence path.

Core implementation must:

- Read the current run metadata.
- Apply the route transition.
- Update `workflow_run.metadata.loopCounters` and `workflow_run.metadata.route_loop_state`.
- Insert required `node_routed`.
- Insert the route loop node's `node_completed` event containing the same route metadata as output.
- Commit before the executor activates the selected target.
- Throw on any DB failure.

Keep `createWorkflowEvent` non-throwing for existing ordinary observability events.

Tests:

- `packages/core/src/db/workflows.test.ts`
- `packages/core/src/workflows/store-adapter` coverage if present or add focused tests.
- SQLite and PostgreSQL dialect SQL expectations for route transaction behavior.

### Phase 3 - Route-Aware Executor

Keep the current static topological path for workflows without `route_loop`.
For workflows with route nodes, execute through an activation frontier.

Runtime rules:

- Root nodes start activated.
- A node can run only when activated and dependency-ready.
- A route loop evaluates after its `from` node has completed with output.
- Condition parse and output reference errors fail the route loop.
- Negative route increments the counter and activates the target unless exhausted.
- Positive route resets only that loop's counter after recording the count in route output.
- Exhausted is completed control flow and activates the exhausted target.
- Route to running or paused target fails fast.
- Completed targets selected by a route get a new attempt.
- Negative rerun invalidates only the selected path back to `from` and the route loop.

Tests:

- `packages/workflows/src/dag-executor.test.ts`
- New tests for positive, negative, exhausted, direct negative-to-from warning path, target already running, resume preservation, and route-loop direct retry rejection.
- Regression tests proving no-route workflows keep existing static DAG behavior.

### Phase 4 - API, SSE, And Run Detail Projection

Add `node_routed` to workflow event types.
Add `not_activated` to API/Web graph node status projection where appropriate.

Server work:

- Extend `workflowNodeStateSchema`.
- Extend `projectApiWorkflowNodeStates`.
- Extend `WorkflowEventBridge` with a `workflow_route` payload for `node_routed`.
- Extend dashboard poller event type list.
- Keep REST events as source of truth for route history.

Web work:

- Regenerate `packages/web/src/lib/api.generated.d.ts`.
- Update workflow store and execution graph to consume route events.
- Display route loop nodes and edge outcome state without counting `not_activated` as executed.

Tests:

- `packages/server/src/routes/api.workflow-runs.test.ts`
- `packages/server/src/adapters/web/dashboard-event-poller.test.ts`
- `packages/server/src/adapters/web/workflow-bridge.test.ts`
- `packages/web/src/stores/workflow-store.test.ts`
- `packages/web/src/components/workflows/WorkflowExecution.test.tsx`

### Phase 5 - Production Builder

Implement production builder support in `packages/web/src/components/workflows`.

Required behavior:

- Add a Route Loop node type.
- Render one input handle.
- Render `positive`, `negative`, and `exhausted` output handles.
- Serialize route output edges to `route_loop.routes`.
- Keep the input edge aligned with both `depends_on` and `route_loop.from`.
- Prevent a second input edge.
- Block save/run when any required output is missing.
- Allow different route outcomes to share the same target.

Tests:

- Builder serialization tests.
- Validation tests for missing route outputs and multiple input edges.
- Visual verification of straight, target-aligned route edges in the mockup and production canvas.

### Phase 6 - Secondary Builder Guard

Update `packages/web/src/experiments/console/builder`.

Choose one of two compliant paths:

- Add `route_loop` as an eighth variant with exact round-trip.
- Or detect `route_loop` as unsupported and block save/run so it cannot drop fields.

The first path is preferred because the experiment builder already has registry-based variant conversion and round-trip tests.

Tests:

- `packages/web/src/experiments/console/builder/model/round-trip.test.ts`
- Variant detection tests.
- Structural validation tests.

## Validation Gate

Run these before calling the implementation ready:

```bash
bun run type-check
bun run lint --max-warnings 0
bun run format:check
bun --filter @archon/workflows test
bun --filter @archon/core test
bun --filter @archon/server test
bun --filter @archon/web test
bun run validate
```

Use the package-level tests while iterating.
Use `bun run validate` before PR.

## Rollback Path

Route Loop Routing is additive.
Rollback should remove or ignore workflows that declare `route_loop`.
Existing workflows without `route_loop` must not need migration or rollback changes.

The highest-risk rollback point is the store contract.
Keep the strict route-decision method isolated so reverting Route Loop does not change ordinary workflow event persistence.
