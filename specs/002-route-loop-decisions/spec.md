# Feature Specification: Route Loop Decisions

**Feature Branch**: `002-route-loop-decisions`  
**Created**: 2026-06-27  
**Status**: Draft  
**Input**: User description: "Read requirement in create detail spec for 260625-2337-route-loop-decisions, read grill-me and source code to understand the context comprehensive, don't guess, make sure every decision in grill-me be covered in spec, spawn sub-agents for help, follow TTD, create e2e test to verify, don't forget design the UI/UX for new feature, scout source code to know the context, create detail spec, spawn sub-agents for help."  
**Origin Reference**: [plans/grill-me/260625-2337-route-loop-decisions.md](../../plans/grill-me/260625-2337-route-loop-decisions.md)

## Source Context

This spec is grounded in the current repository behavior and the full grill-me decision log.

- The target workflow is a BMAD-style story lifecycle with repeated quality gates, fix work, and next-story progression.
- Current workflow execution is a static DAG built from `depends_on`, `when`, and `trigger_rule`.
- Current DAG validation rejects normal dependency cycles before runtime.
- Current DAG execution walks topological layers once and executes independent nodes in a layer concurrently.
- The existing `loop` node is an AI prompt loop with `prompt`, `until`, `max_iterations`, optional `until_bash`, and optional interactive gate behavior.
- The new feature is a route controller loop and must not overload the existing `loop` node contract.
- The current condition evaluator already supports `$node.output`, `$node.output.field`, `$node.field`, equality, numeric comparisons, `&&`, and `||`.
- Current `when` parse failures skip nodes fail-closed, while route-loop condition failures must fail fast because the route controller is mandatory control flow.
- Current event types include workflow events, node lifecycle events, loop iteration events, approval events, and retry events, but no `node_routed` event.
- Current Web and console graph surfaces have fixed node-kind unions and do not know about `route_loop`.
- A TDD guard has been added in [packages/workflows/src/dag-executor.test.ts](../../packages/workflows/src/dag-executor.test.ts) under `executeDagWorkflow -- route_loop end-to-end TDD`.
- That test is expected to fail until the feature is implemented because `route_loop` is not yet a supported node mode.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Author A Controlled Review Loop (Priority: P1)

As a workflow author, I can add a `route_loop` controller after a quality gate node so that a failed gate routes back to explicit fix work, a passing gate routes forward, and exhausted retry budget routes to escalation.

**Why this priority**: This is the core product need from the origin requirement and every other behavior depends on a clear public workflow contract.

**Independent Test**: Load a workflow containing `fix -> review -> review-router`, where `review-router` has `route_loop.from: review`, a condition reading the review output, and required `positive`, `negative`, and `exhausted` routes.
Verify the workflow loads, validates, renders as a route-loop node, and preserves the YAML shape on round trip.

**Acceptance Scenarios**:

1. **Given** a workflow with `route_loop.from: review` and `depends_on: [review]`, **When** the workflow is loaded, **Then** the route-loop node is accepted as its own node with its own id, events, output, retry surface rules, and UI representation.
2. **Given** a workflow that omits `routes.exhausted`, **When** the workflow is validated, **Then** validation fails before execution with an error tied to the missing route.
3. **Given** a workflow that combines `route_loop` with `prompt`, `command`, `bash`, `script`, `approval`, `cancel`, or `loop`, **When** the workflow is validated, **Then** validation fails because `route_loop` is execution-mode exclusive.

---

### User Story 2 - Execute Negative, Positive, And Exhausted Routes (Priority: P1)

As a workflow user, I can run a route-loop workflow and trust that each decision activates exactly the configured route target with bounded retry behavior.

**Why this priority**: Bounded runtime routing is the reason the feature exists, and incorrect route activation would either skip required fix work or create unbounded loops.

**Independent Test**: Run the TDD workflow where the first review result is negative and the second review result is positive.
Verify execution order is `fix`, `review`, `fix`, `review`, `done`, that `escalation` does not run, and that two `node_routed` events are emitted.

**Acceptance Scenarios**:

