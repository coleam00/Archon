/**
 * Remove a terminal run's scratch directory (`$ARTIFACTS_DIR/.archon/scratch`).
 *
 * Scratch is removed only once the run is terminal and nothing of it can still write
 * into it. `releaseRunScratch` proves the second half itself: the run's recorded
 * execution owner must be this process, no longer executing the run, or a process on
 * this host that no longer exists. A run can be terminal while its executor still runs
 * nodes: a cooperative cancel, `halt` or a fan-out cancel commits while they write, a
 * gate pauses its run while sibling nodes in the same layer still execute, and a CLI
 * stopped by a signal records `failed` before it ends its node trees.
 * - The executor releases scratch when it exits and the run is terminal; its nodes have
 *   stopped by then. A host may defer deletion until it reports the settled outcome,
 *   then drain cleanup before sleeping or shutting down.
 * - Cancel, abandon, a conversation reset and a cancelling gate reject release the
 *   scratch of the runs they cancelled. Where the owner proof fails, scratch is kept: an
 *   owner on another host, a recorded owner process still alive, or an output holder a
 *   stop left running.
 * - A container run is skipped by all of these: its container mounts the artifacts
 *   directory and lives past the terminal write. The container backend calls
 *   `removeRunScratch` once the container is removed, so a gate reject that proves the
 *   owner gone reclaims the container.
 *
 * Only the scratch child is removed; the rest of the artifacts directory is the
 * workflow's evidence and is never inspected.
 */

import { hostname } from 'node:os';
import { rm } from 'node:fs/promises';
import { createLogger } from '@archon/paths';
import { isPidProvablyGone } from '@archon/paths/process-owner';
import {
  getRunArtifactsDirForRoot,
  getRunScratchDir,
  resolveRunStorageRoot,
} from '@archon/paths/archon-paths';
import { isContainerRun, readExecutionOwner, type WorkflowRun } from './schemas/workflow-run';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.run-scratch');
  return cachedLog;
}

type ScratchRun = Pick<WorkflowRun, 'id' | 'output_root' | 'metadata'>;

/** Executions of each run in progress in this process; a run can re-enter itself. */
const executingHere = new Map<string, number>();

/**
 * Count `runId` as executing in this process until the returned function is called. The
 * executor holds it while the run's nodes can run, so a release in the same process can
 * tell an executor that is still running from one that has exited.
 */
export function enterRunExecution(runId: string): () => void {
  executingHere.set(runId, (executingHere.get(runId) ?? 0) + 1);
  return () => {
    const count = (executingHere.get(runId) ?? 1) - 1;
    if (count > 0) executingHere.set(runId, count);
    else executingHere.delete(runId);
  };
}

/**
 * True only when no executor of `run` can still be running: its recorded execution owner
 * is this process and it is not executing the run, or a process on this host that no
 * longer exists. Every executor stamps the runs it executes, a sub-run or a parent
 * resumed in its child's process included, so the record names the process that last
 * ran the run's nodes. A reused pid reads as alive and keeps scratch.
 */
export function noExecutorCanWrite(run: Pick<WorkflowRun, 'id' | 'metadata'>): boolean {
  const owner = readExecutionOwner(run.metadata);
  if (owner?.host !== hostname()) return false;
  if (owner.pid === process.pid) return !executingHere.has(run.id);
  return isPidProvablyGone(owner.pid);
}

/**
 * Remove a terminal run's scratch once no executor can still write it. The caller
 * guarantees the run is terminal and that nothing it left running outside the executor,
 * such as an output holder a stop could not end, still writes. Never throws: the status
 * write is authoritative, and a failed removal is only logged.
 */
export async function releaseRunScratch(run: ScratchRun): Promise<void> {
  if (isContainerRun(run)) {
    getLog().debug({ workflowRunId: run.id }, 'run_scratch.left_to_container_teardown');
    return;
  }
  if (!noExecutorCanWrite(run)) {
    getLog().debug({ workflowRunId: run.id }, 'run_scratch.kept_for_live_owner');
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
