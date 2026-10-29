import { GitFailure } from './errors';
import { inspectRemoteBranches } from './remote-branches';
import { createLogger } from '@archon/paths';
import { execFileAsync } from './exec';
import type { RepoPath, BranchName, WorktreePath } from './types';
import { toBranchName } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('git');
  return cachedLog;
}

/** Resolve the advertised remote default; never guess or use a stale cached HEAD. */
export async function getDefaultBranch(repoPath: RepoPath, remote = 'origin'): Promise<BranchName> {
  const result = await inspectRemoteBranches({ kind: 'local', repoPath, remote });
  if (result.status === 'available' && result.defaultBranch) return result.defaultBranch;
  const reason = result.status === 'unavailable' ? result.evidence : `${remote}/HEAD is not known`;
  throw new GitFailure(
    result.status === 'unavailable' ? 'unclassified' : 'default_branch_missing',
    `Cannot detect default branch for ${repoPath}: ${reason}. ` +
      'Pass --base, set worktree.baseBranch in .archon/config.yaml, or set the codebase default_branch field.',
    result.status === 'unavailable' ? result.failure : undefined
  );
}

/**
 * Count commits that would become unreachable if a local branch and its remote
 * counterpart were deleted.
 *
 * Every other local branch, remote branch, and tag is treated as a surviving
 * ref that can keep the candidate branch's commits reachable.
 */
export async function getUniqueCommitCount(
  repoPath: RepoPath,
  branchName: BranchName,
  remote = 'origin'
): Promise<number> {
  try {
    const { stdout: refsOutput } = await execFileAsync(
      'git',
      [
        '-C',
        repoPath,
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ],
      { timeout: 10000 }
    );
    const deletedRefs = new Set([
      `refs/heads/${branchName}`,
      `refs/remotes/${remote}/${branchName}`,
    ]);
    const survivingRefs = refsOutput
      .split('\n')
      .map(ref => ref.trim())
      .filter(ref => ref.length > 0 && !deletedRefs.has(ref));

    const { stdout: commitsOutput } = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-list', branchName, '--not', ...survivingRefs],
      { timeout: 15000 }
    );

    return commitsOutput.split('\n').filter(line => line.trim().length > 0).length;
  } catch (error) {
    const err = error as Error & { stderr?: string };
    getLog().error(
      { repoPath, branchName, remote, err, stderr: err.stderr },
      'unique_commit_count_failed'
    );
    throw new Error(`Failed to count unique commits for ${branchName}: ${err.message}`);
  }
}

/**
 * Checkout a branch (creating it if it doesn't exist)
 */
export async function checkout(repoPath: RepoPath, branchName: BranchName): Promise<void> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'checkout', branchName], {
      timeout: 30000,
    });
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const exists =
      !isExitOne(error) ||
      (await checkoutBranchExists(repoPath, branchName).catch((inspectionError: unknown) => {
        getLog().debug(
          { err: inspectionError, repoPath, branchName },
          'checkout_ref_inspection_failed'
        );
        return true;
      }));
    if (!exists) {
      await execFileAsync('git', ['-C', repoPath, 'checkout', '-b', branchName], {
        timeout: 30000,
      });
      return;
    }

    getLog().error({ repoPath, branchName, err, stderr: err.stderr }, 'checkout_failed');
    throw new Error(`Failed to checkout branch ${branchName}: ${err.message}`, { cause: error });
  }
}

/** Whether `branchName` names a local commit or a remote-tracking ref a checkout could start from. */
async function checkoutBranchExists(repoPath: RepoPath, branchName: BranchName): Promise<boolean> {
  if (await localCommitExists(repoPath, branchName)) return true;
  const sourceRef = `refs/heads/${branchName}`;
  for (const remote of await listRemotes(repoPath)) {
    for (const spec of await remoteFetchSpecs(repoPath, remote)) {
      const destination = fetchDestination(spec, sourceRef);
      if (destination !== undefined && (await refExists(repoPath, destination))) return true;
    }
  }
  return false;
}

