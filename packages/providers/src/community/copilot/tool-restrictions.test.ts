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
const mockSession = {
  sessionId: 'copilot-session-tools',
  on: mock((eventType: string, handler: SessionHandler) => {
    registeredHandlers[eventType] ??= [];
    registeredHandlers[eventType].push(handler);
    return () => undefined;
  }),
  sendAndWait: mock(async () => ({
    data: { content: 'ok', messageId: 'm' },
  })),
  abort: mock(async () => undefined),
  disconnect: mock(async () => undefined),
};

const capturedSessionConfigs: Array<Record<string, unknown>> = [];
const mockCreateSession = mock(async (config: Record<string, unknown>) => {
  capturedSessionConfigs.push(config);
  return mockSession;
});
const mockResumeSession = mock(async (_id: string, config: Record<string, unknown>) => {
  capturedSessionConfigs.push(config);
  return mockSession;
});

mock.module('@github/copilot-sdk', () => ({
  approveAll: () => ({ kind: 'approved' }),
  CopilotClient: class MockCopilotClient {
    createSession = mockCreateSession;
    resumeSession = mockResumeSession;
    stop = mock(async () => []);
  },
}));

import { CopilotProvider } from './provider';

async function drain(generator: AsyncGenerator<unknown>): Promise<void> {
  for await (const _chunk of generator) void _chunk;
}

describe('applyToolRestrictions', () => {
  beforeEach(() => {
    registeredHandlers = {};
    capturedSessionConfigs.length = 0;
    mockCreateSession.mockClear();
    mockResumeSession.mockClear();
  });

  test('omits availableTools/excludedTools when nodeConfig has neither', async () => {
    await drain(new CopilotProvider().sendQuery('hi', '/repo', undefined, { model: 'gpt-5' }));

    const cfg = capturedSessionConfigs[0] ?? {};
    expect(cfg.availableTools).toBeUndefined();
    expect(cfg.excludedTools).toBeUndefined();
  });

  test('passes allowed_tools through as availableTools', async () => {
    await drain(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        model: 'gpt-5',
        nodeConfig: { allowed_tools: ['read_file', 'write_file'] },
      })
    );

    const cfg = capturedSessionConfigs[0] ?? {};
    expect(cfg.availableTools).toEqual(['read_file', 'write_file']);
    expect(cfg.excludedTools).toBeUndefined();
  });

  test('passes denied_tools through as excludedTools', async () => {
    await drain(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        model: 'gpt-5',
        nodeConfig: { denied_tools: ['shell'] },
      })
    );

    const cfg = capturedSessionConfigs[0] ?? {};
    expect(cfg.excludedTools).toEqual(['shell']);
    expect(cfg.availableTools).toBeUndefined();
  });

  test('passes both through when both present (SDK enforces availableTools precedence)', async () => {
    await drain(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        model: 'gpt-5',
        nodeConfig: {
          allowed_tools: ['read_file'],
          denied_tools: ['shell'],
        },
      })
    );

    const cfg = capturedSessionConfigs[0] ?? {};
    expect(cfg.availableTools).toEqual(['read_file']);
    expect(cfg.excludedTools).toEqual(['shell']);
  });

  test('applies restrictions on resumeSession path too', async () => {
    await drain(
      new CopilotProvider().sendQuery('hi', '/repo', 'resume-abc', {
        model: 'gpt-5',
        nodeConfig: { allowed_tools: ['read_file'] },
      })
    );

    const cfg = capturedSessionConfigs[0] ?? {};
    expect(cfg.availableTools).toEqual(['read_file']);
    expect(mockResumeSession).toHaveBeenCalledTimes(1);
    expect(mockCreateSession).toHaveBeenCalledTimes(0);
  });
});
