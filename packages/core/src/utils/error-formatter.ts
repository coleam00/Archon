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
import { MissingProjectDirectoryError } from '@archon/isolation';
import { ConnectedCredentialUnavailableError } from '../credentials/unavailable-error';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';

const SHOWN_EVIDENCE_MAX_CHARS = 600;
const CREDENTIAL_MARKERS = ['password', 'token', 'secret', 'key='];

/**
 * The vendor's words, unless they carry anything that looks like a credential, cut to a
 * readable length. Shown only; nothing branches on it.
 */
function shownEvidence(evidence: string): string | undefined {
  const text = evidence.trim();
  if (text.length === 0) return undefined;
  const lower = text.toLowerCase();
  if (CREDENTIAL_MARKERS.some(marker => lower.includes(marker))) {
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
    case 'misconfigured':
      return `⚠️ The AI provider is not set up correctly${detail}. Fix its configuration, then try again; retrying unchanged will fail the same way.`;
    case 'rate_limited':
      return '⚠️ The AI provider is rate limiting requests. Wait a moment and try again.';
    case 'overloaded':
      return `⚠️ The AI provider is at capacity${detail}. Wait and try again.`;
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
 * @returns Safe diagnostic, with guidance only for typed errors
 */
export function classifyAndFormatError(error: Error, surface: WorkflowCommandSurface = {}): string {
  const message = error.message || '';

  if (error instanceof MissingProjectDirectoryError) {
    return `⚠️ ${message}`;
  }

  // Adoption refusals are authored user guidance (fail-loud contract in
  // workflow-adoption.ts): deliver them verbatim instead of erasing them into
  // the generic fallback below.
  if (error instanceof WorkflowAdoptionError) {
    return `⚠️ ${message}`;
  }

  // A failed terminal write leaves a non-terminal run holding its working path.
  // Resetting the conversation cannot recover it.
  if (error instanceof TerminalStatusWriteError) {
    return (
      '⚠️ The workflow ran, but its final status could not be saved, so it may still show ' +
      `as running. Check \`${spellWorkflowCommand(surface, 'status')}\` before starting another run on this project.`
    );
  }

  // Tier-resolution failures are authored configuration guidance (the message
  // names the CLI command, the console panel, and the docs URL): deliver it
  // verbatim.
  if (error instanceof TierResolutionError) {
    return `⚠️ ${message}`;
  }

  // Authored reconnect guidance. It names a credential, so the marker check below would
  // otherwise erase it into "unexpected error".
  if (error instanceof ConnectedCredentialUnavailableError) {
    return `⚠️ ${message}`;
  }

  const lower = message.toLowerCase();
  if (
    message.trim().length === 0 ||
    CREDENTIAL_MARKERS.some(marker => lower.includes(marker)) ||
    lower.includes('api key')
  ) {
    return '⚠️ An unexpected error occurred.';
  }
  const safeMessage = redactCredentialValues(message, collectCredentialValues(process.env));
  return `⚠️ Error: ${safeMessage}`;
}
