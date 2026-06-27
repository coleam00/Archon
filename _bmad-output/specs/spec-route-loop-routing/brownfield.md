# Brownfield Context

This context was verified by repo inspection during spec creation.
The configured persistent fact file `project-context.md` was absent from the repository root, so it was not used.

## Workflow Schema

Current DAG nodes live in `packages/workflows/src/schemas/dag-node.ts`.
The current node mode union is `command`, `prompt`, `bash`, `script`, `loop`, `approval`, and `cancel`.
`route_loop` does not exist yet.
The existing `loop` node is an AI prompt loop and must remain distinct from route control.
The existing loop schema includes prompt-loop fields such as `prompt`, `until`, `until_bash`, `fresh_context`, `interactive`, and `gate_message`.
Existing loop docs live under `packages/docs-web/src/content/docs/guides/loop-nodes.md`.
The schema currently enforces mode mutual exclusivity in `dagNodeSchema`.
Relevant references are `packages/workflows/src/schemas/dag-node.ts:140`, `packages/workflows/src/schemas/dag-node.ts:286`, `packages/workflows/src/schemas/dag-node.ts:349`, `packages/workflows/src/schemas/dag-node.ts:415`, and `packages/workflows/src/schemas/dag-node.ts:468`.

Server route schemas derive workflow API contracts under `packages/server/src/routes/schemas/workflow.schemas.ts`.
The web builder reaches workflow node wire types through generated OpenAPI types, so adding `route_loop` requires type regeneration after the server schema changes.

## Loader And Graph Validation

The loader parses each raw node through `dagNodeSchema.safeParse`.
It validates unique ids, `depends_on` references, acyclic graph structure, and `$node.output` references in `when` and prompt bodies.
Cycle detection uses Kahn's algorithm and rejects cycles before runtime.
Relevant references are `packages/workflows/src/loader.ts:96`, `packages/workflows/src/loader.ts:139`, `packages/workflows/src/loader.ts:158`, `packages/workflows/src/loader.ts:197`, and `packages/workflows/src/loader.ts:318`.

## Condition Evaluation

The existing condition evaluator supports equality, inequality, numeric comparisons, compound `&&` and `||`, canonical `$node.output.field`, and shorthand `$node.field`.
Malformed syntax returns `parsed: false` and regular `when` conditions skip fail-closed.
Unresolvable output field references throw `OutputRefError`.
Route loop must reuse the grammar but change parse failure behavior so the controller fails instead of skipping.
Relevant references are `packages/workflows/src/condition-evaluator.ts:1`, `packages/workflows/src/condition-evaluator.ts:117`, `packages/workflows/src/condition-evaluator.ts:205`, `packages/workflows/src/output-ref.ts:31`, and `packages/workflows/src/output-ref.ts:117`.

## Execution Model

The DAG executor currently builds topological layers and executes all nodes in a layer concurrently through `Promise.allSettled`.
Trigger rules run before `when` conditions.
Resume can prepopulate prior completed outputs and emit `node_skipped_prior_success`.
Checkpoint creation currently happens after trigger and `when` checks and before executable node dispatch.
`isCheckpointableExecutableNode` currently excludes only approval and cancel nodes, so route loop must be explicitly excluded if it should not create checkout checkpoints.
`dagNodeTelemetryType` currently needs an explicit route loop arm because unknown future node types would otherwise fall through to prompt telemetry.
Relevant references are `packages/workflows/src/dag-executor.ts:5`, `packages/workflows/src/dag-executor.ts:710`, `packages/workflows/src/dag-executor.ts:751`, `packages/workflows/src/dag-executor.ts:2966`, `packages/workflows/src/dag-executor.ts:3060`, `packages/workflows/src/dag-executor.ts:3167`, and `packages/workflows/src/dag-executor.ts:3253`.

Route activation and rerun-path invalidation will require extending the execution scheduler beyond pure topological-layer execution.
The design must preserve existing behavior for workflows that do not use `route_loop`.
Paused runs are considered active for path locking, so route-loop resume and pause behavior must not bypass that guard.

## Events And Retry Projection

Current workflow event types are declared in `packages/workflows/src/store.ts`.
`node_routed` does not exist yet.
The workflow emitter has typed variants for workflow, node, loop, artifact, tool, approval, and cancellation events.
The run event projection already has retry-aware state calculation through `projectLatestEffectiveNodeStates`.
Event insertion through `createWorkflowEvent` is generally fire-and-forget and non-throwing, but route decisions may need stricter handling if `node_routed` becomes durable control-flow evidence.
Manual retry already preserves old history and invalidates target plus descendants through events instead of deleting records.
Route-triggered reruns need a comparable projection so stale completed nodes do not remain visually completed while their selected path is active.
Relevant references are `packages/workflows/src/store.ts:50`, `packages/workflows/src/event-emitter.ts:90`, `packages/workflows/src/event-emitter.ts:145`, `packages/workflows/src/retry-state.ts:80`, and `packages/core/src/db/workflow-events.ts:233`.

## Web Builder

The experimental console builder currently shares `WorkflowNodeKind` with the graph primitive.
The current kind union has `prompt`, `command`, `bash`, `script`, `approval`, `loop`, and `cancel`.
The variant registry and detection logic do not include `route_loop`.
The builder graph validation currently checks `depends_on` references and cycles.
Unknown or unsupported modes currently fall back through the builder's variant detection/import path rather than becoming first-class route-loop nodes.
Relevant references are `packages/web/src/experiments/console/primitives/workflow-graph.ts:7`, `packages/web/src/experiments/console/builder/types/variant.ts:20`, `packages/web/src/experiments/console/builder/variants/registry.ts:22`, `packages/web/src/experiments/console/builder/variants/registry.ts:48`, `packages/web/src/experiments/console/builder/variants/detect.ts:19`, and `packages/web/src/experiments/console/builder/validation/graph.ts:81`.

## Existing Routing Boundary

Existing workflow routing in `packages/workflows/src/router.ts` maps user requests to workflow names.
It is conversation-to-workflow routing, not DAG control-flow routing.
`route_loop` must therefore be implemented in workflow schema, validation, execution, events, and builder surfaces rather than by extending the request router.

## Additional Implementation Surfaces

The route-loop change likely touches engine schemas, OpenAPI-derived web types, server route schemas, docs, builder variants, SSE mappings, dashboard poller mappings, telemetry, checkpoint eligibility, retry projection, and focused workflow tests.
These are brownfield surfaces, not new scope beyond the Grill Me decisions.

## Validation Commands

Use focused workflow package tests while implementing schema, loader, condition, executor, and event projection changes.
Use focused web builder tests while implementing builder variant, graph validation, serialization, and round-trip behavior.
Run full repo validation before PR creation.

```bash
bun test packages/workflows/src/loader.test.ts
bun test packages/workflows/src/condition-evaluator.test.ts
bun test packages/workflows/src/dag-executor.test.ts
bun test packages/workflows/src/retry-state.test.ts
bun test packages/web/src/experiments/console/builder
bun run validate
```
