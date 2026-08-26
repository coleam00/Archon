// Prose patterns exclude bare HTTP codes; exact structured statusCode fields
// and SDK error discriminators are classified separately below.
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', 'overloaded'];
const AUTH_PATTERNS = ['unauthorized', 'authentication', 'invalid token', 'api key'];
const CRASH_PATTERNS = [
  'server disconnected',
  'disposed',
  'econnreset',
  'socket hang up',
  'connection terminated',
  'process terminated',
];
const AGENT_NOT_FOUND_PATTERNS = [
  'agent not found',
  'unknown agent',
  'invalid agent',
  'no agent named',
];

export type RetryableErrorClass =
  | 'rate_limit'
  | 'auth'
  | 'crash'
  | 'agent_not_found'
  | 'unknown'
  | 'aborted';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function classifyStructuredError(error: unknown): RetryableErrorClass | undefined {
  const candidates = [error];
  if (error instanceof Error) candidates.push(error.cause);

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (candidate.name === 'ProviderAuthError') return 'auth';

    const data = isRecord(candidate.data) ? candidate.data : undefined;
    const statusCode =
      typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : typeof candidate.status === 'number'
          ? candidate.status
          : typeof data?.statusCode === 'number'
            ? data.statusCode
            : undefined;
    if (statusCode === 401 || statusCode === 403) return 'auth';
    if (statusCode === 429) return 'rate_limit';
  }

  return undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    if (typeof error.message === 'string') return error.message;
    if (isRecord(error.data) && typeof error.data.message === 'string') return error.data.message;
  }
  return String(error);
}

export function classifyOpencodeError(error: unknown, aborted: boolean): RetryableErrorClass {
  if (aborted) return 'aborted';

  const structuredClass = classifyStructuredError(error);
  if (structuredClass) return structuredClass;

  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
  }
  if (isRecord(error)) {
    if (typeof error.name === 'string') parts.push(error.name);
    if (typeof error.message === 'string') parts.push(error.message);
    if (isRecord(error.data)) {
      if (typeof error.data.message === 'string') parts.push(error.data.message);
      if (typeof error.data.responseBody === 'string') parts.push(error.data.responseBody);
    }
  }

  const combined = parts.join(' ').toLowerCase();
  if (RATE_LIMIT_PATTERNS.some(pattern => combined.includes(pattern))) return 'rate_limit';
  if (AUTH_PATTERNS.some(pattern => combined.includes(pattern))) return 'auth';
  if (CRASH_PATTERNS.some(pattern => combined.includes(pattern))) return 'crash';
  if (AGENT_NOT_FOUND_PATTERNS.some(pattern => combined.includes(pattern)))
    return 'agent_not_found';
  return 'unknown';
}

export function enrichOpencodeError(error: unknown, errorClass: RetryableErrorClass): Error {
  if (errorClass === 'aborted') {
    return new Error('OpenCode query aborted');
  }

  const err = new Error(`OpenCode ${errorClass}: ${errorMessage(error)}`);
  if (error instanceof Error) err.cause = error;
  return err;
}
