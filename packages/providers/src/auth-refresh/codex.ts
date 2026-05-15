import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '@archon/paths';
import type { CodexCreds, RefreshResult } from './types.js';
import {
  acquireRefreshLock,
  atomicWriteJson,
  classifyRefreshFailure,
  redactError,
} from './shared.js';

const CODEX_REFRESH_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = ['app', 'EMoamEEZ73f0CkXaXp7hran'].join('_');

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.auth-refresh');
  return cachedLog;
}

function credentialsPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

function readCreds(filePath: string): CodexCreds | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CodexCreds;
}

function freshLastRefresh(filePath: string): number | undefined {
  const creds = readCreds(filePath);
  const lastRefresh = creds?.last_refresh ? new Date(creds.last_refresh).getTime() : NaN;
  const hasTokens = Boolean(creds?.tokens?.access_token && creds.tokens.refresh_token);
  if (!hasTokens || !Number.isFinite(lastRefresh)) return undefined;
  const ageMs = Date.now() - lastRefresh;
  return ageMs >= 0 && ageMs < 30_000 ? Date.now() + 1 : undefined;
}

export async function refreshCodex(): Promise<RefreshResult> {
  const filePath = credentialsPath();
  const creds = readCreds(filePath);
  if (!creds) return { refreshed: false, reason: 'no_creds' };
  if (!creds.tokens?.refresh_token) return { refreshed: false, reason: 'no_refresh_token' };

  const lockPath = path.join(os.homedir(), '.codex', '.refresh.lock');
  const lockResult = await acquireRefreshLock(
    lockPath,
    () => freshLastRefresh(filePath),
    lockAgeMs => {
      getLog().debug({ provider: 'codex', lockAgeMs }, 'token_refresh_waiting_for_lock');
    },
    staleAgeMs => {
      getLog().warn({ provider: 'codex', staleAgeMs }, 'token_refresh_lock_stale_forced');
    }
  );
  if (lockResult.refreshedByOther !== undefined) {
    return { refreshed: true, expiresAt: lockResult.refreshedByOther };
  }

  const lock = lockResult.handle;
  try {
    const lockedCreds = readCreds(filePath);
    if (!lockedCreds) return { refreshed: false, reason: 'no_creds' };
    const tokens = lockedCreds.tokens;
    if (!tokens?.refresh_token) return { refreshed: false, reason: 'no_refresh_token' };

    const refreshedByOther = freshLastRefresh(filePath);
    if (refreshedByOther !== undefined) return { refreshed: true, expiresAt: refreshedByOther };

    getLog().info({ provider: 'codex', lockHeld: true }, 'token_refresh_attempt');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: CODEX_CLIENT_ID,
    }).toString();
    const resp = await fetch(CODEX_REFRESH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!resp.ok) {
      const responseBody = await resp.text();
      const reason = classifyRefreshFailure(responseBody, resp.status);
      getLog().error(
        { provider: 'codex', reason, statusCode: resp.status },
        'token_refresh_failed'
      );
      return { refreshed: false, reason };
    }

    const data = (await resp.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      id_token?: unknown;
    };
    if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
      const error = new Error('OAuth response missing required fields');
      getLog().error(
        {
          provider: 'codex',
          reason: 'unknown',
          missing: {
            access_token: typeof data.access_token !== 'string',
            refresh_token: typeof data.refresh_token !== 'string',
          },
        },
        'token_refresh_failed'
      );
      return { refreshed: false, reason: 'unknown', error };
    }

    const newCreds: CodexCreds = {
      ...lockedCreds,
      tokens: {
        ...tokens,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        ...(typeof data.id_token === 'string' ? { id_token: data.id_token } : {}),
      },
      last_refresh: new Date().toISOString(),
    };
    atomicWriteJson(filePath, newCreds, 0o600);
    getLog().info(
      { provider: 'codex', newExpiresAtISO: newCreds.last_refresh, validForHours: undefined },
      'token_refresh_success'
    );
    return { refreshed: true, expiresAt: Date.now() + 1 };
  } catch (error) {
    const redacted = redactError(error);
    getLog().error({ provider: 'codex', reason: 'network', err: redacted }, 'token_refresh_failed');
    return { refreshed: false, reason: 'network', error: redacted };
  } finally {
    lock?.release();
  }
}
