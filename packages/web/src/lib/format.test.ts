import { describe, test, expect } from 'bun:test';
import { ensureUtc, formatDuration, formatDurationMs, formatStarted } from './format';

describe('ensureUtc', () => {
  test('returns timestamp unchanged when it already ends with Z', () => {
    expect(ensureUtc('2024-03-10T14:30:00Z')).toBe('2024-03-10T14:30:00Z');
  });

  test('appends Z when timestamp does not end with Z', () => {
    expect(ensureUtc('2024-03-10T14:30:00')).toBe('2024-03-10T14:30:00Z');
  });

  test('returns Z for empty string', () => {
    expect(ensureUtc('')).toBe('Z');
  });

  test('does not double-append Z', () => {
    const ts = '2024-03-10T14:30:00.000Z';
    expect(ensureUtc(ts)).toBe('2024-03-10T14:30:00.000Z');
  });

  test('appends Z to timestamp with milliseconds but no Z', () => {
    expect(ensureUtc('2024-03-10T14:30:00.123')).toBe('2024-03-10T14:30:00.123Z');
  });
});

describe('formatDuration', () => {
  test('returns milliseconds when duration is under 1000ms', () => {
    const start = '2024-03-10T14:30:00.000Z';
    const end = '2024-03-10T14:30:00.500Z';
    expect(formatDuration(start, end)).toBe('500ms');
  });

  test('returns milliseconds for exactly 0ms', () => {
    const ts = '2024-03-10T14:30:00.000Z';
    expect(formatDuration(ts, ts)).toBe('0ms');
  });

  test('returns milliseconds for 999ms (boundary below 1s)', () => {
    const start = '2024-03-10T14:30:00.000Z';
    const end = '2024-03-10T14:30:00.999Z';
    expect(formatDuration(start, end)).toBe('999ms');
  });

  test('returns seconds for exactly 1000ms', () => {
    const start = '2024-03-10T14:30:00.000Z';
    const end = '2024-03-10T14:30:01.000Z';
    expect(formatDuration(start, end)).toBe('1.0s');
  });

  test('returns seconds for 1-60s range', () => {
    const start = '2024-03-10T14:30:00.000Z';
    const end = '2024-03-10T14:30:30.000Z';
    expect(formatDuration(start, end)).toBe('30.0s');
  });

  test('returns seconds for 59.999s (boundary below 1 minute)', () => {
    const start = '2024-03-10T14:30:00.000Z';
    const end = '2024-03-10T14:30:59.999Z';
    expect(formatDuration(start, end)).toBe('60.0s');
  });

  test('returns minutes for exactly 60000ms', () => {
    const start = '2024-03-10T14:30:00.000Z';
    const end = '2024-03-10T14:31:00.000Z';
    expect(formatDuration(start, end)).toBe('1.0m');
  });

  test('returns minutes for durations over 60s', () => {
    const start = '2024-03-10T14:30:00.000Z';
    const end = '2024-03-10T14:32:30.000Z';
    expect(formatDuration(start, end)).toBe('2.5m');
  });

  test('uses Date.now() when completedAt is null', () => {
    // Use a start far enough in the past that the result is at least 1s
    const start = new Date(Date.now() - 5000).toISOString();
    const result = formatDuration(start, null);
    // Should be at least 5s and expressed in seconds or minutes, not ms
    expect(result).not.toMatch(/ms$/);
    expect(result).toMatch(/^[0-9.]+[sm]$/);
  });

  test('handles timestamps without Z suffix (non-UTC format)', () => {
    // ensureUtc is called internally, so these are treated as UTC
    const start = '2024-03-10T14:30:00';
    const end = '2024-03-10T14:30:02';
    expect(formatDuration(start, end)).toBe('2.0s');
  });

  test('returns fractional seconds with one decimal place', () => {
    const start = '2024-03-10T14:30:00.000Z';
    const end = '2024-03-10T14:30:01.500Z';
    expect(formatDuration(start, end)).toBe('1.5s');
  });
});

describe('formatStarted', () => {
  test('returns a non-empty locale string for a valid UTC timestamp', () => {
    const result = formatStarted('2024-03-10T14:30:00.000Z');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('returns a locale string for a non-UTC timestamp (Z is appended)', () => {
    const result = formatStarted('2024-03-10T14:30:00');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('formats two different times differently', () => {
    const morning = formatStarted('2024-03-10T09:00:00.000Z');
    const evening = formatStarted('2024-03-10T21:00:00.000Z');
    expect(morning).not.toBe(evening);
  });

  test('formats two different dates differently', () => {
    const day1 = formatStarted('2024-03-10T14:30:00.000Z');
    const day2 = formatStarted('2024-03-11T14:30:00.000Z');
    expect(day1).not.toBe(day2);
  });
});

describe('formatDurationMs', () => {
  test('returns ms for 0', () => {
    expect(formatDurationMs(0)).toBe('0ms');
  });

  test('returns ms for positive value under 1000', () => {
    expect(formatDurationMs(500)).toBe('500ms');
  });

  test('returns ms for 999 (boundary below 1s)', () => {
    expect(formatDurationMs(999)).toBe('999ms');
  });

  test('returns seconds for exactly 1000ms', () => {
    expect(formatDurationMs(1000)).toBe('1.0s');
  });

  test('returns seconds for mid-range (30s)', () => {
    expect(formatDurationMs(30000)).toBe('30.0s');
  });

  test('returns seconds for 59999ms (boundary below 1 minute)', () => {
    expect(formatDurationMs(59999)).toBe('60.0s');
  });

  test('returns minutes for exactly 60000ms', () => {
    expect(formatDurationMs(60000)).toBe('1.0m');
  });

  test('returns minutes for 90000ms (1.5 minutes)', () => {
    expect(formatDurationMs(90000)).toBe('1.5m');
  });

  test('returns minutes for large values', () => {
    expect(formatDurationMs(600000)).toBe('10.0m');
  });

  test('one decimal place for seconds', () => {
    expect(formatDurationMs(1500)).toBe('1.5s');
  });

  test('one decimal place for minutes', () => {
    expect(formatDurationMs(75000)).toBe('1.3m');
  });
});
