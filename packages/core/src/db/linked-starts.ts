/**
 * Linked run-ended starts, resolved inside the transaction that completes the run. A
 * binding with `on.runEnded.linked` starts its stage on the items the ended run's item is
 * linked to (the holders), so which items those are is read after the completing write
 * and before its commit: read earlier, a link ended meanwhile would still start a stage.
 *
 * The link rows read here are share-locked on PostgreSQL, so an end of one of them
 * (`endItemLink`) waits until this completion commits: the links that count are the links
 * active when the run completed. SQLite already serializes writers.
 */
import { randomUUID } from 'node:crypto';
import type {
  LinkedRunEndedStart,
  SourceReceiptAcceptance,
} from '@archon/workflows/schemas/resource-start';
import { getDatabaseType } from './connection';
import type { TransactionQuery } from './resource-slots';
import { insertStartReceipt } from './start-receipt-writes';

interface Holder {
  id: string;
  key: string;
}

/** The items holding an active link of the start's kind to the ended run's item. */
async function holdersOf(query: TransactionQuery, start: LinkedRunEndedStart): Promise<Holder[]> {
  const [holder, member] =
    start.link.holder === 'to' ? ['to_item_id', 'from_item_id'] : ['from_item_id', 'to_item_id'];
  const lock = getDatabaseType() === 'postgresql' ? ' FOR SHARE OF l' : '';
  const found = await query<Holder>(
    `SELECT i.id, i.key FROM remote_agent_item_links l
     JOIN remote_agent_items i ON i.id = l.${holder}
     WHERE l.${member} = $1 AND l.kind = $2 AND l.ended_at IS NULL
     ORDER BY i.id${lock}`,
    [start.endedItemId, start.link.kind]
  );
  return found.rows.map(row => ({ id: String(row.id), key: row.key }));
}

/**
 * Write the receipts `starts` cause, inside the completing transaction and after its
 * write, and return the ones written (a replay writes nothing): one per holder, the
 * engine's receipt for the ended run on the holder's key, keyed by the ended run and the
 * holder. The ended run stays the receipt's source actor, so the started run's cause
 * names it.
 */
export async function insertLinkedStarts(
  query: TransactionQuery,
  starts: readonly LinkedRunEndedStart[]
): Promise<SourceReceiptAcceptance[]> {
  const written: SourceReceiptAcceptance[] = [];
  for (const start of starts) {
    for (const holder of await holdersOf(query, start)) {
      const receipt: SourceReceiptAcceptance = {
        ...start.acceptance,
        receipt: {
          ...start.acceptance.receipt,
          id: randomUUID(),
          itemKey: holder.key,
          deliveryId: `${start.endedRunId}:${holder.id}`,
        },
      };
      if (!(await insertStartReceipt(query, receipt)).replay) written.push(receipt);
    }
  }
  return written;
}
