import {
  CANCELLED_REASON_METADATA_KEY,
  ISOLATION_ENV_ID_METADATA_KEY,
} from '@archon/workflows/schemas/run-metadata';
import { releaseRunVerificationImages } from '@archon/isolation';
import { createLogger } from '@archon/paths';
import { noExecutorCanWrite } from '@archon/workflows/run-scratch';
import {
  isContainerRun,
  isTerminalRunStatus,
  RESUMABLE_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import { FAN_OUT_CANCEL_REASONS, type IWorkflowStore } from '@archon/workflows/store';

export function createRunResourceRelease(
  store: Pick<IWorkflowStore, 'getWorkflowRun'>,
  // Snapshot the optional host capability before execution. Losing Docker later
  // must remain a cleanup failure, rather than looking like a Docker-free host.
  release: typeof releaseRunVerificationImages | undefined = Bun.which('docker', {
    PATH: process.env.PATH ?? '',
  })
    ? releaseRunVerificationImages
    : undefined
): (runId: string) => Promise<void> {
  return async runId => {
    const log = createLogger('cleanup.verification-images');
    try {
      const run = await store.getWorkflowRun(runId);
      if (!run || !isTerminalRunStatus(run.status) || !noExecutorCanWrite(run)) {
        log.debug({ runId }, 'verification_images.kept_for_owner');
        return;
      }
      // Failed runs and fan-out-cancelled children can resume under the same ID
      // during Docker I/O; writer shutdown alone cannot authorize their deletion.
      if (
        RESUMABLE_WORKFLOW_STATUSES.includes(run.status) ||
        (run.status === 'cancelled' &&
          FAN_OUT_CANCEL_REASONS.some(
            reason => reason === run.metadata[CANCELLED_REASON_METADATA_KEY]
          ))
      ) {
        log.debug({ runId }, 'verification_images.kept_for_resumable_run');
        return;
      }
      const envId = run.metadata[ISOLATION_ENV_ID_METADATA_KEY];
      if (isContainerRun(run) && (typeof envId !== 'string' || !envId.trim())) {
        throw new Error(`Missing container identity for verification image cleanup: ${runId}`);
      }
      if (!release && !isContainerRun(run)) {
        log.info({ runId }, 'verification_images.skipped_docker_unavailable');
        return;
      }
      await (release ?? releaseRunVerificationImages)(
        runId,
        isContainerRun(run) && typeof envId === 'string' ? envId : undefined
      );
    } catch (err) {
      log.warn({ err, runId }, 'verification_images.release_failed');
      throw err;
    }
  };
}