1. **Given** the route-loop condition evaluates false for the first time and `max_iterations` is `10`, **When** the router runs, **Then** it increments the loop counter to `1`, emits `node_routed` with outcome `negative`, and activates only the negative target.
2. **Given** the route-loop condition evaluates false for the eleventh time and `max_iterations` is `10`, **When** the router runs, **Then** it emits outcome `exhausted`, keeps `condition_result: false`, and activates only the exhausted target.
3. **Given** the route-loop condition evaluates true after previous negative attempts, **When** the router runs, **Then** it emits outcome `positive`, records the pre-reset negative counter, resets only that loop node's counter, and activates only the positive target.
4. **Given** a route target has already completed in an earlier attempt, **When** the router activates that target again, **Then** the target runs as a new attempt instead of reusing stale output.

---

### User Story 3 - Debug Attempts And Route Decisions (Priority: P2)

As an operator, I can inspect the latest output, prior attempts, route decisions, counters, and selected targets without losing audit history.

**Why this priority**: Review and fix loops are hard to reason about without explicit route and attempt history.

**Independent Test**: Run a workflow that takes multiple negative routes before success.
Verify the main run summary shows the latest node attempt, the event log keeps every attempt, each `node_routed` event includes routing metadata, and `$node.output` resolves to the latest completed attempt.

**Acceptance Scenarios**:

1. **Given** a node has completed multiple attempts, **When** a later node reads `$node.output`, **Then** it receives the latest completed attempt output.
2. **Given** a route-loop eventually passes, **When** a user inspects the event log, **Then** prior failed review attempts remain available for audit and debug.
3. **Given** a route-loop reaches exhausted, **When** the escalation node runs, **Then** it can read route metadata showing the exhausted outcome, target, condition, condition result, negative count, and max iterations.

---

### User Story 4 - Build And Validate Route Loops In The Web UI (Priority: P2)

As a Web UI user, I can author a route-loop node visually with clear route ports, synchronized route fields, and validation feedback before saving or running the workflow.

**Why this priority**: Route loops are graph-oriented control flow, and the UI must make route targets and invalid shapes visible.

**Independent Test**: In the workflow builder, create a route-loop node, connect one input from a review node, connect `positive`, `negative`, and `exhausted` output ports, save the workflow, reload it, and verify the YAML route targets match the graph edges.

**Acceptance Scenarios**:

1. **Given** a route-loop node in the builder, **When** the node is rendered, **Then** it shows a distinct controller kind with output ports labeled `positive`, `negative`, and `exhausted`.
2. **Given** a user connects the route-loop input edge from `review`, **When** the builder serializes the workflow, **Then** it writes both `depends_on: [review]` and `route_loop.from: review`.
3. **Given** a user attempts to connect a second input edge to the route-loop node, **When** validation runs, **Then** the UI blocks or reports the invalid second input.
4. **Given** two route outcomes intentionally point to the same target, **When** validation runs, **Then** the UI accepts that shape unless another route-cycle rule is violated.

---

### User Story 5 - Preserve Existing Workflow Lifecycle Behavior (Priority: P3)

As an Archon user, I can keep using existing workflows, resume behavior, cancellation, abandon, manual retry, and provider session behavior without route-loop support changing their meaning.

**Why this priority**: The feature must be additive and must not regress current DAG workflows or lifecycle operations.

**Independent Test**: Run the current workflow test suite plus route-loop-specific tests.
Verify workflows without `route_loop` still use current static DAG behavior and route-loop workflows use route activation only when the new node type is present.

**Acceptance Scenarios**:

1. **Given** a workflow contains no `route_loop` nodes, **When** it runs, **Then** it uses the existing topological DAG behavior.
2. **Given** a workflow run is resumed after a pause, **When** execution continues, **Then** route activation state, loop counters, and attempt counters are preserved.
3. **Given** manual `retry-node` is used on a node inside a route-loop path, **When** the retried node completes, **Then** execution continues through the route-loop controller rather than bypassing it.
4. **Given** a user tries to retry the route-loop controller itself, **When** retry eligibility is computed, **Then** the controller is not directly retryable and the user is directed to retry the node referenced by `route_loop.from`.

### Edge Cases

