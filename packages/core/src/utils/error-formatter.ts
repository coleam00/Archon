/**
 * Error Formatter
 *
 * Classifies errors and provides user-friendly messages
 * without leaking sensitive information
 */

/**
 * Classify an error and return a user-friendly message
 *
 * @param error - The error to classify
 * @returns User-friendly error message with actionable guidance
 */
export function classifyAndFormatError(error: Error): string {
  const message = error.message || '';

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

  // Codex-specific auth errors — 401 retry exhaustion
  // Codex surfaces auth failures as "exceeded retry limit, last status: 401 Unauthorized"
  // Recovery: `codex login` in terminal.
  if (
    message.includes('Codex query failed:') &&
    (message.includes('401') || message.includes('Unauthorized'))
  ) {
    return '⚠️ Codex authentication error. Run `codex login` in your terminal to re-authenticate.';
  }

  // General AI/SDK authentication errors
  if (
    message.includes('API key') ||
    message.includes('authentication_error') ||
    message.includes('authentication error') ||
    message.includes('401')
  ) {
    return '⚠️ AI service authentication error. Please check your API key or credentials.';
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
