# Addendum: Route Loop Routing

## 1. Source Inventory

The canonical route-loop contract is `_bmad-output/specs/spec-route-loop-routing/SPEC.md`.
The SPEC declares the following companions as part of the complete preservation-validated contract:

- `_bmad-output/specs/spec-route-loop-routing/decision-catalog.md`
- `_bmad-output/specs/spec-route-loop-routing/bmad-lifecycle.md`
- `_bmad-output/specs/spec-route-loop-routing/route-loop-contract.md`
- `_bmad-output/specs/spec-route-loop-routing/runtime-contract.md`
- `_bmad-output/specs/spec-route-loop-routing/ui-builder-contract.md`
- `_bmad-output/specs/spec-route-loop-routing/brownfield.md`
- `_bmad-output/specs/spec-route-loop-routing/architecture-diagrams.md`

The SPEC lists `plans/grill-me/260625-2337-route-loop-decisions.md` and `../bmad-target-follow.md` as traceability sources.
The PRD treats the canonical SPEC and companions as higher authority than earlier examples in the decision log.

## 2. Source Reconciliation

### 2.1 No Scoped Output Alias

The earlier decision log includes an example using `$output.result`.
Later decisions D086 through D095 and `route-loop-contract.md` require existing condition syntax unchanged and explicitly reject a scoped `$output` alias.
The PRD resolves this by requiring `$node.output` or `$node.output.field` syntax only.

### 2.2 Snake Case Metadata

The earlier decision log includes route metadata examples using camelCase names such as `negativeCount` and `maxIterations`.
Decision D048 and `runtime-contract.md` require snake_case for route output and event metadata.
The PRD resolves this by requiring `negative_count` and `max_iterations`.

### 2.3 Route Loop Output Field Set

`runtime-contract.md` says `route_loop.output` mirrors the core route metadata from `node_routed`.
The event metadata list includes route loop node ID and source node ID.
The JSON output example omits those IDs.
The v1 PRD resolves the output contract by requiring `route_loop_node_id` and `from_node_id` in `node_routed` and not requiring them in `route_loop.output`.

## 3. Brownfield Context For Architecture

### 3.1 Engine Schema And Loader

Current DAG node modes are `command`, `prompt`, `bash`, `script`, `loop`, `approval`, and `cancel`.
`route_loop` does not exist today.
The existing `loop` node is an AI prompt loop with fields such as `prompt`, `until`, `until_bash`, `fresh_context`, `interactive`, and `gate_message`.
The new Route Loop must stay separate from that AI loop contract.

The loader currently parses every raw node through `dagNodeSchema.safeParse()`.
It validates unique IDs, `depends_on` references, acyclic graph structure, and `$node.output` references in `when`, prompt nodes, and loop prompts.
Route Loop adds a new expression field and therefore needs its own output-reference validation.

### 3.2 Condition Semantics

The existing condition evaluator supports string equality, inequality, numeric comparisons, shorthand field references, canonical `$node.output.field`, `&&`, and `||`.
Malformed `when` syntax returns `parsed: false` and regular `when` conditions skip fail-closed.
Unresolvable output field references throw `OutputRefError`.
Route Loop should reuse the grammar but treat parse errors as controller failures, not skips.

### 3.3 Runtime Scheduling

The current DAG executor precomputes topological layers and executes each layer concurrently.
This model has no selected-route state, activation state, or dynamic edge concept.
Route Loop therefore requires a route-aware execution path for workflows containing `route_loop`.
The PRD explicitly preserves the existing topological behavior for workflows that do not contain `route_loop`.

### 3.4 Retry And Resume Projection

Current resume prepopulates completed node outputs from `node_completed` and `node_skipped_prior_success` events.
Current retry-node invalidates a failed target plus all static descendants from `depends_on`.
Route Loop needs selected-path invalidation so a Negative Outcome reruns only the path back to the From Node and Route Loop.
Route state must be reconstructable after resume, retry, or process restart.

### 3.5 Events And SSE

`node_routed` does not exist today.
The store event type list, typed workflow emitter, server Web bridge, workflow store, generated web types, and dashboard projection need updates before route events are visible.
Existing event insertion is generally best effort and non-throwing.
Architecture should decide whether route decisions require stronger durability guarantees than ordinary observability events.
SSE propagation is an Archon Web implementation-surface requirement derived from live run visibility, not a separate canonical route-loop source requirement.
The v1 PRD resolves control-state authority by making workflow run metadata authoritative for scheduler state and treating `node_routed` as required audit and live-observability evidence.
Workflow execution control must not depend on best-effort event insertion being the only source of route state.
If required route audit evidence cannot be recorded, the Route Loop fails before activating the selected target.

### 3.6 Checkpoints And Artifacts

Pre-node git checkpoints currently exclude approval and cancel nodes.
Route Loop is a controller and should not create checkout checkpoints unless architecture finds a concrete rollback need.
Typed output artifacts already exist for nodes with `output_type`.
Route Loop output metadata may not need a typed artifact unless docs require it.

### 3.7 Web Builder Surfaces

