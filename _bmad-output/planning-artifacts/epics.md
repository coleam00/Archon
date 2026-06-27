---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/prd.md
  - _bmad-output/planning-artifacts/prds/prd-Archon-2026-06-26/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-Archon-2026-06-26/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/architecture/architecture-Archon-2026-06-26/IMPLEMENTATION-PLAN.md
  - _bmad-output/planning-artifacts/ux-designs/ux-Archon-2026-06-26/DESIGN.md
  - _bmad-output/planning-artifacts/ux-designs/ux-Archon-2026-06-26/EXPERIENCE.md
  - _bmad-output/specs/spec-route-loop-routing/SPEC.md
  - _bmad-output/specs/spec-route-loop-routing/decision-catalog.md
  - _bmad-output/specs/spec-route-loop-routing/route-loop-contract.md
  - _bmad-output/specs/spec-route-loop-routing/runtime-contract.md
  - _bmad-output/specs/spec-route-loop-routing/ui-builder-contract.md
  - plans/grill-me/260625-2337-route-loop-decisions.md
---

# Archon - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Archon, decomposing the requirements from the PRD, UX Design if it exists, and Architecture requirements into implementable stories.

## Requirements Inventory

### Functional Requirements

- FR-1: Workflow authors can declare a standalone `route_loop` node with its own `id`, `depends_on`, `from`, `condition`, optional `max_iterations`, and required `routes`.
- FR-2: The system rejects any node that combines `route_loop` with executable modes, existing AI `loop`, `when`, or `trigger_rule`.
- FR-3: The system requires `route_loop.from` to be present, requires `depends_on` to contain exactly one entry, and requires that entry to equal `route_loop.from`.
- FR-4: The system requires `route_loop.routes.positive`, `route_loop.routes.negative`, and `route_loop.routes.exhausted` to be explicit real node targets.
- FR-5: The system supports `route_loop.max_iterations` as an integer negative outcome budget from `1` through `100`, with a default of `10`.
- FR-6: The system evaluates `route_loop.condition` with the existing condition grammar used by `when`.
- FR-7: The system requires every node reference inside `route_loop.condition` to reference the From Node.
- FR-8: Workflow authors can compare the whole text output of the From Node without declaring `output_format`.
- FR-9: Workflow authors can reference structured output fields from the From Node only when those fields are declared in the From Node's `output_format.properties`.
- FR-10: The system fails the Route Loop when `route_loop.condition` cannot be parsed or resolved.
- FR-11: Workflows that do not contain `route_loop` continue to parse, schedule, execute, summarize, resume, and validate with existing DAG behavior.
- FR-12: Workflows that contain `route_loop` require nodes to be activated before dependency readiness can cause execution.
- FR-13: The runtime selects `positive`, `negative`, or `exhausted` from the evaluated condition and the Route Loop negative budget.
- FR-14: When a route activates a node that has already completed, the runtime runs that node again as a new one-based attempt.
- FR-15: If a route tries to activate a node that is already running or paused, the workflow fails fast and identifies the Route Loop and target node.
- FR-16: When a Negative Outcome is intended to retry and the Negative Route Target reaches the From Node, the runtime reruns only the selected dependency path back to the From Node and Route Loop.
- FR-17: The system allows runtime cycles only when formed by a Route Loop route edge plus normal dependency edges guarded by that Route Loop's `max_iterations`.
- FR-18: The system persists Route Loop counters, activation state, attempt counters, execution sequence, and latest route snapshots in workflow run metadata.
- FR-19: Resume preserves activation state, Negative Count, attempt counters, selected route state, and latest effective outputs.
- FR-20: When `retry-node` is used on a node inside a Route Loop, the retried node's new result continues through the route flow.
- FR-21: Cancel, abandon, and resume keep existing Archon lifecycle semantics without introducing a new Route Loop lifecycle status.
- FR-22: Route-triggered reruns use existing node provider session behavior, and the Route Loop controller itself does not create a provider session.
- FR-23: The runtime emits a required `node_routed` event for every Route Loop decision.
- FR-24: `route_loop.output` exposes the six required route metadata fields: `outcome`, `to`, `condition`, `condition_result`, `negative_count`, and `max_iterations`.
- FR-25: The main run summary shows only the latest attempt for each node and excludes never-activated route targets from executed-node summaries.
- FR-26: Route decisions are persisted through required control state, required route output metadata, and required audit evidence so route behavior can be reconstructed.
- FR-27: The production Web workflow builder renders `route_loop` as a branch controller with one input and three labeled output ports.
- FR-28: Edges from Route Loop output ports serialize directly into `route_loop.routes.positive`, `route_loop.routes.negative`, and `route_loop.routes.exhausted`.
- FR-29: The builder enforces exactly one input edge for a Route Loop and keeps that edge synchronized with both `depends_on` and `route_loop.from`.
- FR-30: The builder marks a Route Loop invalid and blocks saving or running when any required route is missing.

