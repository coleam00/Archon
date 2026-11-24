/**
 * Links between items (`remote_agent_item_links`). One row per link: what the link says
 * and who recorded it are written at insert and never change; the `ended_*` columns are
 * written once, when the link is ended. A partial unique index keeps one active row per
 * (from, to, kind). Nothing here gives a kind any meaning.
 */
import type { ItemAct } from '@archon/workflows/schemas/item-act';
import {
  ItemLinkEndedError,
  ItemLinkNotFoundError,
  ItemLinkOutsideProjectError,
  ItemLinkSelfError,
  itemLinkSchema,
  type ItemLink,
  type ItemLinkKind,
  type ItemLinkRead,
} from '@archon/workflows/schemas/item-link';
import { getDatabase, pool } from './connection';
import { actColumns, actRead, type ActColumns } from './item-act';
import { ensureItemInProject } from './items';
import type { TransactionQuery } from './resource-slots';
import { getLog } from './workflow-run-shared';

interface LinkRow extends ActColumns {
  id: string;
  kind: string;
  from_item_id: string;
  from_project_key: string;
  from_key: string;
  from_title: string | null;
  to_item_id: string;
  to_project_key: string;
  to_key: string;
  to_title: string | null;
  ended_at: string | Date | null;
  ended_by_declared: string | null;
  ended_by_user_id: string | null;
  ended_via: string | null;
  ended_from_run_id: string | null;
  ended_from_node_path: string | null;
}

function linkRead(row: LinkRow): ItemLinkRead {
  const parsed = itemLinkSchema.safeParse({
    id: row.id,
    kind: row.kind,
    from: {
      id: row.from_item_id,
      projectKey: row.from_project_key,
      key: row.from_key,
      title: row.from_title,
    },
    to: {
      id: row.to_item_id,
      projectKey: row.to_project_key,
      key: row.to_key,
      title: row.to_title,
    },
    ...actRead(row),
    ended:
      row.ended_at === null
        ? null
        : actRead({
            by_declared: row.ended_by_declared,
            by_user_id: row.ended_by_user_id,
            // Set with ended_at, by a CHECK; a missing value fails the parse below.
            via: row.ended_via ?? '',
            from_run_id: row.ended_from_run_id,
            from_node_path: row.ended_from_node_path,
            created_at: row.ended_at,
          }),
  });
  if (parsed.success) return parsed.data;
  // The parse error can quote item keys; the id is enough to find the row.
  getLog().error({ linkId: row.id }, 'item_link_unreadable');
  return { type: 'degraded', reason: 'link_unreadable', linkId: row.id };
}

const LINKS_SELECT = `SELECT l.*, f.project_key AS from_project_key, f.key AS from_key,
    f.title AS from_title, t.project_key AS to_project_key, t.key AS to_key, t.title AS to_title
  FROM remote_agent_item_links l
  JOIN remote_agent_items f ON f.id = l.from_item_id
  JOIN remote_agent_items t ON t.id = l.to_item_id`;

/** Every link from or to the item, ended ones included, in recording order. */
export async function listItemLinks(itemId: string): Promise<ItemLinkRead[]> {
  const result = await pool.query<LinkRow>(
    `${LINKS_SELECT} WHERE l.from_item_id = $1 OR l.to_item_id = $1 ORDER BY l.seq`,
    [itemId]
  );
  return result.rows.map(linkRead);
}

async function readLink(query: TransactionQuery, linkId: string): Promise<ItemLink> {
  const result = await query<LinkRow>(`${LINKS_SELECT} WHERE l.id = $1`, [linkId]);
  const row = result.rows[0];
  if (!row) throw new ItemLinkNotFoundError(linkId);
  return readableLink(row);
}

function readableLink(row: LinkRow): ItemLink {
  const read = linkRead(row);
  if ('type' in read) throw new Error(`Link '${row.id}' was written but does not read back`);
  return read;
}

/**
 * Record a link from the item `fromKey` names to the one `toKey` names, both in
 * `projectKey` and each written on first use. An active link of the same kind between the
 * same two items in the same direction is returned as it is, with `created: false`.
 */
export async function recordItemLink(
  input: { projectKey: string; fromKey: string; toKey: string; kind: ItemLinkKind } & ItemAct
): Promise<{ link: ItemLink; created: boolean }> {
  return getDatabase().withTransaction(async query => {
    const fromId = await ensureItemInProject(query, input.projectKey, input.fromKey);
    const toId = await ensureItemInProject(query, input.projectKey, input.toKey);
    if (fromId === toId) throw new ItemLinkSelfError(input.fromKey);
    // The partial unique index decides a race between two records: the loser inserts nothing.
    // On PostgreSQL another operator can end the active link between the insert that
    // conflicted with it and the select that looks for it; then the insert is tried again.
    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = await query<{ id: string }>(
        `INSERT INTO remote_agent_item_links
           (from_item_id, to_item_id, kind, by_declared, by_user_id, via, from_run_id,
            from_node_path, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (from_item_id, to_item_id, kind) WHERE ended_at IS NULL DO NOTHING
         RETURNING id`,
        [fromId, toId, input.kind, ...actColumns(input)]
      );
      const insertedId = inserted.rows[0]?.id;
      if (insertedId !== undefined)
        return { link: await readLink(query, insertedId), created: true };
      // One statement, so the row returned is active as of that statement.
      const active = await query<LinkRow>(
        `${LINKS_SELECT} WHERE l.from_item_id = $1 AND l.to_item_id = $2 AND l.kind = $3
           AND l.ended_at IS NULL`,
        [fromId, toId, input.kind]
      );
      const activeRow = active.rows[0];
      if (activeRow) return { link: readableLink(activeRow), created: false };
    }
    throw new Error('The link was neither written nor found active after a retry');
  });
}

/** With `projectKey`, a link from an item of another project is refused and not ended. */
export async function endItemLink(
  input: { linkId: string; projectKey?: string } & ItemAct
): Promise<ItemLink> {
  return getDatabase().withTransaction(async query => {
    const found = await query<{ project_key: string }>(
      `SELECT f.project_key FROM remote_agent_item_links l
       JOIN remote_agent_items f ON f.id = l.from_item_id WHERE l.id = $1`,
      [input.linkId]
    );
    const link = found.rows[0];
    if (!link) throw new ItemLinkNotFoundError(input.linkId);
    if (input.projectKey !== undefined && link.project_key !== input.projectKey)
      throw new ItemLinkOutsideProjectError(input.linkId, input.projectKey);
    // `ended_at IS NULL` decides a race between two ends: the loser updates nothing.
    const updated = await query(
      `UPDATE remote_agent_item_links SET ended_by_declared = $2, ended_by_user_id = $3,
         ended_via = $4, ended_from_run_id = $5, ended_from_node_path = $6, ended_at = $7
       WHERE id = $1 AND ended_at IS NULL`,
      [input.linkId, ...actColumns(input)]
    );
    if (updated.rowCount === 0) throw new ItemLinkEndedError(input.linkId);
    return readLink(query, input.linkId);
  });
}
