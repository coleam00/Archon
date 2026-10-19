import * as sqlIsolation from '@archon/core/db/isolation-environments';
import * as sqlWorkflow from '@archon/core/db/workflows';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import { isWorkflowWaitContext } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import * as workflowDb from '../../db/workflows';
import { RunActionForbiddenError } from '../../operations/run-authorization';
import { resolveWorkflowAdoption, WorkflowAdoptionError } from '../../operations/workflow-adoption';
import type { WorkflowRequest } from '../../types';
import { resolveRunWorkflow } from '../../workflows/resolve-run-workflow';
import { createSqlWorkflowOperations } from '../../workflows/sql-host';
import { createWorkflowDeps } from '../../workflows/store-adapter';
import { getLog } from '../agent-log';
import type { DispatchAdoption, DispatchScope } from './scope';

/** The workflow the request names; `undefined` after telling the user it cannot run. */
export async function resolveRequestedWorkflow(
  scope: DispatchScope,
  request: WorkflowRequest
): Promise<ResolvedWorkflow | undefined> {
  const { platform, conversationId, runCwd } = scope;
  if (request.kind === 'resume') {
    if (!request.run.working_path) {
      getLog().warn({ runId: request.run.id }, 'orchestrator.resume_missing_working_path');
      await platform.sendMessage(
        conversationId,
        `Cannot resume ${request.run.id}: missing working path.`
      );
      return undefined;
    }
    const resolved = await resolveRunWorkflow(createWorkflowDeps(), request.run, runCwd, platform);
    if (!resolved.ok) {
      await platform.sendMessage(
        conversationId,
        `Cannot continue run \`${request.run.id}\`: ${resolved.message}` +
          (resolved.resumeHint ? ` ${resolved.resumeHint}` : '')
      );
      return undefined;
    }
    return resolved.workflow;
  }
  return request.definition;
}

export async function resolveDispatchAdoption(
  scope: DispatchScope,
  workflow: ResolvedWorkflow
): Promise<DispatchAdoption | undefined> {
  const { codebase, options } = scope;
  if (options?.adoptRunId !== undefined && options.supersedesRunId !== undefined) {
    throw new WorkflowAdoptionError(
      'adoptRunId and supersedesRunId are mutually exclusive. Choose adoption or supersede.'
    );
  }
  // Between-run continuation (#2747): adoption is validated by the ONE resolver,
  // whatever surface declared it — CLI, API, or chat. A non-terminal target, a
  // cross-codebase id, or a missing estate refuses here, before any worktree is
  // cut; the resolved lane then drives where the run actually executes.
  const adoption = options?.adoptRunId
    ? await resolveWorkflowAdoption({
        deps: {
          getRun: sqlWorkflow.getWorkflowRun,
          getActiveRunByPath: sqlWorkflow.getActiveWorkflowRunByPath,
          findEnvironmentByPath: sqlIsolation.findLatestByCodebaseAndWorkingPath,
        },
        adoptedRunId: options.adoptRunId,
        codebaseId: codebase.id,
        codebasePath: codebase.default_cwd,
        codebaseKind: codebase.kind,
      })
    : undefined;
  const adoptionLane = adoption?.lane;

  // A lane other than in-place inherits a worktree or branch estate; a workflow
  // that opted out of worktrees runs in the parent checkout and has nothing to
  // inherit, so honoring the adoption would mean silently dropping the lane.
  if (
    options?.adoptRunId !== undefined &&
    adoptionLane !== undefined &&
    adoptionLane.kind !== 'in-place' &&
    workflow.worktree?.enabled === false
  ) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${options.adoptRunId}': workflow '${workflow.name}' disables ` +
        'worktrees, so there is no worktree or branch estate to inherit. ' +
        'Drop the adoption or run a worktree-isolated workflow.'
    );
  }
  return adoption;
}

export interface Continuation {
  resumableRun: WorkflowRun | null;
  explicitResumeRequested: boolean;
  willContinueExistingRun: boolean;
}

