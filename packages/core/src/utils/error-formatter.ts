/**
 * Error Formatter
 *
 * Classifies errors and provides user-friendly messages
 * without leaking sensitive information
 */
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';
import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';
import { TierResolutionError } from '@archon/workflows/model-validation';
import { WorkflowAdoptionError } from '../operations/workflow-adoption';
import type { ProviderFailure } from '@archon/provider-contract';

const SHOWN_EVIDENCE_MAX_CHARS = 600;

/**
 * The vendor's words, unless they carry anything that looks like a credential, cut to a
 * readable length. Shown only; nothing branches on it.
 */
function shownEvidence(evidence: string): string | undefined {
  const text = evidence.trim();
  if (text.length === 0) return undefined;
  const lower = text.toLowerCase();
  if (['password', 'token', 'secret', 'key='].some(marker => lower.includes(marker))) {
    return undefined;
  }
  return text.length > SHOWN_EVIDENCE_MAX_CHARS
    ? `${text.slice(0, SHOWN_EVIDENCE_MAX_CHARS)}…`
    : text;
}

/**
 * The chat message for a turn whose provider reported a typed failure. The advice
 * follows the class the provider chose from its SDK's structured signals; the evidence
 * is shown when it is safe to, never read to pick the advice.
 */
export function formatProviderFailure(failure: ProviderFailure): string {
  const shown = shownEvidence(failure.evidence);
  const detail = shown !== undefined ? `: ${shown}` : '';
  switch (failure.class) {
    case 'auth':
      return `⚠️ The AI provider rejected its credentials${detail}. Reconnect it in Settings → Agents, or log in again with the provider's own CLI.`;
    case 'quota_exhausted':
      return `⚠️ AI usage limit reached${failure.resetAt !== undefined ? ` (resets ${failure.resetAt})` : ''}. Please wait and try again.`;
    case 'budget_exceeded':
      return '⚠️ The turn stopped at its spend limit.';
    case 'rate_limited':
      return '⚠️ The AI provider is rate limiting requests. Wait a moment and try again.';
    case 'transient':
      return `⚠️ The AI provider failed temporarily${detail}. Try again.`;
    case 'unknown':
      return `⚠️ AI error${detail}. Try /reset if issue persists.`;
    default: {
      const exhaustive: never = failure.class;
      return exhaustive;
    }
  }
}

/**
 * Classify an error and return a user-friendly message
 *
 * @param error - The error to classify
 * @param surface - The surface the message is shown on; spells any command it suggests
 * @returns User-friendly error message with actionable guidance
 */
export function classifyAndFormatError(error: Error, surface: WorkflowCommandSurface = {}): string {
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
      `as running. Check \`${spellWorkflowCommand(surface, 'status')}\` before starting another run on this project.`
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

  // Not logged in — no credential reached the subprocess. On a multi-user
  // install this means the user hasn't connected a provider yet; on a solo
  // install it means no key / no `claude login`. Name both connect surfaces
  // instead of leaking the raw CLI string (#1983).
  if (message.includes('Not logged in') || message.includes('Please run /login')) {
    return '⚠️ Not logged in to the AI provider. Connect a subscription or API key in Settings → Agents, or set credentials in your environment (e.g. `claude /login` or `CLAUDE_API_KEY`).';
  }

  // General AI/SDK authentication errors. Deliberately excludes a bare "401"
  // (#2509 R2, R7, R8) — a stray status-looking digit in unrelated
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
