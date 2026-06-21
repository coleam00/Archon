# Implementation Plan: Manual Failed-Node Retry Decisions

**Branch**: `001-manual-node-retry-decisions` | **Date**: 2026-06-21 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `specs/001-manual-node-retry-decisions/spec.md`

## Summary

Add manual retry for failed DAG nodes by reusing the existing workflow run row, incrementing a retry epoch, invalidating the selected failed node plus current-DAG descendants, and rerunning only that invalidated scope while preserving valid upstream and independent sibling outputs. The implementation will introduce checkpoint persistence, tracked-only git safety/checkpoint refs, epoch-aware event/output projection, a shared retry preparation operation used by Web API and CLI, and UI controls for eligible failed nodes.

The critical path is not a thin wrapper around existing run-level resume. Existing Web resume dispatches `/workflow run <name> ...` and depends on lookup of a failed/paused run; manual retry must CAS the run to `running` before dispatch, so it needs a retry-specific handoff that passes an already prepared `preCreatedRun` and filtered prior completed outputs directly into execution.

## Technical Context

**Language/Version**: Bun + TypeScript with strict TS, React/Vite frontend, Hono OpenAPI server  
**Primary Dependencies**: `@hono/zod-openapi`, `@archon/git`, `@archon/workflows`, `@archon/core`, React Query/Zustand, SQLite/PostgreSQL adapters  
**Storage**: SQLite default plus PostgreSQL via `DATABASE_URL`; schema source is `migrations/000_combined.sql`, SQLite adapter DDL, and bundled schema generation  
**Testing**: Bun package-level tests only; never root `bun test`; pre-PR command is `bun run validate`  
**Target Platform**: Local/server process controlling git worktrees or live checkouts; Web UI and CLI surfaces  
**Project Type**: Monorepo application with workflow engine, HTTP API, CLI, database layer, git helpers, and React UI  
**Performance Goals**: Retry preparation should be dominated by local git/DB operations; run-detail projection should stay linear in event count for a single run; dashboard polling should keep using a small event-type whitelist  
**Constraints**: No `any` without justification; derive Zod types with `z.infer`; route schemas live under `packages/server/src/routes/schemas/`; API routes use `registerOpenApiRoute(createRoute(...), handler)`; git calls use `@archon/git` helpers or `execFileAsync`; never run `git clean`; tracked-only reset/commit behavior; no native `manage_run` retry support in v1; Web retry only for web-created runs; CLI retry verifies recorded working path identity before mutation  
**Scale/Scope**: Single-developer tool, one workflow run and one selected node per retry request; no multi-tenant permission model beyond current user/admin owner check

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

The project constitution file is still the default placeholder and defines no concrete project-specific gates. The enforceable gates for this plan therefore come from `AGENTS.md` and the existing repo contracts:

- **Type safety**: PASS - add Zod schemas for checkpoint rows and retry API contracts; no parallel hand-written interfaces when schema-derived types are appropriate.
- **Package boundaries**: PASS - keep workflow-engine contracts in `@archon/workflows`, DB/auth/API orchestration in `@archon/core`/`@archon/server`, and browser-only state projection in `@archon/web`.
- **Git safety**: PASS - use `execFileAsync`, validate generated refs with `git check-ref-format`, commit tracked dirty changes only, preserve untracked/ignored files, and never use `git clean`.
- **Fail fast**: PASS - retry setup errors leave the run `failed`, emit `node_retry_failed`, and do not dispatch execution.
- **No autonomous lifecycle mutation across process boundaries**: PASS - retry is explicit user action and uses CAS; no timer marks ambiguous active work failed.
- **Deterministic tests**: PASS - use local temp repositories, in-memory/local DB fixtures, explicit promise hooks, and package test commands that avoid Bun `mock.module()` pollution.

Post-design re-check: PASS. The design preserves narrow interfaces, uses explicit retry-preparation state rather than broad fallback behavior, and documents the accepted v1 risk that the current workflow definition is the retry DAG source of truth.

## Project Structure

### Documentation (this feature)

```text
specs/001-manual-node-retry-decisions/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── api.md
│   ├── cli.md
│   ├── events.md
│   └── web-ui.md
├── spec.md
├── clarifications-applied-2026-06-21-221245.md
└── red-team-findings-applied-2026-06-21-222808.md
```

### Source Code (repository root)

