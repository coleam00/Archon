# Implementation Plan: Route Loop Decisions

**Branch**: `002-route-loop-decisions` | **Date**: 2026-06-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/002-route-loop-decisions/spec.md`

## Summary

Add `route_loop` as a new workflow node mode for bounded deterministic routing after a gate or review node.
The implementation keeps the existing AI `loop` node unchanged, preserves static DAG execution for workflows without route loops, and switches only route-loop workflows into route activation mode where selected route targets run and unselected targets remain dormant.

The technical approach is to extend workflow schemas and loader validation, add a route-loop-aware execution path in the DAG executor, persist route state in typed workflow-run metadata, emit first-class `node_routed` events, and update API, Web, and generated type surfaces so route loops can be authored, saved, run, inspected, resumed, and manually retried without hiding history.

## Technical Context

**Language/Version**: Bun + TypeScript with strict TypeScript, React + Vite for Web, Hono OpenAPI server, SQLite default and PostgreSQL via `DATABASE_URL`.
**Primary Dependencies**: `@hono/zod-openapi`, `@archon/workflows`, `@archon/core`, `@archon/server`, `@archon/web`, Zustand, React Flow, Dagre, and existing provider contracts from `@archon/providers/types`.
**Storage**: Existing `remote_agent_workflow_runs.metadata` and `remote_agent_workflow_events.data`; no new table is required for v1 unless implementation discovers metadata atomicity cannot be upheld through existing run updates.
**Testing**: Bun package-level tests only, with the existing route-loop TDD guard in `packages/workflows/src/dag-executor.test.ts`; never use root `bun test`.
**Target Platform**: Local/server Archon workflow execution with CLI and Web UI surfaces.
**Project Type**: Bun monorepo application with workflow engine, HTTP API, database-backed run store, CLI, and React Web workflow builder.
**Performance Goals**: Existing non-route workflows keep current topological layer execution; route-loop workflows should evaluate and activate routes in memory with per-run metadata updates proportional to the number of nodes and selected rerun path length.
**Constraints**: Preserve existing `loop` semantics, keep `depends_on` acyclic, reject malformed route-loop shapes at load time, fail fast on route condition parse or output resolution errors, keep route state updates atomic, avoid new git mutations, and keep observability free of prompts, secrets, PII, git remotes, and raw unsafe error text.
**Scale/Scope**: Single-developer v1 with bounded negative route attempts per route-loop node, independent counters per route-loop node, and no general cyclic graph engine.

## Constitution Check

_GATE: Must pass before Phase 0 research.
Re-check after Phase 1 design._

- **Single-developer scope**: PASS - the feature adds deterministic workflow control flow and does not add tenancy, resource visibility policy, or role expansion.
- **Boundary discipline**: PASS - workflow contracts and runtime behavior stay in `@archon/workflows`; database persistence and event projection stay behind the `IWorkflowStore` adapter in `@archon/core`; API schemas stay in `@archon/server`; Web consumes generated API types and local UI helpers.
- **Type/schema contracts**: PASS - add Zod schemas for `route_loop`, route outcomes, safe route metadata, workflow-run route state, and any server route/event schema changes; derive TypeScript types with `z.infer`; add `node_routed` to runtime event contracts and regenerate Web API types after OpenAPI changes.
- **Determinism and validation**: PASS - route selection is deterministic condition evaluation plus stored counters; loader validation rejects unsupported graph shapes before execution; validation commands use package test scripts and `bun run validate`, not root `bun test`.
- **Git/lifecycle safety**: PASS - the feature introduces no new git mutation; resume, pause, cancel, abandon, and manual retry behavior must preserve existing lifecycle ownership rules and must not autonomously mutate ambiguous non-terminal runs.
- **Observability and security**: PASS - `node_routed` is a typed event with snake_case metadata and a redacted safe condition representation; logs and APIs must not expose raw comparison literals that could contain secrets, user content, prompts, file paths, or git remotes.
- **UI/brand**: PASS - Web builder and run-detail changes reuse current workflow builder primitives, React Flow graph conventions, and Archon design tokens.

Post-design re-check: PASS.
The design keeps route-loop runtime state in a small typed metadata model, keeps route edges separate from dependency edges, and rejects general graph cycles rather than introducing an unbounded scheduler.

## Project Structure

### Documentation (this feature)

```text
specs/002-route-loop-decisions/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── api.md
│   ├── events.md
│   ├── web-ui.md
│   └── workflow-yaml.md
├── spec.md
├── checklists/
│   └── requirements.md
└── red-team-findings-applied-2026-06-27-152745.md
```

### Source Code (repository root)

```text
packages/workflows/src/
├── schemas/
│   ├── dag-node.ts              # Add route-loop node mode, guards, and exports
│   ├── route-loop.ts            # Route-loop config, outcome, metadata, and runtime state schemas
│   ├── workflow-run.ts          # Metadata schema extension beyond the current loose record shape
│   └── index.ts                 # Re-export new route-loop schemas and type guards
├── loader.ts                    # Route-loop graph validation and route edge checks
├── condition-evaluator.ts       # Reuse evaluator and expose parse/reference metadata as needed
├── output-ref.ts                # Reuse strict output field resolution contract
├── dag-executor.ts              # Route activation mode, route decisions, counters, attempts, sequence, and rerun path invalidation
├── event-emitter.ts             # Stream `node_routed` when live event bridge needs it
├── store.ts                     # Add `node_routed` to workflow event type contract
└── retry-state.ts               # Extend retry projection if route-loop attempts affect retry hydration

