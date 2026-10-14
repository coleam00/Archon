import { describe, test, expect } from 'bun:test';
import { formatDuration } from './duration';

describe('formatDuration', () => {
  test.each([
    [0, '0ms'],
    [500, '500ms'],
    [999, '999ms'],
    [1000, '1s'],
    [1500, '1.5s'],
    [45000, '45s'],
    [60000, '1m0s'],
    [90000, '1m30s'],
    [3661000, '61m1s'],
    [-1, '0s'],
    [NaN, '0s'],
    [Infinity, '0s'],
  ])('formats %s milliseconds as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
