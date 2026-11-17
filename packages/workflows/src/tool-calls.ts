import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import { writeArtifactFile } from './artifact-writes';
import {
  WORKFLOW_TOOL_CALL_EVENT_TYPE,
  workflowToolCallSchema,
  type WorkflowToolCall,
} from './schemas/tool-call';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { IWorkflowStore } from './store';

const TOOL_CALLS_SUBDIR = join(RUN_ARTIFACTS_ENGINE_SUBDIR, 'tool-calls');

export function newToolCallId(): string {
  return randomUUID();
}

export function toolCallRef(callId: string, name: 'input.json' | 'output.json'): string {
  return join(TOOL_CALLS_SUBDIR, callId, name);
}

export async function writeToolCallValue(
  artifactsDir: string,
  ref: string,
  value: unknown
): Promise<void> {
  await writeArtifactFile(join(artifactsDir, ref), JSON.stringify(value), { mode: 0o600 });
}

export async function persistToolCall(
  store: Pick<IWorkflowStore, 'persistWorkflowEvent'>,
  stepName: string,
  call: WorkflowToolCall
): Promise<void> {
  const parsed = workflowToolCallSchema.parse(call);
  await store.persistWorkflowEvent({
    workflow_run_id: parsed.run_id,
    event_type: WORKFLOW_TOOL_CALL_EVENT_TYPE,
    step_name: stepName,
    data: { ...parsed },
  });
}

export function foldToolCalls(
  events: readonly WorkflowEventRow[],
  runId: string
): WorkflowToolCall[] {
  const latest = new Map<string, WorkflowToolCall>();
  for (const event of events) {
    if (event.event_type !== WORKFLOW_TOOL_CALL_EVENT_TYPE) continue;
    const call = workflowToolCallSchema.parse(event.data);
    if (call.run_id !== runId) throw new Error('Tool-call receipt belongs to another run');
    const previous = latest.get(call.call_id);
    if (acceptToolCallTransition(previous, call)) latest.set(call.call_id, call);
  }
  return [...latest.values()];
}

function acceptToolCallTransition(
  previous: WorkflowToolCall | undefined,
  call: WorkflowToolCall
): boolean {
  if (call.input_ref !== toolCallRef(call.call_id, 'input.json')) {
    throw new Error('Tool-call receipt has an invalid input reference');
  }
  if (
    call.output_ref !== undefined &&
    call.output_ref !== toolCallRef(call.call_id, 'output.json')
  ) {
    throw new Error('Tool-call receipt has an invalid output reference');
  }
  if (previous === undefined || previous.status === 'started') return true;
  if (JSON.stringify(previous) === JSON.stringify(call)) return false;
  throw new Error('Tool-call receipt has conflicting terminal transitions');
}

export async function writeToolCallListing(
  artifactsDir: string,
  runId: string,
  events: readonly WorkflowEventRow[]
): Promise<string> {
  const path = join(artifactsDir, TOOL_CALLS_SUBDIR, `${randomUUID()}-listing.json`);
  await writeArtifactFile(path, JSON.stringify({ runId, calls: foldToolCalls(events, runId) }), {
    mode: 0o600,
  });
  return path;
}
