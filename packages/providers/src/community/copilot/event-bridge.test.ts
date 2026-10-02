import { describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test/mocks/logger';

mock.module('@archon/paths', () => ({
  createLogger: mock(() => createMockLogger()),
}));

import type { SessionEvent } from '@github/copilot-sdk';
import { TOOL_OUTPUT_MAX_CHARS } from '@archon/provider-contract';

import type { TokenUsage } from '../../types';
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
  let capturedUsage: TokenUsage | undefined;
  let erroredWith: string | undefined;
  return {
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

  test('returns undefined when only one required axis is numeric', () => {
    expect(normalizeCopilotUsage({ inputTokens: 100 })).toBeUndefined();
    expect(normalizeCopilotUsage({ outputTokens: 50 })).toBeUndefined();
  });

  test('maps both input and output when present', () => {
    expect(normalizeCopilotUsage({ inputTokens: 100, outputTokens: 42 })).toEqual({
      input: 100,
      output: 42,
    });
  });

  test('preserves measured zeros', () => {
    expect(normalizeCopilotUsage({ inputTokens: 0, outputTokens: 0 })).toEqual({
      input: 0,
      output: 0,
    });
  });
});

describe('mapCopilotEvent', () => {
  test('a delta stream followed by the whole message yields one agent_message_chunk', () => {
    const ctx = makeCtx();
    const out = [
      evt('assistant.message_delta', { messageId: 'm1', deltaContent: 'Hello ' }),
      evt('assistant.message_delta', { messageId: 'm1', deltaContent: 'world' }),
      evt('assistant.message', { messageId: 'm1', content: 'Hello world' }),
    ].flatMap(event => mapCopilotEvent(event, ctx));
    expect(out).toEqual([{ type: 'agent_message_chunk', text: 'Hello world' }]);
  });

  test('an assistant.message with empty content is dropped', () => {
    const ctx = makeCtx();
    expect(
      mapCopilotEvent(evt('assistant.message', { messageId: 'm1', content: '' }), ctx)
    ).toEqual([]);
  });

  test('reasoning deltas then the whole reasoning block yield one agent_thought_chunk', () => {
    const ctx = makeCtx();
    const out = [
      evt('assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: 'hmm ' }),
      evt('assistant.reasoning', { reasoningId: 'r1', content: 'hmm, let me think' }),
    ].flatMap(event => mapCopilotEvent(event, ctx));
    expect(out).toEqual([{ type: 'agent_thought_chunk', text: 'hmm, let me think' }]);
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

  test('tool.execution_start → tool_call with arguments as rawInput', () => {
    const out = mapCopilotEvent(
      evt('tool.execution_start', { toolCallId: 'c1', toolName: 'bash', arguments: { cmd: 'ls' } }),
      makeCtx()
    );
    expect(out).toEqual([
      { type: 'tool_call', toolCallId: 'c1', name: 'bash', rawInput: { cmd: 'ls' } },
    ]);
  });

  test('tool.execution_start without arguments omits rawInput', () => {
    const out = mapCopilotEvent(
      evt('tool.execution_start', { toolCallId: 'c1', toolName: 'read' }),
      makeCtx()
    );
    expect(out).toEqual([{ type: 'tool_call', toolCallId: 'c1', name: 'read' }]);
  });

  test('tool.execution_complete on success → completed update with detailedContent', () => {
    const out = mapCopilotEvent(
      evt('tool.execution_complete', {
        toolCallId: 'c1',
        success: true,
        result: { content: 'brief', detailedContent: 'full diff output' },
      }),
      makeCtx()
    );
    expect(out).toEqual([
      {
        type: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        output: 'full diff output',
      },
    ]);
  });

  test('tool.execution_complete falls back to content when detailedContent absent', () => {
    const out = mapCopilotEvent(
      evt('tool.execution_complete', {
        toolCallId: 'c1',
        success: true,
        result: { content: 'file contents' },
      }),
      makeCtx()
    );
    expect(out).toEqual([
      { type: 'tool_call_update', toolCallId: 'c1', status: 'completed', output: 'file contents' },
    ]);
  });

  test('tool output over the cap is truncated and flagged', () => {
    const out = mapCopilotEvent(
      evt('tool.execution_complete', {
        toolCallId: 'c1',
        success: true,
        result: { content: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 10) },
      }),
      makeCtx()
    );
    expect(out).toEqual([
      {
        type: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        output: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS),
        outputTruncated: true,
      },
    ]);
  });

  test.each<[string, Record<string, unknown>, string]>([
    ['result only', { result: { content: 'permission denied' } }, 'permission denied'],
    [
      'error.message and no result',
      { error: { message: 'permission denied', code: 'EACCES' } },
      'permission denied',
    ],
    [
      'error.message and a distinct result',
      {
        error: { message: 'command exited with code 1' },
        result: { content: 'brief', detailedContent: 'stderr: file not found' },
      },
      'command exited with code 1\nstderr: file not found',
    ],
    [
      'error.message already in the result',
      { error: { message: 'permission denied' }, result: { content: 'Error: permission denied' } },
      'Error: permission denied',
    ],
  ])('a failed tool.execution_complete with %s → failed update', (_label, data, output) => {
    const out = mapCopilotEvent(
      evt('tool.execution_complete', { toolCallId: 'c1', success: false, ...data }),
      makeCtx()
    );
    expect(out).toEqual([{ type: 'tool_call_update', toolCallId: 'c1', status: 'failed', output }]);
  });

  test('session.error → no chunk emitted, markErrored called (deferred to bridgeSession)', () => {
    const ctx = makeCtx();
    const out = mapCopilotEvent(
      evt('session.error', { errorType: 'rate_limit', message: 'Slow down' }),
      ctx
    );
    // Deferred to bridgeSession so it can suppress the warning when SDK
    // auto-recovery still delivers a fallback assistant message.
    expect(out).toEqual([]);
    expect(ctx.erroredWith).toBe('Slow down');
  });

  test('session.error with missing message records fallback string', () => {
    const ctx = makeCtx();
    const out = mapCopilotEvent(evt('session.error', { errorType: 'unknown' }), ctx);
    expect(out).toEqual([]);
    expect(ctx.erroredWith).toBe('Copilot session error');
  });

  test('compaction start and complete → compaction started/completed with token counts', () => {
    const ctx = makeCtx();
    const out = [
      evt('session.compaction_start', {}),
      evt('session.compaction_complete', {
        success: true,
        preCompactionTokens: 9000,
        postCompactionTokens: 1200,
      }),
    ].flatMap(event => mapCopilotEvent(event, ctx));
    expect(out).toEqual([
      { type: 'compaction', phase: 'started' },
      { type: 'compaction', phase: 'completed', tokensBefore: 9000, tokensAfter: 1200 },
    ]);
  });

  test('unhandled event types yield no chunks', () => {
    const ctx = makeCtx();
    expect(mapCopilotEvent(evt('session.idle', {}), ctx)).toEqual([]);
    expect(mapCopilotEvent(evt('assistant.turn_start', { turnId: 't1' }), ctx)).toEqual([]);
    expect(mapCopilotEvent(evt('user.message', {}), ctx)).toEqual([]);
  });
});
