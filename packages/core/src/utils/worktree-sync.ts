import { copyWorktreeFiles } from '@archon/isolation';
import { getCanonicalRepoPath, isWorktreePath } from '@archon/git';
import { stat } from 'fs/promises';
import type { Stats } from 'fs';
import { join } from 'path';
import { loadRepoConfig } from '../config/config-loader';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('worktree-sync');
  return cachedLog;
}

/** Check if an error is ENOENT (file not found) */
function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Log a warning for filesystem errors (non-ENOENT) */
function logStatWarning(context: string, path: string, error: unknown): void {
  const err = error as NodeJS.ErrnoException;
  getLog().warn({ context, path, err, code: err.code }, 'stat_failed');
}

/** Safely stat a path, returning null for ENOENT or logging warnings for other errors */
async function safeStat(
  path: string,
  context: string,
  throwOnNonEnoent: boolean
): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    logStatWarning(context, path, error);
    if (throwOnNonEnoent) {
      throw error;
    }
    return null;
  }
}

/** Normalize copyFiles to always include .archon at the start */
function normalizeCopyFiles(copyFiles: string[] | undefined): string[] {
  if (!copyFiles) {
    return ['.archon'];
  }
  if (copyFiles.includes('.archon')) {
    return copyFiles;
  }
  return ['.archon', ...copyFiles];
}

/**
 * Sync .archon folder from canonical repo to worktree if canonical repo is newer
 *
 * @param worktreePath - Path to the worktree
 * @returns true if sync occurred, false if skipped
 */
export async function syncArchonToWorktree(worktreePath: string): Promise<boolean> {
  try {
    // 1. Verify this is actually a worktree
    if (!(await isWorktreePath(worktreePath))) {
      return false;
    }

    // 2. Get canonical repo path
    const canonicalRepoPath = await getCanonicalRepoPath(worktreePath);

    // 3. Check if .archon exists in both locations
    const canonicalArchonPath = join(canonicalRepoPath, '.archon');
    const worktreeArchonPath = join(worktreePath, '.archon');

    // Canonical must exist; for worktree, ENOENT is expected (will be copied)
    const canonicalStat = await safeStat(canonicalArchonPath, 'canonical', false);
    if (!canonicalStat) {
      return false;
    }

    const worktreeStat = await safeStat(worktreeArchonPath, 'worktree', true);

    // 4. Compare modification times - skip if worktree is up-to-date
    if (worktreeStat && canonicalStat.mtime <= worktreeStat.mtime) {
      return false;
    }

    // 5. Load config to respect copyFiles configuration
    let copyFiles: string[] | undefined;
    try {
      const repoConfig = await loadRepoConfig(canonicalRepoPath);
      copyFiles = repoConfig.worktree?.copyFiles;
    } catch (error) {
      getLog().warn({ canonicalRepoPath, err: error }, 'repo_config_load_failed_using_default');
      copyFiles = ['.archon'];
    }

    // 6. Perform sync using existing utility
    const copied = await copyWorktreeFiles(
      canonicalRepoPath,
      worktreePath,
      normalizeCopyFiles(copyFiles)
    );

    getLog().info(
      { canonicalRepo: canonicalRepoPath, worktree: worktreePath, filesCopied: copied.length },
      'archon_synced_to_worktree'
    );

    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    getLog().error(
      { worktreePath, err, errorName: err.name, code: err.code ?? 'UNKNOWN' },
      'archon_sync_failed'
    );
    return false;
  }
}
