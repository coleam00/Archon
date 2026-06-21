# Feature Specification: Manual Failed-Node Retry Decisions

**Feature Branch**: `001-manual-node-retry-decisions`  
**Created**: 2026-06-21  
**Status**: Draft  
**Input**: User description: "Read requirement in `plans/grill-me/260621-1239-manual-node-retry-decisions.md`, link that file as reference so next phase knows the origin grill-me decision, scout source code, and create a detailed spec."  
**Origin Reference**: [plans/grill-me/260621-1239-manual-node-retry-decisions.md](../../plans/grill-me/260621-1239-manual-node-retry-decisions.md)

## Source Context

This spec is grounded in the current repository behavior, not inferred from a generic workflow engine.

- DAG execution lives in `packages/workflows/src/dag-executor.ts`. It builds topological layers and runs independent nodes in a layer concurrently (`buildTopologicalLayers`, `Promise.allSettled`), then derives final run success or failure from accumulated node outputs.
- Existing node retry is automatic and in-process. `getEffectiveNodeRetryConfig()` currently defaults to two transient retries with a 3000 ms base delay, and the retry loop is applied around AI command/prompt execution. This feature is separate manual retry after a failed run.
- Run resume is currently run-level. `hydrateResumableRun()` in `packages/workflows/src/executor.ts` reads prior completed node outputs, then `resumeWorkflowRun()` compare-and-swaps a failed/paused run to `running`.
- Completed DAG outputs are reconstructed from `remote_agent_workflow_events` in `packages/core/src/db/workflow-events.ts`; current logic reads `node_completed` and `node_skipped_prior_success` events without retry-epoch filtering.
- Run status values are `pending`, `running`, `completed`, `failed`, `cancelled`, and `paused` in `packages/workflows/src/schemas/workflow-run.ts`. Node output states are `pending`, `running`, `completed`, `failed`, and `skipped`.
- Workflow events are a closed TypeScript union in `packages/workflows/src/store.ts`, even though the DB column can store arbitrary event strings. New retry events must be added to schemas, bridge code, poller whitelists, and generated API types.
- Existing approval/rejection flows are approval-gate-specific. Manual retry must not overload approval metadata or approval endpoints.
- The Web resume endpoint dispatches `/workflow run <name> <message>` back into the parent web conversation and depends on current resumable-run lookup finding a failed/paused run. Because this feature requires retry setup to CAS `failed -> running` before dispatch, implementation needs a retry-specific handoff to `executeWorkflow` or a retry-aware hydration path; it must not assume existing foreground resume detection will find a run already moved to `running`.

## Clarifications

### Session 2026-06-21

- Q: When a run has multiple latest failed nodes, including a failed downstream node whose ancestor also failed, which failed nodes are eligible retry targets? → A: Any node whose latest effective status is `failed` is eligible, even if an upstream dependency also failed.
- Q: Where should `retry_epoch` be stored for workflow lifecycle events? → A: Store `retry_epoch` in `remote_agent_workflow_events.data` JSON for lifecycle and retry events.
- Q: What canonical local git ref namespace should checkpoints and retry safety refs use? → A: Checkpoints use `refs/archon/checkpoints/<runId>/<retryEpoch>/<nodeId>`; safety refs use `refs/archon/retry-safety/<runId>/<retryEpoch>`.
- Q: When should the run status CAS from `failed` to `running` happen relative to retry reset/setup? → A: CAS and increment epoch at the start of accepted setup, then restore status to `failed` if setup/reset fails.
- Q: When checkpointing or retry-safety committing a dirty checkout, which files should be committed? → A: Commit tracked dirty changes only; leave untracked and ignored files untouched.
- Q: How should invalidated target/downstream nodes appear after retry is accepted but before their new lifecycle events arrive? → A: Run detail/API/UI projection marks invalidated nodes `pending` in the latest retry epoch until new lifecycle events arrive.
- Q: Which retry events should trigger live Web UI refetches through SSE/dashboard polling? → A: Map retry events to existing `workflow_status` refetch triggers; keep node graph changes driven by run-detail projection and lifecycle events.
- Q: How should retry epochs distinguish old and new node artifacts/logs for the same run and node id? → A: Use epoch-qualified paths for retry epochs, e.g. `nodes/epoch-<N>/<nodeId>.*`, while leaving epoch 0 paths unchanged.
- Q: When deleting or cleaning up a workflow run, should cleanup remove retry safety refs as well as checkpoint refs? → A: Cleanup deletes both checkpoint refs and retry safety refs under the run id prefix.
- Q: Should clean-checkout checkpoints create a named checkpoint ref, or store only the current commit SHA? → A: Always create a checkpoint ref for each executable node checkpoint, even when the checkout is clean.

