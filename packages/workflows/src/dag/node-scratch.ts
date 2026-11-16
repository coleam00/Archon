/**
 * A node invocation's own scratch directory, `$NODE_SCRATCH_DIR`: created before the node
 * runs and released, worktree registrations first, when the invocation ends.
 */
import { lstat, mkdir } from 'node:fs/promises';
import { getNodeScratchDir } from '@archon/paths/archon-paths';
import { isWorkflowExecutionInterruption } from '../execution-interruption';
import { nodeScratchRootIsDirectory, releaseNodeScratch } from '../run-scratch';
import { runWithNodeScratch } from '../workflow-variables';
import type { DagNode } from '../schemas';
import type { LayerNodeResult, RunLayersContext } from './run-context';

/**
 * Run `dispatch` with `invocationId`'s scratch directory created and in scope, then
 * release it unless the invocation can continue. Release is awaited, so the disk is free
 * before a dependent or the next `loop_group` iteration starts. A failure to create the
 * directory, or a directory reached through a link, rejects, so the caller fails the node
 * rather than hand it a missing path or one outside the run.
 */
export async function runInNodeScratch(
  ctx: RunLayersContext,
  node: DagNode,
  invocationId: string,
  dispatch: () => Promise<LayerNodeResult>
): Promise<LayerNodeResult> {
  const dir = getNodeScratchDir(ctx.artifactsDir, invocationId);
  let keep = false;
  try {
    await mkdir(dir, { recursive: true });
    const logContext = { workflowRunId: ctx.workflowRun.id, nodeId: node.id, invocationId };
    if (
      !(await nodeScratchRootIsDirectory(ctx.artifactsDir, logContext)) ||
      !(await lstat(dir)).isDirectory()
    ) {
      throw new Error(
        `Node scratch ${dir} is not inside the run's artifacts directory: a directory on its path is a link.`
      );
    }
    const result = await runWithNodeScratch(dir, dispatch);
    // A suspended invocation (a gate, a wait, a paused loop_group) resumes with the same
    // invocation id, so it finds its scratch where it left it.
    keep = result.output.state === 'running';
    return result;
  } catch (error) {
    // An interrupted run is stopping under this node, which may still be writing;
    // run-end release removes its scratch once nothing can.
    keep = isWorkflowExecutionInterruption(error);
    throw error;
  } finally {
    if (!keep) {
      await releaseNodeScratch({
        artifactsDir: ctx.artifactsDir,
        invocationId,
        repoPath: ctx.cwd,
        container: ctx.execContext.kind === 'container',
        logContext: { workflowRunId: ctx.workflowRun.id, nodeId: node.id, invocationId },
      });
    }
  }
}