### NonFunctional Requirements

- NFR-1: Existing workflows that do not use `route_loop` must continue to load, execute, summarize, resume, retry, validate, and render as they do today.
- NFR-2: The existing AI `loop` node contract must remain unchanged.
- NFR-3: Existing `when` behavior must remain unchanged, including fail-closed skip behavior for unparseable `when` expressions.
- NFR-4: Runtime cycles must be bounded by the owning Route Loop's `max_iterations`.
- NFR-5: The engine must fail fast on ambiguous route state, unsafe target activation, invalid rerun path containment, skipped or failed From Node state, and condition evaluation errors.
- NFR-6: The engine must not silently choose Negative Outcome when it cannot confidently evaluate the condition.
- NFR-7: The engine must not infer a route target from naming conventions, graph shape, or prompt content.
- NFR-8: Every route decision must be inspectable after the fact through durable route state, route output, and route audit events.
- NFR-9: Event history must preserve older attempts and chronological route decisions while keeping the main run summary compact.
- NFR-10: Route output metadata must be structured, stable, downstream-readable, and snake_case.
- NFR-11: Engine schema changes must flow through server OpenAPI schema generation and Web generated types.
- NFR-12: Web builder validation must not drift from engine validation for route-loop-specific invariants.
- NFR-13: Route expression validation should reuse or mirror the engine's allowed node-reference grammar.
- NFR-14: Builder UI must not silently drop unsupported Route Loop fields during round trip.
- NFR-15: The runtime must avoid rerunning unrelated descendants outside the selected Rerun Path.
- NFR-16: Selected-path recomputation should be linear in node plus edge count for the current workflow graph.
- NFR-17: Route Loop should not introduce a global emergency execution cap in v1.
- NFR-18: Route Loop implementation must preserve existing package boundaries between `@archon/workflows`, `@archon/core`, `@archon/server`, and `@archon/web`.

### Additional Requirements

- AR-1: Use an activation-gated DAG controller architecture for any workflow containing `route_loop`.
- AR-2: Keep current static topological DAG behavior for workflows without route nodes or gate route-aware scheduling so non-route workflows remain unchanged.
- AR-3: Treat `workflow_run.metadata` as the authoritative scheduler state for activation, `loopCounters`, attempt counters, invalidation state, execution sequence, and latest route snapshots.
- AR-4: Add `workflow_run.metadata.route_loop_state` for activation, invalidation, attempts, execution sequence, and latest route snapshots while preserving top-level `loopCounters`.
- AR-5: Add a throwing `IWorkflowStore.recordRouteDecision(...)` method as the only route-decision persistence path.
- AR-6: Implement the core route-decision transaction so it updates run metadata, inserts `node_routed`, inserts the Route Loop `node_completed` output event, and commits before target activation.
- AR-7: Keep ordinary `createWorkflowEvent` behavior non-throwing for existing best-effort observability events.
- AR-8: Persist Route Loop completed output with the same six-field core metadata as `node_routed`, excluding event-only fields from v1 output.
- AR-9: Store route loop node id, From Node id, attempt, and execution sequence in `node_routed` event metadata.
- AR-10: Add route-loop state, graph, and scheduler helpers under `packages/workflows/src/route-loop/`.
- AR-11: Loader validation must reject invalid route graph shapes before execution.
- AR-12: Runtime validation must recheck selected rerun path self-containment before route activation or invalidation.
- AR-13: Positive and exhausted routes must be exit paths and must not re-enter the loop path.
- AR-14: A negative path may exit without returning to the same loop, and that shape should not warn merely because it exits.
- AR-15: A negative route that directly targets the From Node is allowed but should warn because it often reruns review without fix work.
- AR-16: `not_activated` is REST and Web projection state, not a persisted execution output.
- AR-17: Add a dedicated `workflow_route` SSE payload mapped from persisted `node_routed` events.
- AR-18: The `workflow_route` SSE payload must carry `runId`, `nodeId`, `fromNodeId`, `outcome`, `to`, `condition`, `conditionResult`, `negativeCount`, `maxIterations`, `attempt`, `executionSeq`, and `timestamp`.
- AR-19: Regenerate `packages/web/src/lib/api.generated.d.ts` after OpenAPI changes.
- AR-20: The production builder must fully support Route Loop authoring, serialization, validation, load, edit, save, and run.
- AR-21: Secondary builder surfaces that can save or run workflows must either exactly round-trip `route_loop` or block unsupported editing and saving.
- AR-22: Direct retry of the Route Loop controller must be blocked because it can duplicate route side effects or increment counters without a new source output.
- AR-23: `$node.output` must point to the latest completed attempt output after route-triggered reruns.
- AR-24: Attempt history must remain audit-only in v1, and workflow expressions must not expose `$node.attempts`.
- AR-25: Negative target nodes must not receive automatic prompt augmentation or default loop iteration context.
- AR-26: Workflow authors must explicitly reference review output, artifacts, route output, or route events when negative target context is needed.
- AR-27: Validation must cover schema, loader, condition evaluation, executor routing, resume, retry-node, event projection, builder validation, and secondary builder guard behavior.
- AR-28: Pre-PR validation must include type checking, linting with zero warnings, format checking, package tests, and `bun run validate`.