## User Scenarios & Testing

### User Story 1 - Retry A Failed DAG Node (Priority: P1)

As a workflow user, I can retry one failed DAG node after a workflow run fails, so I can rerun only the failed node and downstream dependent nodes without losing successful upstream work.

**Why this priority**: This is the core user value from the origin requirement. Without scoped retry, users must rerun an entire workflow or manually recover work.

**Independent Test**: Create a DAG `A -> B -> C` where `A` succeeds, `B` fails, and `C` is skipped. Retry `B`. Verify the same run row is reused, `A` is not rerun, `B` and `C` run again, and the run becomes `completed` if both succeed.

**Acceptance Scenarios**:

1. **Given** a failed workflow run with node `B` in status `failed`, **When** the user retries node `B`, **Then** the system increments the run retry epoch, invalidates `B` and all descendants, preserves completed upstream outputs, and dispatches the same workflow run to continue.
2. **Given** a parallel layer containing independent siblings `B1` and `B2`, where only `B1` failed, **When** the user retries `B1`, **Then** `B2` remains valid unless it depends on `B1`.
3. **Given** a downstream node was skipped because its dependency failed, **When** the run is failed, **Then** that downstream skipped node does not expose its own retry action.

---

### User Story 2 - Restore Checkout State Safely Before Retry (Priority: P1)

As a workflow user, I can trust manual retry to reset tracked files to the right pre-node checkpoint while preserving a recoverable safety reference for the failed attempt.

**Why this priority**: Manual retry can be destructive without a clear checkpoint and safety model. The origin requirement explicitly accepts local checkpoint commits and branch rewrites for v1, but requires recoverability.

**Independent Test**: Run a mutating workflow where a node changes tracked files and then fails. Retry the failed node. Verify a safety ref points to the failed attempt, the checkout resets to the node checkpoint, untracked/ignored files are not deleted by reset, and execution continues only after reset succeeds.

**Acceptance Scenarios**:

1. **Given** a mutating workflow node is about to execute in a clean checkout, **When** checkpointing runs, **Then** the checkpoint records the current `HEAD` without creating a commit.
2. **Given** a mutating workflow node is about to execute in a dirty checkout, **When** checkpointing runs, **Then** the system commits dirty changes with the required checkpoint message and records that commit.
3. **Given** reset to a checkpoint fails validation or `git reset --hard` fails, **When** the user requests retry, **Then** retry setup fails fast, the run remains `failed`, and no executor dispatch occurs.

---

### User Story 3 - Review And Trigger Retry From UI Or CLI (Priority: P2)

As a user working from Web UI or CLI, I can trigger the same node-level retry operation from my surface, with confirmation and clear feedback about git side effects.

**Why this priority**: The feature must be usable from the same run-management surfaces that already expose resume, approve, reject, abandon, and delete.

**Independent Test**: For a web-created failed run, click a retry action on the failed node, confirm, and observe the run refetch and continue. For a CLI-created failed run, run `archon workflow retry-node <run-id> <node-id>` and observe streamed retry execution.

**Acceptance Scenarios**:

1. **Given** a web-created failed run with a failed node, **When** the user clicks Retry on that node, **Then** a confirmation dialog explains tracked-file reset, safety ref/commit, untracked-file behavior, and target/downstream rerun scope before dispatch.
2. **Given** a CLI-created failed run, **When** the user opens the Web UI, **Then** the Web UI does not retry it and directs the user to the CLI retry command.
3. **Given** retry setup succeeds via API, **When** the API returns, **Then** the UI disables/loading state clears through refetch or live events and the run's latest status is shown.

---

### User Story 4 - Preserve Audit History Across Attempts (Priority: P2)

As an operator, I can inspect old failed attempts, retry attempts, checkpoints, and final status without old events corrupting the latest run state.

**Why this priority**: The existing system is event-sourced for node state and output hydration. Manual retry reuses the same run row, so epoch separation is required for correctness.

