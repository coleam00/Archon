/**
 * Creating a worktree for a request: adopt one that already exists, or add a
 * locked checkout of the request's branch, finish its setup, and unlock it.
 */

import { randomUUID } from 'crypto';
import { access, stat, writeFile } from 'fs/promises';
import { join } from 'path';

import {
  execFileAsync,
  ConfiguredBaseBranchNotFoundError,
  getDefaultRemote,
  getGitCheckoutIdentity,
  mkdirAsync,
  refreshWorktreeIndex,
  syncWorkspace,
  toBranchName,
  toWorktreePath,
} from '@archon/git';
import type { BranchName, RepoPath } from '@archon/git';
import { isInsideArchonWorkspaces } from '@archon/paths';
import { validateWorktreePostCreate } from '../../post-create-config';
import { IsolationFailure, MissingProjectDirectoryError } from '../../errors';
import { copyWorktreeFiles } from '../../worktree-copy';
import type {
  IsolationRequest,
  RepoConfigLoader,
  WorktreeCreateConfig,
  WorktreeCreationEnvironment,
  WorktreeSetupExecutor,
} from '../../types';
import { isPRIsolationRequest } from '../../types';
import { findExisting } from './adopt';
import {
  createFromExistingBranch,
  createFromPR,
  createNewBranch,
  generateBranchName,
} from './branches';
import { worktreeBaseFor, worktreePathFor } from './location';
import { releaseSetupLock, rollBackOnFailure } from './setup-lock';
import {
  CREATION_MARKER,
  SETUP_LOCK_PREFIX,
  directoryExists,
  getForkReviewBranch,
  getLog,
} from './shared';

type BranchCheckout =
  | { kind: 'checked_out'; cutFromCommit?: string; branchCreated: boolean }
  | { kind: 'adopted'; environment: WorktreeCreationEnvironment };

type WorktreeCreationResult =
  | {
      kind: 'created';
      warnings: string[];
      cutFromCommit?: string;
      creationId: string;
      branchCreated: boolean;
    }
  | { kind: 'adopted'; environment: WorktreeCreationEnvironment };

/**
 * `WorktreeProvider.create()`: create an isolated environment using git worktrees.
 *
 * Config is loaded once; parsed provisioning settings are validated before mutation.
 */
export async function createWorktreeEnvironment(
  request: IsolationRequest,
  loadConfig: RepoConfigLoader,
  setupExecutor: WorktreeSetupExecutor | undefined
): Promise<WorktreeCreationEnvironment> {
  if (!(await projectDirectoryExists(request.canonicalRepoPath))) {
    throw new MissingProjectDirectoryError(
      request.canonicalRepoPath,
      request.codebaseName ?? request.codebaseId
    );
  }

  const repoConfig = await loadRepoConfig(request.canonicalRepoPath, loadConfig);
  validateWorktreePostCreate(repoConfig);
  if (repoConfig?.postCreate?.length && !setupExecutor) {
    throw new Error('worktree.postCreate requires a worktree setup executor');
  }
  const branchName = toBranchName(generateBranchName(request));
  // envId is, by contract, the worktree filesystem path (see `destroy()` docstring),
  // so the environment's id is this resolved path and never a separately computed one.
  const worktreePath = worktreePathFor(request, branchName, repoConfig);

  const existing = await findExisting(request, branchName, worktreePath);
  if (existing) {
    return existing;
  }

  const creation = await createWorktree(
    request,
    worktreePath,
    branchName,
    repoConfig,
    setupExecutor
  );
  if (creation.kind === 'adopted') {
    return creation.environment;
  }

  const checkedOutBranch =
    isPRIsolationRequest(request) && request.isForkPR
      ? getForkReviewBranch(request.identifier)
      : branchName;
  return {
    id: worktreePath,
    provider: 'worktree',
    workingPath: worktreePath,
    branchName: checkedOutBranch,
    status: 'active',
    createdAt: new Date(),
    metadata: {
      provenance: 'created',
      adopted: false,
      creationId: creation.creationId,
      branchCreated: creation.branchCreated,
      request,
      ...(creation.cutFromCommit !== undefined ? { cutFromCommit: creation.cutFromCommit } : {}),
    },
    ...(creation.warnings.length > 0 ? { warnings: creation.warnings } : {}),
  };
}

async function loadRepoConfig(
  repoPath: RepoPath,
  loadConfig: RepoConfigLoader
): Promise<WorktreeCreateConfig | null> {
  try {
    return await loadConfig(repoPath);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, repoPath }, 'repo_config_load_failed');
    throw new Error(`Failed to load config: ${err.message}`, { cause: error });
  }
}

/**
 * Whether the registered project path is a directory. An absent path, a
 * non-directory, and a path under a regular file (ENOTDIR) all count as
 * missing, so create() can raise MissingProjectDirectoryError. Other
 * filesystem errors propagate.
 */
