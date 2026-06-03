/**
 * Unit tests for scripts/migrate-coerce.ts.
 *
 * Run with: `bun test scripts/migrate-coerce.test.ts`
 *
 * These are pure-function tests; no DB, no mocks. The goal is to lock in
 * the exact contract the migration driver depends on, since the live
 * SQLite data has both 32-char hex IDs and 36-char canonical UUIDs
 * distributed across the 9 application tables.
 */
import { describe, test, expect } from 'bun:test';
import { transformId, coerceBoolean, coerceJson, coerceTimestamp } from './migrate-coerce';

describe('transformId', () => {
  test('converts 32-char hex to canonical 36-char UUID', () => {
    expect(transformId('aabbccddeeff00112233445566778899')).toBe(
      'aabbccdd-eeff-0011-2233-445566778899'
    );
  });

  test('lowercases a 36-char canonical UUID on input', () => {
    expect(transformId('AABBCCDD-EEFF-0011-2233-445566778899')).toBe(
      'aabbccdd-eeff-0011-2233-445566778899'
    );
  });

  test('passes through a 36-char canonical UUID unchanged', () => {
    expect(transformId('aabbccdd-eeff-0011-2233-445566778899')).toBe(
      'aabbccdd-eeff-0011-2233-445566778899'
    );
  });

  test('rejects malformed 32-char input', () => {
    expect(() => transformId('aabbccddeeff0011223344556677889z')).toThrow(/malformed 32-char/);
  });

  test('rejects malformed 36-char input', () => {
    expect(() => transformId('aabbccddeeff00112233445566778899xxxx')).toThrow(/malformed 36-char/);
  });

  test('rejects non-string input', () => {
    expect(() => transformId(123 as unknown as string)).toThrow(/expected string/);
  });

  test('rejects unexpected length', () => {
    expect(() => transformId('aabb')).toThrow(/unexpected ID length/);
  });
});

describe('coerceBoolean', () => {
  test('1 -> true', () => {
    expect(coerceBoolean(1)).toBe(true);
  });

  test('0 -> false', () => {
    expect(coerceBoolean(0)).toBe(false);
  });

  test('null -> false', () => {
    expect(coerceBoolean(null)).toBe(false);
  });

  test('undefined -> false', () => {
    expect(coerceBoolean(undefined)).toBe(false);
  });

  test('rejects 2', () => {
    expect(() => coerceBoolean(2)).toThrow(RangeError);
  });

  test('rejects -1', () => {
    expect(() => coerceBoolean(-1)).toThrow(RangeError);
  });
});

describe('coerceJson', () => {
  test('string JSON -> parsed object', () => {
    const result = coerceJson('{"a":1}') as { a: number };
    expect(result).toEqual({ a: 1 });
  });

  test('null -> null', () => {
    expect(coerceJson(null)).toBeNull();
  });

  test('empty string -> null', () => {
    expect(coerceJson('')).toBeNull();
  });
  test('object -> identity (defensive)', () => {
    const obj = { x: 'y' };
    const result = coerceJson(obj) as typeof obj;
    expect(result).toBe(obj);
  });

  test('returns null for malformed JSON (tolerant mode for migration)', () => {
    // The migration script's coerceJson is tolerant: it returns null
    // on parse error rather than throwing, so a single bad row doesn't
    // abort the entire 188 MiB cutover. The error is logged to stderr.
    expect(coerceJson('{not json}')).toBeNull();
  });

  test('rejects non-string non-object input', () => {
    expect(() => coerceJson(42 as unknown as string)).toThrow(TypeError);
  });
});

describe('coerceTimestamp', () => {
  test('passes through ISO 8601', () => {
    expect(coerceTimestamp('2026-06-02T10:15:00.000Z')).toBe('2026-06-02T10:15:00.000Z');
  });

  test('passes through SQLite datetime() format', () => {
    expect(coerceTimestamp('2026-06-02 10:15:00')).toBe('2026-06-02 10:15:00');
  });

  test('null -> null', () => {
    expect(coerceTimestamp(null)).toBeNull();
  });

  test('undefined -> null', () => {
    expect(coerceTimestamp(undefined)).toBeNull();
  });

  test('empty string -> null', () => {
    expect(coerceTimestamp('')).toBeNull();
  });

  test('rejects value without year prefix', () => {
    expect(() => coerceTimestamp('hello')).toThrow(/does not start with a year/);
  });

  test('rejects non-string non-null input', () => {
    expect(() => coerceTimestamp(123 as unknown as string)).toThrow(TypeError);
  });
});
