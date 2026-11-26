/**
 * Waits on an item (`remote_agent_item_waits`): what a completed run said its item now waits
 * for outside Archon. A set opens in the write that completes its run and closes once, all
 * its rows together: met by an accepted event, replaced by a later completed run of the same
 * workflow on the item, or withdrawn. The write that meets a set also writes the start it
 * causes, in the receipt's transaction, so an event that arrives twice starts it once.
 * Nothing here fires at a deadline.
 */
import type {
  ItemWait,
  ItemWaitsWithdrawResult,
  MetWaitInput,
  StoredItemWait,
} from '@archon/workflows/schemas/item-wait';
import type { AttentionRead } from '@archon/workflows/schemas/attention-degraded';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import type { JsonValue } from '@archon/workflows/output-ref';
import {
  sourceReceiptAcceptanceSchema,
  type BindingWake,
  type CheckoutHandoff,
  type ResourceStartBindingIntent,
  type SourceReceiptAcceptance,
  withCheckoutFrom,
} from '@archon/workflows/schemas/resource-start';
import { getDatabaseType, getDatabase, pool } from './connection';
import { readItemAsksIn, readRunMetadataIn } from './item-asks';
import { recordRunRefusedStart } from './item-stops';
import type { TransactionQuery } from './resource-slots';
import { toHydratedTimestamp } from './timestamps';

interface WaitRow {
  id: string;
  item_id: string;
  run_id: string;
  workflow_name: string;
  position: number | string;
  event: string;
  about: string;
  subject_kind: string | null;
  subject_number: number | string | null;
  created_at: string | Date;
  deadline_at: string | Date;
  closed_as: string | null;
  closed_at: string | Date | null;
  met_by_receipt_id: string | null;
  met_by_binding_id: string | null;
  replaced_by_run_id: string | null;
}

function isoTime(value: string | Date): string {
  const time = toHydratedTimestamp(value);
  return Number.isNaN(time.getTime()) ? String(value) : time.toISOString();
}

/**
 * How the row closed. A close this binary does not know (a later one wrote it) reads as a
 * withdrawal: the wait is not open, and nothing here acts on how it closed.
 */
function closure(row: WaitRow): StoredItemWait['closed'] {
  if (row.closed_as === null) return null;
  const at = isoTime(row.closed_at ?? row.created_at);
  if (row.closed_as === 'met' && row.met_by_receipt_id !== null && row.met_by_binding_id !== null)
    return { as: 'met', at, receiptId: row.met_by_receipt_id, bindingId: row.met_by_binding_id };
  if (row.closed_as === 'replaced' && row.replaced_by_run_id !== null)
    return { as: 'replaced', at, byRunId: row.replaced_by_run_id };
  return { as: 'withdrawn', at };
}

/** A subject this binary does not know (a later one wrote it) reads as none. */
function subjectOf(row: WaitRow): StoredItemWait['subject'] {
  const { subject_kind: kind, subject_number: number } = row;
  if ((kind !== 'pr' && kind !== 'issue') || number === null) return null;
  return { kind, number: Number(number) };
}

function readWait(row: WaitRow): StoredItemWait {
  return {
    id: row.id,
    itemId: String(row.item_id),
    runId: row.run_id,
    workflowName: row.workflow_name,
    position: Number(row.position),
    event: row.event,
    about: row.about,
    subject: subjectOf(row),
    openedAt: isoTime(row.created_at),
    deadlineAt: isoTime(row.deadline_at),
    closed: closure(row),
  };
}

/**
 * Open the waits a completed run left, inside the transaction that completes it, after
 * closing as `replaced` the waits still open from the same workflow on the same item. Called
 * only when that transaction won the run's change to `completed`, as asks are opened.
 */
