/**
 * Where an admitted resource start works: in place, in a worktree of its own (cut fresh, or
 * on an explicit branch's reusable checkout), or in the checkout another run handed it
 * (`checkout_handoff`). Preparation picks the lane and admission keys it; this lays it out
 * when the run starts.
 */
import { execFileAsync, toBranchName, toRepoPath, type BranchName } from '@archon/git';
import {
  getIsolationProvider,
  recordWorktreeAdoption,
  type WorktreeSetupExecutor,
} from '@archon/isolation';
import {
  readAsksCheckout,
  readCheckoutHandoff,
  readResourceStartReceiptId,
  startCause,
  type CheckoutHandoff,
  type CheckoutHandoffRunMetadata,
  type PreparedWorkflowLaunch,
} from '@archon/workflows/schemas/resource-start';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { OwnedWorktree, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { adoptRegisteredWorktree, resolveWorkflowAdoption } from '../operations/workflow-adoption';
import { ensureIsolationConfigured } from '../orchestrator/dispatch/isolation-resolver';
import type { Codebase } from '../schemas/codebase';
import { askingWorktreeGone } from './asks-settled';
import type { WorkflowHost } from './host-store';
import { createRegisteredWorktree, type RegisteredWorktreeInput } from './registered-worktree';

/**
 * The lane of a start on another run's checkout. A stage that mutates its checkout
 * continues on the hand-off's branch, so admission keys it by that branch and two never
 * work in it at once. A read-only stage gets its own checkout on a generated branch cut at
 * the hand-off's commit, so checks run beside each other and cannot move the branch.
 */
export function handoffIsolation(
  handoff: CheckoutHandoff,
  workflow: ResolvedWorkflow,
  codebase: Codebase
): {
  isolation: PreparedWorkflowLaunch['execution']['isolation'];
  lane: CheckoutHandoffRunMetadata['lane'];
} {
  if (codebase.kind === 'folder')
    throw new Error(
      `Folder project '${codebase.name}' has no branch to continue run '${handoff.runId}''s checkout.`
    );
  if (workflow.worktree?.enabled === false)
    throw new Error(
      `Workflow '${workflow.name}' runs in place, so it cannot take run '${handoff.runId}''s checkout.`
    );
  return workflow.mutates_checkout === false
    ? { isolation: { kind: 'worktree', fromBranch: handoff.commit }, lane: 'copy' }
    : { isolation: { kind: 'worktree', branch: handoff.branch }, lane: 'continue' };
}

type WorktreeLaneSpec = Extract<
  PreparedWorkflowLaunch['execution']['isolation'],
  { kind: 'worktree' }
>;

interface WorktreeLane {
  cwd: string;
  envId: string;
  cutFromCommit?: string;
  ownedWorktree?: OwnedWorktree;
}

/** An explicit branch names one reusable checkout, so repeated starts share it. */
async function adoptBranchWorktree(
  host: WorkflowHost,
  lane: WorktreeLaneSpec,
  codebase: Codebase
): Promise<WorktreeLane | undefined> {
  if (!lane.branch) return undefined;
  const existing = await host.records.isolation.findActiveByWorkflow(
    codebase.id,
    'task',
    lane.branch
  );
  if (!existing || !(await getIsolationProvider().healthCheck(existing.working_path)))
    return undefined;
  await recordWorktreeAdoption(host.records.isolation, existing, codebase.default_cwd);
  return { cwd: existing.working_path, envId: existing.id };
}

/** The base commit a run's definitions were captured at; see `TaskIsolationRequest.startCommit`. */
type StartCommit = { commit: string; branch: BranchName };

function worktreeLaneRequest(
  lane: WorktreeLaneSpec,
  codebase: Codebase,
  identifier: string,
  startCommit: StartCommit | undefined
): RegisteredWorktreeInput['request'] {
  const fromBranch = lane.fromBranch ? toBranchName(lane.fromBranch) : undefined;
  const defaultBranch = codebase.default_branch?.trim();
  return {
    workflowType: 'task',
    identifier: lane.branch ?? identifier,
    taskBranch:
      lane.branch || fromBranch
        ? {
            kind: 'new',
            ...(lane.branch ? { branch: toBranchName(lane.branch) } : {}),
            ...(fromBranch ? { fromBranch } : {}),
          }
        : undefined,
    baseBranch: defaultBranch ? toBranchName(defaultBranch) : undefined,
    baseOverride: lane.baseOverride ? toBranchName(lane.baseOverride) : undefined,
    ...(startCommit ? { startCommit } : {}),
    codebaseId: codebase.id,
    codebaseName: codebase.name,
    canonicalRepoPath: toRepoPath(codebase.default_cwd),
    description: `Resource start: ${identifier}`,
  };
}

async function worktreeLane(
  host: WorkflowHost,
  lane: WorktreeLaneSpec,
  codebase: Codebase,
  identifier: string,
  platformType: string,
  userId: string | undefined,
  setupExecutor: WorktreeSetupExecutor,
  startCommit: StartCommit | undefined
): Promise<WorktreeLane> {
  ensureIsolationConfigured();
  const adopted = await adoptBranchWorktree(host, lane, codebase);
  if (adopted) return adopted;
  const created = await createRegisteredWorktree(host.records.isolation, {
    request: worktreeLaneRequest(lane, codebase, identifier, startCommit),
    setupExecutor,
    createdByPlatform: platformType,
    ...(userId ? { createdByUserId: userId } : {}),
  });
  return {
    cwd: created.env.workingPath,
    envId: created.envId,
    ...(created.ownedWorktree ? { ownedWorktree: created.ownedWorktree } : {}),
    ...(created.cutFromCommit !== undefined ? { cutFromCommit: created.cutFromCommit } : {}),
  };
}

/**
 * Refuse a hand-off whose branch is gone or moved off the commit the source run ended on.
 * Both lanes check it: a `copy` would otherwise start on a commit its branch has left.
 */
async function assertBranchAtHandoff(codebase: Codebase, handoff: CheckoutHandoff): Promise<void> {
  // Every worktree of a repository shares its branch refs, so the tip read in the
  // repository is the one a reused worktree has checked out.
  let tip: string;
  try {
    tip = (
      await execFileAsync(
        'git',
        [
          '-C',
          codebase.default_cwd,
          'rev-parse',
          '--verify',
          `refs/heads/${handoff.branch}^{commit}`,
        ],
        { timeout: 10000 }
      )
    ).stdout.trim();
  } catch (error) {
    throw new Error(
      `Branch '${handoff.branch}' that run '${handoff.runId}' handed on could not be read: ${(error as Error).message}; its hand-off is refused.`,
      { cause: error }
    );
  }
  if (tip !== handoff.commit)
    throw new Error(
      `Branch '${handoff.branch}' is at ${tip.slice(0, 12)} but run '${handoff.runId}' ended at ${handoff.commit.slice(0, 12)}; its hand-off is refused.`
    );
}

/**
 * Lay out a `continue` hand-off: the worktree the source run left, or its branch checked
 * out again when that worktree is gone. Refused when the branch is gone or has moved off
 * the commit the source run ended on, so a start never runs on work it was not handed and
 * never falls back to the base branch. The branch is not this run's generated one, so its
 * end never removes the checkout; `archon isolation cleanup` does, as for `--adopt`.
 */
async function continueLane(
  host: WorkflowHost,
  handoff: CheckoutHandoff,
  codebase: Codebase,
  platformType: string,
  userId: string | undefined,
  setupExecutor: WorktreeSetupExecutor
): Promise<WorktreeLane> {
  ensureIsolationConfigured();
  const { lane } = await resolveWorkflowAdoption({
    adoptedRunId: handoff.runId,
    deps: {
      getRun: id => host.deps.store.getWorkflowRun(id),
      getActiveRunByPath: (...args) => host.deps.store.getActiveWorkflowRunByPath(...args),
      findEnvironmentByPath: (...args) =>
        host.records.isolation.findLatestByCodebaseAndWorkingPath(...args),
    },
    codebaseId: codebase.id,
    codebasePath: codebase.default_cwd,
    codebaseKind: codebase.kind,
  });
  if (lane.kind === 'in-place')
    throw new Error(`Run '${handoff.runId}' ran in place, so it left no checkout to continue.`);
  // A newer environment at the same path can be on another branch.
  const branch =
    lane.kind === 'reuse-worktree' ? lane.environment.branch_name : lane.taskBranch.branch;
  if (branch !== handoff.branch)
    throw new Error(
      `Run '${handoff.runId}' handed on branch '${handoff.branch}', but its checkout is now on '${branch ?? 'no branch'}'; its hand-off is refused.`
    );
  await assertBranchAtHandoff(codebase, handoff);
  if (lane.kind === 'reuse-worktree') {
    const env = await adoptRegisteredWorktree(host.records.isolation, lane, codebase.default_cwd);
    return { cwd: env.working_path, envId: env.id };
  }
  const created = await createRegisteredWorktree(host.records.isolation, {
    request: {
      workflowType: 'task',
      identifier: handoff.branch,
      taskBranch: lane.taskBranch,
      codebaseId: codebase.id,
      codebaseName: codebase.name,
      canonicalRepoPath: toRepoPath(codebase.default_cwd),
      description: `Resource start: continue run ${handoff.runId}`,
    },
    setupExecutor,
    createdByPlatform: platformType,
    ...(userId ? { createdByUserId: userId } : {}),
  });
  return {
    cwd: created.env.workingPath,
    envId: created.envId,
    ...(created.ownedWorktree ? { ownedWorktree: created.ownedWorktree } : {}),
  };
}

/**
 * A start its asks' answers caused takes the asking run's checkout only while the worktree
 * that holds it is still there: settling checked it, and a start that runs later checks it
 * again, so neither lane recreates it from the branch. Other hand-offs may recreate it.
 */
async function assertAskingWorktree(
  host: WorkflowHost,
  run: Pick<WorkflowRun, 'metadata'>
): Promise<void> {
  const receiptId = readResourceStartReceiptId(run.metadata);
  const receipt = receiptId ? await host.deps.store.getStartReceipt(receiptId) : null;
  const cause = receipt ? startCause(receipt) : null;
  if (cause?.kind !== 'asks_settled') return;
  const asking = await host.deps.store.getWorkflowRun(cause.runId);
  const recorded = asking ? readAsksCheckout(asking) : undefined;
  const gone =
    recorded === undefined || !('handoff' in recorded)
      ? `run '${cause.runId}', which left the asks, no longer records the checkout it handed on`
      : askingWorktreeGone(cause.runId, recorded);
  if (gone !== undefined)
    throw new Error(
      `${gone}; its hand-off is refused. Run '${asking?.workflow_name ?? 'the asking workflow'}' again on the item.`
    );
}

export interface ExecutionLane {
  cwd: string;
  /** Absent for an in-place run. */
  envId?: string;
  cutFromCommit?: string;
  ownedWorktree?: OwnedWorktree;
}

/** Lay out the lane an admitted run was prepared with. */
export async function executionLane(
  host: WorkflowHost,
  input: {
    run: Pick<WorkflowRun, 'id' | 'workflow_name' | 'user_id' | 'metadata'>;
    lane: PreparedWorkflowLaunch['execution']['isolation'];
    /** Cut a fresh worktree here; a hand-off lane ignores it. */
    startCommit?: StartCommit;
    codebase: Codebase;
    /** The prepared cwd, where an in-place run works. */
    cwd: string;
    platformType: string;
    setupExecutor: WorktreeSetupExecutor;
  }
): Promise<ExecutionLane> {
  const { run, lane, codebase, platformType, setupExecutor } = input;
  const userId = run.user_id ?? undefined;
  const handoff = readCheckoutHandoff(run);
  if (handoff) await assertAskingWorktree(host, run);
  if (handoff?.lane === 'continue')
    return continueLane(host, handoff, codebase, platformType, userId, setupExecutor);
  if (handoff?.lane === 'copy') await assertBranchAtHandoff(codebase, handoff);
  if (lane.kind === 'in-place') return { cwd: input.cwd };
  return worktreeLane(
    host,
    lane,
    codebase,
    `${run.workflow_name}-${run.id.slice(0, 8)}`,
    platformType,
    userId,
    setupExecutor,
    handoff ? undefined : input.startCommit
  );
}
