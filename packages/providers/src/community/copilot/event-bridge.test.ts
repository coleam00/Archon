import { describe, expect, test } from 'bun:test';
import type { SessionEvent } from '@github/copilot-sdk';

import { AsyncQueue, mapCopilotEvent } from './event-bridge';

// ─── AsyncQueue ────────────────────────────────────────────────────────────

describe('AsyncQueue', () => {
  test('buffers pushes before consumer starts', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);

    const received: number[] = [];
    const iter = q[Symbol.asyncIterator]();
    for (let i = 0; i < 3; i++) {
      const r = await iter.next();
      if (!r.done) received.push(r.value);
    }
    expect(received).toEqual([1, 2, 3]);
  });

  test('resolves pending waiter when push arrives later', async () => {
    const q = new AsyncQueue<string>();
    const iter = q[Symbol.asyncIterator]();
    const pending = iter.next();
    queueMicrotask(() => q.push('hello'));
    const r = await pending;
    expect(r.done).toBe(false);
    if (!r.done) expect(r.value).toBe('hello');
  });

  test('second iterator call throws (single-consumer invariant)', () => {
    const q = new AsyncQueue<number>();
    q[Symbol.asyncIterator]();
    expect(() => q[Symbol.asyncIterator]()).toThrow(/single-consumer/);
  });

  test('close() terminates pending waiter so consumer exits loop', async () => {
    const q = new AsyncQueue<number>();
    const iter = q[Symbol.asyncIterator]();
    const pending = iter.next();
    queueMicrotask(() => q.close());
    const result = await pending;
    expect(result.done).toBe(true);
  });

  test('close() drains buffered items before terminating', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    const received: number[] = [];
    for await (const n of q) received.push(n);
    expect(received).toEqual([1, 2]);
  });

  test('push after close is a no-op (does not leak past close)', async () => {
    const q = new AsyncQueue<number>();
    const iter = q[Symbol.asyncIterator]();
    q.close();
    q.push(42);
    const r = await iter.next();
    expect(r.done).toBe(true);
  });

  test('close() is idempotent', () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.close()).not.toThrow();
  });
});

// ─── mapCopilotEvent ──────────────────────────────────────────────────────

