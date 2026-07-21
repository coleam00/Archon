import { describe, test, expect } from 'bun:test';
import { truncateToolOutput, boundMetadataToolOutputs, MAX_TOOL_OUTPUT_CHARS } from './truncate';

describe('truncateToolOutput', () => {
  test('returns empty string unchanged', () => {
    expect(truncateToolOutput('')).toBe('');
  });

  test('returns output shorter than the cap unchanged', () => {
    const short = 'hello world\nline two';
    expect(truncateToolOutput(short)).toBe(short);
  });

  test('returns output at exactly the cap unchanged', () => {
    const atCap = 'a'.repeat(MAX_TOOL_OUTPUT_CHARS);
    expect(truncateToolOutput(atCap)).toBe(atCap);
  });

  test('truncates output one char over the cap', () => {
    const overCap = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1);
    const result = truncateToolOutput(overCap);
    expect(result.startsWith('x'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
    expect(result).toContain('[truncated');
    expect(result).toContain('full output preserved on the server');
  });

  test('truncates large output and embeds KB sizes in the marker', () => {
    const large = 'y'.repeat(MAX_TOOL_OUTPUT_CHARS + 200_000);
    const result = truncateToolOutput(large);
    expect(result.length).toBeLessThan(large.length);
    expect(result.startsWith('y'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
    // Marker must contain KB numbers so users know how much was cut
    expect(result).toMatch(/\d+ KB of \d+ KB total/);
  });
});

describe('boundMetadataToolOutputs', () => {
  test('truncates oversized tool outputs in toolCalls', () => {
    const large = 'z'.repeat(MAX_TOOL_OUTPUT_CHARS + 10_000);
    const meta = JSON.stringify({
      toolCalls: [{ name: 'bash', input: { command: 'cat big.txt' }, output: large, duration: 5 }],
    });
    const bounded = JSON.parse(boundMetadataToolOutputs(meta)) as {
      toolCalls: Array<{ name: string; output: string; duration: number }>;
    };
    expect(bounded.toolCalls[0]!.output.length).toBeLessThan(large.length);
    expect(bounded.toolCalls[0]!.output).toContain('[truncated');
    // Sibling fields on the tool call survive
    expect(bounded.toolCalls[0]!.name).toBe('bash');
    expect(bounded.toolCalls[0]!.duration).toBe(5);
  });

  test('truncates only the oversized output in a mixed toolCalls array', () => {
    const large = 'q'.repeat(MAX_TOOL_OUTPUT_CHARS + 1);
    const meta = JSON.stringify({
      toolCalls: [
        { name: 'read', output: 'small' },
        { name: 'bash', output: large },
      ],
    });
    const bounded = JSON.parse(boundMetadataToolOutputs(meta)) as {
      toolCalls: Array<{ output: string }>;
    };
    expect(bounded.toolCalls[0]!.output).toBe('small');
    expect(bounded.toolCalls[1]!.output).toContain('[truncated');
  });

  test('preserves non-toolCall metadata fields alongside truncated outputs', () => {
    const large = 'w'.repeat(MAX_TOOL_OUTPUT_CHARS + 1);
    const meta = JSON.stringify({
      toolCalls: [{ name: 'bash', output: large }],
      workflowDispatch: { workflowName: 'implement', workerConversationId: 'wc-1' },
    });
    const bounded = JSON.parse(boundMetadataToolOutputs(meta)) as {
      workflowDispatch: { workflowName: string; workerConversationId: string };
    };
    expect(bounded.workflowDispatch).toEqual({
      workflowName: 'implement',
      workerConversationId: 'wc-1',
    });
  });

  test('returns metadata without toolCalls byte-for-byte unchanged', () => {
    const meta = JSON.stringify({ workflowResult: { runId: 'abc', status: 'completed' } });
    expect(boundMetadataToolOutputs(meta)).toBe(meta);
  });

  test('returns metadata with all outputs within the cap byte-for-byte unchanged', () => {
    const meta = JSON.stringify({
      toolCalls: [{ name: 'bash', output: 'ok' }, { name: 'read' }],
    });
    expect(boundMetadataToolOutputs(meta)).toBe(meta);
  });

  test('returns invalid JSON unchanged', () => {
    expect(boundMetadataToolOutputs('not json {')).toBe('not json {');
  });

  test('returns JSON null / non-object values unchanged', () => {
    expect(boundMetadataToolOutputs('null')).toBe('null');
    expect(boundMetadataToolOutputs('"a string"')).toBe('"a string"');
  });

  test('leaves non-object and outputless entries in toolCalls untouched', () => {
    const meta = JSON.stringify({ toolCalls: [null, 'weird', { name: 'bash' }] });
    expect(boundMetadataToolOutputs(meta)).toBe(meta);
  });
});
