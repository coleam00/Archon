# Decision Catalog

Every Grill Me decision below is normative for this spec.
The kernel summarizes the capability surface, but this catalog preserves the full decision set that downstream implementers must honor.

## Feature Shape And Public Surface

- **D001 - Feature Shape:** Build a controlled route loop, not arbitrary cyclic graph execution.
- **D002 - Route Loop Node Name:** Use `route_loop` as the new node mode field.
- **D003 - Route Loop Is A Node:** `route_loop` is a standalone node with its own `id`.
- **D004 - Route Outcomes:** `route_loop` has exactly three required outcomes, `positive`, `negative`, and `exhausted`.
- **D005 - Exhausted Name:** Use `exhausted` instead of `close` for the third outcome.
- **D006 - Required Routes:** `route_loop.routes.positive`, `route_loop.routes.negative`, and `route_loop.routes.exhausted` are all required.
- **D007 - Max Iterations Location:** `max_iterations` belongs to the `route_loop` node.
- **D008 - Max Iterations Default And Bounds:** `route_loop.max_iterations` defaults to `10`, and provided values must be integers from `1` to `100`.
- **D009 - Meaning Of Max Iterations:** `max_iterations` counts allowed `negative` routes.
- **D010 - Exhaustion Threshold:** When the condition is false, increment the negative counter first; if the new count is greater than `max_iterations`, route to `exhausted`; otherwise route to `negative`.
- **D011 - Max Iterations One:** `max_iterations: 1` allows one negative route, and the second false result routes to `exhausted`.
- **D012 - Counter Storage:** Store loop counters in `workflow_run.metadata.loopCounters`.
- **D013 - Counter Reset On Positive:** When `route_loop` routes to `positive`, reset only the counter for that specific loop node.
- **D014 - Counter Is Not Reset On Negative:** When `route_loop` routes to `negative`, increment the counter and keep it.
- **D015 - Counter Is Not Reset On Resume:** Normal resume and retry do not reset the loop counter.
- **D016 - Counter Reset Scope:** The counter resets when the workflow starts over as a new workflow run.
- **D017 - Route Loop Is A Controller:** `route_loop` only controls routing and does not own a nested body or subgraph.
- **D018 - Negative Flow Ownership:** When `route_loop` routes to `negative`, it only activates the configured negative target, then normal `depends_on` graph behavior continues and can reach `from` and the router again.
- **D019 - No Node-Level Routes:** Do not add node-level `routes` in the first version, and keep `routes` config only inside `route_loop`.
- **D020 - Route Support Scope:** Only `route_loop` has `routes`, and the first version does not add `routes.default` to regular nodes.
- **D021 - Dependency Graph Remains Acyclic:** `depends_on` remains acyclic, while runtime cycles are formed by a `route_loop` route edge plus the normal `depends_on` path that may lead back to `from`.
- **D022 - Runtime Cycles Need A Route Loop Guard:** A runtime cycle is valid only when formed by a `route_loop` route edge and a normal dependency path protected by that `route_loop.max_iterations`.
- **D023 - No Global Emergency Cap:** Do not add a global node execution cap in the first version.
- **D024 - Route Loop From Field:** `route_loop.from` is required.
- **D025 - From Must Be Direct Dependency:** `route_loop.from` must be the only direct dependency of the `route_loop` node.
- **D026 - Route Loop Has One Dependency:** `route_loop` must have exactly one `depends_on` entry, and that entry must equal `route_loop.from`.
- **D027 - Route Loop Is Execution-Mode Exclusive:** `route_loop` cannot be combined with `prompt`, `command`, `bash`, `script`, `approval`, `cancel`, or existing `loop`.

## Conditions And Outputs

