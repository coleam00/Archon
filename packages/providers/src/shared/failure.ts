import type { ProviderFailure, ProviderFailureClass } from '@archon/provider-contract';
import type { ResultChunk } from '../types';

/**
 * A failed turn as the one `result` chunk the contract requires, with the vendor's text
 * kept as evidence (or the subtype when the vendor said nothing). The caller derives
 * `failureClass` from structured SDK signals only, never from that text.
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

/** The class a thrown error carries, or `unknown` when nothing classified it. */
export function failureClassOfThrown(error: unknown): ProviderFailureClass {
  return error instanceof ClassifiedProviderError ? error.failureClass : 'unknown';
}
