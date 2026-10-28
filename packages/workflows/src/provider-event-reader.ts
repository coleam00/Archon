import { PROVIDER_EVENT_ROW_TYPES } from './store';
import { createLogger } from '@archon/paths';
import { providerEventSchema, type ProviderEvent } from '@archon/provider-contract';
import {
  orderProviderEventRecords,
  providerEventEnvelopeSchema,
  providerEventRecordsAfter,
  type ProviderEventQuery,
  type ProviderEventRecord,
} from './schemas/provider-event';
import type { WorkflowEventRow } from './schemas/workflow-event';
function dataString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

function dataNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' ? value : undefined;
}

const LEGACY_TOOL_STATUS: Record<string, 'completed' | 'failed' | 'cancelled'> = {
  success: 'completed',
  error: 'failed',
  interrupted: 'cancelled',
  unknown: 'cancelled',
};

const LEGACY_HOOK_STATUS: Record<string, 'succeeded' | 'failed' | 'cancelled'> = {
  success: 'succeeded',
  error: 'failed',
  cancelled: 'cancelled',
};

const LEGACY_SUBTASK_STATUS: Record<
  string,
  'started' | 'running' | 'completed' | 'failed' | 'stopped'
> = {
  started: 'started',
  progress: 'running',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
};

function legacyToolResult(data: Record<string, unknown>) {
  // A row with no outcome came from a reported tool result, before outcomes existed.
  const outcome = dataString(data, 'tool_outcome');
  const exitCode = dataNumber(data, 'exit_code');
  return {
    type: 'tool_call_update',
    toolCallId: data.tool_call_id,
    status: outcome === undefined ? 'completed' : LEGACY_TOOL_STATUS[outcome],
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function legacySubtask(data: Record<string, unknown>) {
  const activity = dataString(data, 'activity');
  return {
    type: 'subtask',
    taskId: data.task_id,
    status: activity === undefined ? undefined : LEGACY_SUBTASK_STATUS[activity],
    ...(data.description !== undefined ? { description: data.description } : {}),
    ...(data.summary !== undefined ? { summary: data.summary } : {}),
    ...(data.task_type !== undefined ? { taskType: data.task_type } : {}),
    ...(data.last_tool_name !== undefined ? { lastToolName: data.last_tool_name } : {}),
    ...(data.output_file !== undefined ? { outputFile: data.output_file } : {}),
    ...(data.usage !== undefined ? { usage: data.usage } : {}),
  };
}

function legacyHook(data: Record<string, unknown>) {
  const outcome = dataString(data, 'outcome');
  const exitCode = dataNumber(data, 'exit_code');
  return {
    type: 'hook',
    hookId: data.hook_id,
    hookName: data.hook_name,
    hookEvent: data.hook_event,
    status:
      dataString(data, 'activity') === 'started'
        ? 'started'
        : outcome === undefined
          ? undefined
          : LEGACY_HOOK_STATUS[outcome],
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

/**
 * The provider event a pre-envelope row recorded, from the keys v0.11.0 wrote. The result
 * is parsed with the contract schema, so a row missing a required fact (a tool row with
 * no `tool_call_id`) yields nothing rather than a record the contract forbids.
 */
function translateLegacyRow(
  eventType: Exclude<(typeof PROVIDER_EVENT_ROW_TYPES)[number], 'provider_event'>,
  data: Record<string, unknown>
): ProviderEvent | undefined {
  let candidate: unknown;
  switch (eventType) {
    case 'tool_called':
      candidate = {
        type: 'tool_call',
        toolCallId: data.tool_call_id,
        name: data.tool_name,
        ...(data.tool_input !== undefined ? { rawInput: data.tool_input } : {}),
      };
      break;
    case 'tool_completed':
      candidate = legacyToolResult(data);
      break;
    case 'task_activity':
      candidate = legacySubtask(data);
      break;
    case 'hook_activity':
      candidate = legacyHook(data);
      break;
    default:
      eventType satisfies never;
      return undefined;
  }
  const parsed = providerEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function readProviderEventRow(
  runId: string,
  row: WorkflowEventRow,
  eventType: (typeof PROVIDER_EVENT_ROW_TYPES)[number],
  legacySeq: Map<string, number>
): ProviderEventRecord | undefined {
  const stepName = row.step_name;
  if (stepName === null) return undefined;
  if (eventType === 'provider_event') {
    const envelope = providerEventEnvelopeSchema.safeParse(row.data);
    return envelope.success ? { runId, stepName, ...envelope.data } : undefined;
  }
  const event = translateLegacyRow(eventType, row.data);
  if (event === undefined) return undefined;
  const seq = legacySeq.get(stepName) ?? 0;
  legacySeq.set(stepName, seq + 1);
  return {
    runId,
    stepName,
    attemptId: null,
    seq,
    observedAt: new Date(row.created_at).toISOString(),
    event,
  };
}

export function readProviderEventRows(
  runId: string,
  rows: readonly WorkflowEventRow[],
  query: ProviderEventQuery = {}
): ProviderEventRecord[] {
  const byStep = new Map<string, ProviderEventRecord[]>();
  const legacySeq = new Map<string, number>();
  for (const row of rows) {
    const eventType = PROVIDER_EVENT_ROW_TYPES.find(type => type === row.event_type);
    if (eventType === undefined) continue;
    const record = readProviderEventRow(runId, row, eventType, legacySeq);
    if (record === undefined) {
      createLogger('workflow-provider-events').warn(
        { eventId: row.id, runId: runId, eventType: row.event_type },
        'provider_event_row_unreadable'
      );
      continue;
    }
    const stepRecords = byStep.get(record.stepName) ?? [];
    stepRecords.push(record);
    byStep.set(record.stepName, stepRecords);
  }

  const ordered = [...byStep.values()].flatMap(records => orderProviderEventRecords(records));
  return query.after === undefined ? ordered : providerEventRecordsAfter(ordered, query.after);
}
