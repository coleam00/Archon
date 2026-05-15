import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Mock refreshIfAuthFailed from the index module — preflight imports it
// indirectly via the public surface. We can't use mock.module on the index
// because the same index also exports the function under test, so we mock
// the underlying ./claude and ./codex implementations instead.
const refreshClaudeMock = mock(async () => ({
  refreshed: true as const,
  expiresAt: Date.now() + 3_600_000,
}));
const refreshCodexMock = mock(async () => ({
  refreshed: true as const,
  expiresAt: Date.now() + 3_600_000,
}));
mock.module('../claude', () => ({ refreshClaude: refreshClaudeMock }));
mock.module('../codex', () => ({ refreshCodex: refreshCodexMock }));

import { ensureFreshAuth } from '../preflight';

let tempHome: string;
let homedirSpy: ReturnType<typeof spyOn>;

function claudeCredsPath(): string {
  return path.join(tempHome, '.claude', '.credentials.json');
}

function codexCredsPath(): string {
  return path.join(tempHome, '.codex', 'auth.json');
}

function writeClaudeCreds(expiresAt: number, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(claudeCredsPath()), { recursive: true });
  fs.writeFileSync(
    claudeCredsPath(),
    JSON.stringify(
      {
        claudeAiOauth: {
          accessToken: 'ACCESS_PLACEHOLDER',
          refreshToken: 'REFRESH_PLACEHOLDER',
          expiresAt,
          scopes: ['org:create_api_key'],
          subscriptionType: 'max',
          rateLimitTier: 'default',
        },
        mcpOAuth: { notion: { accessToken: 'MCP_PLACEHOLDER' } },
        ...overrides,
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

function writeCodexCreds(lastRefresh: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(codexCredsPath()), { recursive: true });
  fs.writeFileSync(
    codexCredsPath(),
    JSON.stringify(
      {
        OPENAI_API_KEY: null,
        tokens: {
          id_token: 'ID_PLACEHOLDER',
          access_token: 'ACCESS_PLACEHOLDER',
          refresh_token: 'REFRESH_PLACEHOLDER',
          account_id: 'ACCT_PLACEHOLDER',
        },
        last_refresh: lastRefresh,
        ...overrides,
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-refresh-preflight-'));
  homedirSpy = spyOn(os, 'homedir').mockReturnValue(tempHome);
  mockLogger.info.mockClear();
  mockLogger.error.mockClear();
  mockLogger.debug.mockClear();
  mockLogger.warn.mockClear();
  refreshClaudeMock.mockClear();
  refreshCodexMock.mockClear();
});

afterEach(() => {
  homedirSpy.mockRestore();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('ensureFreshAuth (Claude)', () => {
  test('short-circuits without refresh when creds are fresh', async () => {
    writeClaudeCreds(Date.now() + 60 * 60 * 1000); // 1h in future
    await ensureFreshAuth('claude');
    expect(refreshClaudeMock).toHaveBeenCalledTimes(0);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude' }),
      'provider_preflight_refresh_short_circuit_fresh'
    );
  });

  test('triggers refresh when expiresAt is within the 60s buffer', async () => {
    writeClaudeCreds(Date.now() + 30_000); // 30s — inside buffer
    await ensureFreshAuth('claude');
    expect(refreshClaudeMock).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude' }),
      'provider_preflight_refresh_attempt'
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude' }),
      'provider_preflight_refresh_success'
    );
  });

  test('triggers refresh when expiresAt is in the past', async () => {
    writeClaudeCreds(Date.now() - 60_000);
    await ensureFreshAuth('claude');
    expect(refreshClaudeMock).toHaveBeenCalledTimes(1);
  });

  test('returns quietly when no creds file exists', async () => {
    await ensureFreshAuth('claude');
    expect(refreshClaudeMock).toHaveBeenCalledTimes(0);
    expect(mockLogger.error).toHaveBeenCalledTimes(0);
  });

  test('throws with re-auth instructions when refresh token is missing', async () => {
    writeClaudeCreds(Date.now() - 60_000, {
      claudeAiOauth: {
        accessToken: 'OLD',
        // refreshToken: missing entirely
        expiresAt: Date.now() - 60_000,
        scopes: [],
        subscriptionType: 'max',
        rateLimitTier: 'default',
      },
    });
    await expect(ensureFreshAuth('claude')).rejects.toThrow(/re-authenticate/i);
    expect(refreshClaudeMock).toHaveBeenCalledTimes(0);
  });

  test('throws with re-auth instructions on terminal refresh failure', async () => {
    writeClaudeCreds(Date.now() - 60_000);
    refreshClaudeMock.mockImplementationOnce(async () => ({
      refreshed: false as const,
      reason: 'refresh_revoked' as const,
    }));
    await expect(ensureFreshAuth('claude')).rejects.toThrow(/re-authenticate/i);
  });

  test('does NOT throw on transient refresh failure (network/unknown)', async () => {
    writeClaudeCreds(Date.now() - 60_000);
    refreshClaudeMock.mockImplementationOnce(async () => ({
      refreshed: false as const,
      reason: 'network' as const,
    }));
    await ensureFreshAuth('claude');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude', reason: 'network' }),
      'provider_preflight_refresh_failed_transient'
    );
  });

  test('does not log raw token values', async () => {
    writeClaudeCreds(Date.now() - 60_000);
    refreshClaudeMock.mockImplementationOnce(async () => ({
      refreshed: false as const,
      reason: 'refresh_expired' as const,
    }));
    try {
      await ensureFreshAuth('claude');
    } catch {
      // expected throw
    }
    const allLogCalls = [
      ...mockLogger.info.mock.calls,
      ...mockLogger.error.mock.calls,
      ...mockLogger.debug.mock.calls,
      ...mockLogger.warn.mock.calls,
    ];
    const serialized = JSON.stringify(allLogCalls);
    // Match the placeholders we wrote — these are NOT real tokens but the
    // test still proves redaction by checking they don't leak.
    expect(serialized).not.toContain('ACCESS_PLACEHOLDER');
    expect(serialized).not.toContain('REFRESH_PLACEHOLDER');
  });
});

describe('ensureFreshAuth (Codex)', () => {
  test('short-circuits when last_refresh is recent (<11h ago)', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    writeCodexCreds(recent);
    await ensureFreshAuth('codex');
    expect(refreshCodexMock).toHaveBeenCalledTimes(0);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex' }),
      'provider_preflight_refresh_short_circuit_fresh'
    );
  });

  test('triggers refresh when last_refresh is older than 11h', async () => {
    const stale = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(); // 12h ago
    writeCodexCreds(stale);
    await ensureFreshAuth('codex');
    expect(refreshCodexMock).toHaveBeenCalledTimes(1);
  });

  test('returns quietly when no creds file exists', async () => {
    await ensureFreshAuth('codex');
    expect(refreshCodexMock).toHaveBeenCalledTimes(0);
  });

  test('throws on terminal refresh failure', async () => {
    const stale = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    writeCodexCreds(stale);
    refreshCodexMock.mockImplementationOnce(async () => ({
      refreshed: false as const,
      reason: 'refresh_revoked' as const,
    }));
    await expect(ensureFreshAuth('codex')).rejects.toThrow(/Re-authenticate/i);
  });
});
