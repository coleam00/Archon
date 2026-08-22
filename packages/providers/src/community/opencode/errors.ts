// Deliberately excludes a bare '429': that digit can appear in unrelated text
// (a port, a byte count, a millisecond duration) on this classifier's sole
// call site (the retry loop's catch in provider.ts:181) — same "bare digits
// aren't enough signal" reasoning as AUTH_PATTERNS below (#2715, mirror of
// #2509 R11). A false 'rate_limit' classification wastes a subprocess
// retry/backoff cycle before the correct terminal message is shown, but
// (unlike a false 'auth' hit) does not deny the retry outright.
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', 'overloaded'];
// Deliberately excludes bare '401'/'403': those digits can appear in
// unrelated text (a port, a byte offset, a millisecond duration) on this
// classifier's sole call site (the retry loop's catch in provider.ts:181),
// which covers every error thrown mid-turn — the most common failure
// surface in this file. A false 'auth' classification here both misroutes
// the user-facing message (enrichOpencodeError prefixes the error with
// `OpenCode auth:` unconditionally) and forces `shouldRetry: false` at
// provider.ts:182-186, denying a transient failure its retry (#2715,
// mirror of #2509 R7 / Claude AUTH_PATTERNS).
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
      if (typeof error.data.statusCode === 'number') parts.push(String(error.data.statusCode));
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
