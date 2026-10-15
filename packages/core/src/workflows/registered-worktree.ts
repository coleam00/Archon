import {
  classifyIsolationError,
  getIsolationProvider,
  worktreeRegistrationMetadata,
  type IIsolationStore,
  type IsolationEnvironmentRow,
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
 * Create a task worktree and register its isolation record, so `isolation list`,
 * `cleanup` and `complete` see it. Every launch path that makes a worktree outside the
 * isolation resolver goes through here.
 *
 * A provider failure is rethrown with the classified, actionable message; the git or
 * filesystem error stays on `cause`. The caller configures isolation first.
 */
export async function createRegisteredWorktree(
  isolation: Pick<IIsolationStore, 'create'>,
  input: RegisteredWorktreeInput
): Promise<RegisteredWorktree> {
  let env: WorktreeCreationEnvironment;
  try {
    env = await getIsolationProvider().create(input.request, input.setupExecutor);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(classifyIsolationError(error), { cause: error });
  }
  let record: IsolationEnvironmentRow;
  try {
    record = await isolation.create({
      codebase_id: input.request.codebaseId,
      workflow_type: 'task',
      workflow_id: input.workflowId ?? input.request.identifier,
      provider: 'worktree',
      working_path: env.workingPath,
      branch_name: env.branchName,
      created_by_platform: input.createdByPlatform,
      ...(input.createdByUserId ? { created_by_user_id: input.createdByUserId } : {}),
      metadata: { ...input.metadata, ...worktreeRegistrationMetadata(env.metadata) },
    });
  } catch (error) {
    const proof =
      env.metadata.provenance === 'created'
        ? ` creation ID: ${env.metadata.creationId}; branch created: ${String(env.metadata.branchCreated)}.`
        : '';
    throw new Error(
      `Worktree registration failed: ${error instanceof Error ? error.message : String(error)}. ` +
        `The ${env.metadata.provenance} checkout remains unregistered at ${env.workingPath} ` +
        `(branch: ${env.branchName}; repository: ${input.request.canonicalRepoPath}).${proof} ` +
        'Recover this checkout before retrying; record-based cleanup cannot find it.',
      { cause: error }
    );
  }
  const created = env.metadata.provenance === 'created' ? env.metadata : undefined;
  return {
    env,
    envId: record.id,
    ...(created ? { ownedWorktree: { envId: record.id, creationId: created.creationId } } : {}),
    ...(created?.cutFromCommit !== undefined ? { cutFromCommit: created.cutFromCommit } : {}),
  };
}
