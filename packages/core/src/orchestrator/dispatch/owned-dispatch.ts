import { assertRunCredentials } from '@archon/workflows/run-preflight';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import * as db from '../../db/conversations';
import { createWorkflowDeps } from '../../workflows/store-adapter';
import { getLog } from '../agent-log';
import { dispatchBackgroundWorkflow } from './background';
import { dispatchForeground } from './foreground';
import { runSignatureGates, sendRunStartNotices } from './gates';
import {
  detectContinuation,
  resolveDispatchAdoption,
  resolveRequestedWorkflow,
  type Continuation,
} from './request';
import { buildFailedRunResumePrompt } from './resume-prompt';
import { createDispatchScope, type DispatchScope, type DispatchTarget } from './scope';
import { prepareExecutableSource, prepareLaunchAiConfiguration } from './source';

/**
 * Dispatch a workflow after the orchestrator resolves a project.
 * Auto-attaches the project to the conversation, resolves isolation, and executes.
 * Every early return after a capture leaves it to the target's owner to reclaim.
 *
 * TODO(#988): Move to operations/ once dispatchBackgroundWorkflow is extracted
 * from the orchestrator (currently coupled to SSE bridging infrastructure).
 */
export async function dispatchOrchestratorWorkflowOwned(target: DispatchTarget): Promise<void> {
  const scope = createDispatchScope(target);
  const { platform, conversationId, conversation, codebase, options } = scope;

  const requested = await resolveRequestedWorkflow(scope, target.request);
  if (requested === undefined) return;
  const adoption = await resolveDispatchAdoption(scope, requested);
  const adoptionLane = adoption?.lane;
  const continuation = await detectContinuation(scope, target.request, requested);
  if (continuation === undefined) return;
  const { willContinueExistingRun } = continuation;

  const executable = await prepareExecutableSource(
    scope,
    target.request,
    requested,
    adoption,
    continuation
  );
  if (executable === undefined) return;
  const { workflow } = executable;

  const gates = await runSignatureGates(scope, workflow, willContinueExistingRun);
  if (!gates.ok) return;
  const { resolvedInputs, deferredInputError } = gates;

  await sendRunStartNotices(scope, workflow);
  if (await offerResumeChoice(scope, workflow, continuation)) return;

  // A fresh run reads repo config from the project's registered checkout, never from a
  // worktree an earlier run left on this conversation, so uncommitted and gitignored
  // config apply. An adopted worktree stays the estate. The run records the result, and
  // every continuation reuses that record.
  const launchConfigCwd =
    adoptionLane?.kind === 'reuse-worktree'
      ? adoptionLane.environment.working_path
      : codebase.default_cwd;
  const prepareLaunch = (
    definition: ResolvedWorkflow
  ): ReturnType<typeof prepareLaunchAiConfiguration> =>
    prepareLaunchAiConfiguration(scope, adoption, definition, launchConfigCwd);
  const preparedAiConfiguration =
    executable.branchPrepared ??
    (!willContinueExistingRun ? await prepareLaunch(workflow) : undefined);
  if (preparedAiConfiguration)
    await assertRunCredentials(createWorkflowDeps(), preparedAiConfiguration, {
      cwd: launchConfigCwd,
    });

  // Auto-attach project to conversation
  await db.updateConversation(conversation.id, {
    codebase_id: codebase.id,
  });

  if (!willContinueExistingRun && platform.capabilities.defaultWorkflowDispatch === 'background') {
    // Background dispatch: adapter-default workflows with no resumable run.
    // This is the console's default path, so it is exactly where a console-supplied
    // input map must not be dropped.
    await dispatchBackgroundWorkflow(
      {
        platform,
        conversationId,
        cwd: launchConfigCwd,
        originalMessage: scope.userMessage,
        conversationDbId: conversation.id,
        codebaseId: codebase.id,
        availableWorkflows: [workflow],
        isolationHints: scope.isolationHints,
        userId: scope.userId,
        source: scope.source,
        parseWarnings: scope.parseWarnings,
        inputs: resolvedInputs,
        modelOverrides: options?.modelOverrides,
        runConfig: options?.runConfig,
        adoptRunId: options?.adoptRunId,
        supersedesRunId: options?.supersedesRunId,
        adoptionLane,
      },
      workflow
    );
    return;
  }

  await dispatchForeground(scope, {
    workflow,
    continuation,
    freshCaptured: executable.freshCaptured,
    adoptedEnvironment: executable.adoptedEnvironment,
    adoptionLane,
    preparedAiConfiguration,
    resolvedInputs,
    deferredInputError,
    prepareLaunchAiConfiguration: prepareLaunch,
  });
}

/**
 * A prior run that is neither paused nor explicitly resumed is not continued
 * implicitly: show the resume / abandon / force choice instead. True when shown.
 */
async function offerResumeChoice(
  { platform, conversationId, userMessage }: DispatchScope,
  workflow: ResolvedWorkflow,
  { resumableRun, explicitResumeRequested }: Continuation
): Promise<boolean> {
  if (!resumableRun?.working_path || resumableRun.status === 'paused' || explicitResumeRequested)
    return false;
  getLog().info(
    {
      workflowName: workflow.name,
      resumableRunId: resumableRun.id,
      platformType: platform.getPlatformType(),
    },
    'orchestrator.failed_resume_user_prompted'
  );
  await platform.sendMessage(
    conversationId,
    buildFailedRunResumePrompt(platform, workflow.name, resumableRun, userMessage)
  );
  return true;
}
