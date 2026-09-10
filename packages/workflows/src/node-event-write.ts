import type { WorkflowDeps, WorkflowTokenUsage } from './deps';
import type { DagNode, EffortLevel, NodeSkipReason, SkipCause, TierName } from './schemas';
import type { WorkflowEvent } from './logger';
import { logWorkflowEvent } from './logger';
import type { WorkflowEmitterEvent } from './event-emitter';
import { getWorkflowEventEmitter } from './event-emitter';

import type { NodeStateEventInput } from './store';

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
 * What the run resolved for an AI node's execution. It is a fact about this run, not
 * a field of the authored node, so it travels beside the node rather than on it. The
 * emitter shows it on `node_started`; the durable row carries its own copy in `data`.
 */
export interface ResolvedExecution {
  provider?: string;
  model?: string;
  tier?: TierName;
  effort?: EffortLevel;
}

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

function transcriptContent(node: NodeStateSubject, event: NodeStateEventInput): string {
  if (typeof event.data?.command === 'string') return event.data.command;
  if (node.kind === 'agent') return commandNameOf(node) ?? '<inline>';
  if (node.kind === 'exec') return node.runtime === 'sh' ? '<bash>' : '<script>';
  if (typeof event.data?.type === 'string') return `<${event.data.type}>`;
  return node.id;
}

export function deriveTranscriptEvent(
  node: NodeStateSubject,
  event: NodeStateEventInput
): Omit<WorkflowEvent, 'ts' | 'workflow_id'> | undefined {
  const content = transcriptContent(node, event);
  switch (event.event_type) {
    case 'node_started':
      return { type: 'node_start', step: node.id, content };
    case 'node_completed':
      return {
        type: 'node_complete',
        step: node.id,
        content,
        ...(typeof event.data?.duration_ms === 'number'
          ? { duration_ms: event.data.duration_ms }
          : {}),
        ...(typeof event.data?.cost_usd === 'number' ? { cost_usd: event.data.cost_usd } : {}),
        ...(event.data?.tokens ? { tokens: event.data.tokens as WorkflowTokenUsage } : {}),
      };
    case 'node_failed':
      return {
        type: 'node_error',
        step: node.id,
        error: (event.data?.error as string) ?? '',
        ...(typeof event.data?.cost_usd === 'number' ? { cost_usd: event.data.cost_usd } : {}),
        ...(event.data?.tokens ? { tokens: event.data.tokens as WorkflowTokenUsage } : {}),
      };
    case 'node_skipped':
      return {
        type: 'node_skipped',
        step: node.id,
        content: (event.data?.reason as string) ?? 'skipped',
        ...(event.data?.cause !== undefined ? { cause: event.data.cause as SkipCause } : {}),
      };
    case 'node_skipped_prior_success':
      return { type: 'node_skipped', step: node.id, content: 'prior_success' };
    case 'node_prior_cache_invalidated':
    case 'node_always_run_reset':
      return undefined;
    default: {
      const exhaustiveCheck: never = event.event_type;
      throw new Error(`Unhandled NodeStateEventType: ${String(exhaustiveCheck)}`);
    }
  }
}

export function deriveEmitterEvent(
  node: NodeStateSubject,
  event: NodeStateEventInput,
  execution: ResolvedExecution = {}
): WorkflowEmitterEvent | undefined {
  const nodeName = getNodeName(node);
  switch (event.event_type) {
    case 'node_started':
      return {
        type: 'node_started',
        runId: event.workflow_run_id,
        nodeId: node.id,
        nodeName,
        ...(execution.provider ? { provider: execution.provider } : {}),
        ...(execution.model ? { model: execution.model } : {}),
        ...(execution.tier ? { tier: execution.tier } : {}),
        ...(execution.effort ? { effort: execution.effort } : {}),
      };
    case 'node_completed':
      return {
        type: 'node_completed',
        runId: event.workflow_run_id,
        nodeId: node.id,
        nodeName,
        duration: (event.data?.duration_ms as number) ?? 0,
        ...(typeof event.data?.cost_usd === 'number' ? { costUsd: event.data.cost_usd } : {}),
        ...(typeof event.data?.stop_reason === 'string'
          ? { stopReason: event.data.stop_reason }
          : {}),
        ...(typeof event.data?.num_turns === 'number' ? { numTurns: event.data.num_turns } : {}),
      };
    case 'node_failed':
      return {
        type: 'node_failed',
        runId: event.workflow_run_id,
        nodeId: node.id,
        nodeName,
        error: (event.data?.error as string) ?? '',
      };
    case 'node_skipped':
      if (event.data?.reason === 'prior_success') {
        return {
          type: 'node_skipped',
          runId: event.workflow_run_id,
          nodeId: node.id,
          nodeName,
          reason: 'prior_success',
        };
      }
      return {
        type: 'node_skipped',
        runId: event.workflow_run_id,
        nodeId: node.id,
        nodeName,
        reason:
          (event.data?.reason as Exclude<NodeSkipReason, 'prior_success'>) ?? 'when_condition',
        cause: event.data?.cause as SkipCause,
      };
    case 'node_skipped_prior_success':
      return {
        type: 'node_skipped',
        runId: event.workflow_run_id,
        nodeId: node.id,
        nodeName,
        reason: 'prior_success',
      };
    case 'node_prior_cache_invalidated':
    case 'node_always_run_reset':
      return undefined;
    default: {
      const exhaustiveCheck: never = event.event_type;
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
  event: NodeStateEventInput,
  execution?: ResolvedExecution
): Promise<void> {
  const transcript = deriveTranscriptEvent(node, event);
  if (transcript) {
    await logWorkflowEvent(sinks.logDir, event.workflow_run_id, transcript);
  }

  const emitted = deriveEmitterEvent(node, event, execution);
  if (emitted) {
    (sinks.emitter ?? getWorkflowEventEmitter()).emit(emitted);
  }
}

/**
 * Write one node-state fact to every sink. The durable row goes first and is awaited:
 * its rejection is a NodeEventWriteError that must reach the run failure boundary. The
 * transcript and the emitter then derive from the same value.
 */
export async function recordNodeState(
  sinks: NodeStateSinks,
  node: NodeStateSubject,
  event: NodeStateEventInput,
  execution?: ResolvedExecution
): Promise<void> {
  await persistNodeEvent(sinks.store, event);
  await recordDerivedNodeState(sinks, node, event, execution);
}
