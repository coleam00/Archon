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

import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '@archon/paths';
import {
  getRunArtifactsDirForRoot,
  getRunScratchDir,
  resolveRunStorageRoot,
  RUN_ARTIFACTS_ENGINE_SUBDIR,
} from '@archon/paths/archon-paths';
import { isContainerRun, type WorkflowRun, type WorkflowRunStatus } from './schemas/workflow-run';

const execFileAsync = promisify(execFile);

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.run-scratch');
  return cachedLog;
}

type ScratchRun = Pick<WorkflowRun, 'id' | 'output_root' | 'metadata'>;

/**
 * A store's duty after a terminal write it won: remove scratch when the write ended a run
 * that had no executor left to write it. Never throws.
 */
export async function releaseScratchAfterTerminalWrite(
  run: ScratchRun,
  priorStatus: WorkflowRunStatus
): Promise<void> {
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
 * Something that outlived the run could still replace `.archon` or the run directory
 * with a link, so no path through them is trusted at the moment of removal. `rm` runs
 * in a child whose working directory is first proven to be the run's own `.archon`:
 * `pwd -P` names the directory the child actually holds, and `rm -rf scratch` then
 * resolves from that directory, not from a path, and never follows a link below it.
 * The physical path is anchored at the runs directory, which holds every run and is
 * not part of any one run's artifacts.
 */
export async function removeRunScratch(
  artifactsDir: string,
  logContext: Record<string, unknown>
): Promise<void> {
  if (process.platform === 'win32') {
    // No removal here is confined against a replaced parent, so scratch is kept.
    getLog().debug({ ...logContext, artifactsDir }, 'run_scratch.windows_unsupported');
    return;
  }
  const engineDir = join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR);
  try {
    if (!(await exists(getRunScratchDir(artifactsDir)))) return;
    const expected = join(
      await realpath(dirname(artifactsDir)),
      basename(artifactsDir),
      RUN_ARTIFACTS_ENGINE_SUBDIR
    );
    await execFileAsync(
      '/bin/sh',
      ['-c', '[ "$(pwd -P)" = "$1" ] || exit 3; exec rm -rf -- scratch', 'sh', expected],
      { cwd: engineDir }
    );
  } catch (error) {
    getLog().warn(
      { ...logContext, err: error as Error, path: engineDir },
      'run_scratch.remove_failed'
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
