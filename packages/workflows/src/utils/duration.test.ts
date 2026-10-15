import { describe, test, expect } from 'bun:test';
import { parseDbTimestamp } from './duration';

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
