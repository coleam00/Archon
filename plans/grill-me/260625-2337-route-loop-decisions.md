# Grill-Me Decisions - Route Loop Routing

Created: 2026-06-25 23:37 Asia/Ho_Chi_Minh
Mode: normal with explicit decision log request
Source: /Users/dale/Desktop/workspace/OceanLabs/workflow-engine/bmad-target-follow.md

## Context

The target BMAD flow is a story lifecycle with quality gates, not only a two-node review and fix loop.
The target flow is SS, CS, VS, TD, AT, DS, TA, CR, RV, NR, TR, then choose the next story and repeat.
The critical local loop is review or quality gate failure returning to dev or fix work.
Archon currently models workflows as a mostly static DAG with `depends_on`, `when`, and `trigger_rule`.
Archon already has a `loop` node, but that node means an AI prompt loop until a completion condition is met.
The new feature is a route controller loop, so it must not overload the existing `loop` node contract.
n8n was used as a reference for output-port based routing, especially IF, Switch, and Loop Over Items.
The Archon design should borrow named runtime outcomes from n8n without replacing the whole executor with an n8n-style stack runtime.

## Decisions

### D001 - Feature Shape

Decision:
Build a controlled route loop, not arbitrary cyclic graph execution.

Reason:
The user needs bounded review and fix loops, not fully general cycles.
Unbounded cycles would make infinite loops too easy and would conflict with the current DAG assumptions.

### D002 - Route Loop Node Name

Decision:
Use `route_loop` as the new node mode field.

Reason:
The existing `loop` field already has a different meaning.
Using `route_loop` avoids shape-based ambiguity and keeps the public workflow contract clearer.

### D003 - Route Loop Is A Node

Decision:
`route_loop` is a standalone node with its own `id`.

Reason:
The loop controller needs its own events, counter, output metadata, retry surface, and UI representation.
Embedding it inside the review node would mix AI work with control-flow policy.

Example:

```yaml
- id: review-router
  depends_on: [review]
  route_loop:
    from: review
    condition: "$review.output.result == 'positive'"
    max_iterations: 10
    routes:
      positive: next_step
      negative: fix
      exhausted: escalation
```

### D004 - Route Outcomes

Decision:
`route_loop` has exactly three required outcomes: `positive`, `negative`, and `exhausted`.

Reason:
`positive` means the condition passed.
`negative` means the condition failed but the loop still has retry budget.
`exhausted` means the condition failed after the retry budget has been consumed.

### D005 - Exhausted Name

Decision:
Use `exhausted` instead of `close` for the third outcome.

Reason:
`close` is ambiguous.
`exhausted` precisely means the loop reached the max iteration guard and must exit through the fallback path.

### D006 - Required Routes

Decision:
`route_loop.routes.positive`, `route_loop.routes.negative`, and `route_loop.routes.exhausted` are all required.

Reason:
The original requirement is to route to another node when the loop exceeds the limit.
Making `exhausted` optional would allow workflows to fail in the middle instead of using an explicit escalation or close path.

### D007 - Max Iterations Location

Decision:
`max_iterations` belongs to the `route_loop` node.

Reason:
The retry budget is a property of the loop controller, not an individual edge and not the fix node.

### D008 - Max Iterations Default And Bounds

Decision:
`route_loop.max_iterations` defaults to `10`.
If provided, it must be an integer from `1` to `100`.

Reason:
The user explicitly chose default `10`, minimum `1`, and maximum `100`.
The bounds keep accidental high-cost loops from hiding broken gates.

### D009 - Meaning Of Max Iterations

Decision:
`max_iterations` counts allowed `negative` routes.

Reason:
Positive routes should not consume retry budget.
The budget exists to limit repeated failure and fix cycles.

### D010 - Exhaustion Threshold

Decision:
When the condition is false, increment the negative counter first.
If the new count is greater than `max_iterations`, route to `exhausted`.
Otherwise route to `negative`.

Reason:
With `max_iterations: 10`, the workflow is allowed to go to fix 10 times.
The 11th false result goes to exhausted.

Example:

```text
false #1  -> negative
false #10 -> negative
false #11 -> exhausted
```

### D011 - Max Iterations One

Decision:
`max_iterations: 1` allows one negative route.
The second false result routes to exhausted.

Reason:
This follows the chosen exhaustion threshold.

### D012 - Counter Storage

Decision:
Store loop counters in `workflow_run.metadata.loopCounters`.

Reason:
Counters are small, scoped to a workflow run, and do not need independent query APIs in the first version.

Example:

