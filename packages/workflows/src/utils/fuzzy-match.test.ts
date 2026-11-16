import { describe, test, expect } from 'bun:test';
import { levenshtein, findSimilar } from './fuzzy-match';

describe('levenshtein', () => {
  test('identical strings → 0', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  test('single insertion', () => {
    expect(levenshtein('abc', 'abcd')).toBe(1);
  });

  test('single deletion', () => {
    expect(levenshtein('abcd', 'abc')).toBe(1);
  });

  test('single substitution', () => {
    expect(levenshtein('abc', 'axc')).toBe(1);
  });

  test('empty string → length of other', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  test('both empty → 0', () => {
    expect(levenshtein('', '')).toBe(0);
  });

  test('completely different strings', () => {
    expect(levenshtein('abc', 'xyz')).toBe(3);
  });
});

describe('findSimilar', () => {
  test('returns closest candidates within threshold', () => {
    const result = findSimilar('asist', ['assist', 'assign', 'resist', 'totally-different']);
    expect(result).toContain('assist');
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test('excludes exact match (distance = 0)', () => {
    expect(findSimilar('assist', ['assist', 'asist'])).not.toContain('assist');
  });

  test('returns empty array when nothing is close', () => {
    expect(findSimilar('xyz', ['totally-different', 'another-one'])).toEqual([]);
  });

  test('respects explicit maxDistance override', () => {
    const result = findSimilar('a', ['ab', 'abc', 'abcd'], 1);
    expect(result).toEqual(['ab']);
  });

  test('returns at most 3 suggestions', () => {
    const result = findSimilar('test', ['teat', 'tent', 'text', 'best', 'rest']);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test('is case-insensitive for near-matches', () => {
    const result = findSimilar('ASIST', ['assist']);
    expect(result).toContain('assist');
  });
});
