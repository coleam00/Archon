# PRD Quality Review - Route Loop Routing

## Overall verdict

Revise before green-lighting implementation.
The PRD is substantially stronger than a typical draft for a brownfield developer-product feature: the thesis is clear, the FRs are concrete, the non-goals are honest, and the addendum gives architecture useful repo-specific handoff context.
The main blockers are not conceptual weakness, but unresolved MVP decisions that are still embedded in required surfaces, especially route evidence durability, required `route_loop.output` fields, and which Web builder must ship.

## Decision-readiness - adequate

The PRD states its core product bet clearly: Route Loop is a controlled routing primitive for BMAD and TEA quality gates, not a general cyclic graph engine.
That decision is repeated in the Vision, Non-Users, Non-Goals, MVP Scope, and Counter-Metrics, so a decision-maker can see what is being chosen and what is being deliberately excluded.
The most important brownfield trade-off is also surfaced: route workflows need a route-aware runtime path while non-route workflows keep current topological DAG behavior.

Decision-readiness drops from strong to adequate because several open questions are not peripheral.
They define required MVP behavior for durable route evidence, route output fields, and the Web builder surface.
Those questions are listed in §11, but the MVP Scope and FRs already assume some answers, which creates conflict for architecture and story slicing.

### Findings

- **high** MVP scope depends on unresolved control-flow durability (§4.5, §8.1, §10, §11) - FR-26 says route decisions must be durable enough for resume, retry projection, SSE, dashboard state, and debugging, and MVP Scope includes `node_routed` event persistence and SSE propagation.
  Open Question 3 still asks whether `node_routed` persistence should be upgraded from best-effort observable event to required control-flow evidence.
  Addendum §3.5 also says existing event insertion is best-effort and architecture should decide whether route decisions need stronger guarantees.
  _Fix:_ Decide this before architecture starts, or split the requirement into two explicit parts: workflow-run metadata is required control state, while `node_routed` is required durable audit evidence with defined failure behavior.
- **high** Required Web builder surface is not decided (§4.6, §8.1, §11; addendum §3.7) - FR-27 through FR-30 and MVP Scope require Web builder rendering, validation, and round-trip behavior.
  Open Question 2 still asks whether the mandatory MVP surface is the production builder, experimental console builder, or both.
  Addendum §3.7 says production surfaces support only a subset of engine node kinds and the experimental console builder has fuller variant infrastructure.
  _Fix:_ Name the MVP authoring surface explicitly and classify the other as out of scope, follow-up, or compatibility-only.
- **medium** Route output field set is still partly undecided inside an FR (§4.5, §6.3, §11; addendum §2.3) - FR-24 says output includes six fields and "should also include" `route_loop_node_id` and `from_node_id`.
  Open Question 1 then asks whether those fields are required or event-only.
  This is an interface contract, so "should" leaves generated types, downstream node expressions, tests, and docs ambiguous.
  _Fix:_ Make the field list mandatory or explicitly event-only before story creation.

## Substance over theater - strong

The document earns its detail.
The named UJs are few, role-specific, and each drives concrete FRs: Kevin drives rerun and exhausted behavior, Mira drives attempt history and route events, and Ana drives builder ports and validation.
The PRD avoids novelty theater by comparing to existing workflow systems only in the addendum, where the lessons are applied directly to route explicitness, bounded loops, retry separation, and audit history.

The NFRs are mostly product-specific rather than boilerplate.
Backward compatibility, fail-fast condition behavior, route evidence, generated API type integrity, and bounded negative routes all connect directly to the feature shape.
The one weaker area is performance: §5.5 defines iteration bounds and selected-path reruns, but does not define a runtime performance expectation for large graphs.
For this feature, that is acceptable because the primary risk is correctness and state coherence, not throughput.

### Findings

- **low** Performance expectations are bounded but not profiled (§5.5) - The PRD defines default and maximum negative route budgets and requires avoiding unrelated descendants, but it does not say what size of graph or attempt count should remain responsive.
  _Fix:_ If architecture expects large workflows, add one operational target such as "selected path recomputation remains linear in node plus edge count" or leave it explicitly to architecture.

## Strategic coherence - strong

The PRD has a clear thesis: preserve the DAG-first mental model while adding one bounded routing primitive for quality gate repair loops.
The feature list serves that thesis consistently.
Schema restrictions, From Node constraints, max iteration semantics, condition reuse, activation state, attempt history, route events, and builder ports all reinforce the same controlled-loop model.

The Success Metrics validate the thesis rather than measuring generic activity.
SM-1 checks the actual BMAD quality-gate loop.
SM-2 protects brownfield compatibility.
SM-3 checks route state across lifecycle boundaries.
SM-C1 through SM-C3 are useful counter-metrics because they prevent the team from optimizing toward arbitrary cycles, misleading skipped states, or prompt magic.

### Findings

- No issues found.

## Done-ness clarity - adequate

Most FRs have testable consequences.
Schema validation, single-source wiring, three required route outcomes, max iteration semantics, condition parse failures, latest-attempt output, retry-node constraints, event fields, builder serialization, and missing-route blocking are all verifiable.
The addendum's Suggested Validation Focus is also useful for converting the PRD into tests.

