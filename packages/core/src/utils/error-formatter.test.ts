import { describe, test, expect } from 'bun:test';
import { classifyAndFormatError, formatProviderFailure } from './error-formatter';
import { WorkflowAdoptionError } from '../operations/workflow-adoption';
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';
import { buildAiProfile, resolveTierWithFallback } from '@archon/workflows/model-validation';

describe('classifyAndFormatError', () => {
  describe('rate limit errors', () => {
    test('detects lowercase "rate limit"', () => {
      const result = classifyAndFormatError(new Error('rate limit exceeded'));
      expect(result).toBe('⚠️ AI usage limit reached. Please wait and try again.');
    });

    test('detects titlecase "Rate limit"', () => {
      const result = classifyAndFormatError(new Error('Rate limit: 429 Too Many Requests'));
      expect(result).toBe('⚠️ AI usage limit reached. Please wait and try again.');
    });

    test('matches rate limit anywhere in message', () => {
      const result = classifyAndFormatError(new Error('Request failed: rate limit hit'));
      expect(result).toBe('⚠️ AI usage limit reached. Please wait and try again.');
    });

    test('detects "hit your limit" (Claude subscription cap)', () => {
      const result = classifyAndFormatError(
        new Error("You've hit your limit · resets 4:50pm (UTC)")
      );
      expect(result).toBe(
        '⚠️ AI usage limit reached (resets 4:50pm (UTC)). Please wait and try again.'
      );
    });

    test('detects full enriched Claude usage-cap error with reset time', () => {
      const result = classifyAndFormatError(
        new Error(
          "Claude Code unknown: Claude Code returned an error result: You've hit your limit · resets 4:50pm (UTC)"
        )
      );
      expect(result).toBe(
        '⚠️ AI usage limit reached (resets 4:50pm (UTC)). Please wait and try again.'
      );
    });

    test('detects "usage limit" (Claude org-disabled-overage variant)', () => {
      const result = classifyAndFormatError(new Error('usage limit exceeded'));
      expect(result).toBe('⚠️ AI usage limit reached. Please wait and try again.');
    });

    test('omits reset clause when no reset time present in hit-your-limit message', () => {
      const result = classifyAndFormatError(new Error("You've hit your limit"));
      expect(result).toBe('⚠️ AI usage limit reached. Please wait and try again.');
    });

    test('detects title-case "Hit your limit" (case-insensitive)', () => {
      const result = classifyAndFormatError(new Error('Hit your limit'));
      expect(result).toBe('⚠️ AI usage limit reached. Please wait and try again.');
    });

    test('detects title-case "Usage limit" (case-insensitive)', () => {
      const result = classifyAndFormatError(new Error('Usage limit exceeded'));
      expect(result).toBe('⚠️ AI usage limit reached. Please wait and try again.');
    });

    test('handles reset text containing abbreviated periods (e.g. p.m.)', () => {
      const result = classifyAndFormatError(
        new Error("You've hit your limit · resets 4:50 p.m. (UTC)")
      );
      expect(result).toBe(
        '⚠️ AI usage limit reached (resets 4:50 p.m. (UTC)). Please wait and try again.'
      );
    });

    test('detects "session limit" (Claude subscription 5h window)', () => {
      const result = classifyAndFormatError(
        new Error("You've hit your session limit · resets 3am (America/Mexico_City)")
      );
      expect(result).toBe(
        '⚠️ AI usage limit reached (resets 3am (America/Mexico_City)). Please wait and try again.'
      );
    });

    test('captures only the first ·-delimited segment when multiple · separators follow', () => {
      const result = classifyAndFormatError(
        new Error("You've hit your limit · resets 4:50pm (UTC) · upgrade to increase your limit")
      );
      expect(result).toBe(
        '⚠️ AI usage limit reached (resets 4:50pm (UTC)). Please wait and try again.'
      );
    });
  });

  describe('reset-time fallback without · separator', () => {
    test('captures a standalone "Resets in ..." clause', () => {
      const result = classifyAndFormatError(new Error('rate limit exceeded. Resets in 5 minutes'));
      expect(result).toBe(
        '⚠️ AI usage limit reached (Resets in 5 minutes). Please wait and try again.'
      );
    });

    test('does not capture a clause from "reset" without the plural form', () => {
      const result = classifyAndFormatError(new Error('usage limit exceeded, reset pending'));
      expect(result).toBe('⚠️ AI usage limit reached. Please wait and try again.');
    });

    test('keeps abbreviated periods intact in the fallback capture', () => {
      const result = classifyAndFormatError(new Error('rate limit hit. Resets 4:50 p.m. (UTC)'));
      expect(result).toBe(
        '⚠️ AI usage limit reached (Resets 4:50 p.m. (UTC)). Please wait and try again.'
      );
    });

    test('drops the follow-on sentence from the workflow session-limit FATAL shape (#2181)', () => {
      const result = classifyAndFormatError(
        new Error(
          'Claude session limit reached — resets 3:20pm (UTC). Abandon this run and retry after reset.'
        )
      );
      expect(result).toBe(
        '⚠️ AI usage limit reached (resets 3:20pm (UTC)). Please wait and try again.'
      );
    });
  });

  describe('Claude OAuth refresh-token errors', () => {
    test('detects "refresh token" in message', () => {
      const result = classifyAndFormatError(new Error('Your refresh token was already used'));
      expect(result).toContain('Claude authentication expired');
      expect(result).toContain('/login');
    });

    test('detects "could not be refreshed" in message', () => {
      const result = classifyAndFormatError(new Error('Your access token could not be refreshed'));
      expect(result).toContain('Claude authentication expired');
    });

    test('detects "log out and sign in" in message', () => {
      const result = classifyAndFormatError(new Error('Please log out and sign in again'));
      expect(result).toContain('Claude authentication expired');
    });

    test('detects "OAuth token has expired" in message', () => {
      const result = classifyAndFormatError(
        new Error('API Error: 401 OAuth token has expired. Please run /login')
      );
      expect(result).toContain('Claude authentication expired');
      expect(result).toContain('claude logout && claude login');
    });

    test('detects "sign-in has expired" in message', () => {
      const result = classifyAndFormatError(
        new Error('Unable to start session: sign-in has expired')
      );
      expect(result).toContain('Claude authentication expired');
    });

    test('handles full Claude OAuth error with refresh token race condition', () => {
      const result = classifyAndFormatError(
        new Error(
          'Claude Code auth error: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
        )
      );
      expect(result).toContain('Claude authentication expired');
    });
  });

  describe('not logged in (no credential reached the subprocess) (#1983)', () => {
    test('detects "Not logged in" and names the connect surfaces', () => {
      const result = classifyAndFormatError(new Error('Not logged in · Please run /login'));
      expect(result).toContain('Not logged in to the AI provider');
      expect(result).toContain('Settings → Agents');
    });

    test('detects a "Please run /login" message without leaking the raw string', () => {
      const result = classifyAndFormatError(new Error('Invalid API key · Please run /login'));
      expect(result).toContain('Settings → Agents');
      expect(result).not.toContain('Invalid API key ·');
    });
  });

  describe('general authentication errors', () => {
    test('detects "API key" in message', () => {
      const result = classifyAndFormatError(new Error('Invalid API key provided'));
      expect(result).toContain('authentication error');
    });

    test('detects "authentication_error" in message', () => {
      const result = classifyAndFormatError(new Error('authentication_error: invalid'));
      expect(result).toContain('authentication error');
    });

    test('detects "authentication error" in message', () => {
      const result = classifyAndFormatError(new Error('authentication error'));
      expect(result).toContain('authentication error');
    });

    test('does not treat a bare "401" alone as sufficient auth signal (#2509 R9)', () => {
      // A bare "401" used to be enough on its own (#2509 R2, R7, R8, R9).
      // This message carries no other auth word
      // ("API key" / "authentication_error" / "authentication error"), so it
      // now falls through to the generic fallback instead of the auth
      // message.
      const result = classifyAndFormatError(new Error('HTTP 401 Unauthorized'));
      expect(result).toBe('⚠️ Error: HTTP 401 Unauthorized. Try /reset if issue persists.');
      expect(result).not.toContain('authentication error');
    });

    test('does not false-positive on generic messages containing "auth"', () => {
      // "auth" alone should NOT match — only specific patterns
      const result = classifyAndFormatError(new Error('author name missing'));
      expect(result).not.toContain('authentication');
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
      expect(result).toBe('⚠️ AI usage limit reached. Please wait and try again.');
    });

    test('Claude OAuth check takes precedence over general auth check', () => {
      // Contains both "refresh token" and "authentication error" — OAuth branch fires first
      const result = classifyAndFormatError(
        new Error('authentication error: refresh token expired')
      );
      expect(result).toContain('Claude authentication expired');
    });

    test('auth check takes precedence over short-message fallback', () => {
      const result = classifyAndFormatError(new Error('API key'));
      expect(result).toContain('authentication error');
    });
  });

  describe('workflow adoption refusals', () => {
    // Adoption refusals are authored guidance (fail-loud contract, #2747 R9); they
    // must reach chat/web users verbatim instead of the generic fallback.
    test('delivers a WorkflowAdoptionError message verbatim', () => {
      const refusal =
        "Cannot adopt run 'prior-run': this conversation already continues run 'x' (paused).";
      const result = classifyAndFormatError(new WorkflowAdoptionError(refusal));
      expect(result).toBe(`⚠️ ${refusal}`);
    });
  });

  describe('terminal status write failures', () => {
    // #2910: this is the terminus for the orchestrator's /invoke-workflow and
    // /workflow run dispatch paths — neither has a closer catch, so handleMessage's
    // catch formats the error here. A run whose status was never recorded must not
    // read as a generic error the user is told to /reset away from.
    test('names the unrecorded status instead of the generic fallback', () => {
      const result = classifyAndFormatError(
        new TerminalStatusWriteError(new Error('SQLITE_BUSY: database is locked'))
      );
      expect(result).toContain('final status could not be saved');
      expect(result).toContain('/workflow status');
      expect(result).not.toContain('/reset');
    });

    test('spells the status command for the surface', () => {
      const result = classifyAndFormatError(new TerminalStatusWriteError(new Error('gone')), {
        formatWorkflowCommand: command => `/archon-workflow ${command}`,
      });
      expect(result).toContain('`/archon-workflow status`');
      expect(result.replaceAll('/archon-workflow ', '')).not.toContain('/workflow ');
    });

    test('an ordinary database error still gets the generic database guidance', () => {
      const result = classifyAndFormatError(new Error('database is locked'));
      expect(result).not.toContain('final status could not be saved');
    });
  });
});