- A route target id is missing from the workflow.
- A route target points to the same `route_loop` node.
- `route_loop.depends_on` has zero, two, or more entries.
- `route_loop.depends_on[0]` does not equal `route_loop.from`.
- The node referenced by `route_loop.from` is skipped or failed when the controller runs.
- The node referenced by `route_loop.from` declares `when` and can be skipped.
- The node referenced by `route_loop.from` declares `trigger_rule` and still completes with output.
- `route_loop.condition` cannot be parsed.
- `route_loop.condition` references a node other than `route_loop.from`.
- `route_loop.condition` references a missing field from structured output.
- `route_loop.condition` reads a field that is not declared in the `from` node's `output_format.properties`.
- `route_loop.condition` reads the whole output string from the `from` node without structured output.
- `max_iterations` is omitted.
- `max_iterations` is `1`.
- `max_iterations` is less than `1`, greater than `100`, non-integer, or non-numeric.
- The negative route targets the `from` node directly.
- The negative route targets a node after the route-loop node rather than an upstream path.
- The negative route path exits instead of returning to the `from` node.
- The negative route path contains multiple paths back to `from`.
- The negative route path contains a node that depends on a node outside the rerun path.
- Positive and exhausted routes try to re-enter the loop path.
- Different outcomes share a target node.
- Negative and exhausted share a target node.
- A route target is already completed.
- A route target is already running or paused.
- A workflow includes nested route loops.
- A workflow has unselected route targets.
- A route-loop run is cancelled, abandoned, paused, resumed, or manually retried.

## Requirements _(mandatory)_

### Functional Requirements

#### Public Workflow Contract

- **FR-001**: System MUST add `route_loop` as a new node mode field and MUST NOT change the existing `loop` node semantics.
- **FR-002**: A `route_loop` node MUST be a standalone workflow node with its own `id`.
- **FR-003**: A `route_loop` node MUST be execution-mode exclusive and MUST NOT be combined with `prompt`, `command`, `bash`, `script`, `approval`, `cancel`, or existing `loop`.
- **FR-004**: A `route_loop` node MUST have required `route_loop.from`, required `route_loop.condition`, required `route_loop.routes.positive`, required `route_loop.routes.negative`, and required `route_loop.routes.exhausted`.
- **FR-005**: System MUST support exactly three route outcomes for route-loop decisions: `positive`, `negative`, and `exhausted`.
- **FR-006**: `positive` MUST mean the route-loop condition evaluated true.
- **FR-007**: `negative` MUST mean the route-loop condition evaluated false and the loop still has negative-route budget remaining.
- **FR-008**: `exhausted` MUST mean the route-loop condition evaluated false after the negative-route budget has been consumed.
- **FR-009**: `route_loop.max_iterations` MUST default to `10` when omitted.
- **FR-010**: If provided, `route_loop.max_iterations` MUST be an integer from `1` to `100`.
- **FR-011**: `route_loop.max_iterations` MUST count allowed `negative` routes and MUST NOT count `positive` routes.
- **FR-012**: When a route-loop condition is false, system MUST increment that loop's negative counter before selecting the outcome.
- **FR-013**: If the incremented negative counter is greater than `max_iterations`, system MUST select `exhausted`.
- **FR-014**: If the incremented negative counter is less than or equal to `max_iterations`, system MUST select `negative`.
- **FR-015**: With `max_iterations: 1`, the first false result MUST route to `negative` and the second false result MUST route to `exhausted`.
- **FR-016**: System MUST NOT add node-level `routes` to regular nodes in the first version.
- **FR-017**: System MUST NOT add public `routes.default` or any terminal sentinel such as `__end__` in the first version.
- **FR-018**: Each route-loop route target MUST be a short string node id and MUST target exactly one node.
  Workflow node ids, `route_loop.from`, route-loop route targets, and node references parsed from `route_loop.condition` MUST share the same safe node-id grammar: `[A-Za-z_][A-Za-z0-9_-]{0,63}`.
  Loader validation and the Web builder MUST reject ids outside that grammar and MUST reject reserved JavaScript object keys `__proto__`, `prototype`, and `constructor`.

#### Validation Rules

