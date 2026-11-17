import { WORKFLOW_NOTICE_LIMITS } from '@archon/workflows/workflow-notice';
import { insertWorkflowEvent } from './workflow-events';
import { z } from 'zod';
import {
  DIRECT_START_HOST_ID,
  drainableStarts,
  preparedBindingStart,
  skippedFireNotice,
  resourceStartBlocker,
  validateStartReceiptLimit,
} from '@archon/workflows/resource-start-store';
import type {
  PreparedBindingInput,
  StartBindingInspection,
  StartReceiptInspection,
  ResourceBlocker,
  ResourceStartRequestInspection,
  QueuedResourceStartInspection,
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
  SourceReceiptAcceptance,
} from '@archon/workflows/schemas/resource-start';
import {
  sourceReceiptInputSchema,
  preparedWorkflowLaunchSchema,
  resourceStartBindingIntentSchema,
  checkoutHandoffSchema,
} from '@archon/workflows/schemas/resource-start';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import { getDatabase, getDatabaseType, getDialect } from './connection';
import {
  addResourceSlotHolder,
  lockResourceSlot,
  lockResourceSlotForAdmission,
  resourceStartOccupancy,
  parseQueuedResourceStart,
  type TransactionQuery as Query,
} from './resource-slots';
import { loadResourceCapacities } from '../config/concurrency-config';
import { insertWorkflowRun } from './workflows';
import { ensureItem } from './items';
import { WorkflowStatusReadError } from './workflow-run-reads';
import { insertStartReceipt } from './start-receipt-writes';
import { toHydratedTimestamp } from './timestamps';

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

