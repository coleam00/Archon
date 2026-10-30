import {
  CANCELLED_REASON_METADATA_KEY,
  ISOLATION_ENV_ID_METADATA_KEY,
} from '@archon/workflows/schemas/run-metadata';
import { dockerCli, releaseRunVerificationImages } from '@archon/isolation';
import { createLogger } from '@archon/paths';
import { noExecutorCanWrite } from '@archon/workflows/run-scratch';
import {
  isContainerRun,
  isTerminalRunStatus,
  RESUMABLE_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import { FAN_OUT_CANCEL_REASONS, type IWorkflowStore } from '@archon/workflows/store';

async function hostDockerAvailable(): Promise<boolean> {
  try {
    await dockerCli(['version', '--format', '{{.Server.Version}}'], {
      timeout: 10_000,
    });
    return true;
  } catch (err) {
    createLogger('cleanup.verification-images').info(
      { err },
      'verification_images.docker_unavailable'
    );
    return false;
  }
}

export function createRunResourceRelease(
  store: Pick<IWorkflowStore, 'getWorkflowRun'>,
  release: typeof releaseRunVerificationImages = releaseRunVerificationImages
): (runId: string) => Promise<void> {
  // Snapshot daemon reachability before execution. Losing Docker later must
  // remain a cleanup failure, rather than looking like a Docker-free host.
  const dockerAvailable =
    release === releaseRunVerificationImages ? hostDockerAvailable() : Promise.resolve(true);
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
      // A workflow can start Docker itself after the host was created.
      if (!isContainerRun(run) && !(await dockerAvailable) && !(await hostDockerAvailable())) {
        log.info({ runId }, 'verification_images.skipped_docker_unavailable');
        return;
      }
      await release(runId, isContainerRun(run) && typeof envId === 'string' ? envId : undefined);
    } catch (err) {
      log.warn({ err, runId }, 'verification_images.release_failed');
      throw err;
    }
  };
}