### UX Design Requirements

- UX-1: The production Archon Web workflow builder and workflow run detail view are the in-scope product surfaces.
- UX-2: Route Loop UI must preserve Archon's DAG-first mental model and present Route Loop as controlled routing, not a general graph-cycle editor.
- UX-3: The Route Loop controller must be visually distinct from the existing AI `loop` node before the user opens the inspector.
- UX-4: The Route Loop node uses a compact controller treatment with a route accent stripe, `ROUTE` badge, fixed dimensions, and no provider, model, tool, or execution metadata.
- UX-5: The Route Loop node shows one top input port and three right-side output ports labeled exactly `positive`, `negative`, and `exhausted`.
- UX-6: Route outcome meaning must not rely on color alone because visible text labels carry the outcome meaning.
- UX-7: Route output edges use outcome styling only when the edge originates from a Route Loop output port, while normal dependency edges keep neutral styling.
- UX-8: The Route Loop inspector edits condition, `max_iterations`, synchronized From Node, and route target fields while keeping canvas edges and YAML in sync.
- UX-9: The max iterations control shows the visible default `10` and enforces bounds of `1` through `100`.
- UX-10: Builder validation names route-loop-specific invalid states and blocks save and run for missing routes, mismatched From Node, second input edge, self-target route, and unsupported mixed mode.
- UX-11: The YAML split and full view show the serialized `route_loop` contract without becoming the primary authoring surface.
- UX-12: Workflow run detail graph shows latest node state, selected route edge, and `not_activated` route-capable nodes.
- UX-13: The event and logs panel shows `node_routed`, attempt history, condition results, counters, and errors.
- UX-14: Retry UI hides or blocks retry for Route Loop controllers and uses selected-route-path language for eligible nodes inside a route loop.
- UX-15: Runtime detail copy must distinguish condition parse failures, unusable From Node failures, route audit persistence failures, Negative Outcome, and Exhausted Outcome.
- UX-16: `not_activated` must be displayed as its own state and must not be collapsed into skipped, pending, failed, hidden, or an executed-node count.
- UX-17: Keyboard users must be able to create a Route Loop node, open the inspector, edit fields, select route targets, move through validation issues, inspect route decisions, and inspect attempt history.
- UX-18: Screen readers must have node-scoped route port labels such as `review-router positive route`, `review-router negative route`, and `review-router exhausted route`.
- UX-19: The validation panel, inspector, and event or log panel must expose all information required to author and debug a Route Loop without relying on spatial canvas interpretation.
- UX-20: Responsive behavior may collapse panels on narrower screens but must not hide required route outcomes.
- UX-21: The main graph summary must remain latest-attempt-only and must not render every attempt as a separate main-graph node.
- UX-22: Microcopy must use exact public terms such as `route_loop`, `positive`, `negative`, `exhausted`, `from`, `max_iterations`, `negative_count`, and `node_routed`.

### FR Coverage Map

FR-1: Epic 1 - Standalone `route_loop` node declaration.
FR-2: Epic 1 - Controller exclusivity validation.
FR-3: Epic 1 - Single source wiring validation.
FR-4: Epic 1 - Required positive, negative, and exhausted route targets.
FR-5: Epic 1 - Bounded `max_iterations` contract.
FR-6: Epic 1 - Existing condition grammar reuse.
FR-7: Epic 1 - From Node-only condition references.
FR-8: Epic 1 - Whole output condition support.
FR-9: Epic 1 - Declared structured output field references.
FR-10: Epic 1 - Route Loop hard failure on condition parse or output reference errors.
FR-11: Epic 2 - Existing DAG behavior preserved for non-route workflows.
FR-12: Epic 2 - Activation-gated execution for route workflows.
FR-13: Epic 2 - Positive, negative, and exhausted route selection.
FR-14: Epic 2 - Fresh attempts for route-triggered reruns.
FR-15: Epic 2 - Fail-fast handling for non-terminal route targets.
FR-16: Epic 2 - Selected retry path reruns back to the router.
FR-17: Epic 2 - Runtime cycle safety.
FR-18: Epic 2 - Route state persistence in workflow run metadata.
FR-19: Epic 3 - Route flow preservation on resume.
FR-20: Epic 3 - Route-aware `retry-node` continuation.
FR-21: Epic 3 - Existing lifecycle command semantics.
FR-22: Epic 2 - Existing provider session behavior for route-triggered reruns.
FR-23: Epic 2 - Required `node_routed` events.
FR-24: Epic 2 - Six-field `route_loop.output` metadata.
FR-25: Epic 3 - Compact run summary and `not_activated` projection.
FR-26: Epic 2 - Durable route evidence.
FR-27: Epic 4 - Route Loop branch controller in the production Web builder.
FR-28: Epic 4 - Route output edge serialization to YAML routes.
FR-29: Epic 4 - Input edge synchronization with `from` and `depends_on`.
FR-30: Epic 4 - Save and run blocking for missing required routes.

