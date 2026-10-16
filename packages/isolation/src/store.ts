import { toRepoPath, toWorktreePath, verifyWorktreeOwnership } from '@archon/git';
import type { BranchName, RepoPath } from '@archon/git';
import { createLogger } from '@archon/paths';
import { worktreeRegistrationMetadata } from './types';
import type {
  IsolationEnvironmentRow,
  CreateEnvironmentParams,
  IsolationWorkflowType,
  IIsolationProvider,
  WorktreeCreationEnvironment,
} from './types';

export interface IIsolationStore {
  getById(id: string): Promise<IsolationEnvironmentRow | null>;
  findActiveByWorkflow(
    codebaseId: string,
    workflowType: IsolationWorkflowType,
    workflowId: string
  ): Promise<IsolationEnvironmentRow | null>;
  create(env: CreateEnvironmentParams): Promise<IsolationEnvironmentRow>;
  /** With an observed row, merge atomically only if its active worktree registration is unchanged. */
  updateMetadata(
    id: string,
    metadata: Record<string, unknown>,
    observed?: IsolationEnvironmentRow
  ): Promise<void>;
  /** Container status changes and worktree rollback; retire worktrees with markWorktreeDestroyed. */
  updateStatus(id: string, status: 'active' | 'destroyed'): Promise<void>;
  /**
   * Retire only the observed worktree registration, atomically. Succeeds if that
   * registration is already destroyed; throws WorktreeRegistrationChangedError
   * if it was replaced. An upsert keeps the row id, so a write by id is unsafe.
   */
  markWorktreeDestroyed(observed: IsolationEnvironmentRow): Promise<void>;
  countActiveByCodebase(codebaseId: string): Promise<number>;
}

/** Reuse must not revoke the creation proof used by the run that created the checkout. */
export async function recordWorktreeAdoption(
  store: Pick<IIsolationStore, 'updateMetadata'>,
  env: IsolationEnvironmentRow,
  repoPath: string
): Promise<IsolationEnvironmentRow> {
  if (env.provider !== 'worktree') return env;
  await verifyWorktreeOwnership(toWorktreePath(env.working_path), toRepoPath(repoPath));
  await store.updateMetadata(env.id, { adopted: true }, env);
  createLogger('isolation.store').warn(
    {
      envId: env.id,
      codebaseId: env.codebase_id,
      workflowType: env.workflow_type,
      identifier: env.workflow_id,
      branchName: env.branch_name,
      worktreePath: env.working_path,
    },
    'worktree_adopted'
  );
  return { ...env, metadata: { ...env.metadata, adopted: true } };
}

/**
 * Register a worktree the provider just returned, so `isolation list`, `cleanup` and
 * `complete` see it. Every path that creates a worktree registers it through here.
 *
 * If the insert fails, a worktree this call created is removed so no checkout is left
 * without a record; an adopted one may be in use elsewhere and stays. The insert error
 * is rethrown, and a failed removal is logged without masking it.
 */
export async function registerWorktree(
  deps: { store: Pick<IIsolationStore, 'create'>; provider: Pick<IIsolationProvider, 'destroy'> },
  env: WorktreeCreationEnvironment,
  canonicalRepoPath: RepoPath,
  record: Omit<CreateEnvironmentParams, 'provider' | 'working_path' | 'branch_name'>
): Promise<IsolationEnvironmentRow> {
  try {
    return await deps.store.create({
      ...record,
      provider: 'worktree',
      working_path: env.workingPath,
      branch_name: env.branchName,
      // The creation provenance keys always win over caller metadata.
      metadata: { ...record.metadata, ...worktreeRegistrationMetadata(env.metadata) },
    });
  } catch (storeError) {
    const err = storeError instanceof Error ? storeError : new Error(String(storeError));
    createLogger('isolation.store').error(
      {
        err,
        errorType: err.constructor.name,
        worktreePath: env.workingPath,
        codebaseId: record.codebase_id,
      },
      'isolation_store_create_failed'
    );
    if (env.metadata.provenance === 'created') {
      await removeCreatedWorktree(deps.provider, env.workingPath, {
        canonicalRepoPath,
        creationId: env.metadata.creationId,
        ...(env.metadata.branchCreated ? { branchName: env.branchName } : {}),
      });
    }
    throw storeError;
  }
}

/**
 * Remove a worktree this caller created and verify it is gone.
 * Logs and returns false on any failure instead of throwing.
 *
 * The creation id proves only that the caller created the checkout, not the branch:
 * a same-repo PR or a reused branch name checks out a local branch that may already
 * exist and hold unpushed work. Callers pass `branchName` only when the provider
 * reports `branchCreated`.
 */
export async function removeCreatedWorktree(
  provider: Pick<IIsolationProvider, 'destroy'>,
  worktreePath: string,
  proof: { canonicalRepoPath: RepoPath; creationId: string; branchName?: BranchName }
): Promise<boolean> {
  const log = createLogger('isolation.store');
  try {
    const result = await provider.destroy(worktreePath, { ...proof, force: true });
    if (!result.worktreeRemoved || !result.directoryClean) {
      throw new Error(
        `Worktree cleanup incomplete at ${worktreePath}: ${result.warnings.join('; ')}`
      );
    }
    log.info({ worktreePath }, 'isolation_orphan_cleanup_completed');
    return true;
  } catch (cleanupError) {
    const err = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
    log.error(
      { err, errorType: err.constructor.name, worktreePath },
      'isolation_orphan_cleanup_failed'
    );
    return false;
  }
}
