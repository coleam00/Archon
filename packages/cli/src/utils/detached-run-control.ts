export const DETACHED_RUN_OWNER_ENV = 'ARCHON_DETACHED_RUN_OWNER';

/** Prove the marked POSIX owner has the process group that active cancellation will signal. */
export function assertDetachedRunProcessOwner(): void {
  if (process.platform !== 'win32' && !processGroupExists(process.pid)) {
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
