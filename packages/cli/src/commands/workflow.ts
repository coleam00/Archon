/**
 * Workflow command - list and run workflows
 */

import { checkoutSharedEventDataSchema } from '@archon/workflows/schemas/workflow-event';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { WorkflowResourceBusyError } from '@archon/workflows/store';
import {
  WORKFLOW_EVENT_TYPES,
  isDurableWorkflowEventType,
  type WorkflowEventType,
} from '@archon/workflows/store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  CancelRefusedError,
  type CancelWorkflowResult,
  describeAbandonOwner,
  describeReleasedWorktrees,
  assertAnswerAdmissible,
  assertResponseAccepted,
  expectedGateForOccurrence,
  type ApprovalOperationResult,
  type GateAnswerOrigin,
} from '@archon/core/operations/workflow-operations';
import { writeJsonLine, writeStdout } from '../utils/stdout';
import {
  getLog,
  printJsonWriteError,
  resolveDiscoveryCwdForCodebase,
  resolveRunIdArg,
  spelledForCli,
} from './workflow-shared';
import { runDetachedControlCommand } from './workflow-detach';
import { assertResumeWorkingPathExists } from './workflow-isolation';
import { workflowRunCommand } from './workflow-run-owned';

export { workflowRunCommand };
export {
  WorkflowListLookupError,
  workflowGetCommand,
  workflowListCommand,
  workflowLogsCommand,
  workflowRunsCommand,
  workflowStatusCommand,
  workflowTestCommand,
  workflowWaitCommand,
} from './workflow-query';
export { workflowAttentionCommand, workflowAttentionLabelCommand } from './workflow-attention';