export async function openItemWaitsForCompletedRun(
  query: TransactionQuery,
  runId: string,
  waits: readonly ItemWait[]
): Promise<void> {
  const found = await query<{ item_id: string | null; workflow_name: string }>(
    'SELECT item_id, workflow_name FROM remote_agent_workflow_runs WHERE id = $1',
    [runId]
  );
  const run = found.rows[0];
  if (run === undefined) throw new Error(`Run '${runId}' was not found while opening its waits`);
  if (run.item_id === null) {
    if (waits.length > 0)
      throw new Error(`Run '${runId}' left waits but has no item; a wait belongs to an item`);
    return;
  }
  // Completions of one workflow on one item serialize here, as asks' do, so an item has at
  // most one open set per workflow.
  if (getDatabaseType() === 'postgresql')
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      JSON.stringify(['item-waits', run.item_id, run.workflow_name]),
    ]);
  const opened = new Date();
  const now = opened.toISOString();
  await query(
    `UPDATE remote_agent_item_waits
     SET closed_as = 'replaced', closed_at = $1, replaced_by_run_id = $2
     WHERE item_id = $3 AND workflow_name = $4 AND closed_as IS NULL`,
    [now, runId, run.item_id, run.workflow_name]
  );
  for (const [position, wait] of waits.entries())
    await query(
      `INSERT INTO remote_agent_item_waits
       (item_id, run_id, workflow_name, position, event, about, subject_kind, subject_number,
        created_at, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        run.item_id,
        runId,
        run.workflow_name,
        position,
        wait.event,
        wait.about,
        wait.subject?.kind ?? null,
        wait.subject?.number ?? null,
        now,
        new Date(opened.getTime() + wait.within_minutes * 60_000).toISOString(),
      ]
    );
}

export async function listOpenItemWaits(itemId?: string): Promise<StoredItemWait[]> {
  const result = await pool.query<WaitRow>(
    `SELECT * FROM remote_agent_item_waits WHERE closed_as IS NULL${itemId === undefined ? '' : ' AND item_id = $1'}
     ORDER BY created_at, run_id, position`,
    itemId === undefined ? [] : [itemId]
  );
  return result.rows.map(readWait);
}

export async function withdrawItemWaits(runId: string): Promise<ItemWaitsWithdrawResult> {
  const lock = getDatabaseType() === 'postgresql' ? ' FOR UPDATE' : '';
  return getDatabase().withTransaction(async query => {
    const set = await query<WaitRow>(
      `SELECT * FROM remote_agent_item_waits WHERE run_id = $1 ORDER BY position${lock}`,
      [runId]
    );
    const [first, ...rest] = set.rows.map(readWait);
    if (first === undefined) return { kind: 'not_found' };
    if (first.closed !== null && rest.every(wait => wait.closed !== null))
      return { kind: 'refused', closedAs: first.closed.as, waits: [first, ...rest] };
    await query(
      `UPDATE remote_agent_item_waits SET closed_as = 'withdrawn', closed_at = $2
       WHERE run_id = $1 AND closed_as IS NULL`,
      [runId, new Date().toISOString()]
    );
    const after = await query<WaitRow>(
      'SELECT * FROM remote_agent_item_waits WHERE run_id = $1 ORDER BY position',
      [runId]
    );
    const [closed, ...others] = after.rows.map(readWait);
    if (closed === undefined) throw new Error(`Waits of run '${runId}' do not read back`);
    return { kind: 'withdrawn', waits: [closed, ...others] };
  });
}

type Evaluated = NonNullable<SourceReceiptAcceptance['evaluatedBindings']>[number];

/**
 * What a wake binding with `inputs` or `checkout` maps from the run that left the met wait
 * (`runId`; `run` is null when it was deleted) and the asks on the wait's item: the event
 * inputs and the checkout hand-off, or why the start is refused. Synchronous, as it runs
 * while the wait is locked. Supplied by core's workflows, which own the mapping, so this
 * module reads rows and maps nothing itself (as `StartsOnSettle` is for asks).
 */
export type WakeStart = (
  wake: BindingWake,
  waiting: {
    runId: string;
    run: { metadata: Record<string, unknown> } | null;
    itemAsks: readonly AttentionRead<StoredItemAsk>[];
  }
) =>
  | { inputs: Record<string, JsonValue>; handoff?: CheckoutHandoff }
  | { refused: { detail: string; reason: 'inputs_unmapped' | 'checkout_refused' } };

/**
 * What a wake binding needs from core's workflows, injected as `WakeStart` alone would be:
 * `start` maps it from the waiting run inside the transaction, and `inputProblems` checks,
 * before the transaction, each `{ input }` it carries against the inputs its `wake.workflow`
 * declared in the definitions `waiting` (a run that left a matching open wait) ran with, so
 * a binding the source plugin accepted with a stale or mistyped name is refused without
 * meeting the wait.
 */
export interface WakeMapping {
  start: WakeStart;
  inputProblems: (
    binding: ResourceStartBindingIntent & { wake: BindingWake },
    waiting: { runId: string; metadata: Record<string, unknown> }
  ) => Promise<string[]>;
}

/** What is read per wake binding before the receipt's transaction. */
export interface PreparedWake {
  /** The project its launch is in, or null when none is registered there. */
  projectKey: string | null;
  /**
   * Per run that left a matching open wait, each carried `{ input }` that run's workflow
   * does not declare. A run absent here, or one with no problems, is not refused for them.
   */
  inputProblems: ReadonlyMap<string, readonly string[]>;
}

/**
 * The runs that left an open wait `wake` could meet, with their metadata, read before the
 * receipt's transaction for the input check. Wider than `resolveWake`'s match (any project
 * or item): it only decides which runs to check, and the match is still made in the
 * transaction.
 */
export async function openWaitingRuns(
  wake: Pick<BindingWake, 'workflowName' | 'wait' | 'about'>
): Promise<{ runId: string; metadata: Record<string, unknown> }[]> {
  const found = await pool.query<{ run_id: string }>(
    `SELECT DISTINCT run_id FROM remote_agent_item_waits
     WHERE workflow_name = $1 AND event = $2 AND about = $3 AND closed_as IS NULL`,
    [wake.workflowName, wake.wait, wake.about]
  );
  const runs: { runId: string; metadata: Record<string, unknown> }[] = [];
  for (const { run_id: runId } of found.rows) {
    const run = await readRunMetadataIn(pool.query.bind(pool), runId);
    if (run !== null) runs.push({ runId, ...run });
  }
  return runs;
}

/**
 * What else a wake's wait must match besides `about`, as SQL clauses whose parameters number
 * from `$5`, and the words that name it. Its subject is the event's: a wait that names one is
 * met only by an event about it, and an event that names none (a check) meets only a wait that
 * names none. Only through the binding's mapped item may a subject-naming event meet a wait
 * that names none, as before subjects. The wait is on the mapped item, and on the item an
 * observation was for; when the two differ, nothing matches.
 */
function waitScope(
  wake: NonNullable<ResourceStartBindingIntent['wake']>,
  itemKey: string | undefined
): { sql: string; params: (string | number)[]; named: string } {
  const { subject, observedItemKey } = wake;
  const params: (string | number)[] = [];
  const param = (value: string | number): string => `$${String(params.push(value) + 4)}`;
  const clauses: string[] = [];
  if (subject === undefined) clauses.push('w.subject_kind IS NULL');
  else {
    const same = `w.subject_kind = ${param(subject.kind)} AND w.subject_number = ${param(subject.number)}`;
    clauses.push(itemKey === undefined ? same : `(w.subject_kind IS NULL OR (${same}))`);
  }
  const items = [itemKey, observedItemKey].filter(key => key !== undefined);
  for (const key of items) clauses.push(`i.key = ${param(key)}`);
  const forSubject = subject === undefined ? '' : ` for ${subject.kind} ${String(subject.number)}`;
  return {
    sql: clauses.map(clause => ` AND ${clause}`).join(''),
    params,
    named: `wait '${wake.wait}' about '${wake.about}' from '${wake.workflowName}'${items.map(key => ` on item '${key}'`).join('')}${forSubject}`,
  };
}

/**
 * The binding a wake makes once resolved against the open waits, or why it starts nothing.
 * A match is an open wait of the binding's workflow and name whose `about` is exactly the
 * event's, on an item of the binding's project, within `waitScope`. A wait about any other
 * value (the commit the change has moved past), or on another subject at the same commit, is
 * not one. The match closes its whole set as met, guarded on the set still being open, so of
 * two deliveries for one wait only the first starts. A wake with `inputs` or `checkout` is
 * mapped from the run that left the matched wait first (`wakeStart`), unless the check made
 * before the transaction found carried inputs that run's workflow does not declare; a refusal
 * leaves the set open and is recorded on that run.
 */
async function resolveWake(
  query: TransactionQuery,
  receiptId: string,
  binding: ResourceStartBindingIntent & { wake: NonNullable<ResourceStartBindingIntent['wake']> },
  { projectKey, inputProblems }: PreparedWake,
  wakeStart: WakeStart | undefined
): Promise<{ binding: ResourceStartBindingIntent } | { evaluated: Evaluated }> {
  const { wake, ...rest } = binding;
  const notStarted = (
    status: Evaluated['status'],
    reason: string,
    refused?: NonNullable<Evaluated['refused']>
  ) => ({
    evaluated: {
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      status,
      reason,
      ...(refused === undefined ? {} : { refused }),
    },
  });
  const scope = waitScope(wake, binding.itemKey);
  const { named } = scope;
  if (projectKey === null)
    return notStarted(
      'rejected',
      `launch.cwd '${binding.launch.cwd}' is in no registered project, so no ${named} can be on its items`
    );
  const lock = getDatabaseType() === 'postgresql' ? ' FOR UPDATE OF w' : '';
  const found = await query<WaitRow & { item_key: string }>(
    `SELECT w.*, i.key AS item_key FROM remote_agent_item_waits w
     JOIN remote_agent_items i ON i.id = w.item_id
     WHERE i.project_key = $1 AND w.workflow_name = $2 AND w.event = $3 AND w.about = $4
       AND w.closed_as IS NULL${scope.sql}
     ORDER BY w.created_at, w.run_id${lock}`,
    [projectKey, wake.workflowName, wake.wait, wake.about, ...scope.params]
  );
  const items = [...new Set(found.rows.map(row => row.item_key))];
  const row = found.rows[0];
  if (row === undefined) return notStarted('unmatched', `no open ${named}`);
  if (items.length > 1)
    return notStarted(
      'rejected',
      `an open ${named} is on more than one item (${items.join(', ')}), so which one it is for cannot be known; nothing was started`
    );
  // Read from the run that left this wait, never the latest run on the item, and before the
  // set closes, so a start that cannot be mapped leaves the wait open for a later event.
  let carried: { inputs: Record<string, JsonValue>; handoff?: CheckoutHandoff } = { inputs: {} };
  if (wake.inputs !== undefined || wake.checkout !== undefined) {
    if (wakeStart === undefined)
      throw new Error(
        `Binding '${binding.bindingId}' wakes with inputs or a checkout, which this store cannot map`
      );
    const undeclared = inputProblems.get(row.run_id) ?? [];
    const mapped =
      undeclared.length > 0
        ? {
            refused: {
              detail: `binding '${binding.bindingId}': ${undeclared.join('; ')}`,
              reason: 'inputs_unmapped' as const,
            },
          }
        : wakeStart(wake, {
            runId: row.run_id,
            run: await readRunMetadataIn(query, row.run_id),
            itemAsks: await readItemAsksIn(query, row.item_id),
          });
    if ('refused' in mapped) {
      const refused = { workflow: binding.launch.workflowName, reason: mapped.refused.reason };
      // On the waiting run, so attention lists the refusal beside the open wait.
      await recordRunRefusedStart(query, row.run_id, {
        refused: {
          receiptId,
          bindingId: binding.bindingId,
          ...refused,
          refusedAt: new Date().toISOString(),
        },
      });
      return notStarted(
        'rejected',
        `${named} on item '${row.item_key}': ${mapped.refused.detail}; '${binding.launch.workflowName}' was not started and the wait stays open`,
        refused
      );
    }
    carried = mapped;
  }
  const met = await query(
    `UPDATE remote_agent_item_waits
     SET closed_as = 'met', closed_at = $2, met_by_receipt_id = $3, met_by_binding_id = $4
     WHERE run_id = $1 AND closed_as IS NULL`,
    [row.run_id, new Date().toISOString(), receiptId, binding.bindingId]
  );
  // Another binding of this receipt met the set first.
  if ((met.rowCount ?? 0) === 0) return notStarted('unmatched', `no open ${named}`);
  const input: MetWaitInput = {
    event: row.event,
    about: row.about,
    subject: subjectOf(row),
    workflow: row.workflow_name,
    runId: row.run_id,
    waitingSince: isoTime(row.created_at),
    deadline: isoTime(row.deadline_at),
  };
  const eventInputs = {
    ...rest.eventInputs,
    ...carried.inputs,
    ...(wake.input === undefined ? {} : { [wake.input]: { ...input } }),
  };
  return {
    binding: {
      ...withCheckoutFrom(rest, carried.handoff),
      itemKey: row.item_key,
      ...(Object.keys(eventInputs).length > 0 ? { eventInputs } : {}),
    },
  };
}

/**
 * `acceptance` with every binding that wakes resolved against the open waits, inside the
 * transaction that writes the receipt: a met wait's binding starts on its item, and any other
 * is recorded as not started. `prepared` holds, per binding id, what was read before the
 * transaction. The caller resolves only a first delivery.
 */
export async function resolveWakes(
  query: TransactionQuery,
  acceptance: SourceReceiptAcceptance,
  prepared: ReadonlyMap<string, PreparedWake>,
  wakeStart?: WakeStart
): Promise<SourceReceiptAcceptance> {
  if (!acceptance.bindings.some(binding => binding.wake !== undefined)) return acceptance;
  const bindings: ResourceStartBindingIntent[] = [];
  const evaluated: Evaluated[] = [...(acceptance.evaluatedBindings ?? [])];
  const reasons: string[] = [];
  for (const binding of acceptance.bindings) {
    const { wake } = binding;
    if (wake === undefined) {
      bindings.push(binding);
      continue;
    }
    const resolved = await resolveWake(
      query,
      acceptance.receipt.id,
      { ...binding, wake },
      prepared.get(binding.bindingId) ?? { projectKey: null, inputProblems: new Map() },
      wakeStart
    );
    if ('binding' in resolved) bindings.push(resolved.binding);
    else {
      evaluated.push(resolved.evaluated);
      reasons.push(resolved.evaluated.reason);
    }
  }
  const [first, ...more] = bindings;
  return sourceReceiptAcceptanceSchema.parse({
    receipt: acceptance.receipt,
    evaluatedBindings: evaluated,
    ...(first === undefined
      ? // On the receipt as well as its bindings, so `trigger list` shows why nothing started.
        { outcome: 'unmatched', reason: reasons.join('; '), bindings: [] }
      : {
          outcome: 'matched',
          ...(acceptance.reason === undefined ? {} : { reason: acceptance.reason }),
          bindings: [first, ...more],
        }),
  });
}