- **FR-019**: The normal `depends_on` graph MUST remain acyclic.
- **FR-020**: Runtime cycles MUST be valid only when formed by a `route_loop` route edge plus a normal dependency path protected by that route-loop node's `max_iterations`.
- **FR-021**: System MUST NOT add a global emergency execution cap in the first version.
- **FR-022**: A `route_loop` node MUST declare exactly one `depends_on` entry.
- **FR-023**: The sole `depends_on` entry of a `route_loop` node MUST equal `route_loop.from`.
- **FR-024**: Loader validation MUST reject a `route_loop` whose `from` node does not exist.
- **FR-025**: Loader validation MUST reject any route target id that does not exist.
- **FR-026**: Loader validation MUST reject any route target that points to the same `route_loop` node.
- **FR-027**: Loader validation SHOULD warn when `routes.negative` targets the `from` node directly because this often reruns review without fix work.
- **FR-028**: Loader validation MUST reject `when` on a `route_loop` node.
- **FR-029**: Loader validation MUST reject `trigger_rule` on a `route_loop` node.
- **FR-030**: Loader validation MUST reject a `from` node that declares `when`.
- **FR-031**: Loader validation MUST allow `trigger_rule` on the `from` node.
- **FR-032**: Runtime MUST fail the route-loop node if the `from` node is skipped, failed, missing, or has no usable output when the controller runs.
- **FR-033**: Only the `negative` route MAY participate in a loop cycle back to `route_loop.from`.
- **FR-034**: `positive` and `exhausted` MUST be exit paths and MUST NOT route back to the `from` node, the same `route_loop` node, or the negative rerun path.
- **FR-035**: The `negative` path MAY exit instead of returning to the same loop's `from` node and this shape MUST NOT produce a warning by itself.
- **FR-036**: When `routes.negative` is intended to retry, the negative target MUST be on an upstream dependency path that can reach `route_loop.from` and then the route-loop node.
- **FR-037**: System MUST NOT support a retry target that sits after the route-loop node in the DAG in the first version.
- **FR-038**: A `route_loop` MAY appear inside another route-loop rerun path and MUST manage its own routes and counters independently.

#### Condition Semantics

- **FR-039**: `route_loop.condition` MUST reuse the existing condition grammar without adding route-loop-specific functions, trimming, lowercasing, normalization, parentheses, or expression rewriting.
- **FR-040**: `route_loop.condition` MUST use explicit existing node-reference syntax such as `$review.output.result == 'positive'`.
- **FR-041**: System MUST NOT add a scoped `$output` alias for `route_loop.condition` in the first version.
- **FR-042**: `route_loop.condition` MAY use compound `&&` and `||` expressions.
- **FR-043**: Every node reference inside `route_loop.condition` MUST reference the node declared in `route_loop.from`.
- **FR-044**: If multiple gate inputs are needed, authors MUST model a separate gate aggregation node and set `route_loop.from` to that aggregation node.
- **FR-045**: If `route_loop.condition` reads a field from the `from` node output, that field MUST be declared in the `from` node's `output_format.properties`.
- **FR-045A**: Before evaluating `route_loop.condition`, runtime MUST resolve field references through the same validated `NodeOutput` contract used by existing `when` evaluation and node-output substitution.
  Producer `output_format` schema validation MUST have succeeded before a field reference can route, declared fields MUST be enforced, undeclared or unresolvable fields MUST fail the route-loop node, and whole-output references remain allowed without `output_format`.
- **FR-046**: If `route_loop.condition` reads only the whole output string from the `from` node, `output_format` MUST NOT be required.
- **FR-047**: If `route_loop.condition` cannot be parsed, the route-loop node MUST fail fast rather than skip.
- **FR-048**: If `route_loop.condition` references a missing or unresolvable output field, the route-loop node MUST fail fast rather than treat the result as negative.
- **FR-049**: The route-loop node MUST NOT hard-code field names such as `result`, `gate`, or `status`.

#### Route Activation And Execution

