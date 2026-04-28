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

const mockResolveCopilotCliPath = mock(async () => '/usr/local/bin/copilot');
mock.module('./binary-resolver', () => ({
  resolveCopilotCliPath: mockResolveCopilotCliPath,
}));

type SessionHandler = (event: Record<string, unknown>) => void;

let registeredHandlers: Record<string, SessionHandler[]> = {};
let scriptedFinalMessage: { data: { content: string; messageId: string } } | undefined;
let sendAndWaitImpl:
  | (() => Promise<{ data: { content: string; messageId: string } } | undefined>)
  | undefined;

const mockAbort = mock(async () => undefined);
const mockDisconnect = mock(async () => undefined);
const mockSendAndWait = mock(async () => {
  if (sendAndWaitImpl) return await sendAndWaitImpl();
  return scriptedFinalMessage;
});

const mockSession = {
  sessionId: 'copilot-session-123',
  on: mock((eventType: string, handler: SessionHandler) => {
    registeredHandlers[eventType] ??= [];
    registeredHandlers[eventType].push(handler);
    return () => {
      registeredHandlers[eventType] = (registeredHandlers[eventType] ?? []).filter(
        h => h !== handler
      );
    };
  }),
  sendAndWait: mockSendAndWait,
  abort: mockAbort,
  disconnect: mockDisconnect,
};

const createdClients: Array<Record<string, unknown>> = [];
const mockCreateSession = mock(async () => mockSession);
const mockResumeSession = mock(async () => mockSession);
const mockStop = mock(async () => []);

mock.module('@github/copilot-sdk', () => ({
  approveAll: () => ({ kind: 'approved' }),
  CopilotClient: class MockCopilotClient {
    constructor(options: Record<string, unknown>) {
      createdClients.push(options);
    }
    createSession = mockCreateSession;
    resumeSession = mockResumeSession;
    stop = mockStop;
  },
}));

import { CopilotProvider } from './provider';
import { COPILOT_CAPABILITIES } from './capabilities';

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

describe('CopilotProvider', () => {
  beforeEach(() => {
    registeredHandlers = {};
    scriptedFinalMessage = { data: { content: 'COPILOT_OK', messageId: 'msg-final' } };
    sendAndWaitImpl = undefined;
    createdClients.length = 0;
    mockResolveCopilotCliPath.mockClear();
    mockCreateSession.mockClear();
    mockResumeSession.mockClear();
    mockStop.mockClear();
    mockSendAndWait.mockClear();
    mockAbort.mockClear();
    mockDisconnect.mockClear();
  });

  test('reports provider type and capabilities', () => {
    const provider = new CopilotProvider();
    expect(provider.getType()).toBe('copilot');
    expect(provider.getCapabilities()).toEqual(COPILOT_CAPABILITIES);
  });

  test('streams assistant, thinking, tool, and result chunks', async () => {
    sendAndWaitImpl = async () => {
      emit('assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: 'thinking...' });
      emit('assistant.message_delta', { messageId: 'm1', deltaContent: 'hello ' });
      emit('tool.execution_start', {
        toolCallId: 'tool-1',
        toolName: 'read_file',
        arguments: { path: 'README.md' },
      });
      emit('tool.execution_complete', {
        toolCallId: 'tool-1',
        success: true,
        result: { content: 'ok', detailedContent: 'full output' },
      });
      emit('assistant.usage', { model: 'gpt-5', inputTokens: 11, outputTokens: 7, cost: 1 });
      return scriptedFinalMessage;
    };

    const { chunks, error } = await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        model: 'gpt-5',
        env: { GH_TOKEN: 'token-123', PROJECT_ONLY: 'yes' },
      })
    );

    expect(error).toBeUndefined();
    expect(chunks).toContainEqual({ type: 'thinking', content: 'thinking...' });
    expect(chunks).toContainEqual({ type: 'assistant', content: 'hello ' });
    expect(chunks).toContainEqual({
      type: 'tool',
      toolName: 'read_file',
      toolInput: { path: 'README.md' },
      toolCallId: 'tool-1',
    });
    expect(chunks).toContainEqual({
      type: 'tool_result',
      toolName: 'read_file',
      toolOutput: 'full output',
      toolCallId: 'tool-1',
    });
    expect(chunks).toContainEqual({
      type: 'result',
      sessionId: 'copilot-session-123',
      tokens: { input: 11, output: 7, total: 18, cost: 1 },
      cost: 1,
    });

    expect(createdClients[0]).toMatchObject({
      cliPath: '/usr/local/bin/copilot',
      cwd: '/repo',
      githubToken: 'token-123',
    });
    expect((createdClients[0].env as Record<string, string>).PROJECT_ONLY).toBe('yes');
  });

  test('falls back to final assistant message when no deltas were streamed', async () => {
    const { chunks, error } = await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, { model: 'gpt-5' })
    );

    expect(error).toBeUndefined();
    expect(chunks).toContainEqual({ type: 'assistant', content: 'COPILOT_OK' });
  });

  test('uses resumeSession when resumeSessionId is provided', async () => {
    const { error } = await collect(
      new CopilotProvider().sendQuery('resume me', '/repo', 'resume-123', { model: 'gpt-5' })
    );

    expect(error).toBeUndefined();
    expect(mockResumeSession).toHaveBeenCalledTimes(1);
    expect(mockCreateSession).toHaveBeenCalledTimes(0);
  });

  test('surfaces reasoning warning for unsupported thinking config shapes', async () => {
    const { chunks, error } = await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        model: 'gpt-5',
        nodeConfig: { thinking: { type: 'enabled', budget_tokens: 1024 } },
      })
    );

    expect(error).toBeUndefined();
    expect(chunks).toContainEqual({
      type: 'system',
      content:
        '⚠️ Copilot ignored `thinking` (object form is Claude-specific). Use `effort: low|medium|high|max` instead.',
    });
  });

  test('returns a friendly auth error', async () => {
    sendAndWaitImpl = async () => {
      emit('session.error', { errorType: 'authentication', message: 'not authenticated' });
      throw new Error('not authenticated');
    };

    const { error } = await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, { model: 'gpt-5' })
    );

    expect(error?.message).toContain('Copilot authentication failed');
    expect(error?.message).toContain('copilot login');
  });
});