```json
{
  "loopCounters": {
    "review-router": 3
  }
}
```

### D013 - Counter Reset On Positive

Decision:
When `route_loop` routes to `positive`, reset only the counter for that specific loop node.

Reason:
A workflow can contain multiple route loops.
Passing one loop must not erase another loop's state.

### D014 - Counter Is Not Reset On Negative

Decision:
When `route_loop` routes to `negative`, increment the counter and keep it.

Reason:
Resetting on negative would make `max_iterations` ineffective.

### D015 - Counter Is Not Reset On Resume

Decision:
Normal resume and retry do not reset the loop counter.

Reason:
Resetting on resume would allow a crash, pause, or retry to turn a bounded loop into an unbounded loop.

### D016 - Counter Reset Scope

Decision:
The counter resets when the workflow starts over as a new workflow run.

Reason:
The counter is scoped by workflow run id and loop node id.

### D017 - Route Loop Is A Controller

Decision:
`route_loop` only controls routing.
It does not own a nested body or subgraph.

Reason:
This keeps the design closer to Archon's existing node model and makes debug output simpler.

### D018 - Negative Flow Ownership

Decision:
When `route_loop` routes to `negative`, it only activates the configured negative target.
After the negative target runs, normal `depends_on` graph behavior continues.
If that path reaches `from` and then the `route_loop` node again, the loop repeats.

Reason:
The loop controller should not secretly rerun a body.
The workflow should make the retry path explicit through the normal graph order.

Example:

```yaml
- id: fix
  command: bmad-dev-story

- id: review
  command: bmad-code-review
  depends_on: [fix]

- id: review-router
  depends_on: [review]
  route_loop:
    from: review
    condition: "$review.output.result == 'positive'"
    routes:
      positive: next_step
      negative: fix
      exhausted: escalation
```

### D019 - No Node-Level Routes

Decision:
Do not add node-level `routes` in the first version.
`routes` is config only inside `route_loop`.

Reason:
The user clarified that `route_loop` is just a node type, and `routes` belongs to that node's config.
Adding node-level routes would broaden the feature beyond the intended surface.

### D020 - Route Support Scope

Decision:
Only `route_loop` has `routes`.
The first version does not add `routes.default` to regular nodes.

Reason:
This keeps the public YAML focused on one new node type.

### D021 - Dependency Graph Remains Acyclic

Decision:
`depends_on` remains acyclic.
Runtime cycles are formed by a `route_loop` route edge plus the normal `depends_on` path that may lead back to `from`.

Reason:
This preserves the current DAG validation model and confines cycles to controlled route flow.

### D022 - Runtime Cycles Need A Route Loop Guard

Decision:
A runtime cycle is valid only when it is formed by a `route_loop` route edge and a normal dependency path protected by that `route_loop.max_iterations`.

Reason:
This prevents unguarded runtime cycles.

### D023 - No Global Emergency Cap

Decision:
Do not add a global node execution cap in the first version.

Reason:
The user rejected a global cap.
The guard is the required `route_loop.max_iterations`.

### D024 - Route Loop From Field

Decision:
`route_loop.from` is required.

Reason:
The controller must have a single decision source.
This makes validation, UI rendering, and debugging simpler.

### D025 - From Must Be Direct Dependency

Decision:
`route_loop.from` must be the only direct dependency of the `route_loop` node.

Reason:
The controller should run immediately after the node it evaluates.
Multiple dependencies would make the decision source ambiguous.

Example:

```yaml
- id: review-router
  depends_on: [review]
  route_loop:
    from: review
```

### D026 - Route Loop Has One Dependency

Decision:
`route_loop` must have exactly one `depends_on` entry, and that entry must equal `route_loop.from`.

Reason:
If multiple outputs are needed, a separate gate aggregation node should produce one decision output first.

### D027 - Route Loop Is Execution-Mode Exclusive

Decision:
`route_loop` cannot be combined with `prompt`, `command`, `bash`, `script`, `approval`, `cancel`, or existing `loop`.

Reason:
The controller should not run provider, command, shell, script, approval, or cancel behavior.
It only reads output, evaluates condition, updates counter, emits events, and activates a route target.

### D028 - Condition Shape

Decision:
Use a YAML expression in `route_loop.condition`.
The engine must not hard-code the comparison value or the field name.

Reason:
The workflow author owns the routing condition.
`route_loop` only evaluates the condition result and routes to `positive`, `negative`, or `exhausted`.

Example:

```yaml
condition: "$output.result == 'positive'"
```

### D029 - Condition Scope

