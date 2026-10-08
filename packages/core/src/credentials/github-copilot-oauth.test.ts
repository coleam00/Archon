// @archon-test-isolated
import { afterEach, beforeEach, expect, test, mock, spyOn } from 'bun:test';
let now = Date.now();
const waits: number[] = [];
mock.module('node:timers/promises', () => ({
  setTimeout: async (milliseconds: number, _value: unknown, options: { signal: AbortSignal }) => {
    options.signal.throwIfAborted();
    waits.push(milliseconds);
    now += milliseconds;
  },
}));
const { githubCopilotOAuthProvider } = await import('./github-copilot-oauth');
let clock: ReturnType<typeof spyOn<typeof Date, 'now'>>;
beforeEach(() => {
  now = Date.now();
  waits.length = 0;
  clock = spyOn(Date, 'now').mockImplementation(() => now);
});
import {
  mintOAuthApiKey,
  SubscriptionOAuthError,
  type OAuthLoginCallbacks,
} from './subscription-oauth';

const realFetch = globalThis.fetch;
function install(implementation: (...args: Parameters<typeof fetch>) => Promise<Response>): void {
  globalThis.fetch = Object.assign(implementation, { preconnect: realFetch.preconnect });
}
afterEach(() => {
  globalThis.fetch = realFetch;
  clock.mockRestore();
});
const bearer = 'tid=test;proxy-ep=proxy.individual.githubcopilot.com';
const model = (id: string, policy: string, picker = true, tools = true) => ({
  id,
  policy: { state: policy },
  model_picker_enabled: picker,
  capabilities: { supports: { tool_calls: tools } },
});
function callbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks {
  return {
    onAuth: () => {},
    onDeviceCode: () => {},
    onManualCodeInput: async () => '',
    onPrompt: async () => '',
    onSelect: async () => '',
    ...overrides,
  };
}

test('device login polls pending and slow_down, mints a bearer and enables only supported model policies', async () => {
  const calls: string[] = [];
  let polls = 0;
  let deviceInfo: unknown;
  install(async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/device/code')) {
      expect(new URLSearchParams(String(init?.body)).get('client_id')).toBe('Iv1.b507a08c87ecfe98');
      return Response.json({
        device_code: 'device-secret',
        user_code: 'USER',
        verification_uri: 'https://github.com/login/device',
        expires_in: 60,
        interval: 1,
      });
    }
    if (url.endsWith('/access_token')) {
      expect(new URLSearchParams(String(init?.body)).get('device_code')).toBe('device-secret');
      polls++;
      return Response.json(
        polls === 1
          ? { error: 'authorization_pending' }
          : polls === 2
            ? { error: 'slow_down' }
            : { access_token: 'github-token' }
      );
    }
    if (url.endsWith('/v2/token')) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer github-token');
      return Response.json({ token: bearer, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    if (url.endsWith('/models'))
      return Response.json({
        data: [
          model('gpt-5.4', 'unconfigured'),
          model('unknown-future-model', 'unconfigured'),
          model('disabled', 'disabled'),
          model('no-tools', 'enabled', true, false),
        ],
      });
    expect(url).toBe('https://api.individual.githubcopilot.com/models/gpt-5.4/policy');
    expect(JSON.parse(String(init?.body))).toEqual({ state: 'enabled' });
    return new Response(null, { status: 204 });
  });
  const creds = await githubCopilotOAuthProvider.login(
    callbacks({
      onDeviceCode: info => {
        deviceInfo = info;
      },
    })
  );
  expect(deviceInfo).toEqual({
    userCode: 'USER',
    verificationUri: 'https://github.com/login/device',
  });
  expect(creds).toMatchObject({
    access: bearer,
    refresh: 'github-token',
    type: 'oauth',
    availableModelIds: ['gpt-5.4', 'unknown-future-model'],
  });
  expect(polls).toBe(3);
  expect(waits).toEqual([1000, 1000, 6000]);
  expect(calls.filter(url => url.endsWith('/policy'))).toHaveLength(1);
});

