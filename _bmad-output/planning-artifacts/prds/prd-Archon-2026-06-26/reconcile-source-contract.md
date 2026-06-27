# Source Contract Reconciliation: Route Loop Routing

## Input

- Draft PRD: `prd.md`
- Draft addendum: `addendum.md`
- Canonical contract: `_bmad-output/specs/spec-route-loop-routing/SPEC.md` plus all companion files in that directory
- Traceability-only sources: `plans/grill-me/260625-2337-route-loop-decisions.md` and `../bmad-target-follow.md`

## Verdict

PARTIAL.

The draft substantially preserves the route-loop contract, especially the standalone `route_loop` node shape, three required outcomes, `max_iterations` semantics, condition grammar reuse, event metadata, resume and retry behavior, and web builder ports.
It is not yet fully reconciled because it omits several normative decision-catalog rules and turns a few source uncertainties into PRD recommendations or MVP scope.

## Contract Authority Check

The draft correctly states that `SPEC.md` plus declared companions are canonical and that the source documents listed in the SPEC are traceability inputs.
Evidence: `prd.md:14-16` and `addendum.md:5-18`.

This matches `SPEC.md`, which states that the SPEC and every companion file are the complete preservation-validated contract, while source documents are for traceability only.

## Confirmations

### C1: Route loop public shape is preserved

The draft correctly requires a standalone `route_loop` node with its own `id`, `depends_on`, `from`, `condition`, optional `max_iterations`, and required `routes`.
Evidence: `prd.md:100-141`.

This matches `route-loop-contract.md:5-23` and `decision-catalog.md:D001-D027`.

### C2: Three route outcomes and route target rules are preserved

The draft correctly requires `positive`, `negative`, and `exhausted`, rejects missing route targets, requires real node IDs, rejects self-targeting, rejects terminal sentinels, and allows multiple outcomes to share a target when safety validation passes.
Evidence: `prd.md:129-141` and `prd.md:451-458`.

This matches `route-loop-contract.md:32-39` and `ui-builder-contract.md:23-27`.

### C3: `max_iterations` semantics are correct

The draft correctly says `max_iterations` defaults to `10`, accepts integers from `1` through `100`, counts allowed negative routes rather than total route decisions, increments the negative counter before comparing to the budget, and routes false result 11 to `exhausted` when `max_iterations` is `10`.
Evidence: `prd.md:143-152` and `prd.md:240-250`.

This matches `route-loop-contract.md:41-51` and `decision-catalog.md:D008-D011`.

### C4: Condition grammar source conflict is handled correctly

The draft rejects the older `$output` example and keeps the existing `when` grammar, without route-loop-specific aliases, functions, rewriting, or string normalization.
Evidence: `prd.md:162-172`, `prd.md:521-524`, and `addendum.md:21-31`.

This matches `route-loop-contract.md:53-68` and `decision-catalog.md:D086-D095`.

### C5: UI builder contract is mostly preserved

The draft includes one input edge, three output ports, direct serialization into `route_loop.routes`, input-edge synchronization with `depends_on` and `route_loop.from`, missing-route save/run blocking, shared-target allowance, and no special ban on `negative` plus `exhausted` sharing a target.
Evidence: `prd.md:415-458`.

This matches `ui-builder-contract.md:3-27` and `decision-catalog.md:D098-D104`.

### C6: Lifecycle and attempt semantics are mostly preserved

The draft preserves latest-attempt `$node.output`, audit history, direct retry block for `route_loop`, retry continuation through route flow, resume preserving counters and activation state, and unchanged cancel, abandon, and resume lifecycle semantics.
Evidence: `prd.md:252-262`, `prd.md:318-346`, and `prd.md:393-411`.

This matches `runtime-contract.md:45-62` and `runtime-contract.md:89-99`.

## Gaps And Corrections

### G1: Missing hard ban on `when` and `trigger_rule` on `route_loop`

Severity: High.

The canonical decision catalog says a node with `route_loop` must not declare `when` and must not declare `trigger_rule`.
Evidence: `decision-catalog.md:D071-D072`.

