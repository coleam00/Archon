/**
 * A failed turn ends in one `result` chunk whose `failure` class comes only from
 * structured SDK signals: the typed assistant-message error code, the HTTP status the
 * result carries as a field, the result subtype, the subscription window reported by
 * `rate_limit_event`, the typed fields the SDK sets on the errors it throws, and the class
 * Archon's own setup checks attach to theirs (`ClassifiedProviderError`). The
 * vendor's words travel as `evidence` and nothing branches on them, so a reworded
 * message keeps its class. The provider does not retry; the engine owns that policy.
 */
import type {
  SDKAssistantMessageError,
  SDKRateLimitInfo,
  SDKStartupFailureReason,
} from '@anthropic-ai/claude-agent-sdk';
import type { ProviderFailure, ProviderFailureClass } from '@archon/provider-contract';
import type { ResultChunk } from '../types';
import { ClassifiedProviderError } from '../shared/failure';
import { pathKind } from './binary-resolver';

/**
 * Errors the Claude SDK throws carry a machine-readable `errorClass` it sets beside the
 * message (for example `process_exited_nonzero`). The field is not in the SDK's typings,
 * so it is read defensively.
 */
function sdkErrorClass(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as { errorClass?: unknown }).errorClass;
  return typeof value === 'string' ? value : undefined;
}

/** The class an HTTP status alone can justify. Anything else is `unknown`. */
function classOfHttpStatus(status: number | null | undefined): ProviderFailureClass {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (typeof status === 'number' && status >= 500) return 'transient';
  return 'unknown';
}

export function failureOf(failureClass: ProviderFailureClass, evidence: string): ProviderFailure {
  return { class: failureClass, evidence: evidence.trim() || failureClass };
}

/**
 * Classify an API failure the SDK reported as a synthetic assistant message (#1797).
 * `rateLimit` is the last `rate_limit_event` of the turn: a `rejected` subscription window
 * turns a `rate_limit` code into an exhausted quota that reopens at `resetsAt` (epoch
 * seconds), where a plain `rate_limit` is load shedding the engine may wait out.
 */
export function classifyClaudeApiError(
  code: SDKAssistantMessageError,
  httpStatus: number | null | undefined,
  rateLimit: SDKRateLimitInfo | undefined,
  evidence: string
): ProviderFailure {
  switch (code) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
    case 'verification_required':
    case 'cloud_credential_error':
      // Each blocks requests until the operator acts; a new attempt cannot clear it.
      return failureOf('auth', evidence);
    case 'billing_error':
      return failureOf('quota_exhausted', evidence);
    case 'model_not_found':
      // The model id comes from the node or config; another attempt asks for it again.
      return failureOf('misconfigured', evidence);
    case 'rate_limit': {
      if (rateLimit?.status !== 'rejected') return failureOf('rate_limited', evidence);
      const failure = failureOf('quota_exhausted', evidence);
      if (rateLimit.resetsAt !== undefined) {
        const resetAt = new Date(rateLimit.resetsAt * 1000);
        if (Number.isFinite(resetAt.getTime())) failure.resetAt = resetAt.toISOString();
      }
      return failure;
    }
    case 'overloaded':
      return failureOf('overloaded', evidence);
    case 'server_error':
      return failureOf('transient', evidence);
    case 'invalid_request':
    case 'max_output_tokens':
    case 'unknown':
      // No class of their own; the status field may still say more (a 429 or 529
      // reported under a catch-all code).
      return failureOf(classOfHttpStatus(httpStatus), evidence);
    default: {
      // A code newer than this mapping. Unclassified is honest; it keeps the evidence.
      const unmapped: never = code;
      return failureOf('unknown', `${String(unmapped)}: ${evidence}`);
    }
  }
}

/**
 * The class a reason Claude Code gave for refusing to start can justify. Sign-in
 * refusals are `auth`; a setup the operator must change is `misconfigured`; the
 * reasons the SDK documents as retryable are `transient`. A reason that could be either a
 * setup fault or a passing condition stays `unknown`.
 */
