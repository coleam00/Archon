// @archon-test-isolated
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { anthropicOAuthProvider } from './anthropic-oauth';
import {
  mintOAuthApiKey,
  SubscriptionOAuthError,
  type OAuthLoginCallbacks,
} from './subscription-oauth';

const realFetch = globalThis.fetch;
function stub(implementation: typeof fetch): void {
  globalThis.fetch = implementation;
}
const token = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 };
function callbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks {
  return {
    onAuth: () => {},
    onDeviceCode: () => {},
    onManualCodeInput: async () => 'CODE',
    onPrompt: async () => '',
    onSelect: async () => 'browser',
    ...overrides,
  };
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Anthropic subscription OAuth', () => {
  test('manual paste exchanges with the original PKCE/client/redirect contract', async () => {
    let authorize!: URL;
    let body!: Record<string, unknown>;
    stub(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          expect(String(input)).toBe('https://platform.claude.com/v1/oauth/token');
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json(token);
        },
        { preconnect: realFetch.preconnect }
      )
    );
    const before = Date.now();
    const creds = await anthropicOAuthProvider.login(
      callbacks({
        onAuth: info => {
          authorize = new URL(info.url);
        },
        onManualCodeInput: async () => `CODE#${authorize.searchParams.get('state')}`,
      })
    );
    expect(body.client_id).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(body.redirect_uri).toBe('http://localhost:53692/callback');
    expect(body.state).toBe(authorize.searchParams.get('state'));
    expect(authorize.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(String(body.code_verifier)).digest('base64url')
    );
    expect(body.code).toBe('CODE');
    expect(creds).toMatchObject({ type: 'oauth', access: 'new-access', refresh: 'new-refresh' });
    expect(creds.expires).toBeGreaterThanOrEqual(before + 3_300_000);
  });

  test('browser callback rejects wrong state then accepts the valid callback and releases the port', async () => {
    stub(Object.assign(async () => Response.json(token), { preconnect: realFetch.preconnect }));
    let callbackDone!: Promise<void>;
    const creds = await anthropicOAuthProvider.login(
      callbacks({
        onAuth: info => {
          const url = new URL(info.url);
          callbackDone = (async () => {
            const invalid = await realFetch('http://127.0.0.1:53692/callback?code=C&state=wrong');
            expect(invalid.status).toBe(400);
            await invalid.text();
            const valid = await realFetch(
              `http://127.0.0.1:53692/callback?code=C&state=${url.searchParams.get('state')}`
            );
            expect(valid.status).toBe(200);
            await valid.text();
          })();
        },
        onManualCodeInput: () => new Promise<string>(() => {}),
      })
    );
    await callbackDone;
    expect(creds.access).toBe('new-access');
    await expect(anthropicOAuthProvider.login(callbacks())).resolves.toMatchObject({
      access: 'new-access',
    });
  });

  test('copy-code method uses its registered redirect and rejects a mismatched paste without exchange', async () => {
    let fetched = false;
    stub(
      Object.assign(
        async () => {
          fetched = true;
          return Response.json(token);
        },
        { preconnect: realFetch.preconnect }
      )
    );
    await expect(
      anthropicOAuthProvider.login(
        callbacks({
          onSelect: async () => 'copy_code',
          onAuth: info => {
            expect(new URL(info.url).searchParams.get('redirect_uri')).toBe(
              'https://platform.claude.com/oauth/code/callback'
            );
          },
          onManualCodeInput: async () => 'CODE#wrong',
        })
      )
    ).rejects.toThrow('state mismatch');
    expect(fetched).toBe(false);
  });

  test('abort closes an awaiting browser callback so the next login can bind', async () => {
    const abort = new AbortController();
    await expect(
      anthropicOAuthProvider.login(
        callbacks({
          signal: abort.signal,
          onAuth: () => abort.abort(),
          onManualCodeInput: () => new Promise<string>(() => {}),
        })
      )
    ).rejects.toThrow('cancelled');
    stub(Object.assign(async () => Response.json(token), { preconnect: realFetch.preconnect }));
    await expect(anthropicOAuthProvider.login(callbacks())).resolves.toMatchObject({
      access: 'new-access',
    });
  });

  test('an occupied callback port still allows manual browser login', async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(53692, '127.0.0.1', resolve));
    let authorize!: URL;
    const progress: string[] = [];
    stub(Object.assign(async () => Response.json(token), { preconnect: realFetch.preconnect }));
    try {
      const credentials = await anthropicOAuthProvider.login(
        callbacks({
          onAuth: info => {
            authorize = new URL(info.url);
          },
          onManualCodeInput: async () => `CODE#${authorize.searchParams.get('state')}`,
          onProgress: message => {
            progress.push(message);
          },
        })
      );
      expect(progress).toEqual([
        'Anthropic callback listener unavailable. Paste the authorization code or redirect URL to complete login.',
      ]);
      expect(authorize.searchParams.get('redirect_uri')).toBe('http://localhost:53692/callback');
      expect(credentials.access).toBe('new-access');
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('legacy untagged blobs refresh without login and preserve extension fields', async () => {
    const legacy = { access: 'old-access', refresh: 'old-refresh', expires: 1, extra: 'kept' };
    stub(
      Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            grant_type: 'refresh_token',
            refresh_token: 'old-refresh',
          });
          return Response.json(token);
        },
        { preconnect: realFetch.preconnect }
      )
    );
    const minted = await mintOAuthApiKey(anthropicOAuthProvider, legacy);
    expect(minted.apiKey).toBe('new-access');
    expect(minted.newCredentials).toMatchObject({ refresh: 'new-refresh', extra: 'kept' });
  });

  test('refresh preserves the stored refresh token when the endpoint omits it', async () => {
    stub(
      Object.assign(async () => Response.json({ access_token: 'new-access', expires_in: 3600 }), {
        preconnect: realFetch.preconnect,
      })
    );
    const creds = await anthropicOAuthProvider.refreshToken({
      access: 'old',
      refresh: 'kept-refresh',
      expires: 1,
    });
    expect(creds.refresh).toBe('kept-refresh');
    expect(creds.access).toBe('new-access');
  });

  test('HTTP, malformed JSON and network errors contain no vendor body or credential', async () => {
    for (const response of [
      new Response('secret-access account-id', { status: 401 }),
      new Response('secret-access', { status: 200 }),
    ]) {
      stub(Object.assign(async () => response, { preconnect: realFetch.preconnect }));
      const error: unknown = await anthropicOAuthProvider
        .refreshToken({ refresh: 'old-refresh' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SubscriptionOAuthError);
      expect((error as Error).message).not.toContain('secret-access');
    }
    stub(
      Object.assign(
        async () => {
          throw new Error('old-refresh');
        },
        { preconnect: realFetch.preconnect }
      )
    );
    await expect(anthropicOAuthProvider.refreshToken({ refresh: 'old-refresh' })).rejects.toThrow(
      'request failed.'
    );
  });
});