- **D028 - Condition Shape:** Use a YAML expression in `route_loop.condition`, and do not hard-code the comparison value or field name.
- **D029 - Condition Scope:** `route_loop.condition` uses the existing condition reference syntax.
- **D030 - Condition Evaluation Failure:** If the condition cannot be evaluated, fail fast.
- **D031 - Route Loop Output:** `route_loop.output` is routing metadata and does not copy the `from` node output.
- **D032 - Latest Output Semantics:** `$node.output` always points to the latest completed attempt output for that node, while attempt history is kept separately for debug and audit.
- **D033 - Attempts Are Not Deleted On Positive:** When a loop reaches `positive`, do not delete attempts or history, and only reset the active counter for that loop.
- **D034 - Attempts Are Not Deleted On Exhausted:** When a loop reaches `exhausted`, do not reset the counter or delete attempts.
- **D035 - Exhausted Is Completed Control Flow:** `exhausted` is a completed control-flow outcome, not a node failure.
- **D036 - Route Events:** Emit a `node_routed` event for every route outcome.
- **D037 - Route Target Validation:** The loader validates that all route target ids exist.
- **D038 - Route Loop Self Target:** A route target cannot point to the same `route_loop` node.
- **D039 - Negative Can Target From:** `routes.negative` may target the `from` node directly, and the validator should warn because this often means review is rerun without fix work.
- **D040 - Route-Triggered Rerun:** When a route activates a node that has already completed, the node gets a new attempt and runs again.
- **D041 - Route To Non-Terminal Node:** If a route tries to activate a node that is already running or paused, fail fast.
- **D042 - Provider Session Behavior:** Route-triggered reruns use the existing node session behavior and only use fresh context when the node config requests it.
- **D043 - Route Loop Owns Its Route Outcomes:** `route_loop` owns its route outcomes through `route_loop.routes`, and regular nodes do not gain route outcomes in the first version.
- **D044 - Route Activation Mode:** In workflows that use routes, nodes must be activated before dependency readiness can cause execution.
- **D045 - Workflow Start In Route Mode:** If a workflow uses `route_loop`, root nodes with no dependencies are activated at startup, and workflows without `route_loop` keep existing DAG behavior.
- **D046 - Route Target Dependency Semantics:** Do not introduce a new special dependency rule for route targets in this design pass, and keep route target dependency behavior aligned with existing workflow semantics as much as possible.
- **D047 - Current BMAD Modeling Pattern:** For BMAD review and fix, model the quality decision through a single decision output, and use a gate aggregation node before `route_loop` when multiple gates are involved.
- **D048 - Metadata Naming:** Use snake_case for route loop output and event metadata.
- **D049 - Attempt History Visibility:** Attempt history is for audit and debug only in the first version, and workflow expressions use `$node.output` without exposing `$node.attempts`.
- **D050 - Attempt Identity In Events:** Events should record both a per-node `attempt` and a global `execution_seq`.
- **D051 - Execution Sequence Storage:** Store the global execution sequence counter in workflow run metadata.
- **D052 - Node Attempt Counter Storage:** Store per-node attempt counters in workflow run metadata.
- **D053 - Attempt Number Base:** Attempt numbers are one-based, so the first time a node runs its attempt is `1`.
- **D054 - Run Summary Attempt Display:** The main run summary shows only the latest attempt for each node, and detailed attempt history is available through the event log.

## Retry, Resume, Lifecycle, And Branch Reachability

