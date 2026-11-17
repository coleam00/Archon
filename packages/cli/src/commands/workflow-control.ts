import {
  abandonOneRun,
  cancelOneRun,
  cancelResultPayload,
  formatAbandonResult,
  printAbandonResult,
  printCancelResult,
  printCleanupWarnings,
} from './workflow-run-stop';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import {
  checkedResumeCursor,
  WorkflowNotResumableError,
  WorkflowResourceBusyError,
} from '@archon/workflows/store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  ResumeRefusedError,
  assertAnswerAdmissible,
  assertResponseAccepted,
  expectedGateForOccurrence,
  type ApprovalOperationResult,
  type GateAnswerOrigin,
} from '@archon/core/operations/workflow-operations';
import { cliActor } from '../utils/calling-node';
import { writeJsonLine } from '../utils/stdout';
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

/**
 * Resume a workflow run by ID: a failed or paused one, or a running one whose owner is
 * gone (`resumeWorkflow` decides). `workflowRunCommand` continues exactly this run and
 * skips its already-completed nodes.
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
  // A run whose owner still answers is the one refusal with a CLI next step to name.
  // Cancel is not that step: it records the run `cancelled`, which resume refuses.
  const resumeWorkflowOp = (id: string): Promise<WorkflowRun> =>
    host.operations.resumeWorkflow(id, { kind: 'operator' }).catch((error: unknown) => {
      if (!(error instanceof ResumeRefusedError) || error.reason !== 'live_owner') throw error;
      const hint = 'Resume it once that process is gone; cancel would end the run for good.';
      throw new Error(`${error.message}\n${hint}`, { cause: error });
    });

  // --detach: validate read-only (resumeWorkflowOp checks the run is resumable),
  // then let a detached child re-invoke the blocking resume and own all mutation
  // + execution, so a reaped launching shell can't wedge the run mid-resume.
  // Composes with --json (structured ack; nothing executes here).
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'resume', json, cwd, async () => {
      const run = await resumeWorkflowOp(resolvedId);
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
  // run as a background task) or `resume <run-id> --detach`.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const run = await resumeWorkflowOp(resolvedId);
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
  const run = await resumeWorkflowOp(resolvedId);
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

  // Re-execute this run via workflowRunCommand; it skips already-completed nodes.
  try {
    await workflowRunCommand(host, run.working_path, run.workflow_name, run.user_message ?? '', {
      // Continue from the source this run froze, not a fresh capture of the target.
      continuationRun: run,
      continuationCursor: checkedResumeCursor(run),
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
  // The container reclaim (M2) and the live-owner stop both live in the shared
  // `abandonWorkflow` op, so EVERY surface does them — the CLI reports the outcome.
  // Keeps `--json` a clean one-line contract (no reclaim text before the payload).
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await abandonOneRun(host, resolvedId);
      await writeJsonLine(formatAbandonResult(resolvedId, result));
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'abandon', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  printAbandonResult(resolvedId, await abandonOneRun(host, resolvedId));
  return 0;
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
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      await writeJsonLine(cancelResultPayload(resolvedId, await cancelOneRun(host, resolvedId)));
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'cancel', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  printCancelResult(resolvedId, await cancelOneRun(host, resolvedId));
  return 0;
}

/**
 * Ask the executor that owns a running run to pause it once its running nodes finish
 * (`pauseWorkflow`). Returns at once; the run reads `pause requested` until it pauses.
 */
export async function workflowPauseCommand(
  host: WorkflowHost,
  runId: string,
  opts: { json?: boolean; cwd?: string; as?: string }
): Promise<number> {
  const pause = async () => {
    const resolvedId = await resolveRunIdArg(host, runId, opts.cwd);
    return host.operations.pauseWorkflow(resolvedId, cliActor(opts.as), 'cli');
  };
  if (opts.json) {
    try {
      const { run, requested, alreadyRequested } = await pause();
      await writeJsonLine({
        ok: true,
        runId: run.id,
        action: 'pause',
        state: 'requested',
        alreadyRequested,
        requestedAt: requested.at,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'pause', error);
      return 1;
    }
  }
  const { run, requested, alreadyRequested } = await pause();
  console.log(
    alreadyRequested
      ? `A pause of run ${run.id} (${run.workflow_name}) was already requested at ${requested.at}.`
      : `Pause requested for run ${run.id} (${run.workflow_name}).`
  );
  console.log(
    'It pauses when the nodes running now finish and starts no node after them. ' +
      'Its checkout, results, resource slot and item stay held.'
  );
  console.log(
    `Once \`archon workflow status\` shows it paused, resume it: archon workflow resume ${run.id}`
  );
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

function isCompletedAnswerContinuation(error: unknown, runId: string): boolean {
  const MAX_CAUSE_DEPTH = 5;
  for (let current: unknown = error, depth = 0; current instanceof Error; depth += 1) {
    if (
      current instanceof WorkflowNotResumableError &&
      current.runId === runId &&
      current.currentStatus === 'completed'
    ) {
      return true;
    }
    if (depth >= MAX_CAUSE_DEPTH) return false;
    current = current.cause;
  }
  return false;
}

/**
 * A continuation host may claim this answer first. `workflowRunCommand` reports an
 * active owner; only this answer boundary treats an already-completed refusal as handled.
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
    if (isCompletedAnswerContinuation(error, resolvedId)) {
      getLog().info(
        { runId: resolvedId, workflowName: result.workflowName },
        `cli.workflow_${action}_already_continued`
      );
      console.log(`Run ${resolvedId} has already continued in another process and is completed.`);
      return;
    }
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
 * Answer a paused attention wait in its declared form: `selection` holds declared option
 * ids, or accepts the wait's recommendation, and `text` is the free text. `occurrence` is
 * required, so an answer prepared for an earlier pause is refused. Like approve, `--json`
 * records the answer for a continuation host; otherwise this process continues the run
 * inline.
 */
export async function workflowAnswerCommand(
  host: WorkflowHost,
  runId: string,
  occurrence: string,
  selection: { choose: readonly string[] } | { recommended: true },
  text: string | undefined,
  json?: boolean,
  cwd?: string,
  answerer?: string
): Promise<number> {
  const request = { ...selection, ...(text !== undefined ? { text } : {}) };
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await host.operations.answerWorkflow(
        resolvedId,
        request,
        cliActor(answerer),
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
      cliActor(answerer),
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
  occurrence?: string,
  answerer?: string
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
      assertResponseAccepted(run, 'approve', comment, cliActor(answerer));
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
        cliActor(answerer),
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
      cliActor(answerer),
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );

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
  occurrence?: string,
  answerer?: string
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
      assertResponseAccepted(run, 'reject', reason, cliActor(answerer));
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
        cliActor(answerer),
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
        cleanupWarnings: result.cleanupWarnings,
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
      cliActor(answerer),
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );

  if (result.cancelled) {
    const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
    console.log(`Rejected and cancelled${suffix}: ${result.workflowName}`);
    printCleanupWarnings(result.cleanupWarnings);
    return 0;
  }

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
  occurrence?: string,
  answerer?: string
): Promise<number> {
  const { respondToWorkflow } = host.operations;

  if (decision === 'approve')
    return workflowApproveCommand(host, runId, text, json, cwd, detach, occurrence, answerer);
  if (decision === 'reject')
    return workflowRejectCommand(host, runId, text, json, cwd, detach, occurrence, answerer);

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
      assertResponseAccepted(run, decision, text, cliActor(answerer));
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
        cliActor(answerer),
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
      cliActor(answerer),
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