- **FR-050**: If a workflow has no `route_loop` nodes, system MUST keep the existing static DAG execution behavior.
- **FR-051**: If a workflow has at least one `route_loop` node, system MUST use route activation so unselected route branches do not execute merely because their dependencies are satisfied.
- **FR-052**: In route activation mode, root nodes with no dependencies MUST be activated at workflow start.
- **FR-053**: In route activation mode, `depends_on` MUST remain a readiness constraint and MUST NOT itself select route branches.
- **FR-054**: When a route-loop selects an outcome, system MUST activate only the configured target for that selected outcome.
- **FR-055**: Unselected route targets MUST NOT be marked as skipped.
- **FR-056**: Graph UI MAY display unselected route targets as `not_activated`.
- **FR-057**: If a selected route target has already completed, route activation MUST create a new attempt and run the target again.
- **FR-058**: If a selected route target is running or paused, route activation MUST fail fast.
- **FR-059**: After a negative route activates its configured target, normal dependency readiness MUST carry execution forward through the graph.
- **FR-060**: The engine MUST NOT implicitly jump from the negative target back to `route_loop.from`.
- **FR-061**: A node targeted by `routes.negative` MAY also run during the initial graph pass.
- **FR-062**: When a negative route reruns a previously completed target, system MUST rerun the necessary downstream dependency path back to `route_loop.from` and then the route-loop node.
- **FR-063**: A negative rerun MUST NOT rerun every descendant of the negative target.
- **FR-064**: When multiple dependency paths lead from the negative target back to `route_loop.from`, system MUST rerun all nodes on those paths before re-evaluating the route-loop node.
- **FR-065**: When a negative rerun path is selected, system MUST invalidate only nodes on the selected path back to the router for latest-output readiness.
- **FR-066**: System MUST NOT delete old attempt history during rerun path invalidation.
- **FR-067**: First-version route-loop rerun paths MUST NOT include nodes that depend on nodes outside the rerun path.
- **FR-068**: System MUST validate rerun path self-containment at load time and at runtime.
- **FR-069**: Every node on a selected rerun path MUST run normally.
- **FR-070**: System MUST NOT add a `rerun: false` exclusion behavior in the first version.

#### Counters, Attempts, Outputs, And Events

- **FR-071**: System MUST store route-loop negative counters in `workflow_run.metadata.loopCounters`, keyed by route-loop node id.
- **FR-072**: System MUST reset only the selected route-loop node's counter when that loop routes to `positive`.
- **FR-073**: System MUST NOT reset a route-loop counter when that loop routes to `negative`.
- **FR-074**: System MUST NOT reset a route-loop counter when that loop routes to `exhausted`.
- **FR-075**: System MUST NOT reset route-loop counters on normal resume or manual retry.
- **FR-076**: System MUST reset route-loop counters when a new workflow run starts because counters are scoped to workflow run id and route-loop node id.
- **FR-077**: System MUST store per-node attempt counters in workflow run metadata.
- **FR-078**: System MUST store a global execution sequence counter in workflow run metadata.
- **FR-079**: Per-node attempt numbers MUST be one-based.
- **FR-080**: Events for executed nodes and route decisions MUST include both the per-node `attempt` and global `execution_seq` where applicable.
- **FR-080A**: Route-loop counter increments, counter resets, per-node attempt increments, execution sequence increments, route activation state changes, route-loop output writes, and the corresponding `node_routed` event write MUST be performed through one typed, schema-validated workflow-run state transition that commits atomically or fails without partial state.
- **FR-080B**: Before applying a route-loop state transition, system MUST validate existing `workflow_run.metadata` route-loop fields against runtime schemas and fail fast on malformed loop counters, activation state, attempt counters, or execution sequence data.
- **FR-080C**: Route-loop state transitions MUST protect against stale writes by using the existing workflow-run lock and transaction boundary or an equivalent compare-and-set claim so resume, retry, and concurrent dispatch cannot overwrite a newer route decision.
- **FR-081**: The main run summary MUST show only the latest attempt for each node.
- **FR-082**: Detailed attempt history MUST remain available through the event log.
- **FR-083**: `$node.output` MUST resolve to the latest completed attempt output for that node.
- **FR-084**: System MUST NOT expose `$node.attempts` to workflow expressions in the first version.
- **FR-085**: Attempts and history MUST NOT be deleted when a route-loop routes to `positive`.
- **FR-086**: Attempts and history MUST NOT be deleted when a route-loop routes to `exhausted`.
- **FR-087**: `exhausted` MUST be a completed control-flow outcome and MUST NOT fail the route-loop node.
- **FR-088**: System MUST emit a `node_routed` event for every route-loop outcome.
- **FR-089**: `node_routed` events MUST use the same outcome names as YAML: `positive`, `negative`, and `exhausted`.
- **FR-090**: `node_routed` event data MUST include `from`, `outcome`, `to`, `condition`, `condition_result`, `negative_count`, and `max_iterations`, where `condition` is the persisted safe condition representation rather than the raw author expression.
- **FR-090A**: The persisted safe condition representation MUST preserve node references, field names, operators, and boolean structure while redacting non-structural literal comparison values and any future grammar token class that can carry secrets, prompts, PII, raw user content, git remotes, or unsafe raw errors.
- **FR-091**: `node_routed` event data MUST use snake_case metadata fields.
- **FR-092**: `node_routed` events MUST include `negative_count` and `max_iterations` for every outcome.
- **FR-093**: For `positive`, `node_routed` MUST record the negative count before resetting the loop counter.
- **FR-094**: For `exhausted`, `node_routed.condition_result` MUST remain `false`.
- **FR-095**: `route_loop.output` MUST mirror the core route metadata from the corresponding `node_routed` event.
- **FR-096**: `route_loop.output` MUST NOT copy the `from` node output.
- **FR-097**: Route-loop output and route-loop event metadata MUST use snake_case fields.

