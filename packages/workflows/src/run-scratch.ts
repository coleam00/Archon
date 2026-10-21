/**
 * Remove a terminal run's scratch directory (`$ARTIFACTS_DIR/.archon/scratch`).
 *
 * Scratch is removed only where nothing of the run can still write into it:
 * - The executor removes it when it exits and the run is terminal. Its nodes have stopped
 *   by then, including after a cancel it only observed at a status check.
 * - A store removes it after a terminal write that ended a paused or failed run
 *   (`releaseScratchAfterTerminalWrite`): no executor is behind such a run. A terminal
 *   write that ended a pending or running run leaves scratch to that run's executor,
 *   because a cooperative cancel, `halt`, a cancelling gate or a fan-out cancel commits
 *   while its nodes may still be writing.
 * - Cancel and abandon remove it themselves once they have stopped the run's owner.
 * - A container run is skipped by all of these: its container mounts the artifacts
 *   directory and lives past the terminal write. The container backend calls
 *   `removeRunScratch` once the container is removed, so every operation that cancels a
 *   paused container run (abandon, conversation reset, gate reject) reclaims its container.
 *
 * Only the scratch child is removed; the rest of the artifacts directory is the
 * workflow's evidence and is never inspected.
 */

import { rm } from 'node:fs/promises';
import { createLogger } from '@archon/paths';
import {
  getRunArtifactsDirForRoot,
  getRunScratchDir,
  resolveRunStorageRoot,
} from '@archon/paths/archon-paths';
import {
  isContainerRun,
  isTerminalRunStatus,
  type WorkflowRun,
  type WorkflowRunStatus,
} from './schemas/workflow-run';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.run-scratch');
  return cachedLog;
}

type ScratchRun = Pick<WorkflowRun, 'id' | 'output_root' | 'metadata'>;

/**
 * A store's duty after a terminal write it won: remove scratch when the write moved `run`
 * from a status with no executor left to write it into a terminal one. A terminal event
 * appended without that status change ends nothing. Never throws.
 */
export async function releaseScratchAfterTerminalWrite(
  run: ScratchRun & Pick<WorkflowRun, 'status'>,
  priorStatus: WorkflowRunStatus
): Promise<void> {
  if (!isTerminalRunStatus(run.status) || run.status === priorStatus) return;
  if (priorStatus === 'paused' || priorStatus === 'failed') await releaseRunScratch(run);
}

/**
 * Remove a terminal run's scratch. The caller guarantees nothing of the run can still
 * write into it. Never throws: the status write is authoritative, and a failed removal
 * is only logged.
 */
export async function releaseRunScratch(run: ScratchRun): Promise<void> {
  if (isContainerRun(run)) {
    getLog().debug({ workflowRunId: run.id }, 'run_scratch.left_to_container_teardown');
    return;
  }
  // A row with no trusted output_root (created before the column existed, or on the
  // identity_unresolved path) has no locatable artifacts directory, so nothing is removed.
  const root = resolveRunStorageRoot(run, null);
  if (!root) {
    getLog().debug({ workflowRunId: run.id }, 'run_scratch.no_storage_root');
    return;
  }
  await removeRunScratch(getRunArtifactsDirForRoot(root, run.id), { workflowRunId: run.id });
}

/**
 * Remove `artifactsDir`'s scratch child. The caller guarantees the run is terminal and
 * nothing of it can still write into `artifactsDir`. Never throws; failures are logged
 * with `logContext`.
 *
 * A recursive `rm` does not follow symlinks inside the tree, so a link a node left in
 * scratch is removed, not its target.
 */
export async function removeRunScratch(
  artifactsDir: string,
  logContext: Record<string, unknown>
): Promise<void> {
  const scratchDir = getRunScratchDir(artifactsDir);
  try {
    await rm(scratchDir, { recursive: true, force: true });
  } catch (error) {
    getLog().warn(
      { ...logContext, err: error as Error, path: scratchDir },
      'run_scratch.remove_failed'
    );
  }
}
