import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { OpenCodeClient, OpenCodeEvent } from '@opencode-ai/client';

import { createMockLogger } from '../../test/mocks/logger';
import type { NativeTool, SendQueryOptions } from '../../types';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({ createLogger: mock(() => mockLogger) }));

interface MockV2Runtime {
  client: OpenCodeClient;
  release: ReturnType<typeof mock>;
}

const v2Runtimes: MockV2Runtime[] = [];
const v2Errors: unknown[] = [];
async function nextV2Runtime(
  _signal?: AbortSignal,
  _nativeTools?: readonly NativeTool[]
): Promise<MockV2Runtime> {
  const error = v2Errors.shift();
  if (error) throw error;
  const runtime = v2Runtimes.shift();
  if (!runtime) throw new Error('Missing mocked V2 runtime');
  return runtime;
}
const acquireV2Runtime = mock(nextV2Runtime);
const acquireEmbeddedRuntime = mock(async (): Promise<never> => {
  throw new Error('V1 runtime must not be acquired');
});

mock.module('./runtime-v2', () => ({ acquireV2Runtime }));
mock.module('./runtime', () => ({
  acquireEmbeddedRuntime,
  disposeInstanceForDirectory: mock(async () => undefined),
  releaseEmbeddedRuntime: mock(() => undefined),
  resetEmbeddedRuntime: mock(() => undefined),
}));

const { OpencodeProvider } = await import('./provider');

function durableEvent<T extends OpenCodeEvent['type']>(
  sessionId: string,
  type: T,
  data: Extract<OpenCodeEvent, { type: T }>['data']
): OpenCodeEvent {
  return {
    id: `evt_${type}`,
    created: 1,
    type,
    durable: { aggregateID: sessionId, seq: 1, version: 1 },
    data,
  } as OpenCodeEvent;
}

