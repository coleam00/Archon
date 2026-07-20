import { describe, test, expect } from 'bun:test';
import {
  elapsedSince,
  ensureUtc,
  formatClock,
  formatRelativeToBaseline,
  relativeTime,
} from './format';

// A fixed instant: 2026-06-13 23:22:53 UTC.
const EPOCH = Date.UTC(2026, 5, 13, 23, 22, 53);
const NAIVE = '2026-06-13 23:22:53'; // SQLite datetime('now') shape — UTC, no suffix
const ZULU = '2026-06-13T23:22:53.000Z'; // toISOString() / Postgres Date-serialized shape

describe('ensureUtc', () => {
  test('tags naive DB timestamps as UTC and swaps the space for T', () => {
    expect(ensureUtc(NAIVE)).toBe('2026-06-13T23:22:53Z');
  });

  test('parses naive timestamps as the correct UTC instant', () => {
    expect(new Date(ensureUtc(NAIVE)).getTime()).toBe(EPOCH);
  });

  test('leaves Z-suffixed timestamps untouched (no double shift)', () => {
    expect(ensureUtc(ZULU)).toBe(ZULU);
    expect(ensureUtc('2026-06-13T23:22:53Z')).toBe('2026-06-13T23:22:53Z');
  });

  test('leaves explicit-offset timestamps untouched', () => {
    expect(ensureUtc('2026-06-13T23:22:53+02:00')).toBe('2026-06-13T23:22:53+02:00');
    expect(ensureUtc('2026-06-13T23:22:53-0500')).toBe('2026-06-13T23:22:53-0500');
  });

  test('handles fractional seconds on naive input', () => {
    expect(new Date(ensureUtc('2026-06-13 23:22:53.500')).getTime()).toBe(EPOCH + 500);
  });
});

describe('formatClock', () => {
  test('renders naive UTC and Z-suffixed forms of the same instant identically', () => {
    // Both must resolve to the same local wall-clock regardless of the host TZ.
    expect(formatClock(NAIVE)).toBe(formatClock(ZULU));
  });
});

describe('relativeTime', () => {
  test('treats naive timestamps as UTC when computing distance', () => {
    expect(relativeTime(NAIVE, EPOCH + 90_000)).toBe('1m ago');
    expect(relativeTime(NAIVE, EPOCH + 2_000)).toBe('just now');
  });

  test('agrees between naive and Z-suffixed forms of the same instant', () => {
    const now = EPOCH + 3600_000 * 5;
    expect(relativeTime(NAIVE, now)).toBe(relativeTime(ZULU, now));
  });
});

describe('elapsedSince', () => {
  test('computes the true delta across mixed naive and Z-suffixed inputs', () => {
    expect(elapsedSince(NAIVE, '2026-06-13T23:23:53.000Z')).toBe(60);
    expect(elapsedSince('2026-06-13T23:22:53.000Z', '2026-06-13 23:24:53')).toBe(120);
  });
});

describe('formatRelativeToBaseline', () => {
  test('offsets correctly with a naive baseline and a Z-suffixed event', () => {
    expect(formatRelativeToBaseline('2026-06-13T23:27:05.000Z', NAIVE)).toBe('+04:12');
  });

  test('offsets correctly when both inputs are naive', () => {
    expect(formatRelativeToBaseline('2026-06-13 23:22:54', NAIVE)).toBe('+00:01');
  });
});
