---
id: SPEC-route-loop-routing
companions:
  - decision-catalog.md
  - bmad-lifecycle.md
  - route-loop-contract.md
  - runtime-contract.md
  - ui-builder-contract.md
  - brownfield.md
  - architecture-diagrams.md
sources:
  - ../../../plans/grill-me/260625-2337-route-loop-decisions.md
  - ../../../../bmad-target-follow.md
---

> **Canonical contract.**
> This SPEC and every file in `companions:` are the complete, preservation-validated contract for route loop routing.
> Source documents listed in frontmatter are for traceability only.

# Route Loop Routing

## Why

Archon needs a controlled workflow routing loop so BMAD story quality gates can send failed review, test review, NFR, or trace outcomes back to dev or fix work without turning the workflow engine into arbitrary cyclic graph execution.
The feature is additive and must preserve Archon's existing DAG model, existing AI `loop` node contract, existing lifecycle commands, and current workflow compatibility.
All Grill Me decisions from D001 through D109 plus O005 are normative in `decision-catalog.md`.

## Capabilities

- **CAP-1**
  - **intent:** Workflow authors can declare `route_loop` as a standalone controller node that reads exactly one source node and selects one of `positive`, `negative`, or `exhausted`.
  - **success:** A workflow containing a valid `route_loop` with `from`, `condition`, `max_iterations`, and all three route targets parses successfully, while missing targets, missing routes, invalid source wiring, or mixed execution modes are rejected before unsafe runtime behavior.
- **CAP-2**
  - **intent:** The runtime can execute bounded negative routing loops that return to fix or gate work through explicit graph paths.
  - **success:** A false condition routes to `negative` for the allowed negative count, the next false condition after the budget routes to `exhausted`, and a true condition routes to `positive` regardless of prior negative count.
- **CAP-3**
  - **intent:** Route loop conditions reuse the existing `when` condition grammar without route-loop-specific aliases, normalization, or hard-coded field names.
  - **success:** Conditions can read whole outputs or declared structured output fields from the `from` node, compound expressions only reference the `from` node, syntax errors fail the route loop, and missing or unresolvable fields fail the route loop.
- **CAP-4**
  - **intent:** Route-triggered reruns create inspectable attempts while preserving audit history.
  - **success:** Completed route targets can run again as new attempts, latest output points to the latest completed attempt, old attempts remain available for audit, and reruns invalidate only the selected path back to the router.
- **CAP-5**
  - **intent:** Route state remains coherent across resume, retry-node, lifecycle operations, and provider session behavior.
  - **success:** Resume preserves activation state, loop counters, and attempt counters; `retry-node` on a node inside a route loop continues through the router; `route_loop` itself is not directly retryable; cancel, abandon, and resume keep existing Archon semantics.
- **CAP-6**
  - **intent:** Runtime and UI surfaces expose route decisions clearly enough to debug loops.
  - **success:** Every route emits `node_routed`, `route_loop.output` mirrors the core route metadata, run summaries stay compact, event history carries attempt detail, and the web builder renders one input plus `positive`, `negative`, and `exhausted` output ports.

## Constraints

- The `depends_on` graph remains acyclic; runtime cycles are allowed only when formed by a `route_loop` route edge plus a normal dependency path protected by that route loop's `max_iterations`.
- `route_loop` must not overload the existing AI `loop` node and must not combine with `prompt`, `command`, `bash`, `script`, `approval`, `cancel`, or `loop`.
- `route_loop.from` is required, must be the only direct dependency of the route loop node, and must equal the single `depends_on` entry.
- `route_loop.routes.positive`, `route_loop.routes.negative`, and `route_loop.routes.exhausted` are all required short string node ids.
- Each route target is exactly one real node id, and no route may target the same `route_loop` node.
- If a negative route is intended to retry, the negative target must be upstream of the router path and the rerun path must be self-contained.
- Positive and exhausted outcomes are exit paths and must not re-enter the loop path.
- Existing `loop`, `depends_on`, `when`, `trigger_rule`, workflow lifecycle, and current workflow migration behavior must remain backward compatible.

## Non-goals

- Fully general cyclic graph execution is out of scope.
- Replacing the executor with an n8n-style stack runtime is out of scope.
- Node-level `routes`, `routes.default`, route sentinels such as `__end__`, multi-target routes, and a global emergency node execution cap are out of scope.
- Automatic prompt injection or default iteration context for negative route targets is out of scope.
- Exposing `$node.attempts` in workflow expressions is out of scope for the first version.
- Direct retry of the `route_loop` controller node is out of scope.

## Success signal

A BMAD quality gate workflow can run `fix -> review -> review-router`, route failed review results back to fix as fresh attempts, eventually exit through `positive` or `exhausted`, and expose enough route metadata for the run stream and builder to explain what happened.
Existing workflows that do not use `route_loop` continue to parse, execute, summarize, resume, and validate as they do today.
