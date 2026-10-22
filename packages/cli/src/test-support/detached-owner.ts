import { readFileSync } from 'node:fs';
import {
  DetachedRunOwnerUnavailableError,
  requestDetachedRunStop,
} from '@archon/core/services/run-owner-stop';

export async function waitForDetachedTestOwnerExit(pidFile: string): Promise<void> {
  const pid = Number(readFileSync(pidFile, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`Invalid test owner PID in ${pidFile}`);
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(`Detached test owner ${String(pid)} is still alive`);
    await Bun.sleep(25);
  }
}

export async function stopDetachedTestOwner(runId: string, pidFile: string): Promise<void> {
  try {
    await (await requestDetachedRunStop(runId)).stop();
  } catch (error) {
    if (
      !(error instanceof DetachedRunOwnerUnavailableError) ||
      (error.reason !== 'unreachable' && error.reason !== 'unproven')
    )
      throw error;
    // Endpoint closure can precede process exit. Only the fixture's recorded owner
    // disappearing makes an unavailable stop safe to accept in test cleanup.
    await waitForDetachedTestOwnerExit(pidFile).catch(exitError => {
      throw new AggregateError(
        [error, exitError],
        'Detached test owner is still alive after refused stop'
      );
    });
    return;
  }
  await waitForDetachedTestOwnerExit(pidFile);
}
