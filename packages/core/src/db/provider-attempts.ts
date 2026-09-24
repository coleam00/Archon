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
} from './resource-slots';
import { currentProcessOwner, isOwnerProvablyGone, type ProcessOwner } from './process-owner';

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

export interface ProviderAttemptHolder {
  provider: string;
  attemptId: string;
  owner: ProcessOwner;
  acquiredAt: string;
  /** False when this host cannot prove liveness either way (the owner is on another host). */
  ownerOnThisHost: boolean;
}

/** Every provider-attempt holder, for operator inspection and explicit release. */
export async function listProviderAttemptHolders(): Promise<ProviderAttemptHolder[]> {
  const result = await getDatabase().query<{
    resource_key: string;
    holder_id: string;
    owner_host: string;
    owner_pid: number | string;
    owner_instance: string;
    acquired_at: string | Date;
  }>(
    `SELECT resource_key, holder_id, owner_host, owner_pid, owner_instance, acquired_at
       FROM remote_agent_resource_slot_holders
      WHERE holder_kind = 'attempt'
      ORDER BY resource_key, acquired_at, holder_id`
  );
  return result.rows.map(row => {
    const owner = {
      host: row.owner_host,
      pid: Number(row.owner_pid),
      instance: row.owner_instance,
    };
    return {
      provider: row.resource_key.slice(PROVIDER_RESOURCE_PREFIX.length),
      attemptId: row.holder_id,
      owner,
      acquiredAt: row.acquired_at instanceof Date ? row.acquired_at.toISOString() : row.acquired_at,
      ownerOnThisHost: owner.host === currentProcessOwner.host,
    };
  });
}

/**
 * Explicit operator release of one attempt holder, for an owner this host cannot
 * prove dead. Refuses a same-host owner that is still running.
 */
export async function releaseProviderAttemptHolder(
  attemptId: string
): Promise<'released' | 'not_found' | 'owner_running'> {
  const holder = (await listProviderAttemptHolders()).find(h => h.attemptId === attemptId);
  if (!holder) return 'not_found';
  if (holder.ownerOnThisHost && !isOwnerProvablyGone(holder.owner)) return 'owner_running';
  await releaseProviderAttempt(holder.provider, attemptId);
  return 'released';
}
