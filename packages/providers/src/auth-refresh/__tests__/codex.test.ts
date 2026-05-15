import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { refreshCodex } from '../codex';

const originalFetch = globalThis.fetch;
let tempHome: string;
let homedirSpy: ReturnType<typeof spyOn>;

function credsPath(): string {
  return path.join(tempHome, '.codex', 'auth.json');
}

function writeCreds(): void {
  fs.mkdirSync(path.dirname(credsPath()), { recursive: true });
  fs.writeFileSync(
    credsPath(),
    JSON.stringify(
      {
        OPENAI_API_KEY: null,
        tokens: {
          id_token: 'OLD_ID_TOKEN',
          access_token: 'OLD_ACCESS_TOKEN',
          refresh_token: 'TEST_REFRESH_TOKEN',
          account_id: 'acct_123',
        },
        last_refresh: '2026-05-01T00:00:00.000Z',
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-refresh-codex-'));
  homedirSpy = spyOn(os, 'homedir').mockReturnValue(tempHome);
  mockLogger.info.mockClear();
  mockLogger.error.mockClear();
  mockLogger.debug.mockClear();
  globalThis.fetch = mock(async () => {
    return new Response(
      JSON.stringify({
        access_token: 'NEW_ACCESS_TOKEN',
        refresh_token: 'NEW_REFRESH_TOKEN',
        id_token: 'NEW_ID_TOKEN',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  homedirSpy.mockRestore();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('refreshCodex', () => {
  test('refreshes credentials with form-urlencoded body', async () => {
    writeCreds();

    const result = await refreshCodex();

    expect(result.refreshed).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
    expect(url).toBe('https://auth.openai.com/oauth/token');
    expect((init as RequestInit).headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const body = new URLSearchParams((init as RequestInit).body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('TEST_REFRESH_TOKEN');
    expect(body.get('client_id')?.startsWith('app_')).toBe(true);

    const written = JSON.parse(fs.readFileSync(credsPath(), 'utf-8'));
    expect(written.OPENAI_API_KEY).toBeNull();
    expect(written.tokens.access_token).toBe('NEW_ACCESS_TOKEN');
    expect(written.tokens.refresh_token).toBe('NEW_REFRESH_TOKEN');
    expect(written.tokens.id_token).toBe('NEW_ID_TOKEN');
    expect(written.tokens.account_id).toBe('acct_123');
    expect(new Date(written.last_refresh).getTime()).toBeGreaterThan(
      new Date('2026-05-01T00:00:00.000Z').getTime()
    );
    if (process.platform !== 'win32') {
      expect(fs.statSync(credsPath()).mode & 0o777).toBe(0o600);
    }
  });

  test('returns no_creds when credentials file is missing', async () => {
    const result = await refreshCodex();

    expect(result).toEqual({ refreshed: false, reason: 'no_creds' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('maps revoked refresh token without writing credentials', async () => {
    writeCreds();
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'refresh_token_revoked' }), { status: 400 });
    }) as unknown as typeof fetch;

    const before = fs.readFileSync(credsPath(), 'utf-8');
    const result = await refreshCodex();
    const after = fs.readFileSync(credsPath(), 'utf-8');

    expect(result).toEqual({ refreshed: false, reason: 'refresh_revoked' });
    expect(after).toBe(before);
  });

  test('preserves old id token when response omits id_token', async () => {
    writeCreds();
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'NEW_ACCESS_TOKEN',
          refresh_token: 'NEW_REFRESH_TOKEN',
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await refreshCodex();
    const written = JSON.parse(fs.readFileSync(credsPath(), 'utf-8'));

    expect(result.refreshed).toBe(true);
    expect(written.tokens.id_token).toBe('OLD_ID_TOKEN');
  });
});
