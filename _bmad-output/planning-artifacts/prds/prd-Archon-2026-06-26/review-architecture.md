# Route Loop Architecture Readiness Review

## Summary

Verdict: `BLOCK` for downstream architecture readiness.
The PRD is strong on the public YAML contract, condition grammar intent, route outcomes, and high-level lifecycle goals, and I found no hard contradiction with the canonical spec bundle on those core product semantics.
It is not yet architecture-ready because several remaining open questions are actually architecture source-of-truth decisions for schema, persistence, retry/resume projection, SSE, and builder scope.

The highest priority fix is to turn the open questions in `prd.md` into explicit requirements before architecture starts.
Leaving them open will force architecture to invent product policy around route state durability, output fields, activation state, and which web builder must ship.

## Analysis

### Finding 1 - Blocking - Route state durability is required, but its source of truth is still open.

The PRD says route state must be persisted in workflow run metadata, including negative counters and attempt counters, and resume/retry must not reset counters inside the same run.
Evidence: `prd.md:306` through `prd.md:316`.
The PRD also says resume must preserve activation state, Negative Count, Attempt counters, and latest effective outputs.
Evidence: `prd.md:318` through `prd.md:326`.
The PRD further says route evidence must be durable enough for resume, retry projection, SSE propagation, dashboard state, and post-run debugging.
Evidence: `prd.md:403` through `prd.md:411`.

The blocker is that the same PRD leaves `node_routed` persistence durability as an open question.
Evidence: `prd.md:617` through `prd.md:620`.
This is not a minor implementation detail because the canonical spec requires route state coherence across resume and retry, and requires route decisions to be visible.
Evidence: `_bmad-output/specs/spec-route-loop-routing/SPEC.md:42` through `_bmad-output/specs/spec-route-loop-routing/SPEC.md:47`.
The runtime contract also says counters live in `workflow_run.metadata.loopCounters`, resume preserves route activation state and counters, and `node_routed` is emitted for every route outcome.
Evidence: `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:34` through `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:43`, `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:89` through `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:98`, and `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:100` through `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:110`.

The current implementation makes this decision unavoidable.
`IWorkflowStore.createWorkflowEvent()` explicitly says implementations must not throw and callers treat events as observable-only.
Evidence: `packages/workflows/src/store.ts:127` through `packages/workflows/src/store.ts:138`.
The core DB event writer catches insert failures and never throws.
Evidence: `packages/core/src/db/workflow-events.ts:57` through `packages/core/src/db/workflow-events.ts:89`.
The web bridge and dashboard poller depend on persisted event types to produce SSE/dashboard updates.
Evidence: `packages/server/src/adapters/web/workflow-bridge.ts:222` through `packages/server/src/adapters/web/workflow-bridge.ts:233` and `packages/server/src/adapters/web/workflow-bridge.ts:235` through `packages/server/src/adapters/web/workflow-bridge.ts:312`.

Architecture cannot safely decide schema, executor atomicity, resume reconstruction, or SSE projection until the PRD states whether authoritative route state is metadata, persisted events, or both.
If `node_routed` is control-flow evidence, the existing event-store contract must change for route events.
If metadata is authoritative, the PRD should say `node_routed` is durable audit/SSE evidence and resume uses metadata plus latest node outputs, not best-effort event insertion.

### Finding 2 - Blocking - The route-aware execution state machine is under-specified.

The PRD introduces activation before dependency readiness, route target activation, selected rerun paths, new attempts, and route-state preservation.
Evidence: `prd.md:229` through `prd.md:238`, `prd.md:252` through `prd.md:263`, `prd.md:273` through `prd.md:283`, and `prd.md:318` through `prd.md:326`.
The canonical runtime contract agrees that route workflows need activation and that ordinary dependency readiness is only a readiness constraint after activation.
Evidence: `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:3` through `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:13`.
It also requires rerun path validation both statically and at runtime.
Evidence: `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:78` through `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:87`.

What is missing is a product-level route state model.
The PRD does not define the persisted shape for activated nodes, selected route edges, attempt counters, global execution sequence, stale completed outputs, never-activated route targets, or route epochs.
It also does not define how route activation interacts with a previously completed positive or exhausted target, even though FR-14 says any completed activated node runs again as a new attempt.
Evidence: `prd.md:252` through `prd.md:259`.

