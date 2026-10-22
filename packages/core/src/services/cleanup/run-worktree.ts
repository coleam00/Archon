// The worktree a workflow run created: assessed and released when the run completes,
// reclaimed when it is abandoned.
import { lstat } from 'node:fs/promises';
import {
  readOwnedWorktree,
  type OwnedWorktree,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import type { WorktreeDisposition } from '@archon/workflows/schemas/terminal-record';
import {
  getIsolationProvider,
  isGeneratedTaskBranch,
  readWorktreeCreationId,
  WorktreeLeftoverError,
  type IIsolationStore,
} from '@archon/isolation';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import {
  hasUncommittedChangesStrict,
  isWorktreeRegistered,
  toRepoPath,
  toWorktreePath,
  worktreeExists,
} from '@archon/git';
import type { RepoPath, WorktreePath } from '@archon/git';
import { retainsWorkspace, unknownPlatformReason } from '../../platforms/registry';
import * as isolationEnvDb from '../../db/isolation-environments';
import * as codebaseDb from '../../db/codebases';
import { countUnpushedCommits, readLiveRemoteTips } from './run-lock';
import { getLog } from './log';

export interface ReleasedWorktree {
  path: string;
  branch: string;
}

export interface RunWorktreeRelease {
  released?: ReleasedWorktree;
  warnings: string[];
}

export interface WorktreeOwnershipReaders {
  getCodebase: typeof codebaseDb.getCodebase;
  getLiveRunOwningEnv: typeof isolationEnvDb.getLiveRunOwningEnv;
}

/** Runs before the registration claim; the check it returns runs under the worktree lock. */
type PrepareCheck = (env: IsolationEnvironmentRow, repo: RepoPath) => Promise<() => Promise<void>>;

/** The isolation record and repository behind a run's creation proof; throws when they disagree. */
async function resolveOwnedWorktree(
  run: WorkflowRun,
  proof: OwnedWorktree,
  store: IIsolationStore,
  getCodebase: WorktreeOwnershipReaders['getCodebase']
): Promise<{ env: IsolationEnvironmentRow; repo: RepoPath }> {
  const env = await store.getById(proof.envId);
  if (
    env?.provider !== 'worktree' ||
    env.codebase_id !== run.codebase_id ||
    env.working_path !== run.working_path ||
    readWorktreeCreationId(env.metadata) !== proof.creationId
  ) {
    throw new Error('creation proof does not match its isolation record');
  }
  const reason = unknownPlatformReason(env.created_by_platform);
  if (reason) throw new Error(reason);
  const codebase = run.codebase_id ? await getCodebase(run.codebase_id) : null;
  if (!codebase) throw new Error('canonical repository is unavailable');
  return { env, repo: toRepoPath(codebase.default_cwd) };
}

async function judgeLocalCompletedWorktree(
  env: IsolationEnvironmentRow,
  repo: RepoPath,
  liveTips: readonly string[]
): Promise<WorktreeDisposition> {
  const path = toWorktreePath(env.working_path);
  if ((await worktreeExists(path)) && (await hasUncommittedChangesStrict(path))) {
    return { disposition: 'retained', reason: 'uncommitted_changes' };
  }
  const commits = await countUnpushedCommits(env, repo, liveTips);
  if (commits > 0) {
    return {
      disposition: 'retained',
      reason: 'unpushed_commits',
      detail: `${String(commits)} commit(s) on no remote`,
    };
  }
  return { disposition: 'release' };
}

/**
 * Decide what happens to the worktree a completed run created. Null when the run has
 * no creation proof or its launch named the worktree's branch: only a checkout on the
 * run's own generated branch is the run's to remove. A failed check is reported as a
 * retention, never thrown.
 */
export async function assessCompletedRunWorktree(
  run: WorkflowRun,
  store: IIsolationStore,
  readers: WorktreeOwnershipReaders
): Promise<WorktreeDisposition | null> {
  const proof = readOwnedWorktree(run.metadata);
  if (!proof || run.metadata?.isolation === 'container') return null;
  try {
    const { env, repo } = await resolveOwnedWorktree(run, proof, store, readers.getCodebase);
    if (!isGeneratedTaskBranch(env)) return null;
    if (retainsWorkspace(env.created_by_platform)) {
      return { disposition: 'retained', reason: 'workspace_retained' };
    }
    // The completing run is still claimable here; release refuses any other claimant.
    const user = await readers.getLiveRunOwningEnv(env.id, undefined, run.id);
    if (user) {
      return {
        disposition: 'retained',
        reason: 'in_use',
        detail: `run ${user.id} (${user.status})`,
      };
    }
    return await judgeLocalCompletedWorktree(env, repo, await readLiveRemoteTips(env, repo));
  } catch (err) {
    getLog().warn({ err, workflowRunId: run.id }, 'completed_worktree_assess_failed');
    return { disposition: 'retained', reason: 'check_failed', detail: (err as Error).message };
  }
}

/**
 * Remove a completed run's worktree, keeping its branch so the run stays adoptable.
 * Remote tips are read before the claim; local checks rerun under the lock against them.
 */
export async function releaseCompletedRunWorktree(
  run: WorkflowRun,
  store: IIsolationStore,
  readers: WorktreeOwnershipReaders
): Promise<void> {
  const result = await reclaimOwnedWorktree(run, store, readers, async (env, repo) => {
    const liveTips = await readLiveRemoteTips(env, repo);
    return async () => {
      const disposition = await judgeLocalCompletedWorktree(env, repo, liveTips);
      if (disposition.disposition !== 'release') {
        throw new Error(`worktree is no longer releasable: ${disposition.reason}`);
      }
    };
  });
  if (result.warnings.length > 0) {
    getLog().warn(
      { workflowRunId: run.id, warnings: result.warnings },
      'completed_worktree_release_warnings'
    );
  }
}

async function reclaimOwnedWorktree(
  run: WorkflowRun,
  store: IIsolationStore,
  readers: WorktreeOwnershipReaders,
  prepareCheck?: PrepareCheck
): Promise<RunWorktreeRelease> {
  const proof = readOwnedWorktree(run.metadata);
  if (!proof) return unprovenCheckoutRelease(run, readers);
  const { env, repo } = await resolveOwnedWorktree(run, proof, store, readers.getCodebase);
  const path = toWorktreePath(env.working_path);
  if (!(await pathExists(path))) return settleAbsentCheckout(env, repo, path, store);
  if (env.status === 'destroyed') refuse('a path exists for an already destroyed environment');
  const beforeRemove = await prepareCheck?.(env, repo);
  const user = await readers.getLiveRunOwningEnv(env.id);
  if (user) refuse(`claimable run ${user.id} (${user.status}) also uses this checkout`);
  return store.withWorktreeRegistration(env, async markDestroyed => {
    const result = await getIsolationProvider().destroy(path, {
      canonicalRepoPath: repo,
      guardedRemoval: {
        creationId: proof.creationId,
        beforeRemove: async () => {
          await beforeRemove?.();
          await markDestroyed();
        },
      },
    });
    if (!result.worktreeRemoved || !result.directoryClean) refuse('filesystem removal incomplete');
    return { released: { path, branch: env.branch_name }, warnings: result.warnings };
  });
}

function refuse(reason: string): never {
  throw new Error(reason);
}

async function pathExists(path: WorktreePath): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
}

