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
  aborted: boolean;
  disconnected: boolean;
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
    sendAndWait: (opts: { prompt: string }) => Promise<unknown>;
    disconnect: () => Promise<void>;
    abort: () => Promise<void>;
  };
  session.on = (handler): (() => void) => {
    fake.listener = handler;
    return () => {
      fake.listener = undefined;
    };
  };
  session.sendAndWait = async (opts): Promise<unknown> => {
    fake.prompt = opts.prompt;
    return sendPromise;
  };
  session.disconnect = async (): Promise<void> => {
    fake.disconnected = true;
  };
  session.abort = async (): Promise<void> => {
    fake.aborted = true;
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

class FakeCopilotClient {
  createSession = createSessionSpy;
  resumeSession = resumeSessionSpy;
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
    expect(c.mcp).toBe(false);
    expect(c.hooks).toBe(false);
  });
});

describe('CopilotProvider.sendQuery', () => {
  beforeEach(() => {
    resetCopilotSingleton();
    createSessionSpy.mockClear();
    resumeSessionSpy.mockClear();
    approveAllStub.mockClear();
  });

  test('throws clear error when model is missing', async () => {
    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/tmp', undefined, { assistantConfig: {} });
    await expect(gen.next()).rejects.toThrow(/requires a `model`/);
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

  test('invalid effort value is dropped (not passed to SDK)', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      nodeConfig: { effort: 'minimal' }, // Copilot doesn't support
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
    ac.abort();
    // Give the abort listener a tick to run session.abort().
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

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

  test('unsupported option logs warn but does not throw', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      nodeConfig: { mcp: 'some-config.json' },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    const warnCalls = mockLogger.warn.mock.calls;
    const sawUnsupported = warnCalls.some(
      args =>
        args[1] === 'copilot.option_not_supported' &&
        (args[0] as { option: string }).option === 'mcp'
    );
    expect(sawUnsupported).toBe(true);
  });

  test('sendAndWait rejection propagates as thrown error', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, { model: 'gpt-5' });
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
  });
});
