import { describe, expect, test } from 'bun:test';
import { EFFORT_LADDER, clampEffort, isEffortRung } from './effort';

const CLAUDE = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX = EFFORT_LADDER;
const PI = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const COPILOT = ['low', 'medium', 'high', 'xhigh'] as const;

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
    for (const rung of CLAUDE) expect(clampEffort(rung, CLAUDE)).toBe(rung);
    for (const rung of CODEX) expect(clampEffort(rung, CODEX)).toBe(rung);
  });

  test('clamps down to the nearest supported rung', () => {
    expect(clampEffort('persistent', CLAUDE)).toBe('max');
    expect(clampEffort('persistent', PI)).toBe('max');
    expect(clampEffort('persistent', COPILOT)).toBe('xhigh');
    expect(clampEffort('ultra', CLAUDE)).toBe('max');
    expect(clampEffort('ultra', PI)).toBe('max');
    expect(clampEffort('ultra', COPILOT)).toBe('xhigh');
    expect(clampEffort('max', COPILOT)).toBe('xhigh');
    expect(clampEffort('max', PI)).toBe('max');
  });

  test('clamps up when no weaker rung is supported', () => {
    expect(clampEffort('minimal', CLAUDE)).toBe('low');
    expect(clampEffort('minimal', COPILOT)).toBe('low');
  });

  test('prefers a weaker rung over a stronger one', () => {
    expect(clampEffort('high', ['low', 'xhigh'] as const)).toBe('low');
  });

  test('returns undefined for invalid or unsupported values', () => {
    expect(clampEffort('off', CODEX)).toBeUndefined();
    expect(clampEffort('extreme', CLAUDE)).toBeUndefined();
    expect(clampEffort(undefined, CLAUDE)).toBeUndefined();
    expect(clampEffort(5, CLAUDE)).toBeUndefined();
    expect(clampEffort('high', [] as const)).toBeUndefined();
  });

  test('resolves every rung for every provider vocabulary', () => {
    for (const vocabulary of [CLAUDE, CODEX, PI, COPILOT]) {
      for (const rung of EFFORT_LADDER) {
        expect(vocabulary as readonly string[]).toContain(clampEffort(rung, vocabulary) as string);
      }
    }
  });
});
