import { WORKFLOW_NOTICE_LIMITS } from '@archon/workflows/workflow-notice';
import { insertWorkflowEvent } from './workflow-events';
import { z } from 'zod';
import {
  DIRECT_START_HOST_ID,
  preparedBindingStart,
  skippedFireNotice,
  resourceStartBlocker,
  validateStartReceiptLimit,
} from '@archon/workflows/resource-start-store';
import type {
  HeldPreparation,
  PreparedBindingInput,
  RefusedPreparation,
  StartBindingInspection,
  StartReceiptInspection,
  ResourceBlocker,
  ResourceStartRequestInspection,
  QueuedResourceStartInspection,
  SkippedItemStart,
} from '@archon/workflows/resource-start-store';
export { SourceReceiptDigestConflictError } from '@archon/workflows/resource-start-store';
export type {
  StartBindingInspection,
  StartReceiptInspection,
  ResourceStartRequestInspection,
} from '@archon/workflows/resource-start-store';
import type {
  PreparedWorkflowLaunch,
  QueuedItemStart,
  ResourceStartBindingIntent,
  ResourceStartDisposition,
  ResourceStartIntent,
} from '@archon/workflows/schemas/resource-start';
import {
  sourceReceiptInputSchema,
  preparedWorkflowLaunchSchema,
  resourceStartBindingIntentSchema,
  checkoutHandoffSchema,
  forgeRefusalSchema,
  type ForgeRefusal,
} from '@archon/workflows/schemas/resource-start';
import { countStartLimits, storedLimitFields, type StartLimitColumns } from './start-limits';
export { readItemStartLimits } from './start-limits';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import { getDatabase, getDialect } from './connection';
import {
  addResourceSlotHolder,
  lockAdmission,
  lockResourceSlot,
  lockResourceSlotForAdmission,
  readInstallHold,
  runLimitRefusal,
  resourceStartOccupancy,
  parseQueuedResourceStart,
  type TransactionQuery as Query,
} from './resource-slots';
import { drainAdmits, runLimitBlocker } from './run-room';
import { loadResourceCapacities } from '../config/concurrency-config';
import { insertWorkflowRun } from './workflows';
import { ensureItem } from './items';
import { WorkflowStatusReadError } from './workflow-run-reads';
import { toHydratedTimestamp } from './timestamps';
import { InstallHeldError } from '@archon/workflows/store';

interface RequestRow {
  id: string;
  resource_key: string;
  host_id: string;
  overlap_policy: ResourceStartRequestInspection['overlap'];
  status: ResourceStartRequestInspection['status'];
  blocker_run_id: string | null;
  blocker_kind: NonNullable<ResourceStartRequestInspection['blocker']>['kind'] | null;
  launch: unknown;
}

/** Start requests are the run holder's durable FIFO waiters for a resource slot. */
async function admitExisting(
  query: Query,
  resource: string,
  start: { id: string; launch: PreparedWorkflowLaunch }
): Promise<ResourceStartDisposition> {
  // Preparation resolved the start's item onto its request; the run takes it from there.
  const request = await query<{ item_id: string | null }>(
    'SELECT item_id FROM remote_agent_resource_start_requests WHERE id = $1',
    [start.id]
  );
  await insertWorkflowRun(query, start.launch.run, {
    itemId: request.rows[0]?.item_id ?? null,
  });
  await query(
    `UPDATE remote_agent_resource_start_requests
        SET status = 'admitted', admitted_at = ${getDialect().now()}, blocker_run_id = NULL
      WHERE id = $1 AND status = 'queued'`,
    [start.id]
  );
  await addResourceSlotHolder(query, resource, { kind: 'run', id: start.id });
  return { status: 'admitted', requestId: start.id, runId: start.id };
}

function disposition(row: RequestRow): ResourceStartDisposition {
  if (row.status === 'admitted') return { status: 'admitted', requestId: row.id, runId: row.id };
  if (row.status === 'skipped' && row.blocker_run_id) {
    return {
      status: 'skipped',
      requestId: row.id,
      blocker: { kind: row.blocker_kind ?? 'run', id: row.blocker_run_id },
    };
  }
  if (row.status === 'queued' && row.blocker_run_id && row.blocker_kind) {
    return {
      status: 'queued',
      requestId: row.id,
      blocker: { kind: row.blocker_kind, id: row.blocker_run_id },
    };
  }
  throw new Error(`Resource start request '${row.id}' has no executable disposition`);
}