/** Git's plain exit 1: `rev-parse --verify --quiet` found no such ref, `config --get` no such key. */
function isExitOne(error: unknown): boolean {
  return error instanceof GitFailure && error.kind === 'unclassified' && error.code === 1;
}

async function localCommitExists(repoPath: RepoPath, branchName: BranchName): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      [
        '-C',
        repoPath,
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${branchName}^{commit}`,
      ],
      { timeout: 10000 }
    );
    return true;
  } catch (error) {
    if (!isExitOne(error)) throw error;
    return false;
  }
}

async function listRemotes(repoPath: RepoPath): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote'], { timeout: 10000 });
  return stdout.trim().split('\n').filter(Boolean);
}

async function remoteFetchSpecs(repoPath: RepoPath, remote: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'config', '--get-all', `remote.${remote}.fetch`],
      { timeout: 10000 }
    );
    return stdout.trim().split('\n');
  } catch (error) {
    // A remote without a fetch mapping cannot supply a checkout candidate.
    if (isExitOne(error)) return [];
    throw error;
  }
}

/**
 * The local ref a fetch refspec maps `sourceRef` to, or undefined when the spec is
 * negative, malformed or does not match it. A `*` in the source matches any run of
 * characters, substituted into the destination's `*`.
 */
function fetchDestination(spec: string, sourceRef: string): string | undefined {
  if (spec.startsWith('^')) return undefined;
  const [source, destination] = spec.replace(/^\+/, '').split(':');
  if (!source || !destination) return undefined;
  const star = source.indexOf('*');
  if (star === -1) return source === sourceRef ? destination : undefined;
  const prefix = source.slice(0, star);
  const suffix = source.slice(star + 1);
  if (
    sourceRef.length < prefix.length + suffix.length ||
    !sourceRef.startsWith(prefix) ||
    !sourceRef.endsWith(suffix)
  )
    return undefined;
  const matched = sourceRef.slice(prefix.length, sourceRef.length - suffix.length);
  return destination.replace('*', matched);
}

/**
 * Removal must see untracked and submodule changes regardless of user status settings.
 * Unlike the legacy helper, command failures propagate instead of becoming dirty evidence.
 */
export async function hasUncommittedChangesStrict(
  workingPath: RepoPath | WorktreePath
): Promise<boolean> {
  const { stdout } = await execFileAsync(
    'git',
    [
      '-C',
      workingPath,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ],
    { timeout: 5 * 60 * 1000 }
  );
  return stdout.length > 0;
}

/**
 * Check if a git working directory has uncommitted changes
 *
 * Returns true on failures unless Git establishes that no repository exists.
 */
export async function hasUncommittedChanges(
  workingPath: RepoPath | WorktreePath
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workingPath, 'status', '--porcelain']);
    return stdout.trim().length > 0;
  } catch (error) {
    const err = error as Error & { code?: string };

    if (error instanceof GitFailure && error.kind === 'not_repository') {
      getLog().debug({ workingPath }, 'repository_absent_no_uncommitted_changes');
      return false;
    }

    // FAIL-SAFE: For any other error, assume changes exist to prevent data loss
    // This is intentionally conservative - better to block cleanup than lose work
    getLog().error(
      { workingPath, err, code: err.code },
      'uncommitted_changes_check_failed_assuming_dirty'
    );
    return true;
  }
}

/**
 * Commit all uncommitted changes (typically workflow-generated artifacts)
 * Only commits if there are actually changes to commit
 * Returns true if commit was made, false if nothing to commit
 */
export async function commitAllChanges(
  workingPath: RepoPath | WorktreePath,
  message: string
): Promise<boolean> {
  try {
    if (!(await hasUncommittedChangesStrict(workingPath))) return false;
    await execFileAsync('git', ['-C', workingPath, 'add', '-A'], { timeout: 10000 });
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workingPath, 'diff', '--cached', '--name-only', '-z'],
      { timeout: 10000 }
    );
    if (!stdout) return false;
    await execFileAsync('git', ['-C', workingPath, 'commit', '-m', message], { timeout: 10000 });
  } catch (error) {
    const err = error as Error & { stderr?: string; stdout?: string };
    getLog().error({ workingPath, err, stderr: err.stderr }, 'commit_all_changes_failed');
    throw new Error(`Failed to commit changes in ${workingPath}: ${err.message}`, { cause: error });
  }

  return true;
}

/**
 * Check if a branch has been merged into main.
 *
 * Returns false for a confirmed non-repository; other failures propagate.
 */
export async function isBranchMerged(
  repoPath: RepoPath,
  branchName: BranchName,
  mainBranch: BranchName
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoPath,
      'branch',
      '--merged',
      mainBranch,
    ]);
    const mergedBranches = stdout.split('\n').map(b => b.trim().replace(/^\* /, ''));
    return mergedBranches.includes(branchName);
  } catch (error) {
    const err = error as Error & { code?: string; stderr?: string };
    if (error instanceof GitFailure && error.kind === 'not_repository') return false;

    // Unexpected errors (permission denied, corruption) - propagate so callers can report
    getLog().error({ err: error, repoPath, branchName, mainBranch }, 'branch_merge_check_failed');
    throw new Error(
      `Failed to check if ${branchName} is merged into ${mainBranch}: ${err.message}`,
      { cause: error }
    );
  }
}

/**
 * Check if a branch is patch-equivalent to the upstream (e.g. squash-merged).
 *
 * Uses `git cherry <upstream> <branch>` which lists branch commits not in upstream:
 *   - `- <sha>` means the patch IS already in upstream (squash-merged / cherry-picked)
 *   - `+ <sha>` means the patch is NOT in upstream (genuinely unmerged)
 *
 * Returns true if every reported commit is patch-equivalent (or if there are no
 * commits to compare). Returns false if any commit is unmerged.
 *
 * A confirmed non-repository returns false unless the caller requires errors
 * to surface. Other failures always propagate.
 */
export async function isPatchEquivalent(
  repoPath: RepoPath | WorktreePath,
  branchName: BranchName | 'HEAD',
  baseRef: string,
  options: { throwOnExpectedError?: boolean } = {}
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'cherry', baseRef, branchName], {
      timeout: 15000,
    });
    const lines = stdout.split('\n').filter(line => line.trim());
    if (lines.length === 0) return true;
    return lines.every(line => line.startsWith('-'));
  } catch (error) {
    const err = error as Error & { code?: string; stderr?: string };
    if (
      error instanceof GitFailure &&
      error.kind === 'not_repository' &&
      !options.throwOnExpectedError
    )
      return false;

    getLog().error(
      { err: error, repoPath, branchName, baseRef },
      'branch.patch_equivalent_check_failed'
    );
    throw new Error(
      `Failed to check if ${branchName} is patch-equivalent to ${baseRef}: ${err.message}`,
      { cause: error }
    );
  }
}

/**
 * Check if a ref is an ancestor of HEAD in the given working directory.
 *
 * Returns true if ancestorRef is an ancestor of HEAD (worktree is based on that branch).
 * Returns false if it is not (base branch mismatch detected).
 * A confirmed non-repository returns false; missing refs and other failures
 * propagate so callers can distinguish a mismatch from an unverifiable check.
 */
export async function isAncestorOf(
  workingPath: RepoPath | WorktreePath,
  ancestorRef: string
): Promise<boolean> {
  try {
    await execFileAsync('git', [
      '-C',
      workingPath,
      'merge-base',
      '--is-ancestor',
      ancestorRef,
      'HEAD',
    ]);
    return true;
  } catch (error) {
    const err = error as Error & { code?: number | string; stderr?: string };
    // exit code 1 = not an ancestor — expected case
    if (error instanceof GitFailure && error.code === 1) return false;
    if (error instanceof GitFailure && error.kind === 'not_repository') return false;

    getLog().error({ err: error, workingPath, ancestorRef }, 'branch.ancestor_check_failed');
    throw new Error(
      `Failed to check if ${ancestorRef} is ancestor of HEAD at ${workingPath}: ${(err as Error).message}`,
      { cause: error }
    );
  }
}

/**
 * Whether `rev` (a branch ref, or a worktree's `HEAD`) is `headSha` or an ancestor
 * of it, i.e. whether a PR whose head is `headSha` carried every commit on `rev`.
 * `workingPath` is the checkout the revision is read in.
 *
 * The head commit may have been pushed from elsewhere (a bot fix, a maintainer
 * push) and never fetched here, so when the object is missing it is fetched by
 * SHA from `remote` first. A failed fetch or an unanswerable ancestry check
 * throws: the caller cannot tell "no" from "unknown" and must not guess.
 */
export async function isRevCoveredBy(
  workingPath: RepoPath | WorktreePath,
  rev: string,
  headSha: string,
  remote: string
): Promise<boolean> {
  if (!(await hasCommitObject(workingPath, headSha))) {
    try {
      await execFileAsync('git', ['-C', workingPath, 'fetch', '--no-tags', remote, headSha], {
        timeout: 60000,
      });
    } catch (error) {
      throw new Error(
        `Failed to fetch PR head ${headSha} from ${remote}: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }
  return isCommitAncestor(workingPath, rev, headSha);
}

