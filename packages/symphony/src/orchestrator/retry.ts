import type { ConfigSnapshot } from '../config/snapshot';

export type DelayKind = 'continuation' | 'failure';

/**
 * Compute the retry delay for a failed (or to-be-continued) dispatch attempt.
 * Continuation delays are constant; failure delays grow exponentially with the
 * attempt number, capped at `snapshot.dispatch.retry.maxBackoffMs`.
 */
export function computeRetryDelayMs(
  delayKind: DelayKind,
  attempt: number,
  snapshot: ConfigSnapshot
): number {
  if (delayKind === 'continuation') {
    return snapshot.dispatch.retry.continuationDelayMs;
  }
  const base = snapshot.dispatch.retry.failureBaseDelayMs;
  const exp = Math.max(0, attempt - 1);
  const raw = base * Math.pow(2, exp);
  return Math.min(raw, snapshot.dispatch.retry.maxBackoffMs);
}