## Epic List

### Epic 1: Safe Route Loop Workflow Definition

Workflow authors can declare `route_loop` safely in YAML and get deterministic validation before runtime.

**FRs covered:** FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8, FR-9, FR-10.

**Implementation notes:** This epic covers schema, mode exclusivity, source wiring, route targets, max iteration bounds, condition grammar reuse, and output reference validation.
Story creation must cover malformed YAML and validation boundaries including missing `from`, multiple `depends_on`, mismatched `from` and `depends_on`, missing routes, self-target routes, nonexistent targets, `max_iterations` default, `1`, `100`, out-of-range values, non-From Node condition references, and undeclared structured output fields.

### Epic 2: Bounded Route Loop Execution

Users can run BMAD quality gate workflows that route `positive`, `negative`, or `exhausted`, rerun selected paths as fresh attempts, and persist route decisions durably.

**FRs covered:** FR-11, FR-12, FR-13, FR-14, FR-15, FR-16, FR-17, FR-18, FR-22, FR-23, FR-24, FR-26.

**Implementation notes:** This epic consolidates activation model, counters, attempts, strict route-decision persistence, `node_routed`, and `route_loop.output` because these share the runtime and store contract.
Story creation must cover runtime boundaries including false count at `max_iterations` versus `max_iterations + 1`, route target already running or paused, negative path exits without returning, direct negative target to From Node warning, multiple rerun paths, rerun path self-containment failure, and route audit persistence failure before activation.

### Epic 3: Route-Aware Recovery And Run Review

Users can resume, retry, cancel, abandon, and inspect route-aware runs without losing route state or confusing unselected branches with skipped nodes.

**FRs covered:** FR-19, FR-20, FR-21, FR-25.

**Implementation notes:** This epic covers lifecycle semantics, route-aware `retry-node`, compact summaries, `not_activated`, API and Web projections, and run detail review.
Story creation must cover recovery and review boundaries including resume after pause, retrying a node inside route flow, direct retry of the Route Loop controller being blocked, unselected targets remaining `not_activated` rather than skipped, and main summaries staying latest-attempt-only.

### Epic 4: Visual Route Loop Authoring

Users can create, load, edit, validate, save, and run Route Loops in the production Web builder without losing route fields.

**FRs covered:** FR-27, FR-28, FR-29, FR-30.

**Implementation notes:** This epic covers one input, three outcome ports, edge-to-YAML serialization, input synchronization, save/run blocking, and secondary builder protection.
Story creation must cover builder round-trip boundaries including second input edge rejection, missing positive, negative, or exhausted routes blocking save and run, shared route targets being allowed, route output port identity being preserved through load, edit, save, run, undo, redo, layout, YAML split view, and generated API type round trip, and secondary builder surfaces either round-tripping exactly or blocking unsupported save and run.

## Epic 1: Safe Route Loop Workflow Definition

Workflow authors can declare `route_loop` safely in YAML and get deterministic validation before runtime.

### Story 1.1: Declare Route Loop As A Controller Node

**Requirements covered:** FR-1, FR-2, FR-5.

As a workflow author,
I want to declare `route_loop` as a standalone controller node,
So that I can model routing without overloading executable node behavior.

**Acceptance Criteria:**

**Given** a workflow node declares `route_loop` with `from`, `condition`, optional `max_iterations`, and `routes`
**When** the workflow is parsed
**Then** the node is recognized as a first-class Route Loop controller
**And** it is distinct from existing AI `loop`.

**Given** a regular non-route node declares `routes`
**When** the workflow is validated
**Then** validation rejects the unsupported route field because regular nodes do not gain routes in v1.

**Given** a `route_loop` node declares a nested body or subgraph
**When** the workflow is validated
**Then** validation rejects the nested structure because Route Loop owns only route control metadata.

**Given** a `route_loop` node also declares `prompt`, `command`, `bash`, `script`, `approval`, `cancel`, existing `loop`, `when`, or `trigger_rule`
**When** the workflow is validated
**Then** validation fails with a clear controller-exclusivity error.

**Given** `max_iterations` is omitted
**When** the node is normalized
**Then** it defaults to `10`.