**Independent Test**: Run a DAG where a node fails in epoch 0, then succeeds in epoch 1. Verify events from both epochs remain visible, output hydration ignores invalidated epoch 0 outputs, and the final run status is `completed`.

**Acceptance Scenarios**:

1. **Given** old failed events exist for a node, **When** a later retry epoch completes that node, **Then** the run detail and graph show the latest epoch result as authoritative.
2. **Given** old artifacts/logs exist from failed attempts, **When** retry succeeds, **Then** the artifacts/logs remain available and are distinguished by retry epoch where applicable.
3. **Given** completed output exists from an invalidated downstream node in an old epoch, **When** retry runs, **Then** downstream prompt substitution and `when:` evaluation do not use that stale output.

### Edge Cases

- Target node no longer exists in the current workflow definition: return a clear error and leave the run `failed`.
- Current workflow definition has changed so old downstream nodes are absent: use current-DAG descendants for invalidation and warn when useful.
- Target node is the first node: use its checkpoint row if present, including a row pointing at `HEAD`; otherwise fallback is tracked reset to current `HEAD`.
- Target node has multiple upstream dependencies and no checkpoint row: fallback to the checkpoint for `depends_on[0]`.
- Target workflow has `mutates_checkout: false`: allow manual retry without checkout reset when no checkpoint exists.
- Repo is not a git repo: retry setup errors immediately.
- Git identity is missing and a required checkpoint or safety commit is needed: fail fast with clear `git config user.name` / `git config user.email` guidance.
- Checkpoint ref/SHA validation fails: write `node_retry_failed`, leave run `failed`, and do not dispatch.
- Dirty checkout before retry reset: create/update the retry safety ref first, committing dirty changes if needed.
- Parallel layer has multiple executable nodes that can mutate checkout: emit a warning because checkpoint commits clean the tree between nodes and parallel mutation can be ambiguous.
- Existing YAML automatic retry still runs when retried nodes execute; manual retry must not change auto retry behavior.

## Requirements

### Retry Eligibility And Scope

- **FR-001**: System MUST expose manual retry only for DAG nodes whose latest effective node status is `failed`, including failed nodes whose ancestor also has latest effective status `failed`.
- **FR-002**: System MUST expose manual retry only when the containing workflow run status is `failed`.
- **FR-003**: System MUST NOT expose manual retry when the run status is `pending`, `running`, `paused`, `completed`, or `cancelled`.
- **FR-004**: System MUST NOT expose a retry action on downstream `skipped` nodes; users retry the failed ancestor instead.
- **FR-005**: System MUST reuse the existing `workflow_runs` row for manual retry and MUST NOT create a linked replacement run.
- **FR-006**: System MUST compute invalidated nodes as the retry target plus all descendants in the current workflow DAG.
- **FR-007**: System MUST preserve completed outputs from upstream nodes that are not in the invalidated set.
- **FR-008**: System MUST preserve independent sibling nodes unless they depend on the retry target.
- **FR-009**: System MUST treat `always_run` as having no special manual retry behavior; the manual invalidation set decides rerun scope.
- **FR-010**: System MUST reject retry if the current workflow definition cannot be loaded or no longer contains the target node.
- **FR-011**: System SHOULD warn if the current DAG no longer contains previously observed downstream nodes, but MUST still use the current DAG as v1 source of truth.

### Retry Epochs And Event-Sourced State

