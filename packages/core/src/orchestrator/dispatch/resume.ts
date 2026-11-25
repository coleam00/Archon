import type { WorkflowResumeAdmission } from '@archon/workflows/engine-port';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  checkedResumeCursor,
  leasedResumeCursor,
  RunLimitError,
  WorkflowItemHeldError,
  type RunOwnerLease,
} from '@archon/workflows/store';
import { spellWorkflowCommand } from '@archon/workflows/deps';
import * as workflowDb from '../../db/workflows';
import { startRunLiveOwner } from '../../services/run-live-owner';
import { createWorkflowDeps } from '../../workflows/store-adapter';
import { getLog } from '../agent-log';
import { formatResumableRunState } from './resume-prompt';
import type { DispatchScope } from './scope';

export interface ForegroundResumeInput {
  workflow: ResolvedWorkflow;
  resumableRun: WorkflowRun;
  resumableWorkingPath: string;
  deferredInputError: Error | undefined;
}

/**
 * Continue the detected run in the foreground under its own id, with the inputs, source and
 * configuration it started with. A run with no completed node runs again from its first node.
 */
export async function continueForegroundResume(
  scope: DispatchScope,
  input: ForegroundResumeInput
): Promise<void> {
  const { workflow, resumableRun } = input;
  getLog().info(
    {
      workflowName: workflow.name,
      resumableRunId: resumableRun.id,
      workingPath: resumableRun.working_path,
      platformType: scope.platform.getPlatformType(),
    },
    'orchestrator.foreground_resume_detected'
  );
  // A lost claim never falls through to a fresh run on another owner's worktree.
  const engine = new InProcessWorkflowEngine(createWorkflowDeps());
  const resumeOwner = await startRunLiveOwner(resumableRun.id);
  try {
    const admission = await admitResume(scope, input, engine, resumeOwner.lease);
    if (admission !== undefined) await admission.settled;
  } finally {
    await resumeOwner.close();
  }
}

/** The engine's answer to resuming the run; `undefined` after telling the user it did not. */
async function admitResume(
  scope: DispatchScope,
  input: ForegroundResumeInput,
  engine: InProcessWorkflowEngine,
  lease: RunOwnerLease
): Promise<WorkflowResumeAdmission | undefined> {
  const { platform, conversationId, conversation, codebase, userId, options } = scope;
  const { workflow, resumableRun } = input;
  try {
    if (options?.runConfig) {
      await platform.sendMessage(
        conversationId,
        'This command would resume an existing run, so a new run config cannot be applied. ' +
          'Resume without config, or force a fresh run.'
      );
      return undefined;
    }
    await noticeIgnoredOverrides(scope, workflow, resumableRun);
    return await engine.resume({
      platform,
      conversationId,
      cwd: input.resumableWorkingPath,
      legacyWorkflow: workflow,
      userMessage: scope.userMessage,
      origin: {
        conversationId: conversation.id,
        userId,
        parentConversationId: conversation.id,
      },
      run: resumableRun,
      // A running run got here only through `resumeWorkflow` (`detectContinuation`).
      cursor: leasedResumeCursor(checkedResumeCursor(resumableRun), lease),
      options: {
        codebaseId: codebase.id,
        source: scope.source,
        parseWarnings: scope.parseWarnings,
        baseBranch: scope.codebaseBaseBranch,
        resolveChildIsolation: scope.resolveChildIsolation,
      },
    });
  } catch (err) {
    await reportRefusedResume(scope, input, err);
    return undefined;
  }
}

/**
 * A resume replays the inputs and model bindings stamped on its own row; values
 * supplied on THIS call cannot reach it (the row already exists, so the executor's
 * stamp never fires). Say so rather than accepting them and quietly running
 * something else.
 */