/** Exit status of `git cat-file -e <sha>^{commit}`: 0 means the commit is here. */
async function hasCommitObject(repoPath: RepoPath | WorktreePath, sha: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'cat-file', '-e', `${sha}^{commit}`], {
      timeout: 10000,
    });
    return true;
  } catch {
    // Any non-zero exit sends us to the fetch, which fails loudly if the
    // repository itself is the problem.
    return false;
  }
}

/**
 * Whether `ancestor` is reachable from `descendant` (a commit counts as its own
 * ancestor). Read from `git merge-base --is-ancestor`'s exit status: 0 yes, 1 no.
 * Anything else throws. Kept apart from `isAncestorOf`, which maps a missing ref to
 * false: here false means "unmerged work", and cleanup must not reach it by guessing.
 */
async function isCommitAncestor(
  repoPath: RepoPath | WorktreePath,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['-C', repoPath, 'merge-base', '--is-ancestor', ancestor, descendant],
      {
        timeout: 10000,
      }
    );
    return true;
  } catch (error) {
    const err = error as Error & { code?: number | string };
    if (err.code === 1 || err.code === '1') return false;
    throw new Error(
      `Failed to check whether ${ancestor} is an ancestor of ${descendant} at ${repoPath}: ${err.message}`,
      { cause: error }
    );
  }
}