The server OpenAPI workflow schemas wrap the engine workflow definition schema.
Adding `route_loop` changes generated web types after type generation.
Production workflow builder surfaces currently support only a subset of engine node kinds in places.
The experimental console builder has a fuller variant registry but still lacks `route_loop`.
The PRD leaves exact builder surface priority as an open question because the source says "web builder" but the repo contains more than one relevant authoring surface.
The v1 PRD resolves MVP builder scope as production Web workflow builder support first.
Secondary builder surfaces that can save or run workflows must either fully round-trip Route Loop or block unsupported edits without dropping fields.

## 4. External Landscape Digest

The external research supports a DAG-first design with explicit branch and bounded iteration primitives.
n8n separates IF, Switch, and Loop Over Items concepts and warns that loops need valid termination conditions.
GitHub Actions keeps `needs`, `if`, matrix fanout, and join behavior explicit.
Temporal separates deterministic workflow execution from Activity retries and offers Continue-As-New for durable fresh histories.
Argo Workflows keeps DAGs, conditionals, loops, and bounded recursion as explicit constructs.
Airflow keeps DAGs acyclic, exposes branching, trigger rules, mapped task instances, retry history, and UI history.

The common product guidance is:

- Keep routes explicit.
- Keep loops bounded.
- Keep retries separate from routing.
- Keep resume distinct from re-run.
- Preserve audit history.
- Do not hide skipped, failed, omitted, and not-activated states behind one generic label.

## 5. Comparable Source Links

- n8n IF node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.if/
- n8n Switch node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.switch/
- n8n Loop Over Items node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.splitinbatches/
- n8n looping guidance: https://docs.n8n.io/flow-logic/looping/
- GitHub Actions workflow syntax: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- GitHub Actions expressions: https://docs.github.com/en/actions/concepts/workflows-and-actions/expressions
- Temporal workflow definition: https://docs.temporal.io/workflow-definition
- Temporal workflow execution: https://docs.temporal.io/workflow-execution
- Temporal retry policies: https://docs.temporal.io/encyclopedia/retry-policies
- Temporal Continue-As-New: https://docs.temporal.io/workflow-execution/continue-as-new
- Argo DAG docs: https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/
- Argo loops docs: https://argo-workflows.readthedocs.io/en/latest/walk-through/loops/
- Argo conditionals docs: https://argo-workflows.readthedocs.io/en/latest/walk-through/conditionals/
- Argo enhanced depends docs: https://argo-workflows.readthedocs.io/en/latest/enhanced-depends-logic/
- Argo recursion docs: https://argo-workflows.readthedocs.io/en/latest/walk-through/recursion/
- Airflow DAG docs: https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html
- Airflow dynamic task mapping docs: https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/dynamic-task-mapping.html
- Airflow Dag Run docs: https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html
- Airflow UI docs: https://airflow.apache.org/docs/apache-airflow/stable/ui.html

## 6. Implementation Handoff Notes

These notes are not PRD requirements by themselves.
They are included so the architecture and story workflows do not need to rediscover the brownfield impact.

- Add a `route_loop` schema under `packages/workflows/src/schemas/` and export its inferred type.
- Extend `DagNode` mode detection, mutual exclusivity, type guards, telemetry node type, and checkpoint eligibility.
- Extend loader validation for route target existence, one-source wiring, condition references, acyclic `depends_on`, route-cycle safety, and rerun path self-containment.
- Add a route-aware executor path for workflows containing `route_loop`.
- Preserve existing topological-layer executor behavior for workflows without `route_loop`.
- Extend event types with `node_routed`.
- Extend event projection and resume output reconstruction for route-triggered attempts.
- Extend retry-node invalidation to route-aware selected paths.
- Extend server OpenAPI schemas and regenerate web API types.
- Add web builder variant support for Route Loop.
- Add Web UI event bridge support for route decisions.
- Add docs for authoring Route Loop workflows and distinguish `loop` from `route_loop`.
- Add `not_activated` to the route-aware API and Web projection where graph nodes can be displayed without being executed.

## 7. Suggested Validation Focus

- Schema rejects mixed `route_loop` and executable modes.
- Schema applies `max_iterations` default and bounds.
- Loader rejects missing routes, unknown route targets, self-targeting, multiple `depends_on`, mismatched `from`, and invalid condition references.
- Loader warns when Negative Route Target points directly to the From Node.
- Runtime selects Positive Outcome, Negative Outcome, and Exhausted Outcome according to the counter contract.
- Runtime fails on condition parse errors and output reference errors.
- Runtime reruns only selected paths back to the From Node and Route Loop.
- Runtime preserves prior Attempts and updates `$node.output` to the latest completed Attempt.
- Resume preserves activation state, Negative Count, Attempt counters, and route flow.
- Retry-node on the From Node continues through the Route Loop.
- Direct retry of the Route Loop is blocked.
- `node_routed` appears in persisted events and live event streams.
- Web builder blocks save and run for missing required route targets.
- Web builder keeps one input edge synchronized with `depends_on` and `route_loop.from`.
- Web builder round trips `route_loop.routes` through output ports.