Decision:
`route_loop.condition` uses the existing condition reference syntax.

Reason:
The loop decision needs one source of truth.
If multiple review nodes must be combined, a separate gate aggregation node should produce the combined output.

### D030 - Condition Evaluation Failure

Decision:
If the condition cannot be evaluated, fail fast.

Reason:
Missing or malformed output is an authoring or contract error.
Treating it as `negative` could waste retry budget and hide broken prompts or schemas.

### D031 - Route Loop Output

Decision:
`route_loop.output` is routing metadata.
It does not copy the `from` node output.

Reason:
Downstream nodes and debug tools should be able to inspect what route was taken and why.
The original decision output remains available through the `from` node.

Example:

```json
{
  "outcome": "negative",
  "from": "review",
  "to": "fix",
  "negativeCount": 3,
  "maxIterations": 10
}
```

### D032 - Latest Output Semantics

Decision:
`$node.output` always points to the latest completed attempt output for that node.
Attempt history is kept separately for debug and audit.

Reason:
Loop conditions and downstream nodes usually need the latest result.
Forcing authors to reference attempt indexes would make workflows much harder to write.

### D033 - Attempts Are Not Deleted On Positive

Decision:
When a loop reaches `positive`, do not delete attempts or history.
Only reset the active counter for that loop.

Reason:
The history explains how the story eventually passed after previous failures.

### D034 - Attempts Are Not Deleted On Exhausted

Decision:
When a loop reaches `exhausted`, do not reset the counter or delete attempts.

Reason:
The escalation node should be able to report how many failures occurred and what happened during each attempt.

### D035 - Exhausted Is Completed Control Flow

Decision:
`exhausted` is a completed control-flow outcome, not a node failure.

Reason:
The exhausted path is explicitly configured.
The escalation or close node owns the business-level failure report.

### D036 - Route Events

Decision:
Emit a `node_routed` event for every route outcome.

Reason:
Loops are hard to debug without explicit route events.
The event should record the source node, outcome, target, counter, and max iterations when relevant.

Example:

```json
{
  "nodeId": "review-router",
  "outcome": "negative",
  "to": "fix",
  "counter": 3,
  "maxIterations": 10
}
```

### D037 - Route Target Validation

Decision:
The loader validates that all route target ids exist.

Reason:
Missing targets are authoring errors and should be rejected before runtime.

### D038 - Route Loop Self Target

Decision:
A route target cannot point to the same `route_loop` node.

Reason:
Self-routing the controller would evaluate the same stale output repeatedly.
It would consume the counter without rerunning the decision source.

### D039 - Negative Can Target From

Decision:
`routes.negative` may target the `from` node directly.
The validator should warn because this often means review is rerun without fix work.

Reason:
Direct rerun can be valid for polling or flaky checks.
For review and fix flows, it is usually a smell.

### D040 - Route-Triggered Rerun

Decision:
When a route activates a node that has already completed, the node gets a new attempt and runs again.

Reason:
The review and fix loop needs `fix` and `review` to run again on each negative pass.
Reusing the previous completed result would make the loop stale.

### D041 - Route To Non-Terminal Node

Decision:
If a route tries to activate a node that is already running or paused, fail fast.

Reason:
Concurrent attempts of the same node would make latest output and counter behavior ambiguous.

### D042 - Provider Session Behavior

Decision:
Route-triggered reruns use the existing node session behavior.
They only use a fresh context when the node config requests it.

Reason:
Review and fix loops often benefit from continuity.
Authors can opt into fresh context for nodes that should not carry session state.

### D043 - Route Loop Owns Its Route Outcomes

Decision:
`route_loop` owns its route outcomes through `route_loop.routes`.
Regular nodes do not gain route outcomes in the first version.

Reason:
This avoids mixing regular DAG behavior with a second routing mechanism on every node.

### D044 - Route Activation Mode

Decision:
In workflows that use routes, nodes must be activated before dependency readiness can cause execution.

Reason:
`depends_on` remains a readiness constraint.
The `route_loop` negative route activates the rework target, then normal dependency readiness carries execution forward.

### D045 - Workflow Start In Route Mode

Decision:
If a workflow uses `route_loop`, root nodes with no dependencies are activated at startup.
If a workflow does not use `route_loop`, keep the existing DAG behavior.

Reason:
This preserves backward compatibility for existing workflows while preventing route workflows from running unselected branches.

### D046 - Route Target Dependency Semantics

Decision:
Do not introduce a new special dependency rule for route targets in this design pass.
For route targets, dependency behavior should remain aligned with the existing workflow semantics as much as possible.

