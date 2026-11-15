import {
  CANCELLED_REASON_METADATA_KEY,
  ISOLATION_ENV_ID_METADATA_KEY,
} from '@archon/workflows/schemas/run-metadata';
import { createLogger } from '@archon/paths';
import { noExecutorCanWrite } from '@archon/workflows/run-scratch';
import type { ReleaseVerificationImages, WorkflowDeps } from '@archon/workflows/deps';
import {
  isContainerRun,
  isTerminalRunStatus,
  RESUMABLE_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import { FAN_OUT_CANCEL_REASONS, type IWorkflowStore } from '@archon/workflows/store';

/**
 * Releases a terminal container run's verification images. `release` binds the
 * container resource owner for callers that cannot pass a live backend per call.
 */
export function createRunResourceRelease(
  store: Pick<IWorkflowStore, 'getWorkflowRun'>,
  release?: ReleaseVerificationImages
): NonNullable<WorkflowDeps['releaseRunResources']> {
  return async (runId, releaseVerificationImages) => {
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
      if (isContainerRun(run)) {
        await releaseContainerImages(
          runId,
          run.metadata[ISOLATION_ENV_ID_METADATA_KEY],
          releaseVerificationImages ?? release
        );
        return;
      }
      // Recorded container isolation is the only fact the engine has that a run used
      // Docker. A host run removes its own images, so the engine never asks Docker.
      log.debug({ runId }, 'verification_images.skipped_host_run');
    } catch (err) {
      log.warn({ err, runId }, 'verification_images.release_failed');
      throw err;
    }
  };
}

async function releaseContainerImages(
  runId: string,
  envId: unknown,
  release: ReleaseVerificationImages | undefined
): Promise<void> {
  if (typeof envId !== 'string' || !envId.trim()) {
    throw new Error(`Missing container identity for verification image cleanup: ${runId}`);
  }
  if (!release) {
    throw new Error(`Missing container resource owner for verification image cleanup: ${runId}`);
  }
  await release(runId, envId);
}
