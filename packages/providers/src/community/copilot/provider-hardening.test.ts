import { beforeEach, describe, expect, mock, test } from 'bun:test';

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
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

mock.module('@archon/paths', () => ({
  createLogger: () => mockLogger,
}));

mock.module('./binary-resolver', () => ({
  resolveCopilotCliPath: async () => '/usr/local/bin/copilot',
}));

type SessionHandler = (event: Record<string, unknown>) => void;

let registeredHandlers: Record<string, SessionHandler[]> = {};
let scriptedFinalMessage: { data: { content: string; messageId: string } } | undefined;
let sendAndWaitImpl: (() => Promise<unknown>) | undefined;
let disconnectImpl: () => Promise<void> = async () => undefined;
let stopImpl: () => Promise<Error[]> = async () => [];

const mockSendAndWait = mock(async () => {
  if (sendAndWaitImpl) return await sendAndWaitImpl();
  return scriptedFinalMessage;
});
const mockDisconnect = mock(async () => disconnectImpl());
const mockStop = mock(async () => stopImpl());

const mockSession = {
  sessionId: 'copilot-session-hardening',
  on: mock((eventType: string, handler: SessionHandler) => {
    registeredHandlers[eventType] ??= [];
    registeredHandlers[eventType].push(handler);
    return () => undefined;
  }),
  sendAndWait: mockSendAndWait,
  abort: mock(async () => undefined),
  disconnect: mockDisconnect,
};

const capturedSessionConfigs: Array<Record<string, unknown>> = [];
const mockCreateSession = mock(async (config: Record<string, unknown>) => {
  capturedSessionConfigs.push(config);
  return mockSession;
});

mock.module('@github/copilot-sdk', () => ({
  approveAll: () => ({ kind: 'approved' }),
  CopilotClient: class MockCopilotClient {
    createSession = mockCreateSession;
    resumeSession = mock(async () => mockSession);
    stop = mockStop;
  },
}));

import { CopilotProvider } from './provider';

function emit(eventType: string, data: Record<string, unknown>): void {
  for (const handler of registeredHandlers[eventType] ?? []) {
    handler({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      parentId: null,
      type: eventType,
      data,
    });
  }
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
    registeredHandlers = {};
    scriptedFinalMessage = { data: { content: 'FALLBACK', messageId: 'final' } };
    sendAndWaitImpl = undefined;
    disconnectImpl = async (): Promise<void> => undefined;
    stopImpl = async (): Promise<Error[]> => [];
    capturedSessionConfigs.length = 0;
    mockSendAndWait.mockClear();
    mockDisconnect.mockClear();
    mockStop.mockClear();
    mockCreateSession.mockClear();
  });

  test('rejects early when abortSignal is already aborted', async () => {
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
    expect(mockSendAndWait).toHaveBeenCalledTimes(0);
  });

  test('trims whitespace from the model before assigning to SessionConfig', async () => {
    await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, { model: '  gpt-5-mini  ' })
    );

    expect(capturedSessionConfigs[0]?.model).toBe('gpt-5-mini');
  });

  test('falls back to assistantConfig.model and trims that too', async () => {
    await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        assistantConfig: { model: '  gpt-5  ' },
      })
    );

    expect(capturedSessionConfigs[0]?.model).toBe('gpt-5');
  });

  test('does NOT emit a spurious session-error warning when fallback assistant content was delivered', async () => {
    // Simulate: no streaming deltas, sendAndWait emits session.error and
    // still returns a final assistant message.
    sendAndWaitImpl = async () => {
      emit('session.error', { errorType: 'transient', message: 'some transient error' });
      return scriptedFinalMessage;
    };

    const { chunks, error } = await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, { model: 'gpt-5' })
    );

    expect(error).toBeUndefined();
    expect(chunks).toContainEqual({ type: 'assistant', content: 'FALLBACK' });
    // The session-error should NOT produce a system warning when fallback
    // content was delivered — this is the bug Devin flagged.
    expect(chunks).not.toContainEqual(
      expect.objectContaining({
        type: 'system',
        content: expect.stringContaining('some transient error'),
      })
    );
  });

  test('cleanup failure in disconnect does not mask the primary result', async () => {
    disconnectImpl = async (): Promise<void> => {
      throw new Error('disconnect blew up');
    };

    const { chunks, error } = await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, { model: 'gpt-5' })
    );

    expect(error).toBeUndefined();
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'result' }));
  });

  test('cleanup failure in client.stop does not mask the friendly primary error', async () => {
    sendAndWaitImpl = async () => {
      throw new Error('Model not available');
    };
    stopImpl = async (): Promise<Error[]> => {
      throw new Error('client.stop blew up');
    };

    const { error } = await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, { model: 'gpt-5' })
    );

    // The friendly model-access error must survive the stop() throw.
    expect(error?.message).toContain('Copilot model access error');
    expect(error?.message).not.toContain('client.stop blew up');
  });
});
