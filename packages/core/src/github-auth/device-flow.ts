/**
 * GitHub App device flow (user-to-server tokens), hand-rolled over `fetch`.
 *
 * Design notes:
 *  - No `client_secret`: the device flow is a public-client flow, and refresh
 *    of device-flow-issued tokens also needs no secret.
 *  - No OAuth `scope`: GitHub Apps derive permissions from the App's
 *    fine-grained permission set, not OAuth scopes. `scope` is always "".
 *  - Error responses arrive as HTTP 200 with an `{ error }` field — callers
 *    must inspect the body, not just the status code.
 *
 * Ref: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token
 */

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DeviceAccessToken {
  access_token: string;
  token_type: string;
  scope: string;
  /** Present only when the App has "Expire user authorization tokens" enabled. */
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

export interface GithubUserProfile {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

/**
 * Discriminator for the terminal/recoverable device-flow error states. `code`
 * is the raw `error` string from GitHub (e.g. `access_denied`, `expired_token`,
 * `slow_down`) or an Archon-raised code (`aborted`, `http_error`,
 * `user_fetch_failed`). Left as `string` because the upstream set is not frozen.
 */
export class DeviceFlowError extends Error {
  constructor(
    public readonly code: string,
    message?: string
  ) {
    super(message ?? `GitHub device flow error: ${code}`);
    this.name = 'DeviceFlowError';
  }
}

async function postForm<T>(url: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    // GitHub returns actionable detail in the body even on non-2xx (e.g.
    // {"error":"invalid_client","error_description":"..."}). Surface it so a
    // misconfigured client id reads as more than a bare "HTTP 401".
    let detail = '';
    try {
      const body = (await res.json()) as { error_description?: string; error?: string };
      detail = body.error_description ?? body.error ?? '';
    } catch {
      // Body was not JSON — fall back to the status line only.
    }
    throw new DeviceFlowError(
      'http_error',
      `GitHub device flow returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
  return (await res.json()) as T;
}

/** Step 1: request device + user codes. */
export async function startDeviceFlow(clientId: string): Promise<DeviceCodeResponse> {
  const data = await postForm<DeviceCodeResponse & { error?: string }>(DEVICE_CODE_URL, {
    client_id: clientId,
  });
  if (data.error) throw new DeviceFlowError(data.error);
  return data;
}

export interface PollOptions {
  signal?: AbortSignal;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Step 2: poll until the user authorizes. Handles `authorization_pending`
 * (keep waiting) and `slow_down` (back off using the server-supplied interval).
 * Any other `error` is terminal and thrown as a DeviceFlowError.
 */
export async function pollDeviceFlow(
  clientId: string,
  deviceCode: string,
  intervalSeconds: number,
  opts: PollOptions = {}
): Promise<DeviceAccessToken> {
  const sleep = opts.sleep ?? defaultSleep;
  let interval = Math.max(1, intervalSeconds);
  for (;;) {
    if (opts.signal?.aborted) {
      throw new DeviceFlowError('aborted', 'Device flow polling was aborted');
    }
    await sleep(interval * 1000);
    const result = await pollDeviceFlowOnce(clientId, deviceCode);
    if (result.status === 'authorized') return result.token;
    if (result.status === 'pending') continue;
    if (result.status === 'slow_down') {
      // Honor the server's new interval, else keep the current. Floor at 1s so a
      // malformed `interval: 0` can't turn this into a busy loop.
      interval = Math.max(1, result.interval);
      continue;
    }
    throw new DeviceFlowError(result.code);
  }
}

/** Result of a single (non-blocking) device-flow poll. */
export type PollOnceResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'authorized'; token: DeviceAccessToken }
  | { status: 'error'; code: string };

/**
 * One non-blocking poll attempt. Used by the web endpoint (which polls from the
 * browser) and internally by {@link pollDeviceFlow}'s blocking loop.
 */
export async function pollDeviceFlowOnce(
  clientId: string,
  deviceCode: string
): Promise<PollOnceResult> {
  const data = await postForm<DeviceAccessToken & { error?: string; interval?: number }>(
    ACCESS_TOKEN_URL,
    {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }
  );
  if (!data.error) return { status: 'authorized', token: data };
  if (data.error === 'authorization_pending') return { status: 'pending' };
  if (data.error === 'slow_down') return { status: 'slow_down', interval: data.interval ?? 5 };
  return { status: 'error', code: data.error };
}

/** Exchange a refresh token for a fresh access/refresh pair (no client_secret). */
export async function refreshUserToken(
  clientId: string,
  refreshToken: string
): Promise<DeviceAccessToken> {
  const data = await postForm<DeviceAccessToken & { error?: string }>(ACCESS_TOKEN_URL, {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (data.error) throw new DeviceFlowError(data.error);
  return data;
}

/** Fetch the authenticated user's profile (id is the no-reply-email anchor). */
export async function fetchGithubUser(accessToken: string): Promise<GithubUserProfile> {
  const res = await fetch(USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'archon',
    },
  });
  if (!res.ok) {
    throw new DeviceFlowError('user_fetch_failed', `GET /user returned HTTP ${res.status}`);
  }
  const raw = (await res.json()) as {
    id: number;
    login: string;
    name?: string | null;
    email?: string | null;
  };
  return { id: raw.id, login: raw.login, name: raw.name ?? null, email: raw.email ?? null };
}