describe('mapCopilotEvent', () => {
  function makeTokens() {
    return { input: 0, output: 0 };
  }

  test('assistant.message_delta → assistant chunk', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>();
    const chunks = mapCopilotEvent(
      {
        type: 'assistant.message_delta',
        id: 'e1',
        timestamp: '',
        parentId: null,
        ephemeral: true,
        data: { messageId: 'm1', deltaContent: 'hello world' },
      } as unknown as SessionEvent,
      tokens,
      pending
    );
    expect(chunks).toEqual([{ type: 'assistant', content: 'hello world' }]);
  });

  test('assistant.usage → accumulates tokens, returns empty array', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>();
    const chunks = mapCopilotEvent(
      {
        type: 'assistant.usage',
        id: 'e2',
        timestamp: '',
        parentId: null,
        ephemeral: true,
        data: { model: 'gpt-4', inputTokens: 100, outputTokens: 50 },
      } as unknown as SessionEvent,
      tokens,
      pending
    );
    expect(chunks).toEqual([]);
    expect(tokens.input).toBe(100);
    expect(tokens.output).toBe(50);
  });

  test('assistant.usage accumulates across multiple events', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>();
    const event = {
      type: 'assistant.usage',
      id: 'e3',
      timestamp: '',
      parentId: null,
      ephemeral: true,
      data: { model: 'gpt-4', inputTokens: 10, outputTokens: 5 },
    } as unknown as SessionEvent;
    mapCopilotEvent(event, tokens, pending);
    mapCopilotEvent(event, tokens, pending);
    expect(tokens.input).toBe(20);
    expect(tokens.output).toBe(10);
  });

  test('tool.execution_start → tool chunk + adds to pendingTools', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>();
    const chunks = mapCopilotEvent(
      {
        type: 'tool.execution_start',
        id: 'e4',
        timestamp: '',
        parentId: null,
        data: { toolCallId: 'tc1', toolName: 'read', arguments: { path: '/foo' } },
      } as unknown as SessionEvent,
      tokens,
      pending
    );
    expect(chunks).toEqual([
      { type: 'tool', toolName: 'read', toolInput: { path: '/foo' }, toolCallId: 'tc1' },
    ]);
    expect(pending.get('tc1')).toBe('read');
  });

  test('tool.execution_start with no arguments → empty toolInput', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>();
    const chunks = mapCopilotEvent(
      {
        type: 'tool.execution_start',
        id: 'e5',
        timestamp: '',
        parentId: null,
        data: { toolCallId: 'tc2', toolName: 'bash' },
      } as unknown as SessionEvent,
      tokens,
      pending
    );
    expect(chunks[0]).toMatchObject({ type: 'tool', toolInput: {} });
  });

  test('tool.execution_complete success → tool_result chunk + removes from pendingTools', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>([['tc1', 'read']]);
    const chunks = mapCopilotEvent(
      {
        type: 'tool.execution_complete',
        id: 'e6',
        timestamp: '',
        parentId: null,
        ephemeral: true,
        data: { toolCallId: 'tc1', success: true, result: { content: 'file contents' } },
      } as unknown as SessionEvent,
      tokens,
      pending
    );
    expect(chunks).toEqual([
      { type: 'tool_result', toolName: 'read', toolOutput: 'file contents', toolCallId: 'tc1' },
    ]);
    expect(pending.has('tc1')).toBe(false);
  });

  test('tool.execution_complete failure → system warning + tool_result', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>([['tc2', 'bash']]);
    const chunks = mapCopilotEvent(
      {
        type: 'tool.execution_complete',
        id: 'e7',
        timestamp: '',
        parentId: null,
        ephemeral: true,
        data: { toolCallId: 'tc2', success: false },
      } as unknown as SessionEvent,
      tokens,
      pending
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe('system');
    if (chunks[0].type === 'system') {
      expect(chunks[0].content).toContain('bash');
    }
    expect(chunks[1].type).toBe('tool_result');
  });

  test('tool.execution_complete with unknown toolCallId falls back to "unknown"', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>();
    const chunks = mapCopilotEvent(
      {
        type: 'tool.execution_complete',
        id: 'e8',
        timestamp: '',
        parentId: null,
        ephemeral: true,
        data: { toolCallId: 'missing-id', success: true, result: { content: 'ok' } },
      } as unknown as SessionEvent,
      tokens,
      pending
    );
    if (chunks[0].type === 'tool_result') {
      expect(chunks[0].toolName).toBe('unknown');
    }
  });

  test('session.idle → empty array (sentinel handled in bridge)', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>();
    const chunks = mapCopilotEvent(
      {
        type: 'session.idle',
        id: 'e9',
        timestamp: '',
        parentId: null,
        ephemeral: true,
        data: {},
      } as unknown as SessionEvent,
      tokens,
      pending
    );
    expect(chunks).toEqual([]);
  });

  test('session.error → empty array (sentinel handled in bridge)', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>();
    const chunks = mapCopilotEvent(
      {
        type: 'session.error',
        id: 'e10',
        timestamp: '',
        parentId: null,
        data: { errorType: 'authentication', message: 'Unauthorized' },
      } as unknown as SessionEvent,
      tokens,
      pending
    );
    expect(chunks).toEqual([]);
  });

  test('unknown event type → empty array', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>();
    const chunks = mapCopilotEvent(
      {
        type: 'session.created',
        id: 'e11',
        timestamp: '',
        parentId: null,
      } as unknown as SessionEvent,
      tokens,
      pending
    );
    expect(chunks).toEqual([]);
  });

  test('assistant.reasoning_delta → thinking chunk', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>();
    const chunks = mapCopilotEvent(
      {
        type: 'assistant.reasoning_delta',
        id: 'e12',
        timestamp: '',
        parentId: null,
        data: { deltaContent: 'I am thinking...' },
      } as unknown as SessionEvent,
      tokens,
      pending
    );
    expect(chunks).toEqual([{ type: 'thinking', content: 'I am thinking...' }]);
  });

  test('assistant.reasoning → thinking chunk', () => {
    const tokens = makeTokens();
    const pending = new Map<string, string>();
    const chunks = mapCopilotEvent(
      {
        type: 'assistant.reasoning',
        id: 'e13',
        timestamp: '',
        parentId: null,
        data: { content: 'Full reasoning block content.' },
      } as unknown as SessionEvent,
      tokens,
      pending
    );
    expect(chunks).toEqual([{ type: 'thinking', content: 'Full reasoning block content.' }]);
  });
});

