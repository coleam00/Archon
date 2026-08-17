import { describe, expect, it } from 'bun:test';
import { levenshtein, nearestNames } from './profile-matcher';

describe('levenshtein', () => {
  it('returns 0 for equal strings', () => {
    expect(levenshtein('Poe', 'Poe')).toBe(0);
    expect(levenshtein('', '')).toBe(0);
  });

  it('returns the input length for comparing against empty string', () => {
    expect(levenshtein('Aider', '')).toBe(5);
    expect(levenshtein('', 'Aider')).toBe(5);
  });

  it('case mismatch counts as one substitution per character', () => {
    expect(levenshtein('Aider', 'aider')).toBe(1);
    expect(levenshtein('POE', 'poe')).toBe(3);
  });

  it('single-character drop counts as one deletion', () => {
    expect(levenshtein('Power Tools', 'Power')).toBe(6);
  });

  it('short prefixing differences', () => {
    expect(levenshtein('Poe', 'Po')).toBe(1);
  });

  it('handles unicode-ish substitutions', () => {
    expect(levenshtein('naïve', 'naive')).toBe(1);
  });
});

describe('nearestNames', () => {
  const CATALOG = ['Poe', 'Aider', 'Codenomicron', 'Inspector', 'Aider with Power Search'];

  it('returns empty for empty target', () => {
    expect(nearestNames('', CATALOG)).toEqual([]);
  });

  it('returns empty for empty catalog', () => {
    expect(nearestNames('Power', [])).toEqual([]);
  });

  it('matches a near miss within Levenshtein <= 2', () => {
    expect(nearestNames('Cod', CATALOG)).toContain('Codenomicron');
  });

  it('short prefix matches via substring rule + tiebreaker sorts alphabetically', () => {
    // 'Po' is a substring of 'Poe' AND of 'Aider with Power Search' (via the
    // 'Power' word) → both candidates match. effectiveDistance is bounded to
    // 1 by the substring rule; ties break alphabetically.
    const suggestions = nearestNames('Po', CATALOG);
    expect(suggestions).toEqual(['Aider with Power Search', 'Poe']);
  });

  it('exact-match input returns empty (never suggest an already-correct name)', () => {
    expect(nearestNames('Poe', CATALOG)).toEqual([]);
  });

  it('caps the result at 5 candidates', () => {
    const bigCatalog = Array.from({ length: 20 }, (_, i) => `Poe${i}`);
    const result = nearestNames('Po', bigCatalog);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('orders by ascending distance, then alphabetical name', () => {
    // 'Poa' is distance 1 from 'Poe' and 2 from 'Aider'. So 'Poe' should come first.
    const result = nearestNames('Poa', CATALOG);
    expect(result[0]).toBe('Poe');
  });
});
