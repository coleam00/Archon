import { describe, expect, mock, test } from 'bun:test';

import type { OpenCodeClient, OpenCodeEvent } from '@opencode-ai/client';

import { resolveSessionIdV2, streamOpencodeSessionV2 } from './session-v2';

const SESSION_ID = 'ses_test';

function durableEvent<T extends OpenCodeEvent['type']>(
  type: T,
  data: Extract<OpenCodeEvent, { type: T }>['data']
): OpenCodeEvent {
  return {
    id: `evt_${type}`,
    created: 1,
    type,
    durable: { aggregateID: SESSION_ID, seq: 1, version: 1 },
    data,
  } as OpenCodeEvent;
}

function liveEvent<T extends OpenCodeEvent['type']>(
  type: T,
  data: Extract<OpenCodeEvent, { type: T }>['data']
): OpenCodeEvent {
  return { id: `evt_${type}`, created: 1, type, data } as OpenCodeEvent;
}

function usageRecorded(input: number, output: number, cost: number): OpenCodeEvent {
  return {
    id: 'evt_session.usage.recorded',
    created: 1,
    type: 'session.usage.recorded',
    durable: { aggregateID: SESSION_ID, seq: 1, version: 1 },
    data: {
      sessionID: SESSION_ID,
      source: 'title',
      cost,
      tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  } as unknown as OpenCodeEvent;
}

function eventStream(events: OpenCodeEvent[]): AsyncIterable<OpenCodeEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function makeClient(events: OpenCodeEvent[] = []): {
  client: OpenCodeClient;
  create: ReturnType<typeof mock>;
  get: ReturnType<typeof mock>;
  prompt: ReturnType<typeof mock>;
  switchModel: ReturnType<typeof mock>;
  interrupt: ReturnType<typeof mock>;
  subscribe: ReturnType<typeof mock>;
} {
  const session = {
    create: mock(async () => ({
      id: SESSION_ID,
      projectID: 'project',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
      location: { directory: '/workspace' },
    })),
    get: mock(async () => ({
      id: SESSION_ID,
      projectID: 'project',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
      location: { directory: '/workspace' },
    })),
    prompt: mock(async () => ({ id: 'inbox_current', sessionID: SESSION_ID })),
    switchModel: mock(async () => undefined),
    interrupt: mock(async () => undefined),
  };
  const subscribe = mock(() => eventStream(events));
  return {
    client: { session, event: { subscribe } } as unknown as OpenCodeClient,
    ...session,
    subscribe,
  };
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

describe('OpenCode V2 sessions', () => {
  test('resumes only sessions from the current directory', async () => {
    const runtime = makeClient();

    expect(await resolveSessionIdV2(runtime.client, '/workspace', SESSION_ID)).toEqual({
      sessionId: SESSION_ID,
      resumed: true,
    });
    expect(runtime.create).not.toHaveBeenCalled();

    runtime.get.mockImplementationOnce(async () => ({
      id: 'foreign',
      location: { directory: '/other-project' },
    }));
    expect(await resolveSessionIdV2(runtime.client, '/workspace', 'foreign')).toEqual({
      sessionId: SESSION_ID,
      resumed: false,
    });
    expect(runtime.create).toHaveBeenCalledTimes(1);
  });

  test('creates a fresh session only for a missing resume', async () => {
    const runtime = makeClient();
    runtime.get.mockImplementationOnce(async (): Promise<never> => {
      throw { _tag: 'SessionNotFoundError', message: 'missing' };
    });

    expect(await resolveSessionIdV2(runtime.client, '/workspace', 'ses_missing')).toEqual({
      sessionId: SESSION_ID,
      resumed: false,
    });

    const cyclicError: Record<string, unknown> = { message: 'failed' };
    cyclicError.cause = cyclicError;
    runtime.get.mockImplementationOnce(async (): Promise<never> => {
      throw cyclicError;
    });
    await expect(resolveSessionIdV2(runtime.client, '/workspace', SESSION_ID)).rejects.toBe(
      cyclicError
    );
  });

  test('fences stale inbox events and sums multi-step plus auxiliary usage once', async () => {
    const runtime = makeClient([
      { id: 'connected', type: 'server.connected', data: {} },
      liveEvent('session.text.delta', {
        sessionID: SESSION_ID,
        assistantMessageID: 'stale_message',
        ordinal: 0,
        delta: 'stale-before',
      }),
      durableEvent('session.step.ended', {
        sessionID: SESSION_ID,
        assistantMessageID: 'stale_message',
        finish: 'stop',
        cost: 9,
        tokens: { input: 90, output: 90, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      durableEvent('session.inbox.delivered', {
        sessionID: SESSION_ID,
        inboxID: 'inbox_other',
      }),
      usageRecorded(80, 80, 8),
      liveEvent('session.text.delta', {
        sessionID: SESSION_ID,
        assistantMessageID: 'stale_message',
        ordinal: 0,
        delta: 'stale-after',
      }),
      durableEvent('session.inbox.delivered', {
        sessionID: SESSION_ID,
        inboxID: 'inbox_current',
      }),
      liveEvent('session.text.delta', {
        sessionID: SESSION_ID,
        assistantMessageID: 'current_message',
        ordinal: 0,
        delta: 'current',
      }),
      durableEvent('session.step.ended', {
        sessionID: SESSION_ID,
        assistantMessageID: 'current_message',
        finish: 'tool-calls',
        cost: 0.1,
        tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 1, write: 0 } },
      }),
      durableEvent('session.step.ended', {
        sessionID: SESSION_ID,
        assistantMessageID: 'current_message',
        finish: 'stop',
        cost: 0.2,
        tokens: { input: 4, output: 5, reasoning: 0, cache: { read: 0, write: 2 } },
      }),
      usageRecorded(1, 1, 0.05),
      liveEvent('session.usage.updated', {
        sessionID: SESSION_ID,
        cost: 99,
        tokens: { input: 99, output: 99, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      durableEvent('session.execution.succeeded', { sessionID: SESSION_ID }),
    ]);

    const result = await consume(
      streamOpencodeSessionV2(
        runtime.client,
        '/workspace',
        SESSION_ID,
        'task',
        { providerID: 'anthropic', modelID: 'requested-model' },
        undefined
      )
    );

    expect(result.error).toBeUndefined();
    expect(result.chunks).toEqual([
      { type: 'assistant', content: 'current' },
      {
        type: 'result',
        sessionId: SESSION_ID,
        tokens: {
          input: 10,
          output: 9,
          cacheRead: 1,
          cacheWrite: 2,
          total: 20,
          cost: 0.35000000000000003,
        },
        cost: 0.35000000000000003,
        stopReason: 'stop',
      },
    ]);
  });

  test('aborts the event stream and interrupts the active session', async () => {
    const controller = new AbortController();
    const runtime = makeClient();
    runtime.subscribe.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { id: 'connected', type: 'server.connected', data: {} } as OpenCodeEvent;
        yield durableEvent('session.inbox.delivered', {
          sessionID: SESSION_ID,
          inboxID: 'inbox_current',
        });
        if (!controller.signal.aborted) {
          await new Promise<void>(resolveAbort => {
            controller.signal.addEventListener('abort', () => resolveAbort(), { once: true });
          });
        }
        yield durableEvent('session.execution.interrupted', {
          sessionID: SESSION_ID,
          reason: 'user',
        });
      },
    }));
    runtime.prompt.mockImplementation(async () => {
      queueMicrotask(() => controller.abort('stop'));
      return { id: 'inbox_current', sessionID: SESSION_ID };
    });

    const result = await consume(
      streamOpencodeSessionV2(
        runtime.client,
        '/workspace',
        SESSION_ID,
        'task',
        { providerID: 'anthropic', modelID: 'model' },
        { abortSignal: controller.signal }
      )
    );

    expect(result.error?.message).toContain('OpenCode query aborted');
    expect(runtime.interrupt).toHaveBeenCalledTimes(1);
  });

  test('fails fast on current-turn headless interaction requests', async () => {
    const runtime = makeClient([
      { id: 'connected', type: 'server.connected', data: {} },
      durableEvent('session.inbox.delivered', {
        sessionID: SESSION_ID,
        inboxID: 'inbox_current',
      }),
      liveEvent('permission.asked', {
        id: 'permission_1',
        sessionID: SESSION_ID,
        action: 'external_directory',
        resources: ['/outside'],
      }),
    ]);

    const result = await consume(
      streamOpencodeSessionV2(
        runtime.client,
        '/workspace',
        SESSION_ID,
        'task',
        { providerID: 'anthropic', modelID: 'model' },
        undefined
      )
    );

    expect(result.error?.message).toContain('during a headless Archon run');
    expect(runtime.interrupt).toHaveBeenCalledTimes(1);
  });
});
