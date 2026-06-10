import { describe, expect, test } from 'bun:test';
import { classifyError, FATAL_PATTERNS, TRANSIENT_PATTERNS } from './classify-error';

describe('classifyError (providers)', () => {
  test('classifies 502/503 as TRANSIENT', () => {
    expect(classifyError(new Error('HTTP 502 bad gateway'))).toBe('TRANSIENT');
    expect(classifyError(new Error('503 service unavailable'))).toBe('TRANSIENT');
  });

  test('classifies OMP extension timeout as TRANSIENT', () => {
    expect(classifyError(new Error('Extension error: handler timed out after 10000ms'))).toBe(
      'TRANSIENT'
    );
  });

  test('classifies model-not-found as FATAL', () => {
    expect(classifyError(new Error('OMP model not found: foo/bar'))).toBe('FATAL');
  });

  // Patterns merged from the former @archon/workflows executor-shared copy —
  // this file is now the single classifier for both layers.
  test('classifies claude code crash as TRANSIENT (merged from workflows list)', () => {
    expect(classifyError(new Error('claude code crash detected'))).toBe('TRANSIENT');
  });

  test('classifies 429/529/overloaded as TRANSIENT', () => {
    expect(classifyError(new Error('rate limit: 429 too many requests'))).toBe('TRANSIENT');
    expect(classifyError(new Error('HTTP 529 service overloaded'))).toBe('TRANSIENT');
    expect(classifyError(new Error('Minimax: overloaded, try again later'))).toBe('TRANSIENT');
  });

  test('FATAL takes priority over TRANSIENT when both patterns match', () => {
    expect(classifyError(new Error('unauthorized: exited with code 1'))).toBe('FATAL');
    expect(classifyError(new Error('credit balance too low (503)'))).toBe('FATAL');
  });

  test('classifies no-credentials and invalid-model as FATAL', () => {
    expect(classifyError(new Error("no credentials for provider 'minimax'"))).toBe('FATAL');
    expect(classifyError(new Error('invalid model name'))).toBe('FATAL');
  });

  test('unknown errors classify as UNKNOWN', () => {
    expect(classifyError(new Error('something completely unexpected happened'))).toBe('UNKNOWN');
  });

  test('pattern lists are the merged superset of the former workflows copy', () => {
    // Former workflows-only entries that must survive the merge
    expect(TRANSIENT_PATTERNS).toContain('claude code crash');
    // Former providers-only entries that must survive the merge
    expect(TRANSIENT_PATTERNS).toContain('extension error');
    expect(TRANSIENT_PATTERNS).toContain('handler timed out');
    expect(FATAL_PATTERNS).toContain('model not found');
    expect(FATAL_PATTERNS).toContain('no credentials');
  });
});