Reason:
The user clarified that this should behave as before.
The only new concept is route activation, not a broader redesign of dependency joins.

### D047 - Current BMAD Modeling Pattern

Decision:
For BMAD review and fix, model the quality decision through a single decision output.
If multiple gates are involved, create a gate aggregation node before `route_loop`.

Reason:
`route_loop.condition` only reads `$output` from one `from` node.
The aggregation node can combine CR, RV, NR, and TR into one `gate` output.

Example:

```yaml
- id: quality-gate
  command: collect-quality-gate
  depends_on: [code-review, test-review, nfr-review, trace]

- id: quality-router
  depends_on: [quality-gate]
  route_loop:
    from: quality-gate
    condition: "$quality-gate.output.result == 'positive'"
    max_iterations: 10
    routes:
      positive: next_story
      negative: dev_fix
      exhausted: escalation
```

## Open Questions

### D048 - Metadata Naming

Decision:
Use snake_case for route loop output and event metadata.

Reason:
Workflow YAML already uses fields such as `max_iterations`, `depends_on`, `trigger_rule`, and `until_bash`.
Using snake_case in route loop metadata keeps author-facing references consistent.

Example:

```json
{
  "outcome": "negative",
  "from": "quality-gate",
  "to": "dev-fix",
  "negative_count": 3,
  "max_iterations": 10
}
```

### D049 - Attempt History Visibility

Decision:
Attempt history is for audit and debug only in the first version.
Workflow expressions use `$node.output` for the latest output and do not expose `$node.attempts`.

Reason:
Exposing attempts in expressions would require indexing, retry semantics, pruning policy, and compatibility rules.
The current routing use case only needs latest output.

### D050 - Attempt Identity In Events

Decision:
Events should record both a per-node `attempt` and a global `execution_seq`.

Reason:
Per-node attempts make debug language clear, such as review attempt 3.
The global execution sequence makes it possible to reconstruct the full workflow timeline.

### D051 - Execution Sequence Storage

Decision:
Store the global execution sequence counter in workflow run metadata.

Reason:
Deriving sequence from event count can be wrong if event writes fail, retries happen, or non-execution events are present.
A dedicated metadata counter is clearer and more deterministic.

### D052 - Node Attempt Counter Storage

Decision:
Store per-node attempt counters in workflow run metadata.

Reason:
Route reruns and resume need stable attempt numbers.
Deriving attempts from events can drift if event logging is partial or retry behavior changes.

Example:

```json
{
  "node_attempts": {
    "review": 3,
    "fix": 2
  }
}
```

### D053 - Attempt Number Base

Decision:
Attempt numbers are one-based.
The first time a node runs, its attempt is `1`.

Reason:
One-based attempt numbers are clearer in human-facing logs and reports.

### D054 - Run Summary Attempt Display

Decision:
The main run summary shows only the latest attempt for each node.
Detailed attempt history is available through the event log.

Reason:
The summary should stay compact and compatible with existing UI expectations.
The event log is the correct place for chronological attempt detail.

### D055 - Retry Node Route Continuation

Decision:
When `retry-node` is used on a node inside a route loop, the retry should continue through the route flow from the new result.

Reason:
If `review` is retried, the new review result must pass through `route_loop` again so the workflow can choose `positive`, `negative`, or `exhausted`.
Retry behavior should not bypass the controller.

### D056 - Route Loop Retry Support

Decision:
`route_loop` itself is not directly retryable.

Reason:
Retrying the controller can duplicate route side effects or increment counters without a new decision output.
Users should retry the node referenced by `route_loop.from`, such as `review` or `quality-gate`.

### D057 - Resume Route State

Decision:
Resume preserves route activation state, loop counters, and attempt counters.

Reason:
Pause is a valid runtime state, not a workflow restart.
After resume, the workflow should continue from the paused node and then proceed through the same route flow.

### D058 - Lifecycle Compatibility

Decision:
Cancel, abandon, and resume lifecycle behavior remains the same as current Archon behavior.

Reason:
`route_loop` is a routing feature, not a workflow lifecycle redesign.
Terminal and resumable states should follow existing system rules.

### D059 - No Automatic Prompt Injection

Decision:
When `route_loop` routes to `negative`, the engine does not automatically inject failure context into the target node prompt.

Reason:
Automatic prompt injection would create hidden behavior and provider-specific surprises.
Workflow authors should explicitly reference the needed review output or artifacts in the fix node prompt.

### D060 - No Iteration Context Required For Target Nodes

