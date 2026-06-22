# Tasks: Manual Failed-Node Retry Decisions

**Input**: Design documents from `specs/001-manual-node-retry-decisions/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`
**Tests**: Included. The feature spec and quickstart define independent tests for retry scope, git safety, Web, CLI, audit history, and DB convergence.
**Origin Reference**: `plans/grill-me/260621-1239-manual-node-retry-decisions.md`

## Phase 1: Setup (Shared Test Scaffolding)

**Purpose**: Add failing tests and fixtures that pin the cross-package behavior before implementation.

- [ ] T001 [P] Add failing checkpoint schema/export coverage in `packages/core/src/schemas/index.test.ts`
- [ ] T002 [P] Add failing checkpoint SQLite/PostgreSQL convergence coverage in `packages/core/src/db/adapters/sqlite.test.ts` and `packages/core/src/db/adapters/postgres.test.ts`
- [ ] T003 [P] Add failing tracked-only checkpoint/safety git helper coverage in `packages/git/src/git.test.ts`
- [ ] T004 [P] Add failing epoch-aware DAG retry projection coverage in `packages/workflows/src/retry-state.test.ts`
- [ ] T005 [P] Add failing retry preparation operation coverage in `packages/core/src/operations/workflow-retry.test.ts`
- [ ] T006 [P] Add failing retry API route coverage in `packages/server/src/routes/api.workflow-runs.test.ts`
- [ ] T007 [P] Add failing CLI `workflow retry-node` coverage in `packages/cli/src/commands/workflow.test.ts`
- [ ] T008 [P] Add failing Web retry helper coverage in `packages/web/src/lib/workflow-retry.test.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared schema, storage, event, projection, and git primitives required by every story.

**CRITICAL**: No user story implementation should start until this phase is complete.

- [ ] T009 Create checkpoint row Zod schema in `packages/core/src/schemas/workflow-checkpoint.ts`
- [ ] T010 Re-export checkpoint schema and derived type from `packages/core/src/schemas/index.ts`
- [ ] T011 Add `remote_agent_workflow_node_checkpoints` to SQLite initialization in `packages/core/src/db/adapters/sqlite.ts`
- [ ] T012 Add idempotent checkpoint table and indexes to PostgreSQL migration in `migrations/000_combined.sql`
- [ ] T013 Regenerate bundled DB schema content in `packages/core/src/db/bundled-schema.generated.ts`
- [ ] T014 Implement checkpoint DB queries in `packages/core/src/db/workflow-checkpoints.ts`
- [ ] T015 Export checkpoint DB module from `packages/core/src/db/index.ts` and extend `IWorkflowStore`/workflow deps with narrow checkpoint persistence methods that the core store adapter implements for pre-node DAG checkpoint writes
- [ ] T016 Extend workflow event type unions with `node_retry_requested`, `node_retry_reset`, and `node_retry_failed` in `packages/workflows/src/store.ts`
- [ ] T017 Extend persisted workflow event row schema validation for retry events in `packages/core/src/schemas/workflow-event.ts`
- [ ] T018 Add retry event bridge support to the core workflow store adapter in `packages/core/src/workflows/store-adapter.ts`
- [ ] T019 Implement pure retry DAG helpers for descendants, invalidation, and latest effective node state in `packages/workflows/src/retry-state.ts`
- [ ] T020 Export retry DAG helper types/functions from `packages/workflows/src/index.ts`
- [ ] T021 Add epoch-aware completed DAG output hydration entry point in `packages/core/src/db/workflow-events.ts`
- [ ] T022 Add tracked-only git ref, commit, validation, and reset helpers in `packages/git/src/retry-refs.ts`
- [ ] T023 Export retry git helpers from `packages/git/src/index.ts`
- [ ] T024 Add retry operation request/result/error types and a strict retry audit event writer in `packages/core/src/operations/workflow-retry.ts`; T035/T055/T056 MUST call this writer instead of `IWorkflowStore.createWorkflowEvent()` for retry audit events
- [ ] T025 Export retry operation from `packages/core/src/operations/index.ts`
- [ ] T026 Extend `ExecuteWorkflowOptions` with retry context fields in `packages/workflows/src/executor.ts`

**Checkpoint**: Foundation ready - user story implementation can now begin.

---

## Phase 3: User Story 1 - Retry A Failed DAG Node (Priority: P1) MVP

**Goal**: Retry one failed DAG node and current-DAG descendants while reusing the same workflow run row and preserving valid upstream/sibling outputs.

**Independent Test**: Use a `mutates_checkout: false` DAG `A -> B -> C`; fail `B`, retry `B`, verify `A` is not rerun, `B` and `C` rerun, the same run id is reused, and final status becomes `completed`.

### Tests for User Story 1

- [ ] T027 [P] [US1] Add linear `A -> B -> C` retry scope test in `packages/core/src/operations/workflow-retry.test.ts`
- [ ] T028 [P] [US1] Add parallel sibling preservation retry test in `packages/workflows/src/retry-state.test.ts`
- [ ] T029 [P] [US1] Add skipped downstream ineligible retry test in `packages/workflows/src/retry-state.test.ts`
- [ ] T030 [P] [US1] Add retry execution handoff test for prepared runs in `packages/workflows/src/executor-preamble.test.ts`
- [ ] T031 [P] [US1] Add invalidated persisted-session deletion test in `packages/core/src/db/workflow-node-sessions.test.ts`

### Implementation for User Story 1

- [ ] T032 [US1] Implement target validation for failed run and latest effective failed node in `packages/core/src/operations/workflow-retry.ts`
- [ ] T033 [US1] Implement invalidated target-plus-descendants calculation using current workflow DAG in `packages/core/src/operations/workflow-retry.ts`
- [ ] T034 [US1] Implement retry CAS from `failed` to `running` with exactly one metadata epoch increment in `packages/core/src/db/workflows.ts`
- [ ] T035 [US1] Write mandatory `node_retry_requested` audit event after CAS in `packages/core/src/operations/workflow-retry.ts`
- [ ] T036 [US1] Filter prior completed outputs to exclude invalidated nodes while preserving upstream/sibling outputs in `packages/core/src/db/workflow-events.ts`
- [ ] T037 [US1] Delete persisted node sessions for every invalidated node and all providers in `packages/core/src/operations/workflow-retry.ts`
- [ ] T038 [US1] Use retry-prepared `preCreatedRun` and filtered `priorCompletedNodes` without foreground resume lookup in `packages/workflows/src/executor.ts`
- [ ] T039 [US1] Ensure DAG execution skips preserved completed nodes and reruns invalidated nodes in `packages/workflows/src/dag-executor.ts`
- [ ] T040 [US1] Restore run status to `failed` and avoid dispatch on retry preparation failure in `packages/core/src/operations/workflow-retry.ts`

**Checkpoint**: User Story 1 is retryable through the shared operation in tests without Web/CLI UI.

---

## Phase 4: User Story 2 - Restore Checkout State Safely Before Retry (Priority: P1)

**Goal**: Checkpoint executable nodes and reset tracked files to the correct checkpoint on retry while preserving failed-attempt work through local safety refs.

**Independent Test**: Use a temp git repo with tracked dirty changes and untracked/ignored files; retry a failed mutating node and verify checkpoint/safety refs, tracked-only commits, reset behavior, and no untracked cleanup.

### Tests for User Story 2

- [ ] T041 [P] [US2] Add clean-checkout checkpoint ref test in `packages/git/src/git.test.ts`
- [ ] T042 [P] [US2] Add tracked-dirty checkpoint commit test excluding untracked files in `packages/git/src/git.test.ts`
- [ ] T043 [P] [US2] Add retry safety ref/commit, checkpoint ref/SHA `git rev-parse --verify <ref-or-sha>^{commit}` validation, invalid/missing ref producing `node_retry_failed` with no dispatch, and `git reset --hard` failure tests in `packages/git/src/git.test.ts` and `packages/core/src/operations/workflow-retry.test.ts`
- [ ] T044 [P] [US2] Add checkpoint lookup fallback test for target and first upstream dependency in `packages/core/src/db/workflow-checkpoints.test.ts`
- [ ] T045 [P] [US2] Add DAG pre-node checkpoint test for executable node kinds in `packages/workflows/src/dag-executor.test.ts`

### Implementation for User Story 2

- [ ] T046 [US2] Implement tracked-only dirty detection and commit creation in `packages/git/src/retry-refs.ts`, including immediate non-git repository rejection, missing `user.name`/`user.email` guidance, no stash fallback, and focused T003 coverage for those failures
- [ ] T047 [US2] Implement `git check-ref-format` validation before checkpoint/safety ref mutation in `packages/git/src/retry-refs.ts`
- [ ] T048 [US2] Implement checkpoint ref upsert for clean and dirty checkouts in `packages/git/src/retry-refs.ts`
- [ ] T049 [US2] Create checkpoints after trigger/`when:` checks and before executable node start only when `workflow.mutates_checkout !== false`; add explicit `mutates_checkout: false` no-checkpoint coverage and require retry setup to proceed without checkout reset and emit `node_retry_reset.reset_skipped = true` when no checkpoint exists in `packages/workflows/src/dag-executor.ts` and `packages/core/src/operations/workflow-retry.ts`
- [ ] T050 [US2] Persist node checkpoint rows for command, prompt, bash, script, and loop nodes in `packages/core/src/workflows/store-adapter.ts`
- [ ] T051 [US2] Skip checkpointing for approval/cancel/skipped nodes in `packages/workflows/src/dag-executor.ts`
- [ ] T052 [US2] Implement latest prior checkpoint and first-dependency fallback lookup in `packages/core/src/db/workflow-checkpoints.ts`
- [ ] T053 [US2] Create retry safety ref/commit before reset in `packages/core/src/operations/workflow-retry.ts`
- [ ] T054 [US2] Reset tracked files to selected checkpoint and never call `git clean` in `packages/core/src/operations/workflow-retry.ts`
- [ ] T055 [US2] Write `node_retry_reset` after successful safety/ref/reset setup in `packages/core/src/operations/workflow-retry.ts`
- [ ] T056 [US2] Write `node_retry_failed` with setup phase and error when checkpoint validation or reset fails in `packages/core/src/operations/workflow-retry.ts`
- [ ] T057 [US2] Emit warning for parallel mutating executable nodes in one DAG layer in `packages/workflows/src/dag-executor.ts`

**Checkpoint**: User Story 2 protects tracked checkout state and fails fast before dispatch when reset cannot be prepared.

---

## Phase 5: User Story 3 - Review And Trigger Retry From UI Or CLI (Priority: P2)

**Goal**: Expose the shared retry operation through Web API/UI and CLI with confirmation, authorization, loading, and clear feedback.

**Independent Test**: Retry a web-created failed run from the Web UI and a CLI-created failed run through `archon workflow retry-node <run-id> <node-id>`, verifying dispatch and user-facing output.

### Tests for User Story 3

- [ ] T058 [P] [US3] Add API success, 400, 401, 403, 404, and 409 route tests in `packages/server/src/routes/api.workflow-runs.test.ts`
- [ ] T059 [P] [US3] Add Web-created versus CLI-created retry eligibility route tests in `packages/server/src/routes/api.workflow-runs.test.ts`
- [ ] T060 [P] [US3] Add CLI path verification and `--json` rejection tests in `packages/cli/src/commands/workflow.test.ts`
- [ ] T061 [P] [US3] Add Web retry eligibility and API wrapper tests in `packages/web/src/lib/workflow-retry.test.ts`
- [ ] T062 [P] [US3] Add retry confirmation/loading/error UI tests in `packages/web/src/components/workflows/WorkflowNodeRetryAction.test.tsx`

### Implementation for User Story 3

- [ ] T063 [US3] Add retry request/response OpenAPI schemas in `packages/server/src/routes/schemas/workflow.schemas.ts`
- [ ] T064 [US3] Register `POST /api/workflows/runs/{runId}/nodes/{nodeId}/retry` with `registerOpenApiRoute(createRoute(...), handler)` in `packages/server/src/routes/api.ts`
- [ ] T065 [US3] Resolve Web auth requester and run owner/admin authorization before mutation in `packages/server/src/routes/api.ts`
- [ ] T066 [US3] Reject Web retry for CLI-created or non-web parent conversations with actionable CLI text in `packages/server/src/routes/api.ts`
- [ ] T067 [US3] Dispatch retry-specific Web execution using the prepared run instead of `/workflow run` resume lookup in `packages/server/src/routes/api.ts`
- [ ] T068 [US3] Add `workflow retry-node <run-id> <node-id>` parser/help branch in `packages/cli/src/cli.ts`
- [ ] T069 [US3] Implement CLI retry-node command, streamed execution, and human output in `packages/cli/src/commands/workflow.ts`
- [ ] T070 [US3] Verify CLI working path identity against codebase/worktree contracts before mutation in `packages/cli/src/commands/workflow.ts`
- [ ] T071 [US3] Add `retryWorkflowNode(runId, nodeId)` API wrapper in `packages/web/src/lib/api.ts`
- [ ] T072 [US3] Regenerate frontend OpenAPI declarations in `packages/web/src/lib/api.generated.d.ts`
- [ ] T073 [US3] Add pure Web retry eligibility helpers in `packages/web/src/lib/workflow-retry.ts`
- [ ] T074 [US3] Render retry action for eligible failed nodes in `packages/web/src/components/workflows/WorkflowExecution.tsx`
- [ ] T075 [US3] Add confirmation dialog copy covering tracked reset, safety ref/commit, untracked preservation, and rerun scope in `packages/web/src/components/workflows/WorkflowNodeRetryAction.tsx`
- [ ] T076 [US3] Invalidate/refetch run and dashboard queries after successful retry in `packages/web/src/components/workflows/WorkflowNodeRetryAction.tsx`

**Checkpoint**: User Story 3 is usable from Web and CLI and all mutation paths call the shared retry preparation operation.

---

## Phase 6: User Story 4 - Preserve Audit History Across Attempts (Priority: P2)

**Goal**: Preserve old events/artifacts/logs while making the latest retry epoch authoritative for run detail, output hydration, and UI projection.

**Independent Test**: Fail a node in epoch 0, retry and complete it in epoch 1, then verify historical events remain visible, latest node state is completed, stale invalidated outputs are ignored, and epoch-qualified artifacts/logs are distinct.

### Tests for User Story 4

- [ ] T077 [P] [US4] Add epoch-aware output hydration tests in `packages/core/src/db/workflow-events.test.ts`
- [ ] T078 [P] [US4] Add run detail `nodeStates` projection tests in `packages/server/src/routes/api.workflow-runs.test.ts`
- [ ] T079 [P] [US4] Add retry epoch artifact path tests in `packages/workflows/src/artifacts-index.test.ts`
- [ ] T080 [P] [US4] Add dashboard retry-event refetch tests in `packages/server/src/adapters/web/dashboard-event-poller.test.ts`
- [ ] T081 [P] [US4] Add experimental console retry projection tests in `packages/web/src/experiments/console/primitives/event.test.ts`
- [ ] T082 [P] [US4] Add cleanup warning/non-blocking tests for retry refs in `packages/core/src/services/cleanup-service.test.ts`

### Implementation for User Story 4

- [ ] T083 [US4] Include `retry_epoch` in node lifecycle event data during retry execution in `packages/workflows/src/dag-executor.ts`
- [ ] T084 [US4] Write epoch `1+` node artifacts under `nodes/epoch-<N>/<nodeId>.*` in `packages/workflows/src/dag-executor.ts`
- [ ] T085 [US4] Add server-derived `nodeStates` to run detail responses in `packages/server/src/routes/api.ts`
- [ ] T086 [US4] Update Web run graph/detail rendering to prefer server-derived `nodeStates` in `packages/web/src/components/workflows/WorkflowExecution.tsx`
- [ ] T087 [US4] Update experimental console event projection for `node_retry_*` setup events in `packages/web/src/experiments/console/primitives/event.ts`
- [ ] T088 [US4] Map retry events to existing `workflow_status` refetch triggers in `packages/server/src/adapters/web/workflow-bridge.ts`
- [ ] T089 [US4] Include retry events in dashboard poller whitelist/refetch mapping in `packages/server/src/adapters/web/dashboard-event-poller.ts`
- [ ] T090 [US4] Add checkpoint/safety ref cleanup by run prefix during run deletion in `packages/core/src/db/workflows.ts`
- [ ] T091 [US4] Add checkpoint/safety ref cleanup by run prefix during old-run cleanup in `packages/core/src/services/cleanup-service.ts`
- [ ] T092 [US4] Keep raw historical events unchanged while using latest epoch for current status in `packages/core/src/db/workflow-events.ts`

**Checkpoint**: User Story 4 preserves audit history and prevents old attempt state from corrupting current run state.

---

## Final Phase: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, generated artifacts, and validation after the desired stories are complete.

- [ ] T093 [P] Update CLI help/reference text for retry-node in `packages/core/src/orchestrator/prompt-builder.ts`
- [ ] T094 [P] Update workflow docs for manual retry behavior in `packages/docs-web/src/content/docs/book/dag-workflows.md`
- [ ] T095 [P] Add quickstart scenario notes to `specs/001-manual-node-retry-decisions/quickstart.md`
- [ ] T096 Run focused package tests listed in `specs/001-manual-node-retry-decisions/quickstart.md`
- [ ] T097 Run `bun run validate` using root `package.json` and fix failures in touched package files

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup tests.
- **User Story 1 (Phase 3)**: Depends on Foundational.
- **User Story 2 (Phase 4)**: Depends on Foundational.
- **User Story 3 (Phase 5)**: Depends on User Story 1 and User Story 2 because both surfaces call the shared retry operation and must explain git side effects.
- **User Story 4 (Phase 6)**: Depends on User Story 1 for retry epochs and User Story 2 for artifact/checkpoint history.
- **Polish (Final Phase)**: Depends on all implemented user stories.

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational. Use `mutates_checkout: false` fixtures to validate retry scope independently from git reset.
- **US2 (P1)**: Can start after Foundational. Git checkpoint/reset can be tested independently with temp repositories and mocked workflow runs.
- **US3 (P2)**: Requires US1 and US2 shared operation semantics before exposing Web/CLI controls.
- **US4 (P2)**: Requires retry epochs/events from US1 and checkpoint/artifact behavior from US2.

### Within Each User Story

- Write and run the story tests first; confirm they fail for the missing behavior.
- Implement storage/contracts before callers.
- Implement shared core/workflow behavior before Web/CLI surfaces.
- Keep Web display logic secondary to server-derived retry eligibility and node state.

---

## Parallel Execution Examples

### User Story 1

```bash
Task: "Add parallel sibling preservation retry test in packages/workflows/src/retry-state.test.ts"
Task: "Add invalidated persisted-session deletion test in packages/core/src/db/workflow-node-sessions.test.ts"
Task: "Add retry execution handoff test for prepared runs in packages/workflows/src/executor-preamble.test.ts"
```

### User Story 2

```bash
Task: "Add tracked-dirty checkpoint commit test excluding untracked files in packages/git/src/git.test.ts"
Task: "Add checkpoint lookup fallback test for target and first upstream dependency in packages/core/src/db/workflow-checkpoints.test.ts"
Task: "Add DAG pre-node checkpoint test for executable node kinds in packages/workflows/src/dag-executor.test.ts"
```

### User Story 3

```bash
Task: "Add API success, 400, 401, 403, 404, and 409 route tests in packages/server/src/routes/api.workflow-runs.test.ts"
Task: "Add CLI path verification and --json rejection tests in packages/cli/src/commands/workflow.test.ts"
Task: "Add Web retry eligibility and API wrapper tests in packages/web/src/lib/workflow-retry.test.ts"
```

### User Story 4

```bash
Task: "Add epoch-aware output hydration tests in packages/core/src/db/workflow-events.test.ts"
Task: "Add retry epoch artifact path tests in packages/workflows/src/artifacts-index.test.ts"
Task: "Add experimental console retry projection tests in packages/web/src/experiments/console/primitives/event.test.ts"
```

---

## Implementation Strategy

### MVP First (US1 + US2)

1. Complete Phase 1 and Phase 2.
2. Complete Phase 3 for scoped failed-node retry without Web/CLI UI.
3. Complete Phase 4 for checkpoint/reset safety.
4. Stop and validate the P1 quickstart scenarios.

### Incremental Delivery

1. Deliver US1 + US2 as the core safe retry operation.
2. Add US3 to expose the operation through Web and CLI.
3. Add US4 to harden audit/history projection and cleanup.
4. Run focused package tests after each story, then `bun run validate` before PR.

### Validation Commands

```bash
bun test packages/workflows/src/dag-executor.test.ts
bun test packages/workflows/src/executor.test.ts
bun test packages/core/src/db/workflow-events.test.ts
bun test packages/core/src/db/workflows.resume-cas.integration.test.ts
bun test packages/server/src/routes/api.workflow-runs.test.ts
bun test packages/cli/src/commands/workflow.test.ts
bun test packages/web/src/lib/ packages/web/src/components/
bun run validate
```

---

## Notes

- [P] tasks touch different files and can run in parallel after their phase dependencies are met.
- Every task maps back to `specs/001-manual-node-retry-decisions/spec.md`, `plan.md`, or `contracts/`.
- Use `execFileAsync` or `@archon/git` helpers for git calls; never run `git clean`.
- Do not add retry support to the native `manage_run` AI tool in v1.
- Web UI visibility is convenience only; server authorization remains authoritative.