**Given** `max_iterations` is not an integer from `1` through `100`
**When** the workflow is validated
**Then** validation fails before runtime.

### Story 1.2: Validate Route Loop Source And Routes

**Requirements covered:** FR-3, FR-4, FR-17.

As a workflow author,
I want the loader to validate Route Loop source wiring and target routes,
So that invalid routing graphs fail before execution.

**Acceptance Criteria:**

**Given** a `route_loop` node has no `from` value
**When** the workflow is validated
**Then** validation fails and names the missing source.

**Given** a `route_loop` node has zero, multiple, or mismatched `depends_on` entries
**When** the workflow is validated
**Then** validation fails because `depends_on` must contain exactly `route_loop.from`.

**Given** the From Node uses `when`
**When** the workflow is validated
**Then** validation fails because the From Node cannot be made optional.

**Given** any of `positive`, `negative`, or `exhausted` is missing
**When** the workflow is validated
**Then** validation fails and names the missing route outcome.

**Given** a route target is missing, points to a nonexistent node, or points to the Route Loop node itself
**When** the workflow is validated
**Then** validation fails before runtime.

**Given** a route target is not a short string node id or uses a terminal sentinel such as `__end__`
**When** the workflow is validated
**Then** validation fails before runtime.

**Given** different outcomes share the same target
**When** the graph otherwise passes route validation
**Then** validation allows the shared target.

**Given** a Positive Outcome or Exhausted Outcome would route back to the From Node, the Route Loop, or the Negative Rerun Path
**When** the workflow is validated
**Then** validation fails because positive and exhausted routes must be exit paths.

**Given** `routes.negative` directly targets `route_loop.from`
**When** the workflow is validated
**Then** validation allows the workflow and emits a warning that this often reruns review without fix work.

### Story 1.3: Validate Route Loop Conditions Strictly

**Requirements covered:** FR-6, FR-7, FR-8, FR-9, FR-10.

As a workflow author,
I want Route Loop conditions to reuse the existing condition grammar with stricter route-specific checks,
So that broken gate expressions do not silently route incorrectly.

**Acceptance Criteria:**

**Given** a `route_loop.condition` uses valid existing `when` grammar and references only the From Node
**When** the workflow is validated
**Then** the condition is accepted.

**Given** the condition uses a route-loop-specific alias or function such as `$output`, `trim()`, or `lower()`
**When** the workflow is validated
**Then** validation fails because Route Loop does not extend the existing condition grammar.

**Given** the condition references any node other than `route_loop.from`
**When** the workflow is validated
**Then** validation fails and names the invalid reference.

**Given** the condition uses canonical `$node.output.field` references or shorthand `$node.field` references
**When** the workflow is validated
**Then** every referenced node is checked against `route_loop.from`.

**Given** the condition compares the whole From Node output
**When** the From Node has no `output_format`
**Then** validation accepts the whole-output reference.

**Given** the condition references a structured output field
**When** that field is not declared in `from.output_format.properties`
**Then** validation fails.

**Given** the condition cannot be parsed
**When** the workflow is validated
**Then** validation fails and does not treat the expression as a Negative Outcome.

### Story 1.4: Preserve Existing Validation Behavior Outside Route Loop

**Requirements covered:** FR-11.

As a workflow author,
I want existing workflow validation behavior to remain unchanged when I do not use `route_loop`,
So that current workflows require no migration.

**Acceptance Criteria:**

**Given** a workflow does not declare `route_loop`
**When** it is parsed and validated
**Then** existing `loop`, `depends_on`, `when`, `trigger_rule`, and output reference behavior remains unchanged.

**Given** an existing `when` expression is unparseable
**When** the workflow is validated or executed under existing semantics
**Then** current fail-closed skip behavior remains unchanged.

**Given** route-loop-specific validation code is added
**When** existing non-route workflow tests run
**Then** they continue to pass without requiring workflow file migration.

## Epic 2: Bounded Route Loop Execution

Users can run BMAD quality gate workflows that route `positive`, `negative`, or `exhausted`, rerun selected paths as fresh attempts, and persist route decisions durably.

### Story 2.1: Execute Route Workflows Through Activation

**Requirements covered:** FR-11, FR-12.

As a workflow runner,
I want workflows with `route_loop` to execute through route activation,
So that unselected branches do not run just because their dependencies are ready.

**Acceptance Criteria:**

**Given** a workflow does not contain `route_loop`
**When** it executes
**Then** it uses the existing static DAG behavior.

**Given** a workflow contains `route_loop`
**When** execution starts
**Then** root nodes are activated before dependency readiness is evaluated.

**Given** a route decision selects a target
**When** the selected target's dependencies are ready
**Then** the target is eligible to execute.

**Given** an unselected route target has satisfied dependencies
**When** it has not been activated
**Then** it does not execute.