Decision:
Negative target nodes do not need loop iteration context by default.

Reason:
The target node's job should be driven by its own prompt and explicit references to prior outputs.
Iteration count remains available for audit and debug through route loop output and events if needed.

### D061 - Unselected Route Targets

Decision:
Unselected route targets are not marked as skipped.
They are simply not activated.

Reason:
An unselected route target did not fail its own condition.
Logging skipped events for every unselected target would make route-heavy workflows noisy.

### D062 - Not Activated Display

Decision:
Nodes that are never reached by route activation are not shown as executed nodes in the main run summary.
Graph UI may show them as `not_activated`.

Reason:
`skipped` can already mean a node-level `when` or `trigger_rule` decision.
`not_activated` better describes a branch that was never selected.

### D063 - No Default Route YAML Shape

Decision:
There is no public `routes.default` shape in the first version.

Reason:
`routes` is only config inside `route_loop`, and `route_loop` uses named outcomes.

### D064 - Route Loop Route YAML Shape

Decision:
`route_loop.routes.positive`, `route_loop.routes.negative`, and `route_loop.routes.exhausted` use short string targets.

Reason:
The outcome is already represented by the route key.
Object syntax would not add value in the first version.

Example:

```yaml
route_loop:
  routes:
    positive: next_step
    negative: fix
    exhausted: escalation
```

### D065 - Single Route Target

Decision:
Each route points to exactly one node id.

Reason:
Multi-target routes would require parallel activation, join semantics, failure propagation, and ordering rules.
If multiple actions are needed after a route, the route should target one node and the existing workflow graph can continue from there.

### D066 - No Terminal Route Sentinel

Decision:
Route targets must be real node ids.
There is no special terminal target such as `__end__` in the first version.

Reason:
Routing to a real close, summary, or escalation node makes the end path explicit and reportable.
It also avoids adding sentinel values to the workflow schema.

### D067 - Route To Previously Completed Node

Decision:
A route may target a node that has already completed.
If the target is completed, route activation creates a new attempt.
If the target is running or paused, the workflow fails fast.

Reason:
Review and fix loops require returning to nodes that have already run.
Non-terminal duplicate activation would create ambiguous output and race conditions.

### D068 - Positive Ignores Max Iterations

Decision:
If `route_loop.condition` evaluates true, route to `positive` regardless of the current negative counter.
Then reset that loop node's counter.

Reason:
`max_iterations` limits repeated failure and fix cycles.
It should not block a successful pass.

### D069 - From Node Must Not Be Optional By When

Decision:
The node referenced by `route_loop.from` must not be made optional through `when`.

Reason:
`route_loop` needs a real output from its `from` node.
If the `from` node is skipped by `when`, the controller has no valid decision source.

### D070 - From Node Trigger Rule

Decision:
Do not ban `trigger_rule` on the node referenced by `route_loop.from`.
When `route_loop` runs, the `from` node must be completed and have output.
If the `from` node is skipped or failed, `route_loop` fails fast.

Reason:
`trigger_rule` can be useful for gate aggregation nodes, such as a quality gate that runs with `all_done` and summarizes failed or skipped upstream checks.
The controller must still read a real decision output, not infer a route from a missing or failed source.

### D071 - No When On Route Loop Node

Decision:
A node with `route_loop` must not declare `when`.

Reason:
`route_loop` is the required control-flow decision point.
If the controller itself can be skipped by `when`, the workflow may lose all three route outcomes.
Conditional routing belongs in `route_loop.condition`.

### D072 - No Trigger Rule On Route Loop Node

Decision:
A node with `route_loop` must not declare `trigger_rule`.

Reason:
`route_loop` already has exactly one dependency, which must be the `from` node.
The controller should run only after that source completed with output.
Allowing `trigger_rule` would add configuration that either has no value or routes the controller into fail-fast states.

### D073 - Strict Runtime Cycle Pattern

Decision:
The first version only treats this as the clear retry-loop pattern:
`from -> route_loop -> negative target -> ...depends_on path... -> from`.
If a runtime cycle exists, it must return to the same `from` node of the same `route_loop`.

Reason:
The current use case is review and fix.
Allowing arbitrary guarded route cycles would require nested loop semantics, shared loop ownership, and complex validation rules before there is a concrete need.

### D074 - Positive And Exhausted Are Exit Paths

Decision:
Only the `negative` route may participate in the loop cycle back to `from`.
`positive` and `exhausted` must be exit paths and must not route back to `from`, the same `route_loop`, or the negative loop path.