async function noticeIgnoredOverrides(
  { platform, conversationId, options }: DispatchScope,
  workflow: ResolvedWorkflow,
  resumableRun: WorkflowRun
): Promise<void> {
  const resumeStateLabel = formatResumableRunState(resumableRun.status);
  const abandon = spellWorkflowCommand(platform, `abandon ${resumableRun.id}`);
  const suppliedModelBindingNames = [
    ...Object.keys(options?.modelOverrides?.tiers ?? {}),
    ...Object.keys(options?.modelOverrides?.aliases ?? {}),
  ].sort();
  if (options?.inputs && Object.keys(options.inputs).length > 0) {
    const ignored = Object.keys(options.inputs).sort().join(', ');
    getLog().info(
      {
        workflowName: workflow.name,
        resumableRunId: resumableRun.id,
        ignoredKeys: ignored,
      },
      'orchestrator.resume_ignored_supplied_inputs'
    );
    await platform.sendMessage(
      conversationId,
      `▶️ Resuming the ${resumeStateLabel} run of **${workflow.name}** (\`${resumableRun.id}\`), which ` +
        `keeps the inputs it started with — the values you supplied now (${ignored}) were ` +
        'not applied. To run fresh with them instead, abandon that run first ' +
        `(\`${abandon}\`) and re-invoke.`
    );
  }
  if (suppliedModelBindingNames.length > 0) {
    getLog().info(
      {
        workflowName: workflow.name,
        resumableRunId: resumableRun.id,
        ignoredBindings: suppliedModelBindingNames,
      },
      'orchestrator.resume_ignored_model_bindings'
    );
    await platform.sendMessage(
      conversationId,
      `▶️ Resuming the ${resumeStateLabel} run of **${workflow.name}** (\`${resumableRun.id}\`), which ` +
        'keeps the model bindings it started with — the bindings you supplied now ' +
        `(${suppliedModelBindingNames.join(', ')}) were not applied. To run fresh with them ` +
        `instead, abandon that run first (\`${abandon}\`) and re-invoke.`
    );
  }
}

/** Tell the user why the run could not be resumed here, or rethrow what is not a refusal. */
async function reportRefusedResume(
  { platform, conversationId, options }: DispatchScope,
  { workflow, resumableRun, deferredInputError }: ForegroundResumeInput,
  err: unknown
): Promise<void> {
  // The gate deferred a contract violation because this looked like a
  // continuation; when the run does not continue here it is never surfaced
  // anywhere else. Say it rather than let an already-computed, actionable error die.
  const deferredNote =
    deferredInputError && options?.inputs && Object.keys(options.inputs).length > 0
      ? `\n\nAlso note: ${deferredInputError.message}`
      : '';
  // resumeWorkflowRun is a compare-and-swap: if another surface (web Resume,
  // a concurrent re-dispatch, the CLI) already claimed this run, it throws
  // WorkflowNotResumableError. Surface a friendly note instead of leaking the
  // raw internal string to the generic failure catch, and do NOT fall through
  // to a fresh run — the other resumer owns the worktree (#1830 I2).
  if (err instanceof workflowDb.WorkflowNotResumableError) {
    getLog().info(
      { workflowName: workflow.name, runId: resumableRun.id, status: err.currentStatus },
      'orchestrator.resume_lost_race'
    );
    await platform.sendMessage(
      conversationId,
      `⚠️ **${workflow.name}** is already being resumed (status: ${err.currentStatus}). ` +
        'No action taken — follow the existing run for progress.' +
        deferredNote
    );
    return;
  }
  // The run keeps its state; only its resource is busy. Never fall through to a fresh run.
  if (err instanceof workflowDb.WorkflowResourceBusyError) {
    getLog().info(
      {
        workflowName: workflow.name,
        runId: resumableRun.id,
        blocker: err.blocker,
        refusal: err.refusal,
      },
      'orchestrator.resume_resource_busy'
    );
    await platform.sendMessage(
      conversationId,
      `⏳ **${workflow.name}** cannot resume yet. ${err.message}` + deferredNote
    );
    return;
  }
  // The failed run stays failed while another run of its workflow works its item.
  if (err instanceof WorkflowItemHeldError) {
    getLog().info(
      { workflowName: workflow.name, runId: resumableRun.id, holderRunId: err.holderRunId },
      'orchestrator.resume_item_held'
    );
    await platform.sendMessage(
      conversationId,
      `⏳ **${workflow.name}** cannot resume while another run works its item. ${err.message}` +
        deferredNote
    );
    return;
  }
  // The failed run stays failed; the install runs as many runs as it holds.
  if (err instanceof RunLimitError) {
    getLog().info(
      { workflowName: workflow.name, runId: resumableRun.id, ...err.runLimit },
      'orchestrator.resume_run_limit_full'
    );
    await platform.sendMessage(
      conversationId,
      `⏳ **${workflow.name}** cannot resume yet. ${err.message} Resume it once a run ends.` +
        deferredNote
    );
    return;
  }
  throw err;
}
