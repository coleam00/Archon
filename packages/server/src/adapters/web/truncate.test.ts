import { describe, test, expect } from 'bun:test';
import { truncateToolOutput, MAX_TOOL_OUTPUT_CHARS } from './truncate';

describe('truncateToolOutput', () => {
  test('returns empty string unchanged', () => {
    expect(truncateToolOutput('')).toBe('');
  });

  test('returns output at exactly the cap unchanged', () => {
    const atCap = 'a'.repeat(MAX_TOOL_OUTPUT_CHARS);
    expect(truncateToolOutput(atCap)).toBe(atCap);
  });

  test('truncates output one byte over the cap', () => {
    const overCap = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1);
    const result = truncateToolOutput(overCap);
    expect(result.startsWith('x'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
    expect(result).toContain('[truncated');
    expect(result).toContain('full output preserved in run history');
  });

  test('truncates large output and embeds KB sizes in the marker', () => {
    const large = 'y'.repeat(MAX_TOOL_OUTPUT_CHARS + 200_000);
    const result = truncateToolOutput(large);
    expect(result.length).toBeLessThan(large.length);
    expect(result.startsWith('y'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
    // Marker must contain KB numbers so users know how much was cut
    expect(result).toMatch(/\d+ KB of \d+ KB total/);
    expect(result).toContain('full output preserved in run history');
  });

  test('does not modify output shorter than the cap', () => {
    const short = 'hello world\nline two';
    expect(truncateToolOutput(short)).toBe(short);
  });
});
