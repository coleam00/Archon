/**
 * A node invocation's own scratch directory, `$NODE_SCRATCH_DIR`: created before the node
 * runs and released, worktree registrations first, when the invocation ends.
 */
import { lstat, mkdir } from 'node:fs/promises';
import { getNodeScratchDir } from '@archon/paths/archon-paths';
import { isWorkflowExecutionInterruption } from '../execution-interruption';
import { nodeScratchRootIsDirectory, releaseNodeScratch } from '../run-scratch';
import { runWithNodeScratch } from '../workflow-variables';
import { isLoopGroupNode, type DagNode, type LoopGroupNode } from '../schemas';
import type { PersistedNodeOutput } from '../store';
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
      // A loop_group that ends takes with it the body invocations a prior pass left
      // unfinished in iterations this pass never walked again.
      const ids = isLoopGroupNode(node) ? unfinishedBodyInvocations(ctx, node.id) : [];
      await releaseInvocations(ctx, node, [invocationId, ...ids]);
    }
  }
}

/**
 * Release the scratch an admission-settled node leaves behind. Admission dispatches
 * nothing, but on resume it can settle an invocation a prior pass suspended: skipped by
 * its condition or trigger rule (the reused `invocationId`), or replayed as the success an
 * approval recorded while the run was paused (the replayed completion's invocation).
 * A skipped `loop_group` never dispatches again, so the body invocations a prior pass left
 * suspended under it (recorded with their own ids) are released with it; suspended work
 * elsewhere in the run is not. Each is released by id, so scratch a workflow keeps
 * elsewhere under the run's scratch is never touched.
 */
export async function releaseAdmittedScratch(
  ctx: RunLayersContext,
  node: DagNode,
  invocationId: string,
  result: LayerNodeResult,
  priorCompletedNodes: ReadonlyMap<string, PersistedNodeOutput> | undefined
): Promise<void> {
  if (result.output.state === 'running') return;
  const ids = new Set([invocationId]);
  const replayed = priorCompletedNodes?.get(node.id)?.execution?.invocation.id;
  if (replayed !== undefined) ids.add(replayed);
  if (isLoopGroupNode(node)) {
    for (const id of unfinishedBodyInvocations(ctx, node.id)) ids.add(id);
  }
  await releaseInvocations(ctx, node, ids);
}

/**
 * Release the body invocations of the iteration a resumed loop_group paused in, once the
 * group moves past it without walking it again: the terminal gate the resume answered
 * (`answeredGateId`, which its approval may already have recorded complete), the terminal
 * wait it settled, and anything else that iteration left unfinished. The group's own
 * invocation is not among them; it is still running.
 */
export async function releasePausedIterationScratch(
  ctx: RunLayersContext,
  node: LoopGroupNode,
  iteration: number,
  answeredGateId: string | undefined
): Promise<void> {
  const ids = unfinishedBodyInvocations(ctx, node.id, iteration);
  await releaseInvocations(
    ctx,
    node,
    answeredGateId === undefined ? ids : [answeredGateId, ...ids]
  );
}

/** Release a node's invocation scratch outside dispatch, as a failed admission settles it. */
export async function releaseInvocationScratch(
  ctx: RunLayersContext,
  node: DagNode,
  invocationId: string
): Promise<void> {
  await releaseInvocations(ctx, node, [invocationId]);
}

async function releaseInvocations(
  ctx: RunLayersContext,
  node: DagNode,
  invocationIds: Iterable<string>
): Promise<void> {
  for (const id of new Set(invocationIds)) {
    await releaseNodeScratch({
      artifactsDir: ctx.artifactsDir,
      invocationId: id,
      repoPath: ctx.cwd,
      execContext: ctx.execContext,
      logContext: { workflowRunId: ctx.workflowRun.id, nodeId: node.id, invocationId: id },
    });
  }
}

/**
 * Invocation ids of the body invocations a prior pass left unfinished under this context's
 * invocation of loop_group `groupId` (in `iteration` only, when given): their path is
 * inside the group's, and their loop path is this context's own followed by the group.
 */
function unfinishedBodyInvocations(
  ctx: RunLayersContext,
  groupId: string,
  iteration?: number
): string[] {
  const groupPath = ctx.stepNamePrefix + groupId;
  const outer = ctx.loopGroupPath;
  const ids: string[] = [];
  for (const { path, invocation } of ctx.unfinishedInvocations?.values() ?? []) {
    const frame = invocation.loopPath[outer.length];
    if (
      path.startsWith(`${groupPath}.`) &&
      frame?.groupId === groupId &&
      (iteration === undefined || frame.iteration === iteration) &&
      outer.every(
        (f, i) =>
          invocation.loopPath[i]?.groupId === f.groupId &&
          invocation.loopPath[i]?.iteration === f.iteration
      )
    ) {
      ids.push(invocation.id);
    }
  }
  return ids;
}
