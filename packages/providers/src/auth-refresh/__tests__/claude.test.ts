import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { refreshClaude } from '../claude';

const originalFetch = globalThis.fetch;
let tempHome: string;
let homedirSpy: ReturnType<typeof spyOn>;

function credsPath(): string {
  return path.join(tempHome, '.claude', '.credentials.json');
}

function writeCreds(overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(credsPath()), { recursive: true });
  fs.writeFileSync(
    credsPath(),
    JSON.stringify(
      {
        claudeAiOauth: {
          accessToken: 'OLD_ACCESS_TOKEN',
          refreshToken: 'TEST_REFRESH_TOKEN',
          expiresAt: Date.now() - 1000,
          scopes: ['org:create_api_key'],
          subscriptionType: 'max',
          rateLimitTier: 'default',
        },
        mcpOAuth: { notion: { accessToken: 'MCP_TOKEN' } },
        ...overrides,
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-refresh-claude-'));
  homedirSpy = spyOn(os, 'homedir').mockReturnValue(tempHome);
  mockLogger.info.mockClear();
  mockLogger.error.mockClear();
  mockLogger.debug.mockClear();
  globalThis.fetch = mock(async () => {
    return new Response(
      JSON.stringify({
        access_token: 'NEW_ACCESS_TOKEN',
        refresh_token: 'NEW_REFRESH_TOKEN',
        expires_in: 3600,
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

describe('refreshClaude', () => {
  test('refreshes credentials and preserves mcpOAuth', async () => {
    writeCreds();

    const result = await refreshClaude();

    expect(result.refreshed).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
    expect(url).toBe('https://platform.claude.com/v1/oauth/token');
    expect((init as RequestInit).headers).toEqual({
      'Content-Type': 'application/json',
      'User-Agent': 'claude-cli/2.1.121',
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'TEST_REFRESH_TOKEN',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    });

    const written = JSON.parse(fs.readFileSync(credsPath(), 'utf-8'));
    expect(written.claudeAiOauth.accessToken).toBe('NEW_ACCESS_TOKEN');
    expect(written.claudeAiOauth.refreshToken).toBe('NEW_REFRESH_TOKEN');
    expect(written.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now());
    expect(written.mcpOAuth).toEqual({ notion: { accessToken: 'MCP_TOKEN' } });
    if (process.platform !== 'win32') {
      expect(fs.statSync(credsPath()).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(path.dirname(credsPath())).some(name => name.includes('.tmp.'))).toBe(
      false
    );
  });

  test('returns no_creds when credentials file is missing', async () => {
    const result = await refreshClaude();

    expect(result).toEqual({ refreshed: false, reason: 'no_creds' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('maps expired refresh token without writing credentials', async () => {
    writeCreds();
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'refresh_token_expired' }), { status: 400 });
    }) as unknown as typeof fetch;

    const before = fs.readFileSync(credsPath(), 'utf-8');
    const result = await refreshClaude();
    const after = fs.readFileSync(credsPath(), 'utf-8');

    expect(result).toEqual({ refreshed: false, reason: 'refresh_expired' });
    expect(after).toBe(before);
  });

  test('short-circuits when credentials are already fresh', async () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: 'FRESH_ACCESS_TOKEN',
        refreshToken: 'FRESH_REFRESH_TOKEN',
        expiresAt: Date.now() + 60_000,
        scopes: [],
        subscriptionType: 'max',
        rateLimitTier: 'default',
      },
    });

    const result = await refreshClaude();

    expect(result.refreshed).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
