/**
 * Tests for the GitHub App auth module.
 *
 * Strictly mocked at the @octokit/rest boundary — no live api.github.com calls
 * in CI (PRD Q7). `mock.module` is process-global; this file is the ONLY place
 * in @archon/core that mocks @octokit/rest, and it's slotted as its own
 * `bun test` invocation in package.json's test script for isolation.
 */
import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Capture the constructor arg + request fn so each test can inspect calls.
const lastOctokitInit = { current: undefined as unknown };

// One mockRequest used by every Octokit instance. Tests use mockResolvedValueOnce
// to queue responses in call order. The 'GET /repos/.../installation' and
// 'POST /app/installations/.../access_tokens' endpoints share this queue, so
// queue responses in execution order.
const mockRequest = mock(async (..._args: unknown[]) => ({
  status: 200,
  data: {},
}));

class FakeOctokit {
  // The constructor records its init payload so tests can assert auth config.
  constructor(init: unknown) {
    lastOctokitInit.current = init;
  }
  request = mockRequest;
}

mock.module('@octokit/rest', () => ({ Octokit: FakeOctokit }));

// The real @octokit/auth-app exports `createAppAuth`; we don't actually exercise
// it in the cache/lookup paths (those go through Octokit.request), but the
// factory still passes `authStrategy: createAppAuth` to Octokit, so the symbol
// has to exist.
const mockCreateAppAuth = mock(() => async () => ({ token: 'mock-jwt' }));
mock.module('@octokit/auth-app', () => ({
  createAppAuth: mockCreateAppAuth,
}));

import { createGitHubAppAuthProvider } from './auth';
import { loadAppPrivateKey } from './private-key';
import { AppNotInstalledError, AppPrivateKeyError } from './errors';

const REAL_PEM =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----';

function makeProvider(opts: { defaultInstallationId?: number } = {}) {
  return createGitHubAppAuthProvider({
    appId: '12345',
    privateKey: REAL_PEM,
    slug: 'archon-test',
    defaultInstallationId: opts.defaultInstallationId,
  });
}

function tokenResponse(token: string, expiresInSec: number) {
  return {
    status: 201,
    data: {
      token,
      expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    },
  };
}

beforeEach(() => {
  mockRequest.mockReset();
});