// ─── bridgeCopilotSession cleanup ─────────────────────────────────────────

describe('bridgeCopilotSession cleanup', () => {
  test('cleanup does not block when client.stop() never resolves', async () => {
    const neverSettles = new Promise<void>(() => {
      /* intentionally never resolves */
    });

    let listenerRef: ((e: SessionEvent) => void) | undefined;
    let disconnectCalled = false;

    const mockSession = {
      sessionId: 'test-session-id',
      on: (handler: (e: SessionEvent) => void) => {
        listenerRef = handler;
        return () => {
          listenerRef = undefined;
        };
      },
      send: (_opts: unknown) => Promise.resolve('msg-id'),
      abort: async () => {},
      disconnect: async () => {
        disconnectCalled = true;
      },
    };

    const mockClient = {
      stop: () => neverSettles,
    };

    const { bridgeCopilotSession } = await import('./event-bridge');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = bridgeCopilotSession(mockSession as any, mockClient as any, 'test prompt');

    queueMicrotask(() => {
      listenerRef?.({
        type: 'tool.execution_start',
        id: 'e1',
        timestamp: '',
        parentId: null,
        data: { toolCallId: 'tc1', toolName: 'echo' },
      } as unknown as SessionEvent);
    });

    const start = Date.now();
    let receivedChunk = false;
    let caught: Error | undefined;
    try {
      for await (const _chunk of gen) {
        receivedChunk = true;
        throw new Error('simulated consumer abort');
      }
    } catch (err) {
      caught = err as Error;
    }
    const elapsed = Date.now() - start;

    expect(receivedChunk).toBe(true);
    expect(caught?.message).toBe('simulated consumer abort');
    expect(disconnectCalled).toBe(true);
    // Cleanup must not block waiting for client.stop() to resolve.
    expect(elapsed).toBeLessThan(500);
  }, 5_000);

  test('unsubscribe() is called in finally', async () => {
    let unsubscribeCalled = false;
    let listenerRef: ((e: SessionEvent) => void) | undefined;

    const mockSession = {
      sessionId: 'test-session-id',
      on: (handler: (e: SessionEvent) => void) => {
        listenerRef = handler;
        return () => {
          unsubscribeCalled = true;
        };
      },
      send: (_opts: unknown) => Promise.resolve('msg-id'),
      abort: async () => {},
      disconnect: async () => {},
    };
    const mockClient = { stop: async () => [] };

    const { bridgeCopilotSession } = await import('./event-bridge');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = bridgeCopilotSession(mockSession as any, mockClient as any, 'test prompt');

    queueMicrotask(() => {
      listenerRef?.({
        type: 'tool.execution_start',
        id: 'e1',
        timestamp: '',
        parentId: null,
        data: { toolCallId: 'tc1', toolName: 'echo' },
      } as unknown as SessionEvent);
    });

    try {
      for await (const _chunk of gen) {
        throw new Error('consumer abort');
      }
    } catch {}

    expect(unsubscribeCalled).toBe(true);
  }, 5_000);

  test('abort signal fires session.abort() before yield', async () => {
    let abortCalled = false;
    const mockSession = {
      sessionId: 'test-session-id',
      on: (_handler: (e: SessionEvent) => void) => () => {},
      send: (_opts: unknown) => Promise.resolve('msg-id'),
      abort: async () => {
        abortCalled = true;
      },
      disconnect: async () => {},
    };
    const mockClient = { stop: async () => [] };

    const { bridgeCopilotSession } = await import('./event-bridge');

    const controller = new AbortController();
    controller.abort();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = bridgeCopilotSession(
      mockSession as any,
      mockClient as any,
      'test',
      controller.signal
    );

    // Drain the generator (no chunks since we aborted before any events)
    try {
      for await (const _chunk of gen) {
        // nothing expected
      }
    } catch {}

    expect(abortCalled).toBe(true);
  }, 5_000);
});