// Different resource rows can reserve the same checkout. Hold one transaction lock
// across occupancy and publication; SQLite already serializes writers.
async function lockCheckoutReservations(query: Query): Promise<void> {
  if (getDatabaseType() === 'postgresql') await query('SELECT pg_advisory_xact_lock(1797)');
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
  itemId: string | null = null
): Promise<ResourceStartDisposition> {
  await lockCheckoutReservations(query);
  const { capacity } = await lockResourceSlotForAdmission(query, intent.resource, intent.capacity);
  const existing = await query<RequestRow>(
    'SELECT * FROM remote_agent_resource_start_requests WHERE id = $1',
    [intent.launch.run.id]
  );
  if (existing.rows[0]) return disposition(existing.rows[0]);

  const launch = preparedWorkflowLaunchSchema.parse(intent.launch);
  const blocker = resourceStartBlocker(
    await resourceStartOccupancy(query, intent.resource, capacity),
    launch,
    intent.hostId
  );
  const status = blocker && intent.overlap === 'skip' ? 'skipped' : 'queued';
  await query(
    `INSERT INTO remote_agent_resource_start_requests
       (id, resource_key, host_id, overlap_policy, status, blocker_run_id, blocker_kind, launch, receipt_id, binding_id, item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
    await lockCheckoutReservations(query);
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
    const run = await query<{ status: string }>(
      'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    const status = run.rows[0]?.status;
    if (status !== 'pending') throw new Error(`Run '${id}' is ${status ?? 'missing'}, not pending`);
    const blocker = resourceStartBlocker(
      await resourceStartOccupancy(query, input.resource, capacity),
      launch,
      DIRECT_START_HOST_ID
    );
    if (blocker) return blocker;
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

/** Admit this host's queued requests that can run while the slot has free capacity. */
export async function drainResourceStarts(options: {
  resource: string;
  hostId: string;
}): Promise<ResourceStartDisposition[]> {
  return getDatabase().withTransaction(async query => {
    await lockCheckoutReservations(query);
    const { capacity } = await lockResourceSlotForAdmission(query, options.resource);
    const slot = await resourceStartOccupancy(query, options.resource, capacity);
    const admitted: ResourceStartDisposition[] = [];
    for (const start of drainableStarts(slot, options.hostId))
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

export async function acceptStartReceipt(
  input: SourceReceiptAcceptance
): Promise<{ receiptId: string; replay: boolean }> {
  return getDatabase().withTransaction(query => insertStartReceipt(query, input));
}

function parseStoredJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** Reverses `storableIntent` in `./start-receipt-writes`. */
function readStoredIntent(
  intent: unknown,
  eventInputNames: unknown,
  checkoutFrom: unknown
): ResourceStartBindingIntent {
  const stored = withEventInputs(
    resourceStartBindingIntentSchema.parse(parseStoredJson(intent)),
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
    intent:
      row.intent == null
        ? null
        : readStoredIntent(row.intent, row.event_input_names, row.checkout_from),
    requestStatus,
    disposition: requestDisposition,
  };
}

export async function getStartReceipt(id: string): Promise<StartReceiptInspection | null> {
  const receipt = await getDatabase().query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_start_receipts WHERE id = $1',
    [id]
  );
  if (!receipt.rows[0]) return null;
  const bindings = await getDatabase().query<Record<string, unknown>>(
    `SELECT b.*, r.id AS request_id, r.status AS request_status,
            r.blocker_run_id AS request_blocker_id, r.blocker_kind AS request_blocker_kind
       FROM remote_agent_start_receipt_bindings b
       LEFT JOIN remote_agent_resource_start_requests r
         ON r.receipt_id = b.receipt_id AND r.binding_id = b.binding_id
      WHERE b.receipt_id = $1 ORDER BY b.binding_id`,
    [id]
  );
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
function storedWorkflowName(launch: unknown): string | null {
  try {
    const parsed = storedWorkflowNameSchema.safeParse(parseStoredJson(launch));
    return parsed.success ? parsed.data.run.workflow_name : null;
  } catch {
    // Malformed JSON: the item read reports the start without its workflow.
    return null;
  }
}

export async function listQueuedItemStarts(itemId: string): Promise<QueuedItemStart[]> {
  const result = await getDatabase().query<{
    id: string;
    resource_key: string;
    host_id: string;
    launch: unknown;
    created_at: string | Date;
    ahead: number | string;
  }>(
    `SELECT r.id, r.resource_key, r.host_id, r.launch, r.created_at,
       (SELECT COUNT(*) FROM remote_agent_resource_start_requests q
         WHERE q.resource_key = r.resource_key AND q.host_id = r.host_id
           AND q.status = 'queued' AND q.queue_position < r.queue_position) AS ahead
       FROM remote_agent_resource_start_requests r
      WHERE r.item_id = $1 AND r.status = 'queued'
      ORDER BY r.queue_position`,
    [itemId]
  );
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
): Promise<ResourceStartDisposition | null> {
  return getDatabase().withTransaction(async query => {
    // See withdrawQueuedResourceStart: acquire SQLite's writer lock before the read.
    if (getDatabase().dialect === 'sqlite') {
      await query(
        'UPDATE remote_agent_start_receipt_bindings SET binding_id = binding_id WHERE receipt_id = $1 AND binding_id = $2',
        [input.receiptId, input.bindingId]
      );
    }
    const binding = await query<{ intent: unknown }>(
      `SELECT intent FROM remote_agent_start_receipt_bindings
        WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status = 'preparing' AND preparation_owner = $3${getDialect().rowLock()}`,
      [input.receiptId, input.bindingId, input.ownerId]
    );
    const rawIntent = binding.rows[0]?.intent;
    if (!rawIntent) return null;
    const persisted = resourceStartBindingIntentSchema.parse(parseStoredJson(rawIntent));
    const disposition = await admitResourceStartWithQuery(
      query,
      preparedBindingStart(persisted, input),
      await namedItem(query, input)
    );
    await query(
      `UPDATE remote_agent_start_receipt_bindings SET preparation_status = 'complete', preparation_error = NULL, updated_at = ${getDialect().now()}
        WHERE receipt_id = $1 AND binding_id = $2 AND preparation_owner = $3`,
      [input.receiptId, input.bindingId, input.ownerId]
    );
    return disposition;
  });
}

/**
 * The item the receipt named, in the project preparation resolved. It is written with the
 * start request, so a start that waits for capacity already has its item.
 */
async function namedItem(query: Query, input: PreparedBindingInput): Promise<string | null> {
  const receipt = await query<{ item_key: string | null }>(
    'SELECT item_key FROM remote_agent_start_receipts WHERE id = $1',
    [input.receiptId]
  );
  const key = receipt.rows[0]?.item_key;
  if (!key) return null;
  return ensureItem(query, input.launch.run.codebase_id, key);
}

export async function failStartBindingPreparation(input: {
  receiptId: string;
  bindingId: string;
  ownerId: string;
  retryable: boolean;
  error: string;
}): Promise<boolean> {
  const result = await getDatabase().query(
    `UPDATE remote_agent_start_receipt_bindings SET preparation_status = $4, preparation_error = $5, updated_at = ${getDialect().now()}
      WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status = 'preparing' AND preparation_owner = $3`,
    [
      input.receiptId,
      input.bindingId,
      input.ownerId,
      input.retryable ? 'failed' : 'rejected',
      input.error,
    ]
  );
  return result.rowCount === 1;
}

export async function resetStartBindingPreparation(input: {
  receiptId: string;
  bindingId: string;
  ownerId: string;
}): Promise<boolean> {
  const result = await getDatabase().query(
    `UPDATE remote_agent_start_receipt_bindings SET preparation_status = 'pending', preparation_owner = NULL, updated_at = ${getDialect().now()}
      WHERE receipt_id = $1 AND binding_id = $2 AND preparation_status = 'preparing' AND preparation_owner = $3`,
    [input.receiptId, input.bindingId, input.ownerId]
  );
  return result.rowCount === 1;
}
