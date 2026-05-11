/**
 * Unit tests for GitHub authorization utilities
 */
import { parseAllowedUsers, isGitHubUserAuthorized } from './auth';

describe('github-auth', () => {
  describe('parseAllowedUsers', () => {
    test('should return empty array for undefined', () => {
      expect(parseAllowedUsers(undefined)).toEqual([]);
    });

    test('should return empty array for empty string', () => {
      expect(parseAllowedUsers('')).toEqual([]);
    });

    test('should return empty array for whitespace-only string', () => {
      expect(parseAllowedUsers('   ')).toEqual([]);
    });

    test('should parse single username', () => {
      expect(parseAllowedUsers('octocat')).toEqual(['octocat']);
    });

    test('should parse multiple usernames', () => {
      expect(parseAllowedUsers('alice,bob,charlie')).toEqual(['alice', 'bob', 'charlie']);
    });

    test('should handle whitespace around usernames', () => {
      expect(parseAllowedUsers(' alice , bob , charlie ')).toEqual(['alice', 'bob', 'charlie']);
    });

    test('should normalize usernames to lowercase', () => {
      expect(parseAllowedUsers('Alice,BOB,Charlie')).toEqual(['alice', 'bob', 'charlie']);
    });

    test('should filter out empty segments', () => {
      expect(parseAllowedUsers('alice,,bob')).toEqual(['alice', 'bob']);
    });

    test('should handle mixed case and whitespace', () => {
      expect(parseAllowedUsers(' Octocat , MONALISA ')).toEqual(['octocat', 'monalisa']);
    });
  });

  describe('isGitHubUserAuthorized', () => {
    describe('open access mode (empty allowedUsers)', () => {
      test('should allow any username when no whitelist', () => {
        expect(isGitHubUserAuthorized('anyuser', [])).toBe(true);
      });

      test('should allow undefined username when no whitelist', () => {
        expect(isGitHubUserAuthorized(undefined, [])).toBe(true);
      });

      test('should allow empty username when no whitelist', () => {
        expect(isGitHubUserAuthorized('', [])).toBe(true);
      });
    });

    describe('whitelist mode', () => {
      const allowedUsers = ['alice', 'bob', 'charlie'];

      test('should allow authorized user (exact match)', () => {
        expect(isGitHubUserAuthorized('alice', allowedUsers)).toBe(true);
      });

      test('should allow authorized user (case-insensitive - uppercase)', () => {
        expect(isGitHubUserAuthorized('ALICE', allowedUsers)).toBe(true);
      });

      test('should allow authorized user (case-insensitive - mixed case)', () => {
        expect(isGitHubUserAuthorized('AlIcE', allowedUsers)).toBe(true);
      });

      test('should reject unauthorized user', () => {
        expect(isGitHubUserAuthorized('david', allowedUsers)).toBe(false);
      });

      test('should reject undefined username', () => {
        expect(isGitHubUserAuthorized(undefined, allowedUsers)).toBe(false);
      });

      test('should reject empty username', () => {
        expect(isGitHubUserAuthorized('', allowedUsers)).toBe(false);
      });

      test('should reject whitespace-only username', () => {
        expect(isGitHubUserAuthorized('   ', allowedUsers)).toBe(false);
      });
    });
  });
});
