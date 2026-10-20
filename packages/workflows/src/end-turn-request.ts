import { z } from 'zod';

import {
  TOOL_CALL_ATTENTION_METADATA_KEY,
  toolCallAttentionArraySchema,
  type ToolCallAttention,
  type WorkflowRun,
} from './schemas/workflow-run';
import type { IWorkflowStore } from './store';
import type { StreamStall } from './tool-call-attention';

/** Requests bind to the owner-observed stall, never to the requester's clock. */
export const END_TURN_REQUEST_METADATA_KEY = 'end_turn_request';

export const endTurnRequestSchema = z.object({
  stallIds: z.array(z.string().min(1)).min(1),
});

type EndTurnMetadata = {
  [END_TURN_REQUEST_METADATA_KEY]: z.infer<typeof endTurnRequestSchema>;
};

export type EndTurnPlan =
  | { kind: 'request'; calls: ToolCallAttention[]; metadata: EndTurnMetadata }
  | { kind: 'refused'; reason: 'not_running' | 'nothing_stalled' | 'unreadable_attention' };

/** What ending the run's stalled turns would write, or why there is nothing to end. */
export function planEndTurn(run: Pick<WorkflowRun, 'status' | 'metadata'>): EndTurnPlan {
  if (run.status !== 'running' && run.status !== 'paused')
    return { kind: 'refused', reason: 'not_running' };
  const parsed = toolCallAttentionArraySchema.safeParse(
    run.metadata[TOOL_CALL_ATTENTION_METADATA_KEY] === undefined
      ? []
      : run.metadata[TOOL_CALL_ATTENTION_METADATA_KEY]
  );
  if (!parsed.success) return { kind: 'refused', reason: 'unreadable_attention' };
  const calls = parsed.data;
  if (calls.length === 0) return { kind: 'refused', reason: 'nothing_stalled' };
  const stallIds: string[] = [];
  for (const call of calls) {
    if (call.stallId === undefined) return { kind: 'refused', reason: 'unreadable_attention' };
    stallIds.push(call.stallId);
  }
  return {
    kind: 'request',
    calls,
    metadata: {
      [END_TURN_REQUEST_METADATA_KEY]: endTurnRequestSchema.parse({
        stallIds,
      }),
    },
  };
}

/** Match any observed occurrence that remains stalled, independent of wall clocks. */
export async function isEndTurnRequested(
  store: Pick<IWorkflowStore, 'getWorkflowRun'>,
  runId: string,
  stall: StreamStall
): Promise<boolean> {
  const run = await store.getWorkflowRun(runId);
  const request = endTurnRequestSchema.safeParse(run?.metadata[END_TURN_REQUEST_METADATA_KEY]);
  return request.success && stall.stallIds.some(id => request.data.stallIds.includes(id));
}