/**
 * Resume a failed workflow run by ID.
 *
 * Re-executes the workflow with --resume semantics: `workflowRunCommand` locates
 * the prior failed run via findResumableRun and hands it to the executor, which
 * skips already-completed nodes (the executor no longer auto-detects on its own).
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowResumeCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean
): Promise<number> {
  const { resumeWorkflow: resumeWorkflowOp } = host.operations;

  // --detach: validate read-only (resumeWorkflowOp checks the run is resumable),
  // then let a detached child re-invoke the blocking resume and own all mutation
  // + execution, so a reaped launching shell can't wedge the run mid-resume.
  // Composes with --json (structured ack; nothing executes here).
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'resume', json, cwd, async () => {
      const run = await resumeWorkflowOp(resolvedId, { kind: 'operator' });
      // The inline path below refuses a run with no recorded working path, or one
      // whose checkout is gone. Check both here too, on the run the precheck already
      // holds: otherwise the parent acks success and the child throws where nobody
      // reads it.
      if (!run.working_path) {
        throw new Error(
          `Workflow run '${resolvedId}' has no working path recorded.\n` +
            'Cannot determine where to resume. The run may be too old.'
        );
      }
      assertResumeWorkingPathExists(run.working_path);
      return run;
    });
  }

  // JSON mode is a non-blocking control-plane ack: validate the run is resumable
  // and report its state, but do NOT re-execute the workflow inline (execution
  // streams workflow output to stdout, which would corrupt the JSON contract).
  // To actually execute a resumable run, use the blocking `resume` (no --json,
  // run as a background task) or `resume <run-id> --detach`. Prefer that exact-id
  // form over `run <name> --resume --detach`, which selects the newest resumable
  // run of that workflow in the CURRENT checkout — a different question, and the
  // wrong one when the caller already holds a run id (#2645).
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const run = await resumeWorkflowOp(resolvedId, { kind: 'operator' });
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'resume',
        executed: false,
        status: run.status,
        workflowName: run.workflow_name,
        workingPath: run.working_path,
      });
    } catch (error) {
      await printJsonWriteError(runId, 'resume', error);
      return 1;
    }
    return 0;
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const run = await resumeWorkflowOp(resolvedId, { kind: 'operator' });
  if (!run.working_path) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume. The run may be too old.'
    );
  }
  console.log(`Resuming workflow: ${run.workflow_name}`);
  console.log(`Path: ${run.working_path}`);
  console.log('');

  // Use the codebase's source path for workflow YAML discovery so the file is
  // found even when working_path is a worktree or workspace clone that does
  // not contain the user's local (often untracked) workflow YAML.
  const discoveryCwd = run.codebase_id
    ? await resolveDiscoveryCwdForCodebase(host, resolvedId, run.codebase_id, 'resume')
    : undefined;

  // Re-execute via workflowRunCommand with --resume: it locates the prior failed
  // run via findResumableRun and skips already-completed nodes (the executor
  // itself no longer auto-detects resumable runs).
  try {
    await workflowRunCommand(host, run.working_path, run.workflow_name, run.user_message ?? '', {
      // Continue from the source this run froze, not a fresh capture of the target.
      continuationRun: run,
      resume: true,
      codebaseId: run.codebase_id ?? undefined,
      discoveryCwd,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, runId: resolvedId, workflowName: run.workflow_name },
      'cli.workflow_resume_run_failed'
    );
    throw new Error(`Failed to resume workflow '${run.workflow_name}': ${err.message}`, {
      cause: err,
    });
  }
  return 0;
}

/**
 * Abandon a workflow run by ID (marks it as cancelled).
 *
 * `--json` emits a structured result instead of human text. In JSON mode the
 * command never throws — lookup/state errors are reported as `{ ok: false }` so
 * a parsing agent always gets one clean JSON line.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowAbandonCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  cwd?: string
): Promise<number> {
  const { abandonWorkflow } = host.operations;

  // The container reclaim (M2) and the live-owner stop both live in the shared
  // `abandonWorkflow` op, so EVERY surface does them — the CLI reports the outcome.
  // Keeps `--json` a clean one-line contract (no reclaim text before the payload).
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const {
        run,
        cascadeFailures,
        cleanupWarnings,
        releasedWorktrees,
        blockedParentRunId,
        owner,
      } = await abandonWorkflow(resolvedId, { kind: 'operator' });
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'abandon',
        status: 'cancelled',
        workflowName: run.workflow_name,
        owner:
          owner.kind === 'stopped'
            ? { outcome: 'stopped', pid: owner.pid }
            : {
                outcome: 'no_owner_answered',
                thisHost: owner.thisHost,
                recordedHost: owner.recordedOwner?.host ?? null,
                recordedPid: owner.recordedOwner?.pid ?? null,
                recordedUid: owner.recordedOwner?.uid ?? null,
                lastActivityAt: owner.lastActivityAt?.toISOString() ?? null,
              },
        ...(releasedWorktrees ? { releasedWorktrees } : {}),
        ...(cleanupWarnings ? { cleanupWarnings } : {}),
        ...(cascadeFailures > 0 ? { cascadeFailures } : {}),
        ...(blockedParentRunId ? { blockedParentRunId } : {}),
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'abandon', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const { run, cascadeFailures, cleanupWarnings, releasedWorktrees, blockedParentRunId, owner } =
    await abandonWorkflow(resolvedId, { kind: 'operator' });
  for (const line of describeAbandonOwner(owner)) console.log(line);
  console.log(`Abandoned workflow run: ${resolvedId}`);
  console.log(`Workflow: ${run.workflow_name}`);
  for (const line of describeReleasedWorktrees(releasedWorktrees)) console.log(line);
  for (const warning of cleanupWarnings ?? []) console.log(`Warning: ${warning}`);
  printRunTreeCancellationWarnings(cascadeFailures, blockedParentRunId);
  return 0;
}

function printRunTreeCancellationWarnings(
  cascadeFailures: number,
  blockedParentRunId: string | null
): void {
  if (cascadeFailures > 0) {
    console.log(
      `Warning: ${String(cascadeFailures)} sub-run(s) could not be cancelled and may still be running — check \`archon workflow status\`.`
    );
  }
  if (blockedParentRunId) {
    console.log(
      `Warning: parent run ${blockedParentRunId} was blocked on this sub-run and stays paused.`
    );
    console.log(
      `  Resume it so it reads this sub-run's outcome (archon workflow resume ${blockedParentRunId}) or abandon it too.`
    );
  }
}

/**
 * Cancel a running run through the shared `cancelWorkflow` op.
 *
 * Ordering is the contract: prove the live exact-run owner, terminate its process
 * tree, then record `cancelled`. An unreachable owner never falls back to a DB-only
 * transition — the refusal points at `abandon` for an orphan the operator has verified.
 */
