import type { ProviderFailureClass } from '@archon/provider-contract';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The failure class OpenCode's structured signals support: the SDK's `ProviderAuthError`
 * discriminator or an exact HTTP status field, on the error or its `cause`. Everything
 * else is `unknown`; the message text never sets a class, because a vendor rewording
 * must not change what the engine retries.
 */
export function opencodeFailureClass(error: unknown): ProviderFailureClass {
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
    if (statusCode === 429) return 'rate_limited';
  }

  return 'unknown';
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
