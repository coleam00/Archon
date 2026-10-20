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
  stalls: z.record(z.string().min(1), z.iso.datetime()),
  requestedAt: z.iso.datetime(),
});

type EndTurnMetadata = {
  [END_TURN_REQUEST_METADATA_KEY]: z.infer<typeof endTurnRequestSchema>;
};

export type EndTurnPlan =
  | { kind: 'request'; calls: ToolCallAttention[]; metadata: EndTurnMetadata }
  | { kind: 'refused'; reason: 'not_running' | 'nothing_stalled' | 'unreadable_attention' };

/** What ending the run's stalled turns would write, or why there is nothing to end. */
export function planEndTurn(
  run: Pick<WorkflowRun, 'status' | 'metadata'>,
  now: Date = new Date()
): EndTurnPlan {
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
  const stalls = new Map<string, string>();
  for (const call of calls) {
    const observed = stalls.get(call.streamId);
    if (observed === undefined || call.raisedAt > observed) {
      stalls.set(call.streamId, call.raisedAt);
    }
  }
  return {
    kind: 'request',
    calls,
    metadata: {
      [END_TURN_REQUEST_METADATA_KEY]: endTurnRequestSchema.parse({
        stalls: Object.fromEntries(stalls),
        requestedAt: now.toISOString(),
      }),
    },
  };
}

/** Match against owner timestamps the operator observed, independent of the CLI clock. */
export async function isEndTurnRequested(
  store: Pick<IWorkflowStore, 'getWorkflowRun'>,
  runId: string,
  stall: StreamStall
): Promise<boolean> {
  const run = await store.getWorkflowRun(runId);
  const request = endTurnRequestSchema.safeParse(run?.metadata[END_TURN_REQUEST_METADATA_KEY]);
  return (
    request.success &&
    Object.hasOwn(request.data.stalls, stall.streamId) &&
    stall.raisedAt <= request.data.stalls[stall.streamId]
  );
}
