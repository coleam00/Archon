/**
 * Rulings on an item (`remote_agent_item_rulings`): append-only facts. A row is a ruling or
 * the withdrawal of one; no row is ever updated, and nothing here reads a ruling's text
 * beyond returning it.
 */
import {
  ItemRulingNotFoundError,
  ItemRulingWithdrawnError,
  itemRulingSchema,
  type ItemRuling,
  type ItemRulingAct,
  type ItemRulingRead,
} from '@archon/workflows/schemas/item-ruling';
import { getDatabase, pool } from './connection';
import { ensureItemInProject } from './items';
import type { TransactionQuery } from './resource-slots';
import { toHydratedTimestamp } from './timestamps';
import { getLog } from './workflow-run-shared';

interface ActColumns {
  by_declared: string | null;
  by_user_id: string | null;
  via: string;
  from_run_id: string | null;
  from_node_path: string | null;
  created_at: string | Date;
}

interface RulingRow extends ActColumns {
  id: string;
  text: string | null;
  w_id: string | null;
  w_by_declared: string | null;
  w_by_user_id: string | null;
  w_via: string | null;
  w_from_run_id: string | null;
  w_from_node_path: string | null;
  w_created_at: string | Date | null;
}

function actColumns(act: ItemRulingAct): unknown[] {
  return [
    act.by !== null && 'declared' in act.by ? act.by.declared : null,
    act.by !== null && 'userId' in act.by ? act.by.userId : null,
    act.via,
    act.fromRun?.runId ?? null,
    act.fromRun?.nodePath ?? null,
    // Written here, to the millisecond: SQLite's default keeps only seconds. Order is `seq`.
    new Date().toISOString(),
  ];
}

/** The stored time in ISO form; one that does not parse is left as stored, and fails the read. */
function isoTime(value: string | Date): string {
  const time = toHydratedTimestamp(value);
  return Number.isNaN(time.getTime()) ? String(value) : time.toISOString();
}

function act(row: ActColumns): unknown {
  return {
    at: isoTime(row.created_at),
    via: row.via,
    by:
      row.by_declared !== null
        ? { declared: row.by_declared }
        : row.by_user_id !== null
          ? { userId: row.by_user_id }
          : null,
    fromRun:
      row.from_run_id === null
        ? null
        : { runId: row.from_run_id, nodePath: row.from_node_path ?? '' },
  };
}

function rulingRead(row: RulingRow): ItemRulingRead {
  const parsed = itemRulingSchema.safeParse({
    kind: 'ruling',
    id: row.id,
    text: row.text,
    ...(act(row) as object),
    withdrawn:
      row.w_id === null
        ? null
        : act({
            by_declared: row.w_by_declared,
            by_user_id: row.w_by_user_id,
            // NOT NULL in the schema; a missing value fails the parse below.
            via: row.w_via ?? '',
            from_run_id: row.w_from_run_id,
            from_node_path: row.w_from_node_path,
            created_at: row.w_created_at ?? '',
          }),
  });
  if (parsed.success) return parsed.data;
  // The parse error can quote the stored text.
  getLog().error({ rulingId: row.id }, 'item_ruling_unreadable');
  return { type: 'degraded', reason: 'ruling_unreadable', rulingId: row.id };
}

const RULINGS_SELECT = `SELECT r.*, w.id AS w_id, w.by_declared AS w_by_declared,
    w.by_user_id AS w_by_user_id, w.via AS w_via, w.from_run_id AS w_from_run_id,
    w.from_node_path AS w_from_node_path, w.created_at AS w_created_at
  FROM remote_agent_item_rulings r
  LEFT JOIN remote_agent_item_rulings w ON w.withdraws = r.id
  WHERE r.withdraws IS NULL`;

export async function listItemRulings(itemId: string): Promise<ItemRulingRead[]> {
  const result = await pool.query<RulingRow>(
    `${RULINGS_SELECT} AND r.item_id = $1 ORDER BY r.seq`,
    [itemId]
  );
  return result.rows.map(rulingRead);
}

async function readRuling(query: TransactionQuery, rulingId: string): Promise<ItemRuling> {
  const result = await query<RulingRow>(`${RULINGS_SELECT} AND r.id = $1`, [rulingId]);
  const row = result.rows[0];
  if (!row) throw new ItemRulingNotFoundError(rulingId);
  const read = rulingRead(row);
  if ('type' in read) throw new Error(`Ruling '${rulingId}' was written but does not read back`);
  return read;
}

const INSERT_COLUMNS =
  'item_id, withdraws, text, by_declared, by_user_id, via, from_run_id, from_node_path, created_at';

export async function recordItemRuling(
  input: { projectKey: string; key: string; text: string } & ItemRulingAct
): Promise<ItemRuling> {
  if (input.text.trim() === '') throw new Error('A ruling needs text.');
  return getDatabase().withTransaction(async query => {
    const itemId = await ensureItemInProject(query, input.projectKey, input.key);
    const inserted = await query<{ id: string }>(
      `INSERT INTO remote_agent_item_rulings (${INSERT_COLUMNS})
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [itemId, input.text, ...actColumns(input)]
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('The ruling was not written');
    return readRuling(query, id);
  });
}

export async function withdrawItemRuling(
  input: { rulingId: string } & ItemRulingAct
): Promise<ItemRuling> {
  return getDatabase().withTransaction(async query => {
    const found = await query<{ item_id: string; withdraws: string | null }>(
      'SELECT item_id, withdraws FROM remote_agent_item_rulings WHERE id = $1',
      [input.rulingId]
    );
    const ruling = found.rows[0];
    if (!ruling || ruling.withdraws !== null) throw new ItemRulingNotFoundError(input.rulingId);
    // UNIQUE(withdraws) decides a race between two withdrawals: the loser inserts nothing.
    const inserted = await query(
      `INSERT INTO remote_agent_item_rulings (${INSERT_COLUMNS})
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8) ON CONFLICT (withdraws) DO NOTHING`,
      [ruling.item_id, input.rulingId, ...actColumns(input)]
    );
    if (inserted.rowCount === 0) throw new ItemRulingWithdrawnError(input.rulingId);
    return readRuling(query, input.rulingId);
  });
}
