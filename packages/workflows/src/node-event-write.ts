import type { NodeStateRecord } from './schemas/node-execution';
import {
  serializeNodeStateRecord,
  serializeNodeTranscript,
  serializeNodeEmitter,
  serializeNodeOutput,
  type NodeExecutionResult,
} from './node-record-serialization';
import type { WorkflowDeps } from './deps';
import type { DagNode } from './schemas';
import type { WorkflowEvent } from './logger';
import { logWorkflowEvent } from './logger';
import type { WorkflowEmitterEvent } from './event-emitter';
import { getWorkflowEventEmitter } from './event-emitter';

import type { NodeStateEventInput } from './store';
import { readNodeRecordEvent, type ReadNodeRecordEvent } from './node-record-reader';

/** Storage rejection must leave node retry policy and reach the run failure boundary. */
export class NodeEventWriteError extends Error {
  constructor(event: NodeStateEventInput, cause: unknown) {
    const originalFailure = event.event_type === 'node_failed' ? event.data?.error : undefined;
    super(
      `Could not persist ${event.event_type} for ${event.step_name ?? 'unknown node'}: ${cause instanceof Error ? cause.message : String(cause)}${typeof originalFailure === 'string' ? `; original node failure: ${originalFailure}` : ''}`,
      { cause }
    );
    this.name = 'NodeEventWriteError';
  }
}

export async function persistNodeEvent(
  store: WorkflowDeps['store'],
  event: NodeStateEventInput
): Promise<void> {
  try {
    await store.persistWorkflowEvent(event);
  } catch (error) {
    throw new NodeEventWriteError(event, error);
  }
}

/** The authored node a state fact is about; its kind and source name it in the transcript. */
export type NodeStateSubject = DagNode;

/**
 * The three sinks one node-state fact reaches: the durable row, the JSONL transcript,
 * and the in-process emitter. `logDir` is required because a site without a transcript
 * is exactly the silently dropped sink #3255 removes.
 */
export interface DerivedNodeStateSinks {
  logDir: string;
  emitter?: Pick<ReturnType<typeof getWorkflowEventEmitter>, 'emit'>;
}

export interface NodeStateSinks extends DerivedNodeStateSinks {
  store: WorkflowDeps['store'];
}

function commandNameOf(node: NodeStateSubject): string | undefined {
  return node.kind === 'agent' && node.source.kind === 'command' ? node.source.name : undefined;
}

export function getNodeName(node: NodeStateSubject): string {
  return commandNameOf(node) ?? node.id;
}

function transcriptContent(node: NodeStateSubject, record: ReadNodeRecordEvent): string {
  if (typeof record.data.command === 'string') return record.data.command;
  if (node.kind === 'agent') return commandNameOf(node) ?? '<inline>';
  if (node.kind === 'exec') return node.runtime === 'sh' ? '<bash>' : '<script>';
  if (typeof record.data.type === 'string') return `<${record.data.type}>`;
  return node.id;
}

export function deriveTranscriptEvent(
  node: NodeStateSubject,
  event: NodeStateEventInput
): Omit<WorkflowEvent, 'ts' | 'workflow_id'> | undefined {
  const record = readNodeRecordEvent(event);
  if (!record) return undefined;
  if (record.metadata) return serializeNodeTranscript(record.metadata);
  const content = transcriptContent(node, record);
  switch (record.eventType) {
    case 'node_started':
      return { type: 'node_start', step: node.id, content };
    case 'node_completed':
      return {
        type: 'node_complete',
        step: node.id,
        content,
        ...(record.data.duration_ms !== undefined ? { duration_ms: record.data.duration_ms } : {}),
        ...(record.data.cost_usd !== undefined ? { cost_usd: record.data.cost_usd } : {}),
        ...(record.data.tokens !== undefined ? { tokens: record.data.tokens } : {}),
      };
    case 'node_failed':
      return {
        type: 'node_error',
        step: node.id,
        error: record.data.error ?? '',
        ...(record.data.cost_usd !== undefined ? { cost_usd: record.data.cost_usd } : {}),
        ...(record.data.tokens !== undefined ? { tokens: record.data.tokens } : {}),
      };
    case 'node_skipped':
      return {
        type: 'node_skipped',
        step: node.id,
        content: record.data.reason ?? 'skipped',
        ...(record.data.cause !== undefined ? { cause: record.data.cause } : {}),
      };
    case 'node_skipped_prior_success':
      return { type: 'node_skipped', step: node.id, content: 'prior_success' };
    case 'node_prior_cache_invalidated':
    case 'node_always_run_reset':
      return undefined;
    case 'node_suspended':
      return {
        type: 'node_suspended',
        step: node.id,
        content: record.data.suspend_point ?? 'wait',
      };
    default: {
      const exhaustiveCheck: never = record.eventType;
      throw new Error(`Unhandled NodeStateEventType: ${String(exhaustiveCheck)}`);
    }
  }
}

