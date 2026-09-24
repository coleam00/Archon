import type { WorkflowTerminalProperties } from '@archon/paths';
import type { TokenUsage } from '@archon/providers/types';
import { readNodeRecordData } from './node-record-reader';
import { nodeDescriptorSchema, nodeFailureKindSchema } from './schemas/node-execution';
import { runCancelReasonSchema, runExitReasonSchema } from './schemas/run-terminal-reason';
import { terminalStatusSchema } from './schemas/terminal-record';
import { readRunDispatchMetadata, type WorkflowRun } from './schemas/workflow-run';
import { telemetryNodeType } from './telemetry-node-type';
import { getTerminalRecord } from './terminal-record';

/**
 * The event types {@link buildRunTerminalTelemetry} reads, so a caller can load only
 * those rows. The terminal record rides on the terminal event itself. Reading another
 * event type in the projection means adding it here.
 */
export const RUN_TELEMETRY_EVENT_TYPES = [
  'workflow_started',
  'workflow_completed',
  'workflow_failed',
  'workflow_cancelled',
  'node_failed',
  'loop_iteration_completed',
] as const;

export interface RunTelemetryEvent {
  event_type: string;
  step_name?: string | null;
  data: unknown;
  created_at: Date | string;
}

/**
 * Terminal telemetry for a run, projected from its row and durable event log at the
 * moment its terminal status committed. Every segment of a resumed run is in the log,
 * so duration and loop iterations accumulate across resumes; `usage` is the same
 * cumulative fold resume uses. Returns undefined when the run is not terminal.
 *
 * Only categorical values and numeric totals come out: the workflow name is redacted
 * by the capture's classifier unless the run's recorded source is `bundled`.
 */
export function buildRunTerminalTelemetry(input: {
  run: Pick<WorkflowRun, 'id' | 'workflow_name' | 'parent_run_id' | 'status' | 'metadata'>;
  events: readonly RunTelemetryEvent[];
  usage: { costUsd: number; tokens?: TokenUsage };
}): WorkflowTerminalProperties | undefined {
  const { run, events, usage } = input;
  const status = terminalStatusSchema.safeParse(run.status);
  if (!status.success) return undefined;

  const terminalEvent = lastEvent(events, e => e.event_type === `workflow_${status.data}`);
  const terminalData = terminalEvent ? readNodeRecordData(terminalEvent.data) : {};
  const started = events.find(e => e.event_type === 'workflow_started');
  const startedData = started ? readNodeRecordData(started.data) : {};
  const record = getTerminalRecord(run.status, events);

  const firstFailed =
    record?.first_failed_node == null
      ? undefined
      : lastEvent(
          events,
          e => e.event_type === 'node_failed' && e.step_name === record.first_failed_node
        );
  const failedData = firstFailed ? readNodeRecordData(firstFailed.data) : {};
  const failedNode = nodeDescriptorSchema.safeParse(failedData.node);
  const failureKind = nodeFailureKindSchema.safeParse(failedData.failure_kind);
  const exitReason = runExitReasonSchema.safeParse(terminalData.exit_reason);
  const cancelReason = runCancelReasonSchema.safeParse(terminalData.cancel_reason);
  const nodeStates = record?.nodes.map(node => node.state) ?? [];
  const loopIterations = events.filter(e => e.event_type === 'loop_iteration_completed').length;
  const origin = stringOf(startedData.origin);
  const provider = stringOf(startedData.provider);
  const model = stringOf(startedData.model);
  const source = readRunDispatchMetadata(run.metadata)?.source;

  return {
    outcome: status.data,
    runId: run.id,
    isChild: run.parent_run_id != null,
    workflowName: run.workflow_name,
    ...(source !== undefined ? { workflowSource: source } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(origin !== undefined ? { platform: origin } : {}),
    ...(started && terminalEvent
      ? { durationMs: Math.max(0, time(terminalEvent) - time(started)) }
      : {}),
    ...(record
      ? {
          nodesCompleted: nodeStates.filter(state => state === 'completed').length,
          nodesFailed: nodeStates.filter(state => state === 'failed').length,
          nodesSkipped: nodeStates.filter(state => state === 'skipped').length,
          nodesTotal: nodeStates.length,
        }
      : {}),
    ...(status.data === 'failed' && exitReason.success ? { exitReason: exitReason.data } : {}),
    ...(status.data === 'cancelled' && cancelReason.success
      ? { cancelReason: cancelReason.data }
      : {}),
    ...(firstFailed ? { errorClass: failureKind.success ? failureKind.data : 'unknown' } : {}),
    ...(failedNode.success ? { failedNodeType: telemetryNodeType(failedNode.data) } : {}),
    // Absent when no provider reported spend, so absence never reads as "free".
    ...(usage.costUsd > 0 ? { costUsd: usage.costUsd } : {}),
    ...(usage.tokens !== undefined
      ? {
          tokensIn: usage.tokens.input,
          tokensOut: usage.tokens.output,
          ...(usage.tokens.cacheRead !== undefined
            ? { cacheReadTokens: usage.tokens.cacheRead }
            : {}),
          ...(usage.tokens.cacheWrite !== undefined
            ? { cacheWriteTokens: usage.tokens.cacheWrite }
            : {}),
          ...(usage.tokens.cachePartial ? { cachePartialTokens: true as const } : {}),
        }
      : {}),
    ...(loopIterations > 0 ? { loopIterations } : {}),
  };
}

function lastEvent(
  events: readonly RunTelemetryEvent[],
  match: (event: RunTelemetryEvent) => boolean
): RunTelemetryEvent | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event !== undefined && match(event)) return event;
  }
  return undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function time(event: RunTelemetryEvent): number {
  return new Date(event.created_at).getTime();
}
