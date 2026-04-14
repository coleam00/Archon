import { describe, test, expect } from 'bun:test';
import { formatDuration } from './duration';

describe('formatDuration', () => {
  test('returns "0s" for 0 ms', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  test('rounds sub-second to "1s" so display never reads "0s" for an active run', () => {
    expect(formatDuration(500)).toBe('1s');
    expect(formatDuration(999)).toBe('1s');
  });

  test('formats whole seconds', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(45000)).toBe('45s');
  });

  test('formats minutes with seconds remainder', () => {
    expect(formatDuration(60000)).toBe('1m');
    expect(formatDuration(65000)).toBe('1m 5s');
    expect(formatDuration(125000)).toBe('2m 5s');
  });

  test('formats hours with minutes remainder', () => {
    expect(formatDuration(3600000)).toBe('1h');
    expect(formatDuration(3660000)).toBe('1h 1m');
    expect(formatDuration(7320000)).toBe('2h 2m');
  });

  test('drops seconds at the hour level so display stays compact', () => {
    expect(formatDuration(3661000)).toBe('1h 1m'); // not "1h 1m 1s"
  });

  test('clamps negative values to "0s"', () => {
    expect(formatDuration(-1)).toBe('0s');
    expect(formatDuration(-10000)).toBe('0s');
  });

  test('clamps non-finite values to "0s"', () => {
    expect(formatDuration(NaN)).toBe('0s');
    expect(formatDuration(Infinity)).toBe('0s');
  });
});