Reason:
`positive` means successful exit and `exhausted` means fallback exit.
If either route re-enters the loop, the control-flow meaning becomes ambiguous.

### D075 - Negative Path May Exit

Decision:
The `negative` path of a `route_loop` does not have to return to that same loop's `from` node.
Do not warn when the negative path exits instead of returning to `from`.

Reason:
Some workflows may use `negative` as a fail branch that routes to manual triage, close, escalation, or another controller.
`max_iterations` only becomes meaningful when the negative path eventually returns to `from` and the same controller is reached again.
This is an intentional routing choice and should not create validator noise.

### D076 - Keep Route Loop Name

Decision:
Keep the name `route_loop` even though the negative path may exit instead of returning to `from`.

Reason:
The node still owns the loop budget and exhaustion behavior when the route flow returns to it.
The broader negative-exit behavior is intentional and does not require renaming in this design.

### D077 - Negative Target Continues Through Normal Graph Order

Decision:
`route_loop.routes.negative` activates the configured target node.
After that node completes, execution continues through the existing graph order, such as `fix -> review -> review-router`.
The engine does not implicitly jump from `fix` back to `from`.

Reason:
`fix` must be upstream of `review`, and `review-router` must be after `review`.
The router is the point that decides whether the workflow fixes again, exits positive, or exits exhausted.

Example:

```yaml
- id: fix
  command: bmad-dev-story

- id: review
  command: bmad-code-review
  depends_on: [fix]

- id: review-router
  depends_on: [review]
  route_loop:
    from: review
    condition: "$review.output.result == 'positive'"
    routes:
      positive: next_step
      negative: fix
      exhausted: escalation
```

### D078 - Route Target Can Also Be A Normal First-Pass Node

Decision:
A node targeted by `route_loop.routes.negative` is not route-only by default.
It can still run normally in the initial graph pass.
When the route loop later selects `negative`, that same node is activated again as a new attempt.

Reason:
In the BMAD flow, the dev or fix node runs once before the first review.
If review fails, `route_loop` sends execution back to that same node for another attempt.
The route config controls re-entry, not whether the node is allowed to participate in the initial path.

### D079 - Route Rerun Propagates Through Downstream Dependencies

Decision:
When `route_loop.routes.negative` activates a previously completed target node as a new attempt, the necessary downstream dependency chain should also run again.

Reason:
If `fix` reruns, then `review` and `review-router` must rerun against the new fix result.
Otherwise the loop would evaluate stale review output.

### D080 - Rerun Only The Path Back To The Router

Decision:
A negative rerun should rerun only the dependency path needed to get from the negative target back to `route_loop.from` and then the `route_loop` node.
It should not rerun every descendant of the negative target.

Reason:
A target may have sibling descendants with side effects, such as notification or reporting nodes.
Rerunning every descendant would create unintended side effects.

### D081 - Multiple Paths Back To From

Decision:
Allow multiple dependency paths from the negative target back to `route_loop.from`.
When the negative target reruns, rerun all nodes on those paths before re-evaluating the router.

Reason:
A real workflow may need fan-out and fan-in, such as `fix -> lint -> review` and `fix -> tests -> review`.
This is still a clear DAG subpath as long as the paths converge back to the `from` node.

### D082 - Rerun Path Invalidation

Decision:
When a negative route reruns a path, invalidate only the selected path back to the router for latest-output readiness.
Do not delete attempt history.

Reason:
Nodes on the rerun path need fresh latest outputs before the router evaluates again.
Previous outputs remain useful for audit and debug.

### D083 - No External Dependencies Inside Rerun Path

Decision:
The first version does not support nodes inside the rerun path depending on nodes outside that path.
If this shape is detected for a negative rerun path, execution should fail with a clear error.

Reason:
Mixing fresh rerun outputs with stale external dependency outputs creates ambiguous attempt semantics.
The first version should keep rerun paths self-contained.

### D084 - Validate Rerun Path At Loader And Runtime

Decision:
Validate rerun path self-containment in both loader and runtime.

Reason:
Loader validation catches workflow authoring errors early.
Runtime validation is still required as a safety guard for resume, retry, stale persisted state, or any graph shape that bypasses static validation.

### D085 - All Nodes On Rerun Path Run Normally

Decision:
When a negative route reruns a path back to `from`, every node on that path runs again normally.
There is no exclusion list or `rerun: false` behavior in the first version.

Reason:
The path should behave like normal workflow execution.
If an author does not want a side-effect node to rerun, that node should not be placed on the rerun path.

