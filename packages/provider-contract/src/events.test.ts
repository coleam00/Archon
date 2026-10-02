import { describe, expect, test } from 'bun:test';
import {
  providerChunkSchema,
  providerEventSchema,
  TOOL_OUTPUT_MAX_CHARS,
  truncateToolOutput,
  type ProviderEvent,
} from './events';

const oneOfEach: ProviderEvent[] = [
  { type: 'agent_message_chunk', text: 'Done.' },
  { type: 'agent_thought_chunk', text: 'Check the tests first.' },
  {
    type: 'tool_call',
    toolCallId: 'toolu_1',
    name: 'Bash',
    title: 'bun test',
    rawInput: { command: 'bun test' },
  },
  {
    type: 'tool_call_update',
    toolCallId: 'toolu_1',
    status: 'failed',
    output: '1 fail',
    exitCode: 1,
  },
  { type: 'warning', code: 'claude.node_config_ignored', message: 'effort is ignored' },
  { type: 'mcp_server_status', server: 'github', status: 'failed', error: 'spawn ENOENT' },
  {
    type: 'compaction',
    phase: 'completed',
    trigger: 'auto',
    tokensBefore: 180000,
    tokensAfter: 4000,
  },
  {
    type: 'subtask',
    taskId: 't1',
    status: 'completed',
    description: 'review',
    summary: 'no findings',
    taskType: 'local_agent',
    parentToolCallId: 'toolu_2',
    lastToolName: 'Read',
    outputFile: '/tmp/t1.out',
    usage: { total_tokens: 10 },
  },
  {
    type: 'hook',
    hookId: 'h1',
    hookName: 'lint',
    hookEvent: 'PostToolUse',
    status: 'succeeded',
    exitCode: 0,
  },
  { type: 'state_update', state: 'requires_action' },
];

describe('provider event vocabulary', () => {
  test.each(oneOfEach.map(event => [event.type, event] as const))(
    '%s parses unchanged',
    (_type, event) => {
      expect(providerEventSchema.parse(event)).toEqual(event);
      expect(providerChunkSchema.parse(event)).toEqual(event);
    }
  );

  test('the chunk union also carries result and settled', () => {
    expect(providerChunkSchema.parse({ type: 'result', sessionId: 's' })).toEqual({
      type: 'result',
      sessionId: 's',
    });
    expect(providerChunkSchema.parse({ type: 'settled' })).toEqual({ type: 'settled' });
    expect(providerEventSchema.safeParse({ type: 'result' }).success).toBe(false);
  });

  test.each<[string, unknown]>([
    ['an empty toolCallId', { type: 'tool_call', toolCallId: '', name: 'Bash' }],
    ['a tool call without an id', { type: 'tool_call', name: 'Bash' }],
    [
      'output over the cap',
      {
        type: 'tool_call_update',
        toolCallId: 'a',
        status: 'completed',
        output: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 1),
      },
    ],
    [
      'an unknown tool status',
      { type: 'tool_call_update', toolCallId: 'a', status: 'in_progress' },
    ],
    ['an unknown subtask status', { type: 'subtask', taskId: 't', status: 'paused' }],
    ['a warning without a code', { type: 'warning', code: '', message: 'm' }],
    ['ACP idle state', { type: 'state_update', state: 'idle' }],
    ['empty text', { type: 'agent_message_chunk', text: '' }],
    ['a retired chunk', { type: 'assistant', content: 'hi' }],
  ])('rejects %s', (_label, chunk) => {
    expect(providerChunkSchema.safeParse(chunk).success).toBe(false);
  });
});

describe('truncateToolOutput', () => {
  test('keeps output at or below the cap and does not flag it', () => {
    const atCap = 'x'.repeat(TOOL_OUTPUT_MAX_CHARS);
    expect(truncateToolOutput(atCap)).toEqual({ output: atCap });
    expect(truncateToolOutput('ok')).toEqual({ output: 'ok' });
  });

  test('cuts output above the cap to the cap and flags it', () => {
    const { output, outputTruncated } = truncateToolOutput('x'.repeat(TOOL_OUTPUT_MAX_CHARS + 5));
    expect(output).toHaveLength(TOOL_OUTPUT_MAX_CHARS);
    expect(outputTruncated).toBe(true);
  });

  test('does not split a surrogate pair at the cut', () => {
    // The emoji's high surrogate is the last code unit the cap would keep.
    const text = `${'x'.repeat(TOOL_OUTPUT_MAX_CHARS - 1)}😀tail`;
    const { output } = truncateToolOutput(text);
    expect(output).toBe('x'.repeat(TOOL_OUTPUT_MAX_CHARS - 1));
  });

  test('its output always parses as a tool_call_update', () => {
    const update = {
      type: 'tool_call_update',
      toolCallId: 'a',
      status: 'completed',
      ...truncateToolOutput('y'.repeat(TOOL_OUTPUT_MAX_CHARS * 2)),
    };
    expect(providerEventSchema.safeParse(update).success).toBe(true);
  });
});