This matters because the existing executor is static topological-layer execution.
It builds all layers up front with Kahn's algorithm.
Evidence: `packages/workflows/src/dag-executor.ts:744` through `packages/workflows/src/dag-executor.ts:790`.
It then executes every node in a layer concurrently with `Promise.allSettled`.
Evidence: `packages/workflows/src/dag-executor.ts:3039` through `packages/workflows/src/dag-executor.ts:3061`.
Resume prepopulates a single `Map<string, NodeOutput>` keyed only by node ID.
Evidence: `packages/workflows/src/dag-executor.ts:2982` through `packages/workflows/src/dag-executor.ts:3008`.
Layer result aggregation overwrites `nodeOutputs` by node ID.
Evidence: `packages/workflows/src/dag-executor.ts:3655` through `packages/workflows/src/dag-executor.ts:3679`.

Architecture needs a route-aware scheduler contract, not only a list of desired outcomes.
At minimum, the PRD should define the persisted conceptual state names and transitions for `not_activated`, `activated`, `running`, terminal node attempts, latest effective output, selected route, negative counter, attempt counter, and execution sequence.

### Finding 3 - High - The condition requirement is clear, but the handoff must distinguish grammar reuse from resolver reuse.

The PRD says route-loop conditions reuse the existing `when` grammar.
Evidence: `prd.md:162` through `prd.md:172`.
It also says every route-loop condition reference must point to the From Node, structured field references require declared `output_format.properties`, and parse/reference errors fail the controller instead of selecting `negative`.
Evidence: `prd.md:174` through `prd.md:210`.
The canonical contract says the same thing.
Evidence: `_bmad-output/specs/spec-route-loop-routing/route-loop-contract.md:53` through `_bmad-output/specs/spec-route-loop-routing/route-loop-contract.md:68`.

The architecture risk is that "reuse existing condition grammar" could be misread as "call the existing condition evaluator unchanged."
The existing evaluator returns `{ parsed: false, result: false }` on syntax errors, which is correct for `when` but not for route-loop controller failure.
Evidence: `packages/workflows/src/condition-evaluator.ts:18` through `packages/workflows/src/condition-evaluator.ts:27` and `packages/workflows/src/condition-evaluator.ts:205` through `packages/workflows/src/condition-evaluator.ts:231`.
The existing output resolver also has compatibility paths that are looser than the route-loop contract.
For structured payloads without declared fields, absent keys return empty rather than throwing.
Evidence: `packages/workflows/src/output-ref.ts:140` through `packages/workflows/src/output-ref.ts:149`.
For schemaless JSON output, present keys can be read as fields.
Evidence: `packages/workflows/src/output-ref.ts:151` through `packages/workflows/src/output-ref.ts:156`.

The PRD is directionally right, but architecture needs a stricter route-loop condition adapter.
That adapter should reuse tokenization and comparison grammar while enforcing From Node only, declared-field-only structured access, and controller failure on parse or output-reference errors.

### Finding 4 - High - `route_loop.output` schema is still an open decision.

The PRD says route-loop output mirrors the core route metadata from `node_routed`.
Evidence: `prd.md:382` through `prd.md:390`.
It then says output should include `route_loop_node_id` and `from_node_id`.
Evidence: `prd.md:388` through `prd.md:390`.
The PRD also records this as an open question.
Evidence: `prd.md:617`.

The addendum explains the source of the ambiguity.
The runtime contract says route output mirrors core event metadata, while the JSON example omits those IDs.
Evidence: `addendum.md:33` through `addendum.md:39`.
The runtime contract event list includes route loop node ID and source node ID, but its JSON output example only includes outcome, target, condition, result, negative count, and max iterations.
Evidence: `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:100` through `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:121`.

This blocks downstream schema and OpenAPI work.
Engine schemas derive workflow types from Zod, server OpenAPI wraps the engine workflow schema, and the web client consumes generated API types.
Evidence: `packages/workflows/src/schemas/workflow.ts:114` through `packages/workflows/src/schemas/workflow.ts:119` and `packages/server/src/routes/schemas/workflow.schemas.ts:10` through `packages/server/src/routes/schemas/workflow.schemas.ts:13`.
Without a closed output shape, architecture cannot specify the `RouteLoopOutput` schema, downstream `$router.output.*` references, event projection, generated web types, or builder inspector fields.

### Finding 5 - High - Web builder scope and route UI states are not decided.

The PRD makes web builder support part of MVP.
Evidence: `prd.md:543` through `prd.md:558`.
It requires a branch controller with one input and three labeled output ports, direct serialization into `route_loop.routes`, synchronized input edge and `from`, and blocking save/run for missing routes.
Evidence: `prd.md:420` through `prd.md:459`.
The canonical UI builder contract has the same requirements.
Evidence: `_bmad-output/specs/spec-route-loop-routing/ui-builder-contract.md:1` through `_bmad-output/specs/spec-route-loop-routing/ui-builder-contract.md:27`.

