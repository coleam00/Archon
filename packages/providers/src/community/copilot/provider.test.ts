/**
 * CopilotProvider end-to-end test with a fully mocked @github/copilot-sdk.
 *
 * Covers: streaming chunks flow through the async generator, resume
 * fallback on missing session, abort wiring, unsupported-option log-warn,
 * missing-model throw, terminal result chunk carries sessionId + tokens.
 *
 * Runs in its own bun test invocation — mocks @github/copilot-sdk and
 * @archon/paths process-wide.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SessionEvent } from '@github/copilot-sdk';

import { createMockLogger } from '../../test/mocks/logger';

// ─── Mocks ───────────────────────────────────────────────────────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

// Minimal fake session. Records prompt, exposes the listener so tests can
// fire events synthetically, and resolves sendAndWait when `resolveSend()` is called.
interface FakeSession {
  sessionId: string;
  prompt?: string;
  sendTimeout?: number;
  aborted: boolean;
  disconnected: boolean;
  abortError?: Error;
  listener: ((event: SessionEvent) => void) | undefined;
  fire: (event: SessionEvent) => void;
  resolveSend: (result?: unknown) => void;
  rejectSend: (err: Error) => void;
}

function makeFakeSession(sessionId = 'sess-1'): FakeSession {
  let resolveSend: (v?: unknown) => void = () => undefined;
  let rejectSend: (e: Error) => void = () => undefined;
  const sendPromise = new Promise<unknown>((resolve, reject) => {
    resolveSend = resolve;
    rejectSend = reject;
  });
  const fake: FakeSession = {
    sessionId,
    prompt: undefined,
    aborted: false,
    disconnected: false,
    listener: undefined,
    fire(event) {
      if (this.listener) this.listener(event);
    },
    resolveSend(result) {
      resolveSend(result);
    },
    rejectSend(err) {
      rejectSend(err);
    },
  };
  // Attach the session-shape methods the provider/bridge call:
  const session = fake as FakeSession & {
    on: (h: (e: SessionEvent) => void) => () => void;
    sendAndWait: (opts: { prompt: string }, timeout?: number) => Promise<unknown>;
    disconnect: () => Promise<void>;
    abort: () => Promise<void>;
  };
  session.on = (handler): (() => void) => {
    fake.listener = handler;
    return () => {
      fake.listener = undefined;
    };
  };
  session.sendAndWait = async (opts, timeout): Promise<unknown> => {
    fake.prompt = opts.prompt;
    fake.sendTimeout = timeout;
    return sendPromise;
  };
  session.disconnect = async (): Promise<void> => {
    fake.disconnected = true;
  };
  session.abort = async (): Promise<void> => {
    fake.aborted = true;
    if (fake.abortError) throw fake.abortError;
  };
  return session as unknown as FakeSession;
}

// Test-controlled fake client. We rebuild it per test via reset().
let nextCreateSessionResult: FakeSession | Error;
let nextResumeSessionResult: FakeSession | Error;
const createSessionSpy = mock((_opts: unknown): Promise<FakeSession> => {
  if (nextCreateSessionResult instanceof Error) {
    return Promise.reject(nextCreateSessionResult);
  }
  return Promise.resolve(nextCreateSessionResult);
});
const resumeSessionSpy = mock((_id: string, _opts: unknown): Promise<FakeSession> => {
  if (nextResumeSessionResult instanceof Error) {
    return Promise.reject(nextResumeSessionResult);
  }
  return Promise.resolve(nextResumeSessionResult);
});

let lastClientOpts: Record<string, unknown> | undefined;
class FakeCopilotClient {
  createSession = createSessionSpy;
  resumeSession = resumeSessionSpy;
  constructor(opts: Record<string, unknown>) {
    lastClientOpts = opts;
  }
}

// Capture the onPermissionRequest passed into createSession.
const approveAllStub = mock(() => ({ kind: 'approved' }));

mock.module('@github/copilot-sdk', () => ({
  CopilotClient: FakeCopilotClient,
  approveAll: approveAllStub,
}));

// Provider imports AFTER mocks are installed.
import { CopilotProvider, resetCopilotSingleton } from './provider';

function evt<T extends SessionEvent['type']>(type: T, data: unknown): SessionEvent {
  return {
    id: 'test',
    timestamp: new Date().toISOString(),
    parentId: null,
    type,
    data,
  } as unknown as SessionEvent;
}

// Drain an async generator (used when the producer feeds events async).
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe('CopilotProvider.getType / getCapabilities', () => {
  test('getType returns copilot', () => {
    expect(new CopilotProvider().getType()).toBe('copilot');
  });

  test('getCapabilities matches COPILOT_CAPABILITIES', () => {
    const c = new CopilotProvider().getCapabilities();
    expect(c.sessionResume).toBe(true);
    expect(c.effortControl).toBe(true);
    expect(c.thinkingControl).toBe(true);
    expect(c.mcp).toBe(true);
    expect(c.hooks).toBe(false);
  });
});

describe('CopilotProvider.sendQuery', () => {
  beforeEach(() => {
    resetCopilotSingleton();
    createSessionSpy.mockClear();
    resumeSessionSpy.mockClear();
    approveAllStub.mockClear();
    lastClientOpts = undefined;
  });

  test('defaults to model="auto" when none is configured', async () => {
    const session = makeFakeSession('sess-default-auto');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/tmp', undefined, { assistantConfig: {} });

    const firstNext = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.fire(evt('assistant.message_delta', { messageId: 'm', deltaContent: 'hi' }));
    session.resolveSend(undefined);
    await firstNext;
    await collect(gen);

    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const opts = createSessionSpy.mock.calls[0]![0] as { model: string };
    expect(opts.model).toBe('auto');
  });

  test('passes model + streaming=true + workingDirectory to createSession', async () => {
    const session = makeFakeSession('sess-1');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hello', '/work/dir', undefined, { model: 'gpt-5' });

    // Drive: start iteration (kicks off createSession); fire a tiny stream
    // and resolve sendAndWait so the generator completes.
    const firstNext = gen.next();
    // Give the async chain a tick so createSession resolves.
    await new Promise(resolve => setTimeout(resolve, 5));
    session.fire(evt('assistant.message_delta', { messageId: 'm', deltaContent: 'hi' }));
    session.resolveSend(undefined);
    const chunks = [(await firstNext).value, ...(await collect(gen))];

    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const opts = createSessionSpy.mock.calls[0]![0] as {
      model: string;
      streaming: boolean;
      workingDirectory: string;
    };
    expect(opts.model).toBe('gpt-5');
    expect(opts.streaming).toBe(true);
    expect(opts.workingDirectory).toBe('/work/dir');
    expect(session.prompt).toBe('hello');
    expect(chunks.some(c => c && typeof c === 'object' && 'type' in c && c.type === 'result')).toBe(
      true
    );
  });

  test('holds provider admission around sendAndWait and fails when lease ownership is lost', async () => {
    const session = makeFakeSession('sess-admitted');
    nextCreateSessionResult = session;
    const leaseController = new AbortController();
    let admit: (() => void) | undefined;
    const admitted = new Promise<void>(resolve => {
      admit = resolve;
    });
    const releases: { upstreamStopped: boolean }[] = [];

    const p = new CopilotProvider();
    const gen = p.sendQuery('hello', '/work/dir', undefined, {
      model: 'gpt-5',
      providerAttemptGate: {
        acquire: async () => {
          await admitted;
          return {
            signal: leaseController.signal,
            release: async options => {
              releases.push(options);
            },
          };
        },
      },
    });

    const firstNext = gen.next();
    await Bun.sleep(5);
    expect(session.prompt).toBeUndefined();

    admit?.();
    while (session.prompt === undefined) await Bun.sleep(1);
    expect(session.prompt).toBe('hello');

    leaseController.abort(new Error('lease lost'));
    while (!session.aborted) await Bun.sleep(1);
    await expect(
      (async (): Promise<void> => {
        await firstNext;
        await collect(gen);
      })()
    ).rejects.toThrow('lease lost');

    expect(session.aborted).toBe(true);
    expect(releases).toEqual([{ upstreamStopped: true }]);
  });

  test('preserves the lease when Copilot abort cannot confirm shutdown', async () => {
    const session = makeFakeSession('sess-unconfirmed-stop');
    session.abortError = new Error('abort transport failed');
    nextCreateSessionResult = session;
    const leaseController = new AbortController();
    const releases: { upstreamStopped: boolean }[] = [];

    const p = new CopilotProvider();
    const completion = collect(
      p.sendQuery('hello', '/work/dir', undefined, {
        model: 'gpt-5',
        providerAttemptGate: {
          acquire: async () => ({
            signal: leaseController.signal,
            release: async options => {
              releases.push(options);
            },
          }),
        },
      })
    );

    while (session.prompt === undefined) await Bun.sleep(1);
    leaseController.abort(new Error('lease lost'));

    await expect(completion).rejects.toThrow('Copilot session shutdown could not be confirmed');
    expect(session.aborted).toBe(true);
    expect(releases).toEqual([{ upstreamStopped: false }]);
  });

  test('preserves the lease when early consumer return cannot confirm shutdown', async () => {
    const session = makeFakeSession('sess-unconfirmed-early-return');
    session.abortError = new Error('abort transport failed');
    nextCreateSessionResult = session;
    const releases: { upstreamStopped: boolean }[] = [];

    const p = new CopilotProvider();
    const gen = p.sendQuery('hello', '/work/dir', undefined, {
      model: 'gpt-5',
      providerAttemptGate: {
        acquire: async () => ({
          signal: new AbortController().signal,
          release: async options => {
            releases.push(options);
          },
        }),
      },
    });

    const first = gen.next();
    while (session.prompt === undefined) await Bun.sleep(1);
    session.fire(evt('assistant.message_delta', { messageId: 'm', deltaContent: 'partial' }));
    await first;

    await expect(gen.return(undefined)).rejects.toThrow(
      'Copilot session shutdown could not be confirmed'
    );
    expect(session.aborted).toBe(true);
    expect(releases).toEqual([{ upstreamStopped: false }]);
  });

  test('preserves the lease when send settles before an in-flight abort fails', async () => {
    const session = makeFakeSession('sess-unconfirmed-after-send');
    nextCreateSessionResult = session;
    const leaseController = new AbortController();
    const releases: { upstreamStopped: boolean }[] = [];
    let rejectAbort: ((error: Error) => void) | undefined;
    const abortCompletion = new Promise<void>((_resolve, reject) => {
      rejectAbort = reject;
    });
    (session as unknown as { abort: () => Promise<void> }).abort = async () => {
      session.aborted = true;
      return abortCompletion;
    };

    const p = new CopilotProvider();
    const completion = collect(
      p.sendQuery('hello', '/work/dir', undefined, {
        model: 'gpt-5',
        providerAttemptGate: {
          acquire: async () => ({
            signal: leaseController.signal,
            release: async options => {
              releases.push(options);
            },
          }),
        },
      })
    );

    while (session.prompt === undefined) await Bun.sleep(1);
    leaseController.abort(new Error('lease lost'));
    session.rejectSend(new Error('SDK wait stopped'));
    await Bun.sleep(1);
    expect(releases).toEqual([]);

    rejectAbort?.(new Error('abort transport failed'));
    await expect(completion).rejects.toThrow('Copilot session shutdown could not be confirmed');
    expect(releases).toEqual([{ upstreamStopped: false }]);
  });

  test('preserves the lease when a rejected wait cannot confirm session shutdown', async () => {
    const session = makeFakeSession('sess-unconfirmed-after-wait-rejection');
    session.abortError = new Error('abort transport failed');
    nextCreateSessionResult = session;
    const releases: { upstreamStopped: boolean }[] = [];

    const completion = collect(
      new CopilotProvider().sendQuery('hello', '/work/dir', undefined, {
        model: 'gpt-5',
        providerAttemptGate: {
          acquire: async () => ({
            signal: new AbortController().signal,
            release: async options => {
              releases.push(options);
            },
          }),
        },
      })
    );

    while (session.prompt === undefined) await Bun.sleep(1);
    session.rejectSend(new Error('SDK wait timed out'));

    await expect(completion).rejects.toThrow('Copilot session shutdown could not be confirmed');
    expect(session.aborted).toBe(true);
    expect(releases).toEqual([{ upstreamStopped: false }]);
  });

  test('reasoningEffort from nodeConfig.effort passes through', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      nodeConfig: { effort: 'high' },
    });

    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    const opts = createSessionSpy.mock.calls[0]![0] as { reasoningEffort?: string };
    expect(opts.reasoningEffort).toBe('high');
  });

  test('workflow `effort: max` maps to SDK `xhigh`', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      nodeConfig: { effort: 'max' },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    const opts = createSessionSpy.mock.calls[0]![0] as { reasoningEffort?: string };
    expect(opts.reasoningEffort).toBe('xhigh');
  });

  // #2556: `minimal` is a rung on Archon's shared ladder that Copilot's SDK
  // lacks, so it clamps to the SDK's shallowest — the same treatment `max`
  // already gets at the top end. Only a value that is not a rung at all is
  // dropped.
  test('effort: minimal clamps to the SDK shallowest rung', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      nodeConfig: { effort: 'minimal' },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    const opts = createSessionSpy.mock.calls[0]![0] as { reasoningEffort?: string };
    expect(opts.reasoningEffort).toBe('low');
  });

  test('invalid effort value is dropped (not passed to SDK)', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      nodeConfig: { effort: 'ultra' }, // not a rung on the ladder
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    const opts = createSessionSpy.mock.calls[0]![0] as { reasoningEffort?: string };
    expect(opts.reasoningEffort).toBeUndefined();
  });

  test('systemPrompt wraps to systemMessage with append mode', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      systemPrompt: 'Be concise.',
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    const opts = createSessionSpy.mock.calls[0]![0] as {
      systemMessage?: { content: string; mode: string };
    };
    expect(opts.systemMessage).toEqual({ content: 'Be concise.', mode: 'append' });
  });

  test('resume failure falls back to createSession with warning chunk', async () => {
    const session = makeFakeSession('sess-new');
    nextResumeSessionResult = new Error('session not found');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', 'sess-missing', { model: 'gpt-5' });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    const chunks = [(await first).value, ...(await collect(gen))];

    expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const systemChunk = chunks.find(
      c => c && typeof c === 'object' && 'type' in c && c.type === 'system'
    ) as { content: string } | undefined;
    expect(systemChunk?.content).toContain('Could not resume');
  });

  test('forkSession=true with resumeSessionId creates fresh session (SDK has no fork)', async () => {
    const session = makeFakeSession('sess-fresh');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', 'sess-prior', {
      model: 'gpt-5',
      forkSession: true,
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    const chunks = [(await first).value, ...(await collect(gen))];

    // resumeSession MUST NOT be called — we fork to fresh instead.
    expect(resumeSessionSpy).not.toHaveBeenCalled();
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const systemChunk = chunks.find(
      c => c && typeof c === 'object' && 'type' in c && c.type === 'system'
    ) as { content: string } | undefined;
    expect(systemChunk?.content).toContain('does not support session forking');
  });

  test('resumeSessionId without forkSession resumes in place (node-to-node continuation)', async () => {
    const session = makeFakeSession('sess-resumed');
    nextResumeSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', 'sess-prior', {
      model: 'gpt-5',
      forkSession: false,
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  test('sendAndWait receives explicit timeout > SDK default of 60s', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, { model: 'gpt-5' });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(session.sendTimeout).toBeDefined();
    expect(session.sendTimeout!).toBeGreaterThan(60_000);
  });

  test('terminal result chunk carries sessionId and tokens from usage event', async () => {
    const session = makeFakeSession('sess-42');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, { model: 'gpt-5' });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.fire(evt('assistant.usage', { model: 'gpt-5', inputTokens: 10, outputTokens: 3 }));
    session.resolveSend(undefined);
    const chunks = [(await first).value, ...(await collect(gen))];

    const result = chunks.find(
      c => c && typeof c === 'object' && 'type' in c && c.type === 'result'
    ) as { sessionId?: string; tokens?: { input: number; output: number } } | undefined;
    expect(result?.sessionId).toBe('sess-42');
    expect(result?.tokens).toEqual({ input: 10, output: 3 });
  });

  test('abort signal triggers session.abort', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const ac = new AbortController();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      abortSignal: ac.signal,
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    const completion = (async (): Promise<void> => {
      await first;
      await collect(gen);
    })();
    ac.abort();
    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });

    expect(session.aborted).toBe(true);
  });

  test('session.disconnect is called in finally (even on success)', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, { model: 'gpt-5' });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(session.disconnected).toBe(true);
  });

  test('forkSession + persistSession boolean flags logged at debug (not thrown)', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      persistSession: false,
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    // No throw, and no warn-level log for persistSession — debug is fine.
    const warnCalls = mockLogger.warn.mock.calls;
    const sawUnsupported = warnCalls.some(args => args[1] === 'copilot.option_not_supported');
    expect(sawUnsupported).toBe(false);
  });

  test('GH_TOKEN is ignored by default (logged-in user wins)', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      env: { GH_TOKEN: 'ghp_testtoken' },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(lastClientOpts?.gitHubToken).toBeUndefined();
    expect(lastClientOpts?.useLoggedInUser).toBe(true);
    // copilot-sdk 1.0 rename guard: sessions must run in the request cwd via
    // `workingDirectory` (was `cwd` pre-1.0 — a silent revert would strand
    // sessions in the server's cwd).
    expect(lastClientOpts?.workingDirectory).toBe('/w');
    // Dev mode resolves no custom CLI binary → no stdio connection override
    // (the SDK uses its bundled runtime).
    expect(lastClientOpts?.connection).toBeUndefined();
  });

  test('configDir override → client baseDirectory (COPILOT_HOME), sdk-1.0 placement', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      assistantConfig: { configDir: '/custom/copilot-home' },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(lastClientOpts?.baseDirectory).toBe('/custom/copilot-home');
  });

  test('COPILOT_GITHUB_TOKEN is always used (intent signal)', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      env: { COPILOT_GITHUB_TOKEN: 'ghp_copilot' },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(lastClientOpts?.gitHubToken).toBe('ghp_copilot');
    expect(lastClientOpts?.useLoggedInUser).toBe(false);
  });

  test('useLoggedInUser:false opts into generic GH_TOKEN', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      env: { GH_TOKEN: 'ghp_testtoken' },
      assistantConfig: { useLoggedInUser: false },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(lastClientOpts?.gitHubToken).toBe('ghp_testtoken');
    expect(lastClientOpts?.useLoggedInUser).toBe(false);
  });

  test('assistantConfig.useLoggedInUser=true overrides env token', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      env: { GH_TOKEN: 'ghp_testtoken' },
      assistantConfig: { useLoggedInUser: true },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(lastClientOpts?.gitHubToken).toBeUndefined();
    expect(lastClientOpts?.useLoggedInUser).toBe(true);
  });

  test('sendAndWait rejection propagates as thrown error', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;
    const releases: { upstreamStopped: boolean }[] = [];

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      providerAttemptGate: {
        acquire: async () => ({
          signal: new AbortController().signal,
          release: async options => {
            releases.push(options);
          },
        }),
      },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.rejectSend(new Error('kaboom'));

    await expect(
      (async () => {
        await first;
        for await (const _ of gen) {
          /* drain */
        }
      })()
    ).rejects.toThrow('kaboom');
    expect(session.aborted).toBe(true);
    expect(releases).toEqual([{ upstreamStopped: true }]);
  });
});
