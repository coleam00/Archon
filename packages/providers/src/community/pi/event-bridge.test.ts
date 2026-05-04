import { describe, expect, test } from 'bun:test';
import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';

import {
  AsyncQueue,
  bridgeSession,
  buildResultChunk,
  mapPiEvent,
  serializeToolResult,
  tryParseStructuredOutput,
  usageToTokens,
} from './event-bridge';

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

  test('preserves FIFO order across push and waiter', async () => {
    const q = new AsyncQueue<number>();
    const iter = q[Symbol.asyncIterator]();
    const p1 = iter.next();
    q.push(10);
    q.push(20);
    const r1 = await p1;
    const r2 = await iter.next();
    if (!r1.done) expect(r1.value).toBe(10);
    if (!r2.done) expect(r2.value).toBe(20);
  });

  test('second iterator call throws (single-consumer invariant)', () => {
    const q = new AsyncQueue<number>();
    // First call establishes the consumer; the iterator itself is created
    // but iteration only starts on `.next()`. Pi's bridge uses this pattern.
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
    q.push(42); // Must not resurrect the closed queue.
    const r = await iter.next();
    expect(r.done).toBe(true);
  });

  test('close() is idempotent', () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.close()).not.toThrow();
  });
});

// ─── serializeToolResult ───────────────────────────────────────────────────

