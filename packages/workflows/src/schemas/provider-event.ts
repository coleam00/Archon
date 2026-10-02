import { z } from '@hono/zod-openapi';
import { providerEventSchema } from '@archon/provider-contract';

/**
 * The engine's record of one provider event: the provider's object, unchanged, wrapped
 * with what only the engine knows. The run and the node are the row's or line's own
 * frame (`workflow_run_id`/`step_name` in the store, `workflow_id`/`step` in the JSONL
 * log), so the envelope does not repeat them.
 */
export const providerEventEnvelopeSchema = z.object({
  /** The node attempt that streamed the event: `NodeExecutionRecord.attempt.id`. */
  attemptId: z.string().min(1),
  /**
   * Emission order within the attempt, contiguous from 0. Store writes are not awaited,
   * so a store's own ordering can disagree with emission order; this cannot.
   */
  seq: z.number().int().nonnegative(),
  /** Engine clock when the event arrived, to the millisecond. */
  observedAt: z.iso.datetime(),
  /** The provider's event, exactly as yielded. */
  event: providerEventSchema,
});

export type ProviderEventEnvelope = z.infer<typeof providerEventEnvelopeSchema>;

/**
 * A served provider event: the envelope with its run and node.
 *
 * `attemptId` is null for a record translated from a row written before the engine
 * recorded envelopes (`tool_called`, `tool_completed`, `task_activity`,
 * `hook_activity`). Those records act as one attempt per node, and their `seq` counts
 * that node's legacy rows from 0 in store order.
 */
export const providerEventRecordSchema = providerEventEnvelopeSchema.extend({
  runId: z.string(),
  stepName: z.string(),
  attemptId: z.string().min(1).nullable(),
});

export type ProviderEventRecord = z.infer<typeof providerEventRecordSchema>;

/** Where a reader stopped: the last contiguous event it holds of one attempt. */
export interface ProviderEventCursor {
  attemptId: string;
  seq: number;
}

/**
 * What `IWorkflowStore.listProviderEvents` returns. A cursor names an attempt, and
 * attempts belong to one node, so a cursor needs the node too.
 */
export type ProviderEventQuery =
  | { stepName?: string; after?: undefined }
  | { stepName: string; after: ProviderEventCursor };

/**
 * Order records within one node the way they were emitted: attempts in the order they
 * first appear in `records`, and each attempt's events by `seq`. Legacy records (null
 * attempt) group as one attempt. Records of different nodes keep their relative order
 * only through their attempts, so call it per node.
 */
export function orderProviderEventRecords<T extends { attemptId: string | null; seq: number }>(
  records: readonly T[]
): T[] {
  const attemptRank = new Map<string | null, number>();
  for (const record of records) {
    if (!attemptRank.has(record.attemptId)) attemptRank.set(record.attemptId, attemptRank.size);
  }
  return [...records].sort(
    (a, b) =>
      (attemptRank.get(a.attemptId) ?? 0) - (attemptRank.get(b.attemptId) ?? 0) || a.seq - b.seq
  );
}

/**
 * The records after `cursor` within one node's ordered records: the cursor attempt's
 * later events and every event of an attempt that started after it. Empty when the
 * cursor's attempt is not among the records (its rows are not committed yet), because
 * nothing then says which attempts came later.
 */
export function providerEventRecordsAfter<T extends { attemptId: string | null; seq: number }>(
  ordered: readonly T[],
  cursor: ProviderEventCursor
): T[] {
  const start = ordered.findIndex(record => record.attemptId === cursor.attemptId);
  if (start === -1) return [];
  return ordered
    .slice(start)
    .filter(record => record.attemptId !== cursor.attemptId || record.seq > cursor.seq);
}

/**
 * A `provider_event` line in a run's JSONL log: the envelope inside the log's own line
 * frame. `step` is the same persisted step name the store row carries.
 */
export const providerEventLineSchema = providerEventEnvelopeSchema.extend({
  type: z.literal('provider_event'),
  workflow_id: z.string(),
  ts: z.iso.datetime(),
  step: z.string(),
});