test('expired legacy enterprise credential keeps the GitHub token and extension fields through refresh', async () => {
  const legacy = {
    access: 'old',
    refresh: 'github-refresh',
    expires: 1,
    enterpriseUrl: 'https://company.ghe.com/',
    extra: 'kept',
  };
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  install(async (input, init) => {
    if (String(input).endsWith('/token')) {
      expect(String(input)).toBe('https://api.company.ghe.com/copilot_internal/v2/token');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer github-refresh');
      return Response.json({ token: 'enterprise-bearer', expires_at: expiry });
    }
    expect(String(input)).toBe('https://copilot-api.company.ghe.com/models');
    return Response.json({
      data: [model('available', 'enabled'), model('hidden', 'enabled', false)],
    });
  });
  const result = await mintOAuthApiKey(githubCopilotOAuthProvider, legacy);
  expect(result?.apiKey).toBe('enterprise-bearer');
  expect(result?.newCredentials).toMatchObject({
    refresh: 'github-refresh',
    enterpriseUrl: 'company.ghe.com',
    extra: 'kept',
    expires: expiry * 1000 - 300_000,
    availableModelIds: ['available'],
  });
});

test('unexpired legacy credentials mint without network access or login', async () => {
  install(async () => {
    throw new Error('unexpected fetch');
  });
  const legacy = { access: 'stored', refresh: 'github', expires: Date.now() + 60_000 };
  expect(await mintOAuthApiKey(githubCopilotOAuthProvider, legacy)).toEqual({
    newCredentials: legacy,
    apiKey: 'stored',
  });
});

test('individual accounts with no picker flags use enabled policy fallback on refresh', async () => {
  install(async input =>
    String(input).endsWith('/token')
      ? Response.json({ token: bearer, expires_at: 2000000000 })
      : Response.json({
          data: [model('enabled', 'enabled', false), model('disabled', 'disabled', false)],
        })
  );
  const refreshed = await githubCopilotOAuthProvider.refreshToken({ refresh: 'github' });
  expect(refreshed.availableModelIds).toEqual(['enabled']);
});

test('abort interrupts device polling before token exchange', async () => {
  const abort = new AbortController();
  let calls = 0;
  install(async () => {
    calls++;
    return Response.json({
      device_code: 'd',
      user_code: 'U',
      verification_uri: 'https://github.com/login/device',
      expires_in: 60,
    });
  });
  await expect(
    githubCopilotOAuthProvider.login(
      callbacks({ signal: abort.signal, onDeviceCode: () => abort.abort() })
    )
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

test('invalid device URL, timeout and denial fail without exposing the vendor description', async () => {
  for (const variant of ['uri', 'timeout', 'denied']) {
    install(async input =>
      String(input).endsWith('/device/code')
        ? Response.json({
            device_code: 'd',
            user_code: 'U',
            verification_uri:
              variant === 'uri' ? 'file:///executable' : 'https://github.com/login/device',
            expires_in: variant === 'timeout' ? 0 : 60,
            interval: 1,
          })
        : Response.json({ error: 'access_denied', error_description: 'secret-user-text' })
    );
    const error: unknown = await githubCopilotOAuthProvider
      .login(callbacks())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubscriptionOAuthError);
    expect((error as Error).message).not.toContain('secret-user-text');
  }
});

test('refresh HTTP rejection carries status without response text', async () => {
  install(async () => new Response('github-refresh secret-user-text', { status: 401 }));
  const error: unknown = await githubCopilotOAuthProvider
    .refreshToken({ refresh: 'github-refresh' })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SubscriptionOAuthError);
  expect((error as SubscriptionOAuthError).status).toBe(401);
  expect((error as Error).message).not.toContain('secret');
});

test('model discovery honors Retry-After and policy failures remain observable and best effort', async () => {
  let catalogCalls = 0;
  const progress: string[] = [];
  install(async input => {
    const url = String(input);
    if (url.endsWith('/device/code'))
      return Response.json({
        device_code: 'd',
        user_code: 'U',
        verification_uri: 'https://github.com/login/device',
        expires_in: 60,
        interval: 1,
      });
    if (url.endsWith('/access_token')) return Response.json({ access_token: 'github' });
    if (url.endsWith('/token')) return Response.json({ token: bearer, expires_at: 2000000000 });
    if (url.endsWith('/models')) {
      catalogCalls++;
      return catalogCalls === 1
        ? new Response('secret-account', { status: 429, headers: { 'Retry-After': '1' } })
        : Response.json({ data: [model('gpt-5.4', 'unconfigured', false)] });
    }
    return new Response('secret-account', { status: 403 });
  });
  const creds = await githubCopilotOAuthProvider.login(
    callbacks({
      onProgress: message => {
        progress.push(message);
      },
    })
  );
  expect(catalogCalls).toBe(2);
  expect(waits).toEqual([1000, 1000]);
  expect(creds.availableModelIds).toEqual([]);
  expect(progress).toEqual(['A Copilot model policy could not be enabled.']);
});