#### Session, Lifecycle, Resume, And Retry Compatibility

- **FR-098**: Route-triggered reruns MUST use existing node provider session behavior.
- **FR-099**: Route-triggered reruns MUST use fresh context only when the target node config requests it.
- **FR-100**: System MUST NOT automatically inject failure context or iteration context into the negative target prompt.
- **FR-101**: Authors MUST explicitly reference prior review outputs or artifacts when a negative target needs failure context.
- **FR-102**: Cancel, abandon, pause, and resume lifecycle behavior MUST remain aligned with existing Archon behavior.
- **FR-103**: Resume MUST preserve route activation state, loop counters, and attempt counters.
- **FR-104**: Manual retry of a node inside a route loop MUST continue through the route flow from the retried node's new result.
- **FR-105**: `route_loop` nodes MUST NOT be directly retryable.
- **FR-106**: Retry surfaces SHOULD guide users to retry the node referenced by `route_loop.from` when they need a new route decision.

#### Web UI And UX

- **FR-107**: Web workflow builder MUST represent `route_loop` as a distinct node type and not as the existing `loop` node.
- **FR-108**: Web workflow builder MUST render `route_loop` with three output ports labeled `positive`, `negative`, and `exhausted`.
- **FR-109**: Edges from route-loop output ports MUST serialize directly into `route_loop.routes` string targets.
- **FR-110**: The builder MUST enforce exactly one input edge for a route-loop node.
- **FR-111**: The route-loop input edge MUST stay synchronized with `depends_on[0]` and `route_loop.from`.
- **FR-112**: If the user changes the route-loop input edge, the builder MUST update `depends_on` and `route_loop.from` together.
- **FR-113**: The builder MUST prevent or report a second input edge to a route-loop node.
- **FR-114**: The builder MUST mark a route-loop node invalid if any required output route is missing.
- **FR-115**: The builder MUST NOT allow saving or running a route-loop workflow that is missing `positive`, `negative`, or `exhausted` routes.
- **FR-116**: The builder MUST allow multiple outcomes to target the same node when route-cycle validation still passes.
- **FR-117**: The builder MUST NOT special-case-ban `negative` and `exhausted` sharing a target.
- **FR-118**: Graph views MUST render route edges separately from normal dependency edges.
- **FR-119**: Route edges MUST be labeled by outcome.
- **FR-120**: Run detail UI MUST render `node_routed` as a typed visible event rather than a raw fallback text event.
- **FR-121**: Run graph and stream UI MUST expose route outcome, source node, target node, condition, condition result, negative count, max iterations, attempt, and execution sequence.
- **FR-122**: Existing approval UI and pending-input banners MUST remain distinct from route-loop decisions.

#### API, Event Projection, Types, And Generated Artifacts

