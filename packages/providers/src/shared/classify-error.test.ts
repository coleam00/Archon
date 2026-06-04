import { describe, expect, test } from 'bun:test';
import { classifyError } from './classify-error';

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
});
