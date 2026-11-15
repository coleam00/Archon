import {
  CANCELLED_REASON_METADATA_KEY,
  ISOLATION_ENV_ID_METADATA_KEY,
} from '@archon/workflows/schemas/run-metadata';
import {
  releaseRunVerificationImages,
  VerificationImageInventoryError,
  VERIFICATION_IMAGE_RUN_LABEL,
} from '@archon/isolation';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';
import { getRunArtifactsDirForRoot, resolveRunStorageRoot } from '@archon/paths/archon-paths';
import { noExecutorCanWrite } from '@archon/workflows/run-scratch';
import type { ReleaseVerificationImages, WorkflowDeps } from '@archon/workflows/deps';
import {
  isContainerRun,
  isTerminalRunStatus,
  RESUMABLE_WORKFLOW_STATUSES,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { FAN_OUT_CANCEL_REASONS, type IWorkflowStore } from '@archon/workflows/store';

/**
 * The `$ARTIFACTS_DIR` child a node records its verification builds in, one
 * `docker build --iidfile` file per build. A run with no entry there built no image, so
 * cleanup never asks Docker about it.
 */
export const VERIFICATION_IMAGE_RECORD_DIR = 'verification-images';

/**
 * Releases a terminal run's recorded verification images. A supplied factory effect
 * binds the resource owner for calls without a live backend.
 */
export function createRunResourceRelease(
  store: Pick<IWorkflowStore, 'getWorkflowRun'>,
  release?: typeof releaseRunVerificationImages
): NonNullable<WorkflowDeps['releaseRunResources']> {
  const hostRelease = release ?? releaseRunVerificationImages;
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
      if (!(await recordsVerificationImages(run))) {
        log.debug({ runId }, 'verification_images.none_recorded');
        return;
      }
      if (isContainerRun(run)) {
        return await releaseContainerImages(
          runId,
          run.metadata[ISOLATION_ENV_ID_METADATA_KEY],
          releaseVerificationImages ?? release
        );
      }
      return await hostRelease(runId, undefined).catch((err: unknown) => {
        if (!(err instanceof VerificationImageInventoryError)) throw err;
        log.warn({ err, runId }, 'verification_images.inventory_inconclusive');
        const warning =
          `WARNING: Run ${runId} verification image inventory failed; cleanup is inconclusive. ` +
          'Restore access to the intended Docker context, confirm the run cannot resume or write, ' +
          `then list its images with docker image ls --all --no-trunc --filter "label=${VERIFICATION_IMAGE_RUN_LABEL}=${runId}". ` +
          'Inspect each full ID with docker image inspect <full-id> and check all containers with ' +
          'docker container ls --all --filter ancestor=<full-id>. Remove only confirmed owned, unused images with ' +
          'docker image rm --no-prune <full-id>. Multiple tags require manual recovery under exclusive control of their references. ' +
          'Never force removal or prune shared images/cache.';
        console.error(warning);
        return [warning];
      });
    } catch (err) {
      log.warn({ err, runId }, 'verification_images.release_failed');
      throw err;
    }
  };
}

async function recordsVerificationImages(
  run: Pick<WorkflowRun, 'id' | 'output_root'>
): Promise<boolean> {
  // A row with no trusted output_root has no locatable $ARTIFACTS_DIR, so it holds no record.
  const root = resolveRunStorageRoot(run, null);
  if (!root) return false;
  const dir = join(getRunArtifactsDirForRoot(root, run.id), VERIFICATION_IMAGE_RECORD_DIR);
  try {
    return (await readdir(dir)).length > 0;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return false;
    throw err;
  }
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
