import { setTimeout as sleep } from 'node:timers/promises';
import { COPILOT_POLICY_MODEL_IDS } from './copilot-policy-models.generated';
import {
  credentialString,
  oauthRequest,
  subscriptionTokenRequest,
  oauthResponse,
  oauthJson,
  SubscriptionOAuthError,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
  type SubscriptionOAuthCredentials,
} from './subscription-oauth';
import type { OAuthCredentials } from './delivery';

const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};

function enterpriseDomain(input: unknown): string | undefined {
  if (input === undefined || input === '') return undefined;
  if (typeof input !== 'string')
    throw new SubscriptionOAuthError('Invalid GitHub Enterprise domain.');
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    throw new SubscriptionOAuthError('Invalid GitHub Enterprise domain.');
  }
}

function apiBaseUrl(token: string, domain?: string): string {
  // proxy-ep is a machine field in Copilot's bearer, not vendor error prose.
  const proxy = token
    .split(';')
    .find(field => field.startsWith('proxy-ep='))
    ?.slice('proxy-ep='.length);
  if (proxy) return `https://${proxy.replace(/^proxy\./, 'api.')}`;
  return domain ? `https://copilot-api.${domain}` : 'https://api.individual.githubcopilot.com';
}

async function requestWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  retries: number
): Promise<Response> {
  const deadline = Date.now() + 5000;
  for (let retry = 0; ; retry++) {
    try {
      return await oauthResponse(
        url,
        {
          ...init,
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(retries > 0 ? Math.max(1, deadline - Date.now()) : 5000),
          ]),
        },
        'Copilot model policy'
      );
    } catch (error) {
      if (!(error instanceof SubscriptionOAuthError) || error.status !== 429 || retry >= retries)
        throw error;
      const seconds = error.retryAfter ? Number.parseFloat(error.retryAfter) : NaN;
      const delay = Math.max(
        0,
        error.retryAfter
          ? Number.isNaN(seconds)
            ? Date.parse(error.retryAfter) - Date.now()
            : seconds * 1000
          : 500 * 2 ** retry
      );
      if (!Number.isFinite(delay)) throw error;
      if (Date.now() + delay >= deadline) throw error;
      await sleep(delay, undefined, { signal });
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function models(
  token: string,
  domain: string | undefined,
  signal: AbortSignal,
  retries: number
): Promise<{ available: string[]; policy: string[] }> {
  const baseUrl = apiBaseUrl(token, domain);
  const response = await requestWithRetry(
    `${baseUrl}/models`,
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...HEADERS,
        'X-GitHub-Api-Version': '2026-06-01',
      },
    },
    signal,
    retries
  );
  const raw = await oauthJson(response, 'Copilot models');
  if (!Array.isArray(raw.data))
    throw new SubscriptionOAuthError('Invalid Copilot models response.');
  const catalog = raw.data.flatMap((value: unknown) => {
    const item = record(value);
    if (
      !item ||
      typeof item.id !== 'string' ||
      record(record(item.capabilities)?.supports)?.tool_calls === false
    )
      return [];
    return [
      {
        id: item.id,
        picker: item.model_picker_enabled === true,
        policy: record(item.policy)?.state,
      },
    ];
  });
  const picker = catalog
    .filter(model => model.picker && model.policy !== 'disabled')
    .map(model => model.id);
  const fallback = baseUrl === 'https://api.individual.githubcopilot.com' && picker.length === 0;
  return {
    available: fallback
      ? catalog.filter(model => model.policy === 'enabled').map(model => model.id)
      : picker,
    policy: catalog
      .filter(
        model =>
          model.policy === 'unconfigured' &&
          COPILOT_POLICY_MODEL_IDS.includes(model.id) &&
          (model.picker || fallback)
      )
      .map(model => model.id),
  };
}

async function refreshAccess(
  credentials: OAuthCredentials,
  signal: AbortSignal
): Promise<SubscriptionOAuthCredentials> {
  const refresh = credentialString(credentials, 'refresh');
  const domain = enterpriseDomain(credentials.enterpriseUrl);
  const data = await subscriptionTokenRequest(
    `https://api.${domain ?? 'github.com'}/copilot_internal/v2/token`,
    {
      headers: { Accept: 'application/json', Authorization: `Bearer ${refresh}`, ...HEADERS },
      signal,
    },
    'Copilot token'
  );
  if (
    typeof data.token !== 'string' ||
    !data.token ||
    typeof data.expires_at !== 'number' ||
    !Number.isFinite(data.expires_at)
  )
    throw new SubscriptionOAuthError('Invalid Copilot token response.');
  return {
    ...credentials,
    type: 'oauth',
    refresh,
    access: data.token,
    expires: data.expires_at * 1000 - 300_000,
    enterpriseUrl: domain,
  };
}