async function projectDirectoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Create the actual worktree.
 * Returns either the newly created worktree's warnings or a worktree adopted
 * after a concurrent creator won the same branch.
 */
async function createWorktree(
  request: IsolationRequest,
  worktreePath: string,
  branchName: BranchName,
  worktreeConfig: WorktreeCreateConfig | null,
  setupExecutor?: WorktreeSetupExecutor
): Promise<WorktreeCreationResult> {
  const repoPath = request.canonicalRepoPath;
  if (await directoryExists(worktreePath)) {
    throw new IsolationFailure(
      'path_exists',
      `Cannot create worktree at ${worktreePath}: a pre-existing directory occupies this path. ` +
        'It is not a worktree Archon created, so Archon leaves it intact; remove or move it, then retry.'
    );
  }
  const creationId = randomUUID();
  const setupLockReason = `${SETUP_LOCK_PREFIX}: ${creationId}`;

  // In both layouts the base already carries repo context — creating it
  // recursively is enough.
  await mkdirAsync(worktreeBaseFor(repoPath, request.codebaseName, worktreeConfig), {
    recursive: true,
  });

  const checkout = await checkOutBranch(
    request,
    worktreePath,
    branchName,
    worktreeConfig,
    setupLockReason
  );
  if (checkout.kind === 'adopted') return checkout;

  // Reaching here means this call's own `git worktree add` produced the
  // directory and left the setup lock on it. The lock marks the checkout
  // unfinished until setup completes, so no other caller adopts it meanwhile,
  // and the rollback below only ever removes a checkout this attempt created
  // and still holds. Without both, a half-set-up worktree survives with no
  // isolation-environment row tracking it, and the next run on the same branch
  // adopts it as ready (#3448).
  const existingBranch = request.workflowType === 'task' && request.taskBranch?.kind === 'existing';
  await rollBackOnFailure(repoPath, worktreePath, setupLockReason, async () => {
    await finishWorktreeSetup(request, repoPath, worktreePath, worktreeConfig, setupExecutor);
    if (existingBranch) return;
    const identity = await getGitCheckoutIdentity(worktreePath);
    await writeFile(join(identity.gitDir, CREATION_MARKER), creationId, { flag: 'wx' });
  });

  const lockWarning = await releaseSetupLock(repoPath, worktreePath);
  const warnings = lockWarning ? [lockWarning] : [];
  if (existingBranch) {
    return {
      kind: 'adopted',
      environment: adoptedExistingBranch(request, worktreePath, branchName, warnings),
    };
  }

  return {
    kind: 'created',
    creationId,
    branchCreated: checkout.branchCreated,
    warnings,
    ...(checkout.cutFromCommit !== undefined ? { cutFromCommit: checkout.cutFromCommit } : {}),
  };
}

/** Add the locked checkout of the branch the request needs. */
async function checkOutBranch(
  request: IsolationRequest,
  worktreePath: string,
  branchName: BranchName,
  worktreeConfig: WorktreeCreateConfig | null,
  setupLockReason: string
): Promise<BranchCheckout> {
  const repoPath = request.canonicalRepoPath;
  if (request.workflowType === 'task' && request.taskBranch?.kind === 'existing') {
    // Adoption continues the local branch exactly as the prior run left it.
    // Do not fetch, sync, reset, or create a child branch here.
    await createFromExistingBranch(
      repoPath,
      worktreePath,
      request.taskBranch.branch,
      setupLockReason
    );
    return { kind: 'checked_out', branchCreated: false };
  }

  // Resolve git remote name: explicit config > auto-detect > actionable error
  const remote = await resolveRemote(repoPath, worktreeConfig?.remote);

  // Base precedence: a per-dispatch --base override (request.baseOverride) wins,
  // then explicit repo config, then the registered codebase's default branch
  // (request.baseBranch), then auto-detect via getDefaultBranch.
  const preferredBaseBranch =
    request.baseOverride ?? worktreeConfig?.baseBranch ?? request.baseBranch;
  const baseBranch = await syncWorkspaceBeforeCreate(repoPath, preferredBaseBranch, remote);

  if (isPRIsolationRequest(request)) {
    // For PRs: fetch and checkout the PR branch (actual or synthetic)
    const pr = await createFromPR(request, worktreePath, setupLockReason, remote);
    if ('adopted' in pr) {
      return { kind: 'adopted', environment: pr.adopted };
    }
    return { kind: 'checked_out', branchCreated: pr.branchCreated };
  }
  // For issues, tasks, threads: create new branch
  const created = await createNewBranch(
    request,
    repoPath,
    worktreePath,
    branchName,
    baseBranch,
    setupLockReason,
    remote
  );
  return { kind: 'checked_out', ...created };
}

