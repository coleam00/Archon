/**
 * Remove a terminal run's scratch directory (`$ARTIFACTS_DIR/.archon/scratch`).
 *
 * Every store calls this after a terminal status write commits and only when it won
 * that transition, the same duty as terminal telemetry (see
 * `IWorkflowStore.completeWorkflowRun`). Hanging it on the store rather than on the
 * executor covers every terminal writer — cancel while paused, abandon after the owner
 * died, conversation reset — in whichever process made the write.
 *
 * Only the scratch child is removed; the rest of the artifacts directory is the
 * workflow's evidence and is never inspected. The engine directory must be a real
 * directory: code in a container run can plant a `.archon` link in its mounted
 * artifacts directory, and `rm` would follow that parent link out of the run. A link
 * inside scratch is removed as a link.
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
  run: Pick<WorkflowRun, 'id' | 'output_root'>
): Promise<void> {
  // A row with no trusted output_root (created before the column existed, or on the
  // identity_unresolved path) has no locatable artifacts directory, so nothing is removed.
  const root = resolveRunStorageRoot(run, null);
  if (!root) {
    getLog().debug({ workflowRunId: run.id }, 'run_scratch.no_storage_root');
    return;
  }
  const artifactsDir = getRunArtifactsDirForRoot(root, run.id);
  const engineDir = join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR);
  const scratchDir = getRunScratchDir(artifactsDir);
  try {
    const entry = await lstat(engineDir).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry) return;
    if (!entry.isDirectory()) {
      getLog().warn(
        { workflowRunId: run.id, path: engineDir },
        'run_scratch.engine_dir_not_directory'
      );
      return;
    }
    await rm(scratchDir, { recursive: true, force: true });
  } catch (error) {
    getLog().warn(
      { err: error as Error, workflowRunId: run.id, path: scratchDir },
      'run_scratch.remove_failed'
    );
  }
}
