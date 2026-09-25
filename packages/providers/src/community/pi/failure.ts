// No Pi imports here: provider.ts imports this statically, and Pi's runtime modules
// must stay behind the dynamic imports in sendQuery (see the note in provider.ts).
import type { ProviderFailure } from '@archon/provider-contract';
import type { ResultChunk } from '../../types';

/**
 * A failed Pi turn as the one `result` chunk the contract requires. Pi reports a failure
 * only as `stopReason: 'error' | 'aborted'` plus an `errorMessage` string (its SDK has no
 * typed error taxonomy), so nothing structured can classify it: every Pi failure is
 * `unknown`, with Pi's text kept as evidence. The engine decides whether an unknown
 * failure is worth another attempt.
 */
export function piFailureResult(errorSubtype: string, evidence: string | undefined): ResultChunk {
  const failure: ProviderFailure = {
    class: 'unknown',
    evidence: evidence?.trim() || errorSubtype,
  };
  return { type: 'result', isError: true, errorSubtype, errors: [failure.evidence], failure };
}
