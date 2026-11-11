import { describe, expect, test } from 'bun:test';
import { structuredOutputsEqual } from './stale-dependencies';

describe('structuredOutputsEqual', () => {
  test('ignores object key order, as PostgreSQL JSONB reorders keys', () => {
    const fresh = { delivered: true, reason: 'delivered', pr_url: 'u', summary: 's' };
    const fromJsonb = { pr_url: 'u', reason: 'delivered', summary: 's', delivered: true };
    expect(structuredOutputsEqual(fresh, fromJsonb)).toBe(true);
  });
  test('ignores key order in nested objects inside arrays', () => {
    expect(
      structuredOutputsEqual(
        { a: [{ x: 1, y: { p: 1, q: 2 } }] },
        { a: [{ y: { q: 2, p: 1 }, x: 1 }] }
      )
    ).toBe(true);
  });
  test('still sees a changed value', () => {
    expect(structuredOutputsEqual({ a: 1, b: 2 }, { b: 2, a: 3 })).toBe(false);
  });
  test('preserves an own __proto__ JSON key', () => {
    const prior = JSON.parse('{"__proto__":{"v":1},"ok":true}');
    const reordered = JSON.parse('{"ok":true,"__proto__":{"v":1}}');
    const changed = JSON.parse('{"ok":true,"__proto__":{"v":2}}');
    expect(structuredOutputsEqual(prior, reordered)).toBe(true);
    expect(structuredOutputsEqual(prior, changed)).toBe(false);
  });
  test('array order still matters', () => {
    expect(structuredOutputsEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
  test('absent and null stay distinct', () => {
    expect(structuredOutputsEqual(undefined, null)).toBe(false);
    expect(structuredOutputsEqual(null, null)).toBe(true);
  });
});
