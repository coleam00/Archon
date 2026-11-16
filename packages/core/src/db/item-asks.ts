/**
 * Asks on an item (`remote_agent_item_asks`): the decisions a completed run left for an
 * operator. A row opens in the write that completes its run and closes once, as answered,
 * withdrawn or replaced. The asks one run left are a set; the write that closes the last
 * open one of a set records `asks_settled` on that run. The rows are the item's record of its
 * asks and outlive the run; the events are notices for readers of the run's event tail.
 * Nothing here logs an ask's text.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  storedItemAskSchema,
  type AskClosedEventData,
  type AsksSettledData,
  type ItemAsk,
  type ItemAskAct,
  type ItemAskActInput,
  type ItemAskCloseResult,
  type StoredItemAsk,
} from '@archon/workflows/schemas/item-ask';
import type { AttentionRead } from '@archon/workflows/schemas/attention-degraded';
import { attentionAnswerSchema, type AttentionAnswer } from '@archon/workflows/schemas/run-wait';
import { getDatabase, getDatabaseType, pool } from './connection';
import type { TransactionQuery } from './resource-slots';
import { toHydratedTimestamp } from './timestamps';
import { insertWorkflowEvent } from './workflow-events';
import { getLog } from './workflow-run-shared';

interface AskRow {
  id: string;
  item_id: string;
  run_id: string;
  workflow_name: string;
  position: number | string;
  ask: unknown;
  created_at: string | Date;
  closed_as: string | null;
  answer: unknown;
  closed_at: string | Date | null;
  closed_via: string | null;
  closed_by_declared: string | null;
  closed_by_user_id: string | null;
  closed_from_run_id: string | null;
  closed_from_node_path: string | null;
  replaced_by_run_id: string | null;
}

/** SQLite returns a JSON column as text, PostgreSQL as the parsed value. */
function jsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isoTime(value: string | Date): string {
  const time = toHydratedTimestamp(value);
  return Number.isNaN(time.getTime()) ? String(value) : time.toISOString();
}

class UnreadableAskError extends Error {
  constructor(readonly askId: string) {
    super(`Ask '${askId}' is stored in a form this binary cannot read.`);
    this.name = 'UnreadableAskError';
  }
}

function closeAct(row: AskRow): ItemAskAct {
  return {
    at: isoTime(row.closed_at ?? ''),
    // NOT NULL whenever the row is answered or withdrawn; a missing value fails the read.
    via: (row.closed_via ?? '') as ItemAskAct['via'],
    by:
      row.closed_by_declared !== null
        ? { declared: row.closed_by_declared }
        : row.closed_by_user_id !== null
          ? { userId: row.closed_by_user_id }
          : null,
    fromRun:
      row.closed_from_run_id === null
        ? null
        : { runId: row.closed_from_run_id, nodePath: row.closed_from_node_path ?? '' },
  };
}

function closure(row: AskRow): StoredItemAsk['closed'] | undefined {
  switch (row.closed_as) {
    case null:
      return null;
    case 'answered': {
      const answer = attentionAnswerSchema.safeParse(jsonColumn(row.answer));
      return answer.success
        ? { as: 'answered', answer: answer.data, act: closeAct(row) }
        : undefined;
    }
    case 'withdrawn':
      return { as: 'withdrawn', act: closeAct(row) };
    case 'replaced':
      return row.replaced_by_run_id === null || row.closed_at === null
        ? undefined
        : { as: 'replaced', at: isoTime(row.closed_at), byRunId: row.replaced_by_run_id };
    default:
      return undefined;
  }
}

/** The row as an ask, or undefined when it does not read; the caller reports which. */
function readAsk(row: AskRow): StoredItemAsk | undefined {
  const ask = storedItemAskSchema.safeParse(jsonColumn(row.ask));
  const closed = closure(row);
  if (!ask.success || closed === undefined) return undefined;
  return {
    id: row.id,
    itemId: String(row.item_id),
    runId: row.run_id,
    workflowName: row.workflow_name,
    position: Number(row.position),
    ask: ask.data,
    openedAt: isoTime(row.created_at),
    closed,
  };
}

function readAskOrThrow(row: AskRow): StoredItemAsk {
  const read = readAsk(row);
  if (read !== undefined) return read;
  // The parse error can quote the stored text.
  getLog().error({ askId: row.id }, 'item_ask_unreadable');
  throw new UnreadableAskError(row.id);
}

/**
 * Open the asks a completed run left, inside the transaction that completes it, after
 * closing as `replaced` the asks still open from the same workflow on the same item.
 * Called only when that transaction won the run's change to `completed`.
 */
