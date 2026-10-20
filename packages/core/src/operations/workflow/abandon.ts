import { hostname } from 'node:os';
import { readExecutionOwner, readOwnedWorktree } from '@archon/workflows/schemas/workflow-run';
import type { ExecutionOwnerRecord, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { ReleasedWorktree, RunWorktreeRelease } from '../../services/cleanup-service';
import type { RunActor } from '../run-authorization';
import { getLog, type OperationContext } from './context';
import {
  cancelRunAndCleanup,
  findParentBlockedOn,
  MAX_CASCADE_RUNS,
  reclaimCancelledRunContainer,
  stopLiveOwner,
  type AbandonAttemptResult,
  type AbandonOwnerOutcome,
  type AbandonWorkflowResult,
} from './teardown';

/**
 * A live owner answered, but abandon could not stop it. The run is unchanged.
 * Surfaces show the message as is; it states the reason and what the operator can do.
 */
export class AbandonOwnerNotStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbandonOwnerNotStoppedError';
  }
}

/** Report each removed worktree with the branch that keeps its committed work. */
export function describeReleasedWorktrees(released: readonly ReleasedWorktree[] = []): string[] {
  return released.map(
    worktree =>
      `Removed worktree ${worktree.path} with any uncommitted changes; branch ${worktree.branch} is kept.`
  );
}

export class AbandonRefusedError extends Error {}

export function assertAbandonable(run: WorkflowRun): void {
  if (
    run.status === 'completed' ||
    (run.status === 'cancelled' && !readOwnedWorktree(run.metadata))
  ) {
    throw new AbandonRefusedError(
      `Cannot abandon run with status '${run.status}'. Only running, paused, or failed runs can be abandoned.`
    );
  }
}

export interface AbandonConversationRunsResult {
  /** Runs this call actually took to 'cancelled'. */
  abandoned: number;
  cleanupWarnings?: string[];
  releasedWorktrees?: ReleasedWorktree[];
  /**
   * First cancelled run that left a parent outside the conversation-scoped
   * mutation paused blocked-on-child (stranded parent id), or null. The user
   * must resume or abandon that parent to unstick the tree.
   */
  blockedParentRunId: string | null;
}

/**
 * Abandon a workflow run (marks it as cancelled).
 *
 * Running, paused, AND failed runs can be abandoned. A `failed` run is terminal
 * per TERMINAL_WORKFLOW_STATUSES but remains resumable, so the user must be able
 * to discard it — hence the inline check here intentionally diverges from that
 * constant. Cancelled runs with creation proof allow a cleanup-only retry.
 *
 * `cancelled` releases the run's worktree lock and resource slot, so a live owner is
 * stopped first. When no owner answers, the result carries the recorded owner facts;
 * no timer, age, or PID decides that the run is dead.
 */
export async function abandonWorkflow(
  ctx: OperationContext,
  runId: string,
  actor: RunActor
): Promise<AbandonWorkflowResult & { owner: AbandonOwnerOutcome }> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_abandon_lookup_failed');
  await ctx.assertMayAct(run, actor, 'abandon');
  assertAbandonable(run);
  const owner = await stopLiveOwner(ctx, run);
  if (owner.kind === 'not_stopped') throw new AbandonOwnerNotStoppedError(owner.message);
  const result = await recordAbandonment(
    ctx,
    run,
    owner.kind === 'stopped' ? owner.cleanupWarnings : undefined
  );
  const { warnings, releasedWorktrees } = await releaseAbandonedWorktrees(ctx, run, result, owner);
  return {
    run,
    cancelled: result.cancelled,
    cascadeFailures: result.cascadeFailures,
    blockedParentRunId: result.blockedParentRunId,
    owner,
    ...(warnings.length ? { cleanupWarnings: warnings } : {}),
    ...(releasedWorktrees.length ? { releasedWorktrees } : {}),
  };
}

async function recordAbandonment(
  ctx: OperationContext,
  run: WorkflowRun,
  stopWarnings: string[] = []
): Promise<AbandonAttemptResult> {
  // A cancelled run reaches here only with creation proof: the retry finishes a
  // worktree release that an earlier abandonment reported as failed.
  if (run.status === 'cancelled') {
    const tree = await collectAbandonmentTree(ctx, run);
    return {
      run,
      cancelled: false,
      cleanupWarnings: stopWarnings,
      cancelledRuns: tree.runs.filter(row => row.id !== run.id && row.status === 'cancelled'),
      cascadeFailures: tree.failures,
      blockedParentRunId: null,
    };
  }
  const result = await cancelRunAndCleanup(ctx, run, stopWarnings);
  if (!result.cancelled)
    throw new AbandonRefusedError(
      `Run ${run.id} changed before abandonment; no worktree was released. Inspect its current status.`
    );
  return result;
}

