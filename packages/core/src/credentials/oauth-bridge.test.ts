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
function makeProvider(id: string, usesCallbackServer?: boolean) {
  return {
    id,
    name: id,
    ...(usesCallbackServer ? { usesCallbackServer } : {}),
    login: (cb: Callbacks) => loginImpl(cb),
    refreshToken: async (c: Record<string, unknown>) => c,
    getApiKey: () => 'k',
  };
}
// anthropic/codex bind a local fixed-port callback server in pi (#1963).
const anthropic = makeProvider('anthropic', true);
const codex = makeProvider('openaiCodex', true);
const copilot = makeProvider('github-copilot');
mock.module('@archon/providers/oauth', () => ({
  getOAuthProvider: (id: string) =>
    ({ anthropic, openaiCodex: codex, 'github-copilot': copilot })[id],
  getOAuthApiKey: async () => ({ newCredentials: {}, apiKey: 'k' }),
  anthropicOAuthProvider: anthropic,
  openaiCodexOAuthProvider: codex,
  githubCopilotOAuthProvider: copilot,
}));

// The openai (ChatGPT/Codex) flow is Archon-owned (#1924) — drive its exchange
// and paste parsing via controllable impls; the authorize flow is stubbed thin.
let exchangeImpl: (code: string, verifier: string) => Promise<Record<string, unknown>>;
const defaultParseImpl = (input: string): { code?: string; state?: string } => {
  const v = input.trim();
  if (v.includes('#')) {
    const [code, state] = v.split('#', 2);
    return { code, state };
  }
  return { code: v };
};
let parseImpl = defaultParseImpl;
mock.module('./openai-oauth', () => ({
  createOpenAiAuthorizeFlow: () => ({
    url: 'https://auth.openai.com/oauth/authorize?mock=1',
    verifier: 'pkce-verifier-1',
    state: 'state-1',
  }),
  parseOpenAiAuthorizationInput: (input: string) => parseImpl(input),
  exchangeOpenAiAuthorizationCode: (code: string, verifier: string) => exchangeImpl(code, verifier),
  // Imported by user-provider-key-store (loaded transitively via connect-service);
  // unused by the bridge itself.
  mintOpenAiOAuthApiKey: async (creds: Record<string, unknown>) => ({
    newCredentials: creds,
    apiKey: 'k',
  }),
  refreshOpenAiOAuthCredentials: async (creds: Record<string, unknown>) => creds,
}));

const {
  startOAuth,
  pollOAuth,
  cancelOAuth,
  resetOAuthSessionsForTest,
  OAuthCallbackPortBusyError,
} = await import('./oauth-bridge');

