import { hostname } from 'node:os';
import { serializeNodeStateRecord } from '../node-record-serialization';
import type { NodeExecutionRecord } from '../schemas/node-execution';
import { PAUSE_CAUSE_METADATA_KEY, type PauseCause } from '../schemas/pause-cause';
import type { RunCancelReason } from '../schemas/run-terminal-reason';
import type { ExecutionOwnerRecord } from '../schemas/run-metadata';
import {
  OPERATOR_PAUSE_METADATA_KEY,
  operatorPause,
  readOperatorPauseRecord,
  type OperatorPause,
  type OperatorPauseRecord,
} from '../schemas/operator-pause';
import type { WorkflowRun } from '../schemas/workflow-run';
import {
  SOURCE_RELEASE_METADATA_KEY,
  workflowWaitStepName,
  type AttentionAnswer,
  type SourceRelease,
  type WorkflowWaitContext,
} from '../schemas/workflow-run';
import type { WorkflowWaitResult } from '../schemas/wait-node';
import { attentionAskRecord } from './attention-writes';
import type { NodeStateEventInput, ObservabilityEventInput } from './event-types';

/** Durable wait outcome committed atomically with consumption of its active cursor. */
export interface WorkflowWaitCompletion {
  execution?: NodeExecutionRecord;
  stepName: string;
  result: WorkflowWaitResult;
  /** An attention wait's answer: the node's output in place of `result`. */
  answer?: AttentionAnswer;
}

export type WorkflowWaitPause = { kind: 'started'; stepName: string } | { kind: 'continued' };

/**
 * The audit row of a new wait pause, written in the pause's transaction by every store.
 * An attention wait records the labels it opened with and its ask record
 * (`attentionAskRecord`), which is what `countAttentionWaitStarts` counts once the wait
 * is answered and its context is gone.
 */
export function waitStartedEvent(
  workflowRunId: string,
  wait: WorkflowWaitContext,
  stepName: string
): ObservabilityEventInput {
  return {
    workflow_run_id: workflowRunId,
    event_type: 'wait_started',
    step_name: stepName,
    data: {
      kind: wait.kind,
      ...(wait.kind === 'attention'
        ? { labels: wait.labels ?? {}, ...attentionAskRecord(wait) }
        : { resume_at: wait.resumeAt }),
      ...(wait.kind === 'event' ? { event: wait.event } : {}),
    },
  };
}

/** The audit row of a continued wait pause, written in the pause's transaction by every store. */
export function waitContinuedEvent(
  workflowRunId: string,
  wait: WorkflowWaitContext
): ObservabilityEventInput {
  return {
    workflow_run_id: workflowRunId,
    event_type: 'wait_continued',
    step_name: workflowWaitStepName(wait),
    data: { kind: wait.kind },
  };
}

export const DETACHED_LAUNCH_METADATA_KEY = 'cli_detached_launch_token';
export const EXECUTION_CLAIM_METADATA_KEY = 'execution_claim';

/** The initial execution has no token; resumes mint one so old executors cannot release a later claim. */
export function executionClaim(metadata: Record<string, unknown>): string | null {
  const claim = metadata[EXECUTION_CLAIM_METADATA_KEY];
  return typeof claim === 'string' ? claim : null;
}

/**
 * The owner record of the calling process. Every store records it in the same update that
 * makes a run `running` for that process (a pending claim or a resume), because the process
 * that claims or resumes a run is the one that executes it. A resumer on another host then
 * reads the new owner, not the previous one, and refuses instead of starting a second
 * executor before the new owner stamps the row.
 */
export function currentExecutionOwner(): ExecutionOwnerRecord {
  const uid = process.getuid?.();
  return { host: hostname(), pid: process.pid, ...(uid === undefined ? {} : { uid }) };
}

/** What `releaseRunForUnreadableSource` records about the node whose source could not be read. */
export interface SourceReleaseWrite {
  claimId: string | null;
  nodeId: string;
  path?: string;
  error: string;
  retryAt: string;
}

/** The metadata patch every store's source release merges into the run row. */
export function sourceReleaseMetadata(
  release: SourceReleaseWrite,
  releasedAt: string
): Record<string, unknown> {
  const record: SourceRelease = {
    nodeId: release.nodeId,
    releaseId: crypto.randomUUID(),
    releasedAt,
    ...(release.path !== undefined ? { path: release.path } : {}),
  };
  return {
    [SOURCE_RELEASE_METADATA_KEY]: record,
    continuation_retry_at: release.retryAt,
    [PAUSE_CAUSE_METADATA_KEY]: 'source_release' satisfies PauseCause,
  };
}

