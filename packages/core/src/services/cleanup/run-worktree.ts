// The worktree a workflow run created: assessed and released when the run completes,
// reclaimed when it is abandoned.
import { lstat } from 'node:fs/promises';
import {
  isContainerRun,
  readOwnedWorktree,
  type OwnedWorktree,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import type { WorktreeDisposition } from '@archon/workflows/schemas/terminal-record';
import {
  getIsolationProvider,
  isGeneratedTaskBranch,
  readWorktreeBranchCreated,
  readWorktreeCreationId,
  WorktreeLeftoverError,
  type IIsolationStore,
} from '@archon/isolation';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import {
  execFileAsync,
  hasUncommittedChangesStrict,
  isWorktreeRegistered,
  listWorktrees,
  toBranchName,
  toRepoPath,
  toWorktreePath,
  worktreeExists,
} from '@archon/git';
import type { BranchName, RepoPath, WorktreePath } from '@archon/git';
import { retainsWorkspace, unknownPlatformReason } from '../../platforms/registry';
import * as isolationEnvDb from '../../db/isolation-environments';
import * as codebaseDb from '../../db/codebases';
import { countUnpushedCommits, readLiveRemoteTips } from './run-lock';
import { getLog } from './log';

export interface ReleasedWorktree {
  path: string;
  branch: string;
  /** True when the branch never moved off the commit it was cut from and went with the worktree. */
  branchDeleted: boolean;
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
  if (!proof || isContainerRun(run)) return null;
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
 * Remove a completed run's worktree. Its branch goes too when it holds no commit of its
 * own (see `unusedBranch`); a branch with work is kept. Remote tips are read before
 * the claim; local checks rerun under the lock against them.
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
    const warnings = [...result.warnings];
    const unused = unusedBranch(run, env);
    let branchDeleted = false;
    if (unused) {
      // The worktree is already removed and recorded destroyed: a failed delete is a
      // warning, never a failed release.
      try {
        branchDeleted = (await deleteBranchAt(repo, unused.branch, unused.cutFrom)) === 'deleted';
      } catch (err) {
        getLog().warn({ err, workflowRunId: run.id }, 'run_branch_delete_failed');
        warnings.push(`Kept branch ${unused.branch} for run ${run.id}: ${(err as Error).message}`);
      }
    }
    return { released: { path, branch: env.branch_name, branchDeleted }, warnings };
  });
}

/**
 * The run's branch when deleting it at its start point is safe to try: the engine
 * generated it for the run, this creation made it, and the run recorded the commit it
 * was cut from. Without a recorded start point the branch is kept, because a kept
 * branch costs one `git branch -d` and a deleted one may cost work.
 */
function unusedBranch(
  run: WorkflowRun,
  env: IsolationEnvironmentRow
): { branch: BranchName; cutFrom: string } | null {
  const cutFrom =
    run.checkout_baseline?.kind === 'git' ? run.checkout_baseline.cutFromCommit : undefined;
  if (cutFrom === undefined) return null;
  if (!isGeneratedTaskBranch(env) || !readWorktreeBranchCreated(env.metadata)) return null;
  return { branch: toBranchName(env.branch_name), cutFrom };
}

/**
 * Delete a local branch only while its tip is exactly `expected`: a compare-and-delete,
 * never a force delete. `update-ref -d <ref> <old>` makes Git itself refuse when the ref
 * moved, so a commit landing between the read and the delete is never lost. Unlike
 * `git branch -d`, `update-ref` would delete a checked-out branch, so that is refused first.
 */
async function deleteBranchAt(
  repo: RepoPath,
  branch: BranchName,
  expected: string
): Promise<'deleted' | 'moved' | 'checked_out'> {
  if ((await listWorktrees(repo)).some(wt => wt.branch === branch)) return 'checked_out';
  const ref = `refs/heads/${branch}`;
  const before = await readBranchTip(repo, ref);
  if (before === null) return 'deleted';
  if (before !== expected) return 'moved';
  try {
    await execFileAsync('git', ['-C', repo, 'update-ref', '-d', ref, expected], {
      timeout: 10000,
    });
    return 'deleted';
  } catch (err) {
    const after = await readBranchTip(repo, ref);
    if (after === null) return 'deleted';
    if (after !== expected) return 'moved';
    throw new Error(`could not delete branch ${branch}: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/** The commit a local branch ref points at, or null when the ref does not exist. */
async function readBranchTip(repo: RepoPath, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { timeout: 10000 }
    );
    return stdout.trim();
  } catch (err) {
    // `rev-parse --verify --quiet` exits 1, silently, exactly when the ref is absent.
    const code = (err as { code?: number | string }).code;
    if (code === 1 || code === '1') return null;
    throw err;
  }
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
  if (isContainerRun(run)) return { warnings: [] };
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
 * A branch with commits of its own is kept, so committed work stays recoverable; a
 * generated branch still at its start point goes with the worktree.
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
