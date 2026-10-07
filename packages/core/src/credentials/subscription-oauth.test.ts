import { describe, expect, mock, test } from 'bun:test';

import {
  mintOAuthApiKey,
  type SubscriptionOAuthCredentials,
  type OAuthProviderInterface,
} from './subscription-oauth';

function makeCreds(expires: number): SubscriptionOAuthCredentials {
  return { type: 'oauth', access: 'stored-access', refresh: 'stored-refresh', expires };
}

function makeProvider(overrides?: Partial<OAuthProviderInterface>): {
  provider: OAuthProviderInterface;
  refreshToken: ReturnType<typeof mock>;
  getApiKey: ReturnType<typeof mock>;
} {
  const refreshToken = mock(
    async (): Promise<SubscriptionOAuthCredentials> => ({
      type: 'oauth',
      access: 'refreshed-access',
      refresh: 'refreshed-refresh',
      expires: Date.now() + 3_600_000,
    })
  );
  const getApiKey = mock(async (creds: Record<string, unknown>) => ({
    apiKey: String(creds.access),
  }));
  const provider: OAuthProviderInterface = {
    login: async () => {
      throw new Error('not under test');
    },
    refreshToken,
    getApiKey,
    ...overrides,
  };
  return { provider, refreshToken, getApiKey };
}

describe('mintOAuthApiKey', () => {
  test('unexpired credential mints without refreshing and echoes the input blob', async () => {
    const { provider, refreshToken } = makeProvider();
    const creds = makeCreds(Date.now() + 3_600_000);

    const result = await mintOAuthApiKey(provider, creds);

    expect(refreshToken).not.toHaveBeenCalled();
    expect(result.apiKey).toBe('stored-access');
    // Echoing the input lets the key-store's field comparison see "not
    // rotated" and skip the resave.
    expect(result.newCredentials).toBe(creds);
  });

  test('expired credential refreshes BEFORE minting and returns the rotated blob', async () => {
    const { provider, refreshToken, getApiKey } = makeProvider();
    const creds = makeCreds(Date.now() - 1000);

    const result = await mintOAuthApiKey(provider, creds);

    expect(refreshToken).toHaveBeenCalledTimes(1);
    // The mint must run on the REFRESHED credential, not the stale one.
    expect(getApiKey).toHaveBeenCalledWith(expect.objectContaining({ access: 'refreshed-access' }));
    expect(result.apiKey).toBe('refreshed-access');
    expect(result.newCredentials.access).toBe('refreshed-access');
  });

  test('refresh failure propagates so the caller can log oauth_refresh_failed', async () => {
    const { provider } = makeProvider({
      refreshToken: async () => {
        throw new Error('invalid_grant');
      },
    });
    const creds = makeCreds(Date.now() - 1000);

    await expect(mintOAuthApiKey(provider, creds)).rejects.toThrow('invalid_grant');
  });
});