/** A run without a creation proof: nothing is removed, and a checkout it may have used is reported. */
async function unprovenCheckoutRelease(
  run: WorkflowRun,
  readers: WorktreeOwnershipReaders
): Promise<RunWorktreeRelease> {
  if (run.metadata?.isolation === 'container') return { warnings: [] };
  const codebase = run.codebase_id ? await readers.getCodebase(run.codebase_id) : null;
  if (codebase?.kind === 'folder') return { warnings: [] };
  return {
    warnings: run.working_path
      ? [
          `Retained checkout ${run.working_path} for run ${run.id}: no valid proof this run created it. Inspect it and use explicit isolation cleanup if appropriate.`,
        ]
      : [],
  };
}

/** The checkout is already gone from disk: record that, unless Git still tracks it. */
async function settleAbsentCheckout(
  env: IsolationEnvironmentRow,
  repo: RepoPath,
  path: WorktreePath,
  store: IIsolationStore
): Promise<RunWorktreeRelease> {
  if (await isWorktreeRegistered(repo, path)) {
    refuse('checkout is absent but still registered with Git');
  }
  if (env.status !== 'destroyed') await store.markWorktreeDestroyed(env);
  return { warnings: [] };
}

/**
 * Remove the worktree an abandoned run created, discarding uncommitted work.
 * The branch is kept, so committed work stays recoverable.
 */
export async function reclaimRunWorktree(
  run: WorkflowRun,
  store: IIsolationStore,
  readers: WorktreeOwnershipReaders = {
    getCodebase: codebaseDb.getCodebase,
    getLiveRunOwningEnv: isolationEnvDb.getLiveRunOwningEnv,
  }
): Promise<RunWorktreeRelease> {
  try {
    return await reclaimOwnedWorktree(run, store, readers);
  } catch (err) {
    const proof = readOwnedWorktree(run.metadata);
    // A leftover Git no longer tracks cannot be finished by a retry; its message says so.
    const next =
      err instanceof WorktreeLeftoverError
        ? ''
        : `. Fix the cause and retry workflow abandon ${run.id}.`;
    throw new Error(
      `Could not release worktree for run ${run.id}, environment ${proof?.envId ?? '(unaccounted)'}, checkout ${run.working_path ?? '(missing)'}: ${(err as Error).message}${next}`,
      { cause: err }
    );
  }
}