The draft only bans mixing `route_loop` with executable node modes such as `prompt`, `command`, `bash`, `script`, `approval`, `cancel`, and existing `loop`.
Evidence: `prd.md:110-117`.

This is an omitted normative requirement.
It matters because a skipped or trigger-rule-gated route controller can lose all three route outcomes or create ambiguous route state.

Required correction:
Add a validation requirement that `route_loop` nodes cannot declare `when` or `trigger_rule`.
Place it near FR-2 or add a separate validation FR.

### G2: From-node optionality and source-state rules are under-specified

Severity: High.

The canonical decision catalog says the node referenced by `route_loop.from` must not be made optional through `when`.
It also says `trigger_rule` is not banned on the `from` node, but when `route_loop` runs the `from` node must be completed with output, and skipped or failed source states make the route loop fail fast.
Evidence: `decision-catalog.md:D069-D070`.

The draft mentions skipped or failed From Node state only as a broad safety concern.
Evidence: `prd.md:471-472`.

That is not enough for downstream implementation because the validator and runtime need explicit requirements for `from` node eligibility.

Required correction:
Add a requirement that `route_loop.from` cannot be optional through `when`.
Add a runtime requirement that a route loop fails fast when its From Node is skipped, failed, missing output, or otherwise not a completed output source.
Add a note that `trigger_rule` is allowed on the From Node only if the From Node still produces completed output by the time the route loop evaluates.

### G3: Negative rerun path wording is too absolute and misses the after-router prohibition

Severity: Medium-high.

The canonical runtime contract says the negative path does not have to return to the same loop's `from` node and no warning is required when it exits.
It says that when a negative route reruns a path, only the dependency path back to `route_loop.from` and the route loop node reruns.
Evidence: `runtime-contract.md:72-87`.

The canonical decision catalog also says that when `routes.negative` is intended to retry, the negative target must be on an upstream dependency path that can reach `route_loop.from` and then `route_loop`, and retry targets after the router are unsupported in v1.
Evidence: `decision-catalog.md:D096`.

The draft says "On Negative Outcome, the runtime reruns only the dependency path needed to get from the Negative Route Target back to the From Node and then the Route Loop."
Evidence: `prd.md:273-283`.

That wording makes every Negative Outcome sound like a rerun.
The same PRD later says a negative path may exit, but the FR should be precise because this is a core route condition.
Evidence: `prd.md:295`.

Required correction:
Change FR-16 to say "When a Negative Outcome is intended to retry and the negative target reaches `route_loop.from`, rerun only the selected dependency path back to the From Node and then the Route Loop."
Add the v1 prohibition that a retry target after the route loop node in the DAG is unsupported.

### G4: The draft omits that a negative route target can also run during the normal first pass

Severity: Medium.

The canonical decision catalog says a node targeted by `route_loop.routes.negative` is not route-only by default, can run normally in the initial graph pass, and is activated again as a new attempt when selected later.
Evidence: `decision-catalog.md:D078`.

The draft covers route-triggered new attempts for already completed nodes.
Evidence: `prd.md:252-262`.

It does not explicitly say a negative route target may also be a normal first-pass node.
That omission can cause an implementation or UI to incorrectly model negative targets as branch-only nodes.

Required correction:
Add a consequence under FR-12, FR-14, or FR-16 that route targets are not route-only by default and may run through normal graph order before being selected by a later route.

### G5: Condition reference to non-From nodes should be described as invalid, not just fail-fast

Severity: Medium.

The canonical route-loop contract says every node reference in a compound condition must reference `route_loop.from`, and if the condition references a different node, the workflow is invalid.
Evidence: `route-loop-contract.md:62-68`.

The draft says a condition referencing another node "fails validation or fails before unsafe runtime behavior."
Evidence: `prd.md:174-181`.

Runtime protection is still useful for stale state, but the primary contract is loader invalidation.

Required correction:
State that references to any node other than `route_loop.from` make the workflow invalid.
Keep runtime fail-fast as a secondary protection for stale persisted state or graph shapes that bypass static validation.

