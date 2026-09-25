/**
 * The identity of the process that owns a provider-attempt slot holder, and the only
 * proof Archon accepts that such an owner is gone.
 *
 * A pid alone is not an identity: a restarted container often gets its old pid back.
 * The per-process `instance` token tells a new incarnation from the one that wrote
 * the row. Liveness is provable only on the owner's own host; a holder from any other
 * host stays held until an operator releases it explicitly.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export interface ProcessOwner {
  host: string;
  pid: number;
  instance: string;
}

export const currentProcessOwner: ProcessOwner = Object.freeze({
  host: hostname(),
  pid: process.pid,
  instance: randomUUID(),
});

/** True only when this host can prove the owner process no longer exists. */
export function isOwnerProvablyGone(
  owner: ProcessOwner,
  self: ProcessOwner = currentProcessOwner
): boolean {
  if (owner.host !== self.host) return false;
  if (owner.pid === self.pid) return owner.instance !== self.instance;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // EPERM means the pid exists under another user; only ESRCH proves it is gone.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