function tick(ms = 15): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('oauth-bridge', () => {
  beforeEach(() => {
    resetOAuthSessionsForTest();
    mockQuery.mockClear();
    parseImpl = defaultParseImpl;
  });

  test('unknown / non-subscription provider → throws', async () => {
    await expect(startOAuth('u1', 'openrouter')).rejects.toThrow(/does not support subscription/);
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

  // ---- #1963: abandoned logins must not wedge the fixed callback port ----

  test('aborting a session rejects the manual-code deferred so a pi-style login releases its callback server (#1963)', async () => {
    // Mirror pi-ai 0.79.1 loginAnthropic: the callback server only closes in a
    // `finally` reached after onManualCodeInput() settles — pi ignores the
    // abort signal, so the deferred rejection is the only path there.
    let serverClosed = false;
    loginImpl = async cb => {
      cb.onAuth({ url: 'https://x' });
      try {
        await cb.onManualCodeInput!();
      } finally {
        serverClosed = true; // pi's `finally { server.close() }`
      }
      return { access: 'a' };
    };
    const start = await startOAuth('u1', 'claude');
    expect(serverClosed).toBe(false);
    cancelOAuth(start.sessionId, 'u1');
    await tick();
    expect(serverClosed).toBe(true);
  });

  test("a callback-server vendor start supersedes another user's abandoned session (#1963)", async () => {
    let serversClosed = 0;
    loginImpl = async cb => {
      cb.onAuth({ url: 'https://x' });
      try {
        await cb.onManualCodeInput!();
      } finally {
        serversClosed++;
      }
      return { access: 'a' };
    };
    // alice starts an anthropic login and abandons it (no poll, no code).
    const a = await startOAuth('alice', 'claude');
    // bob's anthropic login must not 500 on the held port: it cancels alice's
    // flow (releasing the server) and proceeds.
    const b = await startOAuth('bob', 'claude');
    expect(serversClosed).toBe(1);
    // S2: the superseded user's poll detail is user-visible in the console
    // retry UX — pin the exact message.
    const supersededPoll = pollOAuth(a.sessionId, 'alice');
    expect(supersededPoll.status).toBe('error');
    expect(supersededPoll.detail).toBe('Login session not found or expired.');
    // bob's flow still completes end-to-end.
    pollOAuth(b.sessionId, 'bob', 'CODE');
    await tick();
    expect(pollOAuth(b.sessionId, 'bob').status).toBe('connected');
  });

  test('cancel AFTER the code was submitted → the credential persists exactly once (S1)', async () => {
    // abortSession claims rejecting an already-resolved deferred is a no-op;
    // pin that a post-submit cancel can neither lose nor double-persist.
    loginImpl = async cb => {
      cb.onAuth({ url: 'https://x' });
      const code = await cb.onManualCodeInput!();
      return { access: `a-${code}`, refresh: 'r', expires: 1 };
    };
    const start = await startOAuth('u1', 'claude');
    mockQuery.mockClear();
    pollOAuth(start.sessionId, 'u1', 'CODE'); // resolves the deferred
    cancelOAuth(start.sessionId, 'u1'); // cancel races the in-flight login
    await tick();
    // persistProviderOAuth → saveUserProviderKey → exactly one INSERT.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).toContain('INSERT INTO remote_agent_user_provider_keys');
  });

  test('superseded while start is still awaiting the first signal → start throws, not a url-less 200 (S4)', async () => {
    // First login never signals onAuth; it unblocks only when the supersede
    // rejects the manual-code deferred.
    loginImpl = async cb => {
      await cb.onManualCodeInput!();
      return { access: 'a' };
    };
    const first = startOAuth('u1', 'claude');
    await tick(1); // let the first session register
    loginImpl = async cb => {
      cb.onAuth({ url: 'https://second' });
      await cb.onManualCodeInput!();
      return { access: 'a' };
    };
    const second = await startOAuth('u1', 'claude');
    expect(second.url).toBe('https://second');
    await expect(first).rejects.toThrow(/superseded/i);
  });

  test('device-flow logins (no callback server) for different users coexist', async () => {
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>(r => {
      resolveFirst = r;
    });
    loginImpl = async cb => {
      cb.onDeviceCode({ userCode: 'AAAA', verificationUri: 'https://dev' });
      await firstGate;
      return { access: 'a' };
    };
    const a = await startOAuth('alice', 'copilot');
    loginImpl = async cb => {
      cb.onDeviceCode({ userCode: 'BBBB', verificationUri: 'https://dev' });
      return { access: 'b' };
    };
    const b = await startOAuth('bob', 'copilot');
    // alice's pending device login was NOT superseded by bob's.
    expect(pollOAuth(a.sessionId, 'alice').status).toBe('pending');
    resolveFirst();
    await tick();
    expect(pollOAuth(a.sessionId, 'alice').status).toBe('connected');
    expect(pollOAuth(b.sessionId, 'bob').status).toBe('connected');
  });

  test('a login impl that ignores the cancel entirely cannot permanently break later starts (#1963 regression)', async () => {
    // Worst case: login neither honors the abort signal nor consumes the
    // manual-code deferred, and never settles. The bridge waits a bounded
    // settle window, then proceeds with the new login.
    loginImpl = async cb => {
      cb.onAuth({ url: 'https://wedged' });
      await new Promise<never>(() => {}); // never settles
      return {};
    };
    const first = await startOAuth('u1', 'claude');
    expect(first.url).toBe('https://wedged');

    let received: string | undefined;
    loginImpl = async cb => {
      cb.onAuth({ url: 'https://fresh' });
      received = await cb.onManualCodeInput!();
      return { access: 'a', refresh: 'r', expires: 1 };
    };
    const second = await startOAuth('u2', 'claude');
    expect(second.url).toBe('https://fresh');
    pollOAuth(second.sessionId, 'u2', 'CODE');
    await tick();
    expect(received).toBe('CODE');
    expect(pollOAuth(second.sessionId, 'u2').status).toBe('connected');
  }, 10000);

  test('EADDRINUSE at start surfaces an actionable retryable error, not an opaque failure (#1963)', async () => {
    loginImpl = async () => {
      throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:53692');
    };
    let thrown: unknown;
    try {
      await startOAuth('u1', 'claude');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OAuthCallbackPortBusyError);
    expect((thrown as Error).message).toMatch(/callback port/i);
    expect((thrown as Error).message).toMatch(/retry/i);
  });

  // ---- #1924: openai (ChatGPT/Codex) runs the Archon-owned PKCE flow ----

  test('openai manual flow: start returns the authorize URL, poll(code) exchanges → connected', async () => {
    let exchanged: { code: string; verifier: string } | undefined;
    exchangeImpl = async (code, verifier) => {
      exchanged = { code, verifier };
      return { access: 'at', refresh: 'rt', expires: 9, accountId: 'acct-1', id_token: 'idt' };
    };
    const start = await startOAuth('u1', 'openai');
    expect(start.mode).toBe('manual');
    expect(start.url).toBe('https://auth.openai.com/oauth/authorize?mock=1');

    expect(pollOAuth(start.sessionId, 'u1', 'AUTHCODE').status).toBe('pending');
    await tick();
    // The pasted code is exchanged with the per-attempt PKCE verifier.
    expect(exchanged).toEqual({ code: 'AUTHCODE', verifier: 'pkce-verifier-1' });
    expect(pollOAuth(start.sessionId, 'u1').status).toBe('connected');
  });

  test("legacy 'codex' id runs the openai flow (gate lifted, #1924)", async () => {
    exchangeImpl = async () => ({ access: 'a', refresh: 'r', expires: 1, id_token: 'idt' });
    const start = await startOAuth('u1', 'codex');
    expect(start.mode).toBe('manual');
    expect(start.url).toContain('auth.openai.com');
  });

  test('openai flow: pasted state mismatch → error, no exchange', async () => {
    let exchangeCalls = 0;
    exchangeImpl = async () => {
      exchangeCalls++;
      return {};
    };
    const start = await startOAuth('u1', 'openai');
    pollOAuth(start.sessionId, 'u1', 'CODE#wrong-state');
    await tick();
    const res = pollOAuth(start.sessionId, 'u1');
    expect(res.status).toBe('error');
    expect(res.detail).toMatch(/state mismatch/i);
    expect(exchangeCalls).toBe(0);
  });

  test('openai flow: exchange failure surfaces via poll', async () => {
    exchangeImpl = async () => {
      throw new Error('OpenAI token exchange failed (400): invalid_grant');
    };
    const start = await startOAuth('u1', 'openai');
    pollOAuth(start.sessionId, 'u1', 'BADCODE');
    await tick();
    const res = pollOAuth(start.sessionId, 'u1');
    expect(res.status).toBe('error');
    expect(res.detail).toContain('invalid_grant');
  });

  test('openai flow: abort cancels cleanly (no callback server involved)', async () => {
    exchangeImpl = async () => ({ access: 'a' });
    const start = await startOAuth('u1', 'openai');
    cancelOAuth(start.sessionId, 'u1');
    await tick();
    expect(pollOAuth(start.sessionId, 'u1').status).toBe('error'); // session dropped
  });

  test('openai flow: state-only paste (no code) → Missing authorization code, no exchange (S1)', async () => {
    parseImpl = () => ({ state: 'state-1' }); // e.g. a redirect URL the user copied before authorizing
    let exchangeCalls = 0;
    exchangeImpl = async () => {
      exchangeCalls++;
      return {};
    };
    const start = await startOAuth('u1', 'openai');
    pollOAuth(start.sessionId, 'u1', 'http://localhost:1455/auth/callback?state=state-1');
    await tick();
    const res = pollOAuth(start.sessionId, 'u1');
    expect(res.status).toBe('error');
    expect(res.detail).toMatch(/missing authorization code/i);
    expect(exchangeCalls).toBe(0);
  });

  test('a second openai login for the same user supersedes the first (S1)', async () => {
    exchangeImpl = async () => ({ access: 'a', refresh: 'r', expires: 1, id_token: 'idt' });
    const first = await startOAuth('u1', 'openai');
    const second = await startOAuth('u1', 'openai');
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(pollOAuth(first.sessionId, 'u1').status).toBe('error'); // dropped
  });
});