- **FR-012**: System MUST store a numeric retry epoch in `workflow_runs.metadata.retry_epoch`.
- **FR-013**: System MUST treat missing `retry_epoch` values on existing events as epoch `0`.
- **FR-014**: System MUST increment `workflow_runs.metadata.retry_epoch` exactly once per accepted manual retry request.
- **FR-015**: System MUST write `node_retry_requested`, `node_retry_reset`, and `node_retry_failed` event types where applicable.
- **FR-016**: `node_retry_requested` MUST record `runId`, target node id, next retry epoch, invalidated node ids, requester surface, authenticated requester user id when available, and the authorization basis used for the accepted retry (for example owner, admin, CLI/solo). If Web/API retry requires an authenticated requester and none can be resolved, the request MUST fail before writing `node_retry_requested` or mutating state; unauthenticated solo/local mode MUST record requester identity explicitly as unavailable.
- **FR-017**: `node_retry_reset` MUST record target node id, retry epoch, checkpoint ref/SHA used, safety ref, safety commit SHA when created, and whether checkout reset was skipped.
- **FR-018**: `node_retry_failed` MUST record target node id, retry epoch, setup phase, and failure message.
- **FR-019**: Node lifecycle events emitted during a retry epoch SHOULD include `retry_epoch` in the event `data` JSON so UI and API consumers can derive latest effective node state without deleting historical rows.
- **FR-020**: Completed-output hydration for retry MUST ignore prior outputs from invalidated nodes in earlier epochs.
- **FR-021**: Completed-output hydration for retry MUST allow non-invalidated upstream outputs from earlier epochs.
- **FR-022**: The run detail API and Web UI MUST derive node state by retry epoch so later retry completion can override older failed/skipped events, and invalidated nodes project as `pending` in the active retry epoch until they emit a new lifecycle event.
- **FR-023**: Old workflow events, artifacts, and logs MUST NOT be deleted as part of manual retry. Retry epoch `1+` artifacts/logs MUST use epoch-qualified relative paths such as `nodes/epoch-<N>/<nodeId>.*` while epoch `0` paths remain unchanged.
- **FR-024**: If a retry eventually succeeds, the reused run row status MUST become `completed`; the final row status wins over older failed events.

### Checkpoint Creation

- **FR-025**: System MUST create a dedicated database table for node checkpoints rather than storing checkpoint state only in workflow events or run metadata.
- **FR-026**: The checkpoint table MUST have a unique key on `(workflow_run_id, node_id, retry_epoch)`.
- **FR-027**: The checkpoint table MUST store at least `workflow_run_id`, `node_id`, `retry_epoch`, `checkpoint_ref`, `commit_sha`, `created_commit`, `fallback_from_node_id`, and `created_at`. Checkpoint refs MUST use `refs/archon/checkpoints/<runId>/<retryEpoch>/<nodeId>`.
- **FR-028**: Checkpoint rows MUST be represented in TypeScript with Zod schemas following repository conventions: import `z` from `@hono/zod-openapi`, derive types using `z.infer`, and place core row schemas under `packages/core/src/schemas/`.
- **FR-029**: Checkpoint storage MUST be implemented for SQLite and PostgreSQL, including `migrations/000_combined.sql`, SQLite adapter initialization, and bundled schema generation.
- **FR-030**: For workflows where `mutates_checkout !== false`, checkpointing MUST be enabled by default with no new v1 config flag.
- **FR-031**: For workflows where `mutates_checkout: false`, checkpointing MUST be skipped by default.
- **FR-032**: System MUST create checkpoints only for nodes that will actually execute, after trigger-rule and `when:` checks pass.
- **FR-033**: System MUST NOT create checkpoints for skipped nodes.
- **FR-034**: System MUST checkpoint command, prompt, bash, script, and loop nodes.
- **FR-035**: System MUST NOT checkpoint approval or cancel nodes.
- **FR-036**: If checkpoint creation fails before a node executes, the node/workflow MUST fail clearly and the node MUST NOT run.
- **FR-037**: Checkpoint commit messages MUST NOT include the user prompt.
- **FR-038**: Node checkpoint commit messages MUST use exactly:

```text
archon checkpoint: <workflowName>/<nodeId>

Run: <runId>
Epoch: <retryEpoch>
Node: <nodeId>
```

- **FR-039**: If the checkout has tracked dirty changes before node start, system MUST commit tracked dirty changes only and store that commit as the node checkpoint; untracked and ignored files MUST remain untouched.
- **FR-040**: If the checkout is clean before node start, system MUST create or update the namespaced checkpoint ref at current `HEAD`, store both `checkpoint_ref` and `commit_sha`, and set `created_commit: false`.
- **FR-041**: Checkpoint commits and refs MUST stay local-only and MUST NOT be pushed.
- **FR-042**: Checkpoint commits MUST NOT be emitted as workflow artifacts.
- **FR-043**: Checkpoint commits MUST NOT be rewritten, squashed, dropped, or hidden automatically after workflow success.

### Retry Reset And Safety

