import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  requestRunLiveOwnerStop,
  RunLiveOwnerStopUnavailableError,
} from '@archon/core/services/run-live-owner';

export const DETACHED_RUN_OWNER_ENV = 'ARCHON_DETACHED_RUN_OWNER';

const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_CONFIRM_MS = 1_000;
const POLL_INTERVAL_MS = 50;

const execFileAsync = promisify(execFile);

export interface DetachedRunStopTarget {
  stop(): Promise<void>;
  release(): void;
}

export class DetachedRunOwnerUnavailableError extends Error {
  constructor(runId: string, detail?: string) {
    super(
      `No live detached CLI owner is reachable for run ${runId}. The run was not changed.` +
        `${detail ? ` (${detail})` : ''} ` +
        `If you have verified that its process is gone, use 'archon workflow abandon ${runId}' to release its persisted state.`
    );
    this.name = 'DetachedRunOwnerUnavailableError';
  }
}

/** Prove the marked POSIX owner has the process group that active cancellation will signal. */
export function assertDetachedRunProcessOwner(): void {
  if (process.platform !== 'win32' && !processGroupExists(process.pid)) {
    throw new Error(
      `Refusing detached run control because process ${String(process.pid)} does not own process group ${String(process.pid)}`
    );
  }
}

/** Ask the live exact-run owner for an opaque termination lease. */
export async function requestDetachedRunStop(runId: string): Promise<DetachedRunStopTarget> {
  let lease: Awaited<ReturnType<typeof requestRunLiveOwnerStop>>;
  try {
    lease = await requestRunLiveOwnerStop(runId);
  } catch (error) {
    const detail =
      error instanceof RunLiveOwnerStopUnavailableError
        ? error.detail
        : error instanceof Error
          ? error.message
          : String(error);
    throw new DetachedRunOwnerUnavailableError(runId, detail);
  }

  return {
    stop: async (): Promise<void> => {
      try {
        await lease.commit();
        await terminateDetachedProcessTree(lease.pid, () => lease.isLive());
      } finally {
        lease.release();
      }
    },
    release: (): void => {
      lease.release();
    },
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntilGone(exists: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (exists()) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return true;
}

/**
 * Did a child command die by signal instead of exiting with a status of its own?
 *
 * This is the line between a command that ran to completion and reported something,
 * and one that was cut off part-way. Node makes it structural rather than textual:
 * a `timeout` kill sets `killed: true` with `signal: 'SIGTERM'`, an ordinary non-zero
 * exit reports `killed: false` with a numeric `code`, and a command that never started
 * carries neither. Nothing here reads message text, so it holds under any locale.
 *
 * Exported for testing: the Windows termination path tolerates a completed-but-failed
 * command and must never tolerate an interrupted one, and that decision cannot be
 * exercised from a platform where the path does not run.
 */
export function commandTerminatedBySignal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { killed, signal } = error as { killed?: unknown; signal?: unknown };
  return killed === true || typeof signal === 'string';
}

/** Terminate the process tree while its exact-run owner holds the IPC lease open. */
async function terminateDetachedProcessTree(
  pid: number,
  ownsLiveLease: () => boolean
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error(`Refusing to terminate invalid detached owner PID ${String(pid)}`);
  }
  if (!ownsLiveLease()) {
    throw new Error(`Detached workflow owner ${String(pid)} released its termination lease`);
  }

  if (process.platform === 'win32') {
    // `taskkill /T` walks the tree PID by PID and exits non-zero when any of them is
    // already gone — the outcome this function wants, reached early. Nothing in that
    // exit code separates it from a kill that genuinely failed, so it is not the
    // proof: the confirmation below is, the same way the POSIX branch tolerates ESRCH
    // and then re-checks. A tree that is still running throws there, carrying the
    // command's own error as the evidence.
    //
    // A walk that never finished is a different case and is rethrown here. The root
    // check can only stand in for the whole tree when every descendant was visited,
    // and a `timeout` kill leaves taskkill part-way through: the root can be gone
    // while a descendant the walk never reached is still alive. `/T` is what takes
    // the descendants with the root, and that they actually die is proved by the
    // descendant-leak case in the integration spec, not by any exit code.
    let killFailure: Error | undefined;
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: TERMINATION_GRACE_MS,
        windowsHide: true,
      });
    } catch (error) {
      if (commandTerminatedBySignal(error)) throw error;
      killFailure = error instanceof Error ? error : new Error(String(error));
    }
    if (!(await waitUntilGone(() => processExists(pid), TERMINATION_CONFIRM_MS))) {
      throw new Error(
        `Detached workflow process tree ${String(pid)} is still running` +
          (killFailure ? `: ${killFailure.message}` : '')
      );
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    if (processExists(pid)) {
      throw new Error(
        `Detached workflow owner ${String(pid)} is alive but does not own process group ${String(pid)}`
      );
    }
    return;
  }
  if (await waitUntilGone(() => processGroupExists(pid), TERMINATION_GRACE_MS)) return;

  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    if (processExists(pid)) {
      throw new Error(
        `Detached workflow owner ${String(pid)} is alive but does not own process group ${String(pid)}`
      );
    }
    return;
  }
  if (!(await waitUntilGone(() => processGroupExists(pid), TERMINATION_CONFIRM_MS))) {
    throw new Error(`Detached workflow process group ${String(pid)} is still running`);
  }
}
