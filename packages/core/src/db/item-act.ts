/** The columns an act on an item is stored in, shared by rulings and links. */
import type { ItemAct } from '@archon/workflows/schemas/item-act';
import { toHydratedTimestamp } from './timestamps';

export interface ActColumns {
  by_declared: string | null;
  by_user_id: string | null;
  via: string;
  from_run_id: string | null;
  from_node_path: string | null;
  created_at: string | Date;
}

/** by_declared, by_user_id, via, from_run_id, from_node_path, and the time, in that order. */
export function actColumns(act: ItemAct): unknown[] {
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

/** The act as `itemActFields` reads it, unparsed; the caller's schema parses it. */
export function actRead(row: ActColumns): Record<string, unknown> {
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
