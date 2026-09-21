import { describe, expect, it } from 'bun:test';
import { toHydratedTimestamp } from './timestamps';

describe('toHydratedTimestamp', () => {
  it("re-anchors SQLite's zone-less datetime('now') text to UTC", () => {
    expect(toHydratedTimestamp('2026-03-08 01:30:00').toISOString()).toBe(
      '2026-03-08T01:30:00.000Z'
    );
  });

  it('keeps the offset of an already-zoned string', () => {
    expect(toHydratedTimestamp('2026-03-08T07:00:00+05:30').toISOString()).toBe(
      '2026-03-08T01:30:00.000Z'
    );
    expect(toHydratedTimestamp('2026-03-08T01:30:00.000Z').toISOString()).toBe(
      '2026-03-08T01:30:00.000Z'
    );
  });

  it('passes a Date through unchanged so PostgreSQL rows need no dialect branch', () => {
    const date = new Date('2026-03-08T01:30:00.000Z');
    expect(toHydratedTimestamp(date)).toBe(date);
  });
});