/**
 * Get the currently checked-out branch name.
 *
 * Returns null for expected errors (detached HEAD, path not found, not a git repo).
 * Returns null on any error since callers use this for non-destructive read-only
 * decisions (ff-merge guard, reminder reporting) and the safe default is "unknown branch".
 */
export async function getCurrentBranch(
  workingPath: RepoPath | WorktreePath
): Promise<BranchName | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workingPath, 'symbolic-ref', '--short', 'HEAD'],
      { timeout: 10000 }
    );
    const branch = stdout.trim();
    return branch ? toBranchName(branch) : null;
  } catch (error) {
    // Expected: detached HEAD, missing path, not a git repo.
    // Unexpected (permission denied, timeout): same safe default; log for debugging.
    getLog().debug({ workingPath, err: error as Error }, 'get_current_branch_failed');
    return null;
  }
}

/**
 * Read the checked-out branch for an ownership decision.
 *
 * Unlike `getCurrentBranch`, this returns `null` only for Git's explicit
 * detached-HEAD result. Infrastructure and repository errors remain errors so
 * callers never mistake an unreadable checkout for a different branch.
 */
export async function getCurrentBranchStrict(
  workingPath: RepoPath | WorktreePath
): Promise<BranchName | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workingPath, 'symbolic-ref', '--quiet', 'HEAD'],
      { timeout: 10000 }
    );
    const branch = stdout.trim().replace(/^refs\/heads\//, '');
    if (!branch) {
      throw new Error(`Git returned no branch for checkout ${workingPath}`);
    }
    return toBranchName(branch);
  } catch (error) {
    const err = error as Error & { code?: number | string };
    if (err.code === 1 || err.code === '1') return null;
    throw new Error(`Failed to inspect the current branch at ${workingPath}: ${err.message}`, {
      cause: error,
    });
  }
}