/**
 * Release the worktrees of the abandoned tree, deepest descendants first and the root
 * last. The root's checkout is retained while any descendant is unaccounted for.
 */
async function releaseAbandonedWorktrees(
  ctx: OperationContext,
  run: WorkflowRun,
  result: AbandonAttemptResult,
  owner: AbandonOwnerOutcome
): Promise<{ warnings: string[]; releasedWorktrees: ReleasedWorktree[] }> {
  const warnings = [...(result.cleanupWarnings ?? [])];
  const releasedWorktrees: ReleasedWorktree[] = [];
  const released = new Set<string>();
  let unsafeDescendant = false;
  for (const row of [...result.cancelledRuns].reverse().concat(run)) {
    const proof = readOwnedWorktree(row.metadata);
    if (proof && released.has(proof.envId)) continue;
    if (row.id === run.id && (result.cascadeFailures || unsafeDescendant)) {
      warnings.push(
        `Retained checkout for run ${run.id}: descendants could not all be accounted for. Abandoning this run again only retries worktree removal and does not cancel descendants; abandon or stop each remaining descendant first.`
      );
      continue;
    }
    const ownerCheck = await checkWorktreeOwner(ctx, row, run, owner);
    warnings.push(...ownerCheck.warnings);
    if (!ownerCheck.safe) {
      unsafeDescendant = true;
      continue;
    }
    const release = await releaseRunWorktree(ctx, row);
    warnings.push(...release.warnings);
    if (release.released) releasedWorktrees.push(release.released);
    if (proof) released.add(proof.envId);
  }
  return { warnings, releasedWorktrees };
}

export async function collectAbandonmentTree(
  ctx: OperationContext,
  root: WorkflowRun
): Promise<{ runs: WorkflowRun[]; failures: number }> {
  const runs = [root];
  const seen = new Set([root.id]);
  let failures = 0;
  for (let i = 0; i < runs.length && i < MAX_CASCADE_RUNS; i++) {
    try {
      for (const child of await ctx.store.findChildRuns(runs[i].id)) {
        if (!seen.has(child.id)) {
          seen.add(child.id);
          runs.push(child);
        }
      }
    } catch (err) {
      getLog().warn({ err, runId: runs[i].id }, 'operations.workflow_abandon_retry_tree_failed');
      failures++;
    }
  }
  if (runs.length > MAX_CASCADE_RUNS) failures += runs.length - MAX_CASCADE_RUNS;
  return { runs: runs.slice(0, MAX_CASCADE_RUNS), failures };
}

async function checkWorktreeOwner(
  ctx: OperationContext,
  row: WorkflowRun,
  root?: WorkflowRun,
  rootOutcome?: AbandonOwnerOutcome
): Promise<{ safe: boolean; warnings: string[] }> {
  if (!readOwnedWorktree(row.metadata) && !(root && readOwnedWorktree(root.metadata)))
    return { safe: true, warnings: [] };
  const recorded = readExecutionOwner(row.metadata);
  const reason = unreachableOwnerReason(row, recorded, root, rootOutcome);
  if (reason)
    return {
      safe: false,
      warnings: [
        `Retained checkout ${row.working_path ?? ''} for run ${row.id}: ${reason}; stop that owner and retry abandonment from its host and user.`,
      ],
    };
  if (root?.id === row.id)
    return {
      safe: !(rootOutcome?.kind === 'stopped' && rootOutcome.cleanupWarnings?.length),
      warnings: [],
    };
  let outcome: Awaited<ReturnType<typeof stopLiveOwner>>;
  try {
    outcome =
      ranInStoppedRootOwner(recorded, root, rootOutcome) && rootOutcome
        ? rootOutcome
        : await stopLiveOwner(ctx, row);
  } catch (err) {
    getLog().warn({ err, runId: row.id }, 'operations.workflow_abandon_child_owner_check_failed');
    return {
      safe: false,
      warnings: [
        `Retained checkout ${row.working_path ?? ''} for run ${row.id}: could not check or stop its owner: ${(err as Error).message}. Inspect the owner before retrying abandonment.`,
      ],
    };
  }
  if (outcome.kind === 'not_stopped')
    return { safe: false, warnings: [`Retained checkout for run ${row.id}: ${outcome.message}`] };
  const warnings = outcome.kind === 'stopped' ? (outcome.cleanupWarnings ?? []) : [];
  if (warnings.length)
    await ctx.store.persistWorkflowEvent({
      workflow_run_id: row.id,
      event_type: 'workflow_cleanup_warning',
      data: { warnings },
    });
  return { safe: warnings.length === 0, warnings };
}

