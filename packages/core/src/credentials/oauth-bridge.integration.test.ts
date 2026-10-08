// @archon-test-isolated
import { afterEach, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const paths = await import('@archon/paths');
const logger = createMockLogger();
mock.module('@archon/paths', () => ({ ...paths, createLogger: () => logger }));
const persist = mock(async () => ({ provider: 'github-copilot', kind: 'oauth' as const }));
mock.module('./connect-service', () => ({ persistProviderOAuth: persist }));
const { startOAuth, pollOAuth, cancelOAuth, resetOAuthSessionsForTest } =
  await import('./oauth-bridge');
const realFetch = globalThis.fetch;

afterEach(() => {
  resetOAuthSessionsForTest();
  globalThis.fetch = realFetch;
  persist.mockClear();
  logger.warn.mockClear();
});

test('real Anthropic callback capability supersedes another user and releases the port', async () => {
  const alice = await startOAuth('alice', 'anthropic');
  try {
    expect(alice.url).toContain('https://claude.ai/oauth/authorize');
    expect(pollOAuth(alice.sessionId, 'alice').status).toBe('pending');
    const bob = await startOAuth('bob', 'anthropic');
    try {
      expect(pollOAuth(alice.sessionId, 'alice')).toEqual({
        status: 'error',
        detail: 'Login session not found or expired.',
      });
      expect(bob.url).toContain('https://claude.ai/oauth/authorize');
      expect(pollOAuth(bob.sessionId, 'bob').status).toBe('pending');
    } finally {
      cancelOAuth(bob.sessionId, 'bob');
    }
  } finally {
    cancelOAuth(alice.sessionId, 'alice');
  }
  expect(persist).not.toHaveBeenCalled();
});

test('Copilot policy failure connects with a visible safe warning', async () => {
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/device/code'))
        return Response.json({
          device_code: 'SECRET-DEVICE',
          user_code: 'SECRET-CODE',
          verification_uri: 'https://github.com/login/device',
          expires_in: 60,
          interval: 1,
        });
      if (url.endsWith('/access_token')) return Response.json({ access_token: 'SECRET-GITHUB' });
      if (url.endsWith('/token'))
        return Response.json({ token: 'SECRET-BEARER', expires_at: 2000000000 });
      if (url.endsWith('/models'))
        return Response.json({
          data: [
            {
              id: 'gpt-5.4',
              model_picker_enabled: true,
              policy: { state: 'unconfigured' },
            },
          ],
        });
      if (url.endsWith('/models/gpt-5.4/policy'))
        return new Response('SECRET-VENDOR-CONTENT', { status: 403 });
      throw new Error('Unexpected request');
    },
    { preconnect: realFetch.preconnect }
  );
  const start = await startOAuth('alice', 'github-copilot');
  const deadline = Date.now() + 3000;
  let result = pollOAuth(start.sessionId, 'alice');
  while (result.status === 'pending' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
    result = pollOAuth(start.sessionId, 'alice');
  }
  expect(result.status).toBe('connected');
  expect(persist).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith(
    {
      provider: 'github-copilot',
      message: 'A Copilot model policy could not be enabled.',
    },
    'oauth_bridge.progress'
  );
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SECRET');
});
