import { describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test/mocks/logger';

mock.module('@archon/paths', () => ({
  createLogger: mock(() => createMockLogger()),
}));

import type { SessionEvent } from '@github/copilot-sdk';

import type { MessageChunk, TokenUsage } from '../../types';
import {
  AsyncQueue,
  mapCopilotEvent,
  normalizeCopilotUsage,
  type EventMapperContext,
} from './event-bridge';

function makeCtx(): EventMapperContext & {
  capturedUsage: TokenUsage | undefined;
  erroredWith: string | undefined;
} {
  const toolCallIdToName = new Map<string, string>();
  let capturedUsage: TokenUsage | undefined;
  let erroredWith: string | undefined;
  return {
    toolCallIdToName,
    captureUsage: (u: TokenUsage): void => {
      capturedUsage = u;
    },
    markErrored: (msg: string): void => {
      erroredWith = msg;
    },
    get capturedUsage() {
      return capturedUsage;
    },
    get erroredWith() {
      return erroredWith;
    },
  };
}

// Helper: construct a minimal SessionEvent with the required shape. We cast
// via unknown because the full SessionEvent union includes many optional
// fields we don't care about in this unit test.
function evt<T extends SessionEvent['type']>(type: T, data: unknown): SessionEvent {
  return {
    id: 'test-event-id',
    timestamp: new Date().toISOString(),
    parentId: null,
    type,
    data,
  } as unknown as SessionEvent;
}

describe('AsyncQueue', () => {
  test('delivers items pushed before iteration starts', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1, 2]);
  });

  test('blocks consumer until item is pushed', async () => {
    const q = new AsyncQueue<string>();
    const iter = q[Symbol.asyncIterator]();
    const next = iter.next();
    let resolved = false;
    void next.then(() => {
      resolved = true;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(resolved).toBe(false);
    q.push('hello');
    const result = await next;
    expect(result).toEqual({ value: 'hello', done: false });
  });

  test('close() drains pending waiters with done=true', async () => {
    const q = new AsyncQueue<number>();
    const iter = q[Symbol.asyncIterator]();
    const next = iter.next();
    q.close();
    const result = await next;
    expect(result).toEqual({ value: undefined, done: true });
  });

  test('rejects second consumer (single-consumer invariant)', () => {
    const q = new AsyncQueue<number>();
    // First iteration — OK.
    q[Symbol.asyncIterator]();
    // Second iteration — throws synchronously at the call site.
    expect(() => q[Symbol.asyncIterator]()).toThrow(/single-consumer/);
  });

  test('push after close is a no-op (does not throw)', () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.push(1)).not.toThrow();
  });

  test('close() is idempotent', () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.close()).not.toThrow();
  });
});

describe('normalizeCopilotUsage', () => {
  test('returns undefined when input is undefined', () => {
    expect(normalizeCopilotUsage(undefined)).toBeUndefined();
  });

  test('returns undefined when neither input nor output is numeric', () => {
    expect(normalizeCopilotUsage({})).toBeUndefined();
    expect(normalizeCopilotUsage({ inputTokens: 'x' as unknown as number })).toBeUndefined();
  });

  test('fills missing side with 0 when only one is numeric', () => {
    expect(normalizeCopilotUsage({ inputTokens: 100 })).toEqual({ input: 100, output: 0 });
    expect(normalizeCopilotUsage({ outputTokens: 50 })).toEqual({ input: 0, output: 50 });
  });

  test('maps both input and output when present', () => {
    expect(normalizeCopilotUsage({ inputTokens: 100, outputTokens: 42 })).toEqual({
      input: 100,
      output: 42,
    });
  });
});

