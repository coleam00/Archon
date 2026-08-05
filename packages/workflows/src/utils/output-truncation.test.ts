import { describe, test, expect } from 'bun:test';
import { buildTruncationMarker, hasTruncationMarker } from './output-truncation';

describe('buildTruncationMarker', () => {
  test('formats the byte count into the marker', () => {
    expect(buildTruncationMarker(1234)).toBe('\n\n… [truncated; original output was 1234 bytes]');
  });

  test('handles zero bytes', () => {
    expect(buildTruncationMarker(0)).toBe('\n\n… [truncated; original output was 0 bytes]');
  });
});

describe('hasTruncationMarker', () => {
  test('returns true for a fresh round-trip with no whitespace', () => {
    const output = `hello${buildTruncationMarker(42)}`;
    expect(hasTruncationMarker(output)).toBe(true);
  });

  test('returns true when a single trailing newline is appended — the regression from #2465', () => {
    // Reproduces the coupling that motivated the .trimEnd() fix: the marker is
    // matched leniently so a future normalisation step that appends a newline
    // does not silently revert to the generic "not a JSON object" error.
    const output = `hello${buildTruncationMarker(42)}\n`;
    expect(hasTruncationMarker(output)).toBe(true);
  });

  test('returns true when several trailing whitespace characters are appended', () => {
    const output = `hello${buildTruncationMarker(42)}\n  \t \n`;
    expect(hasTruncationMarker(output)).toBe(true);
  });

  test('returns false when the marker appears mid-string (anchored match)', () => {
    const output = `${buildTruncationMarker(42)}\nhello`;
    expect(hasTruncationMarker(output)).toBe(false);
  });

  test('returns false when a node merely quotes the phrase in its output', () => {
    const output = 'see the truncation message: [truncated; original output was 9 bytes]';
    expect(hasTruncationMarker(output)).toBe(false);
  });

  test('returns false for plain output with no marker', () => {
    expect(hasTruncationMarker('{"ok":true}')).toBe(false);
  });

  test('returns false for the empty string', () => {
    expect(hasTruncationMarker('')).toBe(false);
  });
});
