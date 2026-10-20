/**
 * An operator's request to end AI turns whose tools or background work stalled.
 *
 * A stream that reports live work suspends its idle watchdog, so work that never ends (a
 * background command polling forever) keeps the node open with nothing to time it out.
 * The stream raises `stalled_tool_calls` attention instead, and this request is the
 * operator's answer to it. It names the attention streams that were stalled when the
 * operator asked; each of those streams reads it at its status check and cuts itself off
 * as a timeout, so the node fails or retries under its retry policy and the run goes on.
 * A stream that recovered and stalled again after the request was made is not ended: the
 * request answers the stall the operator saw, not a later one.
 *
 * The request travels through run metadata, which every owner (server, detached CLI,
 * foreground CLI) already polls, so no owner endpoint is involved. Stream ids are unique
 * per stream pass, so a request left in metadata cannot end a later stream.
 */
import { z } from 'zod';

import {
  TOOL_CALL_ATTENTION_METADATA_KEY,
  toolCallAttentionArraySchema,
  type ToolCallAttention,
  type WorkflowRun,
} from './schemas/workflow-run';
import type { IWorkflowStore } from './store';
import type { StreamStall } from './tool-call-attention';

export const END_TURN_REQUEST_METADATA_KEY = 'end_turn_request';

const endTurnRequestSchema = z.object({
  stalls: z.record(z.string().min(1), z.iso.datetime()),
  requestedAt: z.iso.datetime(),
});

export type EndTurnPlan =
  | { kind: 'request'; calls: ToolCallAttention[]; metadata: Record<string, unknown> }
  | { kind: 'refused'; reason: 'not_running' | 'nothing_stalled' };

/** What ending the run's stalled turns would write, or why there is nothing to end. */
export function planEndTurn(
  run: Pick<WorkflowRun, 'status' | 'metadata'>,
  now: Date = new Date()
): EndTurnPlan {
  if (run.status !== 'running') return { kind: 'refused', reason: 'not_running' };
  const parsed = toolCallAttentionArraySchema.safeParse(
    run.metadata[TOOL_CALL_ATTENTION_METADATA_KEY] ?? []
  );
  const calls = parsed.success ? parsed.data : [];
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
      [END_TURN_REQUEST_METADATA_KEY]: {
        stalls: Object.fromEntries(stalls),
        requestedAt: now.toISOString(),
      },
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