/** Which existing run this dispatch continues, if any; `undefined` after a refusal was sent. */
export async function detectContinuation(
  scope: DispatchScope,
  request: WorkflowRequest,
  workflow: ResolvedWorkflow
): Promise<Continuation | undefined> {
  const { platform, conversationId, actor, options } = scope;
  // Resume detection, hoisted above the signature gate ON PURPOSE (#2554).
  //
  // This function continues an existing run in TWO ways: an explicit
  // `/workflow resume <id>` (which carries one run), and an
  // IMPLICIT auto-detection that fires for a plain `/workflow run <name>` on every
  // platform — the lookup that used to live further down, next to the dispatch. An
  // attention wait is excluded from that implicit path: only the explicit form
  // may consume it. The signature gate (`runSignatureGates`) still has to know about
  // both continuation forms:
  // gating only against the explicit form wrongly refused a required-input workflow
  // that was merely being continued (the run row already holds its validated inputs,
  // and the caller supplies nothing when they just say "run it" again).
  //
  // It has to be hoisted rather than the gate pushed down: `validateAndResolveIsolation`
  // sits between here and the old lookup site and CREATES WORKTREES, so gating after it
  // would forfeit the pre-cost refusal. This lookup is a single indexed DB read — no
  // worktree, no clone, no AI — so it is safe to do before gating. Its inputs
  // (`conversation.id`, `codebase.id`) are parameters and nothing in the dispatch mutates them.
  const explicitResumeRequested = request.kind === 'resume';
  const resumableRun = await findResumableRun(scope, request, workflow);
  // Whether this dispatch will CONTINUE existing work rather than create a fresh run
  // row. Deliberately the exact negation of the resume/abandon/force menu's condition
  // (`offerResumeChoice`): a candidate that is neither paused nor the explicitly-targeted run does not
  // continue — it shows that menu and returns. Only a genuine continuation may defer the
  // signature gate, so an invocation that was never going to continue is still refused
  // immediately, with the specific input error rather than a generic menu, and before
  // isolation resolution can create a worktree.
  const willContinueExistingRun =
    Boolean(resumableRun?.working_path) &&
    (resumableRun?.status === 'paused' || explicitResumeRequested);

  if (willContinueExistingRun && resumableRun) {
    try {
      await createSqlWorkflowOperations().resumeWorkflow(resumableRun.id, actor);
    } catch (error) {
      if (!(error instanceof RunActionForbiddenError)) throw error;
      await platform.sendMessage(conversationId, error.message);
      return undefined;
    }
  }

  // Adoption and continuation are mutually exclusive: both decide where the run
  // executes and which estate it inherits, and every continuation path forwards
  // only the resume context — an adopted id would be validated above and then silently
  // dropped. Refuse the combination up front, mirroring the CLI's adopt/resume guard.
  if (options?.adoptRunId !== undefined && willContinueExistingRun && resumableRun) {
    throw new WorkflowAdoptionError(
      `Cannot adopt run '${options.adoptRunId}': this conversation already continues ` +
        `run '${resumableRun.id}' (${resumableRun.status}). Resume or abandon that run ` +
        'first, or declare the adoption from a conversation with no open run.'
    );
  }
  if (options?.supersedesRunId !== undefined && willContinueExistingRun && resumableRun) {
    throw new WorkflowAdoptionError(
      `Cannot supersede run '${options.supersedesRunId}': this conversation already continues ` +
        `run '${resumableRun.id}' (${resumableRun.status}). Resume or abandon that run ` +
        'first, or declare the supersede from a conversation with no open run.'
    );
  }
  return { resumableRun, explicitResumeRequested, willContinueExistingRun };
}

/**
 * The run this request continues: the one an explicit resume carries, or the
 * conversation's resumable run for this workflow unless the request forces a fresh
 * one. An attention wait is only ever continued explicitly.
 */
async function findResumableRun(
  { conversation, codebase }: DispatchScope,
  request: WorkflowRequest,
  workflow: ResolvedWorkflow
): Promise<WorkflowRun | null> {
  if (request.kind === 'resume') return request.run;
  if (request.force) return null;
  const candidate = await workflowDb.findResumableRunByParentConversation(
    workflow.name,
    conversation.id,
    codebase.id
  );
  return candidate !== null &&
    isWorkflowWaitContext(candidate.metadata.wait) &&
    candidate.metadata.wait.kind === 'attention'
    ? null
    : candidate;
}
