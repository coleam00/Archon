import { describe, test, expect } from 'bun:test';
import { parseAllowedUsers, isGitLabUserAuthorized, verifyWebhookToken } from './auth';

describe('parseAllowedUsers', () => {
  test('returns empty array for undefined', () => {
    expect(parseAllowedUsers(undefined)).toEqual([]);
  });

  test('returns empty array for empty string', () => {
    expect(parseAllowedUsers('')).toEqual([]);
    expect(parseAllowedUsers('   ')).toEqual([]);
  });

  test('parses single user', () => {
    expect(parseAllowedUsers('alice')).toEqual(['alice']);
  });

  test('parses multiple users', () => {
    expect(parseAllowedUsers('alice,bob,charlie')).toEqual(['alice', 'bob', 'charlie']);
  });

  test('trims whitespace and lowercases', () => {
    expect(parseAllowedUsers(' Alice , BOB , Charlie ')).toEqual(['alice', 'bob', 'charlie']);
  });

  test('filters empty segments', () => {
    expect(parseAllowedUsers('alice,,bob,')).toEqual(['alice', 'bob']);
  });
});

describe('isGitLabUserAuthorized', () => {
  test('open access when allowedUsers is empty', () => {
    expect(isGitLabUserAuthorized('anyone', [])).toBe(true);
  });

  test('rejects undefined username with whitelist', () => {
    expect(isGitLabUserAuthorized(undefined, ['alice'])).toBe(false);
  });

  test('rejects empty username with whitelist', () => {
    expect(isGitLabUserAuthorized('', ['alice'])).toBe(false);
  });

  test('authorizes listed user (case-insensitive)', () => {
    expect(isGitLabUserAuthorized('Alice', ['alice', 'bob'])).toBe(true);
    expect(isGitLabUserAuthorized('BOB', ['alice', 'bob'])).toBe(true);
  });

  test('rejects unlisted user', () => {
    expect(isGitLabUserAuthorized('mallory', ['alice', 'bob'])).toBe(false);
  });
});

describe('verifyWebhookToken', () => {
  test('returns true for matching tokens', () => {
    expect(verifyWebhookToken('my-secret', 'my-secret')).toBe(true);
  });

  test('returns false for mismatched tokens', () => {
    expect(verifyWebhookToken('wrong-secret', 'my-secret')).toBe(false);
  });

  test('returns false for different lengths', () => {
    expect(verifyWebhookToken('short', 'much-longer-secret')).toBe(false);
  });

  test('returns false for empty vs non-empty', () => {
    expect(verifyWebhookToken('', 'secret')).toBe(false);
  });

  test('returns false for non-empty received vs empty expected', () => {
    // Guards the !expectedSecret branch added to prevent GITLAB_WEBHOOK_SECRET=""
    // from accepting all incoming requests
    expect(verifyWebhookToken('some-token', '')).toBe(false);
  });

  test('returns false when both tokens are empty', () => {
    // Pre-fix: Buffer.timingSafeEqual(Buffer.from(''), Buffer.from('')) === true
    // because two zero-length buffers are trivially equal — a real auth-bypass
    expect(verifyWebhookToken('', '')).toBe(false);
  });
});
