import {
  requestRunLiveOwnerStop,
  RunLiveOwnerStopUnavailableError,
  type RunLiveOwnerStopRefusal,
} from './run-live-owner';
import { terminateWindowsProcessTree } from './windows-process-tree';

/*
 * The one path that stops a detached run owner: prove the exact-run owner through its
 * live-owner endpoint, take its termination lease, terminate its process tree, wait.
 * Every cancel and abandon surface goes through it (`cancelWorkflow`, `abandonWorkflow`).
 */

const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_CONFIRM_MS = 1_000;
const POLL_INTERVAL_MS = 50;

export interface DetachedRunStopTarget {
  /** The detached owner's PID, as the owner itself reported it. */
  readonly pid: number;
  stop(): Promise<void>;
  release(): void;
}

/**
 * No termination lease. Callers render the operator message from `reason` and `detail`
 * (see `cancelWorkflow` and `abandonWorkflow`), so this message only names the facts.
 */
export class DetachedRunOwnerUnavailableError extends Error {
  constructor(
    runId: string,
    readonly detail: string,
    /** `undefined` when the request failed before the endpoint could be asked. */
    readonly reason: RunLiveOwnerStopRefusal | undefined
  ) {
    super(`No live detached owner gave a termination lease for run ${runId} (${detail}).`);
    this.name = 'DetachedRunOwnerUnavailableError';
  }
}

/** Ask the live exact-run owner for an opaque termination lease. */
export async function requestDetachedRunStop(runId: string): Promise<DetachedRunStopTarget> {
  let lease: Awaited<ReturnType<typeof requestRunLiveOwnerStop>>;
  try {
    lease = await requestRunLiveOwnerStop(runId);
  } catch (error) {
    if (error instanceof RunLiveOwnerStopUnavailableError) {
      throw new DetachedRunOwnerUnavailableError(runId, error.detail, error.reason);
    }
    throw new DetachedRunOwnerUnavailableError(
      runId,
      error instanceof Error ? error.message : String(error),
      undefined
    );
  }

  return {
    pid: lease.pid,
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
    await terminateWindowsProcessTree(pid, ownsLiveLease);
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
