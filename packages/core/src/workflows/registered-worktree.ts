import {
  classifyIsolationError,
  getIsolationProvider,
  registerWorktree,
  type IIsolationStore,
  type TaskIsolationRequest,
  type WorktreeCreationEnvironment,
  type WorktreeSetupExecutor,
} from '@archon/isolation';
import type { OwnedWorktree } from '@archon/workflows/schemas/workflow-run';

export interface RegisteredWorktreeInput {
  request: TaskIsolationRequest;
  setupExecutor?: WorktreeSetupExecutor;
  /** The record's `workflow_id`; defaults to the request identifier. */
  workflowId?: string;
  createdByPlatform: string;
  createdByUserId?: string;
  /** Caller-owned record metadata; the creation provenance keys always win. */
  metadata?: Record<string, unknown>;
}

export interface RegisteredWorktree {
  env: WorktreeCreationEnvironment;
  envId: string;
  /** Present when this call created the worktree, so the run may remove it. */
  ownedWorktree?: OwnedWorktree;
  /** The commit a newly cut branch started from. */
  cutFromCommit?: string;
}

/**
 * Create a task worktree and register its isolation record. Every launch path that
 * makes a worktree outside the isolation resolver goes through here; both register
 * through `registerWorktree`, which owns the failed-insert rollback.
 *
 * A provider failure is rethrown with the classified, actionable message; the git or
 * filesystem error stays on `cause`. The caller configures isolation first.
 */
export async function createRegisteredWorktree(
  isolation: Pick<IIsolationStore, 'create' | 'listActive'>,
  input: RegisteredWorktreeInput
): Promise<RegisteredWorktree> {
  const provider = getIsolationProvider();
  const registrationsBeforeCreation = await isolation.listActive();
  let env: WorktreeCreationEnvironment;
  try {
    env = await provider.create(input.request, input.setupExecutor);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(classifyIsolationError(error), { cause: error });
  }
  const record = await registerWorktree(
    { store: isolation, provider, registrationsBeforeCreation },
    env,
    input.request.canonicalRepoPath,
    {
      codebase_id: input.request.codebaseId,
      workflow_type: 'task',
      workflow_id: input.workflowId ?? input.request.identifier,
      created_by_platform: input.createdByPlatform,
      ...(input.createdByUserId ? { created_by_user_id: input.createdByUserId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }
  );
  const created = env.metadata.provenance === 'created' ? env.metadata : undefined;
  return {
    env,
    envId: record.id,
    ...(created ? { ownedWorktree: { envId: record.id, creationId: created.creationId } } : {}),
    ...(created?.cutFromCommit !== undefined ? { cutFromCommit: created.cutFromCommit } : {}),
  };
}