/** A task that continues an existing branch adopts the checkout it just materialized. */
function adoptedExistingBranch(
  request: IsolationRequest,
  worktreePath: string,
  branchName: BranchName,
  warnings: string[]
): WorktreeCreationEnvironment {
  getLog().warn(
    {
      worktreePath,
      branchName,
      codebaseId: request.codebaseId,
      workflowType: request.workflowType,
      identifier: request.identifier,
    },
    'worktree_adopted'
  );
  return {
    id: worktreePath,
    provider: 'worktree',
    workingPath: worktreePath,
    branchName,
    status: 'active',
    createdAt: new Date(),
    metadata: { provenance: 'adopted', adopted: true, adoptedFrom: 'branch', request },
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Turn a freshly added worktree into a checkout a run can start from.
 */
async function finishWorktreeSetup(
  request: IsolationRequest,
  repoPath: RepoPath,
  worktreePath: string,
  worktreeConfig: WorktreeCreateConfig | null,
  setupExecutor?: WorktreeSetupExecutor
): Promise<void> {
  // Initialize submodules unless explicitly opted out. The check is free
  // when `.gitmodules` is absent (access-based short-circuit), so repos
  // without submodules pay nothing. Default-on matches git's own intent
  // with `clone --recurse-submodules` / `submodule.recurse`.
  if (worktreeConfig?.initSubmodules !== false) {
    await initSubmodules(worktreePath);
  }

  await copyConfiguredFiles(repoPath, worktreePath, worktreeConfig?.copyFiles ?? []);

  if (worktreeConfig?.postCreate?.length && setupExecutor) {
    await setupExecutor({
      workingPath: worktreePath,
      canonicalRepoPath: repoPath,
      codebaseId: request.codebaseId,
      commands: worktreeConfig.postCreate,
      timeout: worktreeConfig.postCreateTimeout ?? 300_000,
    });
  }

  // Last, so the refresh sees the tree the rest of setup leaves, and while the
  // setup lock is still held: no adopter can start git work in the checkout
  // and contend with the refresh for the index lock.
  await refreshIndex(worktreePath);
}

/**
 * Refresh the index of a worktree this provider just created, once, so checkout
 * observation at each node start does not re-hash the whole tree (see
 * `refreshWorktreeIndex`). A failure leaves observations correct but slower, so it is
 * logged and creation continues.
 */
async function refreshIndex(worktreePath: string): Promise<void> {
  try {
    await refreshWorktreeIndex(toWorktreePath(worktreePath));
  } catch (err) {
    getLog().warn({ err: err as Error, worktreePath }, 'worktree.index_refresh_failed');
  }
}

/**
 * Resolve the git remote name to use for all fetch/push operations.
 *
 * Resolution order: explicit config (worktree.remote) > auto-detect via
 * getDefaultRemote() > actionable error when ambiguous.
 */
async function resolveRemote(repoPath: RepoPath, configuredRemote?: string): Promise<string> {
  const configured = configuredRemote?.trim();
  if (configured) {
    getLog().debug({ repoPath, remote: configured }, 'worktree.remote_from_config');
    return configured;
  }

  const detected = await getDefaultRemote(repoPath);
  if (detected) {
    if (detected !== 'origin') {
      // Non-standard remote picked up automatically — log at info so the
      // choice is visible when debugging fetch/push behavior.
      getLog().info({ repoPath, remote: detected }, 'worktree.remote_auto_detected');
    }
    return detected;
  }

  // Distinguish no remotes from multiple non-origin remotes for an actionable error.
  let remoteNames: string[] | null = null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote'], { timeout: 10000 });
    remoteNames = stdout
      .split(/\r?\n/)
      .map(remote => remote.trim())
      .filter(remote => remote.length > 0);
  } catch {
    // Best-effort for error message only
  }

  if (remoteNames?.length === 0) {
    throw new Error(
      `Cannot determine git remote for ${repoPath}: no git remote is configured. ` +
        'Add one with `git remote add origin URL`, or use `--no-worktree` to run in the live checkout.'
    );
  }

  const remoteList = remoteNames?.join(', ') ?? '<unknown>';
  throw new Error(
    `Cannot determine git remote for ${repoPath}: no 'origin' remote found and ` +
      `multiple remotes exist (${remoteList}). ` +
      'Set worktree.remote in .archon/config.yaml to specify which remote to use.'
  );
}

/**
 * Sync workspace with remote before creating a new worktree
 * Ensures new work starts from the latest code on the base branch.
 *
 * Branch resolution:
 * - If configuredBaseBranch is provided: Uses that branch. Fails with actionable
 *   error if the branch doesn't exist - no silent fallback to default.
 * - If configuredBaseBranch is omitted: Auto-detects the default branch via git.
 *
 * All sync failures are fatal — creating a worktree from an unknown
 * start-point risks branching from the wrong commit.
 */
async function syncWorkspaceBeforeCreate(
  repoPath: RepoPath,
  configuredBaseBranch?: string,
  remote = 'origin'
): Promise<string> {
  try {
    getLog().debug(
      { repoPath, branch: configuredBaseBranch ?? 'auto-detect', remote },
      'workspace_sync_starting'
    );
    // Only hard-reset for Archon-managed clones when creating isolated worktrees.
    // Locally-registered repos keep the non-destructive fast-forward mode.
    const isManagedClone = isInsideArchonWorkspaces(repoPath);
    const { branch } = await syncWorkspace(
      repoPath,
      configuredBaseBranch ? toBranchName(configuredBaseBranch) : undefined,
      { mode: isManagedClone ? 'reset' : 'fast-forward', remote }
    );
    getLog().debug({ repoPath, branch, remote }, 'workspace_synced');
    return branch;
  } catch (error) {
    // The configured branch is proven absent; its message carries the config remedy.
    if (error instanceof ConfiguredBaseBranchNotFoundError) throw error;
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(
      `Failed to fetch base branch from '${remote}': ${err.message}. Check your network connection and remote configuration.`,
      { cause: err }
    );
  }
}

/**
 * Copy the git-ignored files the operator listed under `worktree.copyFiles`.
 *
 * `.archon` used to be copied unconditionally, because it was the only way a
 * workflow's own commands and scripts could be seen from inside the worktree it
 * executed against. That is now handled by the run's own source capture
 * (`@archon/workflows` `workflow-source.ts`), which keeps the source outside the
 * target entirely. The implicit copy is gone because it was never scoped to
 * executable source: it also carried `.archon/.env`, cross-run `state/`, and any
 * other ignored content, overwrote the worktree's own tracked `.archon` files, and
 * put all of it into the target's `git status` and its validators' inputs.
 *
 * An operator who still wants `.archon` (or anything else) in a worktree lists it
 * under `worktree.copyFiles`, which is unchanged and still honored verbatim.
 */
async function copyConfiguredFiles(
  canonicalRepoPath: string,
  worktreePath: string,
  configuredFiles: string[]
): Promise<void> {
  // Only what the operator explicitly configured. Set deduplicates a repeated entry.
  const copyFiles = [...new Set(configuredFiles)];
  if (copyFiles.length === 0) return;

  // Copy files - errors are handled inside copyWorktreeFiles, but wrap in
  // try/catch for defense against unexpected errors
  try {
    const copied = await copyWorktreeFiles(canonicalRepoPath, worktreePath, copyFiles);
    if (copied.length > 0) {
      getLog().debug({ worktreePath, copiedCount: copied.length }, 'worktree_files_copied');
    }

    // Log summary if some files were configured but not all were copied
    const attemptedCount = copyFiles.length;
    const copiedCount = copied.length;
    if (copiedCount < attemptedCount) {
      getLog().warn({ worktreePath, copiedCount, attemptedCount }, 'worktree_file_copy_partial');
    }
  } catch (error) {
    // Should not happen as copyWorktreeFiles handles errors internally,
    // but guard against unexpected errors
    getLog().error({ err: error, worktreePath }, 'worktree_file_copy_failed');
  }
}

/**
 * Initialize git submodules in a worktree when the repo uses them.
 *
 * ENOENT on `.gitmodules` → skip (zero-cost for non-submodule repos).
 * Any other error (EACCES, EIO, git failure, timeout) → throw. Silent
 * success on a half-initialized worktree is the exact class of bug this
 * function exists to prevent; an unreadable `.gitmodules` is materially
 * the same as a failed git op. The thrown error is classified by
 * `classifyIsolationError` into an actionable message.
 */
async function initSubmodules(worktreePath: string): Promise<void> {
  try {
    await access(join(worktreePath, '.gitmodules'));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return;
    }
    getLog().error({ err, worktreePath }, 'worktree.submodule_check_failed');
    throw new IsolationFailure(
      'submodule_failed',
      `Submodule initialization failed: cannot read .gitmodules (${err.code ?? 'unknown error'})`,
      err
    );
  }

  try {
    await execFileAsync(
      'git',
      ['-C', worktreePath, 'submodule', 'update', '--init', '--recursive'],
      {
        timeout: 120000,
      }
    );
    getLog().info({ worktreePath }, 'worktree.submodule_init_completed');
  } catch (error) {
    const err = error as Error & { stderr?: string };
    getLog().error({ err, worktreePath }, 'worktree.submodule_init_failed');
    const detail = err.stderr?.trim() || err.message;
    throw new IsolationFailure(
      'submodule_failed',
      `Submodule initialization failed: ${detail}`,
      err
    );
  }
}