describe('mapCopilotEvent', () => {
  test('assistant.message_delta → assistant chunk with deltaContent', () => {
    const ctx = makeCtx();
    const out = mapCopilotEvent(
      evt('assistant.message_delta', { messageId: 'm1', deltaContent: 'Hello ' }),
      ctx
    );
    expect(out).toEqual([{ type: 'assistant', content: 'Hello ' }]);
  });

  test('assistant.message_delta with empty content is dropped', () => {
    const ctx = makeCtx();
    const out = mapCopilotEvent(
      evt('assistant.message_delta', { messageId: 'm1', deltaContent: '' }),
      ctx
    );
    expect(out).toEqual([]);
  });

  test('assistant.reasoning_delta → thinking chunk', () => {
    const ctx = makeCtx();
    const out = mapCopilotEvent(
      evt('assistant.reasoning_delta', { messageId: 'm1', deltaContent: 'hmm ' }),
      ctx
    );
    expect(out).toEqual([{ type: 'thinking', content: 'hmm ' }]);
  });

  test('assistant.usage → no chunk, captures usage via callback', () => {
    const ctx = makeCtx();
    const out = mapCopilotEvent(
      evt('assistant.usage', { model: 'gpt-5', inputTokens: 7, outputTokens: 42 }),
      ctx
    );
    expect(out).toEqual([]);
    expect(ctx.capturedUsage).toEqual({ input: 7, output: 42 });
  });

  test('tool.execution_start → tool chunk + records name by id', () => {
    const ctx = makeCtx();
    const out = mapCopilotEvent(
      evt('tool.execution_start', {
        toolCallId: 'c1',
        toolName: 'bash',
        arguments: { cmd: 'ls' },
      }),
      ctx
    );
    expect(out).toEqual([
      {
        type: 'tool',
        toolName: 'bash',
        toolInput: { cmd: 'ls' },
        toolCallId: 'c1',
      },
    ]);
    expect(ctx.toolCallIdToName.get('c1')).toBe('bash');
  });

  test('tool.execution_start without arguments uses empty object', () => {
    const ctx = makeCtx();
    const out = mapCopilotEvent(
      evt('tool.execution_start', { toolCallId: 'c1', toolName: 'read' }),
      ctx
    );
    expect((out[0] as { toolInput: unknown }).toolInput).toEqual({});
  });

  test('tool.execution_complete on success → tool_result chunk with detailedContent', () => {
    const ctx = makeCtx();
    ctx.toolCallIdToName.set('c1', 'bash');
    const out = mapCopilotEvent(
      evt('tool.execution_complete', {
        toolCallId: 'c1',
        success: true,
        result: { content: 'brief', detailedContent: 'full diff output' },
      }),
      ctx
    );
    expect(out).toEqual([
      {
        type: 'tool_result',
        toolName: 'bash',
        toolOutput: 'full diff output',
        toolCallId: 'c1',
      },
    ]);
  });

  test('tool.execution_complete falls back to content when detailedContent absent', () => {
    const ctx = makeCtx();
    ctx.toolCallIdToName.set('c1', 'read');
    const out = mapCopilotEvent(
      evt('tool.execution_complete', {
        toolCallId: 'c1',
        success: true,
        result: { content: 'file contents' },
      }),
      ctx
    );
    expect((out[0] as { toolOutput: string }).toolOutput).toBe('file contents');
  });

  test('tool.execution_complete on failure → system warning + tool_result with ❌', () => {
    const ctx = makeCtx();
    ctx.toolCallIdToName.set('c1', 'bash');
    const out = mapCopilotEvent(
      evt('tool.execution_complete', {
        toolCallId: 'c1',
        success: false,
        result: { content: 'permission denied' },
      }),
      ctx
    );
    expect(out).toEqual([
      { type: 'system', content: '⚠️ Tool bash failed' },
      {
        type: 'tool_result',
        toolName: 'bash',
        toolOutput: '❌ permission denied',
        toolCallId: 'c1',
      },
    ]);
  });

  test('tool.execution_complete with unknown toolCallId uses "unknown"', () => {
    const ctx = makeCtx();
    const out = mapCopilotEvent(
      evt('tool.execution_complete', {
        toolCallId: 'missing',
        success: true,
        result: { content: 'x' },
      }),
      ctx
    );
    expect((out[0] as { toolName: string }).toolName).toBe('unknown');
  });

  test('session.error → no chunk emitted, markErrored called (deferred to bridgeSession)', () => {
    const ctx = makeCtx();
    const out = mapCopilotEvent(
      evt('session.error', { errorType: 'rate_limit', message: 'Slow down' }),
      ctx
    );
    // Defer the system chunk to bridgeSession so it can suppress the warning
    // when SDK auto-recovery still delivers a fallback assistant message.
    expect(out).toEqual([]);
    expect(ctx.erroredWith).toBe('Slow down');
  });

  test('session.error with missing message records fallback string', () => {
    const ctx = makeCtx();
    const out = mapCopilotEvent(evt('session.error', { errorType: 'unknown' }), ctx);
    expect(out).toEqual([]);
    expect(ctx.erroredWith).toBe('Copilot session error');
  });

  test('session.compaction_start → context-compaction system chunk', () => {
    const ctx = makeCtx();
    const out = mapCopilotEvent(evt('session.compaction_start', {}), ctx);
    expect(out).toEqual([{ type: 'system', content: '⚙️ Compacting context…' }]);
  });

  test('unhandled event types yield no chunks', () => {
    const ctx = makeCtx();
    expect(mapCopilotEvent(evt('session.idle', {}), ctx)).toEqual([]);
    expect(mapCopilotEvent(evt('assistant.turn_start', { turnId: 't1' }), ctx)).toEqual([]);
    expect(mapCopilotEvent(evt('user.message', {}), ctx)).toEqual([]);
  });
});