### D086 - Route Loop Scoped Output Alias

Decision:
Do not add a scoped `$output` alias for `route_loop.condition`.
Do not rewrite condition expressions.
Use the existing condition syntax unchanged.

Reason:
The user explicitly chose to keep the expression system unchanged.
This minimizes implementation scope and avoids changing the shared condition evaluator.

### D087 - Route Loop Can Use Structured Output

Decision:
`route_loop.condition` may read fields from the `from` node's structured output when that node declares `output_format`.
The route loop must not hard-code field names such as `result`, `gate`, or `status`.

Reason:
The previous node should own its output contract.
The YAML expression decides how that output maps to positive versus negative routing.

### D088 - Reuse Existing Condition Grammar

Decision:
`route_loop.condition` reuses the existing `when` condition grammar.
Do not add functions such as `trim()` or `lower()` in the first version.

Reason:
Keeping one expression grammar is simpler and lowers implementation risk.
Gate nodes should output canonical values, such as lowercase `positive` or `negative`, ideally enforced by `output_format`.

### D089 - Route Loop Condition References From Node Only

Decision:
Validate that `route_loop.condition` only references the node declared in `route_loop.from`.

Reason:
`from` is the decision source for the controller.
If the condition reads a different node, the route loop becomes ambiguous.
When multiple inputs are needed, a separate gate aggregation node should produce one decision output and `from` should reference that gate node.

### D090 - Compound Condition References

Decision:
Compound `route_loop.condition` expressions are allowed.
Every node reference inside the expression must still reference the node declared in `route_loop.from`.

Reason:
This preserves the existing condition grammar while keeping the route loop decision source unambiguous.

### D091 - Route Loop Condition Parse Errors Fail

Decision:
If `route_loop.condition` cannot be parsed, the route loop fails.
It must not skip like a regular `when` condition.

Reason:
`route_loop` is a required control-flow decision point.
Skipping it would leave the workflow without a selected route.

### D092 - Route Loop Output Reference Errors Fail

Decision:
If `route_loop.condition` references a missing or unresolvable output field, the route loop fails.
It must not treat that condition as negative.

Reason:
Missing fields indicate a broken gate output contract.
Treating them as negative would waste loop iterations and hide the real error.

### D093 - Field References Require Output Format

Decision:
If `route_loop.condition` reads a field from the `from` node output, that field must be declared in the `from` node's `output_format.properties`.

Reason:
Route loop conditions are control-flow contracts.
Requiring `output_format` for field references catches gate schema mistakes early and avoids routing on best-effort JSON.

### D094 - Whole Output References Do Not Require Output Format

Decision:
If `route_loop.condition` only reads the whole output string of the `from` node, `output_format` is not required.

Reason:
Some gate nodes can intentionally output a simple canonical string such as `positive`.
Requiring structured output for that case would add unnecessary weight.

### D095 - Preserve Existing Condition Comparison Behavior

Decision:
`route_loop.condition` keeps the existing condition evaluator behavior for comparisons.
Do not add route-loop-specific trimming, lowercasing, or normalization.

Reason:
The user chose to keep the expression system unchanged.
Gate nodes should emit canonical values that match the expression exactly.

### D096 - Negative Retry Target Must Be Upstream Of The Router Path

Decision:
When `route_loop.routes.negative` is intended to retry, the negative target must be on an upstream dependency path that can reach `route_loop.from` and then the `route_loop` node.
Do not support a retry target that sits after the `route_loop` node in the DAG.

Reason:
The chosen model is `fix -> review -> review-router`.
The negative route sends execution back to `fix`, and normal dependency order carries it forward to `review` and the router.
A target after the router cannot express that retry path clearly in the first version.

### D097 - Nested Route Loops Are Independent Nodes

Decision:
A `route_loop` may appear inside another route loop's rerun path.
It is treated as an independent node with its own routes and counters.

Reason:
`route_loop` is a node type.
Nested ownership does not require special semantics as long as each route loop manages its own state and the rerun path validation still passes.

## Grill-Me Gotchas

### G001 - Only Ask Decisions That Can Change The Design

When grilling this design, ask only questions whose answer can materially change schema, runtime behavior, validation, UI, migration, compatibility, or user workflow.
Do not ask follow-up questions that are already implied by a confirmed higher-level decision.

Bad question pattern:

- Asking about individual forbidden fields after the user already confirmed `route_loop` is a pure controller.
- Asking about reset behavior that is already implied by the counter lifecycle decision.
- Asking about route consequences that are mechanical outcomes of a prior route model decision.
- Asking about implementation trivia before the product-level or contract-level decision needs it.