### G6: TEA is treated as a target lifecycle term even though the canonical spec does not define TEA semantics

Severity: Medium.

The canonical lifecycle companion says the target flow is a story lifecycle with quality gates and that the source mentions TEA but does not define it.
It explicitly says the spec does not define TEA semantics.
Evidence: `bmad-lifecycle.md:1-21`.

The draft says the first real target is the "BMAD and TEA story lifecycle."
Evidence: `prd.md:27`.

The draft later says redefining BMAD or TEA lifecycle semantics is out of scope.
Evidence: `prd.md:540`.

The later non-goal is correct, but the earlier phrasing risks implying that TEA is a defined lifecycle in the route-loop contract.

Required correction:
Change the target wording to "BMAD story lifecycle with test-architecture gate steps from the traceability source" or similar.
Keep TEA references only as traceability labels unless a separate TEA contract is added.

### G7: `route_loop.output` ID fields are an unresolved source ambiguity, not a settled requirement

Severity: Medium.

The canonical runtime contract says `route_loop.output` mirrors core route metadata from `node_routed`, does not copy the From Node output, and gives an example with `outcome`, `to`, `condition`, `condition_result`, `negative_count`, and `max_iterations`.
Evidence: `runtime-contract.md:100-121`.

The event metadata list includes route loop node ID and source node ID.
Evidence: `runtime-contract.md:102-106`.

The draft says the output should also include `route_loop_node_id` and `from_node_id`.
Evidence: `prd.md:382-390` and `prd.md:521-525`.

The draft also lists this as an open question.
Evidence: `prd.md:617`.

This is good source-conflict handling in the addendum, but the PRD currently recommends the answer before the open question is resolved.

Required correction:
Either make `route_loop_node_id` and `from_node_id` required after an explicit decision, or keep them only in Open Questions and remove the "should include" recommendation from normative requirements.

### G8: `node_routed` persistence and SSE propagation go beyond the canonical wording

Severity: Low-medium.

The canonical contract requires every route decision to emit `node_routed`, route output to mirror metadata, event history to carry attempt detail, and run/debug surfaces to expose enough route metadata.
Evidence: `SPEC.md:CAP-6` and `runtime-contract.md:100-128`.

The draft scopes `node_routed` event persistence and SSE propagation into MVP.
Evidence: `prd.md:403-411` and `prd.md:553`.

This is likely justified by the brownfield Web adapter and live run surfaces, but it is not directly named in the canonical route-loop contract.

Required correction:
Mark SSE propagation as an implementation-surface requirement derived from Archon Web UI needs, not as a canonical source-contract requirement.
Keep persisted route evidence as required because resume, retry projection, and debug history depend on it.

## No Findings

No wrong `max_iterations` semantics found.
The draft correctly counts allowed Negative Outcomes, not total decisions.

No wrong outcome naming found.
The draft consistently uses `positive`, `negative`, and `exhausted`.

No UI builder route-port miss found.
The draft covers the required one input edge and three output ports.

No lifecycle redesign found.
The draft preserves cancel, abandon, resume, retry-node, provider-session, and non-route workflow compatibility at a high level.

## Recommended Patch Targets

1. Add explicit validation requirements for `route_loop.when` and `route_loop.trigger_rule` bans near FR-2.
2. Add explicit From Node eligibility requirements near FR-3 or FR-10.
3. Refine FR-16 so negative rerun behavior is conditional on a retry path and add the after-router retry-target prohibition.
4. Add the normal-first-pass behavior for negative route targets near FR-12 or FR-14.
5. Reword TEA references so TEA remains traceability context rather than a route-loop-defined lifecycle.
6. Move `route_loop_node_id` and `from_node_id` output fields out of normative requirements unless the open question is resolved.
7. Label SSE propagation as an Archon implementation requirement rather than a direct canonical contract item.

## Reconciliation Summary

The PRD is strong enough to proceed to update, but it should not be treated as fully source-clean until the high and medium gaps above are corrected.
The most important fixes are the missing `when` and `trigger_rule` bans, the From Node eligibility rules, and the negative rerun path precision.
