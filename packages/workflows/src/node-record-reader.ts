import { z } from 'zod';
import { NODE_STATE_EVENT_TYPES } from './store';
import {
  nodeExecutionMetadataSchema,
  nodeExecutionMetadataPayloadSchema,
  nodeInvocationSchema,
  type NodeExecutionMetadata,
  type NodeInvocation,
} from './schemas/node-execution';
import {
  DEFERRED_NODE_USAGE_EVENT_TYPE,
  isPersistedExecType,
  serializedDeferredNodeUsageDataSchema,
  serializedNodeDataSchema,
  type SerializedNodeData,
  type SerializedNodeEvent,
  type SerializedDeferredNodeUsageEvent,
} from './node-record-serialization';
import { outputPathsFromRootFields } from './output-ref';

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
  rawUsage: { tokens?: unknown; tokensUnknown?: boolean; costUsd?: unknown };
  metadata?: NodeExecutionMetadata;
}

export function isExecNodeRecord(record: ReadNodeRecordEvent): boolean {
  return record.metadata
    ? record.metadata.node.kind === 'exec'
    : isPersistedExecType(record.data.type);
}

const eventDataSchema = z.record(z.string(), z.unknown());
const eventTypes = new Set<string>(NODE_STATE_EVENT_TYPES);
const metadataKeys = Object.keys(nodeExecutionMetadataPayloadSchema.shape);
const requiredMetadataKeys = Object.entries(nodeExecutionMetadataPayloadSchema.shape)
  .filter(([, schema]) => !schema.isOptional())
  .map(([key]) => key);

export function readNodeRecordData(value: unknown): Record<string, unknown> {
  return eventDataSchema.parse(typeof value === 'string' ? JSON.parse(value) : (value ?? {}));
}

function projectSerializedData(raw: Record<string, unknown>): SerializedNodeData {
  const projected: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(serializedNodeDataSchema.shape)) {
    if (!Object.hasOwn(raw, key)) continue;
    if (key === 'declared_output_paths' || key === 'child_usage') {
      projected[key] = serializedNodeDataSchema.shape[key].unwrap().parse(raw[key]);
      continue;
    }
    const parsed = schema.safeParse(raw[key]);
    if (parsed.success) projected[key] = parsed.data;
  }
  const data = projected as SerializedNodeData;
  // A row written before nested paths carries only the root-field projection.
  if (data.declared_output_paths === undefined && data.declared_fields !== undefined) {
    data.declared_output_paths = outputPathsFromRootFields(data.declared_fields);
  }
  return data;
}

function failedLifecycle(
  data: SerializedNodeData
): Extract<NodeExecutionMetadata['lifecycle'], { status: 'failed' }> | undefined {
  return typeof data.error === 'string'
    ? {
        status: 'failed',
        error: data.error,
        ...(data.retryable === false ? { retryable: false } : {}),
        ...(data.failure_kind !== undefined ? { failureKind: data.failure_kind } : {}),
        ...(data.provider_failure !== undefined ? { providerFailure: data.provider_failure } : {}),
      }
    : undefined;
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
      return failedLifecycle(data);
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
  const hasMetadata = isExecutionEvent && metadataKeys.some(key => Object.hasOwn(raw, key));
  let metadata: NodeExecutionMetadata | undefined;
  if (hasMetadata) {
    if (requiredMetadataKeys.some(key => !Object.hasOwn(raw, key)))
      throw new Error('Node execution metadata is incomplete');
    const lifecycle = lifecycleFor(eventType, data);
    if (lifecycle === undefined) throw new Error('Node execution lifecycle is invalid');
    metadata = nodeExecutionMetadataSchema.parse({
      ...raw,
      runId: envelope.workflow_run_id,
      path: envelope.step_name,
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
      ...(metadata?.spend.tokens.source === 'unavailable' &&
      metadata.spend.tokens.reason === 'incomplete'
        ? { tokensUnknown: true }
        : {}),
      ...(Object.hasOwn(raw, 'cost_usd') ? { costUsd: raw.cost_usd } : {}),
    },
    ...(metadata === undefined ? {} : { metadata }),
  };
}

export function nodeInvocationKey(path: string, loopPath: NodeInvocation['loopPath']): string {
  return JSON.stringify([path, loopPath]);
}

const nodeInvocationKeySchema = z.tuple([z.string(), nodeInvocationSchema.shape.loopPath]);

/** Inverse of {@link nodeInvocationKey}; throws on a key it did not produce. */
export function parseNodeInvocationKey(key: string): {
  path: string;
  loopPath: NodeInvocation['loopPath'];
} {
  const [path, loopPath] = nodeInvocationKeySchema.parse(JSON.parse(key));
  return { path, loopPath };
}

export function readDeferredNodeUsageEvent(envelope: NodeRecordEventEnvelope):
  | (Pick<ReadNodeRecordEvent, 'path' | 'rawUsage'> & {
      data: SerializedDeferredNodeUsageEvent['data'];
    })
  | undefined {
  if (!envelope.step_name || envelope.event_type !== DEFERRED_NODE_USAGE_EVENT_TYPE)
    return undefined;
  const raw = readNodeRecordData(envelope.data);
  const data = serializedDeferredNodeUsageDataSchema.parse(projectSerializedData(raw));
  return {
    path: envelope.step_name,
    data,
    rawUsage: {
      tokens: raw.tokens,
      tokensUnknown:
        data.spend?.tokens.source === 'unavailable' && data.spend.tokens.reason === 'incomplete',
      costUsd: raw.cost_usd,
    },
  };
}
