import { RUN_JOB_ESCAPE_ENV, startRunJobEscapeBroker } from './run-job-escape';

export const DETACHED_RUN_OWNER_ENV = 'ARCHON_DETACHED_RUN_OWNER';
export const DETACHED_LAUNCH_TOKEN_ENV = 'ARCHON_DETACHED_LAUNCH_TOKEN';

/**
 * Take the process container that active cancellation will stop, before the marked owner
 * starts anything. On POSIX that is the process group the owner must already lead; on
 * Windows it is a job object the owner joins here (see `windows-run-job.ts`), after
 * starting the broker that lets the run's own `--detach` launches leave that job (see
 * `run-job-escape.ts`). Throws when the owner cannot hold it, so a run nobody could cancel
 * never starts.
 */
export async function claimDetachedRunProcessOwner(): Promise<void> {
  if (process.platform === 'win32') {
    // Loaded here, not at the top: CLI startup reads `DETACHED_RUN_OWNER_ENV` from this
    // module and must not load core (`check:cli-import-boundary`).
    const job = await import('@archon/core/services/windows-run-job');
    if (job.currentWindowsRunJob() !== undefined) return;
    process.env[RUN_JOB_ESCAPE_ENV] = await startRunJobEscapeBroker();
    job.claimWindowsRunJob();
    return;
  }
  if (!processGroupExists(process.pid)) {
    throw new Error(
      `Refusing detached run control because process ${String(process.pid)} does not own process group ${String(process.pid)}`
    );
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
