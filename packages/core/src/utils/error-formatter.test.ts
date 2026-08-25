import { describe, test, expect } from 'bun:test';
import { classifyAndFormatError } from './error-formatter';
import { WorkflowAdoptionError } from '../operations/workflow-adoption';

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

  describe('Claude general auth errors', () => {
    test('detects "Claude Code auth error:" prefix for non-OAuth errors', () => {
      const result = classifyAndFormatError(new Error('Claude Code auth error: 403 forbidden'));
      expect(result).toContain('Claude authentication error');
      expect(result).toContain('/login');
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

  describe('Codex auth errors', () => {
    test('detects Codex 401 retry exhaustion via "Codex query failed:" wrapper', () => {
      const result = classifyAndFormatError(
        new Error('Codex query failed: exceeded retry limit, last status: 401 Unauthorized')
      );
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
    });

    test('detects Codex 401 auth failure via "Codex auth error:" wrapper (provider-enriched shape)', () => {
      // classifyAndEnrichCodexError wraps messages whose AUTH_PATTERNS match
      // (here: "401" and "Unauthorized") as `Codex auth error: <inner>`. This
      // is the shape the provider actually emits for a 401 auth failure
      // (#2509 R1) — the `auth` class is excluded from retry and thrown
      // immediately (provider.ts:856), not the synthetic `Codex query
      // failed:` shape.
      const result = classifyAndFormatError(
        new Error('Codex auth error: exceeded retry limit, last status: 401 Unauthorized')
      );
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
      expect(result).not.toContain('Claude authentication');
    });

    test('detects Codex query failed with Unauthorized', () => {
      const result = classifyAndFormatError(new Error('Codex query failed: Unauthorized'));
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
    });

    describe('"Codex auth error:" wrapper routes unconditionally (#2509 R1)', () => {
      // The provider only wraps a message as `Codex auth error:` after its own
      // AUTH_PATTERNS check already classified it as auth
      // (packages/providers/src/codex/provider.ts:307-315, 848-851). These
      // inner phrases don't appear in the formatter's OAuth-refresh substring
      // list, so before the fix they fell through to a generic message
      // instead of Codex guidance — the same misdirection #2509 reports, for
      // different real phrasing the provider already classifies as auth.
      test.each([
        ['authentication failed', 'authentication'],
        ['unauthorized', 'unauthorized'],
        ['403 Forbidden: insufficient scope', '403'],
        ['Your credit balance is too low to access the API', 'credit balance'],
        ['invalid token provided', 'invalid token'],
      ])('routes "%s" (AUTH_PATTERNS: %s) to Codex auth guidance', inner => {
        const result = classifyAndFormatError(new Error(`Codex auth error: ${inner}`));
        expect(result).toContain('Codex authentication error');
        expect(result).toContain('codex login');
        expect(result).not.toContain('Claude authentication');
        // "invalid token provided" contains the word "token", which the
        // generic fallback's sensitive-data filter used to strip along with
        // all other detail — the unconditional route must bypass that filter.
        expect(result).not.toContain('unexpected error occurred');
      });
    });
  });

  describe('Codex OAuth refresh-token errors (#2509)', () => {
    // Regression for GitHub #2509: a Codex-wrapped OAuth refresh error used
    // to be routed to Claude `/login` guidance because the OAuth-refresh
    // branch matched provider-agnostic refresh phrases without a Codex-side
    // prefix check, so provider-wrapped shapes (Codex auth error: / Codex
    // unknown: / codex_turn_failed: / codex_stream_incomplete:) fell through
    // to the Claude branch. The Codex-side prefix check now catches every
    // shape the provider/orchestrator actually emits.

    test('routes "Codex query failed:" refresh-token race to Codex auth guidance', () => {
      const result = classifyAndFormatError(
        new Error(
          'Codex query failed: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
        )
      );
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
      expect(result).not.toContain('Claude authentication');
    });

    test('routes "Codex auth error:" refresh-token race to Codex auth guidance (provider throw shape)', () => {
      // The actual provider throw shape when AUTH_PATTERNS doesn't match
      // (refresh-token messages don't match AUTH_PATTERNS, so this is the
      // `Codex unknown:` path; using `Codex auth error:` here to also cover
      // the case where a future AUTH_PATTERNS addition wraps it as auth).
      const result = classifyAndFormatError(
        new Error(
          'Codex auth error: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
        )
      );
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
      expect(result).not.toContain('Claude authentication');
    });

    test('routes "Codex unknown:" refresh-token race to Codex auth guidance (provider throw shape)', () => {
      // The actual provider throw shape when AUTH_PATTERNS doesn't match
      // (none of "credit balance", "unauthorized", "authentication",
      // "invalid token", "401", "403" appears in a refresh-token message),
      // so classifyAndEnrichCodexError wraps it as `Codex unknown: <inner>`
      // (provider.ts:854). This was the unreachable shape #2509 R1
      // identified — it must now route to Codex auth guidance, not Claude.
      const result = classifyAndFormatError(
        new Error(
          'Codex unknown: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
        )
      );
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
      expect(result).not.toContain('Claude authentication');
    });

    test('routes "codex_turn_failed:" synthetic shape to Codex auth guidance (orchestrator isError shape)', () => {
      // The orchestrator's isError branch joins errorSubtype + errors[] into
      // `codex_turn_failed: <inner>` (orchestrator-agent.ts:2522-2524). When
      // the underlying provider turn.failed message is a refresh-token race,
      // this is the shape the formatter sees.
      const result = classifyAndFormatError(
        new Error(
          'codex_turn_failed: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
        )
      );
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
      expect(result).not.toContain('Claude authentication');
    });

    test('routes "codex_stream_incomplete:" synthetic shape to Codex auth guidance (orchestrator isError shape)', () => {
      // The orchestrator's isError branch also emits `codex_stream_incomplete:
      // <inner>` for the post-loop fail-stop path (orchestrator-agent.ts:
      // 2756-2758). The provider's `streamCodexEvents` yields this chunk
      // when the iterator closes without turn.completed / turn.failed (e.g.
      // model rejected before the turn started).
      const result = classifyAndFormatError(
        new Error(
          'codex_stream_incomplete: Your refresh token was already used. Please log out and sign in again.'
        )
      );
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
      expect(result).not.toContain('Claude authentication');
    });

    test('routes Codex-wrapped "refresh token" to Codex auth guidance', () => {
      const result = classifyAndFormatError(
        new Error('Codex query failed: refresh token already used')
      );
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
    });

    test('routes Codex-wrapped "log out and sign in" to Codex auth guidance', () => {
      const result = classifyAndFormatError(
        new Error('Codex query failed: Please log out and sign in again.')
      );
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
    });

    test('routes Codex-wrapped "OAuth token has expired" to Codex auth guidance', () => {
      // No "401" / "Unauthorized" present, so the auth-indicator half of
      // the branch must still fire on the refresh-phrase half.
      const result = classifyAndFormatError(
        new Error('Codex query failed: OAuth token has expired')
      );
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
    });

    test('routes Codex-wrapped "sign-in has expired" to Codex auth guidance (#2509 R2 coverage)', () => {
      // The "sign-in has expired" phrase is in the Codex-side branch's OR
      // chain but had no Codex-wrapped test (#2509 R2). A future refactor
      // that drops this phrase from the OR would otherwise let the next
      // branch (Claude-OAuth) match and re-introduce #2509's misroute.
      const result = classifyAndFormatError(new Error('Codex query failed: sign-in has expired'));
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
      expect(result).not.toContain('Claude authentication');
    });
  });

  describe('raw orchestrator prefixes reject a bare "401" (#2509 R2)', () => {
    // Codex query failed:/codex_turn_failed:/codex_stream_incomplete: carry
    // raw upstream text (provider.ts / orchestrator-agent.ts) that never
    // passes through the provider's own classifyCodexError/AUTH_PATTERNS
    // check, unlike every `Codex auth error:`-classified shape above. A bare
    // "401" in that raw text is not a reliable auth signal — it can appear
    // in unrelated internal errors like a port or a byte offset — so these
    // three prefixes require the more specific word "Unauthorized" instead.
    test('does not route "Codex query failed:" with an unrelated "401" to Codex auth guidance', () => {
      const result = classifyAndFormatError(
        new Error('Codex query failed: connect ECONNREFUSED 127.0.0.1:401')
      );
      expect(result).not.toContain('Codex authentication');
      expect(result).not.toContain('codex login');
    });

    test('does not route "codex_turn_failed:" with an unrelated "401" to Codex auth guidance', () => {
      const result = classifyAndFormatError(
        new Error('codex_turn_failed: internal error at offset 401 while parsing response body')
      );
      expect(result).not.toContain('Codex authentication');
      expect(result).not.toContain('codex login');
    });

    test('does not route "codex_stream_incomplete:" with an unrelated "401" to Codex auth guidance', () => {
      const result = classifyAndFormatError(
        new Error('codex_stream_incomplete: retry counter reached 401 before stream closed')
      );
      expect(result).not.toContain('Codex authentication');
      expect(result).not.toContain('codex login');
    });

    test('still routes "Codex query failed:" carrying "Unauthorized" to Codex auth guidance', () => {
      const result = classifyAndFormatError(
        new Error('Codex query failed: connect refused, 401 Unauthorized')
      );
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
    });

    test('still routes "codex_turn_failed:" carrying "Unauthorized" to Codex auth guidance', () => {
      const result = classifyAndFormatError(new Error('codex_turn_failed: 401 Unauthorized'));
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
    });

    test('routes a lowercase "unauthorized" in a raw-prefixed message to Codex auth guidance (#2509 R8)', () => {
      // The provider's own classifyCodexError lowercases before comparing against
      // AUTH_PATTERNS, so it treats "unauthorized" and "Unauthorized" identically.
      // This raw-prefix guard must not require the capitalized form specifically.
      const result = classifyAndFormatError(
        new Error('Codex query failed: request failed: unauthorized')
      );
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
    });
  });

  describe('non-auth-classified Codex prefixes reject a bare "401"/"403" (#2509 R7, R9)', () => {
    // Before the fix, AUTH_PATTERNS's bare "401"/"403" match meant a message
    // containing either digit sequence could never reach classifyCodexError's
    // 'crash'/'unknown' branches — it was always classified 'auth' first and
    // wrapped as `Codex auth error:`, which error-formatter.ts trusts
    // unconditionally. With AUTH_PATTERNS tightened, a message like this one
    // now genuinely reaches the provider's `Codex unknown:`/`Codex crash:`
    // wrap — proving the misroute doesn't just relocate to this branch's own
    // (now-removed) bare-401 fallback.
    //
    // Asserting the exact returned string (not just the absence of
    // Codex-specific phrasing) matters: the general auth branch a few lines
    // below also used to accept a bare "401" with no prefix gate at all, so
    // these two inputs used to land on generic-but-still-wrong "check your
    // API key" guidance instead of the accurate branch two lines further
    // down (#2509 R9). A negative-only assertion can't tell the difference.
    test('routes "Codex unknown:" with an unrelated "401" to the ECONNREFUSED/database branch, not any auth guidance', () => {
      const result = classifyAndFormatError(
        new Error('Codex unknown: connect ECONNREFUSED 127.0.0.1:401')
      );
      expect(result).toBe('⚠️ Database connection issue. Please try again in a moment.');
      expect(result).not.toContain('authentication');
    });

    test('routes "Codex crash:" with an unrelated "401" to the timeout branch, not any auth guidance', () => {
      const result = classifyAndFormatError(new Error('Codex crash: timeout after 401ms'));
      expect(result).toBe(
        '⚠️ Request timed out. The AI service may be slow. Try again or use /reset.'
      );
      expect(result).not.toContain('authentication');
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
      // A bare "401" used to be enough on its own — same "bare digits aren't
      // enough signal" defect already fixed on the Codex-specific checks
      // above (#2509 R2, R7, R8). This message carries no other auth word
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

  describe('model not available errors', () => {
    test('returns message as-is when it matches the model unavailable pattern', () => {
      const msg = '❌ Model "claude-opus-4" not available for your account';
      const result = classifyAndFormatError(new Error(msg));
      expect(result).toBe(msg);
    });

    test('returns message as-is for different model names', () => {
      const msg = '❌ Model "gpt-5.6-sol" not available for your account';
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
      expect(result).toBe('⚠️ AI usage limit reached. Please wait and try again.');
    });

    test('Claude OAuth check takes precedence over general auth check', () => {
      // Contains both "refresh token" and "Claude Code auth error:" — OAuth branch fires first
      const result = classifyAndFormatError(
        new Error('Claude Code auth error: refresh token expired')
      );
      expect(result).toContain('Claude authentication expired');
    });

    test('Codex auth takes precedence over generic Codex error handler', () => {
      // Contains "Codex query failed:" AND "401" — Codex auth branch fires first
      const result = classifyAndFormatError(new Error('Codex query failed: 401 Unauthorized'));
      expect(result).toContain('Codex authentication error');
      expect(result).toContain('codex login');
    });

    test('auth check takes precedence over short-message fallback', () => {
      const result = classifyAndFormatError(new Error('API key'));
      expect(result).toContain('authentication error');
    });

    test('Codex check is applied before generic fallback', () => {
      // Inner message has "token" — but Codex branch fires before security filter
      const result = classifyAndFormatError(new Error('Codex query failed: token limit reached'));
      expect(result).toBe('⚠️ AI error: token limit reached. Try /reset if issue persists.');
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
});