Done-ness is not yet strong because a few terms that will become acceptance criteria are underspecified.
"Short string node ID", "clear error", "durable enough", "selected Rerun Path", and "visually distinct" are understandable product intent, but not precise enough for final story acceptance.
The biggest ambiguity is selected rerun-path behavior: the PRD says multiple dependency paths are allowed and nodes inside the selected path cannot depend on nodes outside it, but it does not include representative valid and invalid graph examples.

### Findings

- **medium** Rerun-path validity needs examples before story slicing (§4.3, §6.2; addendum §7) - FR-16 and FR-17 describe selected paths, self-containment, direct From Node targets, negative paths that exit, and nested Route Loops.
  These are correct concepts, but implementers will still need to infer the graph algorithm and error cases.
  _Fix:_ Add 2-4 concrete YAML or ASCII graph examples covering a valid fix-review-router cycle, a self-containment violation, a negative path that exits without warning, and a positive or exhausted route that illegally re-enters the loop path.
- **medium** Acceptance wording uses a few soft terms (§4.4, §4.5, §4.6) - Examples include "clear error", "durable enough", "compact", and "visually distinct".
  These are not fatal because adjacent bullets give context, but story authors will need to turn them into explicit checks.
  _Fix:_ For each soft phrase, add one concrete observable criterion, such as required error identifiers or route event projection fields.

## Scope honesty - adequate

The PRD is unusually honest about non-goals.
It explicitly excludes arbitrary cyclic graphs, node-level routes, default routes, sentinels, fanout, prompt injection, attempt arrays in expressions, direct route-controller retry, and redefining BMAD or TEA semantics.
The Non-Users section also prevents readers from assuming the feature serves broader workflow-routing ambitions.

Scope honesty is only adequate because some in-scope statements and open questions conflict.
The MVP includes Web builder round-trip, `node_routed` persistence, SSE propagation, and route output metadata.
The Open Questions then ask which builder surface is mandatory, whether route evidence must be stronger than best-effort, and whether route output includes key identity fields.
Those are not scope refinements; they are acceptance-boundary decisions.

### Findings

- **high** Open questions are too acceptance-critical for an implementation-ready PRD (§8, §11) - Five open questions are acceptable for a draft, but at least the first three directly affect schema, storage, eventing, Web work, generated types, and test coverage.
  _Fix:_ Resolve Open Questions 1 through 3 before moving to architecture and stories, or mark the PRD status as "draft, not ready for implementation planning".

## Downstream usability - adequate

The PRD is useful for architecture and story creation.
FR IDs are contiguous, UJs are named, Success Metrics map to FR ranges, the glossary defines the core domain terms, and the addendum provides brownfield implementation surfaces without turning them into requirements.
I verified representative brownfield references against current code: `buildTopologicalLayers` and `executeDagWorkflow` show the current static layer model, `dagNodeBaseSchema` shows current shared node fields, and the console builder variant model still enumerates the existing node kinds.

Downstream usability is limited by a few unresolved interface contracts.
Generated API and Web types cannot stabilize until route output identity fields and Web builder scope are decided.
Architecture can proceed with investigation, but story creation would likely fork into incompatible interpretations.

### Findings

- **medium** Route output and event contracts need a single source of truth (§4.5, §6.3, §11; addendum §2.3) - The PRD, runtime contract, and addendum all discuss mirroring route metadata, but the output example in the source contract omits IDs while the PRD recommends adding them.
  _Fix:_ Add an explicit "Route Metadata Contract" table with field name, required or optional status, type, source, and exposed surfaces for `node_routed`, `route_loop.output`, SSE, and generated Web types.
- **low** Success Metrics are mostly scenario checks, not measurable release gates (§9) - For an internal developer-product feature this is acceptable, but SM-1 through SM-6 are closer to acceptance scenarios than metrics.
  _Fix:_ If the PRD is used for go or no-go decisions, add pass/fail release gates such as specific fixture workflows, validation commands, and zero-regression expectations for non-route workflows.

## Shape fit - strong

The PRD shape fits a brownfield developer-product feature.
It does not over-index on consumer personas or marketing claims.
It behaves like a product contract plus implementation handoff for a workflow engine change, which is the right shape for a single-developer, TypeScript workflow platform.

The addendum is especially useful for brownfield fit.
It distinguishes canonical sources from traceability sources, reconciles prior decision drift, names affected repo surfaces, and calls out existing executor, condition, event, retry, and builder constraints.
That is exactly the kind of context architecture needs before designing a route-aware scheduler.

### Findings

- No issues found.

## Mechanical notes

- Glossary is generally consistent.
  "From Node", "Negative Outcome", "Route Loop", and "Rerun Path" are used consistently enough for downstream extraction.
- FR IDs are contiguous from FR-1 through FR-30.
  UJ and SM IDs are also contiguous and unique.
- The Assumptions Index says no inline assumption tags remain.
  I did not find inline assumption tags in `prd.md`.
- The PRD uses both "Web UI user" and "web workflow builder" language while the addendum distinguishes production builder and experimental console builder.
  This is a scope issue more than a wording issue.
- The phrase "short string node ID" appears as a validation requirement but is not bounded.
  If this is meant to reuse an existing node ID schema, say so; if not, define the allowed pattern or defer explicitly to architecture.
- The addendum's validation focus is strong and should be preserved into architecture and story creation.
