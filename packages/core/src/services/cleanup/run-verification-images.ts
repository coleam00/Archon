import { releaseRunVerificationImages } from '@archon/isolation';
import { createLogger } from '@archon/paths';
import { noExecutorCanWrite } from '@archon/workflows/run-scratch';
import {
  isContainerRun,
  isTerminalRunStatus,
  RESUMABLE_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';

export function createRunResourceRelease(
  store: Pick<IWorkflowStore, 'getWorkflowRun'>,
  release = releaseRunVerificationImages
): (runId: string) => Promise<void> {
  return async runId => {
    const log = createLogger('cleanup.verification-images');
    try {
      const run = await store.getWorkflowRun(runId);
      if (!run || !isTerminalRunStatus(run.status) || !noExecutorCanWrite(run)) {
        log.debug({ runId }, 'verification_images.kept_for_owner');
        return;
      }
      // A failed run can resume in another process during Docker I/O. Without an
      // admission lock, only unresumable terminal states authorize deletion.
      if (RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
        log.debug({ runId }, 'verification_images.kept_for_resumable_run');
        return;
      }
      const envId = run.metadata.isolation_env_id;
      if (isContainerRun(run) && (typeof envId !== 'string' || !envId.trim())) {
        throw new Error(`Missing container identity for verification image cleanup: ${runId}`);
      }
      await release(runId, isContainerRun(run) && typeof envId === 'string' ? envId : undefined);
    } catch (err) {
      log.warn({ err, runId }, 'verification_images.release_failed');
      throw err;
    }
  };
}