- **FR-044**: Before manual retry reset, system MUST create or update `refs/archon/retry-safety/<runId>/<retryEpoch>` for current `HEAD`.
- **FR-045**: If checkout has tracked dirty changes before manual retry reset, system MUST commit tracked dirty changes first and point the safety ref at that safety commit; untracked and ignored files MUST remain untouched.
- **FR-046**: Manual retry safety commit messages MUST use exactly:

```text
archon retry safety: <workflowName>

Run: <runId>
Epoch: <nextRetryEpoch>
Retry node: <nodeId>
```

- **FR-046A**: Every generated checkpoint or retry safety ref MUST be validated with `git check-ref-format` before create, update, validation, or reset operations. `runId` and `retryEpoch` MUST come from canonical persisted values, and workflow-controlled values such as node ids MUST NOT be allowed to produce invalid refs; if a generated ref is invalid, checkpoint/retry setup MUST fail before git mutation. Workflow names and node ids embedded in checkpoint or retry-safety commit messages MUST be normalized to single-line audit text by replacing control characters and newlines with spaces, without changing the stored logical workflow name or node id.
- **FR-047**: Retry reset MUST use the latest prior checkpoint for the target node when present.
- **FR-048**: If the target node has no checkpoint row, reset MUST fallback to the checkpoint of its upstream node.
- **FR-049**: If multiple upstream nodes exist, reset fallback MUST use the first dependency in `depends_on`.
- **FR-050**: If no target or upstream checkpoint exists, reset fallback MUST be `git reset --hard` to current `HEAD`.
- **FR-051**: If the target is the first node and has a checkpoint row pointing to `HEAD`, system MUST use that row rather than the empty fallback.
- **FR-052**: System MUST validate checkpoint refs and SHAs with `git rev-parse --verify <ref-or-sha>^{commit}` before reset.
- **FR-053**: If checkpoint validation fails, retry setup MUST fail, `node_retry_failed` MUST be written, and the run MUST remain `failed`.
- **FR-054**: Reset failures MUST fail fast; system MUST NOT dispatch or resume executor after a failed checkout reset.
- **FR-055**: If git identity is missing and a checkpoint or safety commit fails, system MUST fail with clear git config guidance and MUST NOT fallback to stash.
- **FR-056**: Manual retry v1 MUST reset tracked files only and MUST NOT run `git clean`.
- **FR-057**: Manual retry v1 MUST NOT delete untracked or ignored files during reset.
- **FR-058**: Retry MAY rewrite the local branch tip back to the selected checkpoint.
- **FR-059**: Failed-attempt commits MUST remain recoverable through safety refs.
- **FR-060**: Creating checkpoint commits makes the tree clean between nodes; v1 workflows MUST NOT rely on inter-node changes remaining uncommitted.
- **FR-061**: If the repository is not a git repository, manual retry setup MUST error immediately.

### Execution Behavior

- **FR-062**: Manual retry MUST be separate from existing YAML automatic retry.
- **FR-063**: Manual retry MUST NOT change existing automatic retry behavior.
- **FR-064**: When a manually retried node executes, it MUST still honor its existing YAML `retry` config.
- **FR-065**: Checkpoint/reset behavior MUST apply only to manual retry and pre-node checkpointing, not to automatic retry attempts inside one node execution.
- **FR-066**: The executor MUST keep current parallel DAG execution behavior.
- **FR-067**: System SHOULD emit a warning when a topological layer contains multiple executable nodes that can mutate checkout.
- **FR-068**: Manual retry MUST support both Archon-managed worktrees and `--no-worktree` live checkouts.
- **FR-069**: Retry setup MUST use `@archon/git` helpers where available and `execFileAsync` rather than shell `exec` for direct git calls.
- **FR-070**: System MUST NOT run `git clean -fd` or equivalent destructive untracked cleanup.

### Persisted AI Session State

- **FR-071**: Manual retry MUST delete persisted workflow node session rows for the target node and all invalidated descendants.
- **FR-072**: Session deletion MUST apply to all providers for the run's workflow name and scope key.
- **FR-073**: Scope key SHOULD match existing persisted-session behavior, typically the run's conversation UUID.
- **FR-074**: Retried AI nodes MUST run fresh rather than carrying failed-attempt persisted session memory.

### API