/** Why abandon cannot account for `row`'s execution owner from here, or undefined when it can. */
function unreachableOwnerReason(
  row: WorkflowRun,
  recorded: ExecutionOwnerRecord | undefined,
  root: WorkflowRun | undefined,
  rootOutcome: AbandonOwnerOutcome | undefined
): string | undefined {
  if (!recorded)
    return root?.id === row.id && rootOutcome?.kind === 'stopped'
      ? undefined
      : 'execution owner is unaccounted for';
  if (recorded.host !== hostname()) return `execution owner belongs to host ${recorded.host}`;
  return process.getuid && recorded.uid !== process.getuid()
    ? `execution owner belongs to uid ${String(recorded.uid)}`
    : undefined;
}

/** A descendant recorded under the root's owner process, which abandon already stopped. */
function ranInStoppedRootOwner(
  recorded: ExecutionOwnerRecord | undefined,
  root: WorkflowRun | undefined,
  rootOutcome: AbandonOwnerOutcome | undefined
): boolean {
  const rootOwner = root ? readExecutionOwner(root.metadata) : undefined;
  return (
    rootOwner !== undefined &&
    recorded !== undefined &&
    rootOutcome?.kind === 'stopped' &&
    recorded.host === rootOwner.host &&
    recorded.pid === rootOwner.pid &&
    recorded.uid === rootOwner.uid
  );
}

export async function releaseRunWorktree(
  ctx: OperationContext,
  row: WorkflowRun
): Promise<RunWorktreeRelease> {
  try {
    return await ctx.reclaimRunWorktree(row, ctx.hostStore.isolation);
  } catch (err) {
    getLog().warn({ err, runId: row.id }, 'operations.workflow_abandon_worktree_reclaim_failed');
    return { warnings: [`${(err as Error).message} The run remains cancelled.`] };
  }
}

/**
 * Abandon every RESUMABLE run belonging to a conversation.
 *
 * Backs `/reset`: with these gone, the resume lookups find nothing, so the next
 * message starts fresh instead of continuing a stale run.
 *
 * The DB owns selection and cancellation in one transaction. This matters when
 * selected paused roots overlap through an unselected running intermediate:
 * traversing each tree independently can visit the same descendant twice and
 * retain a transient first failure after the second visit succeeds. The bulk
 * mutation returns exactly the rows it cancelled, so counts and final parent
 * diagnostics come from one operation-wide outcome. Explicit `/workflow
 * abandon` keeps its broader running/paused/failed cascading policy.
 */
export async function abandonResumableRunsForConversation(
  ctx: OperationContext,
  conversationId: string,
  actor: RunActor
): Promise<AbandonConversationRunsResult> {
  const role = actor.kind === 'user' ? await ctx.getUserRole(actor.userId) : undefined;
  const runs = await ctx.store.cancelResumableRunsForConversation(conversationId, runs => {
    for (const run of runs) ctx.assertAuthorized(run, actor, 'abandon', role);
  });
  let blockedParentRunId: string | null = null;
  const cleanupWarnings: string[] = [];
  const releasedWorktrees: ReleasedWorktree[] = [];
  for (const run of runs) {
    cleanupWarnings.push(...(await reclaimCancelledRunContainer(ctx, run)));
    const ownerCheck = await checkWorktreeOwner(ctx, run);
    cleanupWarnings.push(...ownerCheck.warnings);
    if (ownerCheck.safe) {
      const release = await releaseRunWorktree(ctx, run);
      cleanupWarnings.push(...release.warnings);
      if (release.released) releasedWorktrees.push(release.released);
    }
    const blocked = await findParentBlockedOn(ctx, run);
    if (blockedParentRunId === null) blockedParentRunId = blocked;
  }
  if (runs.length > 0) {
    getLog().info(
      { conversationId, abandoned: runs.length, blockedParentRunId },
      'operations.workflow_abandon_for_conversation_completed'
    );
  }
  return {
    abandoned: runs.length,
    blockedParentRunId,
    ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
    ...(releasedWorktrees.length > 0 ? { releasedWorktrees } : {}),
  };
}
