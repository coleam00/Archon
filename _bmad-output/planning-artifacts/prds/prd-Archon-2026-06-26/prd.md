---
title: Route Loop Routing
status: final
created: 2026-06-26
updated: 2026-06-26
---

# PRD: Route Loop Routing

## 0. Document Purpose

This PRD defines the product requirements for adding controlled `route_loop` routing to Archon's workflow engine, workflow authoring surfaces, runtime observability, and lifecycle behavior.
It is written for Archon maintainers, workflow authors, downstream architecture work, and story creation.
The canonical source is `_bmad-output/specs/spec-route-loop-routing/SPEC.md` plus its declared companion files.
The source documents named in that SPEC are traceability inputs, not stronger authority than the companion contract.
Implementation notes, source reconciliation, brownfield surfaces, and external landscape research are kept in `addendum.md`.

## 1. Vision

Archon should let workflow authors model BMAD quality gate loops without weakening the engine's DAG-first mental model.
A workflow should be able to run dev work, evaluate a review or gate node, route failed gate outcomes back to fix work, and eventually exit through a positive or exhausted path with a clear audit trail.

The feature is a controlled routing primitive, not a general cyclic graph engine.
`route_loop` gives authors a named controller node with one source output, one condition, one bounded negative budget, and three explicit outcomes.
That shape keeps loop behavior inspectable, bounded, and compatible with existing Archon workflows.

The first real target is the BMAD story lifecycle with test-architecture gate steps from the traceability source, where code review, test review, NFR review, or trace gates may need to return work to `bmad-dev-story` or a fix step.
The successful product outcome is not "cycles are now possible".
The successful product outcome is "quality gate failure can return to focused rework safely, repeatedly, and visibly until the workflow exits positive or exhausted."

## 2. Target User

### 2.1 Jobs To Be Done

- As a workflow author, define a quality gate loop in YAML without inventing ad hoc `when` branches or external orchestration scripts.
- As an Archon operator, run a workflow that can repair failed gate outcomes without manually restarting the run or losing audit history.
- As a maintainer, preserve the existing DAG model and current workflow compatibility while introducing bounded runtime routing.
- As a reviewer or debugger, understand which route fired, why it fired, which attempt produced the latest output, and why the loop stopped.
- As a Web UI user, see and author route outcomes as visible graph ports rather than hidden condition strings.

### 2.2 Non-Users For V1

- Authors who need arbitrary cyclic graph execution.
- Authors who need node-level branch routing on every node.
- Authors who need multi-target route fanout or a terminal route sentinel.
- Authors who need expression access to full per-node attempt arrays inside workflow conditions.
- Users trying to redefine TEA semantics inside Archon routing.

### 2.3 Key User Journeys

- **UJ-1. Kevin routes failed code review back to dev work.**
  Kevin maintains an Archon workflow for the BMAD story lifecycle.
  He starts from a workflow where `fix` runs dev work, `review` evaluates it, and `review-router` decides whether the story can advance.
  He declares `review-router` as a `route_loop` that reads `review`, checks `$review.output.result == 'positive'`, routes `positive` to the next step, routes `negative` to `fix`, and routes `exhausted` to escalation.
  The first review fails, the router records a negative route, `fix` and the dependency path back to `review` run again as new attempts, and the run eventually exits through `positive`.
  Kevin opens the event history and can see each route decision, counter value, selected target, and latest output.
  Edge case: if review keeps failing beyond the budget, the run exits through `exhausted` as completed control flow instead of failing the workflow merely because the route budget was consumed.

- **UJ-2. Mira debugs a loop that took too many negative passes.**
  Mira is an Archon maintainer investigating a workflow run where a BMAD quality gate did not converge quickly.
  She opens the run summary and sees only the latest attempt for each node so the main view stays compact.
  She opens event detail and sees attempt numbers, global execution sequence, `node_routed` events, `negative_count`, `max_iterations`, condition text, and selected target.
  She confirms that `$review.output` now points to the latest completed review attempt while earlier attempts remain available for audit.
  Edge case: if the router condition referenced an undeclared field, Mira sees a route-loop failure with a clear output reference error instead of a misleading `negative` route.

- **UJ-3. Ana authors a route loop visually.**
  Ana uses the web workflow builder to create a branch controller node.
  She connects exactly one input edge into `review-router`, and the builder keeps `depends_on` and `route_loop.from` synchronized.
  She connects the `positive`, `negative`, and `exhausted` output ports to real node IDs, with the graph making each branch visible.
  The builder blocks saving or running while any required route is missing.
  Edge case: Ana intentionally points `negative` and `exhausted` to the same node, and the builder allows it because the engine's route-cycle and rerun-path validation owns safety.

