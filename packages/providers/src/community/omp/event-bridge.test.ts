import { describe, expect, test } from 'bun:test';

import { buildResultChunk, mapOmpEvent, tryParseStructuredOutput } from './event-bridge';

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
  });
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
});

describe('tryParseStructuredOutput', () => {
  test('parses clean, fenced, and preamble JSON', () => {
    expect(tryParseStructuredOutput('{"ok":true}')).toEqual({ ok: true });
    expect(tryParseStructuredOutput('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(tryParseStructuredOutput('done\n{"ok":true}')).toEqual({ ok: true });
  });
});
