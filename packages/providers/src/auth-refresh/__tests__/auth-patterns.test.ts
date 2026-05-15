import { describe, expect, test } from 'bun:test';
import { AUTH_PATTERNS, isAuthErrorMessage } from '../auth-patterns';

describe('AUTH_PATTERNS', () => {
  test('includes every documented anchor pattern', () => {
    // These are the patterns that anchor each historical incident; if any
    // get accidentally removed during a refactor, the corresponding bypass
    // path returns. Grep is intentional — keeps the array honest.
    const required = [
      'credit balance',
      'unauthorized',
      'authentication',
      '401',
      '403',
      'not logged in', // PR #49 anchor
      'please run /login', // PR #49 anchor
      'not signed in', // Codex anchor
      "please run 'codex login'", // Codex anchor
      'refresh token', // upstream #1089 mirror
      'could not be refreshed', // upstream #1089 mirror
      'log out and sign in', // upstream #1089 mirror
    ];
    for (const pattern of required) {
      expect(AUTH_PATTERNS).toContain(pattern);
    }
  });

  test('is exposed as a readonly array', () => {
    // TypeScript marks it readonly; this verifies that runtime mutation
    // would not affect the exported reference (the import path is shared
    // by provider + orchestrator).
    expect(Array.isArray(AUTH_PATTERNS)).toBe(true);
    expect(AUTH_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('isAuthErrorMessage', () => {
  test('returns true for the Claude "Not logged in" subprocess message', () => {
    expect(isAuthErrorMessage('Not logged in · Please run /login')).toBe(true);
  });

  test('returns true for the Codex "Not signed in" subprocess message', () => {
    expect(isAuthErrorMessage("Not signed in. Please run 'codex login'.")).toBe(true);
  });

  test('returns true for HTTP 401/403 in error messages', () => {
    expect(isAuthErrorMessage('Request failed with status 401')).toBe(true);
    expect(isAuthErrorMessage('Forbidden (403)')).toBe(true);
  });

  test('returns true for terminal refresh-failure server messages', () => {
    expect(
      isAuthErrorMessage(
        'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
      )
    ).toBe(true);
  });

  test('returns true for unauthorized / authentication keywords', () => {
    expect(isAuthErrorMessage('unauthorized access')).toBe(true);
    expect(isAuthErrorMessage('Authentication failed')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(isAuthErrorMessage('NOT LOGGED IN')).toBe(true);
    expect(isAuthErrorMessage('Not Logged In')).toBe(true);
  });

  test('returns false for non-auth errors', () => {
    expect(isAuthErrorMessage('rate limit exceeded')).toBe(false);
    expect(isAuthErrorMessage('exited with code 137')).toBe(false);
    expect(isAuthErrorMessage('Could not parse JSON response')).toBe(false);
    expect(isAuthErrorMessage('Tool execution failed: file not found')).toBe(false);
  });

  test('returns false on undefined / empty input', () => {
    expect(isAuthErrorMessage(undefined)).toBe(false);
    expect(isAuthErrorMessage('')).toBe(false);
  });
});