## 3. Glossary

- **Activation** - Runtime eligibility for a node to be considered for dependency readiness in workflows that contain `route_loop`.
- **Attempt** - A one-based execution of a node within a workflow run.
- **Exhausted Outcome** - The route selected when the condition is false after the allowed negative route budget has been consumed.
- **From Node** - The single node whose latest output is read by a `route_loop`.
- **Latest Output** - The output exposed by `$node.output`, always from the latest completed attempt for that node.
- **Negative Count** - The count of negative routes taken by one `route_loop` node in one workflow run.
- **Negative Outcome** - The route selected when the condition is false and the negative route budget still allows another pass.
- **Positive Outcome** - The route selected when the condition evaluates true.
- **Route Loop** - A standalone workflow node mode named `route_loop` that controls routing among `positive`, `negative`, and `exhausted` outcomes.
- **Route Target** - The real node ID selected by one route outcome.
- **Rerun Path** - The selected dependency path from a negative route target back to the From Node and then to the Route Loop.
- **Runtime Cycle** - A repeated execution path formed only by a Route Loop route edge plus normal dependency edges.
- **Unselected Route Target** - A route target that was not activated by the current route decision.

## 4. Features

### 4.1 Route Loop YAML Contract

**Description:** Workflow authors can declare a `route_loop` node as a standalone controller that reads exactly one From Node and routes to one of three required outcomes.
The controller has its own node ID, output metadata, events, and negative route budget.
It does not execute AI, shell, script, approval, cancellation, or existing AI `loop` behavior.
Realizes UJ-1 and UJ-3.

**Functional Requirements:**

#### FR-1: Declare A Standalone Route Loop Node

Workflow authors can declare a `route_loop` node with its own `id`, `depends_on`, `from`, `condition`, optional `max_iterations`, and required `routes`.

**Consequences:**

- A valid `route_loop` node parses as a first-class DAG node.
- `route_loop` is represented as a distinct node mode from the existing AI `loop`.
- `route_loop` owns route outcomes and does not add `routes` to regular nodes.
- `route_loop` has no nested body or subgraph.

#### FR-2: Enforce Controller Exclusivity

The system rejects any node that combines `route_loop` with executable modes, conditional node gating, or trigger-rule gating.

**Consequences:**

- Mixed execution-mode route controllers fail validation before runtime.
- A Route Loop node cannot declare `prompt`, `command`, `bash`, `script`, `approval`, `cancel`, or existing `loop`.
- A Route Loop node cannot declare `when`.
- A Route Loop node cannot declare `trigger_rule`.
- Existing nodes without `route_loop` keep their current validation behavior.
- Existing AI `loop` node behavior remains unchanged.

#### FR-3: Enforce Single Source Wiring

The system requires `route_loop.from` to be present, requires `depends_on` to contain exactly one entry, and requires that entry to equal `route_loop.from`.

**Consequences:**

- A Route Loop with no `from` fails validation.
- A Route Loop with multiple direct dependencies fails validation.
- A Route Loop whose `from` and `depends_on` disagree fails validation.
- The From Node must not be made optional through `when`.
- The From Node may use `trigger_rule`, but the Route Loop can run only when the From Node is completed with output.
- If the From Node is skipped, failed, pending, missing, or has no usable output when the Route Loop evaluates, the Route Loop fails fast.
- If multiple gate outputs must contribute to the decision, the workflow author must create a separate aggregation node and point `route_loop.from` to that node.

#### FR-4: Require Three Explicit Route Outcomes

The system requires `route_loop.routes.positive`, `route_loop.routes.negative`, and `route_loop.routes.exhausted`.

**Consequences:**

- Missing `routes` fails validation.
- Missing any one of the three required outcomes fails validation.
- Each route target must be a short string node ID.
- Each route target must reference a real node.
- No route target can point to the same Route Loop node.
- No terminal sentinel such as `__end__` exists in v1.
- A route outcome points to exactly one node ID.
- Different outcomes may share the same target when route-cycle and rerun-path validation still pass.

#### FR-5: Bound Negative Routing With Max Iterations

The system supports `route_loop.max_iterations` as the count of allowed Negative Outcomes for that Route Loop.

**Consequences:**

