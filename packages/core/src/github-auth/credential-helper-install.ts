/**
 * Install the git credential helper into a cloned worktree so long-running
 * workflows can refresh installation tokens without a token in the remote URL.
 *
 * Flow:
 *   1. Atomically replace the managed credential helper in `~/.archon/bin/`
 *      when its contents are outdated.
 *   2. Register the helper on the worktree's git config:
 *      `credential.https://github.com.helper = ~/.archon/bin/git-credential-archon`
 *      `credential.https://github.com.useHttpPath = true`
 *   3. Strip credentials from the worktree's github.com remote URLs.
 *
 * The caller (the GitHub adapter or URL registration in App mode) decides whether to
 * invoke this — it's a no-op for PAT-mode operators by virtue of not being
 * called. The text import is embedded by Bun, so source and compiled installs
 * use the same helper without depending on the repository's `scripts/` tree.
 */
import { resolve } from 'node:path';
import { createLogger, getArchonHome } from '@archon/paths';
import { execFileAsync } from '@archon/git';
import { credentialHelperScript } from './credential-helper-script';
import { installManagedScript } from './managed-script';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('github-auth.credential-helper');
  return cachedLog;
}

/**
 * Result of installCredentialHelper.
 *
 *   installed:  helper now registered on the worktree's git config
 *   failed:     unexpected failure during copy / git-config write; the
 *               original error is attached for the caller to forward
 */
export type CredentialHelperInstallResult =
  | { kind: 'installed'; helperPath: string }
  | { kind: 'failed'; error: Error };

/**
 * Write the helper to `~/.archon/bin/git-credential-archon` when outdated and
 * return its path. Throws when the script cannot be written.
 */
export function installCredentialHelperScript(): string {
  const helperPath = resolve(getArchonHome(), 'bin', 'git-credential-archon');
  if (installManagedScript(helperPath, credentialHelperScript)) {
    getLog().info({ helperPath }, 'github_auth.credential_helper_updated');
  }
  return helperPath;
}

/**
 * Git takes `.git/config.lock` for each write and fails instead of waiting, so
 * overlapping setup on one repository (the adapter and URL registration both
 * call this) is chained per resolved path.
 */
const pendingInstalls = new Map<string, Promise<CredentialHelperInstallResult>>();

/** Never throws. */
export function installCredentialHelper(
  worktreePath: string
): Promise<CredentialHelperInstallResult> {
  const repoPath = resolve(worktreePath);
  const previous = pendingInstalls.get(repoPath) ?? Promise.resolve();
  const pending = previous
    .then(() => install(repoPath))
    .finally(() => {
      if (pendingInstalls.get(repoPath) === pending) pendingInstalls.delete(repoPath);
    });
  pendingInstalls.set(repoPath, pending);
  return pending;
}

async function install(repoPath: string): Promise<CredentialHelperInstallResult> {
  try {
    const helperPath = installCredentialHelperScript();
    const helperCommand = `!'${helperPath.replaceAll("'", "'\"'\"'")}'`;
    await execFileAsync(
      'git',
      ['-C', repoPath, 'config', 'credential.https://github.com.helper', helperCommand],
      { timeout: 5000 }
    );
    await execFileAsync(
      'git',
      ['-C', repoPath, 'config', 'credential.https://github.com.useHttpPath', 'true'],
      { timeout: 5000 }
    );
    const cleanedKeys = await removeGitHubUrlCredentials(repoPath);
    if (cleanedKeys.length > 0) {
      getLog().info(
        { worktreePath: repoPath, keys: cleanedKeys },
        'github_auth.remote_url_credentials_removed'
      );
    }
    getLog().info(
      { worktreePath: repoPath, helperPath },
      'github_auth.credential_helper_registered'
    );
    return { kind: 'installed', helperPath };
  } catch (err) {
    return { kind: 'failed', error: err as Error };
  }
}

/**
 * Git uses credentials embedded in a remote URL without asking any helper, so
 * a clone made with an older PAT would keep pushing with it. Returns the
 * rewritten config keys; URL-write failures expose only the key and Git exit code.
 */
async function removeGitHubUrlCredentials(repoPath: string): Promise<string[]> {
  const cleanedKeys: string[] = [];
  for (const [key, urls] of await listRemoteUrls(repoPath)) {
    const changed = urls.filter(url => withoutGitHubCredentials(url) !== url);
    if (changed.length === 0) continue;
    for (const url of new Set(changed)) await stripUrlCredentials(repoPath, key, url);
    cleanedKeys.push(key);
  }
  return cleanedKeys;
}

/** Every local `remote.*.url` and `remote.*.pushurl` value, grouped by config key. */
async function listRemoteUrls(repoPath: string): Promise<Map<string, string[]>> {
  let listed: string;
  try {
    ({ stdout: listed } = await execFileAsync(
      'git',
      ['-C', repoPath, 'config', '--local', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'],
      { timeout: 5000 }
    ));
  } catch (err) {
    // Exit 1 means no remote URL is configured.
    if ((err as { code?: unknown }).code === 1) return new Map();
    throw err;
  }
  const urlsByKey = new Map<string, string[]>();
  for (const entry of listed.split('\0')) {
    const newline = entry.indexOf('\n');
    if (newline === -1) continue;
    const key = entry.slice(0, newline);
    urlsByKey.set(key, [...(urlsByKey.get(key) ?? []), entry.slice(newline + 1)]);
  }
  return urlsByKey;
}

async function stripUrlCredentials(repoPath: string, key: string, url: string): Promise<void> {
  try {
    await execFileAsync(
      'git',
      [
        '-C',
        repoPath,
        'config',
        '--local',
        '--fixed-value',
        '--replace-all',
        key,
        withoutGitHubCredentials(url),
        url,
      ],
      { timeout: 5000 }
    );
  } catch (error) {
    // execFile errors contain argv, including the credential-bearing match value.
    // Keep only the structured exit code; never retain the original as a cause.
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    throw new Error(
      `Failed to remove credentials from ${key}` +
        (typeof code === 'number' ? ` (git exit ${code})` : '')
    );
  }
}

function withoutGitHubCredentials(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return url;
  if (!parsed.username && !parsed.password) return url;
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}
