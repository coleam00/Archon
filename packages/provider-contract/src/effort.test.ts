import { describe, expect, test } from 'bun:test';
import { EFFORT_LADDER, clampEffort, isEffortRung } from './effort';

// Vocabulary shapes for the generic clamp, not any provider's list: each provider tests its
// own vocabulary in @archon/providers, which this package cannot import.
const FULL = EFFORT_LADDER;
const FROM_LOW = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const FROM_MINIMAL = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const WITHOUT_MAX = ['low', 'medium', 'high', 'xhigh'] as const;

describe('isEffortRung', () => {
  test('accepts every rung on the ladder and nothing else', () => {
    for (const rung of EFFORT_LADDER) expect(isEffortRung(rung)).toBe(true);
    for (const other of ['off', 'extreme', '', 'HIGH', 3, null, undefined, {}]) {
      expect(isEffortRung(other)).toBe(false);
    }
  });
});

describe('clampEffort', () => {
  test('returns a supported rung unchanged', () => {
    for (const rung of FROM_LOW) expect(clampEffort(rung, FROM_LOW)).toBe(rung);
    for (const rung of FULL) expect(clampEffort(rung, FULL)).toBe(rung);
  });

  test('clamps down to the nearest supported rung', () => {
    expect(clampEffort('persistent', FROM_LOW)).toBe('max');
    expect(clampEffort('persistent', FROM_MINIMAL)).toBe('max');
    expect(clampEffort('persistent', WITHOUT_MAX)).toBe('xhigh');
    expect(clampEffort('ultra', FROM_LOW)).toBe('max');
    expect(clampEffort('ultra', FROM_MINIMAL)).toBe('max');
    expect(clampEffort('ultra', WITHOUT_MAX)).toBe('xhigh');
    expect(clampEffort('max', WITHOUT_MAX)).toBe('xhigh');
    expect(clampEffort('max', FROM_MINIMAL)).toBe('max');
  });

  test('clamps up when no weaker rung is supported', () => {
    expect(clampEffort('minimal', FROM_LOW)).toBe('low');
    expect(clampEffort('minimal', WITHOUT_MAX)).toBe('low');
  });

  test('prefers a weaker rung over a stronger one', () => {
    expect(clampEffort('high', ['low', 'xhigh'] as const)).toBe('low');
  });

  test('returns undefined for invalid or unsupported values', () => {
    expect(clampEffort('off', FULL)).toBeUndefined();
    expect(clampEffort('extreme', FROM_LOW)).toBeUndefined();
    expect(clampEffort(undefined, FROM_LOW)).toBeUndefined();
    expect(clampEffort(5, FROM_LOW)).toBeUndefined();
    expect(clampEffort('high', [] as const)).toBeUndefined();
  });

  test('resolves every rung for every vocabulary', () => {
    for (const vocabulary of [FROM_LOW, FULL, FROM_MINIMAL, WITHOUT_MAX]) {
      for (const rung of EFFORT_LADDER) {
        expect(vocabulary as readonly string[]).toContain(clampEffort(rung, vocabulary) as string);
      }
    }
  });
});