**Given** the Route Loop's From Node is skipped, failed, pending, missing, or has no usable output when the Route Loop evaluates
**When** route-aware execution reaches the controller
**Then** the Route Loop fails fast and no target is activated.

### Story 2.2: Select Route Outcomes With Bounded Counters

**Requirements covered:** FR-13, FR-18.

As a workflow runner,
I want Route Loop decisions to select `positive`, `negative`, or `exhausted` deterministically,
So that quality gates stop after the configured retry budget.

**Acceptance Criteria:**

**Given** the Route Loop condition evaluates true
**When** the route decision is recorded
**Then** the selected outcome is `positive` regardless of the current Negative Count
**And** that Route Loop's active counter resets only after route metadata is recorded.

**Given** the Route Loop condition evaluates false and the new Negative Count is less than or equal to `max_iterations`
**When** the route decision is recorded
**Then** the selected outcome is `negative`.

**Given** the Route Loop condition evaluates false and the new Negative Count is greater than `max_iterations`
**When** the route decision is recorded
**Then** the selected outcome is `exhausted`.

**Given** `max_iterations` is `10`
**When** false results occur 1 through 10
**Then** those decisions select `negative`
**And** false result 11 selects `exhausted`.

**Given** a route condition parse error or output reference error occurs at runtime
**When** the Route Loop evaluates
**Then** the controller fails and the Negative Count is not burned.

### Story 2.3: Rerun Selected Paths As Fresh Attempts

**Requirements covered:** FR-14, FR-15, FR-16, FR-17.

As a workflow runner,
I want negative routes to rerun only the selected retry path as fresh attempts,
So that unrelated descendants do not rerun and attempt history stays inspectable.

**Acceptance Criteria:**

**Given** a route activates a node that has already completed
**When** the node runs again
**Then** it runs as a new one-based attempt.

**Given** a route tries to activate a node that is running or paused
**When** the runtime detects the unsafe target state
**Then** the workflow fails fast and names the Route Loop and target node.

**Given** a negative route target reaches the From Node through one or more dependency paths
**When** the runtime reruns the route path
**Then** only the selected path back to the From Node and Route Loop is invalidated and rerun.

**Given** the selected rerun path depends on a node outside that path
**When** runtime validation runs
**Then** execution fails with a clear self-containment error.

**Given** a negative path exits without returning to the same Route Loop
**When** it is otherwise valid
**Then** execution does not warn solely because the path exits.

**Given** route edges and dependency edges would create a runtime cycle that does not return to the same From Node of the same Route Loop
**When** runtime validation runs
**Then** execution fails with a clear route-cycle safety error.

**Given** a Positive Outcome or Exhausted Outcome would participate in a loop cycle
**When** runtime validation runs
**Then** execution fails because only Negative Outcome may participate in a bounded retry cycle.

### Story 2.4: Persist Route Decisions Before Activation

**Requirements covered:** FR-18, FR-23, FR-24, FR-26.

As a workflow runner,
I want every route decision persisted before the selected target activates,
So that route state can be resumed, audited, and projected without guessing.

**Acceptance Criteria:**

**Given** a Route Loop decision is made
**When** the runtime records it
**Then** workflow run metadata stores activation state, `loopCounters`, attempt counters, execution sequence, and latest route snapshot.

**Given** the route decision is recorded
**When** persistence succeeds
**Then** a required `node_routed` event is inserted with loop id, From Node id, outcome, target, condition, `condition_result`, `negative_count`, `max_iterations`, attempt, and execution sequence.

**Given** the recorded outcome is `positive`
**When** the `node_routed` event is inserted
**Then** `negative_count` records the count before the counter reset.

**Given** the recorded outcome is `exhausted`
**When** the `node_routed` event is inserted
**Then** `condition_result` remains `false`.

**Given** the route decision is recorded
**When** persistence succeeds
**Then** the Route Loop node completes with output containing `outcome`, `to`, `condition`, `condition_result`, `negative_count`, and `max_iterations`.

**Given** route metadata or required audit evidence cannot be persisted
**When** the runtime handles the decision
**Then** the Route Loop fails before activating the selected target.

### Story 2.5: Preserve Provider Session And Context Behavior

**Requirements covered:** FR-22.

As a workflow author,
I want route-triggered reruns to keep existing provider session semantics,
So that routing does not secretly change agent context behavior.

**Acceptance Criteria:**

**Given** a route-triggered rerun executes a provider node
**When** the node configuration requests fresh context
**Then** the existing fresh-context behavior is used.

**Given** a route-triggered rerun executes a provider node with persisted session behavior
**When** the node configuration allows session persistence
**Then** existing persist-session constraints are followed.

**Given** the Route Loop controller executes
**When** it evaluates and records a route decision
**Then** it does not invoke a provider and does not create a provider session.

**Given** a Negative Outcome targets fix work
**When** the target node runs
**Then** the engine does not automatically inject failed-gate context into the target prompt.

