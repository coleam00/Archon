import type { Run } from '../primitives/run';
import { isRunLive } from './run-status';

/** How long a running run may record nothing before its card says so. */
export const QUIET_AFTER_MS = 10 * 60_000;

/**
 * How long a run has recorded nothing, when that is long enough to flag; null otherwise.
 * Only a live running run is flagged: a paused run shows its wait, and a run whose owner
 * is gone already says so. A run inside a `bash:` or `script:` step is never flagged,
 * because such a step records nothing until it ends and a long command is not a stall.
 */
export function runQuietMs(
  run: Pick<Run, 'status' | 'ownerObservation' | 'progress'>,
  now: number
): number | null {
  const progress = run.progress;
  if (!isRunLive(run) || progress?.last_observed_at == null) return null;
  if (progress.steps.some(step => step.state === 'running' && step.kind === 'exec')) return null;
  const silentMs = now - Date.parse(progress.last_observed_at);
  return silentMs >= QUIET_AFTER_MS ? silentMs : null;
}

export function lastActivityLabel(lastObservedAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(lastObservedAt)) / 60_000);
  return minutes < 1 ? 'active just now' : `active ${minutes.toString()}m ago`;
}

export function quietMinutes(quietMs: number): number {
  return Math.floor(quietMs / 60_000);
}
