/**
 * The one place the stores read whether stored work is a step of its item.
 *
 * The role is one recorded fact: `observes_item` in the run metadata preparation writes
 * (`observesItemMetadata`). A run reads it from its row (`stepRun`). A queued request reads it
 * from its prepared launch (`launchRunsStep`, through `queuedItemStarts`). An unprepared
 * binding has no record yet, so its role is `unprepared` (`ItemStart`); nothing reads its
 * target's definition to guess it. The consumers decide from the role:
 * - End: only a step opens an end or refuses `workflow end`. An unprepared start opens it once
 *   it is prepared and queued as a step, or once its run exists.
 * - Stop: a start the stopped run caused, on that run's own item, holds the stop back while
 *   it is a step or unprepared; an observer holds nothing. Once its run exists, `stepRun`
 *   decides.
 */
import type { ItemStart } from '@archon/workflows/resource-start-store';
import {
  sourceReceiptInputSchema,
  startCause,
  type StartCause,
} from '@archon/workflows/schemas/resource-start';
import {
  OBSERVES_ITEM_METADATA_KEY,
  observesItemRecorded,
} from '@archon/workflows/schemas/run-metadata';
import { getDialect } from './connection';
import type { TransactionQuery } from './resource-slots';

/** SQL true when run `alias` is a step of its item, not a run that observes it. */
export function stepRun(alias: string): string {
  return `${getDialect().jsonText(`${alias}.metadata`, OBSERVES_ITEM_METADATA_KEY)} IS NULL`;
}

/**
 * Whether a prepared launch, as a start request stores it, will run a step: the run it creates
 * does not record `observes_item`. The launch is stored as text, so it is read here rather than
 * in SQL. A launch that does not read counts as a step, as every start did before.
 */
export function launchRunsStep(launch: unknown): boolean {
  try {
    const parsed: unknown = typeof launch === 'string' ? JSON.parse(launch) : launch;
    const run = (parsed as { run?: { metadata?: unknown } } | null)?.run;
    return !observesItemRecorded(run?.metadata);
  } catch {
    return true;
  }
}

/**
 * What caused a start, from its stored receipt (`startCause`), or null when the start has no
 * receipt or the receipt's source actor does not read: such a start names no run.
 */
export function storedStartCause(receipt: {
  id: string | null;
  sourceInstanceId: string | null;
  sourceActor: unknown;
}): StartCause | null {
  if (receipt.id === null || receipt.sourceInstanceId === null) return null;
  let stored: unknown;
  try {
    stored =
      typeof receipt.sourceActor === 'string'
        ? JSON.parse(receipt.sourceActor)
        : (receipt.sourceActor ?? null);
  } catch {
    return null;
  }
  const actor = sourceReceiptInputSchema.shape.sourceActor.safeParse(stored);
  if (!actor.success) return null;
  return startCause({
    id: receipt.id,
    sourceInstanceId: receipt.sourceInstanceId,
    sourceActor: actor.data,
  });
}

/**
 * The queued requests on item `itemId`, oldest first, each with its cause and the role its
 * prepared launch records. Takes the caller's query, so the end command reads them inside the
 * transaction that writes the end.
 */
export async function queuedItemStarts(
  query: TransactionQuery,
  itemId: string
): Promise<Extract<ItemStart, { phase: 'queued' }>[]> {
  const queued = await query<{
    id: string;
    launch: unknown;
    receipt_id: string | null;
    source_instance_id: string | null;
    source_actor: unknown;
  }>(
    `SELECT CAST(q.id AS TEXT) AS id, q.launch, CAST(r.id AS TEXT) AS receipt_id,
            r.source_instance_id, r.source_actor
       FROM remote_agent_resource_start_requests q
       LEFT JOIN remote_agent_start_receipts r ON r.id = q.receipt_id
      WHERE q.item_id = $1 AND q.status = 'queued'
      ORDER BY q.created_at`,
    [itemId]
  );
  return queued.rows.map(row => ({
    phase: 'queued',
    requestId: row.id,
    cause: storedStartCause({
      id: row.receipt_id,
      sourceInstanceId: row.source_instance_id,
      sourceActor: row.source_actor,
    }),
    role: launchRunsStep(row.launch) ? 'step' : 'observer',
  }));
}