describe('serializeToolResult', () => {
  test('returns strings verbatim', () => {
    expect(serializeToolResult('hello')).toBe('hello');
  });

  test('JSON-serializes objects', () => {
    expect(serializeToolResult({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });

  test('JSON-serializes arrays', () => {
    expect(serializeToolResult([1, 2, 3])).toBe('[1,2,3]');
  });

  test('falls back to String() for circular refs', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const result = serializeToolResult(circular);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── usageToTokens ─────────────────────────────────────────────────────────

describe('usageToTokens', () => {
  test('maps Pi Usage to Archon TokenUsage', () => {
    const usage = {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    };
    expect(usageToTokens(usage)).toEqual({
      input: 100,
      output: 50,
      total: 150,
      cost: 0.003,
    });
  });
});

// ─── buildResultChunk ──────────────────────────────────────────────────────

describe('buildResultChunk', () => {
  const usage = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  };

  test('flags isError when no assistant message is present', () => {
    // agent_end with no assistant message in the transcript is anomalous —
    // must surface as an error so the orchestrator doesn't treat a broken
    // session as a clean success.
    const expected = {
      type: 'result',
      isError: true,
      errorSubtype: 'missing_assistant_message',
    };
    expect(buildResultChunk([])).toEqual(expected);
    expect(buildResultChunk([{ role: 'user', content: [] }])).toEqual(expected);
  });

  test('extracts usage from last assistant message', () => {
    const chunk = buildResultChunk([
      { role: 'user', content: [] },
      { role: 'assistant', usage, stopReason: 'stop', content: [] },
    ]);
    expect(chunk.type).toBe('result');
    if (chunk.type === 'result') {
      expect(chunk.tokens).toEqual({ input: 10, output: 5, total: 15, cost: 0.01 });
      expect(chunk.stopReason).toBe('stop');
      expect(chunk.isError).toBeUndefined();
      expect(chunk.cost).toBe(0.01);
    }
  });

  test('flags isError for stopReason=error', () => {
    const chunk = buildResultChunk([
      { role: 'assistant', usage, stopReason: 'error', errorMessage: 'auth', content: [] },
    ]);
    if (chunk.type === 'result') {
      expect(chunk.isError).toBe(true);
      expect(chunk.errorSubtype).toBe('error');
    }
  });

  test('flags isError for stopReason=aborted', () => {
    const chunk = buildResultChunk([
      { role: 'assistant', usage, stopReason: 'aborted', content: [] },
    ]);
    if (chunk.type === 'result') {
      expect(chunk.isError).toBe(true);
    }
  });

  test('prefers last assistant message when multiple present', () => {
    const olderUsage = { ...usage, input: 1, totalTokens: 1 };
    const chunk = buildResultChunk([
      { role: 'assistant', usage: olderUsage, stopReason: 'stop', content: [] },
      { role: 'user', content: [] },
      { role: 'assistant', usage, stopReason: 'stop', content: [] },
    ]);
    if (chunk.type === 'result') {
      expect(chunk.tokens?.input).toBe(10);
    }
  });
});

// ─── mapPiEvent ────────────────────────────────────────────────────────────

describe('mapPiEvent', () => {
  test('text_delta → assistant chunk', () => {
    const chunks = mapPiEvent({
      type: 'message_update',
      message: { role: 'assistant' } as never,
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'hi',
        partial: { role: 'assistant' } as never,
      },
    });
    expect(chunks).toEqual([{ type: 'assistant', content: 'hi' }]);
  });

  test('thinking_delta → thinking chunk', () => {
    const chunks = mapPiEvent({
      type: 'message_update',
      message: { role: 'assistant' } as never,
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'hmm',
        partial: { role: 'assistant' } as never,
      },
    });
    expect(chunks).toEqual([{ type: 'thinking', content: 'hmm' }]);
  });

  test('text_start/end and boundaries are skipped', () => {
    const chunks = mapPiEvent({
      type: 'message_update',
      message: { role: 'assistant' } as never,
      assistantMessageEvent: {
        type: 'text_start',
        contentIndex: 0,
        partial: { role: 'assistant' } as never,
      },
    });
    expect(chunks).toEqual([]);
  });

  test('tool_execution_start → tool chunk with toolCallId', () => {
    const chunks = mapPiEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-123',
      toolName: 'read',
      args: { path: '/foo' },
    });
    expect(chunks).toEqual([
      {
        type: 'tool',
        toolName: 'read',
        toolInput: { path: '/foo' },
        toolCallId: 'call-123',
      },
    ]);
  });

  test('tool_execution_start coerces non-object args to empty record', () => {
    const chunks = mapPiEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: 'just-a-string',
    });
    expect(chunks[0]).toMatchObject({ type: 'tool', toolInput: {} });
  });

  test('tool_execution_end → tool_result chunk with matching id', () => {
    const chunks = mapPiEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-123',
      toolName: 'read',
      result: 'file contents',
      isError: false,
    });
    expect(chunks).toEqual([
      {
        type: 'tool_result',
        toolName: 'read',
        toolOutput: 'file contents',
        toolCallId: 'call-123',
      },
    ]);
  });

  test('tool_execution_end with isError emits system warning first', () => {
    const chunks = mapPiEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-99',
      toolName: 'bash',
      result: 'exit 1',
      isError: true,
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe('system');
    expect(chunks[1].type).toBe('tool_result');
  });

  test('auto_retry_start → system chunk', () => {
    const chunks = mapPiEvent({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: 'rate limit',
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('system');
    if (chunks[0].type === 'system') {
      expect(chunks[0].content).toContain('retry 1/3');
      expect(chunks[0].content).toContain('rate limit');
    }
  });

  test('agent_end → result chunk', () => {
    const usage = {
      input: 5,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
    };
    const chunks = mapPiEvent({
      type: 'agent_end',
      messages: [{ role: 'assistant', usage, stopReason: 'stop', content: [] } as never],
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('result');
  });

  test('skipped event types yield no chunks', () => {
    expect(mapPiEvent({ type: 'agent_start' })).toEqual([]);
    expect(mapPiEvent({ type: 'turn_start' })).toEqual([]);
    expect(
      mapPiEvent({
        type: 'turn_end',
        message: { role: 'assistant' } as never,
        toolResults: [],
      })
    ).toEqual([]);
    expect(
      mapPiEvent({
        type: 'queue_update',
        steering: [] as readonly string[],
        followUp: [] as readonly string[],
      })
    ).toEqual([]);
    expect(
      mapPiEvent({
        type: 'compaction_start',
        reason: 'manual',
      })
    ).toEqual([]);
  });
});

// ─── tryParseStructuredOutput ──────────────────────────────────────────────

describe('tryParseStructuredOutput', () => {
  test('parses clean JSON object', () => {
    expect(tryParseStructuredOutput('{"name":"alpha","count":3}')).toEqual({
      name: 'alpha',
      count: 3,
    });
  });

  test('parses JSON with surrounding whitespace', () => {
    expect(tryParseStructuredOutput('  \n{"ok":true}\n  ')).toEqual({ ok: true });
  });

  test('strips ```json fences', () => {
    const fenced = '```json\n{"area":"web","confidence":0.9}\n```';
    expect(tryParseStructuredOutput(fenced)).toEqual({ area: 'web', confidence: 0.9 });
  });

  test('strips bare ``` fences', () => {
    expect(tryParseStructuredOutput('```\n{"ok":1}\n```')).toEqual({ ok: 1 });
  });

  test('parses JSON arrays', () => {
    expect(tryParseStructuredOutput('[1,2,3]')).toEqual([1, 2, 3]);
  });

  test('returns undefined on empty string', () => {
    expect(tryParseStructuredOutput('')).toBeUndefined();
    expect(tryParseStructuredOutput('   ')).toBeUndefined();
  });

  test('returns undefined when model wraps JSON in prose with trailing text', () => {
    // Caller degrades via the executor's missing-structured-output warning.
    // Forward scan starts at the JSON object but JSON.parse rejects the
    // trailing prose, so we fail closed rather than guess.
    const prose =
      'Here is the JSON you requested:\n{"ok":true}\nLet me know if you need anything else.';
    expect(tryParseStructuredOutput(prose)).toBeUndefined();
  });

  test('parses preamble + trailing JSON (Minimax M2.7 reasoning-model pattern)', () => {
    // Real-world failure mode observed on Minimax M2.7: the model "thinks out
    // loud" before emitting the JSON-only output we asked for. Forward scan
    // from the first `{` (preamble has no braces) recovers the payload.
    const minimax =
      'Now I have all the inputs. Let me evaluate the three gates:\n\n' +
      '**Gate A — Direction alignment**: aligned\n' +
      '**Gate B — Scope**: focused\n' +
      '**Gate C — Template**: partial\n\n' +
      '{"verdict":"review","direction_alignment":"aligned","scope_assessment":"focused","template_quality":"partial"}';
    expect(tryParseStructuredOutput(minimax)).toEqual({
      verdict: 'review',
      direction_alignment: 'aligned',
      scope_assessment: 'focused',
      template_quality: 'partial',
    });
  });

  test('parses preamble + trailing nested JSON via forward scan', () => {
    // Forward scan lands on the outer `{` and JSON.parse handles the nesting.
    const nested =
      'Reasoning before the JSON.\n' + '{"verdict":"review","details":{"foo":1,"bar":[1,2,3]}}';
    expect(tryParseStructuredOutput(nested)).toEqual({
      verdict: 'review',
      details: { foo: 1, bar: [1, 2, 3] },
    });
  });

  test('parses preamble + JSON containing `{` inside a string value', () => {
    // Forward scan lands on the JSON object's outer `{`; JSON.parse handles
    // the in-string `{`. Preamble must not itself contain `{`, otherwise the
    // forward scan would start there and fail.
    const tricky =
      'Brief preamble with no extra braces.\n' + '{"key":"value with { inside","ok":true}';
    expect(tryParseStructuredOutput(tricky)).toEqual({
      key: 'value with { inside',
      ok: true,
    });
  });

  test('returns undefined when prose contains a brace-bearing example after the real JSON', () => {
    // Conservative-failure regression. A backward-scan strategy would silently
    // return the trailing example; forward scan starts at the real payload,
    // JSON.parse rejects the trailing prose+example, and we fail closed.
    const withExample = '{"actual":"value"}\nFor example: {"verdict":"review"}';
    expect(tryParseStructuredOutput(withExample)).toBeUndefined();
  });

  test('returns undefined on malformed JSON', () => {
    expect(tryParseStructuredOutput('{not valid}')).toBeUndefined();
    expect(tryParseStructuredOutput('{"unclosed":')).toBeUndefined();
  });

  test('preserves backticks inside JSON string values', () => {
    // Fence stripper matches only at start/end; inner backticks must survive.
    const withBackticks = '{"code":"run `npm test`"}';
    expect(tryParseStructuredOutput(withBackticks)).toEqual({ code: 'run `npm test`' });
  });
});

// ─── bridgeSession cleanup ─────────────────────────────────────────────────

describe('bridgeSession cleanup', () => {
  // Regression for #1561: when the consumer throws mid-iteration, bridgeSession's
  // finally block calls session.dispose() and used to await the prompt promise
  // for a "settle so callers see no dangling work" guarantee. That guarantee
  // was illusory — the queue is closed before the await, so a settled prompt
  // pushes into a closed queue (no-op). The await only existed to suppress
  // unhandled rejections, and it caused #1561: when Pi's prompt() hung after
  // dispose(), the await blocked forever, the consumer's catch never ran, and
  // Bun drained its event loop and exited with code 0 mid-workflow.
  //
  // The fix is to not await at all — attach a fire-and-forget .catch() so a
  // late rejection doesn't crash the process. Cleanup is non-blocking
  // regardless of whether prompt() settles.
  test('cleanup does not block when session.prompt() hangs forever after dispose()', async () => {
    const neverSettles = new Promise<void>(() => {
      /* intentionally never resolves */
    });
    let listenerRef: ((e: AgentSessionEvent) => void) | undefined;

    const mockSession = {
      sessionId: 'test-session-id',
      prompt: () => neverSettles,
      dispose: () => {
        /* synchronous noop — does NOT settle prompt() */
      },
      subscribe: (l: (e: AgentSessionEvent) => void) => {
        listenerRef = l;
        return () => {
          listenerRef = undefined;
        };
      },
      abort: async () => {
        /* noop */
      },
    } as unknown as AgentSession;

    const gen = bridgeSession(mockSession, 'test prompt');

    // Push an event after the generator subscribes so the for-await unblocks
    // with a chunk. Then the test consumer throws to simulate the dag-executor
    // throwing on `isError: true`.
    queueMicrotask(() => {
      listenerRef?.({
        type: 'tool_execution_start',
        toolName: 'echo',
        toolCallId: 'tc1',
        args: {},
      } as unknown as AgentSessionEvent);
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
    // Cleanup must return immediately — no timer, no waiting on prompt().
    // 200ms is generous for scheduling overhead while still catching any
    // future regression that re-introduces an await on promptPromise.
    expect(elapsed).toBeLessThan(200);
  }, 5_000);

  test('a late prompt() rejection does not become an unhandled rejection', async () => {
    // The .then() handlers in bridgeSession should preclude promptPromise
    // ever rejecting (both fulfillment and rejection paths convert to queue
    // pushes). The fire-and-forget .catch() is belt-and-suspenders in case
    // of a synchronous throw inside the handlers. This test verifies that
    // belt holds: a late rejection doesn't crash the test process.
    let rejectPrompt!: (err: Error) => void;
    let listenerRef: ((e: AgentSessionEvent) => void) | undefined;

    const mockSession = {
      sessionId: 'test-session-id',
      prompt: () =>
        new Promise<void>((_, reject) => {
          rejectPrompt = reject;
        }),
      dispose: () => {
        /* noop */
      },
      subscribe: (l: (e: AgentSessionEvent) => void) => {
        listenerRef = l;
        return () => {
          listenerRef = undefined;
        };
      },
      abort: async () => {},
    } as unknown as AgentSession;

    const gen = bridgeSession(mockSession, 'test prompt');

    queueMicrotask(() => {
      listenerRef?.({
        type: 'tool_execution_start',
        toolName: 'echo',
        toolCallId: 'tc1',
        args: {},
      } as unknown as AgentSessionEvent);
    });

    try {
      for await (const _chunk of gen) {
        throw new Error('simulated consumer abort');
      }
    } catch {}

    // Reject prompt() AFTER cleanup has run. If the .catch() weren't
    // attached, this would propagate as an unhandled rejection. Bun would
    // log it; we can't assert on the absence directly, but the test simply
    // continuing to completion (and not failing the suite) is the assertion.
    rejectPrompt(new Error('late pi error'));
    // Yield to let the microtask queue drain so the .catch() runs.
    await new Promise(resolve => setTimeout(resolve, 10));
  }, 5_000);
});
