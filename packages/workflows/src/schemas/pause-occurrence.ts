/**
 * Occurrence ids: which pause an answer resolved. A pause carries its `pauseId`; a pause
 * from before pause identities existed is named `legacy:<step>`.
 */
import type { ApprovalContext } from './approval-context';
import { type WorkflowAttentionWaitContext, workflowWaitStepName } from './run-wait';

const LEGACY_OCCURRENCE_PREFIX = 'legacy:';

/**
 * The step a `legacy:<step>` occurrence names, or undefined for a pause id. A legacy
 * occurrence identifies a pause from before pause identities existed.
 */
export function legacyOccurrenceStep(occurrence: string): string | undefined {
  return occurrence.startsWith(LEGACY_OCCURRENCE_PREFIX)
    ? occurrence.slice(LEGACY_OCCURRENCE_PREFIX.length)
    : undefined;
}

/**
 * The occurrence id of an attention wait, by the same rule as `gateOccurrence`: its
 * `pauseId`, or `legacy:<step>` for a wait paused before pause identities existed.
 */
export function attentionOccurrence(wait: WorkflowAttentionWaitContext): string {
  return wait.pauseId ?? `${LEGACY_OCCURRENCE_PREFIX}${workflowWaitStepName(wait)}`;
}

/**
 * The occurrence id of a gate pause: its `pauseId`, or `legacy:<nodeId>` for a gate paused
 * before pause identities existed. Run-attention reports it and answers record it, so a
 * reader can tie an answer to the exact pause it resolved.
 */
export function gateOccurrence(approval: Pick<ApprovalContext, 'nodeId' | 'pauseId'>): string {
  return approval.pauseId ?? `${LEGACY_OCCURRENCE_PREFIX}${approval.nodeId}`;
}
