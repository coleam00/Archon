import { describe, expect, test } from 'bun:test';

import {
  bridgeSession,
  buildResultChunk,
  mapOmpEvent,
  tryParseStructuredOutput,
} from './event-bridge';
import type { OmpSession } from './sdk-loader';

describe('mapOmpEvent', () => {
  test('maps text and thinking deltas', () => {
    expect(
      mapOmpEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'hi' },
      })
    ).toEqual([{ type: 'assistant', content: 'hi' }]);
    expect(
      mapOmpEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' },
      })
    ).toEqual([{ type: 'thinking', content: 'thinking' }]);
  });

  test('maps tool start and end', () => {
    expect(
      mapOmpEvent({
        type: 'tool_execution_start',
        toolName: 'read',
        args: { path: 'a' },
        toolCallId: '1',
      })
    ).toEqual([{ type: 'tool', toolName: 'read', toolInput: { path: 'a' }, toolCallId: '1' }]);
    expect(
      mapOmpEvent({ type: 'tool_execution_end', toolName: 'read', result: 'ok', toolCallId: '1' })
    ).toEqual([{ type: 'tool_result', toolName: 'read', toolOutput: 'ok', toolCallId: '1' }]);
    expect(mapOmpEvent({ type: 'tool_execution_end', toolName: 'read', toolCallId: '2' })).toEqual([
      { type: 'tool_result', toolName: 'read', toolOutput: 'undefined', toolCallId: '2' },
    ]);
  });
});

test('maps retry fallback and compaction events', () => {
  expect(
    mapOmpEvent({
      type: 'retry_fallback_applied',
      from: 'anthropic/old',
      to: 'anthropic/new',
      role: 'default',
    })
  ).toEqual([
    {
      type: 'system',
      content: '⚠️ OMP retry fallback applied for default: anthropic/old → anthropic/new',
    },
  ]);

  expect(
    mapOmpEvent({ type: 'retry_fallback_succeeded', model: 'anthropic/new', role: 'default' })
  ).toEqual([
    {
      type: 'system',
      content: '✓ OMP retry fallback succeeded for default: anthropic/new',
    },
  ]);

  expect(
    mapOmpEvent({ type: 'auto_compaction_start', reason: 'threshold', action: 'context-full' })
  ).toEqual([
    {
      type: 'system',
      content: '⚠️ OMP auto-compaction started (threshold, context-full).',
    },
  ]);

  expect(
    mapOmpEvent({ type: 'auto_compaction_end', action: 'context-full', aborted: false })
  ).toEqual([
    {
      type: 'system',
      content: '✓ OMP auto-compaction completed (context-full).',
    },
  ]);
});

test('maps retry end and ignores skipped compaction', () => {
  expect(
    mapOmpEvent({ type: 'auto_retry_end', success: false, attempt: 2, finalError: 'rate limit' })
  ).toEqual([
    {
      type: 'system',
      content: '⚠️ retry 2 failed: rate limit',
    },
  ]);
  expect(mapOmpEvent({ type: 'auto_compaction_end', skipped: true })).toEqual([]);
});

describe('buildResultChunk', () => {
  test('extracts usage and stop reason', () => {
    expect(
      buildResultChunk([
        {
          role: 'assistant',
          usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.01 } },
          stopReason: 'end_turn',
        },
      ])
    ).toEqual({
      type: 'result',
      tokens: { input: 1, output: 2, total: 3, cost: 0.01 },
      cost: 0.01,
      stopReason: 'end_turn',
    });
  });

  test('surfaces SDK error messages for error result chunks', () => {
    expect(
      buildResultChunk([
        {
          role: 'assistant',
          usage: { input: 1, output: 2 },
          stopReason: 'error',
          errorMessage: 'rate limit exceeded',
        },
      ])
    ).toEqual({
      type: 'result',
      tokens: { input: 1, output: 2 },
      stopReason: 'error',
      isError: true,
      errorSubtype: 'error',
      errors: ['rate limit exceeded'],
    });
  });
});