async function login(callbacks: OAuthLoginCallbacks): Promise<SubscriptionOAuthCredentials> {
  const signal = callbacks.signal ?? new AbortController().signal;
  const domain = enterpriseDomain(
    await callbacks.onPrompt({
      type: 'text',
      message: 'GitHub Enterprise URL/domain (blank for github.com)',
    })
  );
  signal.throwIfAborted();
  const formRequest = (
    path: string,
    body: Record<string, string>
  ): Promise<Record<string, unknown>> =>
    oauthRequest(
      `https://${domain ?? 'github.com'}/login/${path}`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': HEADERS['User-Agent'],
        },
        body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
        signal,
      },
      'Copilot device authorization'
    );
  const device = await formRequest('device/code', { scope: 'read:user' });
  if (
    typeof device.device_code !== 'string' ||
    !device.device_code ||
    typeof device.user_code !== 'string' ||
    typeof device.verification_uri !== 'string' ||
    typeof device.expires_in !== 'number' ||
    !Number.isFinite(device.expires_in) ||
    (device.interval !== undefined &&
      (typeof device.interval !== 'number' || !Number.isFinite(device.interval)))
  )
    throw new SubscriptionOAuthError('Invalid Copilot device code response.');
  let verification: URL;
  try {
    verification = new URL(device.verification_uri);
  } catch {
    throw new SubscriptionOAuthError('Invalid Copilot verification URL.');
  }
  if (verification.protocol !== 'https:' && verification.protocol !== 'http:')
    throw new SubscriptionOAuthError('Invalid Copilot verification URL.');
  callbacks.onDeviceCode({ userCode: device.user_code, verificationUri: verification.href });
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = Math.max(1000, (typeof device.interval === 'number' ? device.interval : 5) * 1000);
  let githubToken: string | undefined;
  while (Date.now() < deadline) {
    await sleep(Math.min(interval, deadline - Date.now()), undefined, { signal });
    if (Date.now() >= deadline) break;
    const result = await formRequest('oauth/access_token', {
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (typeof result.access_token === 'string' && result.access_token) {
      githubToken = result.access_token;
      break;
    }
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') {
      interval =
        typeof result.interval === 'number' &&
        Number.isFinite(result.interval) &&
        result.interval > 0
          ? Math.max(1000, result.interval * 1000)
          : interval + 5000;
      continue;
    }
    throw new SubscriptionOAuthError('Copilot device authorization failed.');
  }
  if (!githubToken) throw new SubscriptionOAuthError('Copilot device authorization timed out.');
  const credentials = await refreshAccess({ refresh: githubToken, enterpriseUrl: domain }, signal);
  const catalog = await models(credentials.access, domain, signal, 2);
  for (const id of catalog.policy) {
    try {
      const response = await requestWithRetry(
        `${apiBaseUrl(credentials.access, domain)}/models/${encodeURIComponent(id)}/policy`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credentials.access}`,
            ...HEADERS,
            'openai-intent': 'chat-policy',
            'x-interaction-type': 'chat-policy',
          },
          body: JSON.stringify({ state: 'enabled' }),
        },
        signal,
        2
      );
      await response.body?.cancel();
      catalog.available.push(id);
    } catch (error) {
      if (signal.aborted) throw error;
      // Model enabling is best effort upstream; keep failures visible without vendor bodies.
      callbacks.onProgress?.('A Copilot model policy could not be enabled.');
      if (error instanceof SubscriptionOAuthError && error.status === 429) break;
    }
  }
  return { ...credentials, availableModelIds: [...new Set(catalog.available)] };
}

export const githubCopilotOAuthProvider: OAuthProviderInterface = {
  login,
  async refreshToken(credentials, options) {
    const signal = options?.signal ?? new AbortController().signal;
    const current = await refreshAccess(credentials, signal);
    const catalog = await models(
      current.access,
      enterpriseDomain(current.enterpriseUrl),
      signal,
      0
    );
    return { ...current, availableModelIds: catalog.available };
  },
};