- If omitted, `max_iterations` defaults to `10`.
- If provided, `max_iterations` must be an integer from `1` through `100`.
- `max_iterations` counts Negative Outcomes, not total route decisions.
- With `max_iterations: 10`, false results 1 through 10 select Negative Outcome and false result 11 selects Exhausted Outcome.
- With `max_iterations: 1`, the first false result selects Negative Outcome and the second false result selects Exhausted Outcome.

### 4.2 Condition Evaluation And Output Contract

**Description:** Route Loop conditions reuse the existing `when` condition grammar, but route-loop parse and reference errors fail the controller instead of silently selecting a branch.
This keeps routing deterministic and prevents broken gate schemas from burning retry budget.
Realizes UJ-1 and UJ-2.

**Functional Requirements:**

#### FR-6: Reuse Existing Condition Grammar

The system evaluates `route_loop.condition` with the existing condition grammar used by `when`.

**Consequences:**

- Conditions support the same comparison and compound expression forms as current `when` conditions.
- Conditions do not support parentheses unless the existing grammar adds them in the future.
- Conditions do not add route-loop-specific functions such as `trim()` or `lower()`.
- Conditions do not add route-loop-specific string normalization.
- Conditions do not rewrite expressions.
- Conditions do not add a scoped `$output` alias.

#### FR-7: Restrict Condition References To The From Node

The system requires every node reference inside `route_loop.condition` to reference the From Node.

**Consequences:**

- A compound condition may use `&&` or `||` only when every referenced node is the From Node.
- A condition referencing any node other than `route_loop.from` makes the workflow invalid.
- Runtime fail-fast remains required as a secondary guard for resume, retry, stale persisted state, or graph shapes that bypass static validation.
- This requirement applies to canonical `$node.output.field` references and shorthand `$node.field` references.

#### FR-8: Support Whole Output Conditions

Workflow authors can compare the whole text output of the From Node without declaring `output_format`.

**Consequences:**

- `$review.output == 'positive'` is valid even when `review` does not declare `output_format`.
- Whole-output references use the existing output string behavior.
- Whole-output references do not require route-specific parsing.

#### FR-9: Support Structured Output Conditions Only Through Declared Fields

Workflow authors can reference structured output fields from the From Node only when those fields are declared in the From Node's `output_format.properties`.

**Consequences:**

- `$review.output.result == 'positive'` requires `review.output_format.properties.result`.
- A field reference not declared in `output_format.properties` fails.
- A missing or unresolvable referenced field fails.
- The Route Loop must not treat output-reference errors as Negative Outcome.

#### FR-10: Fail Route Loop On Condition Parse Errors

The system fails the Route Loop when `route_loop.condition` cannot be parsed.

**Consequences:**

- Route Loop parse errors do not skip like regular `when` parse errors.
- Route Loop parse errors do not select Negative Outcome.
- The user sees a clear error describing the condition syntax failure.
- The workflow does not burn negative route budget for an invalid expression.

### 4.3 Runtime Routing And Bounded Reruns

**Description:** Workflows that use `route_loop` run through an activation model so a route decision can activate a target and normal dependency readiness can carry execution forward.
The runtime preserves DAG compatibility for workflows without Route Loops.
Realizes UJ-1 and UJ-2.

**Route-Aware State Model:**

| Concept                 | Required Meaning                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `not_activated`         | A route-capable graph node that has not been selected or reached in the current route-aware run state        |
| `activated`             | A node selected by startup activation or by a route and eligible to run when its dependencies are ready      |
| `running`               | An activated node currently executing one Attempt                                                            |
| `completed`             | A node Attempt finished successfully and may provide Latest Output                                           |
| `failed`                | A node Attempt failed and may make the workflow fail according to existing semantics                         |
| `skipped`               | A node was explicitly skipped by existing trigger or `when` semantics, not merely unselected by a route      |
| Negative Count          | The persisted count of Negative Outcomes for one Route Loop in one workflow run                              |
| Attempt Counter         | The persisted next Attempt number per node in one workflow run                                               |
| Execution Sequence      | The persisted global ordering counter for node Attempts and route decisions                                  |
| Selected Route          | The latest route decision for one Route Loop, including outcome, target, condition result, and counter state |
| Latest Effective Output | The latest completed Attempt output for a node after route-triggered invalidation and reruns                 |