export async function openItemAsksForCompletedRun(
  query: TransactionQuery,
  runId: string,
  asks: readonly ItemAsk[]
): Promise<void> {
  const found = await query<{ item_id: string | null; workflow_name: string }>(
    'SELECT item_id, workflow_name FROM remote_agent_workflow_runs WHERE id = $1',
    [runId]
  );
  const run = found.rows[0];
  if (run === undefined) throw new Error(`Run '${runId}' was not found while opening its asks`);
  if (run.item_id === null) {
    if (asks.length > 0)
      throw new Error(`Run '${runId}' left asks but has no item; an ask belongs to an item`);
    return;
  }
  const now = new Date().toISOString();
  await query(
    `UPDATE remote_agent_item_asks
     SET closed_as = 'replaced', closed_at = $1, replaced_by_run_id = $2
     WHERE item_id = $3 AND workflow_name = $4 AND closed_as IS NULL`,
    [now, runId, run.item_id, run.workflow_name]
  );
  for (const [position, ask] of asks.entries())
    await query(
      `INSERT INTO remote_agent_item_asks (item_id, run_id, workflow_name, position, ask, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [run.item_id, runId, run.workflow_name, position, JSON.stringify(ask), now]
    );
}

function readAsks(rows: readonly AskRow[]): AttentionRead<StoredItemAsk>[] {
  return rows.map(row => {
    const read = readAsk(row);
    if (read !== undefined) return read;
    getLog().error({ askId: row.id }, 'item_ask_unreadable');
    // The queue names an unreadable entry by run: the run that left the ask.
    return { type: 'degraded', reason: 'run_unreadable', runId: row.run_id };
  });
}

export async function listOpenItemAsks(): Promise<AttentionRead<StoredItemAsk>[]> {
  const result = await pool.query<AskRow>(
    `SELECT * FROM remote_agent_item_asks WHERE closed_as IS NULL
     ORDER BY created_at, run_id, position`
  );
  return readAsks(result.rows);
}

export async function listItemAsks(itemId: string): Promise<AttentionRead<StoredItemAsk>[]> {
  const result = await pool.query<AskRow>(
    `SELECT * FROM remote_agent_item_asks WHERE item_id = $1
     ORDER BY created_at, run_id, position`,
    [itemId]
  );
  return readAsks(result.rows);
}

export async function getItemAsk(id: string): Promise<StoredItemAsk | null> {
  const result = await pool.query<AskRow>('SELECT * FROM remote_agent_item_asks WHERE id = $1', [
    id,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : readAskOrThrow(row);
}

type CloseWrite = { as: 'answered'; answer: AttentionAnswer } | { as: 'withdrawn' };

/** What an earlier close means for this one: the same close changes nothing; another stands. */
function priorClose(ask: StoredItemAsk, write: CloseWrite): ItemAskCloseResult | undefined {
  const { closed } = ask;
  if (closed === null) return undefined;
  const same =
    closed.as === write.as &&
    (write.as !== 'answered' ||
      (closed.as === 'answered' && isDeepStrictEqual(closed.answer, write.answer)));
  return same ? { kind: 'unchanged', ask } : { kind: 'refused', ask };
}

async function closeItemAsk(
  input: { askId: string } & ItemAskActInput,
  write: CloseWrite
): Promise<ItemAskCloseResult> {
  const lock = getDatabaseType() === 'postgresql' ? ' FOR UPDATE' : '';
  return getDatabase().withTransaction(async query => {
    const target = await query<{ run_id: string }>(
      'SELECT run_id FROM remote_agent_item_asks WHERE id = $1',
      [input.askId]
    );
    const runId = target.rows[0]?.run_id;
    if (runId === undefined) return { kind: 'not_found' };
    // Lock the whole set before reading it, so two closes racing for its last open ask
    // cannot each see the other open and both skip the settle.
    const set = await query<AskRow>(
      `SELECT * FROM remote_agent_item_asks WHERE run_id = $1 ORDER BY position${lock}`,
      [runId]
    );
    const row = set.rows.find(candidate => candidate.id === input.askId);
    if (row === undefined) return { kind: 'not_found' };
    const before = readAskOrThrow(row);
    const prior = priorClose(before, write);
    if (prior !== undefined) return prior;

    const at = new Date().toISOString();
    const by = input.by;
    await query(
      `UPDATE remote_agent_item_asks
       SET closed_as = $2, answer = $3, closed_at = $4, closed_via = $5, closed_by_declared = $6,
           closed_by_user_id = $7, closed_from_run_id = $8, closed_from_node_path = $9
       WHERE id = $1 AND closed_as IS NULL`,
      [
        input.askId,
        write.as,
        write.as === 'answered' ? JSON.stringify(write.answer) : null,
        at,
        input.via,
        by !== null && 'declared' in by ? by.declared : null,
        by !== null && 'userId' in by ? by.userId : null,
        input.fromRun?.runId ?? null,
        input.fromRun?.nodePath ?? null,
      ]
    );
    await insertWorkflowEvent(query, {
      workflow_run_id: runId,
      event_type: write.as === 'answered' ? 'ask_answered' : 'ask_withdrawn',
      data: {
        ask: input.askId,
        via: input.via,
        by,
        fromRun: input.fromRun ?? null,
        ...(write.as === 'answered' ? { answer: write.answer } : {}),
      } satisfies AskClosedEventData,
    });
    const others = set.rows.filter(candidate => candidate.id !== input.askId);
    const settled = others.every(candidate => candidate.closed_as !== null);
    if (settled) {
      const closedAs = [write.as, ...others.map(candidate => candidate.closed_as)];
      const data: AsksSettledData = {
        answered: closedAs.filter(as => as === 'answered').length,
        withdrawn: closedAs.filter(as => as === 'withdrawn').length,
      };
      await insertWorkflowEvent(query, {
        workflow_run_id: runId,
        event_type: 'asks_settled',
        data,
      });
    }
    const after = await query<AskRow>('SELECT * FROM remote_agent_item_asks WHERE id = $1', [
      input.askId,
    ]);
    const closedRow = after.rows[0];
    if (closedRow === undefined)
      throw new Error(`Ask '${input.askId}' was closed but does not read back`);
    return { kind: 'closed', ask: readAskOrThrow(closedRow), settled };
  });
}

export function answerItemAsk(
  input: { askId: string; answer: AttentionAnswer } & ItemAskActInput
): Promise<ItemAskCloseResult> {
  return closeItemAsk(input, { as: 'answered', answer: input.answer });
}

export function withdrawItemAsk(
  input: { askId: string } & ItemAskActInput
): Promise<ItemAskCloseResult> {
  return closeItemAsk(input, { as: 'withdrawn' });
}