- **FR-075**: System MUST add a node-level retry API endpoint conceptually equivalent to `POST /api/workflows/runs/:runId/nodes/:nodeId/retry`.
- **FR-076**: The API route MUST be registered with `registerOpenApiRoute(createRoute({...}), handler)` and route schemas MUST live in `packages/server/src/routes/schemas/`.
- **FR-077**: The OpenAPI path MUST use repository route syntax with `{runId}` and `{nodeId}` parameters.
- **FR-078**: API retry MUST validate run existence, target node existence, latest effective node status, run status, web retry eligibility, and requester authorization before mutating state. Authorization MUST resolve the authenticated web requester using the existing API auth context; when a run has `user_id`, the requester MUST match that user or have `admin` role. Runs without `user_id` remain retryable only in unauthenticated solo/local mode. This check MUST occur before the status CAS, retry epoch increment, safety ref/commit, checkout reset, session deletion, or executor dispatch.
- **FR-079**: API retry MUST use compare-and-swap from `failed` to `running` at the start of accepted retry setup; if the status changed, API MUST return an error rather than double-dispatching, and if setup/reset later fails the same run MUST be restored to `failed`.
- **FR-080**: API retry MUST prepare retry state, safety ref/commit, checkout reset, invalidation metadata, session deletion, and checkpoint lookup before dispatching execution.
- **FR-081**: API retry dispatch MUST be asynchronous like current web resume behavior.
- **FR-082**: Because current foreground resume detection finds only failed/paused runs, implementation MUST provide a retry-specific execution handoff after the `failed -> running` CAS. It MUST NOT rely on existing `/workflow run` resume lookup to find a run already set to `running`.
- **FR-083**: API retry response MUST include `success`, `message`, `runId`, `nodeId`, `retryEpoch`, `invalidatedNodes`, and optional `safetyCommitSha`.
- **FR-084**: Web API retry MUST support web-created runs with a parent web conversation.
- **FR-085**: Web API retry MUST reject CLI-created runs with actionable text directing users to `archon workflow retry-node <run-id> <node-id>`.
- **FR-086**: API retry MUST reject runs whose parent conversation is non-web for web dispatch, matching the current cross-adapter guard used by approval auto-resume.

### CLI

- **FR-087**: CLI MUST add `workflow retry-node <run-id> <node-id>`.
- **FR-088**: CLI retry-node MUST stream output to the terminal like `workflow resume`.
- **FR-089**: CLI retry-node MUST NOT support `--json` in v1.
- **FR-090**: CLI retry-node MUST reuse the run's recorded working path, resolve it to a canonical real path, verify it still exists, and verify it still identifies the run's intended repository or Archon-managed worktree before any safety ref, commit, reset, session deletion, or dispatch. Verification MUST use available local contracts: the run's `codebase_id`, the registered codebase `default_cwd` and `repository_url` when present, and any matching isolation environment `working_path` for Archon-managed worktrees. If the path cannot be verified, CLI retry-node MUST fail clearly and MUST NOT mutate git state.
- **FR-091**: CLI retry-node MUST use the same retry preparation and invalidation logic as the API path.
- **FR-092**: CLI-created runs MUST be retried via CLI in v1, not via Web UI.
- **FR-093**: Manual retry MUST NOT be added to the native `manage_run` AI tool in v1.

### Web UI

- **FR-094**: Web UI MUST show a retry button only on failed nodes whose containing run is failed and web-retry-eligible.
- **FR-095**: Web UI MUST NOT show retry on skipped downstream nodes.
- **FR-096**: Web UI MUST require a confirmation dialog before retry.
- **FR-097**: Confirmation copy MUST mention: tracked files reset to checkpoint, dirty changes are auto-committed to a safety ref first, untracked/ignored files are not deleted, and target/downstream nodes rerun.
- **FR-098**: Retry button MUST show loading/disabled state while the request is in flight.
- **FR-099**: After successful API response, UI MUST invalidate/refetch the workflow run query.
- **FR-100**: If API returns an error, UI MUST show the error and leave run status `failed`.
- **FR-101**: Web node-state derivation MUST account for retry epochs so older failed events do not override later retry success.
- **FR-102**: Web API client wrappers MUST be added in `packages/web/src/lib/api.ts`, and generated OpenAPI types MUST be refreshed.
- **FR-103**: SSE bridge and dashboard event poller whitelists MUST include retry-relevant events as existing `workflow_status` refetch triggers: `node_retry_requested` and `node_retry_reset` map to a running status refresh, and `node_retry_failed` maps to a failed status refresh.

