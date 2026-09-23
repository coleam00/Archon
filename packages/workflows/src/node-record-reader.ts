import { z } from '@hono/zod-openapi';
import { NODE_STATE_EVENT_TYPES } from './store';
import {
  nodeExecutionMetadataSchema,
  type NodeExecutionMetadata,
  type NodeInvocation,
} from './schemas/node-execution';
import {
  serializedNodeDataSchema,
  type SerializedNodeData,
  type SerializedNodeEvent,
} from './node-record-serialization';

export interface NodeRecordEventEnvelope {
  workflow_run_id: string;
  step_name?: string | null;
  event_type: string;
  data: unknown;
}

export interface ReadNodeRecordEvent {
  workflowRunId: string;
  path: string;
  eventType: SerializedNodeEvent['event_type'];
  data: SerializedNodeData;
  /** Raw values retained so accounting can diagnose malformed historical usage. */
  rawUsage: { tokens?: unknown; costUsd?: unknown };
  metadata?: NodeExecutionMetadata;
}

const eventDataSchema = z.record(z.string(), z.unknown());
const eventTypes = new Set<string>(NODE_STATE_EVENT_TYPES);
const metadataKeys = [
  'node',
  'invocation',
  'attempt',
  'binding',
  'timing',
  'spend',
  'accounting',
] as const;

export function readNodeRecordData(value: unknown): Record<string, unknown> {
  return eventDataSchema.parse(typeof value === 'string' ? JSON.parse(value) : (value ?? {}));
}

function projectSerializedData(raw: Record<string, unknown>): SerializedNodeData {
  const projected: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(serializedNodeDataSchema.shape)) {
    if (!Object.hasOwn(raw, key)) continue;
    const parsed = schema.safeParse(raw[key]);
    if (parsed.success) projected[key] = parsed.data;
  }
  return projected as SerializedNodeData;
}

function lifecycleFor(
  eventType: SerializedNodeEvent['event_type'],
  data: SerializedNodeData
): NodeExecutionMetadata['lifecycle'] | undefined {
  switch (eventType) {
    case 'node_started':
      return { status: 'started' };
    case 'node_completed':
      return { status: 'completed' };
    case 'node_failed':
      return typeof data.error === 'string'
        ? {
            status: 'failed',
            error: data.error,
            ...(data.retryable === false ? { retryable: false } : {}),
          }
        : undefined;
    case 'node_skipped':
      return data.reason !== undefined &&
        data.reason !== 'stale_dependency' &&
        data.cause !== undefined
        ? { status: 'skipped', reason: data.reason, cause: data.cause }
        : undefined;
    case 'node_suspended': {
      const point = nodeExecutionMetadataSchema.shape.lifecycle.options[4].shape.point.safeParse(
        data.suspend_point
      );
      return point.success ? { status: 'suspended', point: point.data } : undefined;
    }
    case 'node_skipped_prior_success':
    case 'node_always_run_reset':
    case 'node_prior_cache_invalidated':
      return undefined;
  }
}

export function readNodeRecordEvent(
  envelope: NodeRecordEventEnvelope
): ReadNodeRecordEvent | undefined {
  if (!envelope.step_name || !eventTypes.has(envelope.event_type)) return undefined;
  const eventType = envelope.event_type as SerializedNodeEvent['event_type'];
  const raw = readNodeRecordData(envelope.data);
  const data = projectSerializedData(raw);
  const isExecutionEvent =
    eventType === 'node_started' ||
    eventType === 'node_completed' ||
    eventType === 'node_failed' ||
    eventType === 'node_skipped' ||
    eventType === 'node_suspended';
  const presentMetadataKeys = isExecutionEvent
    ? metadataKeys.filter(key => Object.hasOwn(raw, key))
    : [];
  let metadata: NodeExecutionMetadata | undefined;
  if (presentMetadataKeys.length > 0) {
    if (presentMetadataKeys.length !== metadataKeys.length)
      throw new Error('Node execution metadata is incomplete');
    const lifecycle = lifecycleFor(eventType, data);
    if (lifecycle === undefined) throw new Error('Node execution lifecycle is invalid');
    metadata = nodeExecutionMetadataSchema.parse({
      runId: envelope.workflow_run_id,
      path: envelope.step_name,
      node: raw.node,
      invocation: raw.invocation,
      attempt: raw.attempt,
      binding: raw.binding,
      timing: raw.timing,
      spend: raw.spend,
      accounting: raw.accounting,
      lifecycle,
    });
  }
  return {
    workflowRunId: envelope.workflow_run_id,
    path: envelope.step_name,
    eventType,
    data,
    rawUsage: {
      ...(Object.hasOwn(raw, 'tokens') ? { tokens: raw.tokens } : {}),
      ...(Object.hasOwn(raw, 'cost_usd') ? { costUsd: raw.cost_usd } : {}),
    },
    ...(metadata === undefined ? {} : { metadata }),
  };
}

export function nodeInvocationKey(path: string, loopPath: NodeInvocation['loopPath']): string {
  return JSON.stringify([path, loopPath]);
}