describe('tryParseStructuredOutput', () => {
  test('parses clean, fenced, and preamble JSON', () => {
    expect(tryParseStructuredOutput('{"ok":true}')).toEqual({ ok: true });
    expect(tryParseStructuredOutput('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(tryParseStructuredOutput('done\n{"ok":true}')).toEqual({ ok: true });
  });

  test('parses preamble-prefixed JSON arrays', () => {
    expect(tryParseStructuredOutput('done\n[\"a\",\"b\"]')).toEqual(['a', 'b']);
  });
});

describe('bridgeSession', () => {
  test('waits for terminal result after prompt resolves', async () => {
    let listener: ((event: unknown) => void) | undefined;
    let releaseAgentEnd: (() => void) | undefined;
    const agentEndReleased = new Promise<void>(resolve => {
      releaseAgentEnd = resolve;
    });
    const session: OmpSession = {
      sessionId: 'sess-late',
      subscribe(fn) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        listener?.({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: '{"ok":true}' },
        });
        queueMicrotask(() => {
          releaseAgentEnd?.();
          listener?.({
            type: 'agent_end',
            messages: [
              { role: 'assistant', usage: { input: 1, output: 1 }, stopReason: 'end_turn' },
            ],
          });
        });
      },
      async abort() {
        return undefined;
      },
      dispose() {
        return undefined;
      },
    };

    const chunks: unknown[] = [];
    for await (const chunk of bridgeSession(session, 'hi', undefined, { type: 'object' })) {
      chunks.push(chunk);
    }
    await agentEndReleased;

    expect(chunks.at(-1)).toEqual({
      type: 'result',
      tokens: { input: 1, output: 1 },
      stopReason: 'end_turn',
      sessionId: 'sess-late',
      structuredOutput: { ok: true },
    });
  });

  test('emits an error result when prompt resolves without a terminal event', async () => {
    const session: OmpSession = {
      subscribe() {
        return () => undefined;
      },
      async prompt() {
        return undefined;
      },
      async abort() {
        return undefined;
      },
      dispose() {
        return undefined;
      },
    };

    const chunks: unknown[] = [];
    for await (const chunk of bridgeSession(session, 'hi')) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'result', isError: true, errorSubtype: 'missing_terminal_result' },
    ]);
  });
  test('cleans up session state when subscribe throws during setup', async () => {
    let disposed = false;
    const emitterStates: Array<unknown> = [];
    const session: OmpSession = {
      subscribe() {
        throw new Error('subscribe failed');
      },
      async prompt() {
        return undefined;
      },
      async abort() {
        return undefined;
      },
      dispose() {
        disposed = true;
      },
    };
    const uiBridge = {
      setEmitter(fn: unknown) {
        emitterStates.push(fn);
      },
    };

    await expect(async () => {
      for await (const _chunk of bridgeSession(session, 'hi', undefined, undefined, uiBridge)) {
        // consume
      }
    }).toThrow('subscribe failed');

    expect(disposed).toBe(true);
    expect(emitterStates).toHaveLength(2);
    expect(typeof emitterStates.at(0)).toBe('function');
    expect(emitterStates.at(1)).toBeUndefined();
  });

  test('cleans up session state when prompt throws before returning a promise', async () => {
    let disposed = false;
    let unsubscribed = false;
    const session: OmpSession = {
      subscribe() {
        return () => {
          unsubscribed = true;
        };
      },
      prompt(): Promise<unknown> {
        throw new Error('prompt setup failed');
      },
      async abort() {
        return undefined;
      },
      dispose() {
        disposed = true;
      },
    };

    await expect(async () => {
      for await (const _chunk of bridgeSession(session, 'hi')) {
        // consume
      }
    }).toThrow('prompt setup failed');

    expect(unsubscribed).toBe(true);
    expect(disposed).toBe(true);
  });
});
