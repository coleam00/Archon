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
 * No-op in PAT mode (the caller decides whether to invoke this — see the
 * adapter clone path). Source-builds only for this PR; binary builds will
 * ship the script via the embedded-bundle mechanism in a follow-up.
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

/** Idempotent — safe to call from every clone path. */
export async function installCredentialHelper(worktreePath: string): Promise<void> {
  const binDir = resolve(getArchonHome(), 'bin');
  const helperPath = resolve(binDir, 'git-credential-archon');
  if (!existsSync(helperPath)) {
    mkdirSync(binDir, { recursive: true });
    const source = sourceScriptPath();
    if (!existsSync(source)) {
      // Compiled binary: the source script isn't on disk. Skip silently —
      // the credential helper is an optimisation for >1h workflows; clone
      // and short-lived `gh` operations still succeed via the URL-embedded
      // and env-injected installation tokens.
      getLog().warn({ source }, 'github_auth.credential_helper_source_missing_skipping_install');
      return;
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
}
