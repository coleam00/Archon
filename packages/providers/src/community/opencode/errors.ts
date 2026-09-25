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

/**
 * Raised when the OpenCode server emits a `permission.asked` event that the
 * user's own OpenCode permission policy left as `ask`. Workflow nodes run
 * unattended, so there is nobody to answer the prompt: this fails the node
 * fast, naming the pending permission, instead of hanging forever waiting
 * for `session.idle` (issue #3332). It deliberately does not broaden the
 * embedded runtime's permission policy — that is the user's own OpenCode
 * config to own, not this provider's.
 *
 * The shape here is the real server's `permission.asked` event `properties`
 * (`{id, sessionID, permission, patterns, metadata, always, tool}`), verified
 * against a live OpenCode server (`GET /doc`'s `EventPermissionAsked`
 * schema). The `@opencode-ai/sdk` npm package's TypeScript types (as of
 * 1.18.31, matching the server version tested) still declare a
 * `permission.updated`/`Permission{id,type,pattern,...}` shape that no
 * current server actually emits — do not trust those types for this event.
 */
export function pendingPermissionError(permission: {
  id?: unknown;
  permission?: unknown;
  patterns?: unknown;
}): Error {
  const id = typeof permission.id === 'string' ? permission.id : 'unknown';
  const category = typeof permission.permission === 'string' ? permission.permission : 'unknown';
  const patterns = Array.isArray(permission.patterns)
    ? permission.patterns.filter((p): p is string => typeof p === 'string').join(', ')
    : undefined;

  return new Error(
    `OpenCode requested permission '${id}' for '${category}'${patterns ? ` (patterns: ${patterns})` : ''} ` +
      'and no policy resolved it. Workflow nodes run unattended and cannot answer an ' +
      "'ask' permission prompt; update the OpenCode 'permission' config (global or " +
      "project) to 'allow' this action for unattended runs, or adjust the node/agent " +
      'tools configuration to avoid triggering it.'
  );
}