export async function workflowCancelCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  cwd?: string
): Promise<number> {
  const { cancelWorkflow } = host.operations;

  const cancel = async (): Promise<{ resolvedId: string; result: CancelWorkflowResult }> => {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    try {
      const result = await cancelWorkflow(resolvedId, { kind: 'operator' });
      if (result.kind === 'cooperative' && !result.cancelled) {
        throw new Error(`Workflow run ${resolvedId} already finished; nothing to cancel.`);
      }
      return { resolvedId, result };
    } catch (error) {
      if (error instanceof CancelRefusedError && error.reason === 'no_owner_answered') {
        throw new Error(`${error.message}\nAbandon it: archon workflow abandon ${resolvedId}`, {
          cause: error,
        });
      }
      throw error;
    }
  };

  if (json) {
    try {
      const { resolvedId, result } = await cancel();
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'cancel',
        status: 'cancelled',
        processStopped: result.kind === 'stopped',
        workflowName: result.run.workflow_name,
        ...(result.kind === 'stopped' && result.cleanupWarnings
          ? { cleanupWarnings: result.cleanupWarnings }
          : {}),
        ...(result.kind === 'stopped' && result.cascadeFailures > 0
          ? { cascadeFailures: result.cascadeFailures }
          : {}),
        ...(result.kind === 'stopped' && result.blockedParentRunId
          ? { blockedParentRunId: result.blockedParentRunId }
          : {}),
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'cancel', error);
      return 1;
    }
  }

  const { resolvedId, result } = await cancel();
  if (result.kind === 'cooperative') {
    console.log(`Cancelled workflow run: ${resolvedId}`);
    console.log(`Workflow: ${result.run.workflow_name}`);
    console.log("It runs inside its parent run's process and stops at its next status check.");
    return 0;
  }
  console.log(`Cancelled detached workflow run: ${resolvedId}`);
  console.log(`Workflow: ${result.run.workflow_name}`);
  console.log('Host process tree stopped before run state was changed.');
  for (const warning of result.cleanupWarnings ?? []) console.log(`Warning: ${warning}`);
  printRunTreeCancellationWarnings(result.cascadeFailures, result.blockedParentRunId);
  return 0;
}

/**
 * The origin a CLI answer records. `--occurrence` refuses the answer unless the run is
 * still paused at that occurrence, read the way run-attention reports it.
 */
async function cliAnswerOrigin(
  host: WorkflowHost,
  runId: string,
  occurrence: string | undefined
): Promise<GateAnswerOrigin> {
  if (occurrence === undefined) return { via: 'cli' };
  const run = await host.deps.store.getWorkflowRun(runId);
  if (!run) throw new Error(`Workflow run not found: ${runId}`);
  return cliOriginForRun(run, occurrence);
}

function cliOriginForRun(run: WorkflowRun, occurrence: string | undefined): GateAnswerOrigin {
  return occurrence === undefined
    ? { via: 'cli' }
    : { via: 'cli', expectedGate: expectedGateForOccurrence(run, occurrence) };
}

/**
 * Continue a run in this process right after this process recorded its answer, the way
 * the CLI's answering commands do outside `--json`. A continuation host may claim the
 * answer first; `workflowRunCommand` reports that and returns.
 */
