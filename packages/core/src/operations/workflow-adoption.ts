/**
 * Between-run continuation (#2747): resolve an operator-declared adoption of a
 * prior terminal run's estate.
 *
 * Adoption is always explicit — `workflow run <name> --adopt <run-id>` (or the
 * API's `adopt_run_id`). The engine never infers it, and it never degrades out
 * of it silently: every resolution step below fails loud with an actionable
 * message rather than falling back to a fresh start, because a silent fresh
 * start is exactly the failure this machinery exists to kill.
 *
 * Naming note: "adopt" already exists in the executor for capture staging
 * (`withCapturedSource`); these run-level names are deliberately distinct.
 */
import { sameWorktreeRegistration, type IsolationEnvironmentRow } from '@archon/isolation/types';
import { existsSync } from 'fs';
import { getCurrentBranchStrict, localBranchExists, toBranchName, toRepoPath } from '@archon/git';
import {
  recordWorktreeAdoption,
  type IIsolationStore,
  type TaskBranchSelection,
} from '@archon/isolation';
import {
  TERMINAL_WORKFLOW_STATUSES,
  type ContinuationMode,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { IWorkflowHostStore } from '../workflows/host-store';

/** Refusal reasons carry the operator's next action, not just the failure. */
export class WorkflowAdoptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowAdoptionError';
  }
}

/**
 * The lane the adopting run executes in. `in-place` is folder projects only:
 * they run in place anyway, so adoption there is provenance plus artifacts-by-
 * reference with nothing to inherit. Container-backend runs are refused in v1 —
 * their write-back lifecycle is separate machinery.
 */
export type ExistingTaskBranchSelection = Extract<TaskBranchSelection, { kind: 'existing' }>;

export type AdoptionLane =
  | {
      kind: 'reuse-worktree';
      environment: IsolationEnvironmentRow;
    }
  | { kind: 'checkout-branch'; taskBranch: ExistingTaskBranchSelection }
  | { kind: 'in-place' };

export async function resolveRegisteredWorktree(
  store: Pick<IIsolationStore, 'getById'>,
  lane: Extract<AdoptionLane, { kind: 'reuse-worktree' }>
) {
  const env = await store.getById(lane.environment.id);
  if (!env) throw new Error(`Isolation environment ${lane.environment.id} not found`);
  if (env.working_path !== lane.environment.working_path) {
    throw new WorkflowAdoptionError(
      `Cannot adopt: worktree path '${lane.environment.working_path}' does not match isolation environment ${env.id} at '${env.working_path}'.`
    );
  }
  if (env.status !== 'active' || !sameWorktreeRegistration(env, lane.environment)) {
    throw new WorkflowAdoptionError(
      `Worktree ${env.id} changed during adoption; inspect it and retry`
    );
  }
  const actualBranch = await getCurrentBranchStrict(toRepoPath(env.working_path));
  if (!lane.environment.branch_name || actualBranch !== lane.environment.branch_name) {
    throw new WorkflowAdoptionError(
      `Cannot adopt worktree at '${env.working_path}': expected branch ` +
        `'${lane.environment.branch_name}' but is now on '${actualBranch ?? 'detached HEAD'}'. ` +
        'Restore the recorded branch or start a fresh run.'
    );
  }
  return env;
}

export async function adoptRegisteredWorktree(
  store: Pick<IIsolationStore, 'getById' | 'updateMetadata'>,
  lane: Extract<AdoptionLane, { kind: 'reuse-worktree' }>,
  repoPath: string
) {
  const env = await resolveRegisteredWorktree(store, lane);
  return recordWorktreeAdoption(store, env, repoPath);
}

export interface ResolvedWorkflowAdoption {
  adoptedRun: WorkflowRun;
  lane: AdoptionLane;
}

export interface ResolveWorkflowAdoptionArgs {
  adoptedRunId: string;
  deps: {
    existsSync?: (path: string) => boolean;
    branchExists?: (repoPath: string, branch: string) => Promise<boolean>;
    currentBranch?: (workingPath: string) => Promise<string | null>;
    getRun: IWorkflowStore['getWorkflowRun'];
    getActiveRunByPath: IWorkflowStore['getActiveWorkflowRunByPath'];
    findEnvironmentByPath: IWorkflowHostStore['isolation']['findLatestByCodebaseAndWorkingPath'];
  };
  /** Codebase of the NEW run; cross-workflow is fine, cross-codebase is not. */
  codebaseId: string | null | undefined;
  /** Canonical repo path git checks run against (repo-kind projects only). */
  codebasePath?: string;
  codebaseKind?: 'repo' | 'folder' | null;
  /** A container-backend run cannot adopt in v1. */
  containerRequested?: boolean;
}

async function defaultBranchExists(repoPath: string, branch: string): Promise<boolean> {
  return localBranchExists(toRepoPath(repoPath), toBranchName(branch));
}

async function defaultCurrentBranch(workingPath: string): Promise<string | null> {
  return getCurrentBranchStrict(toRepoPath(workingPath));
}

/**
 * Resolve the adoption fail-loud, in order:
 *  1. The adopted run must exist, be terminal, and share the new run's codebase.
 *     A live run refuses with a respond/resume/abandon pointer — adoption never
 *     takes a running run's lane.
 *  2. Its worktree still recorded AND on disk → reuse that path dirty-as-is,
 *     unless another LIVE run holds the same path (the terminal row no longer
 *     holds the lock; whoever does wins).
 *  3. Else its branch still exists → check out that exact branch in a worktree.
 *  4. Else refuse, naming what is missing.
 */
