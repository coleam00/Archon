import { z } from 'zod';

import {
  TOOL_CALL_ATTENTION_METADATA_KEY,
  toolCallAttentionArraySchema,
  toolCallAttentionSchema,
  type ToolCallAttention,
  type WorkflowRun,
} from './schemas/workflow-run';
import type { IWorkflowStore } from './store';
import type { StreamStall } from './tool-call-attention';

/** Requests bind to the owner-observed stall, never to the requester's clock. */
export const END_TURN_REQUEST_METADATA_KEY = 'end_turn_request';

export const endTurnRequestSchema = z.object({
  stalls: z
    .array(toolCallAttentionSchema.pick({ streamId: true, toolCallId: true, raisedAt: true }))
    .min(1),
});

type EndTurnMetadata = {
  [END_TURN_REQUEST_METADATA_KEY]: z.infer<typeof endTurnRequestSchema>;
};

export type EndTurnPlan =
  | { kind: 'request'; calls: ToolCallAttention[]; metadata: EndTurnMetadata }
  | { kind: 'refused'; reason: 'not_running' | 'nothing_stalled' | 'unreadable_attention' };

/** What ending the run's stalled turns would write, or why there is nothing to end. */
export function planEndTurn(run: Pick<WorkflowRun, 'status' | 'metadata'>): EndTurnPlan {
  if (run.status !== 'running') return { kind: 'refused', reason: 'not_running' };
  const parsed = toolCallAttentionArraySchema.safeParse(
    run.metadata[TOOL_CALL_ATTENTION_METADATA_KEY] === undefined
      ? []
      : run.metadata[TOOL_CALL_ATTENTION_METADATA_KEY]
  );
  if (!parsed.success) return { kind: 'refused', reason: 'unreadable_attention' };
  const calls = parsed.data;
  if (calls.length === 0) return { kind: 'refused', reason: 'nothing_stalled' };
  return {
    kind: 'request',
    calls,
    metadata: {
      [END_TURN_REQUEST_METADATA_KEY]: endTurnRequestSchema.parse({
        stalls: calls.map(({ streamId, toolCallId, raisedAt }) => ({
          streamId,
          toolCallId,
          raisedAt,
        })),
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
  if (run?.status !== 'running') return false;
  const request = endTurnRequestSchema.safeParse(run?.metadata[END_TURN_REQUEST_METADATA_KEY]);
  return (
    request.success &&
    stall.some(current =>
      request.data.stalls.some(
        observed =>
          current.streamId === observed.streamId &&
          current.toolCallId === observed.toolCallId &&
          current.raisedAt === observed.raisedAt
      )
    )
  );
}