### Cleanup

- **FR-104**: Cleanup MUST delete checkpoint refs and retry safety refs by run prefix when deleting one workflow run or cleaning old workflow runs.
- **FR-105**: Cleanup MUST delete checkpoint table rows through normal workflow-run foreign key behavior or explicit cleanup.
- **FR-106**: Cleanup failures for checkpoint refs or retry safety refs MUST log a warning and MUST NOT break database cleanup.

## Key Entities

- **Retry Epoch**: Numeric attempt generation for one reused workflow run. Epoch `0` is the original run. Each accepted manual retry increments the epoch.
- **Invalidated Node Set**: Target node plus all current-DAG descendants. Outputs and persisted sessions for these nodes are not reused for the retry.
- **Node Checkpoint**: Persistent record of the checkout state immediately before an executable node starts. Keyed by workflow run, node id, and retry epoch, with checkpoint refs stored under `refs/archon/checkpoints/<runId>/<retryEpoch>/<nodeId>`.
- **Retry Safety Ref**: Local git ref under `refs/archon/retry-safety/<runId>/<retryEpoch>` preserving the branch tip, and tracked dirty state if committed, immediately before reset for manual retry.
- **Retry Request Event**: Workflow event recording who/what requested retry, the target node, retry epoch, and invalidated nodes.
- **Retry Reset Event**: Workflow event recording the checkpoint and safety ref used by retry setup.
- **Retry Failure Event**: Workflow event recording setup/reset failure that prevents dispatch.
- **Epoch-Aware Node Projection**: API/UI derivation of latest effective node status from historical workflow events, using retry epoch as an attempt boundary.

## Non-Goals And Accepted Tradeoffs

- v1 does not add a UI checkpoint info panel.
- v1 does not push checkpoint refs.
- v1 does not rewrite, squash, or remove checkpoint commits after success.
- v1 accepts checkpoint commits appearing in local branch history and possible PR history.
- v1 commits and resets tracked files only and accepts that untracked/ignored leftovers may remain.
- v1 uses the current workflow definition for descendant calculation.
- v1 does not add a new workflow config flag for checkpointing.
- v1 does not add retry-node support to the native `manage_run` AI tool.
- v1 does not support Web retry for CLI-created runs.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A failed middle node in a three-node DAG can be retried and completed using the same workflow run id, with the upstream node not rerun.
- **SC-002**: Output hydration during retry never substitutes old outputs from invalidated nodes in earlier epochs.
- **SC-003**: A dirty checkout before retry reset is recoverable through a local safety ref/commit.
- **SC-004**: A failed checkout reset leaves the run in `failed` state and does not dispatch execution.
- **SC-005**: Web users can retry an eligible failed node with confirmation and see refreshed run state after dispatch.
- **SC-006**: CLI users can run `workflow retry-node <run-id> <node-id>` and see streamed execution output.
- **SC-007**: Old attempt events and logs remain available while the latest epoch drives current node status and final run status.
- **SC-008**: SQLite and PostgreSQL installations converge automatically with the new checkpoint schema on startup.

## Assumptions

- The workflow file available at retry time is the current source of truth for v1 DAG shape.
- Workflow node ids are stable enough across retry attempts for a user-selected failed node to be resolved.
- Checkpoint commits are acceptable local history artifacts for this single-developer tool.
- The implementation may add helper functions or a new narrow store method for retry-specific CAS/hydration rather than overloading approval or generic resume paths.
- Existing event rows without `retry_epoch` are historical epoch `0` rows.
- Existing automatic node retry remains implementation-owned behavior and is not user-visible manual retry state.

## Accepted Risks

- AR-001: Manual retry v1 accepts the current workflow definition as the source of truth for retry DAG calculation. The structural fix is to persist workflow file identity/content hash or commit SHA at run creation and define whether retry replays that recorded definition or blocks on mismatch, but that changes the v1 execution contract documented in `specs/001-manual-node-retry-decisions/spec.md:289` and `plans/grill-me/260621-1239-manual-node-retry-decisions.md:142`. Re-open this when Archon supports retry across untrusted repo writers or non-admin members, when product requires immutable replay of the original graph, or when current-DAG retry causes a confirmed integrity incident.