- **FR-123**: `node_routed` MUST be added to the workflow event type contract used by workflow execution, store typing, event emitters, server event bridges, and web event normalizers.
- **FR-124**: Run detail APIs MUST return route-loop events and route-loop node outputs without dropping or reclassifying them as unknown raw text.
- **FR-125**: Web-generated API types MUST be regenerated when the OpenAPI schema changes for `route_loop`.
- **FR-126**: Bundled schema and bundled defaults checks MUST be updated only if the implementation changes their sources.
- **FR-127**: Existing workflows using `loop`, `depends_on`, `when`, and `trigger_rule` MUST remain backward compatible.

### Constitutional Requirements

- **CR-001 Scope Boundary**: This feature preserves Archon's single-developer default and does not add tenancy, resource visibility, or role policy.
- **CR-002 Package Boundary**: Impacted packages are `@archon/workflows`, `@archon/core` store adapter and event projection, `@archon/server` route/event schemas if OpenAPI changes, `@archon/web`, and `@archon/cli` only if route-loop event display changes are surfaced in CLI output.
- **CR-003 Type/Schema Contract**: The feature requires workflow engine schema changes, route-loop runtime types, workflow event type changes, generated OpenAPI/web types, and web builder node-kind updates.
- **CR-004 Workflow Determinism**: Route-loop routing is deterministic control flow based on a validated condition expression and stored counters.
- **CR-005 Git/Lifecycle Safety**: The feature does not introduce new git mutations and must preserve existing lifecycle behavior for cancel, abandon, resume, and manual retry.
- **CR-006 Observability/Security**: `node_routed` must be structured and must not expose prompts, secrets, PII, raw user message content, git remotes, or unsafe raw errors.

### Key Entities _(include if feature involves data)_

- **RouteLoopConfig**: The workflow YAML contract under `route_loop`, including `from`, `condition`, `max_iterations`, and `routes`.
- **RouteLoopRoutes**: The required target mapping with `positive`, `negative`, and `exhausted` string node ids.
- **RouteOutcome**: One of `positive`, `negative`, or `exhausted`.
- **RouteActivation**: Runtime selection of one route outcome and activation of that outcome's target node.
- **LoopCounter**: Per-workflow-run counter stored in `workflow_run.metadata.loopCounters` for one route-loop node.
- **NodeAttemptCounter**: Per-workflow-run counter tracking one-based execution attempts per node.
- **ExecutionSequence**: Per-workflow-run monotonic sequence for reconstructing total execution order.
- **NodeRoutedEvent**: Persisted and streamed event describing a route-loop decision.
- **RouteLoopOutput**: The route-loop node's latest output metadata mirrored from `node_routed`.
- **NotActivatedNodeState**: Optional UI projection for route targets that were never selected and should not be confused with skipped nodes.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A workflow author can load and save a valid route-loop workflow with all three route outcomes without manual YAML repair.
- **SC-002**: A negative route-loop path that fails ten times with `max_iterations: 10` routes to the negative target ten times and to the exhausted target on the eleventh false decision.
- **SC-003**: A route-loop path that becomes positive after prior negative attempts runs the positive target once and does not run the exhausted target.
- **SC-004**: Existing workflows without `route_loop` continue to pass the current workflow test suite with no changed user-visible behavior.
- **SC-005**: Run detail shows route decisions, selected targets, and counter state within one live refresh cycle after each route decision.
- **SC-006**: The builder blocks saving or running route-loop nodes with missing required routes, missing `from`, mismatched input edge, or invalid route target.
- **SC-007**: The route-loop TDD test in `packages/workflows/src/dag-executor.test.ts` passes after implementation and fails before implementation for the expected missing feature behavior.

## Assumptions

- The phrase "TTD" in the user request is treated as a request for test-driven development because the same request asks for an E2E verification test.
- The first implementation should focus on workflow engine, validation, events, and UI authoring for route-loop v1.
- The route-loop feature is additive and requires no migration for existing workflow definitions.
- Workflow authors can model multi-gate quality decisions by adding a separate aggregation node before `route_loop`.
- The existing condition grammar remains the only expression grammar for v1.
- Attempt history remains event-log based for v1 and is not exposed as `$node.attempts`.

## UI/UX Design Requirements

