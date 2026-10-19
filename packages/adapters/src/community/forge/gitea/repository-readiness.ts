import { readdir } from 'fs/promises';
import { ensureProjectStructure, resolveRepoProjectIdentity } from '@archon/paths';
import {
  addSafeDirectory,
  cloneRepository,
  syncRepository,
  toBranchName,
  toRepoPath,
  type GitError,
} from '@archon/git';
import { getLog } from './log';

/**
 * Ensure repository is cloned and ready.
 * Uses @archon/git functions for safe, testable git operations.
 *
 * Without a checkout (no source/ or an empty one): clone
 * With content (a checkout, or a registered subdirectory of one): sync if
 * shouldSync=true, skip if shouldSync=false
 *
 * @param shouldSync - Whether to sync an existing checkout (pass true to ensure latest code)
 */
export async function ensureRepoReady(
  baseUrl: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  codebase: { name: string; default_cwd: string },
  shouldSync: boolean
): Promise<void> {
  const { name: projectName, default_cwd: repoPath } = codebase;
  if (await hasContent(repoPath)) {
    if (shouldSync) await syncCheckout(repoPath, defaultBranch);
    return;
  }

  // Directory doesn't exist - clone the repository
  getLog().info({ owner, repo, repoPath }, 'repo_cloning');

  // Create project structure (source/, worktrees/, artifacts/, logs/) before
  // cloning so worktree paths resolve correctly on first webhook clone.
  const storage = resolveRepoProjectIdentity(projectName, repoPath);
  if (!storage) throw new Error(`Cannot derive project storage for ${repoPath}`);
  await ensureProjectStructure(storage.owner, storage.repo);

  // Parse URL to get host for authenticated clone
  const urlObj = new URL(baseUrl);
  const repoUrl = `${urlObj.protocol}//${urlObj.host}/${owner}/${repo}.git`;

  const token = process.env.GITEA_TOKEN;
  await addSafeDirectory(toRepoPath(repoPath));
  const cloneResult = await cloneRepository(
    repoUrl,
    toRepoPath(repoPath),
    token ? { credentials: { username: token, password: '' } } : undefined
  );

  if (!cloneResult.ok) {
    getLog().error({ owner, repo, repoPath, error: cloneResult.error }, 'repo_clone_failed');
    throw cloneFailure(owner, repo, cloneResult.error);
  }
}

/** Whether `repoPath` holds anything; a missing path holds nothing. */
async function hasContent(repoPath: string): Promise<boolean> {
  try {
    return (await readdir(repoPath)).length > 0;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return false;
    // Real error - permission denied, I/O failure, etc.
    getLog().error({ repoPath, errorCode: err.code, err }, 'repo_path_access_failed');
    throw new Error(
      `Cannot access repository at ${repoPath}: ${err.code ?? err.message}. ` +
        'Check permissions and disk health.'
    );
  }
}

async function syncCheckout(repoPath: string, defaultBranch: string): Promise<void> {
  getLog().info({ repoPath, defaultBranch }, 'repo_syncing');
  const syncResult = await syncRepository(toRepoPath(repoPath), toBranchName(defaultBranch));
  if (!syncResult.ok) {
    getLog().error({ repoPath, defaultBranch }, 'repo_sync_failed');
    throw new Error(
      `Failed to sync repository to ${defaultBranch}. ` +
        'Try /reset or check if the branch exists.'
    );
  }
}

function cloneFailure(owner: string, repo: string, error: GitError): Error {
  switch (error.code) {
    case 'not_a_repo':
      return new Error(
        `Repository ${owner}/${repo} not found or is private. Check repository access.`
      );
    case 'permission_denied':
      return new Error(
        `Authentication failed for ${owner}/${repo}. Check GITEA_TOKEN permissions.`
      );
    case 'no_space':
      return new Error(`No space left while cloning ${owner}/${repo} to ${error.path}.`);
    case 'branch_not_found':
      return new Error(`Failed to clone ${owner}/${repo}: branch ${error.branch} not found.`);
    case 'unknown':
      return new Error(`Failed to clone ${owner}/${repo}: ${error.message}`);
  }
  const unhandled: never = error;
  return new Error(`Unhandled clone error: ${JSON.stringify(unhandled)}`);
}
