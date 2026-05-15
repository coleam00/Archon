import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '@archon/paths';
import type { ClaudeCreds, RefreshResult } from './types.js';
import {
  acquireRefreshLock,
  atomicWriteJson,
  classifyRefreshFailure,
  redactError,
} from './shared.js';

const CLAUDE_REFRESH_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_USER_AGENT = 'claude-cli/2.1.121';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.auth-refresh');
  return cachedLog;
}

function credentialsPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

function readCreds(filePath: string): ClaudeCreds | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ClaudeCreds;
}

function freshExpiresAt(filePath: string): number | undefined {
  const creds = readCreds(filePath);
  const expiresAt = creds?.claudeAiOauth?.expiresAt;
  return typeof expiresAt === 'number' && expiresAt > Date.now() ? expiresAt : undefined;
}

export async function refreshClaude(): Promise<RefreshResult> {
  const filePath = credentialsPath();
  const creds = readCreds(filePath);
  if (!creds) return { refreshed: false, reason: 'no_creds' };
  if (!creds.claudeAiOauth?.refreshToken) {
    return { refreshed: false, reason: 'no_refresh_token' };
  }

  const alreadyFresh = freshExpiresAt(filePath);
  if (alreadyFresh !== undefined) {
    getLog().debug(
      { provider: 'claude', expiresAtISO: new Date(alreadyFresh).toISOString() },
      'token_refresh_skipped_already_fresh'
    );
    return { refreshed: true, expiresAt: alreadyFresh };
  }

  const lockPath = path.join(os.homedir(), '.claude', '.refresh.lock');
  const lockResult = await acquireRefreshLock(
    lockPath,
    () => freshExpiresAt(filePath),
    lockAgeMs => {
      getLog().debug({ provider: 'claude', lockAgeMs }, 'token_refresh_waiting_for_lock');
    },
    staleAgeMs => {
      getLog().warn({ provider: 'claude', staleAgeMs }, 'token_refresh_lock_stale_forced');
    }
  );
  if (lockResult.refreshedByOther !== undefined) {
    return { refreshed: true, expiresAt: lockResult.refreshedByOther };
  }

  const lock = lockResult.handle;
  try {
    const lockedCreds = readCreds(filePath);
    if (!lockedCreds) return { refreshed: false, reason: 'no_creds' };
    const oauth = lockedCreds.claudeAiOauth;
    if (!oauth?.refreshToken) return { refreshed: false, reason: 'no_refresh_token' };

    const lockedFresh = freshExpiresAt(filePath);
    if (lockedFresh !== undefined) return { refreshed: true, expiresAt: lockedFresh };

    getLog().info({ provider: 'claude', lockHeld: true }, 'token_refresh_attempt');
    const resp = await fetch(CLAUDE_REFRESH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': CLAUDE_USER_AGENT,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      const reason = classifyRefreshFailure(body, resp.status);
      getLog().error(
        { provider: 'claude', reason, statusCode: resp.status },
        'token_refresh_failed'
      );
      return { refreshed: false, reason };
    }

    const data = (await resp.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    if (
      typeof data.access_token !== 'string' ||
      typeof data.refresh_token !== 'string' ||
      typeof data.expires_in !== 'number'
    ) {
      const error = new Error('OAuth response missing required fields');
      getLog().error(
        {
          provider: 'claude',
          reason: 'unknown',
          missing: {
            access_token: typeof data.access_token !== 'string',
            refresh_token: typeof data.refresh_token !== 'string',
            expires_in: typeof data.expires_in !== 'number',
          },
        },
        'token_refresh_failed'
      );
      return { refreshed: false, reason: 'unknown', error };
    }

    const expiresAt = Date.now() + data.expires_in * 1000;
    const newCreds: ClaudeCreds = {
      ...lockedCreds,
      claudeAiOauth: {
        ...oauth,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
      },
    };
    atomicWriteJson(filePath, newCreds, 0o600);
    getLog().info(
      {
        provider: 'claude',
        newExpiresAtISO: new Date(expiresAt).toISOString(),
        validForHours: data.expires_in / 3600,
      },
      'token_refresh_success'
    );
    return { refreshed: true, expiresAt };
  } catch (error) {
    const redacted = redactError(error);
    getLog().error(
      { provider: 'claude', reason: 'network', err: redacted },
      'token_refresh_failed'
    );
    return { refreshed: false, reason: 'network', error: redacted };
  } finally {
    lock?.release();
  }
}