/** Verify an exact local branch ref without treating Git failures as absence. */
export async function localBranchExists(
  repoPath: RepoPath,
  branchName: BranchName
): Promise<boolean> {
  try {
    return await refExists(repoPath, `refs/heads/${branchName}`);
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Failed to verify local branch '${branchName}' at ${repoPath}: ${err.message}`,
      { cause: error }
    );
  }
}

async function refExists(repoPath: RepoPath, ref: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', ref], {
      timeout: 10000,
    });
    return true;
  } catch (error) {
    const err = error as Error & { code?: number | string };
    if (err.code === 1 || err.code === '1') return false;
    throw error;
  }
}

/**
 * Count how many local commits on the current branch are ahead of `origin/<branch>`.
 *
 * Returns 0 if origin/<branch> doesn't exist, on detached HEAD, or any error.
 * Used by the post-message reminder to report unpushed work in `source/` —
 * "I don't know" is reported as zero so the reminder stays silent rather than
 * spuriously warning.
 */
export async function countCommitsAhead(
  workingPath: RepoPath | WorktreePath,
  branch: BranchName
): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workingPath, 'rev-list', '--count', `origin/${branch}..HEAD`],
      { timeout: 10000 }
    );
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch (error) {
    // Expected: origin/<branch> missing, detached HEAD, not a git repo.
    // Unexpected (permission denied, timeout, git corruption): same safe default
    // (0 keeps the reminder silent), but log so it's visible during triage.
    getLog().debug({ workingPath, branch, err: error as Error }, 'count_commits_ahead_failed');
    return 0;
  }
}

/**
 * Count commits reachable from `revs` (a worktree's `HEAD`, a branch ref) that no
 * remote-tracking ref reaches: the commits that exist only in this clone. Throws
 * when git cannot answer, so a caller deciding whether deletion loses work never
 * reads an error as zero.
 */
export async function countCommitsMissingFromRemotes(
  workingPath: RepoPath | WorktreePath,
  revs: readonly string[]
): Promise<number> {
  if (revs.length === 0) return 0;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workingPath, 'rev-list', '--count', ...revs, '--not', '--remotes'],
      { timeout: 10000 }
    );
    return parseInt(stdout.trim(), 10);
  } catch (error) {
    throw new Error(
      `Failed to count unpushed commits on ${revs.join(', ')} at ${workingPath}: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

/**
 * Get the last commit date for a repository or worktree.
 *
 * Returns null for a confirmed non-repository or absent HEAD. Other failures
 * propagate.
 */
export async function getLastCommitDate(
  workingPath: RepoPath | WorktreePath
): Promise<Date | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workingPath, 'log', '-1', '--format=%ci']);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const date = new Date(trimmed);
    if (isNaN(date.getTime())) {
      getLog().warn({ workingPath, rawDate: trimmed }, 'invalid_commit_date_format');
      return null;
    }
    return date;
  } catch (error) {
    const err = error as Error & { code?: string; stderr?: string };
    if (error instanceof GitFailure && error.kind === 'not_repository') return null;
    try {
      await execFileAsync('git', ['-C', workingPath, 'rev-parse', '--verify', '--quiet', 'HEAD'], {
        timeout: 10000,
      });
    } catch (inspectionError) {
      if (inspectionError instanceof GitFailure && inspectionError.code === 1) return null;
    }

    // Unexpected errors (permission denied, corruption) - propagate
    getLog().error({ err: error, workingPath }, 'last_commit_date_check_failed');
    throw new Error(`Failed to get last commit date for ${workingPath}: ${err.message}`, {
      cause: error,
    });
  }
}
