import { describe, test, expect } from 'bun:test';
import {
  isWebAuthEnabled,
  assertWebAuthAtBoot,
  parseAllowedEmails,
  isEmailAllowed,
  getSignupMode,
  isApiGateEnabled,
  isArchonOwnedAuthPath,
} from './config';

const VALID_SECRET = 'a'.repeat(32);
const PG_URL = 'postgresql://postgres:postgres@localhost:5432/db';

describe('auth/config', () => {
  describe('isWebAuthEnabled', () => {
    test('true only when both DATABASE_URL and BETTER_AUTH_SECRET are set', () => {
      expect(isWebAuthEnabled({ DATABASE_URL: PG_URL, BETTER_AUTH_SECRET: VALID_SECRET })).toBe(
        true
      );
    });

    test('false when DATABASE_URL is missing (SQLite/solo install)', () => {
      expect(isWebAuthEnabled({ BETTER_AUTH_SECRET: VALID_SECRET })).toBe(false);
    });

    test('false when BETTER_AUTH_SECRET is missing', () => {
      expect(isWebAuthEnabled({ DATABASE_URL: PG_URL })).toBe(false);
    });

    test('false when both are missing', () => {
      expect(isWebAuthEnabled({})).toBe(false);
    });
  });

  describe('assertWebAuthAtBoot', () => {
    test('no-op when web auth is disabled, even with a short secret', () => {
      expect(() => assertWebAuthAtBoot({ BETTER_AUTH_SECRET: 'short' })).not.toThrow();
    });

    test('passes when enabled with a >=32-char secret', () => {
      expect(() =>
        assertWebAuthAtBoot({ DATABASE_URL: PG_URL, BETTER_AUTH_SECRET: VALID_SECRET })
      ).not.toThrow();
    });

    test('throws an actionable error when enabled with a short secret', () => {
      expect(() =>
        assertWebAuthAtBoot({ DATABASE_URL: PG_URL, BETTER_AUTH_SECRET: 'short' })
      ).toThrow(/at least 32 characters/);
    });
  });

  describe('parseAllowedEmails', () => {
    test('empty/unset → empty list (open signup)', () => {
      expect(parseAllowedEmails({})).toEqual([]);
      expect(parseAllowedEmails({ ARCHON_AUTH_ALLOWED_EMAILS: '' })).toEqual([]);
    });

    test('splits, trims, lowercases, and drops blanks', () => {
      expect(
        parseAllowedEmails({ ARCHON_AUTH_ALLOWED_EMAILS: ' Alice@X.com , , BOB@y.com ' })
      ).toEqual(['alice@x.com', 'bob@y.com']);
    });
  });

  describe('isEmailAllowed', () => {
    test('empty allowlist → any email allowed (open)', () => {
      expect(isEmailAllowed('anyone@example.com', [])).toBe(true);
    });

    test('accepts a listed email (case-insensitive)', () => {
      expect(isEmailAllowed('Alice@X.com', ['alice@x.com'])).toBe(true);
    });

    test('rejects an unlisted email', () => {
      expect(isEmailAllowed('mallory@evil.com', ['alice@x.com'])).toBe(false);
    });
  });

  describe('getSignupMode', () => {
    test("'disabled' by default when no allowlist (safe default — not open)", () => {
      expect(getSignupMode({})).toBe('disabled');
    });

    test("'allowlist' when emails are configured", () => {
      expect(getSignupMode({ ARCHON_AUTH_ALLOWED_EMAILS: 'a@b.com' })).toBe('allowlist');
    });

    test("'open' only when ARCHON_AUTH_OPEN_SIGNUP=true and no allowlist", () => {
      expect(getSignupMode({ ARCHON_AUTH_OPEN_SIGNUP: 'true' })).toBe('open');
    });

    test('allowlist wins over the open flag', () => {
      expect(
        getSignupMode({ ARCHON_AUTH_ALLOWED_EMAILS: 'a@b.com', ARCHON_AUTH_OPEN_SIGNUP: 'true' })
      ).toBe('allowlist');
    });
  });

  describe('isApiGateEnabled', () => {
    test('true when web auth is enabled and not opted out (default)', () => {
      expect(isApiGateEnabled({ DATABASE_URL: PG_URL, BETTER_AUTH_SECRET: VALID_SECRET })).toBe(
        true
      );
    });

    test('false when web auth is disabled', () => {
      expect(isApiGateEnabled({})).toBe(false);
    });

    test('false when explicitly opted out via ARCHON_WEB_AUTH_REQUIRED=false', () => {
      expect(
        isApiGateEnabled({
          DATABASE_URL: PG_URL,
          BETTER_AUTH_SECRET: VALID_SECRET,
          ARCHON_WEB_AUTH_REQUIRED: 'false',
        })
      ).toBe(false);
    });
  });

  describe('isArchonOwnedAuthPath', () => {
    test('exempts Archon-owned /api/auth/* paths (fall through, not Better Auth)', () => {
      for (const p of [
        '/api/auth/status',
        '/api/auth/github',
        '/api/auth/github/device/start',
        '/api/auth/github/device/poll',
        '/api/auth/providers',
        '/api/auth/providers/openrouter',
        '/api/auth/providers/claude/oauth/start', // reserved for PR-3
        '/api/auth/me/ai-prefs',
        '/api/auth/me/ai-prefs/tiers',
      ]) {
        expect(isArchonOwnedAuthPath(p)).toBe(true);
      }
    });

    test('does NOT exempt Better Auth-owned paths (those it must handle)', () => {
      for (const p of [
        '/api/auth/sign-in',
        '/api/auth/sign-up',
        '/api/auth/sign-out',
        '/api/auth/get-session',
        '/api/auth/providersX', // prefix guard: must be exact or under '/'
        '/api/auth/githubbed',
        '/api/auth/me/ai-prefsX',
        '/api/auth',
      ]) {
        expect(isArchonOwnedAuthPath(p)).toBe(false);
      }
    });
  });
});
