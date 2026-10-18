import { formatDuration } from '@archon/paths/duration';
import { toolCallDisplayName } from '@archon/provider-contract';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import { providerEventEnvelopeSchema } from '@archon/workflows/schemas/provider-event';
import type { WorkflowEmitterEvent } from '@archon/workflows/event-emitter';
import { readNodeEmitterEvent } from '@archon/workflows/node-event-write';
import { formatSkipCause } from './workflow-node-summaries';

/**
 * Tool calls this subscription saw start and not yet close, keyed by attempt and call id,
 * so a completion line can name its tool and duration. One per run subscription.
 */
export type OpenToolCalls = Map<string, { name: string; observedAt: string }>;

/**
 * The wording of a node's progress lines. A foreground run renders them from persisted
 * event rows and `workflow logs --format text` from transcript rows; both call these so
 * the lines are worded alike. The label differs: the foreground names a command node by
 * its command, the transcript by its node id, which is all its failure and skip rows record.
 */
export const nodeLine = {
  started: (name: string, detail = ''): string => `[${name}] Started${detail}`,
  completed: (name: string, durationMs?: number): string =>
    `[${name}] Completed${durationMs === undefined ? '' : ` (${formatDuration(durationMs)})`}`,
  failed: (name: string, error: string): string => `[${name}] Failed: ${error}`,
  skipped: (name: string, why: string): string => `[${name}] Skipped (${why})`,
};

function nodeEventLine(event: WorkflowEmitterEvent): string | undefined {
  switch (event.type) {
    case 'node_started': {
      let suffix = '';
      if (event.provider !== undefined && event.model !== undefined) {
        const tierPart = event.tier !== undefined ? ` ← ${event.tier}` : '';
        suffix = `  (${event.provider}/${event.model}${tierPart})`;
      }
      return nodeLine.started(event.nodeName, suffix);
    }
    case 'node_completed':
      return nodeLine.completed(event.nodeName, event.duration);
    case 'node_failed':
      return nodeLine.failed(event.nodeName, event.error);
    case 'node_skipped':
      return nodeLine.skipped(event.nodeName, formatSkipCause(event.cause));
    case 'node_skipped_prior_success':
      return nodeLine.skipped(event.nodeName, 'prior_success');
    default:
      return undefined;
  }
}

function containerLine(phase: string, data: Record<string, unknown>): string {
  const id = typeof data.containerId === 'string' ? data.containerId : '';
  const idPart = id ? ` ${id.slice(0, 12)}` : '';
  return `[container] ${phase}${idPart}`;
}

function toolLine(row: WorkflowEventRow, openToolCalls: OpenToolCalls): string | undefined {
  // A row this build cannot read (another build's provider events) is skipped, as the
  // transcript reader does; a throw here would only log once per row.
  const parsed = providerEventEnvelopeSchema.safeParse(row.data);
  if (!parsed.success) return undefined;
  const envelope = parsed.data;
  const providerEvent = envelope.event;
  // A call id is unique within its attempt; parallel nodes can repeat one.
  const callKey = JSON.stringify([
    envelope.attemptId,
    'toolCallId' in providerEvent ? providerEvent.toolCallId : '',
  ]);
  if (providerEvent.type === 'tool_call') {
    const name = toolCallDisplayName(providerEvent);
    openToolCalls.set(callKey, { name, observedAt: envelope.observedAt });
    return `[${row.step_name}] tool: ${name} (started, ${providerEvent.toolCallId})`;
  }
  if (providerEvent.type !== 'tool_call_update') return undefined;
  const started = openToolCalls.get(callKey);
  openToolCalls.delete(callKey);
  const duration =
    started === undefined
      ? ''
      : `${String(Date.parse(envelope.observedAt) - Date.parse(started.observedAt))}ms, `;
  const exitCode =
    providerEvent.exitCode !== undefined ? `, exit ${String(providerEvent.exitCode)}` : '';
  return `[${row.step_name}] tool: ${started?.name ?? providerEvent.toolCallId} (${duration}${providerEvent.toolCallId}, ${providerEvent.status}${exitCode})`;
}

/** The progress line a persisted workflow event renders as, if any. */
export function workflowEventLine(
  row: WorkflowEventRow,
  verbose: boolean,
  openToolCalls: OpenToolCalls
): string | undefined {
  const nodeEvent = readNodeEmitterEvent(row);
  if (nodeEvent !== undefined) return nodeEventLine(nodeEvent);
  switch (row.event_type) {
    case 'workflow_started':
      return typeof row.data.transcriptPath === 'string'
        ? `[workflow] Transcript: ${row.data.transcriptPath}`
        : undefined;
    case 'approval_requested':
      return typeof row.data.message === 'string'
        ? `[${row.step_name}] Waiting for approval: ${row.data.message}`
        : undefined;
    case 'pause_notice_undelivered':
      return `[${row.step_name}] Pause notice not delivered; the run is still waiting`;
    case 'container_created':
    case 'container_stopped':
    case 'container_resumed':
    case 'container_destroyed':
      return containerLine(row.event_type.slice('container_'.length), row.data);
    case 'writeback_requested':
    case 'writeback_applied':
    case 'writeback_discarded':
      return containerLine(row.event_type, row.data);
    case 'provider_event':
      return verbose ? toolLine(row, openToolCalls) : undefined;
    default:
      // Workflow-level, loop, artifact, and cancelled events are intentionally not rendered.
      return undefined;
  }
}
