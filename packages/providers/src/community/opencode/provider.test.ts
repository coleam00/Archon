import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    instance: {
      dispose: ReturnType<typeof mock>;
    };
  };
  server: {
    url: string;
    close: ReturnType<typeof mock>;
  };
};

const runtimeQueue: MockRuntime[] = [];
const createdRuntimes: MockRuntime[] = [];
const startupErrors: unknown[] = [];
let scriptedEvents: OpencodeEvent[] = [];
const tempDirs = new Set<string>();

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
  instanceDispose?: ReturnType<typeof mock>;
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
  const instanceDispose = overrides?.instanceDispose ?? mock(async () => true);
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
      instance: {
        dispose: instanceDispose,
      },
    },
    server: {
      url: 'http://mock-opencode.local',
      close,
    },
  };
}

const mockCreateOpencode = mock(async () => {
  const startupError = startupErrors.shift();
  if (startupError) throw startupError;
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

async function createTempProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archon-opencode-provider-'));
  tempDirs.add(dir);
  return dir;
}

describe('OpencodeProvider', () => {
  beforeEach(() => {
    scriptedEvents = [];
    runtimeQueue.length = 0;
    createdRuntimes.length = 0;
    startupErrors.length = 0;
    mockCreateOpencode.mockClear();
    mockCreateOpencodeClient.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    resetEmbeddedRuntime();
  });

  afterEach(async () => {
    await Promise.all(Array.from(tempDirs, dir => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
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
    expect(mockCreateOpencode).toHaveBeenCalledTimes(2);
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
    expect(mockCreateOpencode).toHaveBeenCalledTimes(1);
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

    expect(mockCreateOpencode).toHaveBeenCalledTimes(2);
    expect(runtimeA.server.close).toHaveBeenCalledTimes(1);
    expect(runtimeB.server.close).toHaveBeenCalledTimes(1);
  });

  test('always starts a fresh embedded runtime per query attempt', async () => {
    const runtimeA = makeRuntime({ close: mock(() => undefined) });
    const runtimeB = makeRuntime({ close: mock(() => undefined) });
    runtimeQueue.push(runtimeA, runtimeB);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    await consume(
      new OpencodeProvider().sendQuery('one', '/tmp', undefined, { assistantConfig: TEST_MODEL })
    );
    await consume(
      new OpencodeProvider().sendQuery('two', '/tmp', undefined, { assistantConfig: TEST_MODEL })
    );

    expect(mockCreateOpencode).toHaveBeenCalledTimes(2);
    expect(mockCreateOpencodeClient).not.toHaveBeenCalled();
  });

  test('embedded runtime passes random port and isolated startup config', async () => {
    const runtime = makeRuntime({ close: mock(() => undefined) });
    runtimeQueue.push(runtime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const { error } = await consume(
      new OpencodeProvider().sendQuery('one', '/tmp', undefined, { assistantConfig: TEST_MODEL })
    );

    expect(error).toBeUndefined();
    expect(mockCreateOpencode).toHaveBeenCalledTimes(1);
    expect(mockCreateOpencode).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: '127.0.0.1',
        port: expect.any(Number),
        timeout: 5000,
        config: expect.objectContaining({
          server: expect.objectContaining({
            hostname: '127.0.0.1',
            port: expect.any(Number),
            password: expect.any(String),
          }),
        }),
      })
    );

    const startupPort = (mockCreateOpencode.mock.calls[0] as Array<{ port?: number }>)[0]?.port;
    expect(typeof startupPort).toBe('number');
    expect(startupPort).toBeGreaterThan(0);
  });

  test('embedded runtime retries startup on port conflict and succeeds', async () => {
    startupErrors.push(new Error('Failed to start server on port 4096'));
    const runtime = makeRuntime({ close: mock(() => undefined) });
    runtimeQueue.push(runtime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('retry startup', '/tmp', undefined, {
        assistantConfig: TEST_MODEL,
      })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ type: 'result', sessionId: 'session-1' }]);
    expect(mockCreateOpencode).toHaveBeenCalledTimes(2);
    const firstPort = (mockCreateOpencode.mock.calls[0] as Array<{ port?: number }>)[0]?.port;
    const secondPort = (mockCreateOpencode.mock.calls[1] as Array<{ port?: number }>)[0]?.port;
    expect(typeof firstPort).toBe('number');
    expect(typeof secondPort).toBe('number');
    expect(firstPort).toBeGreaterThan(0);
    expect(secondPort).toBeGreaterThan(0);
    expect(firstPort).not.toBe(secondPort);
    const firstConfig = (
      mockCreateOpencode.mock.calls[0] as Array<{ config?: { server?: { port?: number } } }>
    )[0]?.config;
    const secondConfig = (
      mockCreateOpencode.mock.calls[1] as Array<{ config?: { server?: { port?: number } } }>
    )[0]?.config;
    expect(firstConfig?.server?.port).toBe(firstPort);
    expect(secondConfig?.server?.port).toBe(secondPort);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
        startupPort: expect.any(Number),
        attempt: 1,
        maxAttempts: 3,
      },
      'opencode.runtime_start_retry_after_port_conflict'
    );
  });

  test('embedded runtime does not retry non-port startup errors', async () => {
    startupErrors.push(new Error('OpenCode binary missing'));

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('no retry startup', '/tmp', undefined, {
        assistantConfig: TEST_MODEL,
      })
    );

    expect(chunks).toEqual([]);
    expect(error?.message).toContain('OpenCode binary missing');
    expect(mockCreateOpencode).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.any(Object),
      'opencode.runtime_start_retry_after_port_conflict'
    );
  });

  test('agent config injects archon-prefixed kebab-case name into promptAsync body', async () => {
    const cwd = await createTempProjectDir();
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
        'My Agent': { description: 'Test agent', prompt: 'You are helpful' },
      },
    };

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', cwd, undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ type: 'result', sessionId: 'session-1' }]);
    expect(runtime.client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: cwd },
      body: expect.objectContaining({
        agent: 'archon-my-agent',
      }),
    });
  });

  test('materializes workflow agents under project .opencode/agents with mapped content', async () => {
    const cwd = await createTempProjectDir();
    const runtime = makeRuntime();
    runtimeQueue.push(runtime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const nodeConfig = {
      agents: {
        Reviewer: {
          description: 'Code review specialist',
          prompt: 'Review the patch carefully',
          model: 'anthropic/claude-3-5-sonnet',
          tools: ['read', 'grep'],
          disallowedTools: ['bash'],
          skills: ['review-work'],
          maxTurns: 7,
        },
      },
    };

    const { error } = await consume(
      new OpencodeProvider().sendQuery('hi', cwd, undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
    const agentPath = join(cwd, '.opencode', 'agents', 'archon-reviewer.md');
    const content = await readFile(agentPath, 'utf8');
    expect(content).toContain('mode: subagent');
    expect(content).toContain('description: "Code review specialist"');
    expect(content).toContain('model: "anthropic/claude-3-5-sonnet"');
    expect(content).toContain('steps: 7');
    expect(content).toContain('skills:');
    expect(content).toContain('- "review-work"');
    expect(content).toContain('tools:');
    expect(content).toContain('read: true');
    expect(content).toContain('grep: true');
    expect(content).toContain('bash: false');
    expect(content.trimEnd()).toEndWith('Review the patch carefully');
  });

  test('materialization preserves user-authored files and only replaces archon-owned files for current request scope', async () => {
    const cwd = await createTempProjectDir();
    const agentsDir = join(cwd, '.opencode', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'custom-agent.md'), '# user agent\n', 'utf8');
    await writeFile(join(agentsDir, 'archon-stale-agent.md'), 'old stale content\n', 'utf8');
    await writeFile(join(agentsDir, 'archon-keep-agent.md'), 'old keep content\n', 'utf8');

    const runtime = makeRuntime();
    runtimeQueue.push(runtime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const nodeConfig = {
      agents: {
        'Keep Agent': { description: 'Fresh agent', prompt: 'Fresh prompt' },
      },
    };

    const { error } = await consume(
      new OpencodeProvider().sendQuery('hi', cwd, undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
    expect(await readFile(join(agentsDir, 'custom-agent.md'), 'utf8')).toBe('# user agent\n');
    expect(await readFile(join(agentsDir, 'archon-keep-agent.md'), 'utf8')).toContain(
      'Fresh prompt'
    );
    await expect(readFile(join(agentsDir, 'archon-stale-agent.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('generates agent files before prompt execution path', async () => {
    const cwd = await createTempProjectDir();
    const runtime = makeRuntime({
      promptAsync: mock(async () => {
        const content = await readFile(
          join(cwd, '.opencode', 'agents', 'archon-order-check.md'),
          'utf8'
        );
        expect(content).toContain('Prompt exists before execution');
      }),
    });
    runtimeQueue.push(runtime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const nodeConfig = {
      agents: {
        'Order Check': {
          description: 'Ordering test',
          prompt: 'Prompt exists before execution',
        },
      },
    };

    const { error } = await consume(
      new OpencodeProvider().sendQuery('hi', cwd, undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
  });

  test('disposes cached OpenCode instance after agent materialization and before prompt execution', async () => {
    const cwd = await createTempProjectDir();
    const callOrder: string[] = [];
    const runtime = makeRuntime({
      instanceDispose: mock(async () => {
        callOrder.push('dispose');
        return true;
      }),
      promptAsync: mock(async () => {
        callOrder.push('prompt');
      }),
    });
    runtimeQueue.push(runtime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const nodeConfig = {
      nodeId: 'node-1',
      agents: {
        reviewer: {
          description: 'Review agent',
          prompt: 'Return review',
        },
      },
    };

    const { error } = await consume(
      new OpencodeProvider().sendQuery('hi', cwd, undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
    expect(runtime.client.instance.dispose).toHaveBeenCalledWith({
      query: { directory: join(cwd, '.archon-opencode', 'node-1') },
    });
    expect(callOrder).toEqual(['dispose', 'prompt']);
  });

  test('retries once when first attempt fails with agent-not-found for inline agents', async () => {
    const cwd = await createTempProjectDir();
    const failingRuntime = makeRuntime({
      promptAsync: mock(async () => {
        throw new Error("Agent not found: 'archon-reviewer'");
      }),
    });
    const successRuntime = makeRuntime();
    runtimeQueue.push(failingRuntime, successRuntime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const nodeConfig = {
      nodeId: 'node-2',
      agents: {
        reviewer: {
          description: 'Review agent',
          prompt: 'Return review',
        },
      },
    };

    const { chunks, error } = await consume(
      new OpencodeProvider({ retryBaseDelayMs: 1 }).sendQuery('hi', cwd, undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ type: 'result', sessionId: 'session-1' }]);
    expect(mockCreateOpencode).toHaveBeenCalledTimes(2);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { attempt: 0, sessionCwd: join(cwd, '.archon-opencode', 'node-2') },
      'opencode.retrying_after_agent_refresh'
    );
  });

  test('agent config with model override injects model into promptAsync body', async () => {
    const cwd = await createTempProjectDir();
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
      new OpencodeProvider().sendQuery('hi', cwd, undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ type: 'result', sessionId: 'session-1' }]);
    expect(runtime.client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: cwd },
      body: expect.objectContaining({
        model: { providerID: 'anthropic', modelID: 'claude-3-5-sonnet' },
        agent: 'archon-special-agent',
      }),
    });
  });

  test('agent config with tools and disallowedTools produces permissions map', async () => {
    const cwd = await createTempProjectDir();
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
      new OpencodeProvider().sendQuery('hi', cwd, undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ type: 'result', sessionId: 'session-1' }]);
    expect(runtime.client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: cwd },
      body: expect.objectContaining({
        tools: {
          read: true,
          grep: true,
          bash: false,
          write: false,
        },
        agent: 'archon-tools-agent',
      }),
    });
  });

  test('external baseUrl mode is rejected to enforce managed runtime control', async () => {
    const cwd = await createTempProjectDir();
    const nodeConfig = {
      agents: {
        reviewer: {
          description: 'Review agent',
          prompt: 'Review safely',
        },
      },
    };

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', cwd, undefined, {
        assistantConfig: { ...TEST_MODEL, baseUrl: 'http://remote-opencode.local' },
        nodeConfig,
      })
    );

    expect(chunks).toEqual([]);
    expect(error?.message).toContain('external baseUrl mode is no longer supported');
    expect(mockCreateOpencodeClient).not.toHaveBeenCalled();
    expect(mockCreateOpencode).not.toHaveBeenCalled();
  });

  test('external baseUrl mode is rejected even when pre-generated agent files exist', async () => {
    const cwd = await createTempProjectDir();
    const agentsDir = join(cwd, '.opencode', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'archon-reviewer.md'),
      ['---', 'name: archon-reviewer', 'description: "Review agent"', '---', '', 'Review'].join(
        '\n'
      ),
      'utf8'
    );
    await writeFile(join(agentsDir, 'custom-agent.md'), '# user content\n', 'utf8');

    const runtime = makeRuntime();
    runtimeQueue.push(runtime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const nodeConfig = {
      agents: {
        reviewer: {
          description: 'Review agent',
          prompt: 'Review',
        },
      },
    };

    const { error } = await consume(
      new OpencodeProvider().sendQuery('hi', cwd, undefined, {
        assistantConfig: { ...TEST_MODEL, baseUrl: 'http://remote-opencode.local' },
        nodeConfig,
      })
    );

    expect(error?.message).toContain('external baseUrl mode is no longer supported');
    expect(await readFile(join(agentsDir, 'custom-agent.md'), 'utf8')).toBe('# user content\n');
    expect(mockCreateOpencodeClient).not.toHaveBeenCalled();
    expect(mockCreateOpencode).not.toHaveBeenCalled();
  });

  test('external baseUrl mode rejection happens before runtime/dispose side effects', async () => {
    const cwd = await createTempProjectDir();
    const agentsDir = join(cwd, '.opencode', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'archon-reviewer.md'),
      ['---', 'name: archon-reviewer', 'description: "Review agent"', '---', '', 'Review'].join(
        '\n'
      ),
      'utf8'
    );

    const callOrder: string[] = [];
    const runtime = makeRuntime({
      instanceDispose: mock(async () => {
        callOrder.push('dispose');
        return true;
      }),
      promptAsync: mock(async () => {
        callOrder.push('prompt');
      }),
    });
    runtimeQueue.push(runtime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const nodeConfig = {
      nodeId: 'node-remote',
      agents: {
        reviewer: {
          description: 'Review agent',
          prompt: 'Review',
        },
      },
    };

    const { error } = await consume(
      new OpencodeProvider().sendQuery('hi', cwd, undefined, {
        assistantConfig: { ...TEST_MODEL, baseUrl: 'http://remote-opencode.local' },
        nodeConfig,
      })
    );

    expect(error?.message).toContain('external baseUrl mode is no longer supported');
    expect(runtime.client.instance.dispose).not.toHaveBeenCalled();
    expect(callOrder).toEqual([]);
    expect(mockCreateOpencode).not.toHaveBeenCalled();
    expect(mockCreateOpencodeClient).not.toHaveBeenCalled();
  });

  test('external baseUrl mode rejects multi-agent execution with same deprecation error', async () => {
    const cwd = await createTempProjectDir();
    const agentsDir = join(cwd, '.opencode', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'archon-agent-a.md'), '---\nmode: subagent\n---\nA\n', 'utf8');
    await writeFile(join(agentsDir, 'archon-agent-b.md'), '---\nmode: subagent\n---\nB\n', 'utf8');

    const nodeConfig = {
      nodeId: 'node-multi-remote',
      agents: {
        'agent-a': { description: 'A', prompt: 'A' },
        'agent-b': { description: 'B', prompt: 'B' },
      },
    };

    const { chunks, error } = await consume(
      new OpencodeProvider().sendQuery('hi', cwd, undefined, {
        assistantConfig: { ...TEST_MODEL, baseUrl: 'http://remote-opencode.local' },
        nodeConfig,
      })
    );

    expect(chunks).toEqual([]);
    expect(error?.message).toContain('external baseUrl mode is no longer supported');
    expect(mockCreateOpencodeClient).not.toHaveBeenCalled();
    expect(mockCreateOpencode).not.toHaveBeenCalled();
  });

  test('uses node prompt as task when agent is configured', async () => {
    const cwd = await createTempProjectDir();
    const runtime = makeRuntime();
    runtimeQueue.push(runtime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const nodeConfig = {
      agents: {
        'test-agent': {
          description: 'Test agent',
          prompt: 'You are a helpful test agent.',
        },
      },
    };

    const { error } = await consume(
      new OpencodeProvider().sendQuery('node prompt that should be used', cwd, undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
    // The agent's prompt lives in the materialized .md file (system context).
    // The node prompt is the task sent in the prompt body.
    expect(runtime.client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: cwd },
      body: expect.objectContaining({
        parts: [{ type: 'text', text: 'node prompt that should be used' }],
        agent: 'archon-test-agent',
      }),
    });
  });

  test('uses node prompt when no agents are defined', async () => {
    const cwd = await createTempProjectDir();
    const runtime = makeRuntime();
    runtimeQueue.push(runtime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const { error } = await consume(
      new OpencodeProvider().sendQuery('node prompt should be used', cwd, undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig: {}, // No agents
      })
    );

    expect(error).toBeUndefined();
    // Verify the node's prompt was sent to OpenCode
    expect(runtime.client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: cwd },
      body: expect.objectContaining({
        parts: [{ type: 'text', text: 'node prompt should be used' }],
      }),
    });
  });

  test('uses node prompt when agent has no prompt field', async () => {
    const cwd = await createTempProjectDir();
    const runtime = makeRuntime();
    runtimeQueue.push(runtime);
    scriptedEvents = [{ type: 'session.idle', properties: { sessionID: 'session-1' } }];

    const nodeConfig = {
      agents: {
        'empty-agent': {
          description: 'Agent with no prompt',
          // No prompt field
        },
      },
    };

    const { error } = await consume(
      new OpencodeProvider().sendQuery('fallback node prompt', cwd, undefined, {
        assistantConfig: TEST_MODEL,
        nodeConfig,
      })
    );

    expect(error).toBeUndefined();
    // Verify the node's prompt was used as fallback
    expect(runtime.client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: cwd },
      body: expect.objectContaining({
        parts: [{ type: 'text', text: 'fallback node prompt' }],
        agent: 'archon-empty-agent',
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