Workflow run metadata is the authoritative scheduler state for activation, Negative Count, Attempt counters, Execution Sequence, and selected route state.
`route_loop.output` is the authoritative latest route decision output for downstream node references.
`node_routed` events are required audit and live-observability evidence, but workflow execution control must not depend on best-effort event insertion succeeding.
If required route audit evidence cannot be recorded, the Route Loop fails before activating the selected target.
The event log must not be the only copy of control state.

**Functional Requirements:**

#### FR-11: Preserve Existing DAG Behavior For Non-Route Workflows

Workflows that do not contain `route_loop` continue to parse, schedule, execute, summarize, resume, and validate with existing DAG behavior.

**Consequences:**

- Existing workflow files require no migration.
- Existing `loop`, `depends_on`, `when`, `trigger_rule`, retry, resume, approval, cancel, and artifact behavior remains backward compatible.
- Current workflow test coverage for non-route workflows remains valid.

#### FR-12: Activate Nodes Before Dependency Readiness In Route Workflows

Workflows that contain `route_loop` require nodes to be activated before dependency readiness can cause execution.

**Consequences:**

- Root nodes with no dependencies are activated at startup.
- A Route Loop activates the selected route target.
- Normal `depends_on` readiness carries execution forward from the activated target.
- A Route Target is not route-only by default.
- A Route Target may run through normal graph order before a later route activates it again as a new Attempt.
- The engine does not secretly rerun a nested body.
- The engine does not implicitly jump from a fix node back to the From Node.

#### FR-13: Select The Correct Route Outcome

The runtime selects `positive`, `negative`, or `exhausted` from the evaluated condition and the Route Loop's negative budget.

**Consequences:**

- If the condition is true, the runtime selects Positive Outcome regardless of the current Negative Count.
- On Positive Outcome, the runtime resets only that Route Loop node's active counter after recording the route metadata.
- If the condition is false, the runtime increments Negative Count first.
- If the new Negative Count is greater than `max_iterations`, the runtime selects Exhausted Outcome.
- If the new Negative Count is less than or equal to `max_iterations`, the runtime selects Negative Outcome.
- Exhausted Outcome is completed control flow, not a node failure.
- The selected route updates workflow run metadata before downstream activation depends on it.
- The selected route is emitted as `node_routed` audit evidence.

#### FR-14: Create New Attempts For Route-Triggered Reruns

When a route activates a node that has already completed, the runtime runs that node again as a new one-based Attempt.

**Consequences:**

- The latest completed Attempt becomes the source for `$node.output`.
- Earlier Attempts remain available for audit and debug.
- The main run summary shows only the latest Attempt for each node.
- Detailed Attempt history is available through the event log.
- Attempt numbers are one-based.
- Events record both per-node Attempt and global execution sequence.

#### FR-15: Fail Fast On Non-Terminal Route Targets

If a route tries to activate a node that is already running or paused, the workflow fails fast.

**Consequences:**

- The runtime avoids concurrent Attempts of the same node.
- The error identifies the Route Loop and target node.
- The runtime does not mutate counters or outputs in a way that hides the unsafe activation.

#### FR-16: Rerun Only The Selected Retry Path Back To The Router

When a Negative Outcome is intended to retry and the Negative Route Target reaches the From Node, the runtime reruns only the dependency path needed to get from the Negative Route Target back to the From Node and then the Route Loop.

**Consequences:**

- A Negative Outcome path may exit without returning to the same Route Loop and should not warn merely for that shape.
- A retry target that sits after the Route Loop in the dependency graph is unsupported in v1.
- The runtime does not rerun every descendant of the Negative Route Target.
- Multiple dependency paths from the Negative Route Target back to the From Node are allowed.
- All nodes on selected rerun paths run normally.
- There is no exclusion list and no `rerun: false` behavior in v1.
- Nodes inside the selected Rerun Path must not depend on nodes outside that path in v1.
- Rerun path self-containment is validated in the loader and again at runtime.

**Examples:**

- Valid retry cycle: `fix -> review -> review-router`, with `review-router.routes.negative = fix`.
- Valid direct source retry with warning: `review -> review-router`, with `review-router.routes.negative = review`.
- Valid negative exit: `review -> review-router`, with `review-router.routes.negative = manual-escalation` and no path from `manual-escalation` back to `review`.
- Invalid unsupported retry target: `review -> review-router -> downstream-fix`, with `review-router.routes.negative = downstream-fix` when the intent is to retry the review path.
- Invalid self-containment shape: `fix -> review -> review-router` and `review` also depends on `external-context` outside the selected path from `fix` to `review`.

