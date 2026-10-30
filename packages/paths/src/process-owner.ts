/**
 * The identity of the process that owns a shared resource, and the only
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

export class ProcessOwnerRecordError extends Error {
  constructor(
    /** Where the record was read from, such as a file path or a database row. */
    public readonly source: string,
    cause?: unknown
  ) {
    super(`Invalid owner record in ${source}; inspect it manually.`, { cause });
    this.name = 'ProcessOwnerRecordError';
  }
}

/**
 * A pid `process.kill(pid, 0)` probes as one process. Zero and negative pids
 * address process groups, so ESRCH for them says nothing about one owner.
 */
function isProcessId(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0;
}

/** Turns an owner record read from storage into a `ProcessOwner`, or throws naming `source`. */
export function parseProcessOwner(record: unknown, source: string): ProcessOwner {
  if (
    typeof record === 'object' &&
    record !== null &&
    'host' in record &&
    typeof record.host === 'string' &&
    'pid' in record &&
    isProcessId(record.pid) &&
    'instance' in record &&
    typeof record.instance === 'string'
  ) {
    return { host: record.host, pid: record.pid, instance: record.instance };
  }
  throw new ProcessOwnerRecordError(source);
}

/** True when both records name the same process incarnation. */
export function isSameOwner(a: ProcessOwner, b: ProcessOwner): boolean {
  return a.host === b.host && a.pid === b.pid && a.instance === b.instance;
}

/** True only when this host can prove the owner process no longer exists. */
export function isOwnerProvablyGone(
  owner: ProcessOwner,
  self: ProcessOwner = currentProcessOwner
): boolean {
  if (!isProcessId(owner.pid) || owner.host !== self.host) return false;
  if (owner.pid === self.pid) return owner.instance !== self.instance;
  return isPidProvablyGone(owner.pid);
}

export type PidLivenessObservation =
  | { status: 'returned'; value: boolean }
  | { status: 'threw'; code: string | null; errno: number | null };

/** Retains the evidence from the same signal-0 call that decides proof of death. */
export function probePidLiveness(pid: number): PidLivenessObservation {
  try {
    return { status: 'returned', value: process.kill(pid, 0) };
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : null;
    const errno =
      typeof error === 'object' &&
      error !== null &&
      'errno' in error &&
      typeof error.errno === 'number'
        ? error.errno
        : null;
    return { status: 'threw', code, errno };
  }
}

/** True only when no process with this pid exists on this host. */
export function isPidProvablyGone(pid: number): boolean {
  const liveness = probePidLiveness(pid);
  // EPERM means the pid exists under another user; only ESRCH proves it is gone.
  return liveness.status === 'threw' && liveness.code === 'ESRCH';
}
