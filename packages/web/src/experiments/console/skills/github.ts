import { requestJson } from '../lib/http';

/**
 * Per-user GitHub identity (device flow). `getConnection` 401s when there's no web
 * identity (no Better Auth session and no X-Archon-User) — the solo-PAT state, and
 * also a logged-out user on a web-auth install — which the panel reads as "hide".
 *
 * Response types are inlined (mirroring `server/.../auth.schemas.ts`) because the
 * device-flow schemas are not yet in `@/lib/api.generated`, and `@/lib/api` is
 * eslint-blocked for the console. Migrate to `components['schemas']['Github*']`
 * once a regen lands them.
 */

export interface GithubConnectionStatus {
  connected: boolean;
  githubLogin: string | null;
}

export interface GithubDeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export interface GithubDevicePoll {
  status: 'pending' | 'connected' | 'expired' | 'denied' | 'error';
  githubLogin?: string;
  detail?: string;
}

export function getGithubConnection(): Promise<GithubConnectionStatus> {
  return requestJson<GithubConnectionStatus>('/api/auth/github');
}

export function startGithubDeviceFlow(): Promise<GithubDeviceStart> {
  return requestJson<GithubDeviceStart>('/api/auth/github/device/start', { method: 'POST' });
}

export function pollGithubDeviceFlow(deviceCode: string): Promise<GithubDevicePoll> {
  return requestJson<GithubDevicePoll>('/api/auth/github/device/poll', {
    method: 'POST',
    body: JSON.stringify({ device_code: deviceCode }),
  });
}

export function disconnectGithub(): Promise<{ success: boolean }> {
  return requestJson<{ success: boolean }>('/api/auth/github', { method: 'DELETE' });
}

/** The poll loop's next action: stop (connected), keep polling, or fail with a message. */
export type PollStep =
  | { kind: 'connected' }
  | { kind: 'retry'; nextInterval: number }
  | { kind: 'failed'; message: string };

/**
 * Pure interpretation of a single device-flow poll response (ported from the old
 * UI's inline branch logic). `pending` keeps the current interval; a transient
 * `error` with no detail backs off by 2s and retries; everything else is terminal.
 */
export function interpretPollStatus(res: GithubDevicePoll, interval: number): PollStep {
  switch (res.status) {
    case 'connected':
      return { kind: 'connected' };
    case 'pending':
      return { kind: 'retry', nextInterval: interval };
    case 'expired':
      return { kind: 'failed', message: 'Device code expired — try again.' };
    case 'denied':
      return { kind: 'failed', message: 'Authorization was denied.' };
    case 'error':
      return res.detail !== undefined && res.detail !== ''
        ? { kind: 'failed', message: `GitHub connect failed: ${res.detail}` }
        : { kind: 'retry', nextInterval: interval + 2 };
    default:
      // Defensive: the inline type can lag the server. Treat an unrecognized status
      // as a terminal failure rather than crashing the poll loop on `undefined.kind`.
      return { kind: 'failed', message: `Unexpected GitHub poll status: ${String(res.status)}` };
  }
}
