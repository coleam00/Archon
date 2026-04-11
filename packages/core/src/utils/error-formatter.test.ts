import { describe, test, expect } from 'bun:test';
import { classifyAndFormatError } from './error-formatter';

describe('classifyAndFormatError', () => {
  describe('rate limit errors', () => {
    test('detects lowercase "rate limit"', () => {
      const result = classifyAndFormatError(new Error('rate limit exceeded'));
      expect(result).toBe('⚠️ AI rate limit reached. Please wait a moment and try again.');
    });

    test('detects titlecase "Rate limit"', () => {
      const result = classifyAndFormatError(new Error('Rate limit: 429 Too Many Requests'));
      expect(result).toBe('⚠️ AI rate limit reached. Please wait a moment and try again.');
    });

    test('matches rate limit anywhere in message', () => {
      const result = classifyAndFormatError(new Error('Request failed: rate limit hit'));
      expect(result).toBe('⚠️ AI rate limit reached. Please wait a moment and try again.');
    });
  });

  describe('OAuth refresh-token errors', () => {
    test('detects "refresh token" in message', () => {
      const result = classifyAndFormatError(new Error('Your refresh token was already used'));
      expect(result).toBe(
        '⚠️ AI authentication error. Please re-login (e.g. `claude /login`) and try again.'
      );
    });

    test('detects "could not be refreshed" in message', () => {
      const result = classifyAndFormatError(new Error('Your access token could not be refreshed'));
      expect(result).toBe(
        '⚠️ AI authentication error. Please re-login (e.g. `claude /login`) and try again.'
      );
    });

    test('detects "log out and sign in" in message', () => {
      const result = classifyAndFormatError(new Error('Please log out and sign in again'));
      expect(result).toBe(
        '⚠️ AI authentication error. Please re-login (e.g. `claude /login`) and try again.'
      );
    });

    test('handles full Claude OAuth error message', () => {
      const result = classifyAndFormatError(
        new Error(
          'Claude Code auth error: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
        )
      );
      expect(result).toBe(
        '⚠️ AI authentication error. Please re-login (e.g. `claude /login`) and try again.'
      );
    });
  });

  describe('authentication errors', () => {
    test('detects "API key" in message', () => {
      const result = classifyAndFormatError(new Error('Invalid API key provided'));
      expect(result).toBe('⚠️ AI service authentication error. Please check configuration.');
    });

    test('detects "authentication" in message', () => {
      const result = classifyAndFormatError(new Error('authentication failed'));
      expect(result).toBe('⚠️ AI service authentication error. Please check configuration.');
    });

    test('detects "auth error" prefix in message', () => {
      const result = classifyAndFormatError(
        new Error('Claude Code auth error: something went wrong')
      );
      expect(result).toBe('⚠️ AI service authentication error. Please check configuration.');
    });

    test('detects "401" in message', () => {
      const result = classifyAndFormatError(new Error('HTTP 401 Unauthorized'));
      expect(result).toBe('⚠️ AI service authentication error. Please check configuration.');
    });

    test('detects 401 as standalone in message', () => {
      const result = classifyAndFormatError(new Error('Status: 401'));
      expect(result).toBe('⚠️ AI service authentication error. Please check configuration.');
    });
  });

  describe('timeout errors', () => {
    test('detects "timeout" in message', () => {
      const result = classifyAndFormatError(new Error('Request timeout after 30s'));
      expect(result).toBe(
        '⚠️ Request timed out. The AI service may be slow. Try again or use /reset.'
      );
    });

    test('detects "ETIMEDOUT" in message', () => {
      const result = classifyAndFormatError(new Error('connect ETIMEDOUT 1.2.3.4:443'));
      expect(result).toBe(
        '⚠️ Request timed out. The AI service may be slow. Try again or use /reset.'
      );
    });
  });

  describe('database errors', () => {
    test('detects "ECONNREFUSED" in message', () => {
      const result = classifyAndFormatError(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
      expect(result).toBe('⚠️ Database connection issue. Please try again in a moment.');
    });

    test('detects "database" in message', () => {
      const result = classifyAndFormatError(new Error('database query failed'));
      expect(result).toBe('⚠️ Database connection issue. Please try again in a moment.');
    });

    test('detects "database" with mixed case context', () => {
      const result = classifyAndFormatError(new Error('The database is unavailable'));
      expect(result).toBe('⚠️ Database connection issue. Please try again in a moment.');
    });
  });

  describe('session errors', () => {
    test('detects lowercase "session" in message', () => {
      const result = classifyAndFormatError(new Error('session not found'));
      expect(result).toBe('⚠️ Session error. Use /reset to start a fresh session.');
    });

    test('detects titlecase "Session" in message', () => {
      const result = classifyAndFormatError(new Error('Session expired'));
      expect(result).toBe('⚠️ Session error. Use /reset to start a fresh session.');
    });

    test('matches session anywhere in message', () => {
      const result = classifyAndFormatError(new Error('Failed to resume session state'));
      expect(result).toBe('⚠️ Session error. Use /reset to start a fresh session.');
    });
  });

  describe('model not available errors', () => {
    test('returns message as-is when it matches the model unavailable pattern', () => {
      const msg = '❌ Model "claude-opus-4" not available for your account';
      const result = classifyAndFormatError(new Error(msg));
      expect(result).toBe(msg);
    });

    test('returns message as-is for different model names', () => {
      const msg = '❌ Model "gpt-5.3-codex" not available for your account';
      const result = classifyAndFormatError(new Error(msg));
      expect(result).toBe(msg);
    });

    test('does not match when prefix is wrong', () => {
      // Same suffix but different prefix → should NOT pass through
      const msg = 'Model "claude-sonnet" not available for your account';
      const result = classifyAndFormatError(new Error(msg));
      // Falls through to generic short-message path
      expect(result).toBe(`⚠️ Error: ${msg}. Try /reset if issue persists.`);
    });

    test('does not match when suffix is wrong', () => {
      const msg = '❌ Model "claude-opus-4" is not supported';
      const result = classifyAndFormatError(new Error(msg));
      // Falls through to generic short-message path
      expect(result).toBe(`⚠️ Error: ${msg}. Try /reset if issue persists.`);
    });
  });

  describe('Codex errors', () => {
    test('extracts inner message from "Codex query failed:" prefix', () => {
      const result = classifyAndFormatError(
        new Error('Codex query failed: context length exceeded')
      );
      expect(result).toBe('⚠️ AI error: context length exceeded. Try /reset if issue persists.');
    });

    test('handles empty inner message after Codex prefix', () => {
      const result = classifyAndFormatError(new Error('Codex query failed: '));
      expect(result).toBe('⚠️ AI error: . Try /reset if issue persists.');
    });

    test('handles Codex error with longer inner message', () => {
      const result = classifyAndFormatError(
        new Error('Codex query failed: model overloaded, please retry')
      );
      expect(result).toBe(
        '⚠️ AI error: model overloaded, please retry. Try /reset if issue persists.'
      );
    });
  });

  describe('generic short-message fallback', () => {
    test('returns formatted message for short safe error', () => {
      const result = classifyAndFormatError(new Error('unexpected EOF'));
      expect(result).toBe('⚠️ Error: unexpected EOF. Try /reset if issue persists.');
    });

    test('returns formatted message for exactly 99-char message', () => {
      const msg = 'a'.repeat(99);
      const result = classifyAndFormatError(new Error(msg));
      expect(result).toBe(`⚠️ Error: ${msg}. Try /reset if issue persists.`);
    });

    test('treats 100-char message as too long and uses generic fallback', () => {
      const msg = 'a'.repeat(100);
      const result = classifyAndFormatError(new Error(msg));
      expect(result).toBe('⚠️ An unexpected error occurred. Try /reset to start a fresh session.');
    });

    test('treats messages longer than 100 chars as too long', () => {
      const msg = 'a'.repeat(150);
      const result = classifyAndFormatError(new Error(msg));
      expect(result).toBe('⚠️ An unexpected error occurred. Try /reset to start a fresh session.');
    });
  });

  describe('security filtering', () => {
    test('filters message containing "password"', () => {
      const result = classifyAndFormatError(new Error('wrong password supplied'));
      expect(result).toBe('⚠️ An unexpected error occurred. Try /reset to start a fresh session.');
    });

    test('filters message containing "token"', () => {
      const result = classifyAndFormatError(new Error('invalid token abc123'));
      expect(result).toBe('⚠️ An unexpected error occurred. Try /reset to start a fresh session.');
    });

    test('filters message containing "secret"', () => {
      const result = classifyAndFormatError(new Error('bad secret value'));
      expect(result).toBe('⚠️ An unexpected error occurred. Try /reset to start a fresh session.');
    });

    test('filters message containing "key="', () => {
      const result = classifyAndFormatError(new Error('api_key=supersensitive'));
      expect(result).toBe('⚠️ An unexpected error occurred. Try /reset to start a fresh session.');
    });

    test('does not filter message containing "key" without "="', () => {
      // "key" alone should NOT trigger the filter — only "key=" does
      const result = classifyAndFormatError(new Error('missing key in config'));
      expect(result).toBe('⚠️ Error: missing key in config. Try /reset if issue persists.');
    });
  });

  describe('empty message fallback', () => {
    test('returns generic fallback for empty message string', () => {
      const result = classifyAndFormatError(new Error(''));
      expect(result).toBe('⚠️ An unexpected error occurred. Try /reset to start a fresh session.');
    });

    test('returns generic fallback when error has no message property value', () => {
      const err = new Error();
      const result = classifyAndFormatError(err);
      expect(result).toBe('⚠️ An unexpected error occurred. Try /reset to start a fresh session.');
    });
  });

  describe('true generic fallback', () => {
    test('generic fallback message text is correct', () => {
      // Trigger via long message (>100 chars, no sensitive keywords)
      const msg = 'x'.repeat(200);
      expect(classifyAndFormatError(new Error(msg))).toBe(
        '⚠️ An unexpected error occurred. Try /reset to start a fresh session.'
      );
    });

    test('generic fallback is returned for empty error message', () => {
      expect(classifyAndFormatError(new Error(''))).toBe(
        '⚠️ An unexpected error occurred. Try /reset to start a fresh session.'
      );
    });
  });

  describe('priority ordering', () => {
    test('rate limit takes precedence over short-message fallback', () => {
      // "rate limit" message is also short, but rate-limit branch fires first
      const result = classifyAndFormatError(new Error('rate limit'));
      expect(result).toBe('⚠️ AI rate limit reached. Please wait a moment and try again.');
    });

    test('OAuth check takes precedence over general auth check', () => {
      // Contains both "refresh token" and "auth error" — OAuth branch fires first
      const result = classifyAndFormatError(
        new Error('Claude Code auth error: refresh token expired')
      );
      expect(result).toBe(
        '⚠️ AI authentication error. Please re-login (e.g. `claude /login`) and try again.'
      );
    });

    test('auth check takes precedence over short-message fallback', () => {
      const result = classifyAndFormatError(new Error('API key'));
      expect(result).toBe('⚠️ AI service authentication error. Please check configuration.');
    });

    test('Codex check is applied before generic fallback', () => {
      // Inner message has "token" — but Codex branch fires before security filter
      const result = classifyAndFormatError(new Error('Codex query failed: token limit reached'));
      expect(result).toBe('⚠️ AI error: token limit reached. Try /reset if issue persists.');
    });
  });
});
