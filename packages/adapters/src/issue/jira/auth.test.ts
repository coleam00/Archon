import { describe, expect, test } from 'bun:test';
import { isJiraUserAuthorized, parseAllowedUsers, verifyWebhookToken } from './auth';

describe('jira-auth', () => {
  describe('parseAllowedUsers', () => {
    test('returns empty array for undefined', () => {
      expect(parseAllowedUsers(undefined)).toEqual([]);
    });

    test('parses and normalizes users', () => {
      expect(parseAllowedUsers(' Alice , user@example.com , abc123 ')).toEqual([
        'alice',
        'user@example.com',
        'abc123',
      ]);
    });
  });

  describe('isJiraUserAuthorized', () => {
    test('allows everyone when whitelist is empty', () => {
      expect(isJiraUserAuthorized({ accountId: 'abc123' }, [])).toBe(true);
    });

    test('matches account id, email, display name, name, or key', () => {
      const user = {
        accountId: 'abc123',
        emailAddress: 'user@example.com',
        displayName: 'Alice',
        name: 'legacy-name',
        key: 'legacy-key',
      };

      expect(isJiraUserAuthorized(user, ['abc123'])).toBe(true);
      expect(isJiraUserAuthorized(user, ['user@example.com'])).toBe(true);
      expect(isJiraUserAuthorized(user, ['alice'])).toBe(true);
      expect(isJiraUserAuthorized(user, ['legacy-name'])).toBe(true);
      expect(isJiraUserAuthorized(user, ['legacy-key'])).toBe(true);
    });

    test('rejects unlisted users in whitelist mode', () => {
      expect(isJiraUserAuthorized({ accountId: 'abc123' }, ['other'])).toBe(false);
    });
  });

  describe('verifyWebhookToken', () => {
    test('accepts matching non-empty tokens', () => {
      expect(verifyWebhookToken('secret', 'secret')).toBe(true);
    });

    test('rejects mismatched and empty tokens', () => {
      expect(verifyWebhookToken('wrong', 'secret')).toBe(false);
      expect(verifyWebhookToken('', 'secret')).toBe(false);
      expect(verifyWebhookToken('', '')).toBe(false);
    });
  });
});
