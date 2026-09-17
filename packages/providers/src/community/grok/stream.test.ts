import { describe, expect, test } from 'bun:test';
import { parseGrokOutput, parseGrokStreamingLine } from './stream';

describe('parseGrokStreamingLine', () => {
  test('maps text to assistant', () => {
    expect(parseGrokStreamingLine('{"type":"text","data":"hello"}')).toEqual({
      type: 'assistant',
      content: 'hello',
    });
  });

  test('maps thought to thinking', () => {
    expect(parseGrokStreamingLine('{"type":"thought","data":"hmm"}')).toEqual({
      type: 'thinking',
      content: 'hmm',
    });
  });

  test('maps tool_call', () => {
    expect(
      parseGrokStreamingLine(
        '{"type":"tool_call","toolCallId":"c1","toolName":"read_file","rawInput":{"path":"a.ts"}}'
      )
    ).toEqual({
      type: 'tool',
      toolName: 'read_file',
      toolCallId: 'c1',
      toolInput: { path: 'a.ts' },
    });
  });

  test('maps tool_call_update completed', () => {
    expect(
      parseGrokStreamingLine(
        '{"type":"tool_call_update","toolCallId":"c1","toolName":"read_file","status":"completed","rawOutput":{"lines":2}}'
      )
    ).toEqual({
      type: 'tool_result',
      toolName: 'read_file',
      toolCallId: 'c1',
      toolOutput: '{"lines":2}',
      toolOutcome: 'success',
    });
  });

  test('maps end with session and tokens', () => {
    expect(
      parseGrokStreamingLine(
        '{"type":"end","sessionId":"11111111-1111-4111-8111-111111111111","stopReason":"end_turn","num_turns":2,"usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":3}}'
      )
    ).toEqual({
      type: 'result',
      sessionId: '11111111-1111-4111-8111-111111111111',
      stopReason: 'end_turn',
      numTurns: 2,
      tokens: { input: 10, output: 4, cacheRead: 3 },
    });
  });

  test('maps error', () => {
    expect(parseGrokStreamingLine('{"type":"error","message":"nope"}')).toEqual({
      type: 'result',
      isError: true,
      errors: ['nope'],
    });
  });

  test('ignores unknown types', () => {
    expect(parseGrokStreamingLine('{"type":"plan","entries":[]}')).toBeUndefined();
  });

  test('throws on invalid json', () => {
    expect(() => parseGrokStreamingLine('{')).toThrow('grok_stream_json_invalid');
  });

  test('blank lines are ignored', () => {
    expect(parseGrokStreamingLine('  ')).toBeUndefined();
  });
});

describe('parseGrokOutput json document fallback', () => {
  test('splits a json-format object into assistant + result', () => {
    expect(
      parseGrokOutput(
        '{"text":"ok","sessionId":"11111111-1111-4111-8111-111111111111","stopReason":"end_turn"}'
      )
    ).toEqual([
      { type: 'assistant', content: 'ok' },
      {
        type: 'result',
        sessionId: '11111111-1111-4111-8111-111111111111',
        stopReason: 'end_turn',
      },
    ]);
  });
});
