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

  // AI/SDK errors - rate limits
  if (message.includes('rate limit') || message.includes('Rate limit')) {
    return '⚠️ AI rate limit reached. Please wait a moment and try again.';
  }

  // AI/SDK errors - OAuth credential refresh (e.g. "claude /login" token expired)
  if (
    message.includes('refresh token') ||
    message.includes('could not be refreshed') ||
    message.includes('log out and sign in')
  ) {
    return '⚠️ AI authentication error. Please re-login (e.g. `claude /login`) and try again.';
  }

  // AI/SDK errors - authentication
  if (
    message.includes('API key') ||
    message.includes('authentication') ||
    message.includes('auth error') ||
    message.includes('401')
  ) {
    return '⚠️ AI service authentication error. Please check configuration.';
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