function classOfStartupFailure(reason: SDKStartupFailureReason): ProviderFailureClass {
  switch (reason) {
    case 'org_pin_api_key_conflict':
    case 'org_pin_mismatch':
    case 'gateway_signin_required':
    case 'gateway_access_denied':
    case 'org_config_refused': // the sign-in or an admin's change is the fix, not a retry
      return 'auth';
    case 'provider_not_allowed': // the session is set up for a provider managed settings disallow
    case 'managed_settings_invalid':
    case 'proxy_invalid':
    case 'temp_dir_unusable':
    case 'cwd_unavailable':
    case 'shell_tool_missing':
    case 'cli_version_too_old':
    case 'bypass_root':
      return 'misconfigured';
    case 'worktree_unverified':
    case 'org_config_required_unavailable': // the org's required settings could not be loaded
      return 'transient';
    case 'org_verify_failed': // network or a revoked token; the reason does not say which
    case 'remote_settings_required_unavailable': // unreachable or missing; the reason does not say which
    case 'session_held_by_background':
    case 'worktree_resume_refused':
      return 'unknown';
    default: {
      // A reason newer than this mapping. Unclassified is honest; the evidence names it.
      const unmapped: never = reason;
      void unmapped;
      return 'unknown';
    }
  }
}

/** Classify an error result the SDK ended the turn with, when no API error preceded it. */
export function classifyClaudeErrorResult(
  subtype: string,
  httpStatus: number | null | undefined,
  startupFailureReason: SDKStartupFailureReason | undefined,
  evidence: string
): ProviderFailure {
  if (subtype === 'error_max_budget_usd') return failureOf('budget_exceeded', evidence);
  if (startupFailureReason !== undefined) {
    return failureOf(classOfStartupFailure(startupFailureReason), evidence);
  }
  return failureOf(classOfHttpStatus(httpStatus), evidence);
}

/**
 * A spawn that fails because the WORKING DIRECTORY is gone reports ENOENT against the
 * executable's path, not the cwd's, and the SDK then blames a libc mismatch. When the
 * SDK says the executable could not be launched and the cwd is missing, say so. This
 * only rewrites the evidence; the class is `misconfigured` either way.
 */
function launchFailureEvidence(error: Error, hostCwd: string | undefined): string {
  if (hostCwd === undefined) return error.message;
  const kind = pathKind(hostCwd);
  if (kind === 'directory') return error.message;
  const detail =
    kind === 'file' ? 'is a file, not a directory' : 'does not exist (it may have been removed)';
  return (
    `Claude Code could not be started: its working directory "${hostCwd}" ${detail}. ` +
    'A process cannot be spawned in a missing directory, and the failure is reported ' +
    'against the executable rather than the directory — so the underlying SDK error ' +
    'names the Claude Code binary and blames a libc mismatch. The binary is fine. ' +
    'If this was an isolated worktree, recreate it or point this run at a directory ' +
    'that exists.'
  );
}

/**
 * Classify an error thrown while starting or streaming the query. `hostCwd` is the
 * directory the subprocess was spawned in when that directory is on THIS host; container
 * runs pass undefined, because their cwd names a path inside the container.
 */
export function classifyClaudeThrownError(
  error: Error,
  stderr: string,
  hostCwd: string | undefined
): ProviderFailure {
  const withStderr = stderr ? `${error.message} (stderr: ${stderr})` : error.message;
  if (error instanceof ClaudeFirstEventTimeoutError) return failureOf('transient', error.message);
  if (error instanceof ClassifiedProviderError) return failureOf(error.failureClass, error.message);
  switch (sdkErrorClass(error)) {
    case 'process_exited_nonzero':
    case 'process_killed_by_signal':
    case 'initialize_timeout':
      // The subprocess died or never finished starting; a fresh one may not.
      return failureOf('transient', withStderr);
    case 'executable_launch_failed':
    case 'executable_not_found':
      // A missing or unlaunchable binary, or a missing working directory: setup, not luck.
      return failureOf('misconfigured', launchFailureEvidence(error, hostCwd));
    default:
      // An unwrapped spawn error carries the errno as a field.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return failureOf('misconfigured', launchFailureEvidence(error, hostCwd));
      }
      return failureOf('unknown', withStderr);
  }
}

/** A failed turn as the one `result` chunk the contract requires. */
export function failureResultChunk(failure: ProviderFailure): ResultChunk {
  return { type: 'result', isError: true, failure, errors: [failure.evidence] };
}

/** The subprocess produced no first event in time. Classified `transient` by type, not text. */
export class ClaudeFirstEventTimeoutError extends Error {}
