import type { ProviderFailure, ProviderFailureClass } from '@archon/provider-contract';
import type { ResultChunk } from '../types';

/**
 * A failed turn as the one `result` chunk the contract requires, with the vendor's text
 * kept as evidence (or the subtype when the vendor said nothing). The caller derives
 * `failureClass` from structured SDK signals only, never from that text.
 *
 * The one carve-out is a vendor SDK that normalizes a *status code* into the text and
 * exposes nothing else: it is read at a fixed position (the first token) and never read
 * when absent, so this stays a status-code class rather than prose classification. Pi is
 * the case — see `failureClassFromMessage` in `community/pi/event-bridge.ts`.
 */
export function failureResult(
  failureClass: ProviderFailureClass,
  errorSubtype: string,
  evidence: string | undefined
): ResultChunk {
  const failure: ProviderFailure = {
    class: failureClass,
    evidence: evidence?.trim() || errorSubtype,
  };
  return { type: 'result', isError: true, errorSubtype, errors: [failure.evidence], failure };
}

/**
 * A failed turn whose SDK gave nothing structured to classify it by: class `unknown`.
 * The engine decides whether an unknown failure is worth another attempt.
 */
export function unknownFailureResult(
  errorSubtype: string,
  evidence: string | undefined
): ResultChunk {
  return failureResult('unknown', errorSubtype, evidence);
}

/**
 * An error thrown by provider code that already knows its failure class, because the
 * code that detected the problem knows what it is (a binary that cannot be resolved, an
 * MCP config file that cannot be read). The provider's catch reads the class from here,
 * so the message stays free to change.
 */
export class ClassifiedProviderError extends Error {
  constructor(
    readonly failureClass: ProviderFailureClass,
    message: string
  ) {
    super(message);
    this.name = 'ClassifiedProviderError';
  }
}

/**
 * The class an HTTP status alone can justify; anything else is `unknown`. Shared so every
 * provider that reads a status applies the same table rather than its own copy.
 *
 * `429` is a rate limit, `401`/`403` are `auth`, and every `5xx` is `transient` — a generic
 * server error, including `503`, does not establish *capacity*, so it never becomes
 * `overloaded`; that class needs a typed capacity signal from the provider.
 *
 * The 5xx range is bounded by 600 because a text prefix is only three digits: `"600: …"`
 * is not an HTTP status at all, and treating it as a server error would invent a class
 * for text that is not one.
 */
export function classOfHttpStatus(status: number | null | undefined): ProviderFailureClass {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (typeof status === 'number' && status >= 500 && status < 600) return 'transient';
  return 'unknown';
}

/** The class a thrown error carries, or `unknown` when nothing classified it. */
export function failureClassOfThrown(error: unknown): ProviderFailureClass {
  return error instanceof ClassifiedProviderError ? error.failureClass : 'unknown';
}
