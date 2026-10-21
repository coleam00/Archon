/**
 * Remove a terminal run's scratch directory (`$ARTIFACTS_DIR/.archon/scratch`).
 *
 * Scratch is removed only where nothing of the run can still write into it:
 * - Every store calls `releaseRunScratch` after a terminal status write commits and only
 *   when it won that transition, the same duty as terminal telemetry (see
 *   `IWorkflowStore.completeWorkflowRun`). That covers every terminal writer that has no
 *   live executor behind it: cancel while paused, abandon after the owner died, a cancel
 *   that stopped the owner first, conversation reset.
 * - A cancel the executor only observes at its next status check leaves its nodes
 *   writing after that commit, so the executor calls it again when it exits.
 * - A container run is skipped by both: its container mounts the artifacts directory and
 *   lives past the terminal write, and code in it could swap `.archon` for a link between
 *   the check below and `rm`. The container backend calls `removeRunScratch` once the
 *   container is removed.
 *
 * Only the scratch child is removed; the rest of the artifacts directory is the
 * workflow's evidence and is never inspected. The engine directory must be a real
 * directory, so a link left behind in it is not followed out of the run. A link inside
 * scratch is removed as a link.
 */

import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';
import {
  getRunArtifactsDirForRoot,
  getRunScratchDir,
  resolveRunStorageRoot,
  RUN_ARTIFACTS_ENGINE_SUBDIR,
} from '@archon/paths/archon-paths';
import type { WorkflowRun } from './schemas/workflow-run';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.run-scratch');
  return cachedLog;
}

/** Never throws: the status write is authoritative, and a failed removal is only logged. */
export async function releaseRunScratch(
  run: Pick<WorkflowRun, 'id' | 'output_root' | 'metadata'>
): Promise<void> {
  if (run.metadata.isolation === 'container') {
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
 * nothing can still write into `artifactsDir`. Never throws; failures are logged with
 * `logContext`.
 */
export async function removeRunScratch(
  artifactsDir: string,
  logContext: Record<string, unknown>
): Promise<void> {
  const engineDir = join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR);
  const scratchDir = getRunScratchDir(artifactsDir);
  try {
    const entry = await lstat(engineDir).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry) return;
    if (!entry.isDirectory()) {
      getLog().warn({ ...logContext, path: engineDir }, 'run_scratch.engine_dir_not_directory');
      return;
    }
    await rm(scratchDir, { recursive: true, force: true });
  } catch (error) {
    getLog().warn(
      { ...logContext, err: error as Error, path: scratchDir },
      'run_scratch.remove_failed'
    );
  }
}
