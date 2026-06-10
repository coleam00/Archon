import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

// Mirror the store test harness: mock the DB connection so saveUserProviderKey
// runs for real (encrypting the key) against an inspectable query mock.
const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
mock.module('../db/connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
}));

import { persistProviderApiKey, persistProviderOAuth } from './connect-service';

describe('persistProviderApiKey', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  test('rejects a blank API key before any DB write', async () => {
    await expect(persistProviderApiKey('user-1', 'claude', '   ')).rejects.toThrow(
      /API key must not be empty/
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rejects an unknown provider with an actionable message (no DB write)', async () => {
    await expect(persistProviderApiKey('user-1', 'bogus', 'sk-x')).rejects.toThrow(
      /Unknown provider 'bogus'\. Known: /
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('stores a trimmed, encrypted key and returns secret-free metadata', async () => {
    const result = await persistProviderApiKey(
      'user-1',
      'openrouter',
      '  sk-or-plaintext  ',
      'Personal'
    );
    expect(result).toEqual({ provider: 'openrouter', kind: 'api_key', label: 'Personal' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // params: [userId, provider, kind, api_key_encrypted, oauth_creds_encrypted, label]
    const params = mockQuery.mock.calls[0]?.[1] as unknown[];
    expect(params[0]).toBe('user-1');
    expect(params[1]).toBe('openrouter');
    expect(params[2]).toBe('api_key');
    expect(typeof params[3]).toBe('string');
    expect(params[3]).not.toBe('sk-or-plaintext'); // ciphertext, not plaintext
    expect(params[3]).not.toBe('  sk-or-plaintext  ');
    expect(params[4]).toBeNull(); // no oauth blob
    expect(params[5]).toBe('Personal');
  });

  test('normalizes a blank label to null', async () => {
    const result = await persistProviderApiKey('user-1', 'claude', 'sk-ant', '   ');
    expect(result.label).toBeNull();
    const params = mockQuery.mock.calls[0]?.[1] as unknown[];
    expect(params[5]).toBeNull();
  });
});

describe('persistProviderOAuth', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  test('rejects a non-subscription provider (no DB write)', async () => {
    await expect(persistProviderOAuth('user-1', 'openrouter', { access: 'x' })).rejects.toThrow(
      /does not support subscription login/
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('stores an encrypted oauth blob for a subscription provider', async () => {
    const result = await persistProviderOAuth('user-1', 'claude', {
      access: 'a',
      refresh: 'r',
      expires: 123,
    });
    expect(result).toEqual({ provider: 'claude', kind: 'oauth' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // params: [userId, provider, kind, api_key_encrypted, oauth_creds_encrypted, label]
    const params = mockQuery.mock.calls[0]?.[1] as unknown[];
    expect(params[2]).toBe('oauth');
    expect(params[3]).toBeNull(); // no api key
    expect(typeof params[4]).toBe('string'); // encrypted oauth blob
    expect(params[4]).not.toContain('access'); // ciphertext, not plaintext JSON
  });
});
