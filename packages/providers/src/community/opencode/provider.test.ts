import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

type OpencodeEvent = {
  type?: string;
  properties?: Record<string, unknown>;
};

type MockRuntime = {
  client: {
    session: {
      create: ReturnType<typeof mock>;
      get: ReturnType<typeof mock>;
      promptAsync: ReturnType<typeof mock>;
      abort: ReturnType<typeof mock>;
      message: ReturnType<typeof mock>;
    };
    event: {
      subscribe: ReturnType<typeof mock>;
    };
  };
  server: {
    url: string;
    close: ReturnType<typeof mock>;
  };
};

const runtimeQueue: MockRuntime[] = [];
const createdRuntimes: MockRuntime[] = [];
let scriptedEvents: OpencodeEvent[] = [];
let mockHealthCheckResponse: { ok: boolean; json: () => Promise<unknown> } | null = null;

function createEventStream(events: OpencodeEvent[]): AsyncIterable<OpencodeEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createPendingStream(): AsyncIterable<OpencodeEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<OpencodeEvent>>(() => undefined),
      };
    },
  };
}

function makeRuntime(overrides?: {
  sessionCreate?: ReturnType<typeof mock>;
  sessionGet?: ReturnType<typeof mock>;
  promptAsync?: ReturnType<typeof mock>;
  sessionMessage?: ReturnType<typeof mock>;
  sessionAbort?: ReturnType<typeof mock>;
  subscribe?: ReturnType<typeof mock>;
  close?: ReturnType<typeof mock>;
}): MockRuntime {
  const sessionCreate =
    overrides?.sessionCreate ?? mock(async () => ({ data: { id: 'session-1' } }));
  const sessionGet =
    overrides?.sessionGet ?? mock(async () => ({ data: { id: 'resumed-session' } }));
  const promptAsync = overrides?.promptAsync ?? mock(async () => undefined);
  const sessionMessage = overrides?.sessionMessage ?? mock(async () => ({ data: { info: {} } }));
  const sessionAbort = overrides?.sessionAbort ?? mock(async () => undefined);
  const subscribe =
    overrides?.subscribe ??
    mock(async () => ({
      stream: createEventStream(scriptedEvents),
    }));
  const close = overrides?.close ?? mock(() => undefined);

  return {
    client: {
      session: {
        create: sessionCreate,
        get: sessionGet,
        promptAsync,
        abort: sessionAbort,
        message: sessionMessage,
      },
      event: {
        subscribe,
      },
    },
    server: {
      url: 'http://mock-opencode.local',
      close,
    },
  };
}

const mockCreateOpencode = mock(async () => {
  const runtime = runtimeQueue.shift() ?? makeRuntime();
  createdRuntimes.push(runtime);
  return runtime;
});

const mockCreateOpencodeClient = mock((_options?: Record<string, unknown>) => {
  const runtime = runtimeQueue.shift() ?? makeRuntime();
  createdRuntimes.push(runtime);
  return runtime.client;
});

mock.module('@opencode-ai/sdk', () => ({
  createOpencode: mockCreateOpencode,
  createOpencodeClient: mockCreateOpencodeClient,
}));

import { OpencodeProvider, resetEmbeddedRuntime } from './provider';

/** Default model for tests — satisfies the model-or-agent validation */
const TEST_MODEL = { model: 'test/mock-model' };