The PRD still leaves the mandatory surface open.
Evidence: `prd.md:618`.
The addendum states the repo has more than one relevant authoring surface and leaves exact priority open.
Evidence: `addendum.md:88` through `addendum.md:95`.
That is a product decision because the production builder and experimental console builder have different architectures.

The production builder currently serializes React Flow edges only into `depends_on`.
Evidence: `packages/web/src/components/workflows/WorkflowCanvas.tsx:31` through `packages/web/src/components/workflows/WorkflowCanvas.tsx:74`.
Its drop flow only creates `command`, `prompt`, or `bash` nodes.
Evidence: `packages/web/src/components/workflows/WorkflowCanvas.tsx:150` through `packages/web/src/components/workflows/WorkflowCanvas.tsx:179`.
Its node inspector type selector only exposes Command, Prompt, and Bash.
Evidence: `packages/web/src/components/workflows/NodeInspector.tsx:213` through `packages/web/src/components/workflows/NodeInspector.tsx:247`.
The experimental builder has a variant registry for prompt, command, bash, script, loop, approval, and cancel, but no `route_loop`.
Evidence: `packages/web/src/experiments/console/builder/variants/registry.ts:21` through `packages/web/src/experiments/console/builder/variants/registry.ts:105`.

The PRD also leaves the route target display state open.
Evidence: `prd.md:620`.
Current API and web state enums include `pending`, `running`, `completed`, `failed`, and `skipped`, but not `not_activated`.
Evidence: `packages/server/src/routes/schemas/workflow.schemas.ts:127` through `packages/server/src/routes/schemas/workflow.schemas.ts:137` and `packages/workflows/src/schemas/workflow-run.ts:38` through `packages/workflows/src/schemas/workflow-run.ts:54`.
The route-loop contract explicitly distinguishes unselected branches from skipped branches.
Evidence: `prd.md:393` through `prd.md:401` and `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:123` through `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:129`.

Downstream architecture needs the PRD to pick the required builder surface and the explicit UI state name before designing routes, generated types, and state projection.

## Root Cause

The PRD successfully converts the canonical route-loop contract into functional requirements, but it leaves several architecture-defining product decisions in the open-question section.
Those decisions are not downstream implementation preferences.
They define the durable state model, event authority, route output schema, resume/retry reconstruction rules, and required web authoring surface.

The current codebase makes those decisions especially important because workflow execution, resume, retry, SSE, and web projections are already built around static DAG layers, node-ID-keyed latest outputs, best-effort event writes, and fixed node status enums.
Evidence: `packages/workflows/src/dag-executor.ts:744` through `packages/workflows/src/dag-executor.ts:790`, `packages/workflows/src/dag-executor.ts:2982` through `packages/workflows/src/dag-executor.ts:3008`, `packages/workflows/src/store.ts:127` through `packages/workflows/src/store.ts:138`, and `packages/server/src/routes/schemas/workflow.schemas.ts:127` through `packages/server/src/routes/schemas/workflow.schemas.ts:137`.

## Recommendations

1. Close route state durability as a PRD requirement - high effort - high impact.
   State whether `workflow_run.metadata` is the authoritative route-loop state, whether `node_routed` is mandatory persisted control evidence, and what happens if route event persistence fails.
   The safest shape is metadata as authoritative scheduler state plus `node_routed` as required audit/SSE evidence, with architecture explicitly defining whether route-event write failure aborts the route decision.

2. Add a route-aware state model section - high effort - high impact.
   Define the conceptual persisted state fields for activation, selected route, negative counters, attempt counters, execution sequence, latest output by node, never-activated nodes, and route-triggered invalidation.
   Include state transitions for positive, negative, exhausted, pause/resume, retry-node, and process restart.

3. Make `route_loop.output` a closed schema - medium effort - high impact.
   Require or reject `route_loop_node_id` and `from_node_id`.
   Define the final field list, field names, value types, and whether downstream `$router.output.*` references are supported through an `output_format`-like declared schema or a built-in route output schema.

4. Clarify condition implementation policy - medium effort - medium impact.
   Say the grammar is reused, but route-loop reference validation and parse-error handling are stricter than ordinary `when`.
   Require From Node only and declared-field-only checks before runtime, with runtime revalidation for stale state and resume.

5. Pick the MVP web builder surface and route UI state name - medium effort - high impact.
   Decide whether production builder, experimental console builder, or both must ship route-loop authoring.
   Decide whether the UI state is exactly `not_activated` and update API/OpenAPI/SSE expectations accordingly.

