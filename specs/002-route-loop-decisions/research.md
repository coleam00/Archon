# Research: Route Loop Decisions

## Decision: Add `route_loop` As A New Node Mode

**Decision**: Implement `route_loop` as a new workflow node mode with its own `id`, config schema, output, events, counters, retry surface, and UI representation.

**Rationale**: Existing `loop` is an AI prompt loop and must keep its current contract.
Route loops are deterministic control flow and need first-class events and route targets.

**Alternatives considered**:

- Extend existing `loop`.
  Rejected because it would mix AI iteration semantics with route-controller semantics.
- Embed routes in the review node.
  Rejected because it would mix AI work with control-flow policy and hide routing state.
- Add general node-level routes.
  Rejected because v1 only needs the accepted route-loop controller surface.

## Decision: Preserve Acyclic `depends_on` And Add Guarded Route Edges

**Decision**: Keep normal `depends_on` validation acyclic and model runtime repetition through `route_loop` route edges plus bounded negative rerun paths.

**Rationale**: The current executor and loader rely on DAG assumptions.
The user needs bounded review/fix cycles, not arbitrary cyclic graph execution.

**Alternatives considered**:

- Allow arbitrary cycles in `depends_on`.
  Rejected because it would require a new scheduler and make infinite loops easy.
- Add a global emergency execution cap.
  Rejected because the accepted budget belongs to each route-loop controller.
- Convert the executor to an n8n-style stack runtime.
  Rejected because Archon only needs named route outcomes for this feature.

## Decision: Require Three Outcomes

**Decision**: Require exactly `positive`, `negative`, and `exhausted` route targets.

**Rationale**: The three outcomes map directly to condition passed, condition failed with budget remaining, and condition failed after budget exhaustion.
Making all targets required keeps escalation explicit and prevents mid-run ambiguity.

**Alternatives considered**:

- Make `exhausted` optional.
  Rejected because exhausted behavior must route to an explicit node.
- Use `close` instead of `exhausted`.
  Rejected because `close` does not clearly describe budget exhaustion.
- Add `routes.default` or a terminal sentinel.
  Rejected because v1 should stay focused on the three accepted route outcomes.

## Decision: Count Negative Routes In Run Metadata

**Decision**: Store route-loop counters in `workflow_run.metadata.loopCounters`, keyed by route-loop node id.
Store node attempts and execution sequence in the same run metadata family.

**Rationale**: Counters and attempts are scoped to a workflow run, must survive resume and manual retry, and do not need a standalone query API in v1.
Run metadata already carries workflow lifecycle context.

**Alternatives considered**:

- Derive counters only from events.
  Rejected because event replay can drift from the latest state transition and makes atomicity harder.
- Add a dedicated route-loop counter table.
  Rejected because v1 state is small and per-run.
- Reset counters on resume.
  Rejected because that could turn bounded loops into unbounded loops.

## Decision: Reuse The Existing Condition Grammar

**Decision**: Evaluate `route_loop.condition` with the existing condition grammar and output-reference resolution contract.

**Rationale**: Existing `when` evaluation already supports node output references, field access, equality, numeric comparisons, and compound `&&` and `||`.
Reusing that grammar avoids broad expression-language changes.

**Alternatives considered**:

- Add a scoped `$output` alias.
  Rejected because explicit `$review.output.field` references are clearer and already supported.
- Add normalization functions or expression rewriting.
  Rejected because v1 should not change condition language behavior.
- Hard-code field names such as `result` or `status`.
  Rejected because route-loop authors should control their output schema.

## Decision: Restrict Route Conditions To `from`

**Decision**: Require every node reference inside `route_loop.condition` to reference the node declared in `route_loop.from`.

**Rationale**: A route-loop controller has one decision source.
If a workflow needs multiple gate inputs, an aggregation node can produce one gate output for the controller.

**Alternatives considered**:

- Allow arbitrary references in route conditions.
  Rejected because it blurs ownership of the decision and complicates path invalidation.
- Add multi-input route-loop controllers.
  Rejected because aggregation nodes already cover that use case.

## Decision: Route Activation Is The Execution Mode For Route Workflows

**Decision**: Use route activation mode only when a workflow has at least one route-loop node.
Root nodes are activated at workflow start, dependencies remain readiness constraints, and route-loop outcomes activate only the selected target.

**Rationale**: Static DAG execution would run unselected route branches once dependencies are satisfied.
Route activation is the minimal runtime change that prevents unselected branches from executing.

**Alternatives considered**:

- Mark unselected targets as skipped.
  Rejected because unselected route targets are dormant, not skipped work.
- Always use route activation for every workflow.
  Rejected because non-route workflows should keep their current execution behavior.
- Implicitly jump from a negative target back to `from`.
  Rejected because retry paths should remain explicit in the workflow graph.

## Decision: Persist `node_routed` As A Typed Event

**Decision**: Emit and persist a `node_routed` event for every route-loop decision.
The route-loop node output mirrors the safe route metadata from the same decision.

**Rationale**: Route decisions must be debuggable and auditable across attempts, resume, and manual retry.
The main summary should show latest state while the event log keeps full history.

**Alternatives considered**:

- Store route decisions as raw text events.
  Rejected because UI and API consumers need typed route metadata.
- Copy the `from` node output into route-loop output.
  Rejected because route-loop output is control-flow metadata, not review content.
- Store raw condition literals.
  Rejected because comparison literals can contain secrets, prompts, user content, paths, or other sensitive text.

## Decision: Author Route Loops Visually

**Decision**: Add a distinct Web builder node with one input, three labeled output handles, route-edge serialization, route validation, and typed run-detail rendering.

**Rationale**: Route loops are graph-oriented control flow and invalid route shapes should be visible before saving or running.

**Alternatives considered**:

- Provide YAML-only route-loop support.
  Rejected because the accepted requirements include Web authoring and route-port visibility.
- Reuse the existing loop node visuals.
  Rejected because route loops and AI prompt loops need to remain visually and semantically distinct.
