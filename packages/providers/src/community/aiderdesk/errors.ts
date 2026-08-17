/**
 * Error classification for the AiderDesk provider.
 *
 * Mirrors the OpenCode provider's error classification pattern: pattern-match
 * against error name/message/statusCode to decide retryability.
 */

export type AiderDeskRetryableErrorClass =
  | 'rate_limit'
  | 'auth'
  | 'crash'
  | 'timeout'
  | 'aborted'
  | 'unknown';

const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
const AUTH_PATTERNS = ['unauthorized', 'authentication', 'invalid token', '401', '403', 'api key'];
const CRASH_PATTERNS = [
  'server disconnected',
  'econnreset',
  'socket hang up',
  'connection terminated',
  'connection refused',
  'process terminated',
  'econnrefused',
];
const TIMEOUT_PATTERNS = ['timeout', 'timed out', 'aborted'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    if (typeof error.message === 'string') return error.message;
    if (isRecord(error.data) && typeof error.data.message === 'string') return error.data.message;
  }
  return String(error);
}

/**
 * Classify an error from the AiderDesk REST API or the provider layer.
 * Returns the error class so the caller can decide whether to retry.
 */
export function classifyAiderdeskError(
  error: unknown,
  aborted: boolean
): AiderDeskRetryableErrorClass {
  if (aborted) return 'aborted';

  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
  }
  if (isRecord(error)) {
    if (typeof error.name === 'string') parts.push(error.name);
    if (typeof error.message === 'string') parts.push(error.message);
    if (typeof error.statusCode === 'number') parts.push(String(error.statusCode));
    if (isRecord(error.data)) {
      if (typeof error.data.message === 'string') parts.push(error.data.message);
    }
  }

  const combined = parts.join(' ').toLowerCase();

  if (RATE_LIMIT_PATTERNS.some(p => combined.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => combined.includes(p))) return 'auth';
  if (TIMEOUT_PATTERNS.some(p => combined.includes(p))) return 'timeout';
  if (CRASH_PATTERNS.some(p => combined.includes(p))) return 'crash';
  return 'unknown';
}

/**
 * Wrap an error with a class-prefixed message for surface-level reporting.
 */
export function enrichAiderdeskError(
  error: unknown,
  errorClass: AiderDeskRetryableErrorClass
): Error {
  if (errorClass === 'aborted') {
    return new Error('AiderDesk query aborted');
  }

  const err = new Error(`AiderDesk ${errorClass}: ${errorMessage(error)}`);
  if (error instanceof Error) err.cause = error;
  return err;
}

/**
 * Custom error for AiderDesk API failures (non-200 responses, network errors).
 */
export class AiderDeskApiError extends Error {
  constructor(
    public readonly statusCode: number | undefined,
    message: string,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = 'AiderDeskApiError';
  }
}

/**
 * Hard failure surface for AiderDesk agent-profile resolution.
 *
 * Thrown by the AiderDesk provider when:
 *  - `requestOptions.model` is unset and no `assistantConfig.agentProfileId` pin exists.
 *  - `requestOptions.model` IS set but no profile in the catalog carries that exact
 *    `name` (case-sensitive).
 *
 * The provider layer is the SINGLE source of truth for profile existence — the
 * orchestrator-layer resolution path accepts the model-name string as-is and
 * delegates. No silent fallback, no project-default substitute, no warning
 * chunk before an error chunk. The exception carries `requestedName` and
 * `knownNames` so the UI / dag-executor can render an actionable "did you
 * mean …?".
 */
export class UnknownAiderDeskAgentProfileError extends Error {
  constructor(
    public readonly requestedName: string,
    public readonly knownNames: readonly string[],
    public readonly candidates: readonly string[] = []
  ) {
    super(
      `Unknown AiderDesk agent profile: '${requestedName}'. ` +
        `Known names: [${knownNames.join(', ')}].` +
        (candidates.length ? ` Did you mean: ${candidates.join(', ')}?` : '')
    );
    this.name = 'UnknownAiderDeskAgentProfileError';
  }
}

/**
 * Thrown when `modelOverride` is supplied on a SendQueryOptions for AiderDesk
 * but the override is NOT present in the AiderDesk model catalog
 * (`GET /api/models`). Caps the displayed known-models list to the first 8 to
 * avoid noisy error chunks; the full list lives on `knownModels`.
 */
export class InvalidAiderDeskModelOverrideError extends Error {
  constructor(
    public readonly model: string,
    public readonly knownModels: readonly string[]
  ) {
    super(
      `Invalid AiderDesk modelOverride: '${model}'. ` +
        `Known models: ${knownModels.length === 0 ? '[]' : '[' + knownModels.slice(0, 8).join(', ') + (knownModels.length > 8 ? ', …' : '') + ']'}.`
    );
    this.name = 'InvalidAiderDeskModelOverrideError';
  }
}