## Trade-offs

| Option                                                            | Pros                                                                                                                                        | Cons                                                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metadata is authoritative and `node_routed` is audit/SSE evidence | Resume/retry can be deterministic even if event insertion is best-effort; fits the existing `workflow_run.metadata` route counter direction | Requires careful metadata update ordering and a separate projection story for event history completeness                                            |
| `node_routed` is authoritative control-flow evidence              | One chronological stream can reconstruct route state, attempts, and SSE history                                                             | Conflicts with the current non-throwing event-store contract and likely requires transactional event writes or executor abort behavior              |
| Ship production builder support first                             | Aligns with the visible `/workflows` authoring surface and the PRD's "Web builder" language                                                 | Current production builder supports fewer node kinds and serializes only ordinary dependency edges, so route ports are a larger lift                |
| Ship experimental console builder support first                   | The variant registry is closer to full engine shape and may absorb `route_loop` cleanly                                                     | The PRD does not state that experimental console builder is the MVP user-facing surface, so downstream stories may miss the production user journey |

## References

- `_bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/prd.md:14` - The PRD declares the spec bundle as canonical.
- `_bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/prd.md:100` - Route-loop YAML contract starts with standalone node requirements.
- `_bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/prd.md:143` - `max_iterations` budget semantics are specified.
- `_bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/prd.md:162` - Conditions reuse the existing `when` grammar.
- `_bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/prd.md:229` - Activation-before-readiness requirement.
- `_bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/prd.md:306` - Route counters and attempt counters must persist in run metadata.
- `_bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/prd.md:365` - `node_routed` event requirement.
- `_bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/prd.md:382` - `route_loop.output` metadata requirement.
- `_bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/prd.md:615` - Open questions include output IDs, builder surface, route event durability, and UI state naming.
- `_bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/addendum.md:67` - Addendum notes retry/resume projection needs selected-path invalidation and reconstructable route state.
- `_bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/addendum.md:74` - Addendum notes event/SSE surfaces and durability uncertainty.
- `_bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/addendum.md:88` - Addendum notes multiple web builder surfaces.
- `_bmad-output/specs/spec-route-loop-routing/SPEC.md:16` - The spec and companions are the complete canonical contract.
- `_bmad-output/specs/spec-route-loop-routing/SPEC.md:42` - Canonical route-state coherence across resume and retry.
- `_bmad-output/specs/spec-route-loop-routing/route-loop-contract.md:21` - Single-source `from` and `depends_on` rule.
- `_bmad-output/specs/spec-route-loop-routing/route-loop-contract.md:53` - Condition grammar and reference rules.
- `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:3` - Activation model.
- `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:34` - Counter storage.
- `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:64` - Rerun path contract.
- `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:89` - Retry and resume contract.
- `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md:100` - Route event and output contract.
- `_bmad-output/specs/spec-route-loop-routing/ui-builder-contract.md:1` - Builder port and route serialization contract.
- `packages/workflows/src/schemas/dag-node.ts:415` - Current DAG node schema mode field validation has no `route_loop`.
- `packages/workflows/src/loader.ts:96` - Loader parses every raw node through `dagNodeSchema.safeParse()`.
- `packages/workflows/src/loader.ts:139` - Loader validates static DAG structure.
- `packages/workflows/src/dag-executor.ts:744` - Current executor builds static topological layers.
- `packages/workflows/src/dag-executor.ts:3039` - Current executor iterates layers and runs each layer concurrently.
- `packages/workflows/src/dag-executor.ts:2982` - Resume prepopulates node outputs keyed by node ID.
- `packages/workflows/src/store.ts:127` - Workflow event writes are observable-only and must not throw.
- `packages/core/src/db/workflow-events.ts:57` - Core workflow event writes catch errors and never throw.
- `packages/workflows/src/condition-evaluator.ts:205` - Existing condition evaluator returns parse status instead of throwing on syntax errors.
- `packages/workflows/src/output-ref.ts:140` - Existing output reference resolver has lenient structured-output compatibility behavior.
- `packages/server/src/adapters/web/workflow-bridge.ts:222` - Dashboard SSE maps a fixed persisted event type set.
- `packages/server/src/routes/schemas/workflow.schemas.ts:127` - API node state schema lacks `not_activated`.
- `packages/web/src/components/workflows/WorkflowCanvas.tsx:31` - Production builder serializes edges into `depends_on`.
- `packages/web/src/experiments/console/builder/variants/registry.ts:21` - Experimental builder variant list lacks `route_loop`.