describe('TierResolutionError', () => {
  test('delivers the real tier-resolution guidance verbatim (never the generic fallback)', () => {
    // The actual error the chat path hits when the default provider ships no
    // built-in tiers and none are configured — derived, not restated.
    let thrown: Error | undefined;
    try {
      resolveTierWithFallback(buildAiProfile('pi'), 'large');
    } catch (err) {
      thrown = err as Error;
    }
    if (!thrown) throw new Error('expected resolveTierWithFallback to throw');

    const formatted = classifyAndFormatError(thrown);
    expect(formatted).toBe(`⚠️ ${thrown.message}`);
    expect(formatted).toContain('archon ai tier set');
    expect(formatted).toContain('https://archon.diy/');
    expect(formatted).not.toContain('/reset');
  });
});

describe('formatProviderFailure', () => {
  test.each([
    ['auth', 'The AI provider rejected its credentials: Invalid API key'],
    ['quota_exhausted', 'AI usage limit reached. Please wait and try again.'],
    ['budget_exceeded', 'The turn stopped at its spend limit.'],
    ['rate_limited', 'The AI provider is rate limiting requests.'],
    ['transient', 'The AI provider failed temporarily: Invalid API key. Try again.'],
    ['unknown', 'AI error: Invalid API key. Try /reset if issue persists.'],
  ] as const)('%s failures get their own advice', (failureClass, expected) => {
    expect(formatProviderFailure({ class: failureClass, evidence: 'Invalid API key' })).toContain(
      expected
    );
  });

  test('the class picks the advice, never the words', () => {
    // Words that read as a usage limit do not turn an auth failure into usage advice.
    const message = formatProviderFailure({
      class: 'auth',
      evidence: 'rate limit reached, usage limit, session limit',
    });
    expect(message).toStartWith('⚠️ The AI provider rejected its credentials');
    expect(message).not.toContain('AI usage limit reached');
  });

  test('names the reset instant of an exhausted quota', () => {
    expect(
      formatProviderFailure({
        class: 'quota_exhausted',
        evidence: "You've hit your session limit",
        resetAt: '2026-09-25T18:00:00.000Z',
      })
    ).toBe(
      '⚠️ AI usage limit reached (resets 2026-09-25T18:00:00.000Z). Please wait and try again.'
    );
  });

  test('never shows evidence that looks like it carries a credential', () => {
    const message = formatProviderFailure({ class: 'unknown', evidence: 'bad token sk-ant-123' });
    expect(message).toBe('⚠️ AI error. Try /reset if issue persists.');
  });
});