packages/core/src/
├── schemas/workflow-run.ts      # Core row metadata validation if route-loop state is parsed there
├── db/workflows.ts              # Atomic metadata updates or CAS helpers for route-loop state transitions
├── db/workflow-events.ts        # Latest-attempt output projection and `node_routed` event listing
└── workflows/store-adapter.ts   # Wire required route-decision store methods

packages/server/src/
├── routes/api.ts
└── routes/schemas/workflow.schemas.ts

packages/web/src/
├── lib/api.generated.d.ts       # Regenerated after server schema changes
├── lib/api.ts
├── lib/dag-layout.ts            # Route-loop display and route-edge projection
├── stores/workflow-store.ts     # First-class route event projection if streamed
├── components/workflows/
│   ├── DagNodeComponent.tsx
│   ├── ExecutionDagNode.tsx
│   ├── NodeInspector.tsx
│   ├── NodeLibrary.tsx
│   ├── ValidationPanel.tsx
│   ├── WorkflowBuilder.tsx
│   └── WorkflowDagViewer.tsx
└── hooks/useBuilderValidation.ts

packages/web/src/experiments/console/
└── builder/                     # Route-loop round trip, validation, variant detection, and event rendering
```

**Structure Decision**: Implement route loops as a cross-package feature with a narrow source of truth in `@archon/workflows`.
The workflow engine owns YAML validation, route activation, counters, and events.
Core persists typed run/event state through the existing store boundary.
Server exposes the updated contracts through OpenAPI.
Web renders and edits route loops through generated API types and builder-local helpers without importing workflow-engine packages.

## Complexity Tracking

No constitution violations are required.
The feature is broad because it affects workflow schemas, execution, event projection, and Web authoring, but every touched surface maps directly to accepted requirements in `spec.md`.

## Implementation Breakdown

### Phase 1 - Schemas And Validation

1. Add `routeLoopConfigSchema`, `routeLoopRoutesSchema`, `routeOutcomeSchema`, and route metadata schemas in `packages/workflows/src/schemas/route-loop.ts`.
2. Extend `dagNodeSchema` so `route_loop` is one execution mode and is mutually exclusive with `command`, `prompt`, `bash`, `script`, `approval`, `cancel`, and existing `loop`.
3. Add `RouteLoopNode`, `isRouteLoopNode()`, and exports from `packages/workflows/src/schemas/index.ts`.
4. Add safe node-id validation for node ids, `route_loop.from`, route targets, and node references parsed from route conditions.
5. Validate that route-loop nodes have exactly one `depends_on`, that it equals `route_loop.from`, and that route-loop nodes do not declare `when` or `trigger_rule`.
6. Validate route targets exist, do not point to the same route-loop node, and use only the allowed `positive`, `negative`, and `exhausted` outcomes.
7. Keep normal `depends_on` cycle detection unchanged and validate route-edge cycles separately.
8. Reject positive and exhausted routes that re-enter the loop path.
9. Allow nested route loops, shared route targets, and negative routes that intentionally exit instead of retrying.
10. Warn when `routes.negative` targets `from` directly.

### Phase 2 - Route Runtime State

1. Define runtime metadata schemas for `workflow_run.metadata.loopCounters`, `workflow_run.metadata.nodeAttempts`, `workflow_run.metadata.executionSeq`, and route activation state.
2. Add a typed state transition helper that validates current metadata, computes the next route decision, updates counters, attempts, activation state, route-loop output, and writes the corresponding event atomically.
3. Do not route this transition through the existing best-effort `createWorkflowEvent()` path unless that path is made durable for this transition.
4. Reuse the existing workflow-run lock or add an equivalent compare-and-set boundary so stale resume or retry writes cannot overwrite a newer route decision.
5. Store negative counters by route-loop node id and reset only the selected loop counter on `positive`.
6. Store one-based node attempt counters and a monotonic execution sequence for executed nodes and route decisions.
7. Keep all old attempts in events and make the main run summary project only the latest attempt per node.

### Phase 3 - Execution Engine

1. Keep the existing topological layer path for workflows without `route_loop`.
2. Add a route activation execution path for workflows that contain at least one route-loop node.
3. Activate root nodes at workflow start and treat `depends_on` as readiness, not branch selection.
4. When a route-loop node runs, evaluate `route_loop.condition` against the latest completed output of `route_loop.from`.
5. Fail the route-loop node if the source node is skipped, failed, missing, pending, or has no usable output.
6. Treat route condition parse failures and missing output field references as node failures, not negative outcomes.
7. On false conditions, increment the negative counter before selecting `negative` or `exhausted`.
8. Activate only the selected route target and do not mark unselected route targets as skipped.
9. When a selected target already completed, create a new attempt and invalidate only the selected rerun path back to the route-loop node.
10. Fail fast if a selected target is running or paused.
11. Validate rerun path self-containment at load time and at runtime before invalidating latest-output state.
12. Keep provider session behavior unchanged and do not automatically inject route context into negative target prompts.

### Phase 4 - Events, Projection, And APIs

1. Add `node_routed` to `WORKFLOW_EVENT_TYPES` in `packages/workflows/src/store.ts`.
2. Emit `node_routed` for every route-loop outcome with `from`, `outcome`, `to`, `condition`, `condition_result`, `negative_count`, `max_iterations`, `attempt`, and `execution_seq`.
3. Persist route-loop node output as the same route metadata and never copy the source node output into route-loop output.
4. Add safe condition serialization that preserves references, fields, operators, and boolean structure while redacting literal comparison values and future secret-bearing tokens.
5. Update event listing and run detail projection so route-loop events and latest attempts are returned as first-class data.
6. Update SSE or dashboard refetch behavior if route decisions need live Web refresh beyond current run-detail polling.
7. Regenerate frontend API types after any OpenAPI schema changes.

### Phase 5 - Web Builder And Run UI

1. Add `route_loop` to Web node-kind resolution, builder palette or node library, graph layout, and node component display.
2. Render route-loop nodes as controller nodes with compact `from`, `condition`, and `max_iterations` details.
3. Add output handles for `positive`, `negative`, and `exhausted`.
4. Render route edges separately from dependency edges and label each route edge by outcome.
5. Synchronize the single route-loop input edge with both `depends_on[0]` and `route_loop.from`.
6. Serialize route-loop output edges into `route_loop.routes`.
7. Block or report a second input edge, missing required routes, invalid target ids, and mismatched `from`.
8. Keep approval and interactive-loop UI states visually distinct from route-loop route decisions.
9. Render `node_routed` as a typed run-detail event with outcome, target, condition result, negative count, max iterations, attempt, and execution sequence.
10. Show unselected route targets as dormant or not activated when the graph needs to distinguish them from skipped nodes.

### Phase 6 - Compatibility And Lifecycle

1. Ensure workflows without `route_loop` keep existing behavior and test expectations.
2. Preserve pause, cancel, abandon, resume, manual retry, and persisted provider session behavior for existing workflows.
3. Extend manual retry eligibility so route-loop controller nodes are not directly retryable.
4. Guide users to retry the node referenced by `route_loop.from` when a new route decision is needed.
5. Preserve route activation state, loop counters, attempt counters, and execution sequence across resume.

## Risk Controls

- **Existing loop regression**: Add schema and executor tests that prove existing `loop` nodes still parse and execute with current semantics.
- **Unbounded execution**: Reject arbitrary dependency cycles and guard route cycles with `max_iterations`.
- **Silent branch execution**: In route activation mode, route targets run only after explicit activation, not merely because dependencies are satisfied.
- **Stale output reuse**: Latest-output projection must invalidate rerun paths and resolve `$node.output` to the latest completed attempt.
- **Partial route state**: Route decision, counter mutation, output write, activation state, and `node_routed` event write must share one transaction or CAS-protected transition.
- **Sensitive event data**: Store safe condition representations and redact comparison literals before persisting or streaming route metadata.
- **UI mismatch**: Builder serialization must keep visual route edges, `depends_on`, and `route_loop` YAML in sync before saving or running.

## Validation Plan

Focused commands during implementation:

```bash
bun test packages/workflows/src/dag-executor.test.ts -t "reruns a negative route path until the route_loop condition passes"
bun test packages/workflows/src/dag-executor.test.ts
bun test packages/workflows/src/loader.test.ts
bun test packages/workflows/src/schemas.test.ts
bun test packages/workflows/src/condition-evaluator.test.ts
bun test packages/workflows/src/output-ref.test.ts
bun test packages/core/src/db/workflows.test.ts
bun test packages/core/src/db/workflow-events.test.ts
bun test packages/core/src/workflows/store-adapter.test.ts
bun test packages/server/src/routes/api.workflow-runs.test.ts
bun test packages/server/src/routes/api.workflows.test.ts
bun test packages/web/src/experiments/console/builder/model/round-trip.test.ts
bun test packages/web/src/experiments/console/builder/validation/graph.test.ts
bun test packages/web/src/experiments/console/builder/validation/structural.test.ts
bun test packages/web/src/experiments/console/builder/validation/validate.test.ts
bun test packages/web/src/experiments/console/builder/variants/detect.test.ts
bun test packages/web/src/lib/dag-layout.test.ts
bun test packages/web/src/components/workflows/DagNodeComponent.test.ts
bun test packages/web/src/components/workflows/WorkflowExecution.test.tsx
bun test packages/web/src/stores/workflow-store.test.ts
```

Package validation as implementation grows:

```bash
bun --filter @archon/workflows test
bun --filter @archon/core test
bun --filter @archon/server test
bun --filter @archon/web test
```

Additional quality gates:

```bash
bun run type-check
bun run lint --max-warnings 0
bun run format:check
```

Generated artifact checks:

```bash
bun run dev:server
bun --filter @archon/web generate:types
bun run check:bundled
bun run check:bundled-skill
bun run check:bundled-schema
```

Pre-PR:

```bash
bun run validate
```
