/**
 * Install the git credential helper into a cloned worktree so long-running
 * workflows can refresh installation tokens without rewriting the remote URL.
 *
 * Flow:
 *   1. Atomically replace the managed credential helper in `~/.archon/bin/`.
 *   2. Register the helper on the worktree's git config:
 *      `credential.https://github.com.helper = ~/.archon/bin/git-credential-archon`
 *      `credential.https://github.com.useHttpPath = true`
 *
 * The caller (the GitHub adapter repository setup in App mode) decides whether to
 * invoke this — it's a no-op for PAT-mode operators by virtue of not being
 * called. The text import is embedded by Bun, so source and compiled installs
 * use the same helper without depending on the repository's `scripts/` tree.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

const pendingInstalls = new Map<string, Promise<CredentialHelperInstallResult>>();

/** Concurrent setup shares registration; completed attempts can be retried. Never throws. */
export function installCredentialHelper(
  worktreePath: string
): Promise<CredentialHelperInstallResult> {
  const repoPath = resolve(worktreePath);
  const pending = pendingInstalls.get(repoPath);
  if (pending) return pending;
  const installation = registerCredentialHelper(repoPath).finally(() => {
    pendingInstalls.delete(repoPath);
  });
  pendingInstalls.set(repoPath, installation);
  return installation;
}

async function registerCredentialHelper(
  worktreePath: string
): Promise<CredentialHelperInstallResult> {
  const binDir = resolve(getArchonHome(), 'bin');
  const helperPath = resolve(binDir, 'git-credential-archon');
  const helperCommand = `!'${helperPath.replaceAll("'", "'\"'\"'")}'`;
  const tempPath = resolve(binDir, `git-credential-archon.${randomUUID()}.tmp`);
  try {
    mkdirSync(binDir, { recursive: true });
    try {
      writeFileSync(tempPath, credentialHelperScript, { flag: 'wx' });
      chmodSync(tempPath, 0o755);
      renameSync(tempPath, helperPath);
    } finally {
      rmSync(tempPath, { force: true });
    }
    getLog().info({ helperPath }, 'github_auth.credential_helper_updated');
    await execFileAsync(
      'git',
      ['-C', worktreePath, 'config', 'credential.https://github.com.helper', helperCommand],
      { timeout: 5000 }
    );
    await execFileAsync(
      'git',
      ['-C', worktreePath, 'config', 'credential.https://github.com.useHttpPath', 'true'],
      { timeout: 5000 }
    );
    getLog().info({ worktreePath, helperPath }, 'github_auth.credential_helper_registered');
    return { kind: 'installed', helperPath };
  } catch (err) {
    return { kind: 'failed', error: err as Error };
  }
}
