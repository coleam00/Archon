/**
 * The install hold (`archon hold set|lift`): one row, present while no new run may be
 * admitted. Every admission point reads it under `lockAdmission` in its own transaction,
 * and setting or lifting it takes the same lock, so an admission and a hold are ordered:
 * none commits after the hold is set, and a start the hold turned back is pending again
 * before the lift commits.
 */
import { z } from 'zod';
import type { HeldStart } from '@archon/workflows/resource-start-store';
import {
  type InstallHold,
  resourceStartBindingIntentSchema,
} from '@archon/workflows/schemas/resource-start';
import type { RunLimit } from '@archon/workflows/schemas/run-limit';
import { getDatabase } from './connection';
import { INSTALL_HOLD_ID, lockAdmission, readInstallHold, readRunLimit } from './resource-slots';
import { parseStoredJson, storedWorkflowName } from './resource-starts';
import { toHydratedTimestamp } from './timestamps';

export async function getInstallHold(): Promise<InstallHold | null> {
  const db = getDatabase();
  return readInstallHold(db.query.bind(db));
}

/** The run limit and how many runs count against it now; null when no limit is set. */
export async function getRunLimit(): Promise<RunLimit | null> {
  const db = getDatabase();
  const runLimit = await readRunLimit(db.query.bind(db));
  return runLimit && { limit: runLimit.limit, live: runLimit.live };
}

export async function setInstallHold(input: {
  setBy: string;
}): Promise<{ hold: InstallHold; alreadySet: boolean }> {
  return getDatabase().withTransaction(async query => {
    await lockAdmission(query);
    const inserted = await query(
      'INSERT INTO remote_agent_install_hold (id, set_by) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [INSTALL_HOLD_ID, input.setBy]
    );
    const hold = await readInstallHold(query);
    if (!hold) throw new Error('The install hold was not recorded.');
    return { hold, alreadySet: inserted.rowCount !== 1 };
  });
}

export async function liftInstallHold(): Promise<InstallHold | null> {
  return getDatabase().withTransaction(async query => {
    await lockAdmission(query);
    const hold = await readInstallHold(query);
    if (hold) await query('DELETE FROM remote_agent_install_hold WHERE id = $1', [INSTALL_HOLD_ID]);
    return hold;
  });
}

// Stripped, not strict like its owner, so a start whose intent a newer binary extended still lists.
const heldIntentSchema = z.object({
  launch: resourceStartBindingIntentSchema.shape.launch
    .pick({ cwd: true, workflowName: true })
    .strip(),
});

/** The stored intent's workflow and checkout, or null when it does not read. */
function heldIntent(intent: unknown): { workflow: string; cwd: string } | null {
  try {
    const parsed = heldIntentSchema.safeParse(parseStoredJson(intent));
    return parsed.success
      ? { workflow: parsed.data.launch.workflowName, cwd: parsed.data.launch.cwd }
      : null;
  } catch {
    // Malformed JSON: the start is still listed, without its workflow.
    return null;
  }
}

export async function listHeldStarts(): Promise<HeldStart[]> {
  const db = getDatabase();
  const bindings = await db.query<{
    receipt_id: string;
    binding_id: string;
    host_id: string | null;
    intent: unknown;
    item_key: string | null;
    receipt_item_key: string | null;
    received_at: string | Date;
  }>(
    `SELECT b.receipt_id, b.binding_id, b.host_id, b.intent, b.item_key,
            r.item_key AS receipt_item_key, r.received_at
       FROM remote_agent_start_receipt_bindings b
       JOIN remote_agent_start_receipts r ON r.id = b.receipt_id
      WHERE b.preparation_status IN ('pending','failed')
      ORDER BY b.created_at, b.binding_id`
  );
  const queued = await db.query<{
    id: string;
    host_id: string;
    resource_key: string;
    launch: unknown;
    created_at: string | Date;
  }>(
    `SELECT id, host_id, resource_key, launch, created_at
       FROM remote_agent_resource_start_requests WHERE status = 'queued' ORDER BY queue_position`
  );
  return [
    ...bindings.rows.map((row): HeldStart => {
      const intent = heldIntent(row.intent);
      return {
        kind: 'trigger',
        receiptId: String(row.receipt_id),
        bindingId: row.binding_id,
        hostId: row.host_id,
        workflow: intent?.workflow ?? null,
        cwd: intent?.cwd ?? null,
        itemKey: row.item_key ?? row.receipt_item_key,
        receivedAt:
          row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
      };
    }),
    ...queued.rows.map(
      (row): HeldStart => ({
        kind: 'queued',
        requestId: String(row.id),
        hostId: row.host_id,
        resource: row.resource_key,
        workflow: storedWorkflowName(row.launch),
        queuedAt: toHydratedTimestamp(row.created_at).toISOString(),
      })
    ),
  ];
}
