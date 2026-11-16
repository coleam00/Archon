/**
 * Linked run-ended starts, resolved inside the transaction that completes the run. A
 * binding with `on.runEnded.linked` starts its stage on the items the ended run's item is
 * linked to (the holders), so which items those are, and for `all` whether every item
 * linked to a holder is done, must be read after the completing write and before its
 * commit: read earlier, two members ending at the same moment each see the other
 * unfinished and nothing starts, and a link ended meanwhile would still count.
 *
 * Every link row read here is share-locked on PostgreSQL, so an end of one of those links
 * (`endItemLink`) waits until this completion commits: the links counted are the links
 * active when the run completed. SQLite already serializes writers.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  LinkedRunEndedStart,
  SourceReceiptAcceptance,
} from '@archon/workflows/schemas/resource-start';
import { getDatabaseType, getDialect } from './connection';
import type { TransactionQuery } from './resource-slots';
import { insertStartReceipt } from './start-receipt-writes';

/** Share-locks the selected link rows on PostgreSQL; SQLite needs no row lock. */
function shareLock(table?: string): string {
  if (getDatabaseType() !== 'postgresql') return '';
  return table === undefined ? ' FOR SHARE' : ` FOR SHARE OF ${table}`;
}

interface Holder {
  id: string;
  key: string;
}

/** The link column the holder is on, and the one its linked items are on. */
function ends(link: LinkedRunEndedStart['link']): { holder: string; member: string } {
  return link.holder === 'to'
    ? { holder: 'to_item_id', member: 'from_item_id' }
    : { holder: 'from_item_id', member: 'to_item_id' };
}

/** The items holding an active link of the start's kind to the ended run's item. */
async function holdersOf(query: TransactionQuery, start: LinkedRunEndedStart): Promise<Holder[]> {
  const { holder, member } = ends(start.link);
  const found = await query<Holder>(
    `SELECT i.id, i.key FROM remote_agent_item_links l
     JOIN remote_agent_items i ON i.id = l.${holder}
     WHERE l.${member} = $1 AND l.kind = $2 AND l.ended_at IS NULL
     ORDER BY i.id${shareLock('l')}`,
    [start.endedItemId, start.link.kind]
  );
  return found.rows.map(row => ({ id: String(row.id), key: row.key }));
}

/**
 * Whether `itemId`'s latest completed run of `workflowName` completed with `outcome`. A
 * member re-run to another outcome is no longer done; failed and cancelled runs have no
 * outcome and do not count either way. "Latest" is completion order: the `event_order` of
 * the run's `workflow_completed` event, a sequence both backends assign in commit order.
 * `completed_at` cannot order them: SQLite records it to the second, and on PostgreSQL it
 * is the completing transaction's start. A run written before completed_outcome existed
 * reads its boolean `outcome`, as `displayedRunOutcome` does.
 */
async function isDone(
  query: TransactionQuery,
  itemId: string,
  start: LinkedRunEndedStart
): Promise<boolean> {
  const latest = await query<{ completed_outcome: string | null; outcome: string | null }>(
    `SELECT r.completed_outcome, r.outcome FROM remote_agent_workflow_runs r
     WHERE r.item_id = $1 AND r.workflow_name = $2 AND r.status = 'completed'
     ORDER BY COALESCE((SELECT MAX(e.event_order) FROM remote_agent_workflow_events e
                        WHERE e.workflow_run_id = r.id AND e.event_type = 'workflow_completed'), 0) DESC,
              r.completed_at DESC
     LIMIT 1`,
    [itemId, start.workflowName]
  );
  const row = latest.rows[0];
  return (row?.completed_outcome ?? row?.outcome) === start.outcome;
}

/** The receipt for one holder, from the one the engine built for the ended run. */
function forHolder(
  start: LinkedRunEndedStart,
  holder: Holder,
  identity: { deliveryId: string; contentDigest?: string }
): SourceReceiptAcceptance {
  const { acceptance } = start;
  return {
    ...acceptance,
    receipt: {
      ...acceptance.receipt,
      id: randomUUID(),
      itemKey: holder.key,
      deliveryId: identity.deliveryId,
      contentDigest: identity.contentDigest ?? acceptance.receipt.contentDigest,
    },
  };
}

/** The receipt `start` causes on `holder`, or undefined when an `all` set is not done. */
async function receiptForHolder(
  query: TransactionQuery,
  start: LinkedRunEndedStart,
  holder: Holder
): Promise<SourceReceiptAcceptance | undefined> {
  if (start.form === 'each')
    return forHolder(start, holder, { deliveryId: `${start.endedRunId}:${holder.id}` });
  const { holder: holderEnd, member } = ends(start.link);
  const linked = await query<{ id: string }>(
    `SELECT ${member} AS id FROM remote_agent_item_links
     WHERE ${holderEnd} = $1 AND kind = $2 AND ended_at IS NULL${shareLock()}`,
    [holder.id, start.link.kind]
  );
  const members = linked.rows.map(row => String(row.id)).sort();
  // A holder with no active member is never done: there is no set to have finished.
  if (members.length === 0) return undefined;
  for (const id of members) {
    // The ended item is done by this completion, which ended with the outcome. Its own
    // event cannot say so: PostgreSQL assigns an event's final order at commit (a deferred
    // trigger), so until then this run's provisional order can sort behind another review
    // of the same item that committed meanwhile, and the count would read that one.
    if (id === start.endedItemId) continue;
    if (!(await isDone(query, id, start))) return undefined;
  }
  const set = createHash('sha256').update(JSON.stringify(members)).digest('hex');
  // The digest is the set, not the binding: an edited file then replays the receipt when a
  // member re-runs, rather than conflicting with it and failing that completion.
  return forHolder(start, holder, { deliveryId: `all:${holder.id}:${set}`, contentDigest: set });
}

/**
 * Write the receipts `starts` cause, inside the completing transaction and after its
 * write, and return the ones written (a replay writes nothing). `each` writes one per
 * holder, keyed by the ended run and the holder. `all` writes one per holder whose linked
 * items are all done, keyed by the holder and that set of items, so a member that runs
 * again later replays it and a member linked later makes a new set.
 */
export async function insertLinkedStarts(
  query: TransactionQuery,
  starts: readonly LinkedRunEndedStart[]
): Promise<SourceReceiptAcceptance[]> {
  const resolved: { start: LinkedRunEndedStart; holders: Holder[] }[] = [];
  for (const start of starts) resolved.push({ start, holders: await holdersOf(query, start) });
  // Lock every `all` holder first, in one id order across all bindings, so two completions
  // never wait on each other's holders. On PostgreSQL (READ COMMITTED) the second of two
  // members ending together waits here until the first commits, and its count below then
  // sees the first one's completed run: exactly one of them writes the start. SQLite
  // already holds the database write lock from the completing UPDATE.
  const locked = [
    ...new Set(
      resolved
        .filter(({ start }) => start.form === 'all')
        .flatMap(({ holders }) => holders.map(holder => holder.id))
    ),
  ].sort();
  for (const id of locked)
    await query(`SELECT id FROM remote_agent_items WHERE id = $1${getDialect().rowLock()}`, [id]);

  const written: SourceReceiptAcceptance[] = [];
  for (const { start, holders } of resolved) {
    for (const holder of holders) {
      const receipt = await receiptForHolder(query, start, holder);
      if (receipt && !(await insertStartReceipt(query, receipt)).replay) written.push(receipt);
    }
  }
  return written;
}