function usageRecorded(sessionId: string): OpenCodeEvent {
  return {
    id: 'evt_session.usage.recorded',
    created: 1,
    type: 'session.usage.recorded',
    durable: { aggregateID: sessionId, seq: 1, version: 1 },
    data: {
      sessionID: sessionId,
      source: 'title',
      cost: 0.1,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  } as unknown as OpenCodeEvent;
}

function makeRuntime(sessionId: string, events: OpenCodeEvent[]): MockV2Runtime {
  const session = {
    create: mock(async () => ({
      id: sessionId,
      location: { directory: '/workspace' },
    })),
    get: mock(async () => ({
      id: sessionId,
      location: { directory: '/workspace' },
    })),
    prompt: mock(async () => ({ id: `inbox_${sessionId}`, sessionID: sessionId })),
    switchModel: mock(async () => undefined),
    interrupt: mock(async () => undefined),
  };
  const client = {
    session,
    event: {
      subscribe: mock(() => ({
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      })),
    },
  } as unknown as OpenCodeClient;
  return { client, release: mock(async () => undefined) };
}

async function consume(generator: AsyncGenerator<unknown>): Promise<{
  chunks: unknown[];
  error?: Error;
}> {
  const chunks: unknown[] = [];
  try {
    for await (const chunk of generator) chunks.push(chunk);
    return { chunks };
  } catch (error) {
    return { chunks, error: error as Error };
  }
}

const TEST_OPTIONS: SendQueryOptions = {
  assistantConfig: { model: 'anthropic/test-model' },
};

beforeEach(() => {
  v2Runtimes.length = 0;
  v2Errors.length = 0;
  acquireV2Runtime.mockReset();
  acquireV2Runtime.mockImplementation(nextV2Runtime);
  acquireEmbeddedRuntime.mockClear();
  mockLogger.info.mockClear();
  mockLogger.error.mockClear();
});

describe('OpencodeProvider V2 boundary', () => {
  test('fails closed when V2 acquisition fails', async () => {
    const sentinel = new Error('V2 unavailable');
    v2Errors.push(sentinel);

    const result = await consume(
      new OpencodeProvider({ useV2: true, retryBaseDelayMs: 1 }).sendQuery(
        'task',
        '/workspace',
        undefined,
        TEST_OPTIONS
      )
    );

    expect(result.error?.message).toContain('V2 unavailable');
    expect(acquireV2Runtime).toHaveBeenCalledTimes(1);
    expect(acquireEmbeddedRuntime).not.toHaveBeenCalled();
  });

  test('rejects deferred V2 surfaces before starting a sidecar', async () => {
    const cases: SendQueryOptions[] = [
      { ...TEST_OPTIONS, outputFormat: { type: 'json_schema', schema: { type: 'object' } } },
      { ...TEST_OPTIONS, env: { TOKEN: 'secret' } },
      { ...TEST_OPTIONS, nodeConfig: { skills: ['review'] } },
      {
        ...TEST_OPTIONS,
        nodeConfig: {
          agents: { reviewer: { description: 'Review', prompt: 'Review carefully' } },
        },
      },
    ];

    for (const options of cases) {
      const result = await consume(
        new OpencodeProvider({ useV2: true }).sendQuery('task', '/workspace', undefined, options)
      );
      expect(result.error?.message).toContain('OpenCode V2');
    }
    expect(acquireV2Runtime).not.toHaveBeenCalled();
  });

  test('retains spend from a retryable failed attempt in the final result', async () => {
    const firstSession = 'ses_first';
    const secondSession = 'ses_second';
    const first = makeRuntime(firstSession, [
      { id: 'connected-1', type: 'server.connected', data: {} },
      durableEvent(firstSession, 'session.inbox.delivered', {
        sessionID: firstSession,
        inboxID: `inbox_${firstSession}`,
      }),
      durableEvent(firstSession, 'session.step.failed', {
        sessionID: firstSession,
        assistantMessageID: 'msg_first',
        error: { type: 'provider', message: 'rate limit exceeded', status: 429 },
        rawFinish: 'error',
        cost: 0.4,
        tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      durableEvent(firstSession, 'session.execution.failed', {
        sessionID: firstSession,
        error: { type: 'provider', message: 'rate limit exceeded', status: 429 },
      }),
    ]);
    const second = makeRuntime(secondSession, [
      { id: 'connected-2', type: 'server.connected', data: {} },
      durableEvent(secondSession, 'session.inbox.delivered', {
        sessionID: secondSession,
        inboxID: `inbox_${secondSession}`,
      }),
      durableEvent(secondSession, 'session.step.ended', {
        sessionID: secondSession,
        assistantMessageID: 'msg_second',
        finish: 'stop',
        cost: 0.2,
        tokens: { input: 4, output: 5, reasoning: 0, cache: { read: 1, write: 0 } },
      }),
      usageRecorded(secondSession),
      durableEvent(secondSession, 'session.execution.succeeded', { sessionID: secondSession }),
    ]);
    v2Runtimes.push(first, second);

    const result = await consume(
      new OpencodeProvider({ useV2: true, retryBaseDelayMs: 1 }).sendQuery(
        'task',
        '/workspace',
        undefined,
        TEST_OPTIONS
      )
    );

    expect(result.error).toBeUndefined();
    expect(result.chunks.at(-1)).toEqual({
      type: 'result',
      sessionId: secondSession,
      tokens: {
        input: 8,
        output: 9,
        cacheRead: 1,
        cacheWrite: 0,
        total: 17,
        cost: 0.7000000000000001,
      },
      cost: 0.7000000000000001,
      stopReason: 'stop',
    });
    expect(acquireV2Runtime).toHaveBeenCalledTimes(2);
    expect(acquireEmbeddedRuntime).not.toHaveBeenCalled();
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(second.release).toHaveBeenCalledTimes(1);
  });

  test('does not retry after a native tool can produce side effects', async () => {
    const sessionId = 'ses_native_tool_failure';
    const runtime = makeRuntime(sessionId, [
      { id: 'connected', type: 'server.connected', data: {} },
      durableEvent(sessionId, 'session.inbox.delivered', {
        sessionID: sessionId,
        inboxID: `inbox_${sessionId}`,
      }),
      durableEvent(sessionId, 'session.execution.failed', {
        sessionID: sessionId,
        error: { type: 'provider', message: 'rate limit exceeded', status: 429 },
      }),
    ]);
    v2Runtimes.push(runtime);
    const handler = mock(async () => 'started');
    acquireV2Runtime.mockImplementationOnce(async (signal, nativeTools) => {
      await nativeTools?.[0]?.handler({ action: 'start' });
      return nextV2Runtime(signal, nativeTools);
    });

    const result = await consume(
      new OpencodeProvider({ useV2: true, retryBaseDelayMs: 1 }).sendQuery(
        'start workflow',
        '/workspace',
        undefined,
        {
          ...TEST_OPTIONS,
          nativeTools: [
            {
              name: 'manage_run',
              description: 'Manage workflow runs',
              inputSchema: {
                type: 'object',
                properties: { action: { type: 'string' } },
                required: ['action'],
              },
              handler,
            },
          ],
        }
      )
    );

    expect(result.error?.message).toContain('rate_limit');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(acquireV2Runtime).toHaveBeenCalledTimes(1);
    expect(runtime.release).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).not.toHaveBeenCalledWith(expect.anything(), 'opencode.query_retrying');
  });
});