async function admitResourceStartWithQuery(
  query: Query,
  intent: ResourceStartIntent,
  itemId: string | null = null,
  limits: StartLimitColumns = { startLimit: null, grantsLimit: null }
): Promise<ResourceStartDisposition> {
  await lockAdmission(query);
  const { capacity } = await lockResourceSlotForAdmission(query, intent.resource, intent.capacity);
  const existing = await query<RequestRow>(
    'SELECT * FROM remote_agent_resource_start_requests WHERE id = $1',
    [intent.launch.run.id]
  );
  if (existing.rows[0]) return disposition(existing.rows[0]);

  const launch = preparedWorkflowLaunchSchema.parse(intent.launch);
  const slot = await resourceStartOccupancy(query, intent.resource, capacity);
  // The limit is asked last, when the resource admits the start; `overlap` then acts on
  // whichever blocker holds it, as it does on a resource blocker.
  const blocker =
    resourceStartBlocker(slot, launch, intent.hostId, itemId) ??
    (await runLimitBlocker(query, intent.hostId, intent.resource));
  const status = blocker && intent.overlap === 'skip' ? 'skipped' : 'queued';
  await query(
    `INSERT INTO remote_agent_resource_start_requests
       (id, resource_key, host_id, overlap_policy, status, blocker_run_id, blocker_kind, launch, receipt_id, binding_id, item_id, start_limit, grants_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      intent.launch.run.id,
      intent.resource,
      intent.hostId,
      intent.overlap,
      status,
      blocker?.id ?? null,
      blocker?.kind ?? null,
      JSON.stringify(intent.launch),
      intent.receipt?.receiptId ?? null,
      intent.receipt?.bindingId ?? null,
      itemId,
      limits.startLimit,
      limits.grantsLimit,
    ]
  );
  const row: RequestRow = {
    id: intent.launch.run.id,
    resource_key: intent.resource,
    host_id: intent.hostId,
    overlap_policy: intent.overlap,
    status,
    blocker_run_id: blocker?.id ?? null,
    blocker_kind: blocker?.kind ?? null,
    launch: intent.launch,
  };
  const result = blocker
    ? disposition(row)
    : await admitExisting(query, intent.resource, { id: row.id, launch });
  await recordSkippedFireNotice(query, intent, result);
  return result;
}

async function recordSkippedFireNotice(
  query: Query,
  intent: ResourceStartIntent,
  result: ResourceStartDisposition
): Promise<void> {
  if (result.status !== 'skipped' || !intent.receipt) return;
  const receipt = (
    await query<{ delivery_id: string | null; source_actor: unknown }>(
      'SELECT delivery_id, source_actor FROM remote_agent_start_receipts WHERE id = $1',
      [intent.receipt.receiptId]
    )
  ).rows[0];
  if (!receipt) throw new Error('Resource start receipt missing');
  const notice = skippedFireNotice(
    {
      deliveryId: receipt.delivery_id,
      sourceActor: sourceReceiptInputSchema.shape.sourceActor.parse(
        parseStoredJson(receipt.source_actor)
      ),
    },
    { ...intent, bindingId: intent.receipt.bindingId },
    result
  );
  if (notice) {
    const count = await query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'workflow_notice'",
      [notice.runId]
    );
    if (Number(count.rows[0]?.count ?? 0) >= WORKFLOW_NOTICE_LIMITS.perRun) return;
    await insertWorkflowEvent(query, {
      workflow_run_id: notice.runId,
      event_type: 'workflow_notice',
      data: notice.data,
    });
  }
}

export async function admitResourceStart(
  intent: ResourceStartIntent
): Promise<ResourceStartDisposition> {
  return getDatabase().withTransaction(query => admitResourceStartWithQuery(query, intent));
}

export async function admitPendingRun(input: {
  resource: string;
  capacity: number;
  launch: PreparedWorkflowLaunch;
}): Promise<ResourceBlocker | null> {
  const launch = preparedWorkflowLaunchSchema.parse(input.launch);
  const id = launch.run.id;
  return getDatabase().withTransaction(async query => {
    await lockAdmission(query);
    // A hand start is checked against its own number and leaves the slot's recorded one.
    await lockResourceSlot(query, input.resource);
    const capacity = (await loadResourceCapacities()).get(input.resource) ?? input.capacity;
    const existing = await query<RequestRow>(
      'SELECT * FROM remote_agent_resource_start_requests WHERE id = $1',
      [id]
    );
    const request = existing.rows[0];
    if (request?.status === 'admitted') return null;
    if (request) throw new Error(`Run '${id}' already has a ${request.status} resource request`);
    const run = await query<{ status: string; item_id: string | null }>(
      'SELECT status, item_id FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    const status = run.rows[0]?.status;
    // Checked before the hold, so a start cancelled while it waits for the lift stops waiting.
    if (status !== 'pending') throw new Error(`Run '${id}' is ${status ?? 'missing'}, not pending`);
    const hold = await readInstallHold(query);
    if (hold) throw new InstallHeldError(hold);
    const itemId = run.rows[0]?.item_id;
    const blocker = resourceStartBlocker(
      await resourceStartOccupancy(query, input.resource, capacity),
      launch,
      DIRECT_START_HOST_ID,
      itemId == null ? null : String(itemId)
    );
    if (blocker) return blocker;
    // Thrown: the caller waits for the limit, not a resource. A sub-run of a counted tree passes.
    const refusal = await runLimitRefusal(query, id);
    if (refusal) throw refusal;
    await query(
      `INSERT INTO remote_agent_resource_start_requests
         (id, resource_key, host_id, overlap_policy, status, launch, admitted_at)
         VALUES ($1, $2, $3, 'queue', 'admitted', $4, ${getDialect().now()})`,
      [id, input.resource, DIRECT_START_HOST_ID, JSON.stringify(launch)]
    );
    await addResourceSlotHolder(query, input.resource, { kind: 'run', id });
    return null;
  });
}

/** Admit this host's queued requests that fit the slot and the run limit; none under the hold. */
export async function drainResourceStarts(options: {
  resource: string;
  hostId: string;
}): Promise<ResourceStartDisposition[]> {
  return getDatabase().withTransaction(async query => {
    await lockAdmission(query);
    const { capacity } = await lockResourceSlotForAdmission(query, options.resource);
    if (await readInstallHold(query)) return [];
    const slot = await resourceStartOccupancy(query, options.resource, capacity);
    const admitted: ResourceStartDisposition[] = [];
    for (const start of await drainAdmits(query, options.hostId, options.resource, slot))
      admitted.push(await admitExisting(query, options.resource, start));
    return admitted;
  });
}

export async function hasStartReceiptForDelivery(
  sourceInstanceId: string,
  deliveryId: string
): Promise<boolean> {
  const found = await getDatabase().query(
    'SELECT 1 FROM remote_agent_start_receipts WHERE source_instance_id = $1 AND delivery_id = $2',
    [sourceInstanceId, deliveryId]
  );
  return found.rows.length > 0;
}

export function parseStoredJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** Reverses `storableIntent` in `./start-receipt-writes`. */
function readStoredIntent(
  intent: unknown,
  eventInputNames: unknown,
  checkoutFrom: unknown,
  itemKey: unknown,
  startLimit: unknown,
  grantsLimit: unknown
): ResourceStartBindingIntent {
  const parsed = {
    ...resourceStartBindingIntentSchema.parse(parseStoredJson(intent)),
    ...storedLimitFields(startLimit, grantsLimit),
  };
  const stored = withEventInputs(
    typeof itemKey === 'string' ? { ...parsed, itemKey } : parsed,
    eventInputNames
  );
  // A malformed hand-off throws like a malformed intent: read as absent, the start would
  // run on the branch with no commit pin.
  return checkoutFrom == null
    ? stored
    : { ...stored, checkoutFrom: checkoutHandoffSchema.parse(parseStoredJson(checkoutFrom)) };
}

function withEventInputs(
  stored: ResourceStartBindingIntent,
  eventInputNames: unknown
): ResourceStartBindingIntent {
  if (eventInputNames == null) return stored;
  const names = new Set(z.array(z.string()).parse(parseStoredJson(eventInputNames)));
  for (const name of names)
    if (!Object.hasOwn(stored.launch.inputs, name))
      throw new Error(`Stored binding intent lacks its event input '${name}'`);
  const entries = Object.entries(stored.launch.inputs);
  return {
    ...stored,
    launch: {
      ...stored.launch,
      inputs: Object.fromEntries(entries.filter(([name]) => !names.has(name))),
    },
    eventInputs: Object.fromEntries(entries.filter(([name]) => names.has(name))),
  };
}

function readForgeRefusal(stored: unknown): ForgeRefusal | null {
  return stored == null ? null : forgeRefusalSchema.parse(parseStoredJson(stored));
}

function inspectBinding(row: Record<string, unknown>): StartBindingInspection {
  const requestStatus =
    row.request_status === 'queued' ||
    row.request_status === 'admitted' ||
    row.request_status === 'skipped' ||
    row.request_status === 'withdrawn'
      ? row.request_status
      : null;
  let requestDisposition: ResourceStartDisposition | null = null;
  if (
    typeof row.request_id === 'string' &&
    (requestStatus === 'queued' || requestStatus === 'admitted' || requestStatus === 'skipped')
  ) {
    requestDisposition = disposition({
      id: row.request_id,
      resource_key: '',
      host_id: '',
      overlap_policy: 'queue',
      status: requestStatus,
      blocker_run_id: typeof row.request_blocker_id === 'string' ? row.request_blocker_id : null,
      blocker_kind:
        row.request_blocker_kind === 'run' || row.request_blocker_kind === 'request'
          ? row.request_blocker_kind
          : null,
      launch: null,
    });
  }
  return {
    receiptId: String(row.receipt_id),
    bindingId: String(row.binding_id),
    bindingRevision: typeof row.binding_revision === 'string' ? row.binding_revision : null,
    hostId: typeof row.host_id === 'string' ? row.host_id : null,
    status: row.preparation_status as StartBindingInspection['status'],
    ownerId: typeof row.preparation_owner === 'string' ? row.preparation_owner : null,
    error: typeof row.preparation_error === 'string' ? row.preparation_error : null,
    forgeRefusal: readForgeRefusal(row.forge_refusal),
    intent:
      row.intent == null
        ? null
        : readStoredIntent(
            row.intent,
            row.event_input_names,
            row.checkout_from,
            row.item_key,
            row.start_limit,
            row.grants_limit
          ),
    requestStatus,
    disposition: requestDisposition,
  };
}

export const receiptBindingsSql = `SELECT b.*, r.id AS request_id, r.status AS request_status,
            r.blocker_run_id AS request_blocker_id, r.blocker_kind AS request_blocker_kind
       FROM remote_agent_start_receipt_bindings b
       LEFT JOIN remote_agent_resource_start_requests r
         ON r.receipt_id = b.receipt_id AND r.binding_id = b.binding_id
      WHERE b.receipt_id = $1 ORDER BY b.binding_id`;

export async function getStartReceipt(id: string): Promise<StartReceiptInspection | null> {
  const receipt = await getDatabase().query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_start_receipts WHERE id = $1',
    [id]
  );
  if (!receipt.rows[0]) return null;
  const bindings = await getDatabase().query<Record<string, unknown>>(receiptBindingsSql, [id]);
  const row = receipt.rows[0];
  return {
    id: String(row.id),
    sourceInstanceId: String(row.source_instance_id),
    deliveryId: typeof row.delivery_id === 'string' ? row.delivery_id : null,
    contentDigest: String(row.content_digest),
    receivedAt:
      row.received_at instanceof Date ? row.received_at.toISOString() : String(row.received_at),
    occurredAt:
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : typeof row.occurred_at === 'string'
          ? row.occurred_at
          : null,
    sourceActor: sourceReceiptInputSchema.shape.sourceActor.parse(
      parseStoredJson(row.source_actor)
    ),
    itemKey: typeof row.item_key === 'string' ? row.item_key : null,
    outcome: row.outcome as StartReceiptInspection['outcome'],
    reason: typeof row.reason === 'string' ? row.reason : null,
    bindings: bindings.rows.map(inspectBinding),
  };
}

export async function listStartReceipts(
  limit?: number
): Promise<
  Pick<
    StartReceiptInspection,
    'id' | 'sourceInstanceId' | 'deliveryId' | 'itemKey' | 'outcome' | 'reason' | 'receivedAt'
  >[]
> {
  const receiptLimit = validateStartReceiptLimit(limit);
  // SQLite's date functions round fractions to milliseconds. Keep the schema's UTC precision.
  const receivedAtOrder =
    getDatabase().dialect === 'sqlite'
      ? `CASE WHEN length(received_at) = 17 THEN substr(received_at, 1, 16) || ':00'
              ELSE substr(received_at, 1, 19) END || '.' ||
         CASE WHEN instr(received_at, '.') = 0 THEN ''
              ELSE rtrim(substr(received_at, 21, length(received_at) - 21), '0') END`
      : 'received_at';
  const result = await getDatabase().query<{
    id: string;
    source_instance_id: string;
    delivery_id: string | null;
    item_key: string | null;
    outcome: StartReceiptInspection['outcome'];
    reason: string | null;
    received_at: string | Date;
  }>(
    `SELECT id, source_instance_id, delivery_id, item_key, outcome, reason, received_at FROM remote_agent_start_receipts ORDER BY ${receivedAtOrder} DESC, id DESC LIMIT $1`,
    [receiptLimit]
  );
  return result.rows.map(row => ({
    id: row.id,
    sourceInstanceId: row.source_instance_id,
    deliveryId: row.delivery_id,
    itemKey: row.item_key,
    outcome: row.outcome,
    reason: row.reason,
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
  }));
}

export async function listPendingStartBindings(options: {
  hostId: string;
  limit?: number;
  receiptIds?: readonly string[];
}): Promise<StartBindingInspection[]> {
  const receiptIds = options.receiptIds;
  if (receiptIds?.length === 0) return [];
  const receiptFilter = receiptIds
    ? ` AND receipt_id IN (${receiptIds.map((_, index) => `$${String(index + 3)}`).join(', ')})`
    : '';
  const result = await getDatabase().query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_start_receipt_bindings WHERE host_id = $1 AND preparation_status IN ('pending','failed')${receiptFilter} ORDER BY created_at, binding_id LIMIT $2`,
    [options.hostId, options.limit ?? 100, ...(receiptIds ?? [])]
  );
  return result.rows.map(inspectBinding);
}

