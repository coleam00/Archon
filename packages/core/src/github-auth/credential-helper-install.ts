/**
 * Install the git credential helper into a cloned worktree so long-running
 * workflows can refresh installation tokens without rewriting the remote URL.
 *
 * Flow:
 *   1. Copy `scripts/git-credential-archon.sh` to `~/.archon/bin/` (idempotent;
 *      copy only on first call).
 *   2. Register the helper on the worktree's git config:
 *      `credential.https://github.com.helper = ~/.archon/bin/git-credential-archon`
 *
 * The caller (the GitHub adapter clone path in App mode) decides whether to
 * invoke this — it's a no-op for PAT-mode operators by virtue of not being
 * called. The function requires the source script to be present on disk; in
 * compiled binary builds that ship without `scripts/` available, the call
 * returns `{ kind: 'skipped', reason: 'source-script-not-on-disk' }` so the
 * caller's log line reflects the real outcome rather than false success.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger, getArchonHome } from '@archon/paths';
import { execFileAsync } from '@archon/git';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('github-auth.credential-helper');
  return cachedLog;
}

/** Repo-root → scripts/git-credential-archon.sh, resolved relative to this file. */
function sourceScriptPath(): string {
  // packages/core/src/github-auth/credential-helper-install.ts
  // ↑ ../../../..                                       repo root
  return resolve(import.meta.dir, '..', '..', '..', '..', 'scripts', 'git-credential-archon.sh');
}

/**
 * Result of installCredentialHelper.
 *
 *   installed:  helper now registered on the worktree's git config
 *   skipped:    no-op for a structural reason (e.g. binary build with no
 *               source script on disk); caller should log accordingly
 *   failed:     unexpected failure during copy / git-config write; the
 *               original error is attached for the caller to forward
 */
export type CredentialHelperInstallResult =
  | { kind: 'installed'; helperPath: string }
  | { kind: 'skipped'; reason: 'source-script-not-on-disk'; sourcePath: string }
  | { kind: 'failed'; error: Error };

/** Idempotent — safe to call from every clone path. Never throws. */
export async function installCredentialHelper(
  worktreePath: string
): Promise<CredentialHelperInstallResult> {
  const binDir = resolve(getArchonHome(), 'bin');
  const helperPath = resolve(binDir, 'git-credential-archon');
  try {
    if (!existsSync(helperPath)) {
      mkdirSync(binDir, { recursive: true });
      const source = sourceScriptPath();
      if (!existsSync(source)) {
        // Compiled binary build that doesn't ship scripts/ on disk. Don't
        // pretend installation succeeded — caller logs 'skipped' instead.
        getLog().warn({ source }, 'github_auth.credential_helper_source_missing');
        return { kind: 'skipped', reason: 'source-script-not-on-disk', sourcePath: source };
      }
      copyFileSync(source, helperPath);
      chmodSync(helperPath, 0o755);
      getLog().info({ helperPath }, 'github_auth.credential_helper_copied');
    }
    // Per-worktree git config write — idempotent on git's side.
    await execFileAsync(
      'git',
      ['-C', worktreePath, 'config', 'credential.https://github.com.helper', helperPath],
      { timeout: 5000 }
    );
    getLog().info({ worktreePath, helperPath }, 'github_auth.credential_helper_registered');
    return { kind: 'installed', helperPath };
  } catch (err) {
    return { kind: 'failed', error: err as Error };
  }
}
