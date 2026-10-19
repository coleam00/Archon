/**
 * Why a run is paused, recorded in run metadata by the same write that pauses it
 * (`PAUSE_CAUSE_METADATA_KEY`). Resume reads it to tell a run that paused at a node that
 * waits on purpose from one that paused because something failed: the earlier pause
 * contexts (`approval`, `wait`, `source_release`) can outlive the pause they belonged to,
 * so they cannot answer that question. Failing a run removes the key.
 */
import { z } from 'zod';
import type { ApprovalContext, WorkflowWaitContext } from './workflow-run';

export const PAUSE_CAUSE_METADATA_KEY = 'pause_cause';

export const pauseCauseSchema = z.enum(['wait', 'gate', 'child', 'quota', 'source_release']);
export type PauseCause = z.infer<typeof pauseCauseSchema>;

/** The cause a wait pause records: a provider-limit wait is a failure, every other wait is not. */
export function pauseCauseOfWait(wait: WorkflowWaitContext): PauseCause {
  return wait.kind === 'quota' ? 'quota' : 'wait';
}

/** The cause a gate pause records: blocked on children, or a gate someone answers. */
export function pauseCauseOfApproval(approval: ApprovalContext): PauseCause {
  return approval.type === 'child_workflow' || approval.type === 'fan_out' ? 'child' : 'gate';
}

/**
 * The recorded cause, or undefined when the run carries none (paused by an older binary,
 * or never paused) or one this binary does not know.
 */
export function readPauseCause(
  metadata: Record<string, unknown> | undefined
): PauseCause | undefined {
  const parsed = pauseCauseSchema.safeParse(metadata?.[PAUSE_CAUSE_METADATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}
