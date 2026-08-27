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
import { existsSync } from 'fs';
import { getCurrentBranchStrict, localBranchExists, toBranchName, toRepoPath } from '@archon/git';
import type { TaskBranchSelection } from '@archon/isolation';
import {
  TERMINAL_WORKFLOW_STATUSES,
  type ContinuationMode,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import * as workflowDb from '../db/workflows';
import * as isolationDb from '../db/isolation-environments';

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
      workingPath: string;
      envId?: string;
    }
  | { kind: 'checkout-branch'; taskBranch: ExistingTaskBranchSelection }
  | { kind: 'in-place' };

export interface ResolvedWorkflowAdoption {
  adoptedRun: WorkflowRun;
  lane: AdoptionLane;
}

export interface ResolveWorkflowAdoptionArgs {
  adoptedRunId: string;
  /**
   * Seam overrides for tests (and embedders with exotic filesystems): path
   * existence and git branch verification. Defaults are the real fs and git.
   */
  deps?: {
    existsSync?: (path: string) => boolean;
    branchExists?: (repoPath: string, branch: string) => Promise<boolean>;
    currentBranch?: (workingPath: string) => Promise<string | null>;
    getRun?: typeof workflowDb.getWorkflowRun;
    getActiveRunByPath?: typeof workflowDb.getActiveWorkflowRunByPath;
    findEnvironmentByPath?: typeof isolationDb.findLatestByCodebaseAndWorkingPath;
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
  const pathExists = args.deps?.existsSync ?? existsSync;
  const branchExists = args.deps?.branchExists ?? defaultBranchExists;
  const currentBranch = args.deps?.currentBranch ?? defaultCurrentBranch;
  const getRun = args.deps?.getRun ?? workflowDb.getWorkflowRun;
  const getActiveRunByPath = args.deps?.getActiveRunByPath ?? workflowDb.getActiveWorkflowRunByPath;
  const findEnvironmentByPath =
    args.deps?.findEnvironmentByPath ?? isolationDb.findLatestByCodebaseAndWorkingPath;
  const adoptedRun = await getRun(args.adoptedRunId);
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

  if (args.codebaseKind === 'folder') {
    return { adoptedRun, lane: { kind: 'in-place' } };
  }
  if (!args.codebasePath) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${adoptedRun.id}': the target project's repository path is unknown.`
    );
  }

  const environment = adoptedRun.working_path
    ? await findEnvironmentByPath(args.codebaseId, adoptedRun.working_path, adoptedRun.started_at)
    : null;

  // Lane 2: the adopted run's worktree still exists — inherit it as-is, dirty
  // state and all. A live run holding the same path refuses: two writers on one
  // checkout is a collision, not continuation.
  if (
    environment?.status === 'active' &&
    adoptedRun.working_path &&
    pathExists(adoptedRun.working_path)
  ) {
    const historicalBranch = environment.branch_name;
    if (!historicalBranch) {
      throw new WorkflowAdoptionError(
        `Cannot adopt run '${adoptedRun.id}': its surviving worktree has no recorded branch identity.`
      );
    }
    const actualBranch = await currentBranch(adoptedRun.working_path);
    if (actualBranch !== historicalBranch) {
      throw new WorkflowAdoptionError(
        `Cannot adopt run '${adoptedRun.id}': its worktree at '${adoptedRun.working_path}' ` +
          `was recorded on branch '${historicalBranch}' but is now on ` +
          `'${actualBranch ?? 'detached HEAD'}'. Restore the recorded branch or start a fresh run.`
      );
    }
    const liveHolder = await getActiveRunByPath(adoptedRun.working_path);
    if (liveHolder && liveHolder.id !== adoptedRun.id) {
      throw new WorkflowAdoptionError(
        `Cannot adopt run '${adoptedRun.id}': its worktree at '${adoptedRun.working_path}' ` +
          `is held by live run '${liveHolder.id}' (${liveHolder.status}). Let it finish first.`
      );
    }
    return {
      adoptedRun,
      lane: {
        kind: 'reuse-worktree',
        workingPath: adoptedRun.working_path,
        envId: environment.id,
      },
    };
  }

  // Lane 3: worktree gone (or its record destroyed) but the branch survives —
  // materialize the same branch again. The branch carries the PR and remains
  // the one mutable estate every node in the adopting run observes.
  const branch = environment?.branch_name;
  if (branch) {
    if (await branchExists(args.codebasePath, branch)) {
      return {
        adoptedRun,
        lane: {
          kind: 'checkout-branch',
          taskBranch: { kind: 'existing', branch: toBranchName(branch) },
        },
      };
    }
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${adoptedRun.id}': neither its worktree nor its branch '${branch}' ` +
        'still exists. There is nothing left to continue — start a fresh run.'
    );
  }

  throw new WorkflowAdoptionError(
    `Cannot adopt run '${adoptedRun.id}': it has no isolation record, so there is no ` +
      'branch or worktree to continue. Start a fresh run.'
  );
}

export const CONTINUATION_METADATA_KEY = 'continuation';

export interface ContinuationMetadata {
  mode: ContinuationMode;
}
