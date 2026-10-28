import type { WorkflowRun } from './schemas/workflow-run';
import {
  CAPACITY_WAIT_METADATA_KEY,
  RUN_STOP_REASON_METADATA_KEY,
  SOURCE_RELEASE_METADATA_KEY,
  TOOL_CALL_ATTENTION_METADATA_KEY,
  isScheduledWorkflowResume,
  pausedUsageLimitWait,
} from './schemas/workflow-run';
import {
  EXECUTION_CLAIM_METADATA_KEY,
  workflowUnpausedEvent,
  type WorkflowEventInput,
} from './store';

/** Null patch values clear metadata; each adapter applies its native merge semantics. */
export function resumeTransition(run: Pick<WorkflowRun, 'id' | 'status' | 'metadata'>): {
  metadataPatch: WorkflowRun['metadata'];
  events: WorkflowEventInput[];
} {
  const metadataPatch: WorkflowRun['metadata'] = {
    [TOOL_CALL_ATTENTION_METADATA_KEY]: null,
    error: null,
    [RUN_STOP_REASON_METADATA_KEY]: null,
    continuation_retry_at: null,
    [CAPACITY_WAIT_METADATA_KEY]: null,
    [SOURCE_RELEASE_METADATA_KEY]: null,
    [EXECUTION_CLAIM_METADATA_KEY]: crypto.randomUUID(),
  };
  const events: WorkflowEventInput[] = [];
  const error =
    typeof run.metadata.error === 'string' && run.metadata.error !== '' ? run.metadata.error : null;
  if (run.status === 'failed' || error !== null)
    events.push({
      workflow_run_id: run.id,
      event_type: 'workflow_resumed',
      data: error === null ? {} : { error },
    });
  if (run.status === 'paused') events.push(workflowUnpausedEvent(run.id));
  // A usage-limit wait ends at admission so its nodes can run again.
  if (pausedUsageLimitWait(run)) metadataPatch.wait = null;
  const scheduled = run.metadata.scheduled_resume;
  if (
    run.status === 'failed' &&
    isScheduledWorkflowResume(scheduled) &&
    scheduled.triggeredAt === undefined
  ) {
    metadataPatch.scheduled_resume = { ...scheduled, triggeredAt: new Date().toISOString() };
    events.push({
      workflow_run_id: run.id,
      event_type: 'quota_resume_triggered',
      data: { attempt: scheduled.attempt, resume_at: scheduled.resumeAt },
    });
  }
  return { metadataPatch, events };
}
