import type { WorkflowResumeAdmission } from '@archon/workflows/engine-port';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { inspectResumableRun } from '@archon/workflows/run-resume';
import { assertRunCredentials } from '@archon/workflows/run-preflight';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { spellWorkflowCommand, type WorkflowDeps } from '@archon/workflows/deps';
import * as workflowDb from '../../db/workflows';
import { startRunLiveOwner, withRunLiveOwner } from '../../services/run-live-owner';
import { createWorkflowDeps } from '../../workflows/store-adapter';
import { getLog } from '../agent-log';
import { formatResumableRunState } from './resume-prompt';
import type { DispatchScope, PreparedAiConfiguration } from './scope';
import { captureFreshSource } from './source';

export interface ForegroundResumeInput {
  workflow: ResolvedWorkflow;
  resumableRun: WorkflowRun;
  resumableWorkingPath: string;
  resolvedInputs: Record<string, string> | undefined;
  deferredInputError: Error | undefined;
  prepareLaunchAiConfiguration: (definition: ResolvedWorkflow) => Promise<PreparedAiConfiguration>;
}

/**
 * Continue the detected run in the foreground, or start fresh in its worktree when it has
 * nothing to resume.
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
  // An empty resume is the explicit restart path below; a lost claim never
  // falls through to a fresh run on another owner's worktree.
  const deps = createWorkflowDeps();
  const engine = new InProcessWorkflowEngine(deps);
  const resumeOwner = await startRunLiveOwner(resumableRun.id);
  let resumeOwnerClosed = false;
  try {
    const admission = await admitResume(scope, input, deps, engine);
    if (admission === undefined) return;
    if (admission.accepted) {
      await admission.settled;
      return;
    }
    await resumeOwner.close();
    resumeOwnerClosed = true;
    await startFreshInResumedWorktree(scope, input, engine);
  } finally {
    if (!resumeOwnerClosed) await resumeOwner.close();
  }
}

/** The engine's answer to resuming the run; `undefined` after telling the user it did not. */
async function admitResume(
  scope: DispatchScope,
  input: ForegroundResumeInput,
  deps: WorkflowDeps,
  engine: InProcessWorkflowEngine
): Promise<WorkflowResumeAdmission | undefined> {
  const { platform, conversationId, conversation, codebase, userId, options } = scope;
  const { workflow, resumableRun } = input;
  try {
    const needsResumeNotice =
      options?.runConfig !== undefined ||
      Object.keys(options?.inputs ?? {}).length > 0 ||
      Object.keys(options?.modelOverrides?.tiers ?? {}).length > 0 ||
      Object.keys(options?.modelOverrides?.aliases ?? {}).length > 0;
    if (needsResumeNotice && (await inspectResumableRun(deps, resumableRun)) === null)
      return { accepted: false, reason: 'nothing-to-resume' };
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
  throw err;
}

/**
 * Hydration found nothing worth resuming, so this is the ONE continuation path that
 * creates a fresh run row — in the resumed run's worktree.
 */
async function startFreshInResumedWorktree(
  scope: DispatchScope,
  input: ForegroundResumeInput,
  engine: InProcessWorkflowEngine
): Promise<void> {
  const { owner, platform, conversationId, conversation, codebase, userId, options } = scope;
  // A contract violation deferred at the gate is live again and must be surfaced
  // before any AI cost.
  if (input.deferredInputError) {
    await platform.sendMessage(conversationId, input.deferredInputError.message);
    return;
  }
  // This branch IS a fresh run, even though the dispatch entered via the resume
  // menu (#2686). Capture the source here so the run freezes the bytes it actually
  // executes against; without this it would inherit the prior run's frozen graph
  // and let the executor fall back to live command/script lookup, which is exactly
  // the mixed-vintage shape #2660 exists to remove.
  const captured = await captureFreshSource(
    owner,
    scope.runCwd,
    input.workflow,
    conversationId,
    platform
  );
  if (!captured) return; // capture failed, message already sent
  const workflow = captured.workflow;
  const freshAiConfiguration = await input.prepareLaunchAiConfiguration(workflow);
  await assertRunCredentials(createWorkflowDeps(), freshAiConfiguration, { cwd: scope.runCwd });
  await platform.sendMessage(
    conversationId,
    `⚠️ Prior run for **${workflow.name}** had no completed nodes; starting fresh in the same worktree.`
  );
  // The wrap owns the capture until `executeWorkflow`'s rename succeeds; the
  // executor adopts for us there (see #2690). `captured.preparedSource` proves
  // the helper has already run `owner.hold`, which is the only thing the wrap
  // needs to know to reclaim if the rename fails.
  await withRunLiveOwner(captured.preparedSource.runId, {}, async () => {
    await engine.submit({
      platform,
      conversationId,
      cwd: input.resumableWorkingPath,
      workflow,
      userMessage: scope.userMessage,
      origin: {
        conversationId: conversation.id,
        userId,
        parentConversationId: conversation.id,
      },
      options: {
        codebaseId: codebase.id,
        source: scope.source,
        preparedSource: captured.preparedSource,
        preparedAiConfiguration: freshAiConfiguration,
        parseWarnings: scope.parseWarnings,
        baseBranch: scope.codebaseBaseBranch,
        resolveChildIsolation: scope.resolveChildIsolation,
        capturedSourceOwner: owner,
        // This branch creates a FRESH run row (the prior run had nothing to resume),
        // so the supplied inputs still need stamping.
        inputs: input.resolvedInputs,
        ...(options?.modelOverrides
          ? {
              modelOverrideLayer: {
                kind: 'raw' as const,
                overrides: options.modelOverrides,
              },
            }
          : {}),
        ...(options?.runConfig ? { runConfig: options.runConfig } : {}),
      },
    });
  });
}