#### FR-17: Enforce Runtime Cycle Safety

The system allows runtime cycles only when formed by a Route Loop route edge plus normal dependency edges guarded by that Route Loop's `max_iterations`.

**Consequences:**

- The `depends_on` graph remains acyclic.
- If a runtime cycle exists, it must return to the same From Node of the same Route Loop.
- Only Negative Outcome may participate in the loop cycle back to the From Node.
- Positive Outcome and Exhausted Outcome must be exit paths.
- Positive Outcome and Exhausted Outcome must not route back to the From Node, the same Route Loop, or the Negative Rerun Path.
- A Negative Outcome path may exit without returning to the same Route Loop and should not warn merely for that shape.
- A Negative Route Target may point directly to the From Node, but validation should warn because this often reruns review without fix work.
- Nested Route Loops are allowed as independent nodes with independent routes and counters.

### 4.4 Lifecycle, Resume, Retry, And Provider Sessions

**Description:** Route Loop state must survive existing workflow lifecycle operations without turning a bounded loop into an unbounded loop or duplicating route side effects.
Realizes UJ-1 and UJ-2.

**Functional Requirements:**

#### FR-18: Persist Route State Within Workflow Run Metadata

The system persists Route Loop counters and attempt counters in workflow run metadata for the active workflow run.

**Consequences:**

- Negative counters are keyed by Route Loop node ID.
- Counter scope is workflow run ID plus Route Loop node ID.
- Starting a new workflow run resets counters by virtue of a new run scope.
- Normal resume and retry do not reset a Route Loop's counter.
- Internal storage may preserve existing metadata naming such as `loopCounters`.
- Route output and event metadata use snake_case fields such as `negative_count` and `max_iterations`.

#### FR-19: Preserve Route Flow On Resume

Resume preserves activation state, Negative Count, Attempt counters, and latest effective outputs.

**Consequences:**

- Pause is a valid runtime state, not a workflow restart.
- After resume, the workflow continues from the paused node and then proceeds through the same route flow.
- Resume cannot create a fresh negative budget for the same Route Loop inside the same workflow run.
- Resume cannot mark unselected branches as skipped merely because they exist in the graph.

#### FR-20: Continue Route Flow After Retry-Node

When `retry-node` is used on a node inside a Route Loop, the retried node's new result continues through the route flow.

**Consequences:**

- Users retry the From Node, such as `review` or `quality-gate`, when they need a fresh route decision.
- The Route Loop controller itself is not directly retryable.
- Retrying a Route Loop controller is blocked because it can duplicate route side effects or increment counters without a new source output.
- Retry invalidation uses the route-aware selected path semantics, not blindly all static descendants.

#### FR-21: Preserve Existing Lifecycle Commands

Cancel, abandon, and resume keep existing Archon lifecycle semantics.

**Consequences:**

- A Route Loop does not introduce a new lifecycle status.
- Cancel still cancels the workflow run through existing cancellation behavior.
- Abandon still discards a non-terminal run through existing behavior.
- Resume still resumes eligible paused or failed workflow state through existing behavior.

#### FR-22: Preserve Existing Provider Session Behavior

Route-triggered reruns use existing node provider session behavior.

**Consequences:**

- A route-triggered rerun uses fresh context only when the node configuration requests fresh context.
- Persisted provider sessions follow existing persist-session constraints.
- Route Loop itself does not invoke a provider and does not create a provider session.

### 4.5 Observability, Output, And Auditability

**Description:** Every route decision must be inspectable through events and node output metadata.
The run summary remains compact while deeper event history preserves each attempt and route decision.
Realizes UJ-2.

**Route Metadata Contract:**

| Surface                 | Required Fields                                                                                                                                                    | Role                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Workflow run metadata   | Route activation state, Negative Count, Attempt counters, execution sequence                                                                                       | Required control state for resume, retry, and bounded routing        |
| `route_loop.output`     | `outcome`, `to`, `condition`, `condition_result`, `negative_count`, `max_iterations`                                                                               | Required latest route decision metadata for downstream nodes         |
| `node_routed` event     | Route Loop node ID, From Node ID, selected outcome, target node ID, condition, `condition_result`, `negative_count`, `max_iterations`, Attempt, execution sequence | Required audit and live-observability evidence                       |
| SSE and Web projections | The `node_routed` event fields that the current run-detail surface needs to render route decisions                                                                 | Required live UI projection, derived from route events and run state |