## Epic 3: Route-Aware Recovery And Run Review

Users can resume, retry, cancel, abandon, and inspect route-aware runs without losing route state or confusing unselected branches with skipped nodes.

### Story 3.1: Preserve Route State On Resume

**Requirements covered:** FR-19.

As a workflow runner,
I want paused or failed route-aware runs to resume with their existing route state,
So that a resume does not restart the loop or reset its budget.

**Acceptance Criteria:**

**Given** a route-aware workflow is paused after route state has been recorded
**When** the workflow resumes
**Then** activation state, Negative Count, attempt counters, selected route state, and latest effective outputs are preserved.

**Given** a Route Loop has consumed part of its negative budget
**When** the run resumes
**Then** the Route Loop keeps the same Negative Count for that workflow run.

**Given** unselected route branches exist in the workflow graph
**When** the run resumes
**Then** those branches are not marked skipped merely because they exist.

### Story 3.2: Continue Route Flow After Retry-Node

**Requirements covered:** FR-20.

As a workflow runner,
I want `retry-node` on a node inside a route flow to continue through the router,
So that retrying a gate result produces a fresh route decision.

**Acceptance Criteria:**

**Given** a user retries the From Node of a Route Loop
**When** the retried node completes with a new output
**Then** the route flow continues through the Route Loop using that new output.

**Given** a user retries a node inside a selected route path
**When** retry invalidation runs
**Then** it follows route-aware selected path semantics rather than blindly invalidating every static descendant.

**Given** a user attempts to retry the Route Loop controller directly
**When** the command is handled
**Then** retry is blocked with an explanation that the controller is not directly retryable.

**Given** retry is available for an eligible node inside a route-aware run
**When** the retry action is displayed in the UI
**Then** the copy uses selected-route-path language rather than generic descendant retry language.

### Story 3.3: Preserve Existing Lifecycle Commands

**Requirements covered:** FR-21.

As a workflow runner,
I want cancel, abandon, and resume commands to keep their current meanings for route-aware runs,
So that Route Loop does not introduce a new lifecycle model.

**Acceptance Criteria:**

**Given** a route-aware workflow run is cancelled
**When** cancellation is requested
**Then** existing cancellation behavior is used.

**Given** a route-aware workflow run is abandoned
**When** abandon is requested
**Then** existing abandon behavior is used.

**Given** a route-aware workflow run is resumed
**When** resume is requested
**Then** existing resume eligibility and command behavior are used with route state preservation.

**Given** Route Loop support is added
**When** workflow run status is exposed
**Then** no new lifecycle status is introduced solely for Route Loop.

### Story 3.4: Project Route-Aware Run State For Review

**Requirements covered:** FR-23, FR-25, FR-26.

As a workflow reviewer,
I want run summaries and graph projections to distinguish latest attempts, skipped nodes, and not-activated route targets,
So that I can understand route behavior without reconstructing it from raw event order.

**Acceptance Criteria:**

**Given** a node has multiple route-triggered attempts
**When** the main run summary is displayed
**Then** only the latest attempt is shown in the primary summary.

**Given** a route target was never selected
**When** the graph projection is produced
**Then** the node is represented as `not_activated`.

**Given** a latest route decision exists
**When** the run detail graph is displayed
**Then** the selected route edge is visible with its route outcome label.

**Given** a node is skipped by existing `when` or trigger semantics
**When** the graph projection is produced
**Then** it remains `skipped` and is not confused with `not_activated`.

**Given** route decision history exists
**When** detailed events or logs are viewed
**Then** older attempts and chronological route decisions remain available.

**Given** route decision history is displayed
**When** a route decision row is rendered
**Then** it shows outcome, target, condition result, negative count, max iterations, attempt, and execution sequence.

**Given** a `node_routed` event is persisted
**When** server and Web projections process it
**Then** a `workflow_route` SSE payload is emitted with `runId`, `nodeId`, `fromNodeId`, `outcome`, `to`, `condition`, `conditionResult`, `negativeCount`, `maxIterations`, `attempt`, `executionSeq`, and `timestamp`.

**Given** route runtime errors or terminal outcomes are displayed
**When** the user reviews the run detail
**Then** the copy distinguishes condition parse failure, unusable From Node, route audit persistence failure, Negative Outcome, and Exhausted Outcome using the public route terms.

## Epic 4: Visual Route Loop Authoring

Users can create, load, edit, validate, save, and run Route Loops in the production Web builder without losing route fields.

### Story 4.1: Render Route Loop In The Production Builder

**Requirements covered:** FR-27.

As a workflow author,
I want the Web builder to render Route Loop as a distinct branch controller,
So that I can understand route outcomes visually while authoring the workflow.

**Acceptance Criteria:**

**Given** a workflow contains a `route_loop` node
**When** the production builder renders the graph
**Then** the node appears as a Route Loop controller distinct from existing AI `loop`.

