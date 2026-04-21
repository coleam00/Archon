/**
 * IsolationResolver — encapsulates all isolation resolution logic.
 *
 * The resolver determines which isolation environment to use (existing, reusable,
 * adopted, or new) without any platform messaging. It returns rich discriminated
 * union results; the caller handles messaging and DB updates.
 */

import { createLogger } from '@archon/paths';
import {
  worktreeExists,
  toWorktreePath,
  getCanonicalRepoPath,
  findWorktreeByBranch,
  toBranchName,
  isAncestorOf,
  verifyWorktreeOwnership,
} from '@archon/git';
import type { RepoPath, BranchName, WorktreePath } from '@archon/git';

import type {
  IIsolationProvider,
  IsolationResolution,
  IsolationHints,
  IsolationEnvironmentRow,
  IsolationWorkflowType,
  IsolationRequest,
  WorktreeStatusBreakdown,
  ResolveRequest,
} from './types';
import type { IIsolationStore } from './store';
import { classifyIsolationError, isKnownIsolationError } from './errors';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('isolation.resolver');
  return cachedLog;
}

/**
 * Dependencies injected into the resolver.
 * Keeps the resolver decoupled from DB and cleanup implementations.
 */
export interface IsolationResolverDeps {
  store: IIsolationStore;
  provider: IIsolationProvider;
  cleanup?: {
    makeRoom: (codebaseId: string, repoPath: string) => Promise<{ removedCount: number }>;
    getBreakdown: (codebaseId: string, repoPath: string) => Promise<WorktreeStatusBreakdown>;
  };
  staleThresholdDays?: number;
}

const DEFAULT_STALE_THRESHOLD_DAYS = 14;

/**
 * Resolves which isolation environment to use for a conversation.
 *
 * Resolution order:
 * 1. Existing environment reference (from conversation)
 * 2. No codebase = skip isolation
 * 3. Workflow reuse (same codebase + workflow identity)
 * 4. Linked issue sharing (cross-conversation)
 * 5. PR branch adoption (skill symbiosis)
 * 6. Create new worktree
 */
export class IsolationResolver {
  private readonly store: IIsolationStore;
  private readonly provider: IIsolationProvider;
  private readonly staleThresholdDays: number;

  constructor(deps: IsolationResolverDeps) {
    this.store = deps.store;
    this.provider = deps.provider;
    this.staleThresholdDays = deps.staleThresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;

    if (this.staleThresholdDays <= 0) {
      throw new Error(
        `staleThresholdDays must be positive, got ${String(this.staleThresholdDays)}`
      );
    }
  }

  /**
   * Resolve isolation for a conversation request.
   */
  async resolve(request: ResolveRequest): Promise<IsolationResolution> {
    const baseBranch = request.hints?.baseBranch;

    // 1. Check existing isolation reference
    if (request.existingEnvId) {
      const existing = await this.checkExisting(request.existingEnvId, baseBranch);
      if (existing) return existing;
      // Stale — tell caller to clear and retry
      return { status: 'stale_cleaned', previousEnvId: request.existingEnvId };
    }

    // 2. No codebase = no isolation
    if (!request.codebase) {
      return { status: 'none', cwd: '/workspace' };
    }

    const codebase = request.codebase;
    const hints = request.hints;
    const workflowType: IsolationWorkflowType = hints?.workflowType ?? 'thread';
    const workflowId = hints?.workflowId ?? '';

    // Compute canonical repo path once — paths 3-6 all need it either for
    // ownership verification (cross-clone guard) or for worktree creation.
    // Mirror createNewEnvironment's contract: known infrastructure failures
    // (permission denied, ENOENT, malformed worktree pointer, etc.) become
    // a `blocked` result with an actionable user message; unknown failures
    // propagate so they surface as crashes rather than silent isolation
    // failures.
    let canonicalPath: RepoPath;
    try {
      canonicalPath = await getCanonicalRepoPath(codebase.defaultCwd);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error(
        {
          err,
          errorType: err.constructor.name,
          codebaseId: codebase.id,
          defaultCwd: codebase.defaultCwd,
        },
        'isolation.canonical_repo_path_resolution_failed'
      );

      if (!isKnownIsolationError(err)) {
        throw err;
      }

      const userMessage = classifyIsolationError(err);
      return {
        status: 'blocked',
        reason: 'creation_failed',
        userMessage:
          userMessage +
          ' Execution blocked to prevent changes to shared codebase. Please resolve the issue and try again.',
      };
    }

    // 3. Check for existing environment with same workflow
    const reusable = await this.findReusable(
      codebase.id,
      canonicalPath,
      workflowType,
      workflowId,
      baseBranch
    );
    if (reusable) {
      return {
        status: 'resolved',
        env: reusable.env,
        cwd: reusable.env.working_path,
        method: { type: 'workflow_reuse' },
        ...(reusable.warnings.length > 0 ? { warnings: reusable.warnings } : {}),
      };
    }

    // 4. Check linked issues for sharing
    if (hints?.linkedIssues?.length) {
      const linked = await this.findLinkedIssueEnv(codebase.id, canonicalPath, hints.linkedIssues);
      if (linked) return linked;
    }

    // 5. Try PR branch adoption
    if (hints?.prBranch) {
      const adopted = await this.tryBranchAdoption(
        codebase,
        canonicalPath,
        hints,
        workflowType,
        workflowId,
        request.platformType
      );
      if (adopted) return adopted;
    }

    // 6. Create new environment
    return this.createNewEnvironment(
      codebase,
      workflowType,
      workflowId,
      hints,
      canonicalPath,
      request.platformType
    );
  }

