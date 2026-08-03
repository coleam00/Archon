import { describe, test, expect, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createOpenAiAuthorizeFlow,
  parseOpenAiAuthorizationInput,
  exchangeOpenAiAuthorizationCode,
  refreshOpenAiOAuthCredentials,
  mintOpenAiOAuthApiKey,
} from './openai-oauth';

/** Build an unsigned JWT-shaped token with the given payload. */
function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (o: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

const ACCESS_WITH_ACCOUNT = fakeJwt({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' },
});
const ACCESS_WITHOUT_ACCOUNT = fakeJwt({ sub: 'nobody' });

// fetch stub — restored after each test (no mock.module; global only).
const realFetch = globalThis.fetch;
let lastRequest: { url: string; body: URLSearchParams } | undefined;
function stubTokenEndpoint(status: number, json: unknown): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    lastRequest = {
      url: String(input),
      body: new URLSearchParams(String(init?.body)),
    };
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  lastRequest = undefined;
});

describe('createOpenAiAuthorizeFlow', () => {
  test('builds the Codex-client authorize URL with PKCE S256 + state', () => {
    const flow = createOpenAiAuthorizeFlow();
    const url = new URL(flow.url);
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(url.searchParams.get('state')).toBe(flow.state);
    // The challenge is the base64url SHA-256 of the (server-held) verifier.
    const expectedChallenge = createHash('sha256')
      .update(flow.verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    expect(url.searchParams.get('code_challenge')).toBe(expectedChallenge);
  });

  test('every flow gets fresh verifier/state material', () => {
    const a = createOpenAiAuthorizeFlow();
    const b = createOpenAiAuthorizeFlow();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe('parseOpenAiAuthorizationInput', () => {
  test('full redirect URL → code + state', () => {
    expect(
      parseOpenAiAuthorizationInput('http://localhost:1455/auth/callback?code=C1&state=S1')
    ).toEqual({ code: 'C1', state: 'S1' });
  });

  test('code#state → code + state', () => {
    expect(parseOpenAiAuthorizationInput('C2#S2')).toEqual({ code: 'C2', state: 'S2' });
  });

  test('query-fragment form → code + state', () => {
    expect(parseOpenAiAuthorizationInput('code=C3&state=S3')).toEqual({
      code: 'C3',
      state: 'S3',
    });
  });

  test('bare code → code only; blank → empty', () => {
    expect(parseOpenAiAuthorizationInput('  C4  ')).toEqual({ code: 'C4' });
    expect(parseOpenAiAuthorizationInput('   ')).toEqual({});
  });
});

describe('exchangeOpenAiAuthorizationCode', () => {
  test('maps the token response onto the credential blob — id_token KEPT (#1924)', async () => {
    stubTokenEndpoint(200, {
      access_token: ACCESS_WITH_ACCOUNT,
      refresh_token: 'rt-1',
      expires_in: 3600,
      id_token: 'idt-1',
    });
    const before = Date.now();
    const creds = await exchangeOpenAiAuthorizationCode('CODE', 'VERIFIER');
    expect(creds.access).toBe(ACCESS_WITH_ACCOUNT);
    expect(creds.refresh).toBe('rt-1');
    expect(creds.id_token).toBe('idt-1');
    expect(creds.accountId).toBe('acct-42');
    expect(creds.expires).toBeGreaterThanOrEqual(before + 3600 * 1000);
    // The exchange posts the PKCE verifier + code to the token endpoint.
    expect(lastRequest!.url).toBe('https://auth.openai.com/oauth/token');
    expect(lastRequest!.body.get('grant_type')).toBe('authorization_code');
    expect(lastRequest!.body.get('code')).toBe('CODE');
    expect(lastRequest!.body.get('code_verifier')).toBe('VERIFIER');
    expect(lastRequest!.body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
  });

  test('missing id_token → fails loud (never store a #1924-broken blob)', async () => {
    stubTokenEndpoint(200, {
      access_token: ACCESS_WITH_ACCOUNT,
      refresh_token: 'rt',
      expires_in: 3600,
    });
    await expect(exchangeOpenAiAuthorizationCode('C', 'V')).rejects.toThrow(/id_token/);
  });

  test('access token without the account claim → fails loud (mirrors Pi)', async () => {
    stubTokenEndpoint(200, {
      access_token: ACCESS_WITHOUT_ACCOUNT,
      refresh_token: 'rt',
      expires_in: 3600,
      id_token: 'idt',
    });
    await expect(exchangeOpenAiAuthorizationCode('C', 'V')).rejects.toThrow(/account id/);
  });

  test('non-2xx token response → descriptive error', async () => {
    stubTokenEndpoint(400, { error: 'invalid_grant' });
    await expect(exchangeOpenAiAuthorizationCode('C', 'V')).rejects.toThrow(
      /exchange failed \(400\): invalid_grant/
    );
  });

  test('error body is stripped to the OAuth error code — nothing else leaks (S2)', async () => {
    stubTokenEndpoint(400, {
      error: { code: 'invalid_grant', message: 'account chatgpt-acct-SECRET is not allowed' },
    });
    let thrown: Error | undefined;
    try {
      await exchangeOpenAiAuthorizationCode('C', 'V');
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toContain('invalid_grant');
    expect(thrown!.message).not.toContain('SECRET');
    expect(thrown!.message).not.toContain('account');
  });

  test('HTTP 200 with a non-JSON body → labeled error, not a raw SyntaxError (I2)', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>maintenance</html>', { status: 200 })) as typeof fetch;
    await expect(exchangeOpenAiAuthorizationCode('C', 'V')).rejects.toThrow(
      /non-JSON response \(HTTP 200\)/
    );
  });
});

describe('refreshOpenAiOAuthCredentials', () => {
  const stored = {
    access: 'old-access',
    refresh: 'old-refresh',
    expires: 1,
    accountId: 'acct-42',
    id_token: 'old-idt',
  };

  test('rotates access/refresh/id_token from the response', async () => {
    stubTokenEndpoint(200, {
      access_token: ACCESS_WITH_ACCOUNT,
      refresh_token: 'new-refresh',
      expires_in: 1800,
      id_token: 'new-idt',
    });
    const next = await refreshOpenAiOAuthCredentials(stored);
    expect(next.access).toBe(ACCESS_WITH_ACCOUNT);
    expect(next.refresh).toBe('new-refresh');
    expect(next.id_token).toBe('new-idt');
    expect(lastRequest!.body.get('grant_type')).toBe('refresh_token');
    expect(lastRequest!.body.get('refresh_token')).toBe('old-refresh');
  });

  test('response omitting id_token/refresh_token PRESERVES the stored values', async () => {
    stubTokenEndpoint(200, {
      access_token: ACCESS_WITH_ACCOUNT,
      expires_in: 1800,
    });
    const next = await refreshOpenAiOAuthCredentials(stored);
    expect(next.id_token).toBe('old-idt'); // the field Pi's refresh would drop
    expect(next.refresh).toBe('old-refresh');
    expect(next.accountId).toBe('acct-42');
  });

  test('stored blob without a refresh token → throws', async () => {
    await expect(refreshOpenAiOAuthCredentials({ access: 'a' })).rejects.toThrow(
      /no refresh token/
    );
  });

  test('non-2xx refresh (expired/revoked refresh token) → descriptive, stripped error (S1)', async () => {
    stubTokenEndpoint(401, { error: 'invalid_grant' });
    await expect(refreshOpenAiOAuthCredentials(stored)).rejects.toThrow(
      /refresh failed \(401\): invalid_grant/
    );
  });
});

describe('mintOpenAiOAuthApiKey', () => {
  test('unexpired blob → returned as-is, no network call', async () => {
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response('{}');
    }) as typeof fetch;
    const creds = {
      access: 'a1',
      refresh: 'r1',
      expires: Date.now() + 60_000,
      accountId: 'acct-42',
      id_token: 'i1',
    };
    const out = await mintOpenAiOAuthApiKey(creds);
    expect(out).toEqual({ newCredentials: creds, apiKey: 'a1' });
    expect(fetched).toBe(0);
  });

  test('legacy/corrupt row with no usable access token → null, no throw (S1)', async () => {
    // The narrow parameter type is a write-time promise; decrypted rows can
    // still be junk — simulate one via the same assertion the store performs.
    const corrupt = { expires: Date.now() + 60_000 } as unknown as Parameters<
      typeof mintOpenAiOAuthApiKey
    >[0];
    expect(await mintOpenAiOAuthApiKey(corrupt)).toBeNull();
  });

  test('expired blob → refreshes first (id_token preserved through rotation)', async () => {
    stubTokenEndpoint(200, {
      access_token: ACCESS_WITH_ACCOUNT,
      refresh_token: 'r2',
      expires_in: 3600,
    });
    const out = await mintOpenAiOAuthApiKey({
      access: 'a1',
      refresh: 'r1',
      expires: Date.now() - 1000,
      accountId: 'acct-42',
      id_token: 'keep-me',
    });
    expect(out!.apiKey).toBe(ACCESS_WITH_ACCOUNT);
    expect(out!.newCredentials.id_token).toBe('keep-me');
    expect(out!.newCredentials.refresh).toBe('r2');
  });
});
