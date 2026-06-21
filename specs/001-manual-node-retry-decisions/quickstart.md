# Quickstart: Manual Failed-Node Retry Decisions

This feature is still in planning. Use this quickstart as the implementation and validation checklist once tasks are generated.

## 1. Read The Source Artifacts

```bash
sed -n '1,260p' specs/001-manual-node-retry-decisions/spec.md
sed -n '1,260p' specs/001-manual-node-retry-decisions/plan.md
sed -n '1,260p' specs/001-manual-node-retry-decisions/research.md
```

Origin reference:

```bash
sed -n '1,220p' plans/grill-me/260621-1239-manual-node-retry-decisions.md
```

## 2. Implement In This Order

1. Storage/schema: checkpoint table, schemas, DB methods, bundled schema.
2. Projection/hydration: epoch-aware node state and completed-output filtering.
3. Git helpers: tracked-only checkpoint/safety commits, ref validation, reset.
4. Shared retry preparation operation.
5. Executor retry context and epoch-aware lifecycle/artifact writes.
6. API route and retry-specific Web dispatch.
7. CLI command.
8. Web projection, retry button, confirmation dialog, refetch behavior.
9. Cleanup of checkpoint/safety refs.

## 3. Focused Verification

Do not run root `bun test`; use package or focused commands.

```bash
bun test packages/workflows/src/dag-executor.test.ts
bun test packages/workflows/src/executor.test.ts
bun test packages/core/src/db/workflow-events.test.ts
bun test packages/core/src/db/workflows.resume-cas.integration.test.ts
bun test packages/server/src/routes/api.workflow-runs.test.ts
bun test packages/cli/src/commands/workflow.test.ts
bun test packages/web/src/lib/ packages/web/src/components/
```

## 4. Required Scenarios

Use these notes as the expected behavior across every scenario below:

- Manual retry targets one latest-effective `failed` DAG node on a `failed` run. It reuses the same run id, invalidates the target plus current-DAG descendants, preserves valid upstream and independent sibling outputs, and clears persisted node sessions for invalidated nodes.
- Web path: retry only web-created, web-dispatchable runs. The failed-node action requires confirmation that tracked files may reset to a checkpoint, dirty tracked changes are saved to a retry safety ref first, untracked/ignored files are preserved, and the selected node plus downstream dependents rerun. Success must refetch run/dashboard state; errors leave the run `failed`.
- CLI path: `archon workflow retry-node <run-id> <node-id>` streams execution like resume, rejects `--json` in v1, and verifies the recorded working path still identifies the expected repo or Archon-managed worktree before any git mutation.
- Retry epochs: each accepted retry increments `workflow_runs.metadata.retry_epoch` exactly once. Epoch `0` artifacts keep existing paths; epoch `1+` node artifacts/logs use epoch-qualified paths such as `nodes/epoch-<N>/<nodeId>.*`.
- Audit history: never delete old events, logs, or artifacts during retry. Write `node_retry_requested` after validation/CAS, `node_retry_reset` after reset setup succeeds or an allowed reset skip, and `node_retry_failed` when setup fails after acceptance. Latest epoch state drives current projection and output hydration.
- Git reset safety: checkpoint and safety refs are local-only under `refs/archon/checkpoints/<runId>/<retryEpoch>/<nodeId>` and `refs/archon/retry-safety/<runId>/<retryEpoch>`. Validate refs/commits before reset, commit tracked dirty changes only when required, and restore the run to `failed` without dispatch on setup/reset failure.
- Untracked preservation: manual retry must never run `git clean` or equivalent cleanup. Untracked and ignored files remain untouched during checkpointing, safety commits, and retry reset.

### Linear Retry

Fixture DAG: `A -> B -> C`

1. Run fails at `B`.
2. Retry `B`.
3. Verify same run id is reused.
4. Verify `A` is not rerun.
5. Verify `B` and `C` rerun.
6. Verify run becomes `completed` if both succeed.

### Parallel Sibling Preservation

Fixture DAG: `A -> B1`, `A -> B2`, `B1 -> C`

1. `B1` fails, `B2` succeeds.
2. Retry `B1`.
3. Verify `B2` output remains valid and is not rerun.

### Skipped Downstream

1. `B` fails and `C` skips because its dependency failed.
2. Verify retry action is exposed for `B`.
3. Verify retry action is not exposed for `C`.

### Git Safety

Use a local temp repository.

1. Create tracked dirty changes before a node checkpoint.
2. Verify checkpoint commit includes tracked dirty changes only.
3. Create tracked dirty changes before retry reset.
4. Retry failed node.
5. Verify safety ref exists.
6. Verify untracked and ignored files remain.
7. Verify no `git clean` or equivalent was used.

### Setup Failure

1. Corrupt or remove a checkpoint ref.
2. Retry failed node.
3. Verify `node_retry_failed` is written.
4. Verify run status is restored to `failed`.
5. Verify executor dispatch does not occur.

### Web Authorization

1. Create a run with `user_id`.
2. Retry as owner: accepted.
3. Retry as admin: accepted.
4. Retry as different non-admin user: rejected before mutation.

### CLI Path Verification

1. Retry a run whose recorded path no longer exists: fail before mutation.
2. Retry a run whose path points to a different repo after symlink/path changes: fail before mutation.
3. Retry a valid Archon-managed worktree: accepted.

## 5. Regenerate API Types

After adding the API route:

```bash
bun run dev:server
bun --filter @archon/web generate:types
```

## 6. Package Validation

```bash
bun --filter @archon/git test
bun --filter @archon/workflows test
bun --filter @archon/core test
bun --filter @archon/server test
bun --filter @archon/cli test
bun --filter @archon/web test
```

## 7. Pre-PR Validation

```bash
bun run validate
```

All validate steps must pass: bundled defaults, bundled skill, bundled schema, Pi vendor map, type-check, lint with zero warnings, format check, and package-isolated tests.
