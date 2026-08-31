/**
 * Error Formatter
 *
 * Classifies errors and provides user-friendly messages
 * without leaking sensitive information
 */
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';
import { TierResolutionError } from '@archon/workflows/model-validation';
import { WorkflowAdoptionError } from '../operations/workflow-adoption';

/**
 * Classify an error and return a user-friendly message
 *
 * @param error - The error to classify
 * @returns User-friendly error message with actionable guidance
 */
export function classifyAndFormatError(error: Error): string {
  const message = error.message || '';

  // Adoption refusals are authored user guidance (fail-loud contract in
  // workflow-adoption.ts): deliver them verbatim instead of erasing them into
  // the generic fallback below.
  if (error instanceof WorkflowAdoptionError) {
    return `⚠️ ${message}`;
  }

  // The run finished but its terminal status was not recorded, so its row still says
  // `running` and its true outcome is unknown. Distinct from an ordinary failure: the
  // generic fallbacks below would tell the user to `/reset`, which fixes nothing and
  // hides a run that will otherwise sit non-terminal holding its working path.
  if (error instanceof TerminalStatusWriteError) {
    return (
      '⚠️ The workflow ran, but its final status could not be saved, so it may still show ' +
      'as running. Check `/workflow status` before starting another run on this project.'
    );
  }

  // Tier-resolution failures are authored configuration guidance (the message
  // names the CLI command, the console panel, and the docs URL): deliver it
  // verbatim — the generic fallbacks below would erase it into `/reset`
  // advice that cannot fix a missing tier config.
  if (error instanceof TierResolutionError) {
    return `⚠️ ${message}`;
  }

  // AI-provider rate-limit / usage-cap classification
  // Broad substrings are intentional: every call site feeds errors from handling
  // an AI conversation turn, so a bare "usage limit" needs no provider prefix.
  const lower = message.toLowerCase();
  if (
    lower.includes('rate limit') ||
    lower.includes('hit your limit') ||
    lower.includes('usage limit') ||
    lower.includes('session limit')
  ) {
    // Anchor on · (Claude format: "... · resets 4:50pm (UTC)"); stop at · or newline so "p.m." isn't truncated.
    // The no-· fallback also drops any follow-on sentence (period + capital letter), so shapes like
    // "Claude session limit reached — resets 3:20pm (UTC). Abandon this run…" yield just the reset clause.
    const reset =
      /·\s*(resets[^·\n]*)/i.exec(message)?.[1]?.trim() ??
      /resets[^·\n]*/i
        .exec(message)?.[0]
        ?.replace(/\.\s+[A-Z][\s\S]*$/, '')
        .trim();
    return `⚠️ AI usage limit reached${reset ? ` (${reset})` : ''}. Please wait and try again.`;
  }

  // Codex-specific auth errors — OAuth token refresh failures and 401 retry
  // exhaustion (GitHub #2509). The rate-limit branch above has already had a
  // chance to match, so a `Codex rate_limit:` wrap routes to usage-cap
  // guidance first (only when the inner text matches that branch's own
  // substring list: "rate limit" / "hit your limit" / "usage limit" /
  // "session limit").
  //
  // `Codex auth error:` means the provider's own AUTH_PATTERNS
  // (packages/providers/src/codex/provider.ts) already classified this
  // message as auth, so it routes unconditionally instead of being re-tested
  // against a narrower, hand-written substring list — that mismatch is what
  // let real auth errors like "unauthorized" and "invalid token" fall
  // through (#2509 R1). That unconditional trust is warranted only because
  // AUTH_PATTERNS itself requires a real auth word ("unauthorized" /
  // "authentication" / "invalid token" / "credit balance") and deliberately
  // excludes a bare "401"/"403" — a stray status-looking digit in unrelated
  // text (a port, a timeout in ms) does not classify as auth there, so it
  // never reaches this branch (#2509 R7; see the AUTH_PATTERNS comment in
  // provider.ts). Every other Codex-side prefix was NOT classified as auth
  // by the provider: some are a different class (`Codex crash:`), others are
  // raw and never classified at all (`Codex query failed:`,
  // `codex_turn_failed:`, `codex_stream_incomplete:`), so those still need a
  // substring check below — for the same "bare digits aren't enough signal"
  // reason, that check requires the specific word "unauthorized"
  // (case-insensitive), not a bare "401" (#2509 R2, R8).
  if (message.startsWith('Codex auth error:')) {
    return '⚠️ Codex authentication error. Run `codex login` in your terminal to re-authenticate.';
  }
  const isCodexRawPrefixed =
    message.startsWith('Codex query failed:') ||
    message.startsWith('codex_turn_failed:') ||
    message.startsWith('codex_stream_incomplete:');
  if (
    (message.startsWith('Codex ') || isCodexRawPrefixed) &&
    (message.includes('refresh token') ||
      message.includes('could not be refreshed') ||
      message.includes('log out and sign in') ||
      message.includes('OAuth token has expired') ||
      message.includes('sign-in has expired') ||
      lower.includes('unauthorized'))
  ) {
    return '⚠️ Codex authentication error. Run `codex login` in your terminal to re-authenticate.';
  }

  // Claude-specific auth errors — OAuth token refresh failures
  // These come from Claude Code subprocess stderr or SDK result subtypes.
  // Recovery: `/login` in-session or `claude logout && claude login` in terminal.
  if (
    message.includes('refresh token') ||
    message.includes('could not be refreshed') ||
    message.includes('log out and sign in') ||
    message.includes('OAuth token has expired') ||
    message.includes('sign-in has expired')
  ) {
    return '⚠️ Claude authentication expired. Run `/login` inside Claude Code or `claude logout && claude login` in your terminal.';
  }

  // Claude-specific auth errors — general (subprocess crash with auth classification)
  if (message.startsWith('Claude Code auth error:')) {
    return '⚠️ Claude authentication error. Run `/login` inside Claude Code or check your API key configuration.';
  }

  // Not logged in — no credential reached the subprocess. On a multi-user
  // install this means the user hasn't connected a provider yet; on a solo
  // install it means no key / no `claude login`. Name both connect surfaces
  // instead of leaking the raw CLI string (#1983).
  if (message.includes('Not logged in') || message.includes('Please run /login')) {
    return '⚠️ Not logged in to the AI provider. Connect a subscription or API key in Settings → Agents, or set credentials in your environment (e.g. `claude /login` or `CLAUDE_API_KEY`).';
  }

  // General AI/SDK authentication errors. Deliberately excludes a bare "401":
  // same "bare digits aren't enough signal" reasoning as the Codex checks
  // above (#2509 R2, R7, R8) — a stray status-looking digit in unrelated
  // text (a port, a byte offset, a millisecond duration) is not a reliable
  // auth indicator on its own, and this function has more accurate branches
  // for exactly those shapes a few lines below (timeout, ECONNREFUSED). The
  // three remaining checks already carry the real signal (#2509 R9).
  if (
    message.includes('API key') ||
    message.includes('authentication_error') ||
    message.includes('authentication error')
  ) {
    return '⚠️ AI service authentication error. Please check your API key or credentials.';
  }

  // AI Service Provider Outage / 503 Service Unavailable
  if (
    lower.includes('503') ||
    lower.includes('service unavailable') ||
    lower.includes('service_unavailable') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('provider unavailable') ||
    (lower.includes('overloaded') && !message.startsWith('Codex query failed:'))
  ) {
    return '⚠️ 503: Archon is fine, the AI service provider is currently DOWN.';
  }

  // Network errors - timeout
  if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
    return '⚠️ Request timed out. The AI service may be slow. Try again or use /reset.';
  }

  // Database errors
  if (message.includes('ECONNREFUSED') || message.includes('database')) {
    return '⚠️ Database connection issue. Please try again in a moment.';
  }

  // Session errors
  if (message.includes('session') || message.includes('Session')) {
    return '⚠️ Session error. Use /reset to start a fresh session.';
  }

  if (message.startsWith('❌ Model "') && message.includes('not available for your account')) {
    return message;
  }

  // Codex-specific errors (thrown as "Codex query failed: ...")
  if (message.includes('Codex query failed:')) {
    const innerMessage = message.replace('Codex query failed: ', '');
    return `⚠️ AI error: ${innerMessage}. Try /reset if issue persists.`;
  }

  // Generic fallback with hint about what failed
  // Only show if message is short and doesn't contain sensitive data
  if (
    message.length > 0 &&
    message.length < 100 &&
    !message.includes('password') &&
    !message.includes('token') &&
    !message.includes('secret') &&
    !message.includes('key=')
  ) {
    return `⚠️ Error: ${message}. Try /reset if issue persists.`;
  }

  // True generic fallback for unknown/sensitive errors
  return '⚠️ An unexpected error occurred. Try /reset to start a fresh session.';
}
