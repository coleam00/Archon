import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { registerGitCredentialRoute, type GitCredentialRouteDeps } from './git-credentials';

// Mock logger to suppress noisy output during tests
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

describe('POST /internal/git-credential', () => {
  const mockVerifyRunToken = mock((runId: string, token: string) => token === `art_${runId}`);
  const mockVerifySessionToken = mock(
    (sessionId: string, token: string) => token === `ast_${sessionId}`
  );
  const mockGetWorkflowRun = mock(async (runId: string) => {
    if (runId === 'run-active') {
      return { id: 'run-active', status: 'running', user_id: 'user-1' } as any;
    }
    if (runId === 'run-active-no-user') {
      return { id: 'run-active-no-user', status: 'pending', user_id: null } as any;
    }
    if (runId === 'run-completed') {
      return { id: 'run-completed', status: 'completed', user_id: 'user-1' } as any;
    }
    return null;
  });
  const mockGetConversationById = mock(async (sessionId: string) => {
    if (sessionId === 'conv-active') {
      return { id: 'conv-active', user_id: 'user-2' } as any;
    }
    if (sessionId === 'conv-no-user') {
      return { id: 'conv-no-user', user_id: null } as any;
    }
    return null;
  });
  const mockGetDecryptedAccessToken = mock(async (userId: string) => {
    if (userId === 'user-1') return 'ghp_user1token';
    if (userId === 'user-2') return 'ghp_user2token';
    return null;
  });
  const mockGetInstallationToken = mock(
    async (owner: string, repo: string) => `ghs_app_token_${owner}_${repo}`
  );

  function createApp(overrides: Partial<GitCredentialRouteDeps> = {}): OpenAPIHono {
    const app = new OpenAPIHono();
    registerGitCredentialRoute(app, {
      verifyRunToken: mockVerifyRunToken,
      verifySessionToken: mockVerifySessionToken,
      getWorkflowRun: mockGetWorkflowRun,
      getConversationById: mockGetConversationById,
      getDecryptedAccessToken: mockGetDecryptedAccessToken,
      githubAppAuthProvider: { getInstallationToken: mockGetInstallationToken },
      ...overrides,
    });
    return app;
  }

  beforeEach(() => {
    mockVerifyRunToken.mockClear();
    mockVerifySessionToken.mockClear();
    mockGetWorkflowRun.mockClear();
    mockGetConversationById.mockClear();
    mockGetDecryptedAccessToken.mockClear();
    mockGetInstallationToken.mockClear();
  });

  test('rejects request with unsupported host with 400', async () => {
    const app = createApp();
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'gitlab.com', path: 'owner/repo' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported host' });
  });

  test('rejects request with invalid or unparseable path with 400', async () => {
    const app = createApp();
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'github.com', path: 'invalid-path-no-slash' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unparseable path' });
  });

  test('rejects invalid run token with 403', async () => {
    const app = createApp();
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
        runId: 'run-active',
        runToken: 'invalid-token',
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid run credential' });
  });

  test('rejects run when run does not exist with 403', async () => {
    const app = createApp();
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
        runId: 'run-missing',
        runToken: 'art_run-missing',
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'run not active' });
  });

  test('rejects run when run is completed/inactive with 403', async () => {
    const app = createApp();
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
        runId: 'run-completed',
        runToken: 'art_run-completed',
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'run not active' });
  });

  test('returns user access token for active run with user_id', async () => {
    const app = createApp();
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
        runId: 'run-active',
        runToken: 'art_run-active',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'ghp_user1token' });
    expect(mockGetDecryptedAccessToken).toHaveBeenCalledWith('user-1');
  });

  test('fails closed with 403 if active run has user_id but token resolution returns null (expired/revoked)', async () => {
    const app = createApp();
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
        runId: 'run-active',
        runToken: 'art_run-active',
      }),
    });
    // Override getDecryptedAccessToken to return null
    const appWithExpiredToken = createApp({
      getDecryptedAccessToken: mock(async () => null),
    });
    const resExpired = await appWithExpiredToken.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
        runId: 'run-active',
        runToken: 'art_run-active',
      }),
    });
    expect(resExpired.status).toBe(403);
    expect(await resExpired.json()).toEqual({ error: 'user access token missing or expired' });
  });

  test('falls back to App installation token for active run without user_id', async () => {
    const app = createApp();
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo.git',
        runId: 'run-active-no-user',
        runToken: 'art_run-active-no-user',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'ghs_app_token_owner_repo' });
    expect(mockGetInstallationToken).toHaveBeenCalledWith('owner', 'repo');
  });

  test('rejects invalid session token with 403', async () => {
    const app = createApp();
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
        sessionId: 'conv-active',
        sessionToken: 'invalid-session-token',
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid session credential' });
  });

  test('returns user access token for session with conversation user_id', async () => {
    const app = createApp();
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
        sessionId: 'conv-active',
        sessionToken: 'ast_conv-active',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'ghp_user2token' });
    expect(mockGetDecryptedAccessToken).toHaveBeenCalledWith('user-2');
  });

  test('fails closed with 403 if session has user_id but token resolution returns null', async () => {
    const appWithExpiredToken = createApp({
      getDecryptedAccessToken: mock(async () => null),
    });
    const res = await appWithExpiredToken.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
        sessionId: 'conv-active',
        sessionToken: 'ast_conv-active',
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'user access token missing or expired' });
  });

  test('falls back to App installation token for session without user_id', async () => {
    const app = createApp();
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
        sessionId: 'conv-no-user',
        sessionToken: 'ast_conv-no-user',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'ghs_app_token_owner_repo' });
  });

  test('rejects request with 403 when no token/credentials provided even when app provider exists', async () => {
    const app = createApp();
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'no valid credential presented' });
    expect(mockGetInstallationToken).not.toHaveBeenCalled();
  });

  test('returns 403 when no token/credentials provided and no app provider', async () => {
    const app = createApp({ githubAppAuthProvider: null });
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'no valid credential presented' });
  });

  test('returns 500 when dependency throws unexpected error', async () => {
    const app = createApp({
      getWorkflowRun: mock(async () => {
        throw new Error('Database disconnected');
      }),
    });
    const res = await app.request('/internal/git-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'github.com',
        path: 'owner/repo',
        runId: 'run-active',
        runToken: 'art_run-active',
      }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'resolution failed' });
  });
});