async function continueAnsweredRun(
  host: WorkflowHost,
  resolvedId: string,
  result: Pick<
    ApprovalOperationResult,
    'workflowName' | 'userMessage' | 'codebaseId' | 'conversationId'
  >,
  workingPath: string,
  action: 'approve' | 'reject' | 'respond' | 'answer',
  failure: { failurePrefix: string; recorded: string }
): Promise<void> {
  // Look up the original platform conversation ID to keep all messages in one thread
  let platformConversationId: string | undefined;
  try {
    const originalConversation = result.conversationId
      ? await host.records.conversations.getConversationById(result.conversationId)
      : null;
    platformConversationId = originalConversation?.platform_conversation_id ?? undefined;
    if (!originalConversation) {
      getLog().info(
        { runId: resolvedId, conversationId: result.conversationId },
        `cli.workflow_${action}_conversation_not_found`
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      { err, runId: resolvedId, conversationId: result.conversationId },
      `cli.workflow_${action}_conversation_lookup_failed`
    );
  }

  try {
    // Use the codebase's source path for workflow YAML discovery so the file is
    // found even when working_path is a worktree or workspace clone that does
    // not contain the user's local (often untracked) workflow YAML.
    const discoveryCwd = result.codebaseId
      ? await resolveDiscoveryCwdForCodebase(host, resolvedId, result.codebaseId, action)
      : undefined;

    await workflowRunCommand(host, workingPath, result.workflowName, result.userMessage ?? '', {
      // Continue from the source this run froze, not a fresh capture of the target.
      continuationRun: (await host.deps.store.getWorkflowRun(resolvedId)) ?? undefined,
      resume: true,
      codebaseId: result.codebaseId ?? undefined,
      conversationId: platformConversationId,
      discoveryCwd,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.cause instanceof WorkflowResourceBusyError &&
      error.cause.refusal === 'waiting'
    ) {
      console.log(
        `The answer was recorded. Workflow '${result.workflowName}' is waiting for capacity and continues when a slot frees.\n` +
          error.cause.message
      );
      return;
    }
    const err = error as Error;
    getLog().error(
      { err, runId: resolvedId, workflowName: result.workflowName },
      `cli.workflow_${action}_resume_failed`
    );
    throw new Error(
      `${failure.failurePrefix} failed to resume workflow '${result.workflowName}': ${err.message}\n` +
        `The ${failure.recorded} was recorded. Run 'bun run cli workflow resume ${resolvedId}' to retry.`,
      { cause: err }
    );
  }
}

/**
 * Answer a paused attention wait in its declared form: `choose` holds declared option ids,
 * `text` the free text. `occurrence` is required, so an answer prepared for an earlier
 * pause is refused. Like approve, `--json` records the answer for a continuation host;
 * otherwise this process continues the run inline.
 */
export async function workflowAnswerCommand(
  host: WorkflowHost,
  runId: string,
  occurrence: string,
  choose: readonly string[],
  text: string | undefined,
  json?: boolean,
  cwd?: string
): Promise<number> {
  const request = { choose, ...(text !== undefined ? { text } : {}) };
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await host.operations.answerWorkflow(
        resolvedId,
        request,
        { kind: 'operator' },
        await cliAnswerOrigin(host, resolvedId, occurrence)
      );
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'answer',
        answer: result.answer,
        workflowName: result.workflowName,
        resumable: true,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'answer', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const result = await spelledForCli(async () =>
    host.operations.answerWorkflow(
      resolvedId,
      request,
      { kind: 'operator' },
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );
  const { workingPath } = result;
  if (!workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Answered workflow: ${result.workflowName}`);
  console.log(`Path: ${workingPath}`);
  console.log('');
  console.log('Resuming workflow...');
  await continueAnsweredRun(host, resolvedId, result, workingPath, 'answer', {
    failurePrefix: 'Answer recorded but',
    recorded: 'answer',
  });
  return 0;
}

/**
 * Approve a paused workflow run by ID.
 *
 * Human mode records the approval on the still-'paused' run (the resolution
 * lives in metadata.approval.resolved, #2075) and then auto-resumes the run
 * inline. `--json` mode records the approval and returns a structured ack
 * WITHOUT resuming (inline resume would stream output and break the JSON); the
 * answered gate is then a due continuation that `archon serve` or `workflow wake`
 * continues.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowApproveCommand(
  host: WorkflowHost,
  runId: string,
  comment?: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean,
  occurrence?: string
): Promise<number> {
  const { approveWorkflow } = host.operations;

  // --detach: hand the approve AND its inline auto-resume to a detached child
  // (same argv minus --detach/--json). Handled BEFORE any state change — the
  // parent only validates read-only, so the approval is recorded exactly once,
  // in the child. Composes with --json (structured ack; nothing executes here).
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'approve', json, cwd, async () => {
      const run = await host.deps.store.getWorkflowRun(resolvedId);
      if (!run) {
        throw new Error(`Workflow run not found: ${resolvedId}`);
      }
      // The SAME gates approveWorkflow enforces, in the same order — not a copy of
      // one branch of them. A partial copy acks { ok: true } and lets the child die unseen.
      assertAnswerAdmissible(run, cliOriginForRun(run, occurrence));
      assertResponseAccepted(run, 'approve', comment);
      // The child always auto-resumes after approving, and the inline path below
      // refuses a run with no recorded working path. Same check here (message
      // copied verbatim) so the refusal is synchronous instead of buried in a log.
      if (!run.working_path) {
        throw new Error(
          `Workflow run '${resolvedId}' has no working path recorded.\n` +
            'Cannot determine where to resume.'
        );
      }
      return run;
    });
  }

  // JSON mode records the approval and returns a structured ack WITHOUT the
  // inline auto-resume (resuming executes the workflow and streams output to
  // stdout, which would corrupt the JSON contract). The answered gate is a due
  // continuation, so a continuation host (`archon serve`, `workflow wake`) continues it.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await approveWorkflow(
        resolvedId,
        comment,
        { kind: 'operator' },
        await cliAnswerOrigin(host, resolvedId, occurrence)
      );
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'approve',
        type: result.type,
        workflowName: result.workflowName,
        resumable: true,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'approve', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const result = await spelledForCli(async () =>
    approveWorkflow(
      resolvedId,
      comment,
      { kind: 'operator' },
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );

  // CLI auto-resumes after approval, as chat does since #2565. `--json` (handled
  // above) is the one surface that records the decision without continuing.
  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Approved workflow: ${result.workflowName}`);
  console.log(`Path: ${result.workingPath}`);
  console.log('');
  console.log('Resuming workflow...');

  await continueAnsweredRun(host, resolvedId, result, result.workingPath, 'approve', {
    failurePrefix: 'Approved but',
    recorded: 'approval',
  });
  return 0;
}

/**
 * Reject a paused workflow run by ID.
 * If the workflow has an on_reject prompt, auto-resumes with the rejection feedback;
 * otherwise marks the run as cancelled.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowRejectCommand(
  host: WorkflowHost,
  runId: string,
  reason?: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean,
  occurrence?: string
): Promise<number> {
  const { rejectWorkflow } = host.operations;

  // --detach: hand the reject AND its inline on_reject rework to a detached child,
  // exactly as approve does. Without it, reject hosts the executor in the calling
  // shell — a reaped shell (harness task, closed terminal) leaves the run wedged
  // mid-rework. The parent only validates read-only. Composes with --json.
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'reject', json, cwd, async () => {
      const run = await host.deps.store.getWorkflowRun(resolvedId);
      if (!run) {
        throw new Error(`Workflow run not found: ${resolvedId}`);
      }
      // The SAME gates rejectWorkflow enforces, in the same order — not a copy of
      // one branch of them. A partial copy acks { ok: true } and lets the child die unseen.
      assertAnswerAdmissible(run, cliOriginForRun(run, occurrence));
      assertResponseAccepted(run, 'reject', reason);
      return run;
    });
  }

  // JSON mode records the rejection and returns a structured ack WITHOUT the
  // inline auto-resume (an on_reject rework executes the workflow and streams
  // to stdout, corrupting the JSON contract). When `cancelled` is false the answered
  // gate is a due continuation that a continuation host picks up, except on a container
  // run (including its write-back gate), which needs a manual `resume`.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await rejectWorkflow(
        resolvedId,
        reason,
        { kind: 'operator' },
        await cliAnswerOrigin(host, resolvedId, occurrence)
      );
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'reject',
        cancelled: result.cancelled,
        maxAttemptsReached: result.maxAttemptsReached,
        workflowName: result.workflowName,
        resumable: !result.cancelled,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'reject', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const result = await spelledForCli(async () =>
    rejectWorkflow(
      resolvedId,
      reason,
      { kind: 'operator' },
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );

  if (result.cancelled) {
    const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
    console.log(`Rejected and cancelled${suffix}: ${result.workflowName}`);
    return 0;
  }

  // Not cancelled = a legacy on_reject rework, a #2707 step-1 new-mode
  // resolution, or a container write-back reject (discard the overlay). All
  // three auto-resume; the resume drives the rework / continuation / the
  // overlay discard + completion.
  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Rejected workflow: ${result.workflowName}`);
  console.log(
    result.writeBack
      ? 'Discarding container changes (live folder left untouched)...'
      : result.newMode
        ? 'Resuming...'
        : 'Resuming with on_reject prompt...'
  );

  await continueAnsweredRun(host, resolvedId, result, result.workingPath, 'reject', {
    failurePrefix: 'Rejected but',
    recorded: 'rejection',
  });
  return 0;
}

/**
 * Resolve a paused workflow run with any of its gate's declared decisions (#2707 step 2).
 * `approve`/`reject` delegate to the existing commands' exact behavior (the general-purpose
 * function underneath is the same `respondToWorkflow`, which is sugar over
 * `approveWorkflow`/`rejectWorkflow` for those two ids); any other declared decision always
 * resolves immediately and auto-resumes, mirroring `approve`'s shape.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowRespondCommand(
  host: WorkflowHost,
  runId: string,
  decision: string,
  text?: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean,
  occurrence?: string
): Promise<number> {
  const { respondToWorkflow } = host.operations;

  if (decision === 'approve')
    return workflowApproveCommand(host, runId, text, json, cwd, detach, occurrence);
  if (decision === 'reject')
    return workflowRejectCommand(host, runId, text, json, cwd, detach, occurrence);

  // --detach: same shape as approve/reject — the parent validates read-only via the
  // SAME gate respondToWorkflow enforces, then hands the whole command to a detached
  // child. See runDetachedControlCommand's doc comment.
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'respond', json, cwd, async () => {
      const run = await host.deps.store.getWorkflowRun(resolvedId);
      if (!run) {
        throw new Error(`Workflow run not found: ${resolvedId}`);
      }
      assertAnswerAdmissible(run, cliOriginForRun(run, occurrence));
      assertResponseAccepted(run, decision, text);
      if (!run.working_path) {
        throw new Error(
          `Workflow run '${resolvedId}' has no working path recorded.\n` +
            'Cannot determine where to resume.'
        );
      }
      return run;
    });
  }

  // JSON mode records the decision and returns a structured ack WITHOUT the inline
  // auto-resume, mirroring approve/reject; a continuation host continues the answered gate.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await respondToWorkflow(
        resolvedId,
        decision,
        text,
        { kind: 'operator' },
        await cliAnswerOrigin(host, resolvedId, occurrence)
      );
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'respond',
        decision,
        workflowName: result.workflowName,
        resumable: true,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'respond', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const result = await spelledForCli(async () =>
    respondToWorkflow(
      resolvedId,
      decision,
      text,
      { kind: 'operator' },
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );

  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Responded '${decision}' to workflow: ${result.workflowName}`);
  console.log(`Path: ${result.workingPath}`);
  console.log('');
  console.log('Resuming workflow...');

  await continueAnsweredRun(host, resolvedId, result, result.workingPath, 'respond', {
    failurePrefix: 'Response recorded but',
    recorded: 'response',
  });
  return 0;
}

/**
 * Reset persisted per-node provider sessions for a workflow.
 *
 * Filter rules:
 *   - workflow-name required (positional)
 *   - --scope <key>: restrict to one scope (e.g. a conversation UUID); when
 *     omitted, deletes across ALL scopes (use --yes to skip the confirmation)
 *   - --node <id>: restrict to one node within the scope
 *   - --json: machine-readable output
 */
export async function workflowResetSessionsCommand(
  host: WorkflowHost,
  workflowName: string,
  options: { scope?: string; node?: string; yes?: boolean; json?: boolean }
): Promise<void> {
  const { resetWorkflowNodeSessions } = host.operations;

  if (!options.scope && !options.yes) {
    throw new Error(
      `Refusing to delete every persisted session for workflow '${workflowName}' across all scopes without confirmation.\n` +
        'Pass --scope <key> to narrow, or --yes to confirm cross-scope reset.'
    );
  }
  try {
    const { deleted } = await resetWorkflowNodeSessions({
      workflow_name: workflowName,
      scope_key: options.scope,
      node_id: options.node,
    });
    if (options.json) {
      await writeStdout(
        `${JSON.stringify({
          workflow: workflowName,
          deleted,
          scope: options.scope ?? null,
          node: options.node ?? null,
        })}\n`
      );
    } else if (deleted === 0) {
      console.log(`No persisted sessions matched for workflow '${workflowName}'.`);
    } else {
      const scope = options.scope ? ` in scope '${options.scope}'` : ' across all scopes';
      const node = options.node ? ` for node '${options.node}'` : '';
      console.log(
        `Deleted ${deleted} persisted session(s) for workflow '${workflowName}'${node}${scope}.`
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowName, ...options }, 'cli.workflow_reset_sessions_failed');
    throw new Error(`Failed to reset workflow sessions: ${err.message}`);
  }
}

/**
 * Delete terminal workflow runs older than the given number of days.
 */
export async function workflowCleanupCommand(host: WorkflowHost, days: number): Promise<void> {
  let deleted: number | undefined;
  try {
    const { count } = await host.deps.store.deleteOldWorkflowRuns(days);
    deleted = count;
    const { count: revisions } = await host.deps.store.pruneStateRevisions(days);
    console.log(`Pruned ${revisions} state revision(s) older than ${days} days.`);
    if (count === 0) {
      console.log(`No workflow runs older than ${days} days to clean up.`);
    } else {
      console.log(`Deleted ${count} workflow run(s) older than ${days} days.`);
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, days, deleted }, 'cli.workflow_cleanup_failed');
    if (deleted !== undefined)
      throw new Error(
        `Deleted ${deleted} workflow run(s) older than ${days} days, but failed to prune state revisions: ${err.message}`,
        { cause: error }
      );
    throw new Error(`Failed to clean up workflow history: ${err.message}`, { cause: error });
  }
}

export function isValidEventType(value: string): value is WorkflowEventType {
  return (WORKFLOW_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Emit a workflow event directly to the database.
 * Required event writes propagate storage failures; ordinary observability remains best-effort.
 */
export async function workflowEventEmitCommand(
  host: WorkflowHost,
  runId: string,
  eventType: WorkflowEventType,
  data?: Record<string, unknown>,
  cwd?: string
): Promise<void> {
  const resolvedId = await resolveRunIdArg(host, runId, cwd, true);
  const store = host.deps.store;
  if (eventType === 'workflow.checkout_shared') {
    await store.persistWorkflowEvent({
      workflow_run_id: resolvedId,
      event_type: eventType,
      data: checkoutSharedEventDataSchema.parse(data),
    });
    console.log(`Event persisted: ${eventType} for run ${resolvedId}`);
    return;
  }
  if (isDurableWorkflowEventType(eventType)) {
    await store.persistWorkflowEvent({
      workflow_run_id: resolvedId,
      event_type: eventType,
      data,
    });
    console.log(`Event persisted: ${eventType} for run ${resolvedId}`);
    return;
  }
  await store.createWorkflowEvent({
    workflow_run_id: resolvedId,
    event_type: eventType,
    data,
  });
  // createWorkflowEvent is non-throwing (fire-and-forget) — the event may not
  // have been persisted if the DB was unavailable. Check server logs if missing.
  console.log(`Event submitted (best-effort): ${eventType} for run ${resolvedId}`);
}
