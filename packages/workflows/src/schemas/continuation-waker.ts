/**
 * What may resume a due continuation on this install: the recorded wakers
 * (`IWorkflowStore.listContinuationWakers`). A paused wait past its deadline, an answered
 * gate or a released source moves on only when a waker passes, so the attention queue
 * lists a due continuation as `owner_lost` once no recorded waker can pass again.
 */
import { isOwnerProvablyGone, type ProcessOwner } from '@archon/paths/process-owner';

/**
 * `process`: `archon serve` or `archon workflow wake --watch`, gone when its process is
 * provably gone. `schedule`: a native job `wake schedule install` installed, which restarts
 * the watcher when it exits; removed by `wake schedule remove`. `pass`: a one-shot
 * `archon workflow wake`, which something outside Archon (cron, CI) may run again.
 */
export type ContinuationWaker =
  | ({ kind: 'process' } & ProcessOwner)
  | { kind: 'schedule' | 'pass'; host: string };

/**
 * Why no waker can resume a due continuation, or null when one may: none was ever
 * recorded, or every recorded one is a process this host proves gone. A schedule, a
 * one-shot pass, or a waker on another host may still pass, so it lists nothing.
 */
export function noLiveWaker(
  wakers: readonly ContinuationWaker[]
): 'none_recorded' | 'all_gone' | null {
  if (wakers.length === 0) return 'none_recorded';
  return wakers.every(waker => waker.kind === 'process' && isOwnerProvablyGone(waker))
    ? 'all_gone'
    : null;
}
