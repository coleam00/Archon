import type { ProviderFailure } from '@archon/provider-contract';
import type { ResultChunk } from '../types';

/**
 * A failed turn whose SDK gave nothing structured to classify it by, as the one
 * `result` chunk the contract requires: class `unknown`, with the vendor's text kept as
 * evidence (or the subtype when the vendor said nothing). The engine decides whether an
 * unknown failure is worth another attempt. Codex and Pi report every failure this way,
 * because their SDKs expose failures only as message strings.
 */
export function unknownFailureResult(
  errorSubtype: string,
  evidence: string | undefined
): ResultChunk {
  const failure: ProviderFailure = {
    class: 'unknown',
    evidence: evidence?.trim() || errorSubtype,
  };
  return { type: 'result', isError: true, errorSubtype, errors: [failure.evidence], failure };
}
