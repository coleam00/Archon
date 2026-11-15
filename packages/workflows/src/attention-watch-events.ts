/**
 * What a run's row and its events say about an attention item that closed and a run that
 * ended, for the attention stream (`attention-watch.ts`).
 */
import { createLogger } from '@archon/paths';
import { recordSurfaceSchema } from './schemas/record-surface';
import type { WorkflowEventRow } from './schemas/workflow-event';
import {
  attentionAnswererSchema,
  attentionOccurrence,
  gateOccurrence,
  isApprovalContext,
  isGateResolved,
  isWorkflowWaitContext,
  type AttentionAnswerer,
  type AttentionAnsweringRun,
  type RunTerminalStatus,
  type WorkflowRun,
} from './schemas/workflow-run';
import type { WorkflowEventPage } from './store';
import { failedOutcomeReason, getTerminalRecord } from './terminal-record';

function getLog(): ReturnType<typeof createLogger> {
  return createLogger('workflow.attention_watch');
}

export type Resolution =
  | {
      reason: 'answered';
      answeredVia: string | null;
      answeredBy: AttentionAnswerer | null;
      answeredFromRun: AttentionAnsweringRun | null;
      answeredAt: string | null;
    }
  | { reason: 'withdrawn' };

export type Answered = Omit<Extract<Resolution, { reason: 'answered' }>, 'answeredFromRun'>;

/** How `occurrence` closed, from the row when it still records the answer. */
export function rowResolution(run: WorkflowRun, occurrence: string | null): Answered | undefined {
  if (occurrence === null) return undefined;
  const { approval, wait } = run.metadata;
  if (isApprovalContext(approval) && gateOccurrence(approval) === occurrence)
    return isGateResolved(approval)
      ? {
          reason: 'answered',
          answeredVia: approval.answeredVia ?? null,
          answeredBy: null,
          answeredAt: approval.answeredAt ?? null,
        }
      : undefined;
  if (
    isWorkflowWaitContext(wait) &&
    wait.kind === 'attention' &&
    attentionOccurrence(wait) === occurrence &&
    wait.answer !== undefined
  )
    return {
      reason: 'answered',
      answeredVia: wait.answeredVia ?? null,
      answeredBy: wait.answeredBy ?? null,
      answeredAt: wait.answeredAt ?? null,
    };
  return undefined;
}

export const answerKey = (runId: string, occurrence: string): string =>
  `${runId}\u0000${occurrence}`;

export type AnswerOrigin = Pick<Answered, 'answeredVia' | 'answeredBy'>;

/** The surface and answerer of each answer event in a page, by run and occurrence. */
export function indexAnswers(page: WorkflowEventPage): Map<string, AnswerOrigin> {
  const answers = new Map<string, AnswerOrigin>();
  for (const { event } of page.events) {
    if (event.event_type !== 'approval_received' && event.event_type !== 'wait_answered') continue;
    const { occurrence, via, by } = event.data;
    if (typeof occurrence !== 'string') continue;
    const surface = recordSurfaceSchema.safeParse(via);
    const answerer = attentionAnswererSchema.safeParse(by);
    answers.set(answerKey(event.workflow_run_id, occurrence), {
      answeredVia: surface.success ? surface.data : null,
      answeredBy: answerer.success ? answerer.data : null,
    });
  }
  return answers;
}

/** What the terminal record riding on `event` says, or nulls when it cannot be read. */
export function terminalFacts(
  event: WorkflowEventRow,
  status: RunTerminalStatus
): { outcome: 'succeeded' | 'failed' | null; firstFailedNode: string | null; reason: string[] } {
  try {
    const record = getTerminalRecord(status, [event]);
    return {
      outcome: record?.outcome ?? null,
      firstFailedNode: record?.first_failed_node ?? null,
      reason:
        status === 'failed' && event.data.exit_reason === 'launch_failed'
          ? ['launch failed before the first node']
          : failedOutcomeReason(record),
    };
  } catch (error) {
    // A malformed record must not stall the stream on one row; the line still reports
    // the status, and `workflow get` remains the full read.
    getLog().warn(
      { err: error as Error, runId: event.workflow_run_id, eventId: event.id },
      'workflow.attention_watch_terminal_record_unreadable'
    );
    return { outcome: null, firstFailedNode: null, reason: [] };
  }
}