function inspectJoinedRunStatus(runId: string, storedStatus: string | null) {
  if (storedStatus === null) return null;
  const status = workflowRunStatusSchema.safeParse(storedStatus);
  if (!status.success) {
    throw new WorkflowStatusReadError(runId, storedStatus);
  }
  return status.data;
}

interface RequestInspectionRow extends Record<string, unknown> {
  run_status: string | null;
  blocker_run_status: string | null;
}

function inspectRequest(row: RequestInspectionRow): ResourceStartRequestInspection {
  return {
    id: String(row.id),
    resource: String(row.resource_key),
    hostId: String(row.host_id),
    overlap: row.overlap_policy as ResourceStartRequestInspection['overlap'],
    status: row.status as ResourceStartRequestInspection['status'],
    runStatus: inspectJoinedRunStatus(String(row.id), row.run_status),
    blocker:
      (row.blocker_kind === 'run' || row.blocker_kind === 'request') &&
      typeof row.blocker_run_id === 'string'
        ? { kind: row.blocker_kind, id: row.blocker_run_id }
        : null,
    blockerRunStatus: inspectJoinedRunStatus(String(row.blocker_run_id), row.blocker_run_status),
    launch: preparedWorkflowLaunchSchema.parse(parseStoredJson(row.launch)),
  };
}