**Functional Requirements:**

#### FR-23: Emit Node Routed Events

The runtime emits a `node_routed` event for every Route Loop decision.

**Consequences:**

- Event outcome names are exactly `positive`, `negative`, and `exhausted`.
- Event metadata includes the Route Loop node ID.
- Event metadata includes the From Node ID.
- Event metadata includes selected outcome.
- Event metadata includes target node ID.
- Event metadata includes condition expression.
- Event metadata includes boolean `condition_result`.
- Event metadata includes `negative_count`.
- Event metadata includes `max_iterations`.
- For Positive Outcome, `negative_count` records the count before the counter reset.
- For Exhausted Outcome, `condition_result` remains `false`.
- If the required route audit event cannot be recorded, the route decision fails before activating its selected target.

#### FR-24: Expose Route Metadata Through Route Loop Output

`route_loop.output` mirrors the core route metadata from the `node_routed` event and does not copy the From Node output.

**Consequences:**

- Downstream nodes can read selected route metadata without querying the event log.
- The output includes `outcome`, `to`, `condition`, `condition_result`, `negative_count`, and `max_iterations`.
- Route Loop node ID and From Node ID are required in `node_routed` event metadata and are not required fields in `route_loop.output` for v1.
- Route output metadata uses snake_case.
- Route output does not include full attempt history.

#### FR-25: Keep Main Run Summary Compact

The main run summary shows only the latest Attempt for each node and excludes never-activated route targets from executed-node summaries.

**Consequences:**

- Unselected Route Targets are not marked as skipped.
- Unselected Route Targets are not shown as executed nodes in the main run summary.
- A graph UI shows never-activated route-capable nodes as `not_activated`.
- API and Web projections distinguish `not_activated` from `pending` and `skipped`.
- Attempt history remains available through event detail.

#### FR-26: Preserve Durable Route Evidence

Route decisions are persisted through required control state and required audit evidence so resume, retry projection, Web UI projection, and post-run debugging can reconstruct route behavior.

**Consequences:**

- Route state can be reconstructed after process restart.
- Route decisions are not visible only in transient logs.
- Workflow execution control does not depend on best-effort event insertion succeeding.
- Route counters, activation state, and attempt counters are required control state in workflow run metadata.
- Latest route decision metadata is required in the Route Loop's completed output.
- `node_routed` persistence is required audit evidence and live-observability input.
- A route decision cannot silently continue after required route audit evidence fails to persist.
- The event projection can distinguish route-triggered reruns from ordinary retry-node invalidation.
- Archon Web UI and SSE consumers can surface route decisions without guessing from node order.

### 4.6 Web Builder And Authoring Experience

**Description:** The web builder makes Route Loop routing visible and prevents users from producing invalid route-loop YAML.
Realizes UJ-3.

**Functional Requirements:**

#### FR-27: Render Route Loop As A Branch Controller

The production Web workflow builder renders `route_loop` as a branch controller with one input and three labeled output ports.

**Consequences:**

- Output ports are labeled `positive`, `negative`, and `exhausted`.
- Visible ports make route targets obvious on the graph.
- Route Loop nodes are labeled as Route Loop controllers and show the three outcome ports, making them visually distinct from the existing AI `loop` node.
- Experimental or secondary builder surfaces are not mandatory MVP authoring surfaces unless they can save or run workflows.
- Any builder surface that can save or run workflows must either fully round-trip Route Loop or block unsupported Route Loop editing without dropping fields.

#### FR-28: Serialize Route Output Edges Into YAML Routes

Edges from Route Loop output ports serialize directly into `route_loop.routes` string targets.

**Consequences:**

- The `positive` port writes `route_loop.routes.positive`.
- The `negative` port writes `route_loop.routes.negative`.
- The `exhausted` port writes `route_loop.routes.exhausted`.
- No separate edge metadata is required in v1.

#### FR-29: Synchronize Input Edge With From And Depends On

The builder enforces exactly one input edge for a Route Loop and keeps that edge synchronized with both `depends_on` and `route_loop.from`.

**Consequences:**

- Connecting the input edge sets `depends_on` to a one-item array.
- Connecting the input edge sets `route_loop.from` to the same node ID.
- Changing the input edge updates both fields together.
- The builder prevents connecting a second input edge to the same Route Loop.

#### FR-30: Block Save And Run For Missing Required Routes

The builder marks a Route Loop invalid and blocks saving or running when any required route is missing.

**Consequences:**