- **D055 - Retry Node Route Continuation:** When `retry-node` is used on a node inside a route loop, the retry should continue through the route flow from the new result.
- **D056 - Route Loop Retry Support:** `route_loop` itself is not directly retryable.
- **D057 - Resume Route State:** Resume preserves route activation state, loop counters, and attempt counters.
- **D058 - Lifecycle Compatibility:** Cancel, abandon, and resume lifecycle behavior remains the same as current Archon behavior.
- **D059 - No Automatic Prompt Injection:** When `route_loop` routes to `negative`, the engine does not automatically inject failure context into the target node prompt.
- **D060 - No Iteration Context Required For Target Nodes:** Negative target nodes do not need loop iteration context by default.
- **D061 - Unselected Route Targets:** Unselected route targets are not marked as skipped and are simply not activated.
- **D062 - Not Activated Display:** Nodes never reached by route activation are not shown as executed nodes in the main run summary, while graph UI may show them as `not_activated`.
- **D063 - No Default Route YAML Shape:** There is no public `routes.default` shape in the first version.
- **D064 - Route Loop Route YAML Shape:** `route_loop.routes.positive`, `route_loop.routes.negative`, and `route_loop.routes.exhausted` use short string targets.
- **D065 - Single Route Target:** Each route points to exactly one node id.
- **D066 - No Terminal Route Sentinel:** Route targets must be real node ids, with no special terminal target such as `__end__` in the first version.
- **D067 - Route To Previously Completed Node:** A route may target a completed node and create a new attempt; if the target is running or paused, the workflow fails fast.
- **D068 - Positive Ignores Max Iterations:** If `route_loop.condition` evaluates true, route to `positive` regardless of the current negative counter, then reset that loop node's counter.
- **D069 - From Node Must Not Be Optional By When:** The node referenced by `route_loop.from` must not be made optional through `when`.
- **D070 - From Node Trigger Rule:** Do not ban `trigger_rule` on the `from` node, but when `route_loop` runs the `from` node must be completed with output and skipped or failed source states make `route_loop` fail fast.
- **D071 - No When On Route Loop Node:** A node with `route_loop` must not declare `when`.
- **D072 - No Trigger Rule On Route Loop Node:** A node with `route_loop` must not declare `trigger_rule`.
- **D073 - Strict Runtime Cycle Pattern:** The first version only treats `from -> route_loop -> negative target -> ...depends_on path... -> from` as the clear retry-loop pattern, and any runtime cycle must return to the same `from` node of the same `route_loop`.
- **D074 - Positive And Exhausted Are Exit Paths:** Only the `negative` route may participate in the loop cycle back to `from`, while `positive` and `exhausted` must be exit paths and must not route back to `from`, the same `route_loop`, or the negative loop path.
- **D075 - Negative Path May Exit:** The `negative` path of a `route_loop` does not have to return to that same loop's `from` node, and this shape should not warn.
- **D076 - Keep Route Loop Name:** Keep the name `route_loop` even though the negative path may exit instead of returning to `from`.
- **D077 - Negative Target Continues Through Normal Graph Order:** `route_loop.routes.negative` activates the configured target node, then execution continues through existing graph order, and the engine does not implicitly jump from `fix` back to `from`.
- **D078 - Route Target Can Also Be A Normal First-Pass Node:** A node targeted by `route_loop.routes.negative` is not route-only by default, can run normally in the initial graph pass, and is activated again as a new attempt when selected later.
- **D079 - Route Rerun Propagates Through Downstream Dependencies:** When `route_loop.routes.negative` activates a completed target as a new attempt, the necessary downstream dependency chain should also run again.
- **D080 - Rerun Only The Path Back To The Router:** A negative rerun should rerun only the dependency path needed to get from the negative target back to `route_loop.from` and then `route_loop`, and should not rerun every descendant of the negative target.
- **D081 - Multiple Paths Back To From:** Allow multiple dependency paths from the negative target back to `route_loop.from`, and rerun all nodes on those paths before re-evaluating the router.
- **D082 - Rerun Path Invalidation:** When a negative route reruns a path, invalidate only the selected path back to the router for latest-output readiness, and do not delete attempt history.
- **D083 - No External Dependencies Inside Rerun Path:** The first version does not support nodes inside the rerun path depending on nodes outside that path, and detected shapes should fail with a clear error.
- **D084 - Validate Rerun Path At Loader And Runtime:** Validate rerun path self-containment in both loader and runtime.
- **D085 - All Nodes On Rerun Path Run Normally:** Every node on a negative rerun path back to `from` runs again normally, with no exclusion list or `rerun: false` behavior in the first version.

## Condition Grammar Details