```text
packages/workflows/src/
├── store.ts                         # Workflow event type/store contract additions
├── event-emitter.ts                 # In-process retry events for live CLI/Web streams
├── executor.ts                      # Retry-specific ExecuteWorkflowOptions handoff
├── dag-executor.ts                  # Checkpoint before executable nodes, retry epoch artifacts/events
├── schemas/                         # Retry/checkpoint-related engine schemas where needed
└── retry-state.ts                   # Pure DAG invalidation + retry projection helpers

packages/core/src/
├── schemas/workflow-checkpoint.ts   # Core row schema
├── db/workflow-checkpoints.ts       # SQLite/Postgres-neutral checkpoint queries
├── db/workflow-events.ts            # Epoch-aware completed-output hydration/projection helpers
├── db/workflows.ts                  # Retry CAS/metadata helpers and cleanup ref hook points
├── db/workflow-node-sessions.ts     # Existing deletion API reused for invalidated nodes
├── workflows/store-adapter.ts       # New IWorkflowStore methods wired to core DB
└── operations/workflow-retry.ts     # Shared retry preparation used by API and CLI

packages/git/src/
├── branch.ts or retry-refs.ts       # Tracked-only dirty commit, ref validation/update/reset helpers
└── index.ts                         # Export narrow helpers if added

packages/server/src/
├── routes/api.ts                    # Retry route + retry dispatch handoff
├── routes/schemas/workflow.schemas.ts
└── adapters/web/workflow-bridge.ts  # Retry event refetch mappings

packages/cli/src/
├── cli.ts                           # `workflow retry-node <run-id> <node-id>`
└── commands/workflow.ts             # CLI retry-node implementation

packages/web/src/
├── lib/api.ts                       # Retry API wrapper
├── lib/api.generated.d.ts           # Regenerated OpenAPI types
├── lib/workflow-retry.ts            # Pure node projection/eligibility helpers
├── components/workflows/            # Retry button and confirmation dialog
├── experiments/console/             # Epoch-aware console event/node projections
└── stores/workflow-store.ts         # Refetch/invalidation behavior if needed

migrations/
├── 000_combined.sql                 # Postgres idempotent checkpoint table
└── 0xx_workflow_node_checkpoints.sql # Numbered migration if kept in migration set
```

**Structure Decision**: Implement as a cross-package feature, but keep each package's responsibility narrow. Core owns mutation orchestration because it can see DB/auth/git/codebase contracts. Workflows owns execution semantics and pure DAG helpers without depending on core. Server and CLI are thin surfaces over the shared core operation. Web derives eligibility from API/run-detail data and never invents server-side authorization.

## Complexity Tracking

No constitution violations are required. The feature is broad because the accepted behavior crosses DB, git, executor, API, CLI, and UI boundaries, but each addition maps directly to a current requirement and has one current caller.

## Implementation Breakdown

### Phase 1 - Storage And Schemas

1. Add `remote_agent_workflow_node_checkpoints` with unique `(workflow_run_id, node_id, retry_epoch)`, FK cascade to runs, and indexes for lookup by run/node/epoch.
2. Add `packages/core/src/schemas/workflow-checkpoint.ts` and re-export from `packages/core/src/schemas/index.ts`.
3. Add `packages/core/src/db/workflow-checkpoints.ts` with create/upsert, latest prior checkpoint lookup, and delete/list helpers.
4. Update SQLite adapter DDL, `migrations/000_combined.sql`, bundled schema generation, and schema tests.
5. Extend `WORKFLOW_EVENT_TYPES` and `WorkflowEmitterEvent` with `node_retry_requested`, `node_retry_reset`, and `node_retry_failed` where live streams need those transitions.

### Phase 2 - Retry State Projection

1. Add a single epoch-aware projection helper that treats missing `retry_epoch` as `0`, applies `node_retry_requested` invalidation, and derives latest effective node status.
2. Replace or extend `getCompletedDagNodeOutputs()` so retry hydration can ignore invalidated node outputs from earlier epochs while preserving valid upstream/sibling outputs.
3. Add server-owned derived node state to the run-detail response so Web uses one authoritative projection instead of duplicating fragile raw-event folding.
4. Update CLI verbose summaries and the experimental console projections to use the same epoch semantics or server-derived projection.
5. Ensure run detail and Web projection show invalidated nodes as `pending` in the active retry epoch until new lifecycle events arrive.
6. Keep historical events/logs/artifacts visible; never delete old attempts.

### Phase 3 - Git Checkpoint And Reset Boundary

1. Add tracked-only dirty detection/commit helpers. Existing `commitAllChanges()` uses `git add -A`, so it must not be reused for checkpoint or safety commits.
2. Validate every generated ref with `git check-ref-format` before create/update/reset.
3. Normalize workflow/node names only for commit-message audit text by replacing control characters/newlines with spaces.
4. Before executable node start, create/update checkpoint refs under `refs/archon/checkpoints/<runId>/<retryEpoch>/<nodeId>` after trigger/`when:` checks pass and before the node runs.
5. During manual retry setup, create/update `refs/archon/retry-safety/<runId>/<retryEpoch>`, reset tracked files to the selected checkpoint with `git reset --hard <commit>`, and never clean untracked files.
6. Best-effort cleanup deletes checkpoint and retry safety refs by run prefix during run deletion/old-run cleanup, logging warnings without blocking DB cleanup.