- Route-loop nodes must read visually as controller nodes, not as AI work nodes.
- The builder node should show compact labels for `from`, `condition`, and `max_iterations`.
- The route-loop inspector should group fields into decision source, condition, budget, and routes.
- Route outputs should be visible as three distinct output handles with stable labels.
- Route edges should use visible labels and should not be visually confused with dependency edges.
- Validation errors should focus the offending route-loop node and field.
- Missing required routes should be visible without opening raw YAML.
- The run graph should distinguish completed route controllers from failed work nodes.
- The run stream should render route decisions as first-class diagnostic events with outcome and counter state.
- Unselected route targets should read as not activated or dormant rather than skipped.
- Approval gates and interactive-loop input banners should remain visually and semantically distinct from route-loop routing.

## TDD Verification Artifact

The requested TDD guard is implemented as a failing end-to-end style workflow executor test in [packages/workflows/src/dag-executor.test.ts](../../packages/workflows/src/dag-executor.test.ts).

The test builds a route-loop workflow with prompt nodes and a mocked provider.
The first review attempt returns `negative`, the second review attempt returns `positive`, and the expected execution order is `fix`, `review`, `fix`, `review`, `done`.
The test also expects `node_routed` events for `negative` and `positive`, asserts that `escalation` does not run, and verifies the run completes rather than fails.

This test intentionally fails before implementation because `route_loop` is not yet a supported node mode.

## Decision Coverage Matrix

| Grill-Me Decisions                                                     | Covered By                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| D001, D002, D003                                                       | FR-001 through FR-003 and User Story 1                                                  |
| D004, D005, D006                                                       | FR-004 through FR-008                                                                   |
| D007, D008, D009, D010, D011                                           | FR-009 through FR-015                                                                   |
| D012, D013, D014, D015, D016                                           | FR-071 through FR-076                                                                   |
| D017, D018                                                             | FR-050 through FR-060                                                                   |
| D019, D020                                                             | FR-016 and FR-017                                                                       |
| D021, D022, D023                                                       | FR-019 through FR-021                                                                   |
| D024, D025, D026                                                       | FR-022 through FR-024                                                                   |
| D027                                                                   | FR-003                                                                                  |
| D028, D029, D030                                                       | FR-039 through FR-049                                                                   |
| D031, D032                                                             | FR-083, FR-095, and FR-096                                                              |
| D033, D034, D035                                                       | FR-085 through FR-087                                                                   |
| D036                                                                   | FR-088 through FR-090                                                                   |
| D037, D038, D039                                                       | FR-025 through FR-027                                                                   |
| D040, D041, D042                                                       | FR-057, FR-058, FR-098, and FR-099                                                      |
| D043, D044, D045, D046                                                 | FR-050 through FR-054                                                                   |
| D047                                                                   | FR-044 and User Story 1                                                                 |
| D048                                                                   | FR-091 and FR-097                                                                       |
| D049                                                                   | FR-082 and FR-084                                                                       |
| D050, D051, D052, D053, D054                                           | FR-077 through FR-082                                                                   |
| D055, D056, D057, D058                                                 | FR-102 through FR-106                                                                   |
| D059, D060                                                             | FR-100 and FR-101                                                                       |
| D061, D062                                                             | FR-055 and FR-056                                                                       |
| D063, D064, D065, D066                                                 | FR-017 and FR-018                                                                       |
| D067, D068                                                             | FR-057, FR-072, and FR-083                                                              |
| D069, D070, D071, D072                                                 | FR-028 through FR-032                                                                   |
| D073, D074, D075, D076                                                 | FR-033 through FR-038                                                                   |
| D077, D078, D079, D080, D081, D082, D083, D084, D085                   | FR-059 through FR-070                                                                   |
| D086, D087, D088, D089, D090, D091, D092, D093, D094, D095, D096, D097 | FR-039 through FR-049 and FR-038                                                        |
| G001                                                                   | This spec resolves known decisions directly and contains no new clarification questions |
| D098, D099, D100, D101, D102, D103, D104                               | FR-107 through FR-119                                                                   |
| D105, D106, D107, D108, D109                                           | FR-088 through FR-097 and FR-120 through FR-124                                         |
| O005                                                                   | FR-127                                                                                  |
