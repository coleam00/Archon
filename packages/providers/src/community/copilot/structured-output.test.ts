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
let sendAndWaitImpl:
  | (() => Promise<{ data: { content: string; messageId: string } } | undefined>)
  | undefined;
let capturedSendPrompt: string | undefined;

const mockSendAndWait = mock(async (input: { prompt: string }) => {
  capturedSendPrompt = input.prompt;
  if (sendAndWaitImpl) return await sendAndWaitImpl();
  return scriptedFinalMessage;
});

const mockSession = {
  sessionId: 'copilot-session-struct',
  on: mock((eventType: string, handler: SessionHandler) => {
    registeredHandlers[eventType] ??= [];
    registeredHandlers[eventType].push(handler);
    return () => undefined;
  }),
  sendAndWait: mockSendAndWait,
  abort: mock(async () => undefined),
  disconnect: mock(async () => undefined),
};

mock.module('@github/copilot-sdk', () => ({
  approveAll: () => ({ kind: 'approved' }),
  CopilotClient: class MockCopilotClient {
    createSession = mock(async () => mockSession);
    resumeSession = mock(async () => mockSession);
    stop = mock(async () => []);
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

async function collect(generator: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

function firstResult(chunks: unknown[]): Record<string, unknown> | undefined {
  return chunks.find(
    (c): c is Record<string, unknown> =>
      typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
  );
}

describe('Copilot structured output', () => {
  beforeEach(() => {
    registeredHandlers = {};
    scriptedFinalMessage = { data: { content: '', messageId: 'final' } };
    sendAndWaitImpl = undefined;
    capturedSendPrompt = undefined;
    mockSendAndWait.mockClear();
  });

  test('passes prompt through unchanged when outputFormat is absent', async () => {
    await collect(new CopilotProvider().sendQuery('plain prompt', '/repo'));
    expect(capturedSendPrompt).toBe('plain prompt');
  });

  test('augments prompt with schema when outputFormat is set', async () => {
    await collect(
      new CopilotProvider().sendQuery('give me users', '/repo', undefined, {
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { count: { type: 'number' } } },
        },
      })
    );
    expect(capturedSendPrompt).toContain('give me users');
    expect(capturedSendPrompt).toContain('Respond with ONLY a JSON object');
    expect(capturedSendPrompt).toContain('"count"');
  });

  test('attaches structuredOutput on valid JSON transcript', async () => {
    sendAndWaitImpl = async () => {
      emit('assistant.message_delta', {
        messageId: 'm1',
        deltaContent: '{"count": 3, "ok": true}',
      });
      return scriptedFinalMessage;
    };

    const chunks = await collect(
      new CopilotProvider().sendQuery('q', '/repo', undefined, {
        outputFormat: { type: 'json_schema', schema: {} },
      })
    );

    const result = firstResult(chunks);
    expect(result?.structuredOutput).toEqual({ count: 3, ok: true });
  });

  test('strips ```json fences before parsing', async () => {
    sendAndWaitImpl = async () => {
      emit('assistant.message_delta', {
        messageId: 'm1',
        deltaContent: '```json\n{"x": 1}\n```',
      });
      return scriptedFinalMessage;
    };

    const chunks = await collect(
      new CopilotProvider().sendQuery('q', '/repo', undefined, {
        outputFormat: { type: 'json_schema', schema: {} },
      })
    );

    expect(firstResult(chunks)?.structuredOutput).toEqual({ x: 1 });
  });

  test('omits structuredOutput when transcript is unparseable', async () => {
    sendAndWaitImpl = async () => {
      emit('assistant.message_delta', {
        messageId: 'm1',
        deltaContent: 'this is not JSON',
      });
      return scriptedFinalMessage;
    };

    const chunks = await collect(
      new CopilotProvider().sendQuery('q', '/repo', undefined, {
        outputFormat: { type: 'json_schema', schema: {} },
      })
    );

    const result = firstResult(chunks);
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('structuredOutput');
  });

  test('omits structuredOutput when outputFormat is absent', async () => {
    sendAndWaitImpl = async () => {
      emit('assistant.message_delta', {
        messageId: 'm1',
        deltaContent: '{"valid": "json"}',
      });
      return scriptedFinalMessage;
    };

    const chunks = await collect(new CopilotProvider().sendQuery('q', '/repo'));
    const result = firstResult(chunks);
    expect(result).not.toHaveProperty('structuredOutput');
  });

  test('parses from final assistant message fallback', async () => {
    scriptedFinalMessage = { data: { content: '{"v": 42}', messageId: 'final' } };

    const chunks = await collect(
      new CopilotProvider().sendQuery('q', '/repo', undefined, {
        outputFormat: { type: 'json_schema', schema: {} },
      })
    );

    expect(firstResult(chunks)?.structuredOutput).toEqual({ v: 42 });
  });
});