  /**
   * Validate that the worktree is based on the expected base branch.
   * Returns a warning string if mismatched, empty array otherwise.
   * Never throws — validation errors are non-blocking.
   */
  private async collectBaseBranchWarnings(
    env: IsolationEnvironmentRow,
    baseBranch: BranchName | undefined,
    logContext: Record<string, unknown>
  ): Promise<string[]> {
    if (!baseBranch) return [];
    try {
      const isValid = await isAncestorOf(toWorktreePath(env.working_path), `origin/${baseBranch}`);
      if (!isValid) {
        getLog().warn(
          { ...logContext, branchName: env.branch_name, baseBranch },
          'isolation.reuse_base_branch_mismatch'
        );
        return [
          `Worktree branch '${env.branch_name}' is not based on '${baseBranch}'. ` +
            `Recreate with: archon complete ${env.branch_name} --force`,
        ];
      }
    } catch (err) {
      getLog().warn(
        { err, ...logContext, branchName: env.branch_name, baseBranch },
        'isolation.reuse_base_branch_check_failed'
      );
    }
    return [];
  }

  /**
   * Check if an existing environment reference is still valid.
   */
  private async checkExisting(
    envId: string,
    baseBranch?: BranchName
  ): Promise<IsolationResolution | null> {
    const env = await this.store.getById(envId);
    if (env && (await worktreeExists(toWorktreePath(env.working_path)))) {
      const warnings = await this.collectBaseBranchWarnings(env, baseBranch, { envId });
      return {
        status: 'resolved',
        env,
        cwd: env.working_path,
        method: { type: 'existing' },
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    if (env) {
      await this.markDestroyedBestEffort(env.id);
    }

    return null;
  }

  /**
   * Verify that an on-disk worktree belongs to the expected repo before
   * adopting. Wraps the shared `verifyWorktreeOwnership` with logging that
   * includes structured fields for incident debugging — the error message
   * alone is not enough because stack traces and call sites vary.
   *
   * Throws on mismatch (re-throws the original error so `classifyIsolationError`
   * and `isKnownIsolationError` pattern-match against the user-facing message).
   */
  private async assertWorktreeOwnership(
    worktreePath: WorktreePath,
    canonicalRepoPath: RepoPath,
    logContext: Record<string, unknown>,
    logEvent: string
  ): Promise<void> {
    try {
      await verifyWorktreeOwnership(worktreePath, canonicalRepoPath);
    } catch (err) {
      getLog().warn(
        { ...logContext, worktreePath, canonicalRepoPath, err: (err as Error).message },
        logEvent
      );
      throw err;
    }
  }

  /**
   * Find a reusable environment by workflow identity.
   *
   * Verifies that the on-disk worktree belongs to `canonicalRepoPath` before
   * returning. On cross-clone mismatch, throws — the DB row belongs to the
   * other clone and we must not adopt it. The other clone's row is preserved
   * (no markDestroyed) so the other clone's work continues.
   */
  private async findReusable(
    codebaseId: string,
    canonicalRepoPath: RepoPath,
    workflowType: IsolationWorkflowType,
    workflowId: string,
    baseBranch?: BranchName
  ): Promise<{ env: IsolationEnvironmentRow; warnings: string[] } | null> {
    const existing = await this.store.findActiveByWorkflow(codebaseId, workflowType, workflowId);
    if (!existing) return null;

    const worktreePath = toWorktreePath(existing.working_path);
    if (await worktreeExists(worktreePath)) {
      await this.assertWorktreeOwnership(
        worktreePath,
        canonicalRepoPath,
        { codebaseId, workflowType, workflowId },
        'isolation.reuse_refused_cross_checkout'
      );

      getLog().debug({ workflowType, workflowId }, 'isolation_reuse_existing');
      const warnings = await this.collectBaseBranchWarnings(existing, baseBranch, {
        workflowType,
        workflowId,
      });
      return { env: existing, warnings };
    }

    await this.markDestroyedBestEffort(existing.id);
    return null;
  }

  /**
   * Find an environment linked to one of the given issue numbers.
   *
   * Verifies each candidate worktree belongs to `canonicalRepoPath` before
   * adopting. On cross-clone mismatch, throws — this stops iteration over any
   * remaining linked issues. Intentional: if a linked env is owned by another
   * clone, the user's machine state is anomalous (two clones of the same
   * remote) and they should resolve it explicitly rather than have us skip
   * past the signal. For the 99% single-clone case, this path always succeeds.
   */
  private async findLinkedIssueEnv(
    codebaseId: string,
    canonicalRepoPath: RepoPath,
    linkedIssues: number[]
  ): Promise<IsolationResolution | null> {
    for (const issueNum of linkedIssues) {
      const linkedEnv = await this.store.findActiveByWorkflow(
        codebaseId,
        'issue',
        String(issueNum)
      );
      if (!linkedEnv) continue;

      const worktreePath = toWorktreePath(linkedEnv.working_path);
      if (await worktreeExists(worktreePath)) {
        await this.assertWorktreeOwnership(
          worktreePath,
          canonicalRepoPath,
          { codebaseId, issueNum },
          'isolation.linked_issue_refused_cross_checkout'
        );

        getLog().debug({ issueNum, codebaseId }, 'isolation_share_linked_issue');
        return {
          status: 'resolved',
          env: linkedEnv,
          cwd: linkedEnv.working_path,
          method: { type: 'linked_issue_reuse', issueNumber: issueNum },
        };
      }

      await this.markDestroyedBestEffort(linkedEnv.id);
    }
    return null;
  }

  /**
   * Try adopting an existing worktree matching a PR branch.
   *
   * Verifies ownership of the discovered worktree before recording it in the
   * DB. On cross-clone mismatch, throws — adopting another clone's worktree
   * would create a stale DB row pointing at someone else's filesystem state.
   */
  private async tryBranchAdoption(
    codebase: ResolveRequest['codebase'] & object,
    canonicalRepoPath: RepoPath,
    hints: IsolationHints,
    workflowType: IsolationWorkflowType,
    workflowId: string,
    platformType: string
  ): Promise<IsolationResolution | null> {
    const prBranch = hints.prBranch;
    if (!prBranch) return null;

    const adoptedPath = await findWorktreeByBranch(canonicalRepoPath, prBranch);
    if (adoptedPath && (await worktreeExists(adoptedPath))) {
      await this.assertWorktreeOwnership(
        adoptedPath,
        canonicalRepoPath,
        { codebaseId: codebase.id, prBranch },
        'isolation.branch_adoption_refused_cross_checkout'
      );

      getLog().info({ adoptedPath, prBranch }, 'isolation_worktree_adopted');
      const env = await this.store.create({
        codebase_id: codebase.id,
        workflow_type: workflowType,
        workflow_id: workflowId,
        working_path: adoptedPath,
        branch_name: prBranch,
        created_by_platform: platformType,
        metadata: { adopted: true, adopted_from: 'skill' },
      });
      return {
        status: 'resolved',
        env,
        cwd: adoptedPath,
        method: { type: 'branch_adoption', branch: prBranch },
      };
    }
    return null;
  }

  /**
   * Best-effort mark a stale environment as destroyed.
   * Logs errors but never throws - stale cleanup should not block resolution.
   */
  private async markDestroyedBestEffort(envId: string): Promise<void> {
    try {
      await this.store.updateStatus(envId, 'destroyed');
    } catch (cleanupError) {
      const err = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
      getLog().error(
        { err, errorType: err.constructor.name, isolationEnvId: envId },
        'isolation_cleanup_failed'
      );
    }
  }

  /**
   * Create a new isolation environment.
   */
  private async createNewEnvironment(
    codebase: ResolveRequest['codebase'] & object,
    workflowType: IsolationWorkflowType,
    workflowId: string,
    hints: IsolationHints | undefined,
    canonicalPath: RepoPath,
    platformType: string
  ): Promise<IsolationResolution> {
    // Construct request based on workflow type
    const baseRequest = {
      codebaseId: codebase.id,
      codebaseName: codebase.name,
      canonicalRepoPath: canonicalPath,
      identifier: workflowId,
    };

    let isolationRequest: IsolationRequest;
    if (workflowType === 'pr') {
      isolationRequest = {
        ...baseRequest,
        workflowType: 'pr' as const,
        prBranch: hints?.prBranch ?? toBranchName(`pr-${workflowId}`),
        prSha: hints?.prSha,
        isForkPR: hints?.isForkPR ?? false,
      };
    } else if (workflowType === 'task') {
      isolationRequest = {
        ...baseRequest,
        workflowType: 'task' as const,
        fromBranch: hints?.fromBranch,
      };
    } else {
      isolationRequest = {
        ...baseRequest,
        workflowType,
      };
    }

    let isolatedEnv: Awaited<ReturnType<typeof this.provider.create>>;
    try {
      isolatedEnv = await this.provider.create(isolationRequest);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      if (!isKnownIsolationError(err)) {
        // Unknown errors (programming bugs, unexpected failures) should propagate
        // so they appear in logs as crashes, not as silent "workspace blocked" messages.
        throw err;
      }

      const userMessage = classifyIsolationError(err);
      getLog().error(
        {
          err,
          errorType: err.constructor.name,
          codebaseId: codebase.id,
          codebaseName: codebase.name,
        },
        'isolation_creation_failed'
      );

      return {
        status: 'blocked',
        reason: 'creation_failed',
        userMessage:
          userMessage +
          ' Execution blocked to prevent changes to shared codebase. Please resolve the issue and try again.',
      };
    }

    // provider.create() succeeded — worktree exists on disk.
    // If store.create() fails, we must clean up the orphaned worktree.
    let env: IsolationEnvironmentRow;
    try {
      env = await this.store.create({
        codebase_id: codebase.id,
        workflow_type: workflowType,
        workflow_id: workflowId,
        working_path: isolatedEnv.workingPath,
        branch_name: isolatedEnv.branchName,
        created_by_platform: platformType,
        metadata: {
          related_issues: hints?.linkedIssues ?? [],
          related_prs: hints?.linkedPRs ?? [],
        },
      });
    } catch (storeError) {
      const err = storeError instanceof Error ? storeError : new Error(String(storeError));
      getLog().error(
        {
          err,
          errorType: err.constructor.name,
          worktreePath: isolatedEnv.workingPath,
          codebaseId: codebase.id,
        },
        'isolation_store_create_failed'
      );

      // Clean up the orphaned worktree — best-effort, don't mask the original error
      try {
        await this.provider.destroy(isolatedEnv.workingPath, {
          canonicalRepoPath: canonicalPath,
          branchName: isolatedEnv.branchName,
          force: true,
        });
        getLog().info(
          { worktreePath: isolatedEnv.workingPath },
          'isolation_orphan_cleanup_completed'
        );
      } catch (cleanupError) {
        const cleanupErr =
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
        getLog().error(
          {
            err: cleanupErr,
            errorType: cleanupErr.constructor.name,
            worktreePath: isolatedEnv.workingPath,
          },
          'isolation_orphan_cleanup_failed'
        );
      }

      throw err; // Re-throw original store error — this is an unexpected failure
    }

    return {
      status: 'resolved',
      env,
      cwd: env.working_path,
      method: { type: 'created' },
      ...(isolatedEnv.warnings?.length ? { warnings: isolatedEnv.warnings } : {}),
    };
  }
}
