import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

// persistProviderOAuth (called on success) writes through the store → mock the DB.
const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
mock.module('../db/connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
}));

// Drive Pi's login() via a controllable impl. The singletons are the objects the
// bridge maps Archon providers to (claude→anthropic, codex→openaiCodex, copilot→…).
type Callbacks = {
  onAuth: (info: { url: string }) => void;
  onDeviceCode: (info: { userCode: string; verificationUri: string }) => void;
  onManualCodeInput?: () => Promise<string>;
  onPrompt: (p: unknown) => Promise<string>;
  onSelect: (p: { options: { id: string }[] }) => Promise<string | undefined>;
  onProgress?: (m: string) => void;
  signal?: AbortSignal;
};
let loginImpl: (cb: Callbacks) => Promise<Record<string, unknown>>;
function makeProvider(id: string) {
  return {
    id,
    name: id,
    login: (cb: Callbacks) => loginImpl(cb),
    refreshToken: async (c: Record<string, unknown>) => c,
    getApiKey: () => 'k',
  };
}
const anthropic = makeProvider('anthropic');
const codex = makeProvider('openaiCodex');
const copilot = makeProvider('github-copilot');
mock.module('@archon/providers/oauth', () => ({
  getOAuthProvider: (id: string) =>
    ({ anthropic, openaiCodex: codex, 'github-copilot': copilot })[id],
  getOAuthApiKey: async () => ({ newCredentials: {}, apiKey: 'k' }),
  anthropicOAuthProvider: anthropic,
  openaiCodexOAuthProvider: codex,
  githubCopilotOAuthProvider: copilot,
}));

const { startOAuth, pollOAuth, cancelOAuth, resetOAuthSessionsForTest } =
  await import('./oauth-bridge');

function tick(ms = 15): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('oauth-bridge', () => {
  beforeEach(() => {
    resetOAuthSessionsForTest();
    mockQuery.mockClear();
  });

  test('unknown / non-subscription / disabled provider → throws', async () => {
    await expect(startOAuth('u1', 'openrouter')).rejects.toThrow(/does not support subscription/);
    // codex is wired (ARCHON_TO_PI_OAUTH) but gated out of SUBSCRIPTION_PROVIDERS
    // because Pi drops the OpenAI id_token → Codex CLI rejects it (#1924).
    await expect(startOAuth('u1', 'codex')).rejects.toThrow(/does not support subscription/);
  });

  test('manual flow: start returns url, poll(code) unblocks login → connected', async () => {
    let received: string | undefined;
    loginImpl = async cb => {
      cb.onAuth({ url: 'https://auth.example/login' });
      received = await cb.onManualCodeInput!();
      return { access: 'a', refresh: 'r', expires: 1 };
    };
    const start = await startOAuth('u1', 'claude');
    expect(start.mode).toBe('manual');
    expect(start.url).toBe('https://auth.example/login');

    // First poll submits the pasted code; login() then resolves async.
    expect(pollOAuth(start.sessionId, 'u1', 'CODE123').status).toBe('pending');
    await tick();
    expect(received).toBe('CODE123');
    expect(pollOAuth(start.sessionId, 'u1').status).toBe('connected');
    // Connected → session is dropped (a second poll can't find it).
    expect(pollOAuth(start.sessionId, 'u1').status).toBe('error');
  });

  test('device flow: start returns user-code, poll → connected', async () => {
    loginImpl = async cb => {
      cb.onDeviceCode({ userCode: 'WXYZ', verificationUri: 'https://dev' });
      return { access: 'a', refresh: 'r', expires: 1 };
    };
    const start = await startOAuth('u1', 'copilot');
    expect(start.mode).toBe('device');
    expect(start.userCode).toBe('WXYZ');
    expect(start.verificationUri).toBe('https://dev');
    await tick();
    expect(pollOAuth(start.sessionId, 'u1').status).toBe('connected');
  });

  test('login() rejects AFTER start (during the code wait) → poll surfaces error', async () => {
    loginImpl = async cb => {
      cb.onAuth({ url: 'https://auth.example/login' });
      await cb.onManualCodeInput!(); // start returns first; reject only after the code is submitted
      throw new Error('user denied');
    };
    const start = await startOAuth('u1', 'claude');
    expect(start.mode).toBe('manual');
    pollOAuth(start.sessionId, 'u1', 'CODE'); // submit → login resumes → throws
    await tick();
    const res = pollOAuth(start.sessionId, 'u1');
    expect(res.status).toBe('error');
    expect(res.detail).toContain('user denied');
  });

  test("a different user's poll cannot resolve someone else's session", async () => {
    loginImpl = async cb => {
      cb.onAuth({ url: 'https://x' });
      await cb.onManualCodeInput!();
      return { access: 'a' };
    };
    const start = await startOAuth('alice', 'claude');
    expect(pollOAuth(start.sessionId, 'mallory').status).toBe('error');
  });

  test('login() rejects before any callback → startOAuth throws (I1, no silent url-less window)', async () => {
    loginImpl = async () => {
      throw new Error('boom early');
    };
    await expect(startOAuth('u1', 'claude')).rejects.toThrow(/boom early/);
  });

  test('cancelOAuth drops the session', async () => {
    loginImpl = async cb => {
      cb.onAuth({ url: 'https://x' });
      await cb.onManualCodeInput!();
      return { access: 'a' };
    };
    const start = await startOAuth('u1', 'claude');
    cancelOAuth(start.sessionId, 'u1');
    expect(pollOAuth(start.sessionId, 'u1').status).toBe('error');
  });

  test('a new login for the same user aborts the prior session (I3)', async () => {
    loginImpl = async cb => {
      cb.onAuth({ url: 'https://x' });
      await cb.onManualCodeInput!();
      return { access: 'a' };
    };
    const first = await startOAuth('u1', 'claude');
    const second = await startOAuth('u1', 'claude');
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(pollOAuth(first.sessionId, 'u1').status).toBe('error'); // prior session dropped
  });
});
