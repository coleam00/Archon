import { recordDerivedExecution } from '@archon/workflows/node-event-write';
import { logGateDecision } from '@archon/workflows/logger';
import { readNodeRecordEvent } from '@archon/workflows/node-record-reader';
import {
  serializeNodeEmitter,
  serializeNodeStateRecord,
} from '@archon/workflows/node-record-serialization';
import { getWorkflowEventEmitter } from '@archon/workflows/event-emitter';
import { getStoragePathsForRoot, resolveRunStorageRoot } from '@archon/paths/archon-paths';
import { finishNodeExecution } from '@archon/workflows/node-execution';
import { nodeExecutionMetadataSchema } from '@archon/workflows/schemas/node-execution';
import { gateOccurrence } from '@archon/workflows/schemas/workflow-run';
import type { ApprovalContext, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { GateResolutionEvent } from '@archon/workflows/store';
import { getLog } from './context';
import type { GateAnswerOrigin } from './answer-admission';

/**
 * The `step_name` a gate resolution's `node_completed` event should be written
 * under. Ordinarily just `approval.nodeId`. On an ESCALATED body-terminal-gate
 * pause (#2707 step 3), `nodeId` holds the ENCLOSING loop_group's id instead —
 * required so the top-level DAG's resume walk finds it — and `bodyGateId`
 * carries the actual gate's own id. Namespacing the write as `<nodeId>.
 * <bodyGateId>` matches the exact `<groupId>.<bodyId>` step name #2748's
 * `outerNodeOutputs` pre-population already keys on, so the gate's own
 * resolved decision is findable again after a resume the same way any other
 * body node's output is. Every other pause kind has no `bodyGateId`, so this
 * is a no-op there.
 */
function resolvedNodeCompletedStepName(approval: ApprovalContext): string {
  return approval.bodyGateId !== undefined
    ? `${approval.nodeId}.${approval.bodyGateId}`
    : approval.nodeId;
}

/**
 * Mirror a won gate transaction into the run's own transcript. Publish only after the
 * CAS wins; the inserted rows remain authoritative and every sink derives from them.
 *
 * This usually runs in the approving process, not the one executing the run, so the
 * transcript is found the way every out-of-process reader finds it: through the run's
 * persisted `output_root`, then appended through the same writer the executor uses.
 *
 * With no trusted `output_root` there is no transcript location to find. Usually the
 * run's identity lookup faulted at start and its fault-derived root was deliberately
 * never persisted; that lasts until a later resume resolves identity and records the
 * root. A persisted root outside `ARCHON_HOME` is refused the same way, for the life of
 * the run. Either way the rows are skipped, visibly, rather than written to a second
 * file under a guessed root.
 *
 * A completion row with no execution metadata to publish is skipped visibly the same
 * way: once the root resolved, the gate decision beside it still reaches the
 * transcript, so an operator must be able to tell the approval was recorded and its
 * completion was not.
 */
export async function publishGateExecution(
  run: WorkflowRun,
  events: readonly GateResolutionEvent[]
): Promise<void> {
  const root = resolveRunStorageRoot(run, null);
  const logDir = root === null ? null : getStoragePathsForRoot(root).logsDir;
  if (logDir === null) {
    getLog().warn(
      {
        runId: run.id,
        steps: events.map(event => event.step_name),
        eventTypes: events.map(event => event.event_type),
      },
      'workflow.gate_transcript_root_missing'
    );
  }
  for (const event of events) {
    if (event.event_type === 'approval_received') {
      if (logDir !== null) await publishGateDecision(run.id, logDir, event.step_name, event.data);
    } else if (event.event_type === 'node_completed') {
      await publishGateCompletion(run.id, logDir, event);
    }
  }
}

async function publishGateDecision(
  runId: string,
  logDir: string,
  step: string,
  data: Record<string, unknown>
): Promise<void> {
  const { decision, comment, reason } = data;
  if (typeof decision !== 'string') return;
  // Approve and respond record `comment`, reject records `reason`; a write-back
  // reject records neither. Carried verbatim, like the run's own prompt on
  // `workflow_start`: this is the run record the DB already holds, not an
  // operational log line.
  const text = typeof comment === 'string' ? comment : reason;
  await logGateDecision(logDir, runId, {
    step,
    decision,
    ...(typeof text === 'string' ? { comment: text } : {}),
  });
}

async function publishGateCompletion(
  runId: string,
  logDir: string | null,
  event: GateResolutionEvent
): Promise<void> {
  const record = readNodeRecordEvent({ workflow_run_id: runId, ...event })?.metadata;
  if (record === undefined) {
    // A gate paused by a build predating `approval.execution`, not a damaged
    // record: gateCompletionEvent built this event in this process and writes all
    // of an execution or none of it. The reader's other `undefined` return — an
    // envelope with no step name, or an event type it does not track — is not
    // reachable from a gate resolution, and its partial-metadata case throws.
    getLog().warn({ runId, step: event.step_name }, 'workflow.gate_transcript_metadata_missing');
    return;
  }
  if (logDir === null) {
    const emitted = serializeNodeEmitter(record);
    if (emitted !== undefined) getWorkflowEventEmitter().emit(emitted);
    return;
  }
  await recordDerivedExecution({ logDir }, record);
}

/** New gates retain their observed identity; old gates complete without invented history. */
export function gateCompletionEvent(
  runId: string,
  approval: ApprovalContext,
  decision: string,
  text: string,
  structured?: { decision: string; text: string }
): GateResolutionEvent {
  if (approval.execution !== undefined) {
    const execution = nodeExecutionMetadataSchema.parse(approval.execution);
    if (execution.runId !== runId || execution.node.kind !== 'gate') {
      throw new Error(`Gate execution identity does not belong to run ${runId}`);
    }
    const event = serializeNodeStateRecord(
      finishNodeExecution(
        execution,
        { status: 'completed' },
        {
          output: { text, structured },
          diagnostics: { approvalDecision: decision },
        }
      )
    );
    return { event_type: event.event_type, step_name: event.step_name, data: event.data };
  }
  return {
    event_type: 'node_completed',
    step_name: resolvedNodeCompletedStepName(approval),
    data: {
      node_output: text,
      approval_decision: decision,
      ...(structured !== undefined ? { structured_output: structured } : {}),
    },
  };
}

/** The gate context a resolution writes: the decision plus the answer's surface and time. */
export function answeredGate(
  approval: ApprovalContext | undefined,
  resolved: 'approved' | 'rejected',
  origin: GateAnswerOrigin
): Record<string, unknown> {
  return {
    ...approval,
    resolved,
    answeredVia: origin.via,
    answeredAt: new Date().toISOString(),
  };
}

/** The occurrence an answer resolved, recorded on its audit event; absent when the gate is unreadable. */
export function answerOccurrence(approval: ApprovalContext | undefined): { occurrence?: string } {
  return approval === undefined ? {} : { occurrence: gateOccurrence(approval) };
}
