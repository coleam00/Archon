import { readContinuationGiveUp } from './schemas/continuation-give-up';
import type { QueuedRunAttention, WorkflowRun } from './schemas/workflow-run';
import { resumeCursorMatches } from './store/continuation-cursors';

/**
 * A paused run a continuation host stopped resuming, while it is still at the continuation
 * the host gave up on (`readContinuationGiveUp`); a later pause makes an old record inert.
 */
export function givenUpAttention(run: WorkflowRun): QueuedRunAttention | undefined {
  const givenUp = run.status === 'paused' ? readContinuationGiveUp(run.metadata) : undefined;
  if (givenUp === undefined) return undefined;
  if (!resumeCursorMatches(run, givenUp.cursor)) return undefined;
  return {
    kind: 'unreadable',
    runId: run.id,
    reason: 'continuation_given_up',
    detail: `a host stopped resuming it after ${String(givenUp.attempts)} failed reads of its frozen workflow source (${givenUp.path ?? 'path unavailable'}) at ${givenUp.at}. Resume it on a host that can read it with archon workflow resume ${run.id}, or abandon it with archon workflow abandon ${run.id}.`,
  };
}
