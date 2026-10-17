/**
 * Provider-attempt holders on the shared resource slot (`resource-slots.ts`).
 *
 * Each provider with a configured cap has one slot, keyed `provider:<registration id>`.
 * A holder is one running provider attempt owned by one process. Waiting is the
 * caller's in-process poll, not a durable row: a waiter only means something while
 * its process lives, and a durable waiter left by a dead process would block every
 * waiter behind it.
 */
import { PROVIDER_RESOURCE_PREFIX } from '@archon/workflows/schemas/resource-start';
import { getDatabase } from './connection';
import {
  addResourceSlotHolder,
  liveResourceSlotHolders,
  lockConfiguredResourceSlot,
  removeResourceSlotHolder,
  resourceSlotHolderSource,
} from './resource-slots';
import {
  currentProcessOwner,
  isOwnerProvablyGone,
  parseProcessOwner,
  ProcessOwnerRecordError,
  type ProcessOwner,
} from '@archon/paths/process-owner';

export function providerResourceKey(provider: string): string {
  return `${PROVIDER_RESOURCE_PREFIX}${provider}`;
}

/**
 * Admit one attempt when fewer than `capacity` live holders remain. Dead same-host
 * owners are released inside the same slot lock before counting.
 */
export async function tryAdmitProviderAttempt(input: {
  provider: string;
  capacity: number;
  attemptId: string;
  owner?: ProcessOwner;
}): Promise<{ admitted: boolean; live: number }> {
  const resource = providerResourceKey(input.provider);
  return getDatabase().withTransaction(async query => {
    await lockConfiguredResourceSlot(query, resource, input.capacity);
    const live = (await liveResourceSlotHolders(query, resource)).length;
    if (live >= input.capacity) return { admitted: false, live };
    await addResourceSlotHolder(query, resource, {
      kind: 'attempt',
      id: input.attemptId,
      owner: input.owner ?? currentProcessOwner,
    });
    return { admitted: true, live: live + 1 };
  });
}

export async function releaseProviderAttempt(provider: string, attemptId: string): Promise<void> {
  await getDatabase().withTransaction(query =>
    removeResourceSlotHolder(query, providerResourceKey(provider), {
      kind: 'attempt',
      id: attemptId,
    })
  );
}

interface ProviderAttemptHolderRow {
  provider: string;
  attemptId: string;
  acquiredAt: string;
}

/**
 * A holder whose owner record fails to parse is listed with `owner: null` and the
 * parse error, so one corrupt row cannot hide the healthy holders from the operator.
 */
export type ProviderAttemptHolder = ProviderAttemptHolderRow &
  (
    | {
        owner: ProcessOwner;
        /** False when this host cannot prove liveness either way (the owner is on another host). */
        ownerOnThisHost: boolean;
      }
    | { owner: null; invalidOwner: string }
  );

/** Every provider-attempt holder, for operator inspection and explicit release. */
export async function listProviderAttemptHolders(): Promise<ProviderAttemptHolder[]> {
  const result = await getDatabase().query<{
    resource_key: string;
    holder_id: string;
    owner_host: string | null;
    owner_pid: number | null;
    owner_instance: string | null;
    acquired_at: string | Date;
  }>(
    `SELECT resource_key, holder_id, owner_host, owner_pid, owner_instance, acquired_at
       FROM remote_agent_resource_slot_holders
      WHERE holder_kind = 'attempt'
      ORDER BY resource_key, acquired_at, holder_id`
  );
  return result.rows.map((row): ProviderAttemptHolder => {
    const holder = {
      provider: row.resource_key.slice(PROVIDER_RESOURCE_PREFIX.length),
      attemptId: row.holder_id,
      acquiredAt: row.acquired_at instanceof Date ? row.acquired_at.toISOString() : row.acquired_at,
    };
    try {
      const owner = parseProcessOwner(
        { host: row.owner_host, pid: row.owner_pid, instance: row.owner_instance },
        resourceSlotHolderSource(row.resource_key, row.holder_id)
      );
      return { ...holder, owner, ownerOnThisHost: owner.host === currentProcessOwner.host };
    } catch (error) {
      if (!(error instanceof ProcessOwnerRecordError)) throw error;
      return { ...holder, owner: null, invalidOwner: error.message };
    }
  });
}

/**
 * Explicit operator release of one attempt holder, for an owner this host cannot
 * prove dead. Refuses a same-host owner that is still running. A holder with an
 * invalid owner record has no owner to probe, so the operator's release stands.
 */
export async function releaseProviderAttemptHolder(
  attemptId: string
): Promise<'released' | 'not_found' | 'owner_running'> {
  const holder = (await listProviderAttemptHolders()).find(h => h.attemptId === attemptId);
  if (!holder) return 'not_found';
  if (holder.owner && holder.ownerOnThisHost && !isOwnerProvablyGone(holder.owner)) {
    return 'owner_running';
  }
  await releaseProviderAttempt(holder.provider, attemptId);
  return 'released';
}