- **D086 - Route Loop Scoped Output Alias:** Do not add a scoped `$output` alias for `route_loop.condition`, do not rewrite condition expressions, and use existing condition syntax unchanged.
- **D087 - Route Loop Can Use Structured Output:** `route_loop.condition` may read fields from the `from` node's structured output when that node declares `output_format`, and must not hard-code field names such as `result`, `gate`, or `status`.
- **D088 - Reuse Existing Condition Grammar:** `route_loop.condition` reuses the existing `when` condition grammar, and the first version does not add functions such as `trim()` or `lower()`.
- **D089 - Route Loop Condition References From Node Only:** Validate that `route_loop.condition` only references the node declared in `route_loop.from`.
- **D090 - Compound Condition References:** Compound `route_loop.condition` expressions are allowed, and every node reference inside the expression must still reference the node declared in `route_loop.from`.
- **D091 - Route Loop Condition Parse Errors Fail:** If `route_loop.condition` cannot be parsed, the route loop fails and must not skip like a regular `when` condition.
- **D092 - Route Loop Output Reference Errors Fail:** If `route_loop.condition` references a missing or unresolvable output field, the route loop fails and must not treat the condition as negative.
- **D093 - Field References Require Output Format:** If `route_loop.condition` reads a field from the `from` node output, that field must be declared in the `from` node's `output_format.properties`.
- **D094 - Whole Output References Do Not Require Output Format:** If `route_loop.condition` only reads the whole output string of the `from` node, `output_format` is not required.
- **D095 - Preserve Existing Condition Comparison Behavior:** `route_loop.condition` keeps existing condition evaluator comparison behavior, and does not add route-loop-specific trimming, lowercasing, or normalization.
- **D096 - Negative Retry Target Must Be Upstream Of The Router Path:** When `route_loop.routes.negative` is intended to retry, the negative target must be on an upstream dependency path that can reach `route_loop.from` and then `route_loop`, and a retry target after the router is unsupported in the first version.
- **D097 - Nested Route Loops Are Independent Nodes:** A `route_loop` may appear inside another route loop's rerun path, and it is treated as an independent node with its own routes and counters.

## Grill Me Process Guardrail

- **G001 - Only Ask Decisions That Can Change The Design:** Ask only questions whose answers can materially change schema, runtime behavior, validation, UI, migration, compatibility, or user workflow, and do not ask follow-up questions that cannot change a meaningful lever.

## Web Builder And Event Metadata

- **D098 - Web Builder Route Loop Ports:** The web builder should render `route_loop` with three output ports, `positive`, `negative`, and `exhausted`.
- **D099 - UI Route Serialization:** Edges from `route_loop` output ports serialize directly into `route_loop.routes` string targets.
- **D100 - UI Route Loop Input Edge:** The web builder should enforce exactly one input edge for `route_loop`, keep it aligned with `depends_on` and `route_loop.from`, and update both fields together when the input edge changes.
- **D101 - UI Blocks Multiple Route Loop Inputs:** The web builder should prevent connecting a second input edge to a `route_loop` node.
- **D102 - UI Requires All Route Loop Outputs:** The web builder should mark a `route_loop` node invalid if any required output route is missing, and should not allow saving or running a workflow missing `positive`, `negative`, or `exhausted`.
- **D103 - Multiple Outcomes May Share A Target:** Different `route_loop` outcomes may target the same node.
- **D104 - No Special Ban For Negative And Exhausted Sharing Target:** Do not add a special validation ban for `negative` and `exhausted` pointing to the same target node.
- **D105 - Route Event Outcome Names:** `node_routed` events use the same outcome names as YAML, `positive`, `negative`, and `exhausted`.
- **D106 - Route Event Includes Condition:** `node_routed` events should include the condition expression and boolean condition result.
- **D107 - Route Event Includes Counter State:** `node_routed` events should include `negative_count` and `max_iterations` for every outcome, and `positive` records the count before resetting the loop counter.
- **D108 - Exhausted Keeps Condition Result False:** When `route_loop.condition` evaluates false and the negative count exceeds `max_iterations`, selected outcome is `exhausted` and `condition_result` remains false.
- **D109 - Route Loop Output Mirrors Core Route Metadata:** `route_loop.output` should mirror the core metadata from the `node_routed` event.

## Migration

- **O005 - Existing Workflow Migration:** No migration decision is needed for current workflows because this is additive, and existing `loop`, `depends_on`, `when`, and `trigger_rule` behavior should remain backward compatible.
