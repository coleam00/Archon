/**
 * Unit tests for Jira auth utilities (pure functions — no module mocks).
 */
import { describe, test, expect } from 'bun:test';
import { parseJiraAllowedUsers, isJiraUserAuthorized, timingSafeCompareSecret } from './auth';

describe('parseJiraAllowedUsers', () => {
  test('returns empty array for undefined/empty', () => {
    expect(parseJiraAllowedUsers(undefined)).toEqual([]);
    expect(parseJiraAllowedUsers('')).toEqual([]);
    expect(parseJiraAllowedUsers('   ')).toEqual([]);
  });

  test('splits, trims, and lowercases entries', () => {
    expect(parseJiraAllowedUsers('  User@Example.com , Acc123 ')).toEqual([
      'user@example.com',
      'acc123',
    ]);
  });

  test('drops empty entries', () => {
    expect(parseJiraAllowedUsers('a,,b,')).toEqual(['a', 'b']);
  });
});

describe('isJiraUserAuthorized', () => {
  test('open access when allowlist empty', () => {
    expect(isJiraUserAuthorized({ accountId: 'x' }, [])).toBe(true);
    expect(isJiraUserAuthorized({}, [])).toBe(true);
  });

  test('authorizes by accountId (case-insensitive)', () => {
    expect(isJiraUserAuthorized({ accountId: 'ABC123' }, ['abc123'])).toBe(true);
  });

  test('authorizes by email (case-insensitive)', () => {
    expect(isJiraUserAuthorized({ email: 'Dev@Example.com' }, ['dev@example.com'])).toBe(true);
  });

  test('denies when neither matches', () => {
    expect(isJiraUserAuthorized({ accountId: 'x', email: 'y@z.com' }, ['other'])).toBe(false);
  });

  test('denies when identity missing but allowlist set', () => {
    expect(isJiraUserAuthorized({}, ['someone'])).toBe(false);
  });
});

describe('timingSafeCompareSecret', () => {
  test('returns true for equal secrets', () => {
    expect(timingSafeCompareSecret('s3cret', 's3cret')).toBe(true);
  });

  test('returns false for unequal secrets of equal length', () => {
    expect(timingSafeCompareSecret('aaaaaa', 'bbbbbb')).toBe(false);
  });

  test('returns false on length mismatch', () => {
    expect(timingSafeCompareSecret('short', 'longer-secret')).toBe(false);
  });

  test('returns false when either side missing', () => {
    expect(timingSafeCompareSecret(undefined, 'x')).toBe(false);
    expect(timingSafeCompareSecret('x', undefined)).toBe(false);
    expect(timingSafeCompareSecret(undefined, undefined)).toBe(false);
  });
});
