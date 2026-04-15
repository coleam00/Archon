import { describe, test, expect } from 'bun:test';
import { formatDuration, parseDbTimestamp } from './duration';

describe('formatDuration', () => {
  test('rounds 0ms up to "1s" — a run that just started should not display "0s"', () => {
    // 0ms in practice means started_at and now are in the same DB second.
    // Display should show "1s" (active, just started), not the misleading "0s".
    expect(formatDuration(0)).toBe('1s');
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

describe('parseDbTimestamp', () => {
  test('returns Date.getTime() unchanged for Date inputs (PG driver path)', () => {
    const date = new Date('2026-04-14T10:00:00.000Z');
    expect(parseDbTimestamp(date)).toBe(date.getTime());
  });

  test('treats SQLite "YYYY-MM-DD HH:MM:SS" as UTC, not local', () => {
    // Reproduces the live bug — SQLite returns datetimes without `Z`,
    // and `new Date('2026-04-14 10:00:00')` parses as local time, making
    // the duration display hours off depending on the user's TZ.
    const sqliteFormat = '2026-04-14 10:00:00';
    expect(parseDbTimestamp(sqliteFormat)).toBe(new Date('2026-04-14T10:00:00Z').getTime());
  });

  test('respects explicit Z suffix (ISO UTC)', () => {
    expect(parseDbTimestamp('2026-04-14T10:00:00.000Z')).toBe(
      new Date('2026-04-14T10:00:00Z').getTime()
    );
  });

  test('respects explicit timezone offset (+/-HH:MM)', () => {
    // 10:00 UTC = 12:00+02:00
    expect(parseDbTimestamp('2026-04-14T12:00:00+02:00')).toBe(
      new Date('2026-04-14T10:00:00Z').getTime()
    );
  });
});
