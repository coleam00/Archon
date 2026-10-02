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
 * The engine decides whether an unknown failure is worth another attempt. Codex and Pi
 * report every failure this way, because their SDKs expose failures only as message
 * strings.
 */
export function unknownFailureResult(
  errorSubtype: string,
  evidence: string | undefined
): ResultChunk {
  return failureResult('unknown', errorSubtype, evidence);
}
