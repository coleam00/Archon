import { readdir, rm } from 'fs/promises';
import { resolve } from 'path';
import {
  AppNotInstalledError,
  installCredentialHelper,
  type IGitHubAppAuthProvider,
  resolveGitHubTokenFromEnv,
} from '@archon/core';
import { ensureProjectStructure, resolveRepoProjectIdentity } from '@archon/paths';
import {
  addSafeDirectory,
  cloneRepository,
  githubTokenCredentials,
  syncRepository,
  toBranchName,
  toRepoPath,
  type GitError,
} from '@archon/git';
import { isExistingCheckout } from './checkout-readiness';
import { getLog } from './log';

/** What readiness reads from the adapter's auth: the mode and, in App mode, the clone token. */
export type ReadinessAuth =
  | { kind: 'pat' }
  | { kind: 'app'; provider: Pick<IGitHubAppAuthProvider, 'getInstallationToken'> };

// Webhook readiness runs before conversation locking; adapter instances can share a checkout.
const repositoryReadiness = new Map<string, Promise<void>>();

/**
 * Ensure repository is cloned and ready
 * Clone when no checkout exists (see isExistingCheckout)
 * For existing codebases: sync if shouldSync=true, skip if shouldSync=false
 * @param shouldSync - Whether to sync an existing clone (pass true to ensure latest code)
 */
export function ensureRepoReady(
  webUrl: string,
  auth: ReadinessAuth,
  owner: string,
  repo: string,
  defaultBranch: string,
  codebase: { name: string; default_cwd: string },
  shouldSync: boolean
): Promise<void> {
  const key = resolve(codebase.default_cwd);
  const prepare = () =>
    prepareRepository(
      webUrl,
      auth,
      owner,
      repo,
      defaultBranch,
      codebase.default_cwd,
      codebase.name,
      shouldSync
    );
  const previous = repositoryReadiness.get(key) ?? Promise.resolve();
  const pending = previous.then(prepare, prepare).finally(() => {
    if (repositoryReadiness.get(key) === pending) repositoryReadiness.delete(key);
  });
  repositoryReadiness.set(key, pending);
  return pending;
}

async function prepareRepository(
  webUrl: string,
  auth: ReadinessAuth,
  owner: string,
  repo: string,
  defaultBranch: string,
  repoPath: string,
  projectName: string,
  shouldSync: boolean
): Promise<void> {
  if (await isExistingCheckout(repoPath, owner, repo, projectName)) {
    await addSafeDirectory(toRepoPath(repoPath));
    await ensureRepositorySetup(auth, owner, repo, repoPath);
    if (shouldSync) await syncCheckout(repoPath, defaultBranch);
    return;
  }
  await cloneIntoProject(webUrl, auth, owner, repo, repoPath, projectName);
  await ensureRepositorySetup(auth, owner, repo, repoPath);
}

async function syncCheckout(repoPath: string, defaultBranch: string): Promise<void> {
  getLog().info({ repoPath, defaultBranch }, 'github.repo_syncing');
  const syncResult = await syncRepository(toRepoPath(repoPath), toBranchName(defaultBranch));
  if (syncResult.ok) return;
  getLog().error({ error: syncResult.error, repoPath, defaultBranch }, 'github.repo_sync_failed');
  const detail =
    syncResult.error.code === 'branch_not_found'
      ? `Branch '${defaultBranch}' not found`
      : gitErrorDetail(syncResult.error);
  throw new Error(
    `Failed to sync repository to ${defaultBranch}. ` +
      `Try /reset or check if the branch exists. Details: ${detail}`
  );
}

function gitErrorDetail(error: GitError): string {
  return 'message' in error ? error.message : error.code;
}

async function cloneIntoProject(
  webUrl: string,
  auth: ReadinessAuth,
  owner: string,
  repo: string,
  repoPath: string,
  projectName: string
): Promise<void> {
  getLog().info({ owner, repo, repoPath }, 'github.repo_cloning');

  // Create project structure (source/, worktrees/, artifacts/, logs/) before
  // cloning so worktree paths resolve correctly on first webhook clone.
  const storage = resolveRepoProjectIdentity(projectName, repoPath);
  if (!storage) throw new Error(`Cannot derive project storage for ${repoPath}`);
  await ensureProjectStructure(storage.owner, storage.repo);

  const ghToken = await cloneToken(auth, owner, repo);
  const repoUrl = `${webUrl}/${owner}/${repo}.git`;

  // Readiness is serialized through cleanup, so an empty target cannot be
  // populated by a sibling webhook while this attempt owns it.
  let cloneOwnsTarget = true;
  try {
    cloneOwnsTarget = (await readdir(repoPath)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await addSafeDirectory(toRepoPath(repoPath));
  const cloneResult = await cloneRepository(
    repoUrl,
    toRepoPath(repoPath),
    ghToken ? { credentials: githubTokenCredentials(ghToken) } : undefined
  );
  if (cloneResult.ok) return;

  getLog().error({ error: cloneResult.error, owner, repo, repoPath }, 'github.repo_clone_failed');
  if (cloneOwnsTarget) await rm(repoPath, { recursive: true, force: true });
  throw cloneFailure(auth, owner, repo, cloneResult.error);
}

/**
 * Resolve the clone token per auth mode. App mode talks to the auth provider
 * (installation token, ~1h validity); PAT mode reads env directly.
 */
async function cloneToken(
  auth: ReadinessAuth,
  owner: string,
  repo: string
): Promise<string | undefined> {
  if (auth.kind !== 'app') return resolveGitHubTokenFromEnv();
  try {
    return await auth.provider.getInstallationToken(owner, repo);
  } catch (err) {
    if (err instanceof AppNotInstalledError) {
      getLog().error({ err, owner, repo }, 'github.repo_clone_app_not_installed');
    }
    throw err;
  }
}

function cloneFailure(auth: ReadinessAuth, owner: string, repo: string, error: GitError): Error {
  if (error.code === 'not_a_repo') {
    return new Error(
      `Repository ${owner}/${repo} not found or is private. Check repository access.`
    );
  }
  if (error.code === 'permission_denied') {
    const authHint =
      auth.kind === 'app'
        ? 'Check that the Archon GitHub App is installed on the org and has the Contents:Read permission.'
        : 'Check GITHUB_TOKEN permissions.';
    return new Error(`Authentication failed for ${owner}/${repo}. ${authHint}`);
  }
  return new Error(`Failed to clone ${owner}/${repo}: ${gitErrorDetail(error)}`);
}

async function ensureRepositorySetup(
  auth: ReadinessAuth,
  owner: string,
  repo: string,
  repoPath: string
): Promise<void> {
  // App mode requires a refreshable credential source after the
  // request-scoped clone token expires.
  if (auth.kind !== 'app') return;
  const result = await installCredentialHelper(repoPath);
  if (result.kind === 'failed') {
    getLog().error(
      { err: result.error, repoPath, owner, repo },
      'github_auth.credential_helper_install_failed'
    );
    throw new Error(
      `GitHub App repository setup requires the credential helper: ${result.error.message}`,
      { cause: result.error }
    );
  }
  getLog().info(
    { repoPath, owner, repo, helperPath: result.helperPath },
    'github_auth.credential_helper_installed'
  );
}