const requestInspectionSelect = `SELECT r.*, own.status AS run_status, w.status AS blocker_run_status
  FROM remote_agent_resource_start_requests r
  LEFT JOIN remote_agent_workflow_runs own ON own.id = r.id
  LEFT JOIN remote_agent_workflow_runs w
    ON r.blocker_kind = 'run' AND w.id = r.blocker_run_id`;

export async function getResourceStartRequest(
  id: string
): Promise<ResourceStartRequestInspection | null> {
  const result = await getDatabase().query<RequestInspectionRow>(
    `${requestInspectionSelect} WHERE r.id = $1`,
    [id]
  );
  return result.rows[0] ? inspectRequest(result.rows[0]) : null;
}

export const skippedItemStartsSql = `SELECT id, resource_key, blocker_kind, blocker_run_id, launch
       FROM remote_agent_resource_start_requests
      WHERE item_id = $1 AND status = 'skipped'
      ORDER BY queue_position`;

export async function listSkippedItemStarts(itemId: string): Promise<SkippedItemStart[]> {
  const result = await getDatabase().query<{
    id: string;
    resource_key: string;
    blocker_kind: string | null;
    blocker_run_id: string | null;
    launch: unknown;
  }>(skippedItemStartsSql, [itemId]);
  return result.rows.map(row => ({
    requestId: row.id,
    workflow: storedWorkflowName(row.launch),
    resource: row.resource_key,
    blockerRunId: row.blocker_kind === 'run' ? row.blocker_run_id : null,
  }));
}

