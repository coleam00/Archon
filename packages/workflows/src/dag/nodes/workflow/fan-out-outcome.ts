import type { WorkflowDeps } from '../../../deps';
import type { WorkflowRun } from '../../../schemas';
import { isTerminalRunStatus, readSubrunMetadata } from '../../../schemas';
import { TERMINAL_RUN_EVENT_TYPE } from '../../../schemas/workflow-run';
import {
  fanOutOutcome,
  type FanOutCancelledOutcome,
  type FanOutOutcome,
  type FanOutSlot,
} from '../../../schemas/fan-out-outcome';
import { runCancelReasonSchema, type RunCancelReason } from '../../../schemas/run-terminal-reason';
import { FAN_OUT_CANCEL_REASONS } from '../../../store';
import type { ChildWorkflowOutcome } from '../../child-run';
import { findFanOutChildRuns } from './fan-out-children';

const FAN_OUT_ROW_TAGS: ReadonlySet<string> = new Set(FAN_OUT_CANCEL_REASONS);

function rowCancelTag(row: WorkflowRun): string | undefined {
  const tag = (row.metadata as Record<string, unknown> | undefined)?.cancelled_reason;
  return typeof tag === 'string' ? tag : undefined;
}

/**
 * Who cancelled a child. A fan-out row tag is engine-owned even without a recorded reason
 * (tags predate `cancel_reason`); otherwise the reason the canceller recorded decides.
 */
export function cancelledOutcomeFor(
  reason: RunCancelReason | undefined,
  rowTag: string | undefined
): FanOutCancelledOutcome {
  if (rowTag !== undefined && FAN_OUT_ROW_TAGS.has(rowTag)) return 'cancelled_by_engine';
  if (reason === undefined) return 'cancelled_unattributed';
  switch (reason) {
    case 'fan_out':
    case 'precondition_failed':
      return 'cancelled_by_engine';
    case 'halt_node':
    case 'approval_rejected':
      return 'cancelled_by_workflow';
    case 'operator':
    case 'conversation_reset':
      return 'cancelled_out_of_band';
  }
}

/**
 * One slot's outcome. The child row decides once it is terminal, so a pass, a continuation
 * and a recovery classify the same child the same way whatever this pass observed; the
 * pass's outcome stands only where no terminal row exists.
 */
export function classifyFanOutSlot(
  index: number,
  outcome: ChildWorkflowOutcome,
  row: WorkflowRun | undefined,
  cancelReason: RunCancelReason | undefined
): FanOutSlot {
  if (row === undefined) {
    if (outcome.status === 'completed') {
      return { index, outcome: 'completed', child_run_id: outcome.childRunId };
    }
    return { index, outcome: 'not_started', error: outcome.error ?? `child ${outcome.status}` };
  }
  const status = isTerminalRunStatus(row.status) ? row.status : outcome.status;
  switch (status) {
    case 'completed':
      return { index, outcome: 'completed', child_run_id: row.id };
    case 'failed': {
      const rowError = (row.metadata as Record<string, unknown> | undefined)?.error;
      const error = outcome.error ?? (typeof rowError === 'string' ? rowError : undefined);
      return {
        index,
        outcome: 'failed',
        child_run_id: row.id,
        ...(error !== undefined ? { error } : {}),
      };
    }
    case 'cancelled':
      return {
        index,
        outcome: cancelledOutcomeFor(cancelReason, rowCancelTag(row)),
        child_run_id: row.id,
        ...(cancelReason !== undefined ? { cancel_reason: cancelReason } : {}),
      };
    case 'paused':
      throw new Error(`fan-out slot ${String(index)} settled on a paused child ${row.id}`);
  }
}

/**
 * Build the fan-out outcome once every slot has settled. All-completed needs no store read;
 * otherwise the node's child rows, and the cancel events of its cancelled rows, are
 * read once each. A read failure is returned, never classified, so a slot is never
 * reported from a guess.
 */
export async function buildFanOutOutcome(
  store: WorkflowDeps['store'],
  parentRunId: string,
  stepName: string,
  outcomes: readonly ChildWorkflowOutcome[]
): Promise<{ outcome: FanOutOutcome } | { lookupError: unknown }> {
  if (outcomes.every(o => o.status === 'completed')) {
    return {
      outcome: fanOutOutcome(
        outcomes.map((o, index) => ({ index, outcome: 'completed', child_run_id: o.childRunId }))
      ),
    };
  }
  try {
    const rowsByIndex = new Map<number, WorkflowRun>();
    for (const row of await findFanOutChildRuns(store, parentRunId, stepName)) {
      const index = readSubrunMetadata(row.metadata).childIndex;
      if (index !== undefined && index >= 0 && index < outcomes.length) {
        rowsByIndex.set(index, row);
      }
    }
    const reasons = await readCancelReasons(store, [...rowsByIndex.values()]);
    return {
      outcome: fanOutOutcome(
        outcomes.map((o, index) => {
          const row = rowsByIndex.get(index);
          return classifyFanOutSlot(index, o, row, row ? reasons.get(row.id) : undefined);
        })
      ),
    };
  } catch (lookupError) {
    return { lookupError };
  }
}

/** The last recorded `cancel_reason` of each cancelled row. */
async function readCancelReasons(
  store: WorkflowDeps['store'],
  rows: readonly WorkflowRun[]
): Promise<Map<string, RunCancelReason>> {
  const ids = rows.filter(row => row.status === 'cancelled').map(row => row.id);
  const reasons = new Map<string, RunCancelReason>();
  if (ids.length === 0) return reasons;
  const events = await store.listEventsForRuns(ids, [TERMINAL_RUN_EVENT_TYPE.cancelled]);
  for (const [runId, rowsForRun] of events) {
    for (const event of rowsForRun) {
      const parsed = runCancelReasonSchema.safeParse(event.data.cancel_reason);
      if (parsed.success) reasons.set(runId, parsed.data);
    }
  }
  return reasons;
}
