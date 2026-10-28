import { describe, test, expect, mock, beforeEach, spyOn, jest } from 'bun:test';

// Mock logger before importing transport
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
  createLogger: mock(() => mockLogger),
}));

import { SSEStreamingApi } from 'hono/streaming';
import { checkedSSEWriter } from './sse-writer';
import { SSETransport, type SSEWriter } from './transport';

function createMockStream(overrides?: Partial<SSEWriter>): SSEWriter {
  return {
    writeSSE: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
    closed: false,
    ...overrides,
  };
}

async function settleReplay(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  mockLogger.warn.mockClear();
  mockLogger.info.mockClear();
  mockLogger.debug.mockClear();
});

describe('SSETransport', () => {
  test('dashboard connections coexist and disconnect independently', () => {
    const transport = new SSETransport();
    const first = createMockStream();
    const second = createMockStream();
    try {
      transport.registerStream('__dashboard__', first);
      transport.registerStream('__dashboard__', second);
      transport.emitWorkflowEvent('__dashboard__', 'first event');

      expect(first.close).not.toHaveBeenCalled();
      expect(first.writeSSE).toHaveBeenCalledWith({ data: 'first event' });
      expect(second.writeSSE).toHaveBeenCalledWith({ data: 'first event' });

      transport.removeStream('__dashboard__', first);
      transport.removeStream('__dashboard__', first);
      transport.emitWorkflowEvent('__dashboard__', 'second event');

      expect(first.writeSSE).toHaveBeenCalledTimes(1);
      expect(second.writeSSE).toHaveBeenCalledWith({ data: 'second event' });
      expect(transport.hasActiveStream('__dashboard__')).toBe(true);

      transport.removeStream('__dashboard__', second);
      expect(transport.hasActiveStream('__dashboard__')).toBe(false);
    } finally {
      transport.stop();
    }
  });

  test('a failed dashboard writer does not remove or delay another connection', async () => {
    const transport = new SSETransport();
    const failed = createMockStream({
      writeSSE: mock(() => Promise.reject(new Error('disconnected'))),
    });
    const healthy = createMockStream();
    try {
      transport.registerStream('__dashboard__', failed);
      transport.registerStream('__dashboard__', healthy);
      await transport.emit('__dashboard__', 'first event');
      await transport.emit('__dashboard__', 'second event');

      expect(failed.writeSSE).toHaveBeenCalledTimes(1);
      expect(failed.close).toHaveBeenCalledTimes(1);
      expect(healthy.writeSSE).toHaveBeenCalledTimes(2);
      expect(transport.hasActiveStream('__dashboard__')).toBe(true);
      transport.removeStream('__dashboard__', healthy);
      const reconnected = createMockStream();
      transport.registerStream('__dashboard__', reconnected);
      await settleReplay();
      expect(reconnected.writeSSE).not.toHaveBeenCalled();
    } finally {
      transport.stop();
    }
  });

  test('a pending dashboard write does not delay delivery to other connections', async () => {
    const transport = new SSETransport();
    const { promise, resolve } = Promise.withResolvers<void>();
    const slow = createMockStream({ writeSSE: mock(() => promise) });
    const healthy = createMockStream();
    try {
      transport.registerStream('__dashboard__', slow);
      transport.registerStream('__dashboard__', healthy);
      const emitted = transport.emit('__dashboard__', 'event');
      expect(healthy.writeSSE).toHaveBeenCalledWith({ data: 'event' });
      resolve();
      await emitted;
    } finally {
      resolve();
      transport.stop();
    }
  });

  test('closed dashboard writers are removed and shutdown closes remaining connections', async () => {
    const transport = new SSETransport();
    const closed = createMockStream();
    const first = createMockStream();
    const second = createMockStream();
    try {
      transport.registerStream('__dashboard__', closed);
      transport.registerStream('__dashboard__', first);
      transport.registerStream('__dashboard__', second);
      Object.defineProperty(closed, 'closed', { value: true });
      await transport.emit('__dashboard__', 'event');
      expect(closed.writeSSE).not.toHaveBeenCalled();
      expect(first.writeSSE).toHaveBeenCalledWith({ data: 'event' });
      expect(second.writeSSE).toHaveBeenCalledWith({ data: 'event' });
      Object.defineProperty(closed, 'closed', { value: false });
      transport.stop();
      expect(closed.close).not.toHaveBeenCalled();
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(second.close).toHaveBeenCalledTimes(1);
      expect(transport.hasActiveStream('__dashboard__')).toBe(false);
    } finally {
      transport.stop();
    }
  });

  test('a late conversation write failure cannot remove its replacement', async () => {
    const transport = new SSETransport();
    const { promise, reject } = Promise.withResolvers<void>();
    const old = createMockStream({ writeSSE: mock(() => promise) });
    const replacement = createMockStream();
    try {
      transport.registerStream('conv-1', old);
      const emitted = transport.emit('conv-1', 'old event');
      transport.registerStream('conv-1', replacement);
      reject(new Error('old connection failed'));
      await emitted;
      transport.removeStream('conv-1', old);
      await transport.emit('conv-1', 'new event');
      expect(transport.hasActiveStream('conv-1')).toBe(true);
      expect(replacement.writeSSE).toHaveBeenCalledWith({ data: 'old event' });
      expect(replacement.writeSSE).toHaveBeenCalledWith({ data: 'new event' });
      expect(replacement.writeSSE).toHaveBeenCalledTimes(2);
    } finally {
      transport.stop();
    }
  });

  test.each(['conv-1', '__dashboard__'])(
    'retains a live write cancelled through Hono: %s',
    async conversationId => {
      const transport = new SSETransport();
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const stream = new SSEStreamingApi(writable, readable);
      const reader = stream.responseReadable.getReader();
      try {
        transport.registerStream(conversationId, checkedSSEWriter(stream));
        await transport.emit(conversationId, 'prefetched');
        const emitted = transport.emit(conversationId, 'pending');
        await reader.cancel();
        await emitted;
        const reconnected = createMockStream();
        transport.registerStream(conversationId, reconnected);
        await settleReplay();
        expect(reconnected.writeSSE).toHaveBeenCalledTimes(1);
        expect(reconnected.writeSSE).toHaveBeenCalledWith({ data: 'pending' });
      } finally {
        await reader.cancel();
        transport.stop();
      }
    }
  );

  test.each(['aborted', 'closed'] as const)(
    'the Hono writer rejects writes to an already %s stream',
    async state => {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const stream = new SSEStreamingApi(writable, readable);
      const writer = checkedSSEWriter(stream);
      try {
        if (state === 'aborted') stream.abort();
        else await stream.close();
        expect(writer.closed).toBe(true);
        await expect(writer.writeSSE({ data: 'event' })).rejects.toThrow('disconnected');
      } finally {
        await stream.responseReadable.cancel();
        await writer.close();
      }
    }
  );

  test.each(['resolve', 'reject'] as const)(
    'stop prevents a pending live write from restoring old events: %s',
    async outcome => {
      const transport = new SSETransport();
      const pending = Promise.withResolvers<void>();
      try {
        transport.registerStream('conv-1', createMockStream({ writeSSE: () => pending.promise }));
        const emitted = transport.emit('conv-1', 'old');
        transport.stop();
        await transport.emit('conv-1', 'new');
        if (outcome === 'resolve') pending.resolve();
        else pending.reject(new Error('disconnected'));
        await emitted;
        const reconnected = createMockStream();
        transport.registerStream('conv-1', reconnected);
        await settleReplay();
        expect(reconnected.writeSSE).toHaveBeenCalledTimes(1);
        expect(reconnected.writeSSE).toHaveBeenCalledWith({ data: 'new' });
      } finally {
        pending.resolve();
        transport.stop();
      }
    }
  );

  describe('registerStream', () => {
    test('registers a stream for a conversation', () => {
      const transport = new SSETransport();
      const stream = createMockStream();

      transport.registerStream('conv-1', stream);

      expect(transport.hasActiveStream('conv-1')).toBe(true);
    });

    test('closes existing stream when registering a new one', () => {
      const transport = new SSETransport();
      const oldStream = createMockStream();
      const newStream = createMockStream();

      transport.registerStream('conv-1', oldStream);
      transport.registerStream('conv-1', newStream);

      expect(oldStream.close).toHaveBeenCalledTimes(1);
      expect(transport.hasActiveStream('conv-1')).toBe(true);
    });

    test('does not close existing stream if already closed', () => {
      const transport = new SSETransport();
      const oldStream = createMockStream({ closed: true });
      const newStream = createMockStream();

      transport.registerStream('conv-1', oldStream);
      transport.registerStream('conv-1', newStream);

      expect(oldStream.close).not.toHaveBeenCalled();
    });

    test('cancels pending cleanup timer on reconnection', () => {
      const cleanup = mock((_id: string) => undefined);
      const transport = new SSETransport(cleanup, 1);
      const stream1 = createMockStream();
      const stream2 = createMockStream();

      transport.registerStream('conv-1', stream1);
      transport.removeStream('conv-1');

      // Re-register before grace period expires — cleanup should be cancelled
      transport.registerStream('conv-1', stream2);

      // Wait longer than the grace period
      return new Promise<void>(resolve => {
        setTimeout(() => {
          expect(cleanup).not.toHaveBeenCalled();
          resolve();
        }, 50);
      });
    });
  });

  describe('removeStream', () => {
    test('removes a stream', () => {
      const transport = new SSETransport();
      const stream = createMockStream();

      transport.registerStream('conv-1', stream);
      transport.removeStream('conv-1');

      expect(transport.hasActiveStream('conv-1')).toBe(false);
    });

    test('only removes if expectedStream matches current stream', () => {
      const transport = new SSETransport();
      const stream1 = createMockStream();
      const stream2 = createMockStream();

      transport.registerStream('conv-1', stream1);
      transport.registerStream('conv-1', stream2);

      // Attempt to remove with stale stream reference — should be no-op
      transport.removeStream('conv-1', stream1);

      expect(transport.hasActiveStream('conv-1')).toBe(true);
    });

    test('removes when expectedStream matches', () => {
      const transport = new SSETransport();
      const stream = createMockStream();

      transport.registerStream('conv-1', stream);
      transport.removeStream('conv-1', stream);

      expect(transport.hasActiveStream('conv-1')).toBe(false);
    });

    test('calls onCleanup after grace period if stream not re-registered', () => {
      const cleanup = mock((_id: string) => undefined);
      const transport = new SSETransport(cleanup, 1);
      const stream = createMockStream();

      transport.registerStream('conv-1', stream);
      transport.removeStream('conv-1');

      return new Promise<void>(resolve => {
        setTimeout(() => {
          expect(cleanup).toHaveBeenCalledWith('conv-1');
          resolve();
        }, 50);
      });
    });
  });

  describe('emit', () => {
    test('writes to active stream', async () => {
      const transport = new SSETransport();
      const stream = createMockStream();

      transport.registerStream('conv-1', stream);
      await transport.emit('conv-1', '{"type":"text"}');

      expect(stream.writeSSE).toHaveBeenCalledWith({ data: '{"type":"text"}' });
    });

    test('buffers events until a stream connects and replays them only once', async () => {
      const transport = new SSETransport();

      try {
        const events = ['first', 'same', 'same', 'last'];
        for (const event of events) await transport.emit('conv-1', event);
        const stream = createMockStream();
        transport.registerStream('conv-1', stream);
        await settleReplay();
        expect(stream.writeSSE).toHaveBeenCalledTimes(events.length);
        for (const [index, data] of events.entries()) {
          expect(stream.writeSSE).toHaveBeenNthCalledWith(index + 1, { data });
        }

        transport.removeStream('conv-1', stream);
        const reconnected = createMockStream();
        transport.registerStream('conv-1', reconnected);
        await settleReplay();
        expect(reconnected.writeSSE).not.toHaveBeenCalled();
      } finally {
        transport.stop();
      }
    });

    test('retains failed and unattempted replay events for the next connection', async () => {
      const transport = new SSETransport();
      const second = Promise.withResolvers<void>();
      const attempted: string[] = [];
      const stream = createMockStream({
        writeSSE: mock(async ({ data }) => {
          attempted.push(data);
          if (data === 'second') await second.promise;
        }),
      });
      try {
        for (const event of ['first', 'second', 'third']) await transport.emit('conv-1', event);
        transport.registerStream('conv-1', stream);
        await settleReplay();
        expect(attempted).toEqual(['first', 'second']);
        second.reject(new Error('disconnected during replay'));
        await settleReplay();
        expect(attempted).toEqual(['first', 'second']);
        const reconnected = createMockStream();
        transport.registerStream('conv-1', reconnected);
        await settleReplay();
        expect(reconnected.writeSSE).toHaveBeenCalledTimes(2);
        expect(reconnected.writeSSE).toHaveBeenNthCalledWith(1, { data: 'second' });
        expect(reconnected.writeSSE).toHaveBeenNthCalledWith(2, { data: 'third' });
        const next = createMockStream();
        transport.registerStream('conv-1', next);
        await settleReplay();
        expect(next.writeSSE).not.toHaveBeenCalled();
      } finally {
        second.resolve();
        transport.stop();
      }
    });

    for (const conversationId of ['conv-1', '__dashboard__']) {
      test.each(['resolve', 'reject'] as const)(
        `retains concurrent live events in emission order for ${conversationId}: %s`,
        async outcome => {
          const transport = new SSETransport();
          const first = Promise.withResolvers<void>();
          const second = Promise.withResolvers<void>();
          const stream = createMockStream({
            writeSSE: mock(({ data }) => (data === 'first' ? first.promise : second.promise)),
          });
          try {
            transport.registerStream(conversationId, stream);
            const firstEmission = transport.emit(conversationId, 'first');
            const secondEmission = transport.emit(conversationId, 'second');
            second.reject(new Error('second failed first'));
            await secondEmission;
            await transport.emit(conversationId, 'third');
            const reconnected = createMockStream();
            transport.registerStream(conversationId, reconnected);
            await settleReplay();
            expect(reconnected.writeSSE).not.toHaveBeenCalled();

            if (outcome === 'resolve') first.resolve();
            else first.reject(new Error('first failed last'));
            await firstEmission;
            await settleReplay();
            const expected =
              outcome === 'resolve' ? ['second', 'third'] : ['first', 'second', 'third'];
            expect(reconnected.writeSSE).toHaveBeenCalledTimes(expected.length);
            for (const [index, data] of expected.entries()) {
              expect(reconnected.writeSSE).toHaveBeenNthCalledWith(index + 1, { data });
            }
            transport.removeStream(conversationId, reconnected);
            const later = createMockStream();
            transport.registerStream(conversationId, later);
            await settleReplay();
            expect(later.writeSSE).not.toHaveBeenCalled();
          } finally {
            first.resolve();
            second.resolve();
            transport.stop();
          }
        }
      );
    }

    for (const retention of ['expiry', 'cap'] as const) {
      test.each(['resolve', 'reject'] as const)(
        `live completion after ${retention} cannot restore or consume retained events: %s`,
        async outcome => {
          const transport = new SSETransport();
          const clock = spyOn(Date, 'now').mockReturnValue(100_000);
          const pending = Promise.withResolvers<void>();
          const stream = createMockStream({ writeSSE: () => pending.promise });
          try {
            transport.registerStream('conv-1', stream);
            const emitted = transport.emit('conv-1', 'same');
            transport.removeStream('conv-1', stream);
            const count = retention === 'expiry' ? 1 : 500;
            if (retention === 'expiry') clock.mockReturnValue(160_000);
            for (let i = 0; i < count; i++) await transport.emit('conv-1', 'same');
            const reconnected = createMockStream();
            transport.registerStream('conv-1', reconnected);
            if (outcome === 'resolve') pending.resolve();
            else pending.reject(new Error('late failure'));
            await emitted;
            for (let i = 0; i < count; i++) await settleReplay();
            expect(reconnected.writeSSE).toHaveBeenCalledTimes(count);
            expect(reconnected.writeSSE).toHaveBeenLastCalledWith({ data: 'same' });
            transport.removeStream('conv-1', reconnected);
            const later = createMockStream();
            transport.registerStream('conv-1', later);
            await settleReplay();
            expect(later.writeSSE).not.toHaveBeenCalled();
          } finally {
            pending.resolve();
            clock.mockRestore();
            transport.stop();
          }
        }
      );
    }

    test('no-ops when stream is closed', async () => {
      const transport = new SSETransport();
      const stream = createMockStream({ closed: true });

      transport.registerStream('conv-1', stream);
      await transport.emit('conv-1', '{"type":"text"}');

      expect(stream.writeSSE).not.toHaveBeenCalled();
    });

    test.each(['conv-1', '__dashboard__'])(
      'retains a failed live write for reconnect: %s',
      async conversationId => {
        const transport = new SSETransport();
        const stream = createMockStream({
          writeSSE: mock(() => Promise.reject(new Error('write failed'))),
        });

        try {
          transport.registerStream(conversationId, stream);
          await transport.emit(conversationId, '{"type":"text"}');
          expect(transport.hasActiveStream(conversationId)).toBe(false);
          const reconnected = createMockStream();
          transport.registerStream(conversationId, reconnected);
          await settleReplay();
          expect(reconnected.writeSSE).toHaveBeenCalledTimes(1);
          expect(reconnected.writeSSE).toHaveBeenCalledWith({ data: '{"type":"text"}' });
        } finally {
          transport.stop();
        }
      }
    );
  });

  describe('pending replay', () => {
    test.each(['resolve', 'reject'] as const)(
      'hands the backlog to a replacement after the old write settles: %s',
      async outcome => {
        const transport = new SSETransport();
        const pending = Promise.withResolvers<void>();
        const old = createMockStream({ writeSSE: mock(() => pending.promise) });
        const replacement = createMockStream();
        try {
          await transport.emit('conv-1', 'first');
          await transport.emit('conv-1', 'second');
          transport.registerStream('conv-1', old);
          transport.registerStream('conv-1', replacement);
          expect(old.writeSSE).toHaveBeenCalledTimes(1);
          expect(replacement.writeSSE).not.toHaveBeenCalled();
          if (outcome === 'resolve') pending.resolve();
          else pending.reject(new Error('old replay failed'));
          await settleReplay();
          const expected = outcome === 'resolve' ? ['second'] : ['first', 'second'];
          expect(replacement.writeSSE).toHaveBeenCalledTimes(expected.length);
          for (const [index, data] of expected.entries()) {
            expect(replacement.writeSSE).toHaveBeenNthCalledWith(index + 1, { data });
          }
          expect(transport.hasActiveStream('conv-1')).toBe(true);
          await transport.emit('conv-1', 'live');
          expect(replacement.writeSSE).toHaveBeenLastCalledWith({ data: 'live' });
        } finally {
          pending.resolve();
          transport.stop();
        }
      }
    );

    test.each(['closed', 'removed'] as const)(
      'retains the suffix when the writer is %s before the next attempt',
      async state => {
        const transport = new SSETransport();
        const pending = Promise.withResolvers<void>();
        const stream = createMockStream({ writeSSE: mock(() => pending.promise) });
        try {
          await transport.emit('conv-1', 'first');
          await transport.emit('conv-1', 'second');
          transport.registerStream('conv-1', stream);
          if (state === 'closed') Object.defineProperty(stream, 'closed', { value: true });
          else transport.removeStream('conv-1', stream);
          pending.resolve();
          await settleReplay();
          expect(stream.writeSSE).toHaveBeenCalledTimes(1);
          const next = createMockStream();
          transport.registerStream('conv-1', next);
          await settleReplay();
          expect(next.writeSSE).toHaveBeenCalledTimes(1);
          expect(next.writeSSE).toHaveBeenCalledWith({ data: 'second' });
        } finally {
          pending.resolve();
          transport.stop();
        }
      }
    );

    test('failure preserves original TTL while newer events remain eligible', async () => {
      const transport = new SSETransport();
      const clock = spyOn(Date, 'now').mockReturnValue(100_000);
      const pending = Promise.withResolvers<void>();
      const stream = createMockStream({ writeSSE: mock(() => pending.promise) });
      try {
        await transport.emit('conv-1', 'old');
        transport.registerStream('conv-1', stream);
        clock.mockReturnValue(140_000);
        pending.reject(new Error('replay failed'));
        await settleReplay();
        await transport.emit('conv-1', 'new');
        clock.mockReturnValue(160_000);
        const next = createMockStream();
        transport.registerStream('conv-1', next);
        await settleReplay();
        expect(next.writeSSE).toHaveBeenCalledTimes(1);
        expect(next.writeSSE).toHaveBeenCalledWith({ data: 'new' });
        expect(mockLogger.warn).toHaveBeenCalledWith(
          { conversationId: 'conv-1', expired: 1, ttlMs: 60_000 },
          'transport.buffer_ttl_expired'
        );
      } finally {
        pending.resolve();
        clock.mockRestore();
        transport.stop();
      }
    });

    test('expiry is checked again after a pending write', async () => {
      const transport = new SSETransport();
      const clock = spyOn(Date, 'now').mockReturnValue(100_000);
      const pending = Promise.withResolvers<void>();
      const stream = createMockStream({ writeSSE: mock(() => pending.promise) });
      try {
        await transport.emit('conv-1', 'first');
        await transport.emit('conv-1', 'expired suffix');
        transport.registerStream('conv-1', stream);
        clock.mockReturnValue(160_000);
        pending.resolve();
        await settleReplay();
        expect(stream.writeSSE).toHaveBeenCalledTimes(1);
        const next = createMockStream();
        transport.registerStream('conv-1', next);
        expect(next.writeSSE).not.toHaveBeenCalled();
      } finally {
        pending.resolve();
        clock.mockRestore();
        transport.stop();
      }
    });

    test('completion of an evicted entry cannot consume the retained head', async () => {
      const transport = new SSETransport();
      const pending = Promise.withResolvers<void>();
      const stream = createMockStream({ writeSSE: mock(() => pending.promise) });
      try {
        await transport.emit('conv-1', 'evicted');
        transport.registerStream('conv-1', stream);
        transport.removeStream('conv-1', stream);
        for (let i = 0; i < 501; i++) await transport.emit('conv-1', String(i));
        pending.resolve();
        await settleReplay();
        const next = createMockStream();
        transport.registerStream('conv-1', next);
        for (let i = 1; i <= 500; i++) {
          await settleReplay();
          expect(next.writeSSE).toHaveBeenNthCalledWith(i, { data: String(i) });
        }
        expect(next.writeSSE).toHaveBeenCalledTimes(500);
      } finally {
        pending.resolve();
        transport.stop();
      }
    });

    test.each(['resolve', 'reject'] as const)(
      'stop invalidates pending replay even if the transport is reused: %s',
      async outcome => {
        const transport = new SSETransport();
        const pending = Promise.withResolvers<void>();
        const old = createMockStream({ writeSSE: mock(() => pending.promise) });
        try {
          await transport.emit('conv-1', 'old first');
          await transport.emit('conv-1', 'old second');
          transport.registerStream('conv-1', old);
          transport.stop();
          await transport.emit('conv-1', 'new');
          const next = createMockStream();
          transport.registerStream('conv-1', next);
          if (outcome === 'resolve') pending.resolve();
          else pending.reject(new Error('stopped write'));
          await settleReplay();
          expect(old.writeSSE).toHaveBeenCalledTimes(1);
          expect(next.writeSSE).toHaveBeenCalledTimes(1);
          expect(next.writeSSE).toHaveBeenCalledWith({ data: 'new' });
          expect(transport.hasActiveStream('conv-1')).toBe(true);
        } finally {
          pending.resolve();
          transport.stop();
        }
      }
    );

    test('buffer cleanup invalidates old replay before a new buffer is created', async () => {
      jest.useFakeTimers();
      const transport = new SSETransport();
      const pending = Promise.withResolvers<void>();
      const nextPending = Promise.withResolvers<void>();
      const old = createMockStream({ writeSSE: mock(() => pending.promise) });
      const next = createMockStream({ writeSSE: mock(() => nextPending.promise) });
      try {
        await transport.emit('conv-1', 'old first');
        await transport.emit('conv-1', 'old second');
        transport.registerStream('conv-1', old);
        transport.removeStream('conv-1', old);
        jest.advanceTimersByTime(60_500);
        await transport.emit('conv-1', 'new first');
        await transport.emit('conv-1', 'new second');
        transport.registerStream('conv-1', next);
        pending.resolve();
        await settleReplay();
        expect(old.writeSSE).toHaveBeenCalledTimes(1);
        expect(next.writeSSE).toHaveBeenCalledTimes(1);
        const replacement = createMockStream();
        transport.registerStream('conv-1', replacement);
        expect(replacement.writeSSE).not.toHaveBeenCalled();
        nextPending.resolve();
        await settleReplay();
        expect(replacement.writeSSE).toHaveBeenCalledTimes(1);
        expect(replacement.writeSSE).toHaveBeenCalledWith({ data: 'new second' });
      } finally {
        pending.resolve();
        nextPending.resolve();
        transport.stop();
        jest.useRealTimers();
      }
    });

    test('dashboard replay has one owner and retries a failed head on another writer', async () => {
      const transport = new SSETransport();
      const pending = Promise.withResolvers<void>();
      const first = createMockStream({ writeSSE: mock(() => pending.promise) });
      const second = createMockStream();
      try {
        await transport.emit('__dashboard__', 'first');
        await transport.emit('__dashboard__', 'second');
        transport.registerStream('__dashboard__', first);
        transport.registerStream('__dashboard__', second);
        expect(second.writeSSE).not.toHaveBeenCalled();
        pending.reject(new Error('dashboard disconnected'));
        await settleReplay();
        expect(first.writeSSE).toHaveBeenCalledTimes(1);
        expect(second.writeSSE).toHaveBeenCalledTimes(2);
        expect(second.writeSSE).toHaveBeenNthCalledWith(1, { data: 'first' });
        expect(second.writeSSE).toHaveBeenNthCalledWith(2, { data: 'second' });
        const third = createMockStream();
        transport.registerStream('__dashboard__', third);
        expect(third.writeSSE).not.toHaveBeenCalled();
      } finally {
        pending.resolve();
        transport.stop();
      }
    });
  });

  describe('emitWorkflowEvent', () => {
    test('writes to active stream', () => {
      const transport = new SSETransport();
      const stream = createMockStream();

      transport.registerStream('conv-1', stream);
      transport.emitWorkflowEvent('conv-1', '{"type":"workflow_status"}');

      expect(stream.writeSSE).toHaveBeenCalledWith({ data: '{"type":"workflow_status"}' });
    });

    test('buffers workflow events until a stream connects', () => {
      const transport = new SSETransport();

      try {
        transport.emitWorkflowEvent('conv-1', '{"type":"workflow_status"}');
        const stream = createMockStream();
        transport.registerStream('conv-1', stream);
        expect(stream.writeSSE).toHaveBeenCalledWith({ data: '{"type":"workflow_status"}' });
      } finally {
        transport.stop();
      }
    });
  });

  describe('hasActiveStream', () => {
    test('returns false when no stream registered', () => {
      const transport = new SSETransport();
      expect(transport.hasActiveStream('conv-1')).toBe(false);
    });

    test('returns true for active stream', () => {
      const transport = new SSETransport();
      transport.registerStream('conv-1', createMockStream());
      expect(transport.hasActiveStream('conv-1')).toBe(true);
    });

    test('returns false for closed stream', () => {
      const transport = new SSETransport();
      transport.registerStream('conv-1', createMockStream({ closed: true }));
      expect(transport.hasActiveStream('conv-1')).toBe(false);
    });
  });

  describe('buffer eviction warn throttle', () => {
    test('throttles repeated eviction warns to one per conversation per window', () => {
      // EVENT_BUFFER_MAX is 500; push 600 events into a conversation with no
      // active stream so all overflow events trigger an eviction. Even though
      // ~100 evictions happen, we should see exactly one warn (throttled).
      const transport = new SSETransport();
      mockLogger.warn.mockClear();

      for (let i = 0; i < 600; i++) {
        // emit() with no registered stream falls through to bufferEvent()
        void transport.emit('conv-throttle', `{"i":${i}}`);
      }

      const evictionWarns = mockLogger.warn.mock.calls.filter(
        (call: unknown[]) => call[1] === 'transport.buffer_evicted_oldest'
      );
      expect(evictionWarns.length).toBe(1);

      transport.stop();
    });
  });

  describe('start/stop', () => {
    test('start logs adapter_ready', () => {
      const transport = new SSETransport();
      transport.start();
      expect(mockLogger.info).toHaveBeenCalledWith('web.adapter_ready');
      transport.stop();
    });

    test('stop logs adapter_stopped', () => {
      const transport = new SSETransport();
      transport.start();
      mockLogger.info.mockClear();
      transport.stop();
      expect(mockLogger.info).toHaveBeenCalledWith('web.adapter_stopped');
    });

    test('stop closes all streams and clears state', () => {
      const transport = new SSETransport();
      const stream = createMockStream();

      transport.start();
      transport.registerStream('conv-1', stream);
      transport.stop();

      expect(stream.close).toHaveBeenCalledTimes(1);
      expect(transport.hasActiveStream('conv-1')).toBe(false);
    });

    test('stop cancels cleanup timers', () => {
      const cleanup = mock((_id: string) => undefined);
      const transport = new SSETransport(cleanup, 1);
      const stream = createMockStream();

      transport.start();
      transport.registerStream('conv-1', stream);
      transport.removeStream('conv-1');
      transport.stop();

      // Wait longer than grace period — cleanup should NOT fire (timer was cleared)
      return new Promise<void>(resolve => {
        setTimeout(() => {
          expect(cleanup).not.toHaveBeenCalled();
          resolve();
        }, 50);
      });
    });
  });
});
