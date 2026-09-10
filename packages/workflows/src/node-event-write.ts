import type { WorkflowDeps, WorkflowTokenUsage } from './deps';
import type { NodeStateEventInput } from './store';
import type { EffortLevel, NodeSkipReason, SkipCause } from './schemas';
import type { WorkflowEvent } from './logger';
import { logWorkflowEvent } from './logger';
import type { WorkflowEmitterEvent } from './event-emitter';
import { getWorkflowEventEmitter } from './event-emitter';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.node-event-write');
  return cachedLog;
}

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

export interface RecordNodeStateTarget {
  id: string;
  name?: string;
  kind?: string;
  runtime?: string;
  source?: { kind: string; name?: string };
  provider?: string;
  model?: string;
  tier?: 'small' | 'medium' | 'large';
  effort?: EffortLevel;
  [key: string]: unknown;
}

export interface RecordNodeStateDeps {
  store?: WorkflowDeps['store'];
  deps?: { store: WorkflowDeps['store'] };
  logDir?: string;
  emitter?: Pick<ReturnType<typeof getWorkflowEventEmitter>, 'emit'>;
}

export function getNodeName(node: RecordNodeStateTarget): string {
  if (typeof node.name === 'string' && node.name) return node.name;
  if (
    'source' in node &&
    typeof node.source === 'object' &&
    node.source !== null &&
    (node.source as { kind?: string }).kind === 'command' &&
    typeof (node.source as { name?: string }).name === 'string'
  ) {
    return (node.source as { name: string }).name;
  }
  return node.id;
}

function getNodeContent(node: RecordNodeStateTarget, event: NodeStateEventInput): string {
  if (typeof event.data?.command === 'string') {
    return event.data.command;
  }
  if (node.kind === 'agent') {
    if (
      'source' in node &&
      typeof node.source === 'object' &&
      node.source !== null &&
      (node.source as { kind?: string }).kind === 'command' &&
      typeof (node.source as { name?: string }).name === 'string'
    ) {
      return (node.source as { name: string }).name;
    }
    return '<inline>';
  }
  if (node.kind === 'exec') {
    return node.runtime === 'sh' ? '<bash>' : '<script>';
  }
  if (typeof event.data?.type === 'string') {
    return `<${event.data.type}>`;
  }
  return getNodeName(node);
}

export function deriveTranscriptEvent(
  node: RecordNodeStateTarget,
  event: NodeStateEventInput
): Omit<WorkflowEvent, 'ts' | 'workflow_id'> | undefined {
  const content = getNodeContent(node, event);
  switch (event.event_type) {
    case 'node_started':
      return {
        type: 'node_start',
        step: node.id,
        content,
      };
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
      return {
        type: 'node_skipped',
        step: node.id,
        content: 'prior_success',
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

export function deriveEmitterEvent(
  node: RecordNodeStateTarget,
  event: NodeStateEventInput
): WorkflowEmitterEvent | undefined {
  const nodeName = getNodeName(node);
  switch (event.event_type) {
    case 'node_started':
      return {
        type: 'node_started',
        runId: event.workflow_run_id,
        nodeId: node.id,
        nodeName,
        ...(typeof node.provider === 'string' && node.provider ? { provider: node.provider } : {}),
        ...(typeof node.model === 'string' && node.model ? { model: node.model } : {}),
        ...(node.tier ? { tier: node.tier } : {}),
        ...(node.effort ? { effort: node.effort } : {}),
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

export async function recordNodeState(
  deps: RecordNodeStateDeps,
  node: RecordNodeStateTarget,
  event: NodeStateEventInput
): Promise<void> {
  const store = deps.store ?? deps.deps?.store;
  if (!store) {
    throw new Error('recordNodeState requires deps.store or deps.deps.store');
  }

  // 1. Durable sink: must be awaited and throw NodeEventWriteError on rejection
  await persistNodeEvent(store, event);

  // 2. Transcript sink: best-effort, never fails the node
  if (deps.logDir) {
    try {
      const transcriptEvent = deriveTranscriptEvent(node, event);
      if (transcriptEvent) {
        await logWorkflowEvent(deps.logDir, event.workflow_run_id, transcriptEvent);
      }
    } catch (err) {
      getLog().warn({ err, nodeId: node.id }, 'dag.node_state_transcript_failed');
    }
  }

  // 3. Emitter sink: fire-and-forget, listener errors must not propagate
  try {
    const emitterEvent = deriveEmitterEvent(node, event);
    if (emitterEvent) {
      const emitter = deps.emitter ?? getWorkflowEventEmitter();
      emitter.emit(emitterEvent);
    }
  } catch (err) {
    getLog().warn({ err, nodeId: node.id }, 'dag.node_state_emitter_failed');
  }
}
