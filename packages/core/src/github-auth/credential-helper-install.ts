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
 * The caller (the GitHub adapter in App mode) decides whether to
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

/** Never throws. The caller serializes setup per repository. */
export async function installCredentialHelper(
  worktreePath: string
): Promise<CredentialHelperInstallResult> {
  const repoPath = resolve(worktreePath);
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

/**
 * Git uses credentials embedded in a remote URL without asking any helper, so
 * a clone made with an older PAT would keep pushing with it. Returns the
 * rewritten config keys; the URLs themselves are never logged.
 */
async function removeGitHubUrlCredentials(repoPath: string): Promise<string[]> {
  let listed: string;
  try {
    ({ stdout: listed } = await execFileAsync(
      'git',
      ['-C', repoPath, 'config', '--local', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'],
      { timeout: 5000 }
    ));
  } catch (err) {
    // Exit 1 means no remote URL is configured.
    if ((err as { code?: unknown }).code === 1) return [];
    throw err;
  }
  const urlsByKey = new Map<string, string[]>();
  for (const entry of listed.split('\0')) {
    const newline = entry.indexOf('\n');
    if (newline === -1) continue;
    const key = entry.slice(0, newline);
    urlsByKey.set(key, [...(urlsByKey.get(key) ?? []), entry.slice(newline + 1)]);
  }
  const cleanedKeys: string[] = [];
  for (const [key, urls] of urlsByKey) {
    const cleaned = urls.map(withoutGitHubCredentials);
    if (cleaned.every((url, index) => url === urls[index])) continue;
    // A failure message repeats argv; its GitHub URLs are already cleaned.
    const [first, ...rest] = cleaned;
    await execFileAsync('git', ['-C', repoPath, 'config', '--local', '--replace-all', key, first], {
      timeout: 5000,
    });
    for (const url of rest) {
      await execFileAsync('git', ['-C', repoPath, 'config', '--local', '--add', key, url], {
        timeout: 5000,
      });
    }
    cleanedKeys.push(key);
  }
  return cleanedKeys;
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