Good question pattern:

- Ask when two valid designs would produce different public YAML.
- Ask when runtime behavior would change failure, retry, resume, or loop safety semantics.
- Ask when validation strictness could block real workflows or allow dangerous ambiguity.
- Ask when UI representation would change how users author or debug the workflow.
- Ask when backward compatibility or migration risk is affected.

Rule:
Before asking, identify the decision lever.
If the answer cannot change a meaningful lever, do not ask.

### D098 - Web Builder Route Loop Ports

Decision:
The web builder should render `route_loop` with three output ports: `positive`, `negative`, and `exhausted`.

Reason:
The feature is branch routing.
Visible ports make the route targets obvious on the graph and match the user's mental model.

### D099 - UI Route Serialization

Decision:
Edges from `route_loop` output ports serialize directly into `route_loop.routes` string targets.

Reason:
The YAML contract already stores route targets by outcome.
No separate edge metadata is needed in the first version.

Example:

```yaml
route_loop:
  routes:
    positive: next_step
    negative: fix
    exhausted: escalation
```

### D100 - UI Route Loop Input Edge

Decision:
The web builder should enforce exactly one input edge for `route_loop`.
That input edge must match the single node id in `depends_on` and `route_loop.from`.
If the user changes the input edge, the builder should update `from` and `depends_on` together.

Reason:
The schema requires `route_loop` to have one decision source.
Keeping the UI edge and YAML fields synchronized prevents hidden mismatch.

### D101 - UI Blocks Multiple Route Loop Inputs

Decision:
The web builder should prevent connecting a second input edge to a `route_loop` node.

Reason:
`route_loop` has exactly one decision source.
Blocking invalid graph shapes in the UI is better than allowing invalid YAML to be produced.

### D102 - UI Requires All Route Loop Outputs

Decision:
The web builder should mark a `route_loop` node invalid if any required output route is missing.
It should not allow saving or running a workflow with a `route_loop` missing `positive`, `negative`, or `exhausted`.

Reason:
All three route outcomes are required by the schema.
UI validation should catch the error before loader or runtime validation.

### D103 - Multiple Outcomes May Share A Target

Decision:
Different `route_loop` outcomes may target the same node.

Reason:
Some workflows may intentionally route multiple outcomes through a shared reporting, cleanup, or aggregation node.
This does not create an inherent safety issue.

### D104 - No Special Ban For Negative And Exhausted Sharing Target

Decision:
Do not add a special validation ban for `negative` and `exhausted` pointing to the same target node.

Reason:
Shared targets are allowed generally.
Safety should be handled by route-cycle and rerun-path validation, not by special-casing one pair of outcomes.

### D105 - Route Event Outcome Names

Decision:
`node_routed` events use the same outcome names as YAML: `positive`, `negative`, and `exhausted`.

Reason:
Using the same terms avoids an extra mapping layer between config, runtime events, and UI.

### D106 - Route Event Includes Condition

Decision:
`node_routed` events should include the condition expression and boolean condition result.

Reason:
Debugging routing requires seeing both the selected outcome and why that outcome was selected.

Example:

```json
{
  "outcome": "negative",
  "condition": "$review-gate.output.result == 'positive'",
  "condition_result": false,
  "to": "fix"
}
```

### D107 - Route Event Includes Counter State

Decision:
`node_routed` events should include `negative_count` and `max_iterations` for every outcome.
For `positive`, record the count before resetting the loop counter.

Reason:
When a loop eventually passes, the event should still show how many negative iterations happened before success.

### D108 - Exhausted Keeps Condition Result False

Decision:
When `route_loop.condition` evaluates false and the negative count exceeds `max_iterations`, the selected outcome is `exhausted` and `condition_result` remains false.

Reason:
`exhausted` is not a separate condition result.
It is the false condition path after the loop budget has been exceeded.

### D109 - Route Loop Output Mirrors Core Route Metadata

Decision:
`route_loop.output` should mirror the core metadata from the `node_routed` event.

Reason:
Downstream nodes may need to read the route outcome or counter state without querying the event log.

Example:

```json
{
  "outcome": "exhausted",
  "to": "escalation",
  "condition": "$review-gate.output.result == 'positive'",
  "condition_result": false,
  "negative_count": 11,
  "max_iterations": 10
}
```

### O005 - Existing Workflow Migration

No migration decision is needed for current workflows because this is additive.
Existing `loop`, `depends_on`, `when`, and `trigger_rule` behavior should remain backward compatible.
