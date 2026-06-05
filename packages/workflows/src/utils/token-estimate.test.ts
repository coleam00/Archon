/**
 * T1 — token estimator + classification / low-value path unit tests.
 * Pure functions, no mocks.
 */
import { describe, test, expect } from 'bun:test';
import { estimateTokens, classifyToolSource, isLowValuePath } from './token-estimate';

describe('estimateTokens', () => {
  test('T1: ~1000 tokens for 4000 chars (chars/4)', () => {
    expect(estimateTokens('x'.repeat(4000))).toBe(1000);
  });

  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('rounds up partial tokens (ceil)', () => {
    expect(estimateTokens('abcde')).toBe(2); // 5/4 = 1.25 → 2
    expect(estimateTokens('a')).toBe(1);
  });

  test('is deterministic', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(estimateTokens(text)).toBe(estimateTokens(text));
    expect(estimateTokens(text)).toBe(Math.ceil(text.length / 4));
  });
});

describe('classifyToolSource', () => {
  test('maps Read and Edit to file-read', () => {
    expect(classifyToolSource('Read')).toBe('file-read');
    expect(classifyToolSource('Edit')).toBe('file-read');
  });

  test('maps Grep to grep', () => {
    expect(classifyToolSource('Grep')).toBe('grep');
  });

  test('maps Bash to bash', () => {
    expect(classifyToolSource('Bash')).toBe('bash');
  });

  test('is case-insensitive and trims', () => {
    expect(classifyToolSource('  read ')).toBe('file-read');
    expect(classifyToolSource('GREP')).toBe('grep');
  });

  test('maps unknown tools to other', () => {
    expect(classifyToolSource('WebFetch')).toBe('other');
    expect(classifyToolSource('')).toBe('other');
  });
});

describe('isLowValuePath', () => {
  test('matches lockfiles', () => {
    expect(isLowValuePath('package-lock.json')).toBe(true);
    expect(isLowValuePath('yarn.lock')).toBe(true);
    expect(isLowValuePath('bun.lockb')).toBe(true);
    expect(isLowValuePath('Cargo.lock')).toBe(true);
    expect(isLowValuePath('poetry.lock')).toBe(true);
  });

  test('matches *-lock.json anywhere', () => {
    expect(isLowValuePath('packages/web/package-lock.json')).toBe(true);
  });

  test('matches generated / dependency directories', () => {
    expect(isLowValuePath('node_modules/react/index.js')).toBe(true);
    expect(isLowValuePath('dist/bundle.js')).toBe(true);
    expect(isLowValuePath('build/output.o')).toBe(true);
    expect(isLowValuePath('coverage/lcov.info')).toBe(true);
  });

  test('tolerates backslash separators (Windows)', () => {
    expect(isLowValuePath('node_modules\\react\\index.js')).toBe(true);
    expect(isLowValuePath('packages\\web\\package-lock.json')).toBe(true);
  });

  test('does not match ordinary source files', () => {
    expect(isLowValuePath('src/auth/login.ts')).toBe(false);
    expect(isLowValuePath('README.md')).toBe(false);
    expect(isLowValuePath('packages/core/src/index.ts')).toBe(false);
    expect(isLowValuePath('')).toBe(false);
  });
});
