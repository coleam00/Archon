import { describe, it, expect } from 'bun:test';
import { checkConnectedProviders, type ProviderDeps } from './doctor-connected-providers';

describe('checkConnectedProviders', () => {
  const mockUser = { id: 'user-1' };
  type Status = Awaited<ReturnType<ProviderDeps['getStoredCredentialStatus']>>;

  function depsWith(
    rows: Awaited<ReturnType<ProviderDeps['listUserProviderKeys']>>,
    statuses: Record<string, Status> = {}
  ): () => Promise<ProviderDeps> {
    return async () => ({
      listUserProviderKeys: async () => rows,
      getStoredCredentialStatus: async (_userId, vendor) =>
        statuses[vendor] ?? { state: 'usable', source: 'archon' },
      findOrCreateUserByPlatformIdentity: async () => mockUser,
    });
  }

  it('returns skip when CLI identity is not resolvable', async () => {
    const result = await checkConnectedProviders({}, depsWith([]));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('no CLI identity');
  });

  it('returns skip with a connect hint when no providers are connected', async () => {
    const result = await checkConnectedProviders({ USER: 'testuser' }, depsWith([]));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('archon ai login');
  });

  it('passes with one line per credential when every credential is usable', async () => {
    const result = await checkConnectedProviders(
      { USER: 'testuser' },
      depsWith([
        { provider: 'anthropic', kind: 'oauth', label: 'subscription' },
        { provider: 'openrouter', kind: 'api_key', label: null },
      ])
    );
    expect(result.status).toBe('pass');
    expect(result.message).toBe(
      '2 connected\n    anthropic (oauth): usable\n    openrouter (api_key): usable'
    );
  });

  it('fails naming the vendor, its evidence and the reconnect command when one is unusable', async () => {
    const result = await checkConnectedProviders(
      { USER: 'testuser' },
      depsWith(
        [
          { provider: 'anthropic', kind: 'oauth', label: 'subscription' },
          { provider: 'openai', kind: 'oauth', label: null },
        ],
        {
          openai: {
            state: 'unusable',
            source: 'archon',
            evidence: 'OpenAI token refresh failed (401): invalid_grant.',
          },
          anthropic: { state: 'check_failed', source: 'archon', evidence: 'network down.' },
        }
      )
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain(
      'openai (oauth): cannot be used. Reconnect: archon ai login openai. Cause: OpenAI token refresh failed (401): invalid_grant.'
    );
  });

  it('warns when a credential could not be verified', async () => {
    const result = await checkConnectedProviders(
      { USER: 'testuser' },
      depsWith([{ provider: 'openrouter', kind: 'api_key', label: null }], {
        openrouter: { state: 'check_failed', source: 'archon', evidence: 'Request timed out.' },
      })
    );
    expect(result.status).toBe('warn');
    expect(result.message).toContain(
      'openrouter (api_key): could not be verified. If it persists, reconnect: archon ai key set openrouter. Cause: Request timed out.'
    );
  });

  it('returns skip (not fail) when loadDeps throws', async () => {
    const result = await checkConnectedProviders({ USER: 'testuser' }, async () => {
      throw new Error('module load failed');
    });
    expect(result.status).toBe('skip');
    expect(result.message).toContain('module load failed');
  });

  it('returns skip (not fail) when reading credentials throws', async () => {
    const result = await checkConnectedProviders({ USER: 'testuser' }, async () => ({
      ...(await depsWith([{ provider: 'openrouter', kind: 'api_key', label: null }])()),
      getStoredCredentialStatus: async () => {
        throw new Error('db down');
      },
    }));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('db down');
  });
});
