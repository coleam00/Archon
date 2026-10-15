/**
 * Install the git credential helper into a cloned worktree so long-running
 * workflows can refresh installation tokens without rewriting the remote URL.
 *
 * Flow:
 *   1. Atomically replace the managed credential helper in `~/.archon/bin/`
 *      when its contents are outdated.
 *   2. Register the helper on the worktree's git config:
 *      `credential.https://github.com.helper = ~/.archon/bin/git-credential-archon`
 *      `credential.https://github.com.useHttpPath = true`
 *
 * The caller (the GitHub adapter or URL registration in App mode) decides whether to
 * invoke this — it's a no-op for PAT-mode operators by virtue of not being
 * called. The text import is embedded by Bun, so source and compiled installs
 * use the same helper without depending on the repository's `scripts/` tree.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger, getArchonHome } from '@archon/paths';
import { execFileAsync } from '@archon/git';
import { credentialHelperScript } from './credential-helper-script';

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
  const binDir = resolve(getArchonHome(), 'bin');
  const helperPath = resolve(binDir, 'git-credential-archon');
  const helperCommand = `!'${helperPath.replaceAll("'", "'\"'\"'")}'`;
  try {
    if (!isCurrentHelper(helperPath)) {
      mkdirSync(binDir, { recursive: true });
      const tempPath = resolve(binDir, `git-credential-archon.${randomUUID()}.tmp`);
      try {
        writeFileSync(tempPath, credentialHelperScript, { flag: 'wx' });
        chmodSync(tempPath, 0o755);
        renameSync(tempPath, helperPath);
      } finally {
        rmSync(tempPath, { force: true });
      }
      getLog().info({ helperPath }, 'github_auth.credential_helper_updated');
    }
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
 * Windows cannot rename over a file another process holds open, and a running
 * helper keeps its script open. Rewriting only outdated copies keeps routine
 * setup from failing while another worktree's Git fetches credentials.
 */
function isCurrentHelper(helperPath: string): boolean {
  try {
    return readFileSync(helperPath, 'utf8') === credentialHelperScript;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
