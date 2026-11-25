import type { components } from '@/lib/api.generated';
import type { PollStep } from '../primitives/github';
export type { PollStep } from '../primitives/github';
import { requestJson } from '../lib/http';

/**
 * Per-user GitHub identity (device flow). `getConnection` 401s when there's no web
 * identity (no Better Auth session and no X-Archon-User) — the solo-PAT state, and
 * also a logged-out user on a web-auth install — which the panel reads as "hide".
 */

export type GithubConnectionStatus = components['schemas']['GithubConnectionStatus'];

export type GithubDeviceStart = components['schemas']['GithubDeviceStartResponse'];

export type GithubDevicePoll = components['schemas']['GithubDevicePollResponse'];

export function getGithubConnection(): Promise<GithubConnectionStatus> {
  return requestJson('/api/auth/github', 'get');
}

export function startGithubDeviceFlow(): Promise<GithubDeviceStart> {
  return requestJson('/api/auth/github/device/start', 'post');
}

export function pollGithubDeviceFlow(deviceCode: string): Promise<GithubDevicePoll> {
  return requestJson('/api/auth/github/device/poll', 'post', { body: { device_code: deviceCode } });
}

export function disconnectGithub(): Promise<components['schemas']['SuccessResponse']> {
  return requestJson('/api/auth/github', 'delete');
}

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
      return { kind: 'failed', message: `Unexpected GitHub poll status: ${String(res.status)}` };
  }
}
