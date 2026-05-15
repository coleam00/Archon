import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '@archon/paths';
import { resolveCodexBinaryPath } from './binary-resolver';
import type { CodexCreds } from '../auth-refresh/types.js';

const SOFT_REFRESH_TIMEOUT_MS = 10_000;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex.soft-refresh');
  return cachedLog;
}

function credentialsPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

function readLastRefresh(filePath: string): number | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CodexCreds;
    const lastRefreshStr = parsed.last_refresh;
    if (!lastRefreshStr) return undefined;
    const ms = new Date(lastRefreshStr).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Codex soft-refresh (Layer 4).
 *
 * OpenAI's documented refresh pattern (developers.openai.com/codex/auth/ci-cd-auth)
 * is "run Codex and persist the updated auth.json" — explicitly NOT "call the
 * refresh API yourself." This function honors that guidance by letting the
 * Codex binary run its internal OAuth refresh path on a cheap invocation,
 * then checking whether auth.json.last_refresh advanced.
 *
 * Returns:
 *   true  — the binary advanced last_refresh (it self-refreshed). Caller can
 *           skip the manual direct-POST refresh path.
 *   false — last_refresh did not advance (the binary didn't refresh, or it
 *           failed silently). Caller should fall back to refreshIfAuthFailed.
 *
 * Never throws. Spawn failures, timeouts, and parse errors all return false.
 */
export async function softRefreshCodex(): Promise<boolean> {
  const filePath = credentialsPath();
  const before = readLastRefresh(filePath);
  if (before === undefined) {
    // No auth.json or no last_refresh field — nothing for soft-refresh to do.
    return false;
  }

  getLog().info({ provider: 'codex' }, 'codex_soft_refresh_attempt');

  let binaryPath: string | undefined;
  try {
    binaryPath = await resolveCodexBinaryPath();
  } catch (err) {
    getLog().warn(
      { provider: 'codex', err: (err as Error).message },
      'codex_soft_refresh_binary_unresolved'
    );
    return false;
  }
  if (!binaryPath) {
    getLog().warn({ provider: 'codex' }, 'codex_soft_refresh_binary_unresolved');
    return false;
  }

  const exitCode = await new Promise<number | null>(resolve => {
    let settled = false;
    const child = spawn(binaryPath, ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env },
    });
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // best-effort
        }
        resolve(null);
      }
    }, SOFT_REFRESH_TIMEOUT_MS);
    child.once('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(null);
      }
    });
    child.once('exit', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(code);
      }
    });
  });

  if (exitCode === null || exitCode !== 0) {
    getLog().warn({ provider: 'codex', exitCode }, 'codex_soft_refresh_failed_spawn');
    return false;
  }

  const after = readLastRefresh(filePath);
  if (after === undefined || after <= before) {
    // Binary ran but did not advance last_refresh — either auth was already
    // fresh AND a no-op command like `--version` doesn't touch the auth
    // manager, OR the binary tried to refresh and failed silently. Either
    // way, caller falls back to refreshIfAuthFailed.
    return false;
  }

  getLog().info(
    {
      provider: 'codex',
      lastRefreshBeforeISO: new Date(before).toISOString(),
      lastRefreshAfterISO: new Date(after).toISOString(),
    },
    'codex_soft_refresh_succeeded'
  );
  return true;
}