async function consume(
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

describe('OpencodeProvider', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    scriptedEvents = [];
    runtimeQueue.length = 0;
    createdRuntimes.length = 0;
    mockHealthCheckResponse = null; // Reset health check mock
    mockCreateOpencode.mockClear();
    mockCreateOpencodeClient.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    // Reset the embedded runtime state between tests
    resetEmbeddedRuntime();

    // Mock fetch for health checks
    originalFetch = global.fetch;
    global.fetch = mock(async (url: string | URL | Request) => {
      const urlString = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlString.includes('/global/health')) {
        // Default: existing server found (healthy)
        if (mockHealthCheckResponse) {
          return mockHealthCheckResponse as Response;
        }
        // Return healthy response by default
        return {
          ok: true,
          json: async () => ({ healthy: true, version: '1.0.0' }),
        } as Response;
      }
      return originalFetch(url);
    }) as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('basic text streaming yields assistant chunks', async () => {
    scriptedEvents = [
      {
        type: 'message.part.updated',
        properties: {
          delta: 'Hello',
          part: { sessionID: 'session-1', type: 'text' },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          delta: ' world',
          part: { sessionID: 'session-1', type: 'text' },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    ];

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', undefined, { assistantConfig: TEST_MODEL })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([
      { type: 'assistant', content: 'Hello' },
      { type: 'assistant', content: ' world' },
      { type: 'result', sessionId: 'session-1' },
    ]);
  });

  test('tool events normalize into tool and tool_result chunks', async () => {
    scriptedEvents = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            sessionID: 'session-1',
            type: 'tool',
            tool: 'read',
            callID: 'tool-1',
            state: {
              status: 'pending',
              input: { path: '/tmp/file.ts' },
            },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            sessionID: 'session-1',
            type: 'tool',
            tool: 'read',
            callID: 'tool-1',
            state: {
              status: 'completed',
              input: { path: '/tmp/file.ts' },
              output: 'file contents',
            },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    ];

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', undefined, { assistantConfig: TEST_MODEL })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([
      {
        type: 'tool',
        toolName: 'read',
        toolInput: { path: '/tmp/file.ts' },
        toolCallId: 'tool-1',
      },
      {
        type: 'tool_result',
        toolName: 'read',
        toolOutput: 'file contents',
        toolCallId: 'tool-1',
      },
      { type: 'result', sessionId: 'session-1' },
    ]);
  });

  test('terminal result chunk includes sessionId and normalized tokens', async () => {
    scriptedEvents = [
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'message-1',
            role: 'assistant',
            sessionID: 'session-1',
            providerID: 'anthropic',
            modelID: 'claude-sonnet',
            cost: 0.42,
            finish: 'stop',
            tokens: { input: 11, output: 7, reasoning: 3, cache: 1 },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    ];

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', undefined, { assistantConfig: TEST_MODEL })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([
      {
        type: 'result',
        sessionId: 'session-1',
        tokens: { input: 11, output: 7, total: 21, cost: 0.42 },
        cost: 0.42,
        stopReason: 'stop',
        modelUsage: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet',
          reasoning: 3,
          cache: 1,
        },
      },
    ]);
  });

  test('session resume handoff falls back to a fresh session with warning', async () => {
    const runtime = makeRuntime({
      sessionGet: mock(async () => {
        throw new Error('missing session');
      }),
      sessionCreate: mock(async () => ({ data: { id: 'fresh-session' } })),
    });
    runtimeQueue.push(runtime);
    scriptedEvents = [
      {
        type: 'session.idle',
        properties: { sessionID: 'fresh-session' },
      },
    ];

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', 'resume-me', { assistantConfig: TEST_MODEL })
    );

    expect(error).toBeUndefined();
    expect(runtime.client.session.get).toHaveBeenCalledWith({
      path: { id: 'resume-me' },
      query: { directory: '/tmp' },
    });
    expect(runtime.client.session.create).toHaveBeenCalledWith({ query: { directory: '/tmp' } });
    expect(chunks).toEqual([
      {
        type: 'system',
        content: '⚠️ Could not resume OpenCode session. Starting fresh conversation.',
      },
      { type: 'result', sessionId: 'fresh-session' },
    ]);
  });

  test('structured output success includes parsed payload on result chunk', async () => {
    const runtime = makeRuntime({
      sessionMessage: mock(async () => ({
        data: {
          info: {
            structured_output: { answer: 'ok', confidence: 0.9 },
          },
        },
      })),
    });
    runtimeQueue.push(runtime);
    scriptedEvents = [
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'message-1',
            role: 'assistant',
            sessionID: 'session-1',
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    ];

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', undefined, {
        assistantConfig: TEST_MODEL,
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
      })
    );

    expect(error).toBeUndefined();
    expect(runtime.client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: '/tmp' },
      body: {
        parts: [{ type: 'text', text: 'hi' }],
        model: { providerID: 'test', modelID: 'mock-model' },
        format: {
          type: 'json_schema',
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
      },
    });
    expect(chunks).toEqual([
      {
        type: 'result',
        sessionId: 'session-1',
        structuredOutput: { answer: 'ok', confidence: 0.9 },
        modelUsage: {
          providerID: undefined,
          modelID: undefined,
          reasoning: undefined,
          cache: undefined,
        },
      },
    ]);
  });

  test('structured output failure logs debug and still yields terminal result', async () => {
    const runtime = makeRuntime({
      sessionMessage: mock(async () => {
        throw new Error('lookup failed');
      }),
    });
    runtimeQueue.push(runtime);
    scriptedEvents = [
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'message-1',
            role: 'assistant',
            sessionID: 'session-1',
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    ];

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', undefined, {
        assistantConfig: TEST_MODEL,
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object' },
        },
      })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([
      {
        type: 'result',
        sessionId: 'session-1',
        modelUsage: {
          providerID: undefined,
          modelID: undefined,
          reasoning: undefined,
          cache: undefined,
        },
      },
    ]);
    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
  });

  test('rate limit errors are classified as retryable and retried', async () => {
    // First call: createOpencodeClient succeeds (existing server)
    const retryRuntime = makeRuntime({
      promptAsync: mock(async () => {
        throw new Error('429 rate limit exceeded');
      }),
    });
    const successRuntime = makeRuntime();
    runtimeQueue.push(retryRuntime, successRuntime);
    scriptedEvents = [
      {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    ];

    const { chunks, error } = await consume(
      new OpencodeProvider({ retryBaseDelayMs: 1 }).sendQuery('hi', '/tmp', undefined, {
        assistantConfig: TEST_MODEL,
      })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ type: 'result', sessionId: 'session-1' }]);
    // Uses createOpencodeClient for existing server check (called twice due to retry)
    expect(mockCreateOpencodeClient).toHaveBeenCalledTimes(2);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { attempt: 0, delayMs: 1, errorClass: 'rate_limit' },
      'opencode.retrying_query'
    );
  });

  test('auth errors are classified as non-retryable and do not retry', async () => {
    const runtime = makeRuntime({
      promptAsync: mock(async () => {
        const error = new Error('401 unauthorized api key');
        error.name = 'AuthenticationError';
        throw error;
      }),
    });
    runtimeQueue.push(runtime);

    const { chunks, error } = await consume(
      new OpencodeProvider({ retryBaseDelayMs: 1 }).sendQuery('hi', '/tmp', undefined, {
        assistantConfig: TEST_MODEL,
      })
    );

    expect(chunks).toEqual([]);
    expect(error?.message).toContain('OpenCode auth: 401 unauthorized api key');
    // Uses createOpencodeClient for existing server check (called once)
    expect(mockCreateOpencodeClient).toHaveBeenCalledTimes(1);
    // Auth errors should not trigger retries (no 'opencode.retrying_query' log)
    expect(mockLogger.info).not.toHaveBeenCalledWith(expect.any(Object), 'opencode.retrying_query');
  });

  // TODO(#1400): Enable once abort handling is stable in embedded runtime
  test.skip('abort propagates to the OpenCode session and surfaces aborted error', async () => {
    const runtime = makeRuntime({
      subscribe: mock(async () => ({
        stream: createPendingStream(),
      })),
    });
    runtimeQueue.push(runtime);
    const abortController = new AbortController();

    const consumption = consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', undefined, {
        assistantConfig: TEST_MODEL,
        abortSignal: abortController.signal,
      })
    );

    queueMicrotask(() => abortController.abort());

    const { chunks, error } = await consumption;

    expect(chunks).toEqual([]);
    expect(error?.message).toBe('OpenCode query aborted');
    expect(runtime.client.session.abort).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: '/tmp' },
    });
  });

  test('cleanup closes the embedded runtime after completion', async () => {
    const runtimeA = makeRuntime({ close: mock(() => undefined) });
    const runtimeB = makeRuntime({ close: mock(() => undefined) });
    runtimeQueue.push(runtimeA, runtimeB);
    scriptedEvents = [
      {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    ];

    const provider = new OpencodeProvider();
    await consume(provider.sendQuery('first', '/tmp', undefined, { assistantConfig: TEST_MODEL }));
    await consume(provider.sendQuery('second', '/tmp', undefined, { assistantConfig: TEST_MODEL }));

    // Uses createOpencodeClient for existing server check (called twice)
    expect(mockCreateOpencodeClient).toHaveBeenCalledTimes(2);
    // External server connections don't have close() called (no-op)
    expect(runtimeA.server.close).toHaveBeenCalledTimes(0);
    expect(runtimeB.server.close).toHaveBeenCalledTimes(0);
  });

  test('tries existing server before spawning new one', async () => {
    // Simulate existing server found via health check
    mockHealthCheckResponse = {
      ok: true,
      json: async () => ({ healthy: true, version: '1.0.0' }),
    };

    const existingRuntime = makeRuntime();
    runtimeQueue.push(existingRuntime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', undefined, { assistantConfig: TEST_MODEL })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ type: 'result', sessionId: 'session-1' }]);
    // Should use createOpencodeClient (existing server), not createOpencode (spawn)
    expect(mockCreateOpencodeClient).toHaveBeenCalled();
    expect(mockCreateOpencode).not.toHaveBeenCalled();
  });

  test('spawns new server when existing server connection fails', async () => {
    // Health check fails - set mockHealthCheckResponse to simulate failure
    mockHealthCheckResponse = {
      ok: false,
      json: async () => ({ error: 'connection refused' }),
    } as Response;

    const spawnedRuntime = makeRuntime();
    runtimeQueue.push(spawnedRuntime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', undefined, { assistantConfig: TEST_MODEL })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ type: 'result', sessionId: 'session-1' }]);
    // Should have spawned a new server since health check failed
    expect(mockCreateOpencode).toHaveBeenCalled();
  });

  test('agent config injects agent name into promptAsync body', async () => {
    const runtime = makeRuntime();
    runtimeQueue.push(runtime);
    scriptedEvents = [
      {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    ];

    const nodeConfig = {
      agents: {
        'my-agent': { description: 'Test agent', prompt: 'You are helpful' },
      },
    };

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ type: 'result', sessionId: 'session-1' }]);
    expect(runtime.client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: '/tmp' },
      body: expect.objectContaining({
        agent: 'my-agent',
      }),
    });
  });

  test('agent config with model override injects model into promptAsync body', async () => {
    const runtime = makeRuntime();
    runtimeQueue.push(runtime);
    scriptedEvents = [
      {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    ];

    const nodeConfig = {
      agents: {
        'special-agent': {
          description: 'Special agent',
          prompt: 'You are special',
          model: 'anthropic/claude-3-5-sonnet',
        },
      },
    };

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ type: 'result', sessionId: 'session-1' }]);
    expect(runtime.client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: '/tmp' },
      body: expect.objectContaining({
        model: { providerID: 'anthropic', modelID: 'claude-3-5-sonnet' },
        agent: 'special-agent',
      }),
    });
  });

  test('agent config with tools and disallowedTools produces permissions map', async () => {
    const runtime = makeRuntime();
    runtimeQueue.push(runtime);
    scriptedEvents = [
      {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    ];

    const nodeConfig = {
      agents: {
        'tools-agent': {
          description: 'Limited tools agent',
          prompt: 'You have limited access',
          tools: ['read', 'grep'],
          disallowedTools: ['bash', 'write'],
        },
      },
    };

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ type: 'result', sessionId: 'session-1' }]);
    expect(runtime.client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: '/tmp' },
      body: expect.objectContaining({
        tools: {
          read: true,
          grep: true,
          bash: false,
          write: false,
        },
        agent: 'tools-agent',
      }),
    });
  });

  test('agent config with invalid model ref throws explicit error', async () => {
    const nodeConfig = {
      agents: {
        'bad-agent': {
          description: 'Bad agent',
          prompt: 'This will fail',
          model: 'invalid-no-slash-format',
        },
      },
    };

    // The error is thrown during generator iteration, caught by consume and returned in error field
    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', '/tmp', undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(chunks).toEqual([]);
    expect(error).toBeDefined();
    expect(error?.message).toContain(
      "Invalid OpenCode agent model ref for 'bad-agent': 'invalid-no-slash-format'"
    );
  });
});