- A missing Positive Outcome target blocks save and run.
- A missing Negative Outcome target blocks save and run.
- A missing Exhausted Outcome target blocks save and run.
- Different outcomes may target the same node.
- There is no special validation ban on Negative Outcome and Exhausted Outcome sharing a target.

## 5. Cross-Cutting Non-Functional Requirements

### 5.1 Backward Compatibility

- Existing workflows that do not use `route_loop` must continue to load, execute, summarize, resume, retry, validate, and render as they do today.
- The existing AI `loop` node contract must remain unchanged.
- Existing `when` behavior must remain unchanged, including fail-closed skip behavior for unparseable `when` expressions.
- No migration is required for current workflow files.

### 5.2 Safety And Determinism

- Runtime cycles must be bounded by the owning Route Loop's `max_iterations`.
- The engine must fail fast on ambiguous route state, unsafe target activation, invalid rerun path containment, skipped or failed From Node state, and condition evaluation errors.
- The engine must not silently choose Negative Outcome when it cannot confidently evaluate the condition.
- The engine must not infer a route target from naming conventions, graph shape, or prompt content.

### 5.3 Observability And Audit

- Every route decision must be inspectable after the fact.
- Event history must preserve older Attempts and chronological route decisions.
- The main run summary must remain compact enough for normal run review.
- Route output metadata must be structured, stable, and usable by downstream nodes.
- Route metadata fields must use snake_case.

### 5.4 Web And API Type Integrity

- Engine schema changes must flow through server OpenAPI schema generation and web generated types.
- Web builder validation must not drift from engine validation for route-loop-specific invariants.
- Route expression validation should reuse or mirror the engine's allowed node-reference grammar.
- Builder UI must not silently drop unsupported Route Loop fields during round trip.

### 5.5 Performance And Resource Bounds

- The default negative route budget is `10`.
- The maximum configured negative route budget is `100`.
- The runtime must avoid rerunning unrelated descendants outside the selected Rerun Path.
- Selected-path recomputation should be linear in node plus edge count for the current workflow graph.
- Route Loop should not introduce a global emergency execution cap in v1.

## 6. Constraints And Guardrails

### 6.1 Public Surface Constraints

- `route_loop` is the public node mode name.
- Route outcomes are exactly `positive`, `negative`, and `exhausted`.
- Route target values are real node IDs.
- Route target values are short strings.
- Route Loop owns `routes`.
- Regular nodes do not gain `routes` in v1.
- No public `routes.default` exists in v1.

### 6.2 Runtime Guardrails

- `depends_on` remains acyclic.
- Runtime cycles are allowed only through Route Loop route edges.
- Positive Outcome and Exhausted Outcome are exit paths.
- Negative Outcome is the only route allowed to participate in a loop back to the From Node.
- Rerun path self-containment is validated statically and at runtime.
- Nodes inside a Rerun Path cannot depend on nodes outside that path in v1.

### 6.3 Source Reconciliation Guardrails

- The canonical condition syntax is existing `$node.output` or `$node.output.field` syntax.
- Older source examples that use `$output` are not accepted in this PRD.
- The canonical event and output metadata naming style is snake_case.
- Older source examples that use `negativeCount` or `maxIterations` are not accepted in this PRD.
- Route Loop node ID and From Node ID are required in `node_routed` event metadata and are not required fields in `route_loop.output` for v1.

## 7. Non-Goals

- Fully general cyclic graph execution is out of scope.
- Replacing the executor with an n8n-style stack runtime is out of scope.
- Node-level `routes` on regular nodes are out of scope.
- `routes.default` is out of scope.
- Route target sentinels such as `__end__` are out of scope.
- Multi-target route fanout is out of scope.
- A global emergency node execution cap is out of scope.
- Automatic prompt injection for Negative Outcome targets is out of scope.
- Default iteration context injection for Negative Outcome targets is out of scope.
- Exposing `$node.attempts` in workflow expressions is out of scope.
- Direct retry of the Route Loop controller is out of scope.
- Redefining BMAD or TEA lifecycle semantics is out of scope.
- Human-choice routing inside Route Loop is out of scope unless separately specified by a future feature.

## 8. MVP Scope

### 8.1 In Scope