export async function listQueuedResourceStartsForHost(
  hostId: string
): Promise<QueuedResourceStartInspection[]> {
  const result = await getDatabase().query<RequestInspectionRow>(
    `${requestInspectionSelect}
      WHERE r.host_id = $1 AND r.status = 'queued'
      ORDER BY r.resource_key, r.queue_position`,
    [hostId]
  );
  return result.rows.map(row => {
    try {
      parseQueuedResourceStart(row);
      return inspectRequest(row);
    } catch (error) {
      return {
        id: String(row.id),
        resource: String(row.resource_key),
        receiptId: typeof row.receipt_id === 'string' ? row.receipt_id : undefined,
        error,
      };
    }
  });
}

const storedWorkflowNameSchema = z.object({ run: z.object({ workflow_name: z.string() }) });

/** The launch's workflow name, or null when the stored launch does not read. */
export function storedWorkflowName(launch: unknown): string | null {
  try {
    const parsed = storedWorkflowNameSchema.safeParse(parseStoredJson(launch));
    return parsed.success ? parsed.data.run.workflow_name : null;
  } catch {
    // Malformed JSON: the item read reports the start without its workflow.
    return null;
  }
}

export const queuedItemStartsSql = `SELECT r.id, r.resource_key, r.host_id, r.launch, r.created_at,
       (SELECT COUNT(*) FROM remote_agent_resource_start_requests q
         WHERE q.resource_key = r.resource_key AND q.host_id = r.host_id
           AND q.status = 'queued' AND q.queue_position < r.queue_position) AS ahead
       FROM remote_agent_resource_start_requests r
      WHERE r.item_id = $1 AND r.status = 'queued'
      ORDER BY r.queue_position`;

