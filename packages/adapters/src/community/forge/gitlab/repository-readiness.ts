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
import type { GitLabClient } from './types';

/**
 * Clone the project when its checkout is absent or empty; otherwise sync it when
 * `shouldSync` is set. An empty source/ is what a failed clone leaves; any other
 * content is a checkout, or a registered subdirectory of one, and is never cloned over.
 */
export async function ensureRepoReady(
  client: GitLabClient,
  projectPath: string,
  defaultBranch: string,
  codebase: { name: string; default_cwd: string },
  shouldSync: boolean
): Promise<void> {
  const { name: projectName, default_cwd: repoPath } = codebase;
  if (await hasContent(repoPath)) {
    if (shouldSync) await syncCheckout(repoPath, defaultBranch);
    return;
  }

  getLog().info({ projectPath, repoPath }, 'gitlab.repo_cloning');

  // Create project structure (source/, worktrees/, artifacts/, logs/) before
  // cloning so worktree paths resolve correctly on first webhook clone.
  const storage = resolveRepoProjectIdentity(projectName, repoPath);
  if (!storage) throw new Error(`Cannot derive project storage for ${repoPath}`);
  await ensureProjectStructure(storage.owner, storage.repo);

  const urlObj = new URL(client.gitlabUrl);
  const repoUrl = `${urlObj.protocol}//${urlObj.host}/${projectPath}.git`;
  await addSafeDirectory(toRepoPath(repoPath));
  const cloneResult = await cloneRepository(repoUrl, toRepoPath(repoPath), {
    credentials: { username: 'oauth2', password: client.token },
  });

  if (!cloneResult.ok) {
    getLog().error({ projectPath, repoPath, error: cloneResult.error }, 'gitlab.repo_clone_failed');
    throw cloneFailure(projectPath, cloneResult.error);
  }
}

/** Whether `repoPath` holds anything; a missing path holds nothing. */
async function hasContent(repoPath: string): Promise<boolean> {
  try {
    return (await readdir(repoPath)).length > 0;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return false;
    getLog().error({ repoPath, errorCode: err.code, err }, 'gitlab.repo_path_access_failed');
    throw new Error(
      `Cannot access repository at ${repoPath}: ${err.code ?? err.message}. ` +
        'Check permissions and disk health.'
    );
  }
}

async function syncCheckout(repoPath: string, defaultBranch: string): Promise<void> {
  getLog().info({ repoPath, defaultBranch }, 'gitlab.repo_syncing');
  const syncResult = await syncRepository(toRepoPath(repoPath), toBranchName(defaultBranch));
  if (!syncResult.ok) {
    getLog().error({ error: syncResult.error, repoPath, defaultBranch }, 'gitlab.repo_sync_failed');
    throw new Error(
      `Failed to sync repository to ${defaultBranch}. ` +
        'Try /reset or check if the branch exists.'
    );
  }
}

function cloneFailure(projectPath: string, error: GitError): Error {
  if (error.code === 'not_a_repo') {
    return new Error(`Repository ${projectPath} not found or is private. Check repository access.`);
  }
  if (error.code === 'permission_denied') {
    return new Error(`Authentication failed for ${projectPath}. Check GITLAB_TOKEN permissions.`);
  }
  const detail = error.code === 'unknown' ? error.message : error.code;
  return new Error(`Failed to clone ${projectPath}: ${detail}`);
}
