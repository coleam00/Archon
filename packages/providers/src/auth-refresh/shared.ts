import fs from 'fs';
import path from 'path';
import type { LockHandle, RefreshFailureReason } from './types.js';

const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 500;
const ANTHROPIC_TOKEN_PREFIX = ['sk', 'ant'].join('-');
const OPENAI_OAUTH_TOKEN_PREFIX = ['oa', 't0'].join('');
const OPENAI_KEY_PREFIX = ['s', 'k'].join('-');

export function redactError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(new RegExp(`${ANTHROPIC_TOKEN_PREFIX}-[A-Za-z0-9_-]+`, 'g'), '[REDACTED_TOKEN]')
    .replace(new RegExp(`${OPENAI_OAUTH_TOKEN_PREFIX}[A-Za-z0-9_-]+`, 'g'), '[REDACTED_TOKEN]')
    .replace(new RegExp(`${OPENAI_KEY_PREFIX}[A-Za-z0-9_-]+`, 'g'), '[REDACTED_TOKEN]');
  return new Error(redacted);
}

export function classifyRefreshFailure(body: string, status: number): RefreshFailureReason {
  if (body.includes('refresh_token_expired')) return 'refresh_expired';
  if (body.includes('refresh_token_already_used')) return 'refresh_reused';
  if (body.includes('refresh_token_revoked')) return 'refresh_revoked';
  if (body.includes('invalid_grant')) return 'refresh_expired';
  if (body.includes('invalid_client')) return 'unknown';
  if (status >= 500) return 'network';
  return 'unknown';
}

export function isTerminalRefreshReason(reason: RefreshFailureReason): boolean {
  return (
    reason === 'refresh_expired' || reason === 'refresh_reused' || reason === 'refresh_revoked'
  );
}

export function buildReauthMessage(
  provider: 'claude' | 'codex',
  reason: RefreshFailureReason
): string {
  if (provider === 'claude') {
    return (
      `Cauldron auth for claude is dead (reason: ${reason}). Re-authenticate by running:\n\n` +
      "  ssh hetzner-prod 'sudo docker exec -it archon-app-1 " +
      "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /login'"
    );
  }
  return `Cauldron auth for codex is dead (reason: ${reason}). Re-authenticate with the Codex CLI in archon-app-1 and refresh /home/appuser/.codex/auth.json.`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readLockAgeMs(lockPath: string): number | undefined {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as { acquiredAt?: string };
    if (!parsed.acquiredAt) return undefined;
    const ageMs = Date.now() - new Date(parsed.acquiredAt).getTime();
    return Number.isFinite(ageMs) ? ageMs : undefined;
  } catch {
    return undefined;
  }
}

export async function acquireRefreshLock(
  lockPath: string,
  isFresh: () => number | undefined,
  onWaiting?: (lockAgeMs: number | undefined) => void,
  onStale?: (staleAgeMs: number | undefined) => void
): Promise<{ handle?: LockHandle; refreshedByOther?: number }> {
  const start = Date.now();

  while (Date.now() - start <= LOCK_STALE_MS) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })
      );
      fs.closeSync(fd);
      return {
        handle: {
          path: lockPath,
          release(): void {
            try {
              fs.unlinkSync(lockPath);
            } catch {
              // Best-effort cleanup. Stale lock handling covers process death/races.
            }
          },
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      const lockAgeMs = readLockAgeMs(lockPath);
      if (lockAgeMs === undefined || lockAgeMs > LOCK_STALE_MS) {
        onStale?.(lockAgeMs);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Race: another caller may remove it first. Loop and retry.
        }
        continue;
      }

      onWaiting?.(lockAgeMs);
      const freshExpiresAt = isFresh();
      if (freshExpiresAt !== undefined) return { refreshedByOther: freshExpiresAt };
      await sleep(LOCK_POLL_MS);
    }
  }

  const staleAgeMs = readLockAgeMs(lockPath);
  onStale?.(staleAgeMs);
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Race-safe.
  }
  return acquireRefreshLock(lockPath, isFresh, onWaiting, onStale);
}

export function atomicWriteJson(filePath: string, payload: unknown, mode = 0o600): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { mode });
  const fd = fs.openSync(tmpPath, 'r');
  try {
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EINVAL') throw error;
      // Bun/Windows can reject fsync on temp files. Linux containers still fsync,
      // which is the production safety target for Cauldron credential writes.
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  fs.chmodSync(filePath, mode);
}