export async function listQueuedItemStarts(itemId: string): Promise<QueuedItemStart[]> {
  const result = await getDatabase().query<{
    id: string;
    resource_key: string;
    host_id: string;
    launch: unknown;
    created_at: string | Date;
    ahead: number | string;
  }>(queuedItemStartsSql, [itemId]);
  return result.rows.map(row => ({
    requestId: row.id,
    workflow: storedWorkflowName(row.launch),
    resource: row.resource_key,
    hostId: row.host_id,
    queuedAt: toHydratedTimestamp(row.created_at).toISOString(),
    // Postgres returns COUNT(*) as a string.
    ahead: Number(row.ahead),
  }));
}

export async function withdrawQueuedResourceStart(
  id: string
): Promise<PreparedWorkflowLaunch | null> {
  return getDatabase().withTransaction(async query => {
    // SQLite transactions are deferred. Write before taking the snapshot so a
    // concurrent commit cannot make the later write fail its lock upgrade.
    if (getDatabase().dialect === 'sqlite') {
      await query('UPDATE remote_agent_resource_start_requests SET id = id WHERE id = $1', [id]);
    }
    const selected = await query<{ launch: unknown }>(
      `SELECT launch FROM remote_agent_resource_start_requests WHERE id = $1 AND status = 'queued'${getDialect().rowLock()}`,
      [id]
    );
    if (!selected.rows[0]) return null;
    const updated = await query(
      "UPDATE remote_agent_resource_start_requests SET status = 'withdrawn' WHERE id = $1 AND status = 'queued'",
      [id]
    );
    return updated.rowCount === 1
      ? preparedWorkflowLaunchSchema.parse(parseStoredJson(selected.rows[0].launch))
      : null;
  });
}

export async function claimStartBindingPreparation(input: {
  receiptId: string;
  bindingId: string;
  ownerId: string;
}): Promise<boolean> {
  const result = await getDatabase().query(
    `UPDATE remote_agent_start_receipt_bindings SET preparation_status = 'preparing', preparation_owner = $3, updated_at = ${getDialect().now()}
      WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status IN ('pending','failed')`,
    [input.receiptId, input.bindingId, input.ownerId]
  );
  return result.rowCount === 1;
}