### Phase 4 - Shared Retry Operation

1. Add `prepareWorkflowNodeRetry()` in `packages/core/src/operations/workflow-retry.ts`.
2. Validate run existence, status `failed`, target existence, latest effective node status `failed`, requester authorization, web/CLI surface eligibility, and working-path identity before mutation.
3. CAS `failed -> running` and increment `metadata.retry_epoch` exactly once at accepted setup start.
4. Write `node_retry_requested`, prepare safety/checkpoint reset, write `node_retry_reset`, delete persisted node sessions for invalidated nodes/all providers in the run scope, and return filtered prior completed outputs.
5. On setup failure after CAS, write `node_retry_failed`, restore status to `failed`, and do not dispatch.
6. Mandatory retry audit events must use a DB path that throws or otherwise verifies persistence; the existing `IWorkflowStore.createWorkflowEvent()` contract is intentionally non-throwing for normal lifecycle observability and is not enough for "MUST write" retry audit events.

### Phase 5 - Execution Handoff

1. Extend `ExecuteWorkflowOptions` with retry context: retry epoch, target node id, invalidated node ids, and an optional message mode so `executeWorkflow()` announces retry rather than generic resume.
2. Pass retry epoch into `executeDagWorkflow()` so node lifecycle event `data` and retry epoch artifact paths are consistent.
3. Write epoch `1+` typed output sidecars under `nodes/epoch-<N>/<nodeId>.*`; leave epoch `0` paths unchanged.
4. For Web, extract or add a dispatch helper that accepts the existing worker conversation, working path, prepared `preCreatedRun`, and filtered prior outputs. It must not create a new workflow run or rely on `/workflow run` foreground-resume lookup.
5. For CLI, execute inline like `workflow resume`, using the same prepared run state.

### Phase 6 - API, CLI, And Web

1. Add `POST /api/workflows/runs/{runId}/nodes/{nodeId}/retry` with route schemas in `packages/server/src/routes/schemas/workflow.schemas.ts`.
2. Add API response shape `{ success, message, runId, nodeId, retryEpoch, invalidatedNodes, safetyCommitSha? }`.
3. Add `archon workflow retry-node <run-id> <node-id>` and reject `--json` in v1.
4. Update CLI parser help/available-command text and verbose node summaries.
5. Add Web API wrapper and regenerate frontend OpenAPI types after server route changes.
6. Extract pure Web helpers for retry eligibility, but prefer server-derived node state for epoch projection.
7. Render retry controls only on eligible failed nodes for failed, web-retry-eligible runs. Confirmation copy must mention tracked-file reset, safety ref/commit, untracked/ignored preservation, and target/downstream rerun scope.
8. Add retry events to dashboard poller/SSE mapping as existing `workflow_status` refetch triggers.
9. Update experimental console event/node projections so `node_retry_*` events are not misclassified as skipped nodes.

## Risk Controls

- **Double dispatch**: CAS from `failed` to `running` at accepted setup start and refuse CAS misses.
- **Data loss**: tracked-only safety commits/refs before reset; no untracked cleanup; fail before dispatch on reset errors.
- **Stale outputs**: one projection/hydration helper defines epoch semantics for API, CLI, and Web.
- **Cross-user mutation**: Web API authorization resolves requester before CAS or git mutation; run owner or admin required when `run.user_id` is set.
- **Wrong repo reset**: CLI retry resolves real path and verifies codebase/worktree identity before mutation.
- **Changed workflow graph**: v1 uses current DAG; target missing is a hard error; missing old downstream nodes may warn.
- **Parallel mutation ambiguity**: keep current parallel execution but warn when a mutating workflow layer contains multiple executable nodes.

## Validation Plan

Focused commands before broader validation:

```bash
bun test packages/workflows/src/dag-executor.test.ts
bun test packages/workflows/src/executor.test.ts
bun test packages/core/src/db/workflow-events.test.ts
bun test packages/core/src/db/workflows.resume-cas.integration.test.ts
bun test packages/server/src/routes/api.workflow-runs.test.ts
bun test packages/cli/src/commands/workflow.test.ts
bun test packages/web/src/lib/ packages/web/src/components/
```

Package validation as implementation grows:

```bash
bun --filter @archon/workflows test
bun --filter @archon/core test
bun --filter @archon/server test
bun --filter @archon/cli test
bun --filter @archon/web test
```

Pre-PR:

```bash
bun run validate
```