describe('loadAppPrivateKey', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  test('returns inline PEM when GITHUB_APP_PRIVATE_KEY is set', () => {
    process.env.GITHUB_APP_PRIVATE_KEY = REAL_PEM;
    expect(loadAppPrivateKey()).toBe(REAL_PEM);
  });

  test('normalizes literal \\n to real newlines for .env-quoted values', () => {
    // Simulate `KEY="-----BEGIN...\n...\n-----END..."` style .env values.
    process.env.GITHUB_APP_PRIVATE_KEY = REAL_PEM.replace(/\n/g, '\\n');
    const loaded = loadAppPrivateKey();
    expect(loaded).toBe(REAL_PEM);
    expect(loaded.includes('\n')).toBe(true);
  });

  test('reads from GITHUB_APP_PRIVATE_KEY_PATH file when inline not set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-auth-test-'));
    const path = join(dir, 'app.pem');
    writeFileSync(path, REAL_PEM);
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = path;
    try {
      expect(loadAppPrivateKey()).toBe(REAL_PEM);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws AppPrivateKeyError when neither env is set', () => {
    expect(() => loadAppPrivateKey()).toThrow(AppPrivateKeyError);
  });

  test('throws AppPrivateKeyError when file is not PEM-shaped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-auth-test-'));
    const path = join(dir, 'app.pem');
    writeFileSync(path, 'this is not a pem');
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = path;
    try {
      expect(() => loadAppPrivateKey()).toThrow(AppPrivateKeyError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('getInstallationToken', () => {
  test('returns cached token when fresh (>5min remaining)', async () => {
    const provider = makeProvider();
    mockRequest
      .mockResolvedValueOnce({ status: 200, data: { id: 99 } }) // install lookup
      .mockResolvedValueOnce(tokenResponse('ghs_fresh', 3600)); // token issue

    const first = await provider.getInstallationToken('o', 'r');
    expect(first).toBe('ghs_fresh');

    // Second call must hit cache for BOTH the lookup and the token.
    const second = await provider.getInstallationToken('o', 'r');
    expect(second).toBe('ghs_fresh');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  test('refreshes when within 5min of expiry', async () => {
    const provider = makeProvider();
    mockRequest
      .mockResolvedValueOnce({ status: 200, data: { id: 99 } })
      .mockResolvedValueOnce(tokenResponse('ghs_expiring', 60)) // expires in 1min
      .mockResolvedValueOnce(tokenResponse('ghs_fresh', 3600));

    await provider.getInstallationToken('o', 'r');
    const second = await provider.getInstallationToken('o', 'r');
    expect(second).toBe('ghs_fresh');
    // 1 install lookup + 2 token issues.
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });

  test('skips lookup when defaultInstallationId is set', async () => {
    const provider = makeProvider({ defaultInstallationId: 555 });
    mockRequest.mockResolvedValueOnce(tokenResponse('ghs_direct', 3600));

    const token = await provider.getInstallationToken('whatever', 'repo');
    expect(token).toBe('ghs_direct');
    // Exactly one call — the token-issuance, no install lookup.
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const firstCallArgs = mockRequest.mock.calls[0];
    expect(firstCallArgs?.[0]).toBe('POST /app/installations/{installation_id}/access_tokens');
  });
});

describe('resolveInstallationId', () => {
  test('caches owner/repo → installationId across calls', async () => {
    const provider = makeProvider();
    mockRequest.mockResolvedValueOnce({ status: 200, data: { id: 42 } });

    const id1 = await provider.resolveInstallationId('o', 'r');
    const id2 = await provider.resolveInstallationId('o', 'r');
    expect(id1).toBe(42);
    expect(id2).toBe(42);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  test('treats owner/repo case-insensitively for cache key', async () => {
    const provider = makeProvider();
    mockRequest.mockResolvedValueOnce({ status: 200, data: { id: 7 } });

    await provider.resolveInstallationId('Owner', 'Repo');
    const second = await provider.resolveInstallationId('owner', 'repo');
    expect(second).toBe(7);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  test('throws AppNotInstalledError on 404', async () => {
    const provider = makeProvider();
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    mockRequest.mockRejectedValueOnce(err);

    await expect(provider.resolveInstallationId('missing', 'repo')).rejects.toBeInstanceOf(
      AppNotInstalledError
    );
  });
});

describe('primeInstallationLookup', () => {
  test('priming from webhook payload skips the lookup HTTP call', async () => {
    const provider = makeProvider();
    provider.primeInstallationLookup('o', 'r', 1234);

    mockRequest.mockResolvedValueOnce(tokenResponse('ghs_primed', 3600));
    const token = await provider.getInstallationToken('o', 'r');
    expect(token).toBe('ghs_primed');
    // Only the token issuance — no lookup.
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateToken', () => {
  test('causes next call to re-issue', async () => {
    const provider = makeProvider({ defaultInstallationId: 1 });
    mockRequest
      .mockResolvedValueOnce(tokenResponse('ghs_first', 3600))
      .mockResolvedValueOnce(tokenResponse('ghs_second', 3600));

    const first = await provider.getInstallationToken('o', 'r');
    expect(first).toBe('ghs_first');

    provider.invalidateToken(1);

    const second = await provider.getInstallationToken('o', 'r');
    expect(second).toBe('ghs_second');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });
});

describe('getOctokitForInstallation', () => {
  test('returns same instance for same installation (memoised)', async () => {
    const provider = makeProvider({ defaultInstallationId: 9 });
    const a = await provider.getOctokitForInstallation('o', 'r');
    const b = await provider.getOctokitForInstallation('o', 'r');
    expect(a).toBe(b);
  });

  test('returns distinct instances for distinct installations (multi-install)', async () => {
    const provider = makeProvider();
    mockRequest
      .mockResolvedValueOnce({ status: 200, data: { id: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { id: 2 } });

    const a = await provider.getOctokitForInstallation('alpha', 'r');
    const b = await provider.getOctokitForInstallation('beta', 'r');
    expect(a).not.toBe(b);
  });
});