**Given** a Route Loop node is rendered
**When** the author views it on the canvas
**Then** it has one input port and three visible output ports labeled `positive`, `negative`, and `exhausted`.

**Given** a Route Loop node is rendered
**When** the author compares it with an existing AI `loop` node
**Then** it uses Route Loop controller treatment such as route accent, `ROUTE` badge, and no provider, model, tool, or execution metadata.

**Given** a user relies on text rather than color
**When** route outcome ports and selected route events are displayed
**Then** outcome labels remain visible and are not encoded by color alone.

**Given** the builder is used with keyboard or assistive technology
**When** route ports are focused
**Then** node-scoped labels identify each route outcome.

**Given** the builder is used on a narrower responsive layout
**When** panels collapse or resize
**Then** required route outcomes remain available on the canvas or in the inspector.

**Given** route edges and normal dependency edges are both present
**When** the graph is rendered
**Then** route output edges use outcome styling only from Route Loop output ports and normal dependency edges remain neutral.

### Story 4.2: Synchronize Route Loop Input And Output Edges

**Requirements covered:** FR-28, FR-29.

As a workflow author,
I want Route Loop canvas connections to update YAML fields correctly,
So that visual authoring produces a valid `route_loop` contract.

**Acceptance Criteria:**

**Given** an author connects an input edge into a Route Loop
**When** the connection is accepted
**Then** both `depends_on` and `route_loop.from` are set to the same source node id.

**Given** a Route Loop already has an input edge
**When** the author tries to connect a second input edge
**Then** the builder rejects the connection and preserves the existing source.

**Given** an author connects a Route Loop `positive`, `negative`, or `exhausted` output port
**When** the workflow is serialized
**Then** the corresponding `route_loop.routes` key is written to the target node id.

**Given** an author reconnects or edits a route edge
**When** the workflow is serialized
**Then** the route output port identity is preserved.

**Given** an author edits a Route Loop in the inspector
**When** they change condition, `max_iterations`, From Node, or route target fields
**Then** the inspector keeps canvas edges, route target fields, `depends_on`, and YAML in sync.

**Given** an author edits `max_iterations` in the inspector
**When** the field is displayed
**Then** it shows the visible default `10` and enforces the `1` through `100` bounds.

### Story 4.3: Validate Route Loop Save And Run In The Builder

**Requirements covered:** FR-30.

As a workflow author,
I want the builder to block invalid Route Loop workflows before save or run,
So that I do not launch a workflow that the engine must reject.

**Acceptance Criteria:**

**Given** a Route Loop is missing the `positive` target
**When** the author attempts to save or run
**Then** the builder blocks the action and names the missing `positive` route.

**Given** a Route Loop is missing the `negative` target
**When** the author attempts to save or run
**Then** the builder blocks the action and names the missing `negative` route.

**Given** a Route Loop is missing the `exhausted` target
**When** the author attempts to save or run
**Then** the builder blocks the action and names the missing `exhausted` route.

**Given** multiple outcomes share the same target
**When** the route graph passes engine validation
**Then** the builder allows the shared target.

**Given** client validation and server validation disagree
**When** the server returns the authoritative error
**Then** the UI shows the server error and keeps focus on the affected node or route field.

**Given** a Route Loop has mismatched From Node wiring, a second input edge, a self-target route, or unsupported mixed mode
**When** the author validates, saves, or runs
**Then** the builder names the route-loop-specific issue and focuses the affected node or route field.

**Given** Route Loop validation or event copy is shown in the builder or run detail
**When** terms are displayed
**Then** the UI uses the public terms `route_loop`, `positive`, `negative`, `exhausted`, `from`, `max_iterations`, `negative_count`, and `node_routed`.

### Story 4.4: Round-Trip Route Loop Through Builder Surfaces

**Requirements covered:** FR-27, FR-28, FR-29, FR-30.

As a workflow author,
I want builder surfaces to preserve Route Loop fields through load, edit, save, and run,
So that opening a workflow in the UI cannot silently drop routing behavior.

**Acceptance Criteria:**

**Given** a workflow with `route_loop` is loaded in the production builder
**When** the author saves it without route changes
**Then** `route_loop.from`, `condition`, `max_iterations`, and all three routes are preserved.

**Given** a Route Loop graph is edited through undo, redo, layout, YAML split view, or generated API type round trip
**When** the workflow is serialized again
**Then** route output port identity and route target fields remain correct.

**Given** a secondary builder surface can save or run workflows
**When** it encounters `route_loop`
**Then** it either exactly round-trips the Route Loop contract or blocks unsupported save and run with an explicit error.

**Given** Route Loop OpenAPI schema changes are made
**When** Web types are regenerated
**Then** production builder code consumes generated API types rather than importing workflow engine types directly.