- Engine schema and type support for `route_loop`.
- Loader validation for Route Loop shape, route targets, condition references, and route-cycle constraints.
- Runtime activation model for workflows containing Route Loop.
- Positive, Negative, and Exhausted route selection with bounded Negative Count.
- Route-triggered rerun Attempts and selected Rerun Path invalidation.
- Route Loop state preservation across resume and retry-node.
- Required control state in workflow run metadata, required `route_loop.output` metadata, `node_routed` audit events, and Web/SSE route projections.
- `route_loop.output` metadata.
- Main run summary behavior for latest Attempts and never-activated nodes.
- Production Web builder rendering and round-trip for Route Loop input and output ports.
- Compatibility behavior for secondary builder surfaces that can save or run workflows.
- Focused tests for schema, loader, condition evaluation, executor routing, resume, retry-node, event projection, and builder validation.

### 8.2 Out Of Scope For MVP

- Arbitrary cyclic graph execution.
- Runtime branch fanout to multiple targets per outcome.
- UI support for route-only branch analytics beyond route events and graph state.
- Expression-level access to historical Attempts.
- Automatic prompt augmentation for failed review context.
- Per-route custom retry budgets.
- Route Loop conditions with new expression functions.
- Migration tooling for existing workflows.
- Global graph execution caps.

## 9. Success Metrics

**Primary**

- **SM-1:** A BMAD quality gate workflow can run `fix -> review -> review-router`, route failed review results back to `fix` as fresh Attempts, and eventually exit through Positive Outcome or Exhausted Outcome.
  Validates FR-1 through FR-18 and FR-23 through FR-25.
- **SM-2:** Existing workflows that do not use Route Loop pass existing workflow validation and execution tests without behavior changes.
  Validates FR-11 and §5.1.
- **SM-3:** A route-loop workflow can be resumed after pause or failure without resetting Negative Count or losing latest Attempt semantics.
  Validates FR-18 through FR-20.

**Secondary**

- **SM-4:** The Web builder can create, load, edit, validate, and serialize a Route Loop with one input and three output ports.
  Validates FR-27 through FR-30.
- **SM-5:** Route decisions are visible through required control state, persisted audit events, SSE, run detail, and route-loop output metadata.
  Validates FR-23 through FR-26.
- **SM-6:** Invalid route-loop shapes fail with clear errors before unsafe runtime behavior.
  Validates FR-2 through FR-10 and FR-15 through FR-17.

**Counter-Metrics**

- **SM-C1:** Do not optimize for making every graph cycle valid.
  This counterbalances SM-1 because the product goal is controlled quality-gate routing, not general cyclic execution.
- **SM-C2:** Do not optimize for hiding unselected branches by marking them skipped.
  This counterbalances SM-5 because skipped and not-activated have different meanings in route-loop debugging.
- **SM-C3:** Do not optimize for prompt magic around failed gates.
  This counterbalances SM-1 because workflow authors should explicitly pass the review output, artifacts, route output, or route events they need.

## 10. Risks And Mitigations

- **Risk:** Dynamic routing conflicts with the current static topological-layer executor.
  **Mitigation:** Scope Route Loop as a real runtime routing scheduler only for workflows containing `route_loop`, while preserving current execution for non-route workflows.
- **Risk:** Route decisions are lost on resume if stored only as best-effort events.
  **Mitigation:** Persist route metadata in Route Loop output and workflow run metadata, and extend event projection so route state can be reconstructed.
- **Risk:** Web builder validation drifts from engine validation.
  **Mitigation:** Treat engine validation as authoritative, regenerate OpenAPI types, and add focused builder tests for route-loop round trip and invalid shapes.
- **Risk:** Attempt history makes summaries noisy.
  **Mitigation:** Keep the main summary latest-attempt-only and expose prior Attempts through event detail.
- **Risk:** Authors confuse existing AI `loop` with Route Loop.
  **Mitigation:** Keep distinct YAML names, distinct UI visuals, and explicit docs that `loop` is AI iteration while `route_loop` is routing control.
- **Risk:** Route Loop can hide broken gate schemas if errors are treated as negative results.
  **Mitigation:** Fail the Route Loop on parse errors and unresolved output references.

## 11. Open Questions

1. Should docs include a warning for `routes.negative` directly targeting the From Node, or should that warning appear only in validation output?
2. Should architecture allow optional extra fields in `route_loop.output`, or keep the v1 output contract to the six required fields only?
3. Which secondary builder surfaces, if any, should be upgraded in the same release after the production Web builder is complete?

## 12. Assumptions Index

- No inline assumption tags remain in this PRD.
- The few unresolved items are tracked as Open Questions because they are product or architecture decisions still needing confirmation.