export async function resolveWorkflowAdoption(
  args: ResolveWorkflowAdoptionArgs
): Promise<ResolvedWorkflowAdoption> {
  const { adoptedRun, codebaseId } = await loadAdoptableRun(args);
  if (args.codebaseKind === 'folder') {
    return { adoptedRun, lane: { kind: 'in-place' } };
  }
  if (!args.codebasePath) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${adoptedRun.id}': the target project's repository path is unknown.`
    );
  }

  const workingPath = adoptedRun.working_path;
  const environment = workingPath
    ? await args.deps.findEnvironmentByPath(
        codebaseId,
        workingPath,
        adoptedRun.completed_at ?? adoptedRun.started_at
      )
    : null;
  const pathExists = args.deps.existsSync ?? existsSync;
  if (environment?.status === 'active' && workingPath && pathExists(workingPath)) {
    return {
      adoptedRun,
      lane: await reuseWorktreeLane(args, adoptedRun.id, workingPath, environment),
    };
  }
  return {
    adoptedRun,
    lane: await checkoutBranchLane(args, args.codebasePath, adoptedRun.id, environment),
  };
}

/** Step 1: the adopted run exists, is terminal, and shares the new run's codebase. */
async function loadAdoptableRun(
  args: ResolveWorkflowAdoptionArgs
): Promise<{ adoptedRun: WorkflowRun; codebaseId: string }> {
  const adoptedRun = await args.deps.getRun(args.adoptedRunId);
  if (!adoptedRun) {
    throw new WorkflowAdoptionError(
      `Cannot adopt: no workflow run '${args.adoptedRunId}' exists. Check the id with \`workflow runs\`.`
    );
  }
  if (!TERMINAL_WORKFLOW_STATUSES.includes(adoptedRun.status)) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${adoptedRun.id}': it is still ${adoptedRun.status}. ` +
        "Respond to or resume it, or abandon it first — adoption never takes a live run's lane."
    );
  }
  if (!args.codebaseId || !adoptedRun.codebase_id || adoptedRun.codebase_id !== args.codebaseId) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${adoptedRun.id}': it belongs to a different project. ` +
        'Adoption is validated by codebase identity, never by workflow name.'
    );
  }
  if (args.containerRequested) {
    throw new WorkflowAdoptionError(
      "Container-backend runs cannot adopt a prior run's estate yet. " +
        'Drop --container/--adopt or start a plain worktree run.'
    );
  }
  return { adoptedRun, codebaseId: args.codebaseId };
}

/**
 * Lane 2: the adopted run's worktree still exists — inherit it as-is, dirty
 * state and all. A live run holding the same path refuses: two writers on one
 * checkout is a collision, not continuation.
 */
async function reuseWorktreeLane(
  args: ResolveWorkflowAdoptionArgs,
  adoptedRunId: string,
  workingPath: string,
  environment: IsolationEnvironmentRow
): Promise<AdoptionLane> {
  const historicalBranch = environment.branch_name;
  if (!historicalBranch) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${adoptedRunId}': its surviving worktree has no recorded branch identity.`
    );
  }
  const currentBranch = args.deps.currentBranch ?? defaultCurrentBranch;
  const actualBranch = await currentBranch(workingPath);
  if (actualBranch !== historicalBranch) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${adoptedRunId}': its worktree at '${workingPath}' ` +
        `was recorded on branch '${historicalBranch}' but is now on ` +
        `'${actualBranch ?? 'detached HEAD'}'. Restore the recorded branch or start a fresh run.`
    );
  }
  const liveHolder = await args.deps.getActiveRunByPath(workingPath);
  if (liveHolder && liveHolder.id !== adoptedRunId) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${adoptedRunId}': its worktree at '${workingPath}' ` +
        `is held by live run '${liveHolder.id}' (${liveHolder.status}). Let it finish first.`
    );
  }
  return { kind: 'reuse-worktree', environment };
}

/**
 * Lane 3: worktree gone (or its record destroyed) but the branch survives —
 * materialize the same branch again. The branch carries the PR and remains
 * the one mutable estate every node in the adopting run observes.
 */
async function checkoutBranchLane(
  args: ResolveWorkflowAdoptionArgs,
  codebasePath: string,
  adoptedRunId: string,
  environment: IsolationEnvironmentRow | null
): Promise<AdoptionLane> {
  const branch = environment?.branch_name;
  if (!branch) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${adoptedRunId}': it has no isolation record, so there is no ` +
        'branch or worktree to continue. Start a fresh run.'
    );
  }
  const branchExists = args.deps.branchExists ?? defaultBranchExists;
  if (!(await branchExists(codebasePath, branch))) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${adoptedRunId}': neither its worktree nor its branch '${branch}' ` +
        'still exists. There is nothing left to continue — start a fresh run.'
    );
  }
  return {
    kind: 'checkout-branch',
    taskBranch: { kind: 'existing', branch: toBranchName(branch) },
  };
}

export const CONTINUATION_METADATA_KEY = 'continuation';

export interface ContinuationMetadata {
  mode: ContinuationMode;
}