/** The row every store's source release commits with its write. */
export function sourceReleasedEvent(
  workflowRunId: string,
  release: SourceReleaseWrite
): ObservabilityEventInput {
  return {
    workflow_run_id: workflowRunId,
    event_type: 'source_released',
    step_name: release.nodeId,
    data: {
      node_id: release.nodeId,
      ...(release.path !== undefined ? { path: release.path } : {}),
      error: release.error,
      retry_at: release.retryAt,
    },
  };
}

/** The pause request a running run holds after an operator asked; `alreadyRequested` when an earlier one was pending. */
export interface OperatorPauseRequest {
  requested: OperatorPause['requested'];
  alreadyRequested: boolean;
}

/**
 * What every store's `requestOperatorPause` does to `run`, decided under its lock: nothing
 * when the run is not running, nothing but report the pending request when one is, otherwise
 * write `requested` as the run's request.
 */
export function operatorPauseRequestWrite(
  run: Pick<WorkflowRun, 'status' | 'metadata'>,
  requested: OperatorPause['requested']
): { request: OperatorPauseRequest; metadata?: Record<string, unknown> } | undefined {
  if (run.status !== 'running') return undefined;
  const pending = operatorPause(run);
  if (pending !== null)
    return { request: { requested: pending.requested, alreadyRequested: true } };
  const record: OperatorPauseRecord = { requested };
  return {
    request: { requested, alreadyRequested: false },
    metadata: { [OPERATOR_PAUSE_METADATA_KEY]: record },
  };
}

/**
 * The write that pauses a run for an operator's pause request, or undefined when it must
 * not: the run is no longer `running`, another execution claimed it, or no request is
 * pending. Every store applies it with the row's status set to `paused`, in one
 * transaction with the event.
 */
export function operatorPauseWrite(
  run: Pick<WorkflowRun, 'id' | 'status' | 'metadata'>,
  claimId: string | null,
  pausedAt: string
): { metadata: Record<string, unknown>; event: ObservabilityEventInput } | undefined {
  const record = readOperatorPauseRecord(run.metadata);
  if (
    run.status !== 'running' ||
    executionClaim(run.metadata) !== claimId ||
    record === undefined ||
    record.pausedAt !== undefined
  )
    return undefined;
  const paused: OperatorPauseRecord = { ...record, pausedAt };
  return {
    metadata: {
      [OPERATOR_PAUSE_METADATA_KEY]: paused,
      [PAUSE_CAUSE_METADATA_KEY]: 'operator' satisfies PauseCause,
    },
    event: {
      workflow_run_id: run.id,
      event_type: 'operator_paused',
      data: { requested: record.requested, paused_at: pausedAt },
    },
  };
}

/** The row every store's resume CAS writes when it moves a paused run back to running. */
export function workflowUnpausedEvent(workflowRunId: string): ObservabilityEventInput {
  return { workflow_run_id: workflowRunId, event_type: 'workflow_unpaused', data: {} };
}
/**
 * The two rows a wait's completion produces: the wait outcome for observability and
 * the node's own completed state. A wait completes on one of two paths, in the same
 * tick inside the executor or on resume inside the store's cursor-clearing
 * transaction, and both paths must write the same rows for the same result. This is
 * the only place that knows their shape.
 */
export function waitCompletionEvents(
  workflowRunId: string,
  completion: WorkflowWaitCompletion
): { outcome: ObservabilityEventInput; node: NodeStateEventInput } {
  const { stepName, result } = completion;
  const output = completion.answer ?? result;
  return {
    outcome: {
      workflow_run_id: workflowRunId,
      event_type: result.status === 'expired' ? 'wait_expired' : 'wait_completed',
      step_name: stepName,
      data: result,
    },
    node:
      completion.execution !== undefined
        ? serializeNodeStateRecord(completion.execution)
        : {
            workflow_run_id: workflowRunId,
            event_type: 'node_completed',
            step_name: stepName,
            data: {
              type: 'wait',
              duration_ms: result.waited_ms,
              node_output: JSON.stringify(output),
              structured_output: output,
            },
          },
  };
}

export const FAN_OUT_CANCEL_REASONS = [
  'fan_out_gate',
  'fan_out_sibling',
  'fan_out_orphan',
  'fan_out_checkout_check',
] as const;
export type FanOutCancelReason = (typeof FAN_OUT_CANCEL_REASONS)[number];

export interface WorkflowCancellationEventDetails {
  warnings?: string[];
  step_name?: string;
  reason?: string;
  /** Categorical cause, reported to telemetry; `reason` is free text and never is. */
  cancel_reason?: RunCancelReason;
  /** A start refused because this run held its item (`holdsItem`), so item reads can name it. */
  held_by_run_id?: string;
}
