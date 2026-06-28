---
description: 'Tasks for route loop decisions feature implementation'
---

# Tasks: Route Loop Decisions

**Input**: Design documents from `specs/002-route-loop-decisions/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `quickstart.md`, and `contracts/`
**Tests**: Required for this feature because the source request explicitly asks for TDD and E2E verification.
**Organization**: Tasks are grouped by user story so each story can be implemented and tested as an independently reviewable increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files and does not depend on incomplete tasks.
- **[Story]**: Maps a task to a user story from `spec.md`.
- Every task includes concrete repository paths.

## Phase 1: Setup

**Purpose**: Reproduce the current missing-feature behavior and confirm the baseline test surfaces before changing implementation.

- [x] T001 Run `bun test packages/workflows/src/dag-executor.test.ts -t "reruns a negative route path until the route_loop condition passes"` and confirm the expected pre-implementation failure in `packages/workflows/src/dag-executor.test.ts`
- [x] T002 [P] Run `bun test packages/workflows/src/loader.test.ts packages/workflows/src/schemas.test.ts` to capture current workflow schema and loader baseline behavior in `packages/workflows/src/loader.test.ts`
- [x] T003 [P] Run `bun test packages/web/src/experiments/console/builder/model/round-trip.test.ts packages/web/src/experiments/console/builder/validation/validate.test.ts` to capture current builder baseline behavior in `packages/web/src/experiments/console/builder/model/round-trip.test.ts`
- [x] T004 [P] Inspect the current workflow event and metadata seams in `packages/workflows/src/store.ts` and `packages/core/src/db/workflows.ts`

---

## Phase 2: Foundational

**Purpose**: Add shared fixtures and typed route-loop runtime foundations that later user stories rely on.

**Critical**: User-story implementation should not start until this phase is complete.

- [x] T005 [P] Add shared route-loop workflow fixture builders in `packages/workflows/src/test-utils.ts`
- [x] T006 [P] Add a route-loop builder fixture in `packages/web/src/experiments/console/builder/fixtures/route-loop.fixture.ts`
- [x] T007 Export the route-loop builder fixture from `packages/web/src/experiments/console/builder/fixtures/index.ts`
- [x] T008 [P] Add failing tests for route-loop runtime metadata validation in `packages/workflows/src/schemas.test.ts`
- [x] T009 Add route-loop metadata schema support for `loopCounters`, `nodeAttempts`, `executionSeq`, and `routeActivations` in `packages/workflows/src/schemas/workflow-run.ts`
- [x] T010 Add the initial route-loop event type contract placeholder in `packages/workflows/src/store.ts`

**Checkpoint**: Route-loop fixtures, metadata contracts, and event contract placeholders are ready.

---

## Phase 3: User Story 1 - Author A Controlled Review Loop (Priority: P1)

**Goal**: A workflow author can declare a standalone `route_loop` controller with required route targets, safe ids, strict mode exclusivity, and loader validation.

**Independent Test**: Load a `fix -> review -> review-router` workflow and verify the route-loop node is accepted with required `positive`, `negative`, and `exhausted` routes while invalid shapes fail before execution.

### Tests For User Story 1

- [x] T011 [P] [US1] Add schema tests for valid `route_loop` config, exclusive execution mode, default `max_iterations`, and safe id grammar in `packages/workflows/src/schemas.test.ts`
- [x] T012 [US1] Add loader tests for required routes, `depends_on` and `from` mismatch, missing targets, self-target routes, rejecting `when` on `route_loop`, rejecting `trigger_rule` on `route_loop`, rejecting `when` on the `from` node, and allowing `trigger_rule` on the `from` node in `packages/workflows/src/loader.test.ts`
- [x] T013 [US1] Add loader tests for from-only condition references and declared output field references in `packages/workflows/src/loader.test.ts`
- [x] T014 [P] [US1] Add OpenAPI workflow definition tests for the `route_loop` DAG node shape in `packages/server/src/routes/api.workflows.test.ts`

### Implementation For User Story 1

- [x] T015 [US1] Implement `routeLoopConfigSchema`, `routeLoopRoutesSchema`, `routeOutcomeSchema`, safe node id validation, and derived types in `packages/workflows/src/schemas/route-loop.ts`
- [x] T016 [US1] Export route-loop schemas and type guards from `packages/workflows/src/schemas/index.ts`
- [x] T017 [US1] Extend `dagNodeSchema` with mutually exclusive `route_loop` node mode validation in `packages/workflows/src/schemas/dag-node.ts`
- [x] T018 [US1] Extend workflow loader validation for `route_loop.depends_on`, `route_loop.from`, route target existence, and unsupported node fields in `packages/workflows/src/loader.ts`
- [x] T019 [US1] Add route-edge cycle validation, positive and exhausted exit-path validation, nested route-loop allowance, warning behavior when `routes.negative` targets `route_loop.from` directly, and negative rerun plan validation in `packages/workflows/src/loader.ts`
- [x] T020 [US1] Expose condition parsing reference metadata needed by route-loop validation in `packages/workflows/src/condition-evaluator.ts`
- [x] T021 [US1] Wire strict output field validation for route-loop condition references in `packages/workflows/src/output-ref.ts`
- [x] T022 [US1] Update server workflow schemas to include the route-loop DAG node shape in `packages/server/src/routes/schemas/workflow.schemas.ts`
- [x] T023 [US1] Verify User Story 1 with `bun test packages/workflows/src/schemas.test.ts packages/workflows/src/loader.test.ts packages/server/src/routes/api.workflows.test.ts` for `packages/workflows/src/loader.test.ts`

**Checkpoint**: User Story 1 is complete when route-loop YAML validates correctly and invalid public contract shapes fail before execution.

---

## Phase 4: User Story 2 - Execute Negative, Positive, And Exhausted Routes (Priority: P1)

**Goal**: Route-loop workflows execute selected route targets only, rerun completed targets as fresh attempts, and honor bounded negative-route counters.

**Independent Test**: Run the TDD workflow where the first review result is negative and the second review result is positive.
Verify execution order is `fix`, `review`, `fix`, `review`, `done`, `escalation` does not run, and two `node_routed` events are emitted.

### Tests For User Story 2

- [x] T024 [US2] Update the existing route-loop TDD guard to assert safe condition metadata, route-loop attempt, and execution sequence fields in `packages/workflows/src/dag-executor.test.ts`
- [x] T025 [US2] Add executor tests for `max_iterations: 1`, exhausted routing on the second false result, and `condition_result: false` on exhausted events in `packages/workflows/src/dag-executor.test.ts`
- [x] T026 [P] [US2] Add route-loop metadata transition tests for counter increment, positive reset, attempt increment, and sequence increment in `packages/workflows/src/schemas.test.ts`
- [x] T027 [P] [US2] Add core persistence tests for atomic route-decision metadata and event writes in `packages/core/src/db/workflows.test.ts`

### Implementation For User Story 2

- [x] T028 [US2] Add a typed route-loop runtime state transition helper in `packages/workflows/src/route-loop-state.ts`
- [x] T029 [US2] Define the durable route-decision store contract in `packages/workflows/src/store.ts`
- [x] T030 [US2] Implement atomic metadata update and stale-write protection for route decisions in `packages/core/src/db/workflows.ts`
- [x] T031 [US2] Wire route-decision persistence through the workflow store adapter in `packages/core/src/workflows/store-adapter.ts`
- [x] T032 [US2] Add the route activation executor path while preserving the existing static DAG path in `packages/workflows/src/dag-executor.ts`
- [x] T033 [US2] Evaluate `route_loop.condition` against the latest completed output of `route_loop.from` and fail fast for skipped, failed, missing, pending, or unusable source output in `packages/workflows/src/dag-executor.ts`
- [x] T034 [US2] Increment negative counters before selecting `negative` or `exhausted` and reset only the selected loop counter on `positive` in `packages/workflows/src/dag-executor.ts`
- [x] T035 [US2] Activate only the selected route target and leave unselected route targets dormant in `packages/workflows/src/dag-executor.ts`
- [x] T036 [US2] Rerun completed selected targets as fresh attempts, validate the selected rerun path self-containment at runtime before invalidating latest-output state, and add executor coverage for stale persisted state, resume, retry, or loader-bypassed rerun paths in `packages/workflows/src/dag-executor.ts` and `packages/workflows/src/dag-executor.test.ts`
- [x] T037 [US2] Fail fast when a selected route target is already running or paused in `packages/workflows/src/dag-executor.ts`
- [x] T038 [US2] Persist route-loop output metadata from the same route-decision transition that writes `node_routed` in `packages/workflows/src/dag-executor.ts`
- [x] T039 [US2] Verify User Story 2 with `bun test packages/workflows/src/dag-executor.test.ts packages/core/src/db/workflows.test.ts` for `packages/workflows/src/dag-executor.test.ts`

**Checkpoint**: User Story 2 is complete when negative, positive, and exhausted outcomes activate exactly one configured target and bounded counters survive the route decision transition.

---

## Phase 5: User Story 3 - Debug Attempts And Route Decisions (Priority: P2)

**Goal**: Operators can inspect latest outputs, prior attempts, route decisions, counters, and selected targets without losing event history.

**Independent Test**: Run a workflow with multiple negative routes before success.
Verify latest attempt projection uses the newest completed output, the event log keeps every attempt, and each `node_routed` event includes safe route metadata.

### Tests For User Story 3

- [x] T040 [P] [US3] Add output reference tests asserting `$node.output` resolves to the latest completed attempt in `packages/workflows/src/output-ref.test.ts`
- [x] T041 [P] [US3] Add event projection tests for prior attempts and `node_routed` metadata preservation in `packages/core/src/db/workflow-events.test.ts`
- [x] T042 [P] [US3] Add API run detail tests for `node_routed` events, route-loop outputs, latest attempts, and historical attempts in `packages/server/src/routes/api.workflow-runs.test.ts`

### Implementation For User Story 3

- [x] T043 [US3] Extend the workflow event row schema with typed `node_routed` metadata validation in `packages/core/src/schemas/workflow-event.ts`
- [x] T044 [US3] Extend core workflow run row metadata validation for route-loop metadata fields in `packages/core/src/schemas/workflow-run.ts`
- [x] T045 [US3] Project latest attempt summaries without deleting old attempt events in `packages/core/src/db/workflow-events.ts`
- [x] T046 [US3] Return `node_routed` events and latest route-loop outputs through the workflow store adapter in `packages/core/src/workflows/store-adapter.ts`
- [x] T047 [US3] Add safe condition serialization that preserves references, fields, operators, and boolean structure while redacting literal values in `packages/workflows/src/condition-evaluator.ts`
- [x] T048 [US3] Stream typed `node_routed` events through the workflow event emitter in `packages/workflows/src/event-emitter.ts`
- [x] T049 [US3] Update server run detail schemas for route metadata fields in `packages/server/src/routes/schemas/workflow.schemas.ts`
- [x] T050 [US3] Verify User Story 3 with `bun test packages/workflows/src/output-ref.test.ts packages/core/src/db/workflow-events.test.ts packages/core/src/workflows/store-adapter.test.ts packages/server/src/routes/api.workflow-runs.test.ts` for `packages/core/src/db/workflow-events.test.ts`

**Checkpoint**: User Story 3 is complete when run detail surfaces latest state while the audit trail still contains every route decision and attempt.

---

## Phase 6: User Story 4 - Build And Validate Route Loops In The Web UI (Priority: P2)

**Goal**: Web users can author route-loop nodes visually with one input, three labeled route outputs, synchronized YAML fields, and visible validation errors.

**Independent Test**: In the workflow builder, create a route-loop node, connect one review input, connect `positive`, `negative`, and `exhausted` output ports, save, reload, and verify the YAML route targets match the graph edges.

### Tests For User Story 4

- [x] T051 [P] [US4] Add console builder round-trip tests for route-loop input and output serialization in `packages/web/src/experiments/console/builder/model/round-trip.test.ts`
- [x] T052 [P] [US4] Add console builder validation tests for one input, required routes, shared route targets, and mismatched `from` in `packages/web/src/experiments/console/builder/validation/graph.test.ts`
- [x] T053 [P] [US4] Add structural validation tests for safe node ids and reserved keys in `packages/web/src/experiments/console/builder/validation/structural.test.ts`
- [x] T054 [P] [US4] Add route-loop variant detection tests in `packages/web/src/experiments/console/builder/variants/detect.test.ts`
- [x] T055 [P] [US4] Add graph layout tests for route edges, outcome labels, and dormant route targets in `packages/web/src/lib/dag-layout.test.ts`
- [x] T056 [P] [US4] Add component, Web store, and SSE/refetch bridge tests for route-loop node handles, typed `node_routed` rendering, and route decision propagation within one live refresh cycle in `packages/web/src/components/workflows/DagNodeComponent.test.ts`, `packages/web/src/components/workflows/WorkflowExecution.test.tsx`, `packages/web/src/stores/workflow-store.test.ts`, and `packages/server/src/adapters/web/workflow-bridge.test.ts`

### Implementation For User Story 4

- [x] T057 [US4] Regenerate OpenAPI-derived Web API types after server schema changes in `packages/web/src/lib/api.generated.d.ts`
- [x] T058 [US4] Re-export route-loop API types and local runtime constants from `packages/web/src/lib/api.ts`
- [x] T059 [US4] Add route-loop variant detection and field mapping in `packages/web/src/experiments/console/builder/variants/route-loop.ts`
- [x] T060 [US4] Register the route-loop builder variant in `packages/web/src/experiments/console/builder/variants/registry.ts`
- [x] T061 [US4] Serialize route-loop input and outcome edges to workflow YAML in `packages/web/src/experiments/console/builder/model/to-workflow.ts`
- [x] T062 [US4] Hydrate route-loop YAML into builder nodes and route edges in `packages/web/src/experiments/console/builder/model/from-workflow.ts`
- [x] T063 [US4] Add route-loop graph validation issues for missing routes, second inputs, invalid targets, and mismatched `from` in `packages/web/src/experiments/console/builder/validation/graph.ts`
- [x] T064 [US4] Render the route-loop palette entry and inspector controls in `packages/web/src/components/workflows/NodeLibrary.tsx` and `packages/web/src/components/workflows/NodeInspector.tsx`
- [x] T065 [US4] Render route-loop controller styling and three output handles in `packages/web/src/components/workflows/DagNodeComponent.tsx`
- [x] T066 [US4] Render route edges separately with outcome labels in `packages/web/src/lib/dag-layout.ts` and `packages/web/src/components/workflows/WorkflowDagViewer.tsx`
- [x] T067 [US4] Render typed `node_routed` run events and dormant route targets in `packages/web/src/components/workflows/WorkflowExecution.tsx` and `packages/web/src/components/workflows/ExecutionDagNode.tsx`
- [x] T068 [US4] Keep approval gates and interactive-loop input banners visually distinct from route-loop decisions in `packages/web/src/components/workflows/WorkflowExecution.tsx`
- [x] T069 [US4] Verify User Story 4 with builder, layout, and component tests in `packages/web/src/experiments/console/builder/model/round-trip.test.ts` and `packages/web/src/components/workflows/WorkflowExecution.test.tsx`

**Checkpoint**: User Story 4 is complete when the builder can save and reload route-loop graphs without manual YAML repair and run detail renders route decisions as first-class UI events.

---

## Phase 7: User Story 5 - Preserve Existing Workflow Lifecycle Behavior (Priority: P3)

**Goal**: Existing workflows, resume behavior, cancellation, abandon, manual retry, and provider sessions keep their current meaning.

**Independent Test**: Run existing workflow tests plus route-loop lifecycle tests.
Verify workflows without `route_loop` still use static DAG behavior and route-loop workflows resume and retry through the controller path correctly.

### Tests For User Story 5

- [x] T070 [P] [US5] Add regression tests that workflows without `route_loop` still use static DAG execution in `packages/workflows/src/dag-executor.test.ts`
- [x] T071 [P] [US5] Add retry eligibility tests proving route-loop controller nodes are not directly retryable in `packages/workflows/src/retry-state.test.ts`
- [x] T072 [P] [US5] Add resume persistence tests for route activation state, loop counters, attempt counters, and execution sequence in `packages/core/src/db/workflows.resume-cas.integration.test.ts`
- [x] T073 [P] [US5] Add Web retry action tests that guide users toward `route_loop.from` in `packages/web/src/components/workflows/WorkflowNodeRetryAction.test.tsx`

### Implementation For User Story 5

- [x] T074 [US5] Preserve the existing static DAG execution branch for workflows without route-loop nodes in `packages/workflows/src/dag-executor.ts`
- [x] T075 [US5] Hydrate route activation state, counters, attempts, and execution sequence on resume in `packages/workflows/src/dag-executor.ts`
- [x] T076 [US5] Mark route-loop controller nodes ineligible for direct retry in `packages/workflows/src/retry-state.ts`
- [x] T077 [US5] Surface retry guidance toward the node referenced by `route_loop.from` in `packages/core/src/operations/workflow-retry.ts`
- [x] T078 [US5] Render route-loop retry guidance in `packages/web/src/components/workflows/WorkflowNodeRetryAction.tsx`
- [x] T079 [US5] Verify User Story 5 with `bun test packages/workflows/src/retry-state.test.ts packages/core/src/operations/workflow-retry.test.ts packages/web/src/components/workflows/WorkflowNodeRetryAction.test.tsx` for `packages/workflows/src/retry-state.test.ts`

**Checkpoint**: User Story 5 is complete when existing lifecycle behavior is unchanged and route-loop lifecycle state is preserved across resume and retry surfaces.

---

## Final Phase: Polish And Cross-Cutting Concerns

**Purpose**: Run package checks, regenerate derived artifacts, and perform the manual smoke path from `quickstart.md`.

- [x] T080 [P] Run `bun --filter @archon/workflows test` and fix failures in `packages/workflows/src/dag-executor.ts`
- [x] T081 [P] Run `bun --filter @archon/core test` and fix failures in `packages/core/src/workflows/store-adapter.ts`
- [x] T082 [P] Run `bun --filter @archon/server test` and fix failures in `packages/server/src/routes/schemas/workflow.schemas.ts`
- [x] T083 [P] Run `bun --filter @archon/web test` and fix failures in `packages/web/src/components/workflows/WorkflowExecution.tsx`
- [x] T084 Run `bun run type-check` and fix TypeScript errors in `packages/workflows/src/schemas/route-loop.ts`
- [x] T085 Run `bun run lint --max-warnings 0` and fix lint warnings in `packages/workflows/src/dag-executor.ts`
- [x] T086 Run `bun run format:check` and apply formatting fixes in `packages/workflows/src/schemas/route-loop.ts` and `packages/web/src/components/workflows/DagNodeComponent.tsx`
- [x] T087 Run `bun run dev:server` and `bun --filter @archon/web generate:types`, then verify generated type changes in `packages/web/src/lib/api.generated.d.ts`
- [x] T088 Run `bun run check:bundled`, `bun run check:bundled-skill`, and `bun run check:bundled-schema`, then fix checked artifacts in `packages/workflows/src/defaults/bundled-defaults.generated.ts` only if source changes require regeneration
- [x] T089 Run final `bun run validate` and fix remaining failures tracked by `package.json`
- [x] T090 Run the manual route-loop smoke workflow from `specs/002-route-loop-decisions/quickstart.md`

---

## Dependencies And Execution Order

### Phase Dependencies

- **Setup**: No dependencies.
- **Foundational**: Depends on Setup.
- **User Story 1**: Depends on Foundational.
- **User Story 2**: Depends on User Story 1 because runtime routing depends on the public YAML contract.
- **User Story 3**: Depends on User Story 2 because debug projection depends on route decisions and attempts.
- **User Story 4**: Depends on User Story 1 for schema shape and on User Story 3 for typed route-event projection.
- **User Story 5**: Depends on User Story 2 and can proceed alongside late User Story 4 UI tasks after route state exists.
- **Polish**: Depends on all selected user stories.

### User Story Dependencies

- **User Story 1 (P1)**: MVP schema and loader contract.
- **User Story 2 (P1)**: Requires User Story 1.
- **User Story 3 (P2)**: Requires User Story 2.
- **User Story 4 (P2)**: Requires User Story 1 and API type shape from User Story 3.
- **User Story 5 (P3)**: Requires User Story 2 and verifies no lifecycle regressions.

### Within Each User Story

- Write or update tests first and confirm they fail for the missing behavior.
- Implement schemas before loader checks.
- Implement loader checks before executor behavior.
- Implement store contracts before API projection.
- Regenerate Web API types before Web code depends on route-loop fields.
- Verify each story at its checkpoint before moving to the next story.

---

## Parallel Opportunities

- Setup tasks T002, T003, and T004 can run in parallel.
- Foundational tasks T005, T006, and T008 can run in parallel.
- User Story 1 tests T011 and T014 can run in parallel.
- User Story 2 tests T026 and T027 can run in parallel.
- User Story 3 tests T040, T041, and T042 can run in parallel.
- User Story 4 tests T051 through T056 can run in parallel because they touch separate Web test files.
- User Story 5 tests T070 through T073 can run in parallel because they cover separate workflow, core, and Web lifecycle files.
- Final package checks T080 through T083 can run in parallel if the machine has enough capacity.

---

## Parallel Examples

### User Story 1

```bash
Task: "T011 Add schema tests in packages/workflows/src/schemas.test.ts"
Task: "T014 Add OpenAPI workflow definition tests in packages/server/src/routes/api.workflows.test.ts"
```

### User Story 3

```bash
Task: "T040 Add latest output reference tests in packages/workflows/src/output-ref.test.ts"
Task: "T041 Add event projection tests in packages/core/src/db/workflow-events.test.ts"
Task: "T042 Add API run detail tests in packages/server/src/routes/api.workflow-runs.test.ts"
```

### User Story 4

```bash
Task: "T051 Add builder round-trip tests in packages/web/src/experiments/console/builder/model/round-trip.test.ts"
Task: "T052 Add graph validation tests in packages/web/src/experiments/console/builder/validation/graph.test.ts"
Task: "T054 Add variant detection tests in packages/web/src/experiments/console/builder/variants/detect.test.ts"
Task: "T055 Add graph layout tests in packages/web/src/lib/dag-layout.test.ts"
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete User Story 1 so the public YAML and validation contract is stable.
3. Complete User Story 2 so route-loop execution works for negative, positive, and exhausted outcomes.
4. Stop and validate the TDD guard plus workflow schema, loader, and executor tests.

### Incremental Delivery

1. Deliver User Story 1 as the schema and loader contract.
2. Deliver User Story 2 as the runtime MVP.
3. Deliver User Story 3 as debug and API projection.
4. Deliver User Story 4 as Web authoring and run UI.
5. Deliver User Story 5 as lifecycle compatibility and regression hardening.

### Validation Strategy

1. Use focused Bun test files during each story.
2. Use package-level tests after each package's story slice is complete.
3. Use generated API type regeneration only after server schemas compile.
4. Use `bun run validate` only after focused failures have been resolved.

---

## Task Summary

- **Total tasks**: 90
- **Setup tasks**: 4
- **Foundational tasks**: 6
- **User Story 1 tasks**: 13
- **User Story 2 tasks**: 16
- **User Story 3 tasks**: 11
- **User Story 4 tasks**: 19
- **User Story 5 tasks**: 10
- **Polish tasks**: 11
- **Suggested MVP scope**: Complete Phase 1, Phase 2, User Story 1, and User Story 2.
