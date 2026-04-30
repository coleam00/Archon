/**
 * Hardening tests for CopilotProvider — defensive behaviors that protect
 * against caller-side mistakes and SDK-side cleanup failures.
 *
 * Covers:
 *  - early rejection on already-aborted abortSignal (no sendAndWait call)
 *  - model whitespace trimming (request and assistantConfig fallback)
 *  - session.error suppression when SDK delivers fallback assistant content
 *  - disconnect/stop cleanup errors don't mask the primary result/error
 *
 * Runs in its own bun test invocation — mocks @github/copilot-sdk and
 * @archon/paths process-wide.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SessionEvent } from '@github/copilot-sdk';

import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

interface FakeSession {
  sessionId: string;
  prompt?: string;
  aborted: boolean;
  disconnected: boolean;
  listener: ((event: SessionEvent) => void) | undefined;
  fire: (event: SessionEvent) => void;
  resolveSend: (result?: unknown) => void;
  rejectSend: (err: Error) => void;
  setDisconnectImpl: (fn: () => Promise<void>) => void;
}

function makeFakeSession(sessionId = 'sess-hardening'): FakeSession {
  let resolveSend: (v?: unknown) => void = () => undefined;
  let rejectSend: (e: Error) => void = () => undefined;
  const sendPromise = new Promise<unknown>((resolve, reject) => {
    resolveSend = resolve;
    rejectSend = reject;
  });
  let disconnectImpl: () => Promise<void> = async () => undefined;
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
    setDisconnectImpl(fn) {
      disconnectImpl = fn;
    },
  };
  const session = fake as FakeSession & {
    on: (h: (e: SessionEvent) => void) => () => void;
    sendAndWait: (opts: { prompt: string }, timeout?: number) => Promise<unknown>;
    disconnect: () => Promise<void>;
    abort: () => Promise<void>;
  };
  session.on = (handler): (() => void) => {
    fake.listener = handler;
    return (): void => {
      fake.listener = undefined;
    };
  };
  session.sendAndWait = async (opts): Promise<unknown> => {
    fake.prompt = opts.prompt;
    sendAndWaitCallCount++;
    return sendPromise;
  };
  session.disconnect = async (): Promise<void> => {
    fake.disconnected = true;
    await disconnectImpl();
  };
  session.abort = async (): Promise<void> => {
    fake.aborted = true;
  };
  return session as unknown as FakeSession;
}

let sendAndWaitCallCount = 0;
let nextCreateSessionResult: FakeSession | Error;
let stopImpl: () => Promise<Error[]> = async () => [];

const createSessionSpy = mock((_opts: unknown): Promise<FakeSession> => {
  if (nextCreateSessionResult instanceof Error) {
    return Promise.reject(nextCreateSessionResult);
  }
  return Promise.resolve(nextCreateSessionResult);
});
const stopSpy = mock(async (): Promise<Error[]> => stopImpl());

class FakeCopilotClient {
  createSession = createSessionSpy;
  resumeSession = mock(async () => {
    throw new Error('resumeSession not used in hardening tests');
  });
  stop = stopSpy;
  constructor(_opts: Record<string, unknown>) {}
}

const approveAllStub = mock(() => ({ kind: 'approved' }));

mock.module('@github/copilot-sdk', () => ({
  CopilotClient: FakeCopilotClient,
  approveAll: approveAllStub,
}));

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

async function collect(
  generator: AsyncGenerator<unknown>
): Promise<{ chunks: unknown[]; error?: Error }> {
  const chunks: unknown[] = [];
  try {
    for await (const chunk of generator) chunks.push(chunk);
    return { chunks };
  } catch (error) {
    return { chunks, error: error as Error };
  }
}

describe('CopilotProvider hardening', () => {
  beforeEach(() => {
    resetCopilotSingleton();
    sendAndWaitCallCount = 0;
    stopImpl = async (): Promise<Error[]> => [];
    createSessionSpy.mockClear();
    stopSpy.mockClear();
    approveAllStub.mockClear();
  });

  test('rejects early when abortSignal is already aborted', async () => {
    const session = makeFakeSession('sess-already-aborted');
    nextCreateSessionResult = session;

    const controller = new AbortController();
    controller.abort();

    const { error } = await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        model: 'gpt-5',
        abortSignal: controller.signal,
      })
    );

    expect(error).toBeDefined();
    expect(error?.name).toBe('AbortError');
    // sendAndWait must NOT have been entered
    expect(sendAndWaitCallCount).toBe(0);
  });

  test('trims whitespace from the model before assigning to SessionConfig', async () => {
    const session = makeFakeSession('sess-trim-model');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/repo', undefined, { model: '  gpt-5-mini  ' });
    const firstNext = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.fire(evt('assistant.message_delta', { messageId: 'm', deltaContent: 'ok' }));
    session.resolveSend(undefined);
    await firstNext;
    await collect(gen);

    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const opts = createSessionSpy.mock.calls[0]![0] as { model: string };
    expect(opts.model).toBe('gpt-5-mini');
  });

  test('falls back to assistantConfig.model and trims that too', async () => {
    const session = makeFakeSession('sess-fallback-model');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/repo', undefined, {
      assistantConfig: { model: '  gpt-5  ' },
    });
    const firstNext = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.fire(evt('assistant.message_delta', { messageId: 'm', deltaContent: 'ok' }));
    session.resolveSend(undefined);
    await firstNext;
    await collect(gen);

    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const opts = createSessionSpy.mock.calls[0]![0] as { model: string };
    expect(opts.model).toBe('gpt-5');
  });

  test('does NOT emit a spurious session-error warning when fallback assistant content was delivered', async () => {
    const session = makeFakeSession('sess-fallback-after-error');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/repo', undefined, { model: 'gpt-5' });
    const firstNext = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));

    // Simulate: session.error fires, then sendAndWait still resolves with a
    // fallback final assistant message (the SDK auto-recovered).
    session.fire(evt('session.error', { errorType: 'transient', message: 'some transient error' }));
    session.resolveSend({ data: { content: 'FALLBACK', messageId: 'final' } });

    const firstResult = await firstNext;
    const { chunks: rest, error } = await collect(gen);
    const chunks: unknown[] = [];
    if (firstResult.value !== undefined) chunks.push(firstResult.value);
    chunks.push(...rest);

    expect(error).toBeUndefined();
    // The fallback content reached the consumer as an assistant chunk —
    // either via the safety-net path or the streaming path.
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'assistant', content: 'FALLBACK' })
    );
    // The session-error must NOT produce a system warning when fallback
    // content was delivered.
    expect(chunks).not.toContainEqual(
      expect.objectContaining({
        type: 'system',
        content: expect.stringContaining('some transient error'),
      })
    );
  });

  test('cleanup failure in disconnect does not mask the primary result', async () => {
    const session = makeFakeSession('sess-disconnect-fails');
    session.setDisconnectImpl(async (): Promise<void> => {
      throw new Error('disconnect blew up');
    });
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/repo', undefined, { model: 'gpt-5' });
    const firstNext = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.fire(evt('assistant.message_delta', { messageId: 'm', deltaContent: 'hello' }));
    session.resolveSend(undefined);
    await firstNext;
    const { chunks, error } = await collect(gen);

    expect(error).toBeUndefined();
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'result' }));
  });

  test('cleanup failure in client.stop does not mask the friendly primary error', async () => {
    const session = makeFakeSession('sess-stop-fails');
    nextCreateSessionResult = session;
    stopImpl = async (): Promise<Error[]> => {
      throw new Error('client.stop blew up');
    };

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/repo', undefined, { model: 'gpt-5' });
    const firstNext = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.rejectSend(new Error('Model not available'));

    let primaryError: Error | undefined;
    try {
      await firstNext;
    } catch (e) {
      primaryError = e as Error;
    }
    if (!primaryError) {
      // The error may surface from subsequent generator iteration.
      const { error } = await collect(gen);
      primaryError = error;
    }

    // The friendly model-access error must survive the stop() throw.
    expect(primaryError?.message).toMatch(/Copilot model access error/i);
    expect(primaryError?.message ?? '').not.toContain('client.stop blew up');
  });
});