export async function completeStartBindingPreparation(
  input: PreparedBindingInput & { ownerId: string }
): Promise<ResourceStartDisposition | HeldPreparation | RefusedPreparation | null> {
  return getDatabase().withTransaction(async query => {
    // See withdrawQueuedResourceStart: acquire SQLite's writer lock before the read.
    if (getDatabase().dialect === 'sqlite') {
      await query(
        'UPDATE remote_agent_start_receipt_bindings SET binding_id = binding_id WHERE receipt_id = $1 AND binding_id = $2',
        [input.receiptId, input.bindingId]
      );
    }
    const binding = await query<{
      intent: unknown;
      item_key: string | null;
      start_limit: unknown;
      grants_limit: unknown;
    }>(
      `SELECT intent, item_key, start_limit, grants_limit FROM remote_agent_start_receipt_bindings
        WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status = 'preparing' AND preparation_owner = $3${getDialect().rowLock()}`,
      [input.receiptId, input.bindingId, input.ownerId]
    );
    const row = binding.rows[0];
    if (!row?.intent) return null;
    await lockAdmission(query);
    const hold = await readInstallHold(query);
    if (hold) {
      await resetStartBindingPreparation(input, query);
      return { status: 'held', hold };
    }
    const persisted = resourceStartBindingIntentSchema.parse(parseStoredJson(row.intent));
    const { limit, grants } = storedLimitFields(row.start_limit, row.grants_limit);
    const item = await namedItem(query, input, row.item_key);
    const counted = await countStartLimits(query, item, limit, grants, { ...input, persisted });
    if ('refused' in counted) {
      await query(
        `UPDATE remote_agent_start_receipt_bindings SET preparation_status = 'rejected', preparation_error = $4, forge_refusal = NULL, updated_at = ${getDialect().now()}
          WHERE receipt_id = $1 AND binding_id = $2 AND preparation_owner = $3`,
        [input.receiptId, input.bindingId, input.ownerId, counted.refused]
      );
      return { status: 'refused', reason: counted.refused };
    }
    const disposition = await admitResourceStartWithQuery(
      query,
      preparedBindingStart(persisted, input),
      item?.id ?? null,
      counted
    );
    await query(
      `UPDATE remote_agent_start_receipt_bindings SET preparation_status = 'complete', preparation_error = NULL, forge_refusal = NULL, updated_at = ${getDialect().now()}
        WHERE receipt_id = $1 AND binding_id = $2 AND preparation_owner = $3`,
      [input.receiptId, input.bindingId, input.ownerId]
    );
    return disposition;
  });
}

/**
 * The item the binding mapped, else the one its receipt named, in the project preparation
 * resolved. It is written with the start request, so a start that waits for capacity
 * already has its item.
 */
async function namedItem(
  query: Query,
  input: PreparedBindingInput,
  bindingItemKey: string | null
): Promise<{ id: string; key: string } | null> {
  const receipt = await query<{ item_key: string | null }>(
    'SELECT item_key FROM remote_agent_start_receipts WHERE id = $1',
    [input.receiptId]
  );
  const key = bindingItemKey ?? receipt.rows[0]?.item_key;
  if (!key) return null;
  return { id: await ensureItem(query, input.launch.run.codebase_id, key), key };
}

export async function failStartBindingPreparation(input: {
  receiptId: string;
  bindingId: string;
  ownerId: string;
  retryable: boolean;
  error: string;
  forgeRefusal?: ForgeRefusal;
}): Promise<boolean> {
  const result = await getDatabase().query(
    `UPDATE remote_agent_start_receipt_bindings SET preparation_status = $4, preparation_error = $5, forge_refusal = $6, updated_at = ${getDialect().now()}
      WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status = 'preparing' AND preparation_owner = $3`,
    [
      input.receiptId,
      input.bindingId,
      input.ownerId,
      input.retryable ? 'failed' : 'rejected',
      input.error,
      input.forgeRefusal ? JSON.stringify(input.forgeRefusal) : null,
    ]
  );
  return result.rowCount === 1;
}

export async function resetStartBindingPreparation(
  input: { receiptId: string; bindingId: string; ownerId: string },
  query: Query = (sql, params) => getDatabase().query(sql, params)
): Promise<boolean> {
  const result = await query(
    `UPDATE remote_agent_start_receipt_bindings SET preparation_status = 'pending', preparation_owner = NULL, updated_at = ${getDialect().now()}
      WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status = 'preparing' AND preparation_owner = $3`,
    [input.receiptId, input.bindingId, input.ownerId]
  );
  return result.rowCount === 1;
}
