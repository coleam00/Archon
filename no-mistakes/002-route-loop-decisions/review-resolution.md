# Review Resolution Report

Report Format Version: 1

## Run Context

- Run ID: 01KW4HS5EV34WQR7JTBR5H81HE
- Repository identifier or path: /Users/dale/Desktop/workspace/OceanLabs/workflow-engine/Archon
- Branch: 002-route-loop-decisions
- Base commit: 3c6527561c398fc2d2154043d3871cdd42acd472
- Current/final head commit: a633a20881905c004843ea4045b6903b4b9659c9
- Review step status: completed
- Report lifecycle state: in_progress
- First generated timestamp: 2026-06-27T13:39:10Z
- Last refreshed timestamp: 2026-06-27T14:10:15Z
- Finalized timestamp: not finalized
- Repo report path: /Users/dale/.archon/workspaces/coleam00/archon/worktrees/archon/thread-07a17cd4/no-mistakes/002-route-loop-decisions/review-resolution.md

## Counts

- Resolved: 0
- Accepted Without Fix: 1
- Informational / No Action Required: 0
- Still Open: 9
- Total Entries: 10

## Resolved Issues

No issues in this category.

## Accepted Without Fix

### route-loop-scheduled-target-skipped-by-prior-success

- Finding ID: route-loop-scheduled-target-skipped-by-prior-success
- Severity: error
- File and line: packages/workflows/src/dag-executor.ts:3333
- Action: auto-fix
- Source: agent
- Review round ID: 2
- Description: Route-loop rerun scheduling bypasses the in-memory \`nodeOutputs\` cache, but it still falls through to the older prior-success retry shortcut. In a manual retry where the selected route target was completed earlier but is not a static descendant of the retry target, the new route decision is ignored and the stale output is reused; gate this shortcut for scheduled route reruns and replace the stale cached output when the target executes.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Accepted Without Fix
- Outcome evidence and provenance: Persisted Review terminal decision accepted the finding without a fix.
- Selection source: not recorded
- Decision action: approve
- Decision actor/source: user
- Decision timestamp: 2026-06-27T14:10:15Z
- Decision round ID: 01KW4PNCFFTEFWJTFPVZDDB2TY
- Decision reason: approved without fix
- Fix round ID: not recorded
- Applied Solution Source: not applicable
- Applied solution or attempted solution: not recorded
- Rationale: not recorded
- Changed files: not recorded
- Fix commit SHA: not recorded
- No-commit reason: not recorded
- Verification text: accepted without fix by user
- Follow-up round ID: not recorded
- Scope-equivalence note: not recorded
- Verifier source: review terminal decision
- Evidence reference: persisted review resolution decision 01KW4PNCFFTEFWJTFPVZDDB2TY
- Evidence quality: structured

## Informational / No Action Required

No issues in this category.

## Still Open Issues

### builder-route-edges-false-cycle

- Finding ID: builder-route-edges-false-cycle
- Severity: warning
- File and line: packages/web/src/lib/dag-layout.ts:160
- Action: auto-fix
- Source: agent
- Review round ID: 1
- Description: Route-loop outcome edges are added to the React Flow edge list, but builder cycle validation still checks all edges as static dependencies. A valid route loop such as review-router -&gt; fix plus fix -&gt; review -&gt; review-router will be reported as a dependency cycle. Mark or filter route outcome edges before dependency cycle validation, matching serialization behavior.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-27T13:39:10Z
- Decision round ID: 01KW4MWFBAB2NK5WVBVGM6MF1F
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Static cycle detection now ignores route-loop outcome edges.
- Rationale: Route outcomes are conditional runtime transitions, not static depends\\\_on edges, so they should not create builder dependency cycles.
- Changed files: packages/web/src/lib/dag-layout.test.ts, packages/web/src/lib/dag-layout.ts
- Fix commit SHA: a633a20881905c004843ea4045b6903b4b9659c9
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KW4MWFBAB2NK5WVBVGM6MF1F
- Evidence quality: structured

### builder-route-loop-input-source-not-synced

- Finding ID: builder-route-loop-input-source-not-synced
- Severity: warning
- File and line: packages/web/src/components/workflows/WorkflowCanvas.tsx:107
- Action: auto-fix
- Source: agent
- Review round ID: 1
- Description: The serializer treats route_loop.from as node data and depends_on as edge data without keeping them synchronized. Connecting or reconnecting an input edge leaves existing.from stale and this line prefers it over deps\[0\]; editing Route Source changes from but not the input edge, so depends_on still serializes from the old edge. Make the input edge the source of truth or update both representations on every change.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-27T13:39:10Z
- Decision round ID: 01KW4MWFBAB2NK5WVBVGM6MF1F
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Route-loop source data is now the serialization source of truth, with edge connect/delete and inspector updates syncing route data and edges.
- Rationale: This removes the stale split between route\\\_loop.from and the visible input edge when users reconnect or edit the source.
- Changed files: packages/web/src/components/workflows/WorkflowBuilder.tsx, packages/web/src/components/workflows/WorkflowCanvas.test.ts, packages/web/src/components/workflows/WorkflowCanvas.tsx
- Fix commit SHA: a633a20881905c004843ea4045b6903b4b9659c9
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KW4MWFBAB2NK5WVBVGM6MF1F
- Evidence quality: structured

### builder-route-loop-route-edge-stale-state

- Finding ID: builder-route-loop-route-edge-stale-state
- Severity: warning
- File and line: packages/web/src/components/workflows/WorkflowCanvas.tsx:93
- Action: auto-fix
- Source: agent
- Review round ID: 1
- Description: Route-loop routes are initialized from node.data.route_loop.routes and only overridden when a matching edge exists. Deleting a route edge leaves the old target in node data, and editing a route target in the inspector is ignored while a stale edge for that outcome remains. Keep route fields and edges synchronized, or make one source of truth so save cannot silently preserve or override the visible graph.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-27T13:39:10Z
- Decision round ID: 01KW4MWFBAB2NK5WVBVGM6MF1F
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Route-loop route targets now serialize from synced node data, and route edge changes clear or rebuild matching route fields.
- Rationale: Deleting an edge can no longer preserve a hidden old target, and inspector edits are no longer overridden by stale edges.
- Changed files: packages/web/src/components/workflows/WorkflowBuilder.tsx, packages/web/src/components/workflows/WorkflowCanvas.test.ts, packages/web/src/components/workflows/WorkflowCanvas.tsx
- Fix commit SHA: a633a20881905c004843ea4045b6903b4b9659c9
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KW4MWFBAB2NK5WVBVGM6MF1F
- Evidence quality: structured

### parallel-route-loop-stale-cas

- Finding ID: parallel-route-loop-stale-cas
- Severity: error
- File and line: packages/workflows/src/dag-executor.ts:3617
- Action: auto-fix
- Source: agent
- Review round ID: 1
- Description: Layer execution is concurrent, but each route_loop computes its transition from the same shared in-memory routeLoopMetadata before persistence updates it. Two independent route_loop controllers in the same layer can both send the same expected_execution_seq; with correct CAS locking one valid decision is rejected, and without it metadata can be lost. Serialize route decisions within a layer or reload and retry metadata on stale-write conflicts.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-27T13:39:10Z
- Decision round ID: 01KW4MWFBAB2NK5WVBVGM6MF1F
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Route-loop decisions are serialized through an in-run queue before metadata calculation and persistence.
- Rationale: Each parallel controller now observes the latest persisted execution sequence before computing its own transition.
- Changed files: packages/workflows/src/dag-executor.test.ts, packages/workflows/src/dag-executor.ts
- Fix commit SHA: a633a20881905c004843ea4045b6903b4b9659c9
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KW4MWFBAB2NK5WVBVGM6MF1F
- Evidence quality: structured

### route-loop-descendants-stay-skipped

- Finding ID: route-loop-descendants-stay-skipped
- Severity: error
- File and line: packages/workflows/src/dag-executor.ts:3226
- Action: auto-fix
- Source: agent
- Review round ID: 1
- Description: Inactive route targets are cached as pending outputs, so their dependents can evaluate and persist skipped before the route is selected. When the route later selects that target, collectSelectedRouteRerunNodeIds schedules only the target for positive or exhausted outcomes, and the nodeOutputs guard returns the already-skipped descendants without running them. Keep inactive branches out of nodeOutputs or schedule the selected branch descendants too.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-27T13:39:10Z
- Decision round ID: 01KW4MWFBAB2NK5WVBVGM6MF1F
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Inactive route branches remain pending outside nodeOutputs, and descendants with inactive route-target ancestors wait instead of recording skipped outputs.
- Rationale: Avoiding cached pending or skipped state lets selected target descendants run naturally after the route decision.
- Changed files: packages/workflows/src/dag-executor.test.ts, packages/workflows/src/dag-executor.ts
- Fix commit SHA: a633a20881905c004843ea4045b6903b4b9659c9
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KW4MWFBAB2NK5WVBVGM6MF1F
- Evidence quality: structured

### route-loop-resume-replays-decision

- Finding ID: route-loop-resume-replays-decision
- Severity: error
- File and line: packages/workflows/src/dag-executor.ts:3618
- Action: auto-fix
- Source: agent
- Review round ID: 1
- Description: The route-loop branch persists only node_routed and returns transition.output in memory; it never writes a completed-node output for the controller. Production resume and retry hydration read completed/skipped-prior-success projections, so after a failure or later retry they cannot restore the controller output and can re-evaluate the same decision with incremented counters. Persist the controller output or teach hydration to derive it from node_routed.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-27T13:39:10Z
- Decision round ID: 01KW4MWFBAB2NK5WVBVGM6MF1F
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: The route decision transaction now also writes the route controller node\\\_completed output.
- Rationale: Resume hydration already reads completed-node outputs, so persisting the controller output in the same transaction prevents decision replay.
- Changed files: packages/core/src/db/workflows.resume-cas.integration.test.ts, packages/core/src/db/workflows.test.ts, packages/core/src/db/workflows.ts, packages/workflows/src/dag-executor.ts, packages/workflows/src/store.ts
- Fix commit SHA: a633a20881905c004843ea4045b6903b4b9659c9
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KW4MWFBAB2NK5WVBVGM6MF1F
- Evidence quality: structured

### route-loop-root-targets-run-early

- Finding ID: route-loop-root-targets-run-early
- Severity: error
- File and line: packages/workflows/src/dag-executor.ts:3117
- Action: auto-fix
- Source: agent
- Review round ID: 1
- Description: Every root node is pre-marked as an activated route target. Because builder route-outcome edges are not serialized as depends_on edges, positive or exhausted targets can be root nodes and run in layer 0 before the route_loop selects them. Only pre-activate initial nodes needed to reach the controller, or require route targets to wait for a route decision.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-27T13:39:10Z
- Decision round ID: 01KW4MWFBAB2NK5WVBVGM6MF1F
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Route targets now activate only when they are on the initial static path to a route controller or selected by a route decision.
- Rationale: This preserves legitimate initial negative-path setup while preventing positive or exhausted root targets from running before selection.
- Changed files: packages/workflows/src/dag-executor.test.ts, packages/workflows/src/dag-executor.ts
- Fix commit SHA: a633a20881905c004843ea4045b6903b4b9659c9
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KW4MWFBAB2NK5WVBVGM6MF1F
- Evidence quality: structured

### route-loop-stale-activations-after-retry

- Finding ID: route-loop-stale-activations-after-retry
- Severity: error
- File and line: packages/workflows/src/dag-executor.ts:3127
- Action: auto-fix
- Source: agent
- Review round ID: 1
- Description: The executor reactivates every historical routeActivations target from run metadata. Manual node retry preserves that metadata while invalidating node outputs, so a target selected by an earlier decision can become active again and run alongside the newly selected target after the retried route_loop executes. Scope activations to the current retry epoch/latest execution sequence or clear affected activations when retry invalidates them.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-27T13:39:10Z
- Decision round ID: 01KW4MWFBAB2NK5WVBVGM6MF1F
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Resume hydration now uses only the latest activation per controller and ignores activations for retry-invalidated controllers.
- Rationale: Historical targets no longer remain active after a newer decision or a retry that must re-evaluate the controller.
- Changed files: packages/workflows/src/dag-executor.test.ts, packages/workflows/src/dag-executor.ts
- Fix commit SHA: a633a20881905c004843ea4045b6903b4b9659c9
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KW4MWFBAB2NK5WVBVGM6MF1F
- Evidence quality: structured

### route-loop-transaction-not-pinned

- Finding ID: route-loop-transaction-not-pinned
- Severity: error
- File and line: packages/core/src/db/workflows.ts:774
- Action: auto-fix
- Source: agent
- Review round ID: 1
- Description: persistRouteDecisionTransition opens BEGIN and COMMIT through the shared pool, but PostgresAdapter.query() can use a different client for each statement. The FOR UPDATE lock, CAS check, metadata update, event insert, and rollback are not guaranteed to be one transaction, and the BEGIN client can be left idle in a transaction. Use a transaction-scoped client for the whole block.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-27T13:39:10Z
- Decision round ID: 01KW4MWFBAB2NK5WVBVGM6MF1F
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Route decision persistence now uses the database transaction API and a transaction-scoped query function.
- Rationale: The existing adapter transaction abstraction pins Postgres work to one client and keeps SQLite behavior atomic without duplicating transaction handling.
- Changed files: packages/core/src/db/workflows.resume-cas.integration.test.ts, packages/core/src/db/workflows.test.ts, packages/core/src/db/workflows.ts
- Fix commit SHA: a633a20881905c004843ea4045b6903b4b9659c9
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KW4MWFBAB2NK5WVBVGM6MF1F
- Evidence quality: structured