export function deriveEmitterEvent(
  node: NodeStateSubject,
  event: NodeStateEventInput
): WorkflowEmitterEvent | undefined {
  const record = readNodeRecordEvent(event);
  if (!record) return undefined;
  if (record.metadata) return serializeNodeEmitter(record.metadata);
  const nodeName = getNodeName(node);
  switch (record.eventType) {
    case 'node_started':
      return {
        type: 'node_started',
        runId: record.workflowRunId,
        nodeId: node.id,
        nodeName,
      };
    case 'node_completed':
      return {
        type: 'node_completed',
        runId: record.workflowRunId,
        nodeId: node.id,
        nodeName,
        ...(record.data.duration_ms !== undefined ? { duration: record.data.duration_ms } : {}),
        ...(record.data.cost_usd !== undefined ? { costUsd: record.data.cost_usd } : {}),
        ...(record.data.stop_reason !== undefined ? { stopReason: record.data.stop_reason } : {}),
        ...(record.data.num_turns !== undefined ? { numTurns: record.data.num_turns } : {}),
      };
    case 'node_failed':
      return {
        type: 'node_failed',
        runId: record.workflowRunId,
        nodeId: node.id,
        nodeName,
        error: record.data.error ?? '',
      };
    case 'node_skipped':
      if (
        record.data.reason === undefined ||
        record.data.reason === 'prior_success' ||
        record.data.reason === 'stale_dependency' ||
        record.data.cause === undefined
      )
        return undefined;
      return {
        type: 'node_skipped',
        runId: record.workflowRunId,
        nodeId: node.id,
        nodeName,
        reason: record.data.reason,
        cause: record.data.cause,
      };
    case 'node_skipped_prior_success':
      return {
        type: 'node_skipped_prior_success',
        runId: record.workflowRunId,
        nodeId: node.id,
        nodeName,
      };
    case 'node_prior_cache_invalidated':
    case 'node_always_run_reset':
      return undefined;
    case 'node_suspended':
      return undefined;
    default: {
      const exhaustiveCheck: never = record.eventType;
      throw new Error(`Unhandled NodeStateEventType: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * Write the two sinks that derive from a node-state row: the JSONL transcript and the
 * in-process emitter. Each already isolates its own I/O (`logWorkflowEvent` logs an
 * append failure; the emitter catches listener errors), so nothing here catches, and a
 * throw is a derivation defect that surfaces instead of degrading to a warning.
 *
 * Call this directly only when the store wrote the row itself, atomically with another
 * operation, and handed it back; `clearWorkflowWaitContext` is that case. Every other
 * site goes through `recordNodeState`.
 */
export async function recordDerivedNodeState(
  sinks: DerivedNodeStateSinks,
  node: NodeStateSubject,
  event: NodeStateEventInput
): Promise<void> {
  const transcript = deriveTranscriptEvent(node, event);
  if (transcript) {
    await logWorkflowEvent(sinks.logDir, event.workflow_run_id, transcript);
  }

  const emitted = deriveEmitterEvent(node, event);
  if (emitted) {
    (sinks.emitter ?? getWorkflowEventEmitter()).emit(emitted);
  }
}

/** Derive transcript and emitter sinks from the exact canonical record already persisted. */
export async function recordDerivedExecution(
  sinks: DerivedNodeStateSinks,
  record: NodeStateRecord
): Promise<void> {
  const transcript = serializeNodeTranscript(record);
  if (transcript) await logWorkflowEvent(sinks.logDir, record.runId, transcript);
  const emitted = serializeNodeEmitter(record);
  if (emitted) (sinks.emitter ?? getWorkflowEventEmitter()).emit(emitted);
}

/**
 * Write one node-state fact to every sink. The durable row goes first and is awaited:
 * its rejection is a NodeEventWriteError that must reach the run failure boundary. The
 * transcript and the emitter then derive from the same value.
 */
export async function recordNodeState(
  sinks: NodeStateSinks,
  record: NodeStateRecord,
  continuation: { sessionId?: string; resumed?: boolean } = {}
): Promise<NodeExecutionResult> {
  await persistNodeEvent(sinks.store, serializeNodeStateRecord(record));
  await recordDerivedExecution(sinks, record);
  if (!('cache' in record)) return serializeNodeOutput(record, continuation);
  if (record.cache.action !== 'replayed') return { state: 'pending', output: '' };
  const output = record.cache.output;
  return {
    state: 'completed',
    output: output.text,
    ...(output.structured !== undefined ? { structuredOutput: output.structured } : {}),
    ...(output.declaredFields !== undefined ? { declaredFields: output.declaredFields } : {}),
  };
}
