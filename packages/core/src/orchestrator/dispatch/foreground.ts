import { RUN_AI_CONFIGURATION_METADATA_KEY } from '@archon/workflows/run-ai-configuration';
import { WORKFLOW_RUN_CONFIG_METADATA_KEY } from '@archon/workflows/run-config';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import {
  CONTINUATION_METADATA_KEY,
  SUBRUN_METADATA_KEYS,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import {
  TerminalStatusWriteError,
  requireTerminalStatusWrite,
} from '@archon/workflows/terminal-status-write';
import { startRunLiveOwner } from '../../services/run-live-owner';
import { toError } from '../../utils/error';
import { createWorkflowDeps } from '../../workflows/store-adapter';
import { recordSetupRunSource, retainSetupRunSource } from '../../workflows/worktree-setup';
import { submitFreshForeground } from './fresh';
import { resolveForegroundIsolation } from './isolation';
import type { Continuation } from './request';
import { continueForegroundResume } from './resume';
import type {
  AdoptedEnvironment,
  AdoptionLane,
  CapturedSource,
  DispatchScope,
  PreparedAiConfiguration,
} from './scope';

/** Everything the foreground run needs once the dispatch has decided to run here. */
export interface ForegroundLaunch {
  workflow: ResolvedWorkflow;
  continuation: Continuation;
  freshCaptured: CapturedSource | undefined;
  adoptedEnvironment: AdoptedEnvironment | undefined;
  adoptionLane: AdoptionLane | undefined;
  preparedAiConfiguration: PreparedAiConfiguration | undefined;
  resolvedInputs: Record<string, string> | undefined;
  deferredInputError: Error | undefined;
  prepareLaunchAiConfiguration: (definition: ResolvedWorkflow) => Promise<PreparedAiConfiguration>;
}

/**
 * Run the workflow in this process: create the run row its worktree setup reports to,
 * resolve isolation, then continue the detected run or submit a fresh one. A run row
 * created here that never reached the engine is failed before the error propagates.
 */
export async function dispatchForeground(
  scope: DispatchScope,
  launch: ForegroundLaunch
): Promise<void> {
  const { workflow, continuation, adoptionLane, preparedAiConfiguration } = launch;
  const { resumableRun, willContinueExistingRun } = continuation;
  const setupDeps = createWorkflowDeps();
  let freshCaptured = launch.freshCaptured;
  let setupRun: WorkflowRun | undefined;
  let setupOwner: Awaited<ReturnType<typeof startRunLiveOwner>> | undefined;
  let foregroundSubmitted = false;
  try {
    if (
      !willContinueExistingRun &&
      workflow.worktree?.enabled !== false &&
      freshCaptured &&
      preparedAiConfiguration
    ) {
      setupOwner = await startRunLiveOwner(freshCaptured.preparedSource.runId);
      setupRun = await createSetupRun(
        setupDeps,
        scope,
        launch,
        freshCaptured,
        preparedAiConfiguration
      );
      freshCaptured = {
        ...freshCaptured,
        preparedSource: await retainSetupRunSource(
          setupDeps,
          setupRun,
          freshCaptured.preparedSource,
          scope.owner,
          scope.codebase.default_cwd,
          scope.codebase.id
        ),
      };
    }
    const isolation = await resolveForegroundIsolation(scope, {
      workflow,
      willContinueExistingRun,
      resumableRun,
      adoptedEnvironment: launch.adoptedEnvironment,
      adoptionLane,
      setupDeps,
      setupRun,
      preparedAiConfiguration,
    });
    if (isolation === undefined) return;
    const { cwd, cutFromCommit, ownedWorktree } = isolation;

    if (adoptionLane?.kind === 'checkout-branch' && freshCaptured) {
      freshCaptured = {
        ...freshCaptured,
        preparedSource: { ...freshCaptured.preparedSource, origin: cwd },
      };
      if (setupRun) await recordSetupRunSource(setupDeps, setupRun, freshCaptured.preparedSource);
    }

    // `resumableRun` was resolved above the signature gate (see `detectContinuation`):
    // resume detection runs for ALL platforms, so a prior run for this workflow in a
    // resumable state (paused — including approved-awaiting-resume, but excluding an
    // attention wait unless explicitly resumed — or failed) in this conversation+
    // codebase is continued rather than dispatched fresh. This ensures chat platforms
    // (slack, telegram, discord, github) resume after approval gates just like web does.
    if (resumableRun?.working_path) {
      await continueForegroundResume(scope, {
        workflow,
        resumableRun,
        resumableWorkingPath: resumableRun.working_path,
        resolvedInputs: launch.resolvedInputs,
        deferredInputError: launch.deferredInputError,
        prepareLaunchAiConfiguration: launch.prepareLaunchAiConfiguration,
      });
    } else {
      await submitFreshForeground(scope, {
        workflow,
        freshCaptured,
        cwd,
        cutFromCommit,
        ownedWorktree,
        preparedAiConfiguration,
        setupRun,
        setupOwner,
        resolvedInputs: launch.resolvedInputs,
        onSubmitted: () => {
          foregroundSubmitted = true;
        },
      });
    }
  } catch (error) {
    if (setupRun && !foregroundSubmitted && !(error instanceof TerminalStatusWriteError))
      await requireTerminalStatusWrite(
        setupDeps.store.failWorkflowRun(setupRun.id, toError(error).message, {
          exitReason: 'launch_failed',
        }),
        { workflowRunId: setupRun.id, site: 'foreground.preparation_failed' }
      );
    throw error;
  } finally {
    await setupOwner?.close();
  }
}

/** The run row a fresh worktree run is created under before its worktree setup runs. */
function createSetupRun(
  setupDeps: ReturnType<typeof createWorkflowDeps>,
  { conversation, codebase, userId, userMessage, options }: DispatchScope,
  { workflow, resolvedInputs }: ForegroundLaunch,
  freshCaptured: CapturedSource,
  preparedAiConfiguration: PreparedAiConfiguration
): Promise<WorkflowRun> {
  return setupDeps.store.createWorkflowRun({
    id: freshCaptured.preparedSource.runId,
    workflow_name: workflow.name,
    origin: { conversationId: conversation.id, parentConversationId: conversation.id, userId },
    codebase_id: codebase.id,
    user_message: userMessage,
    metadata: {
      [RUN_AI_CONFIGURATION_METADATA_KEY]: preparedAiConfiguration.aiConfigurationSnapshot,
      ...(preparedAiConfiguration.runConfigMetadata
        ? { [WORKFLOW_RUN_CONFIG_METADATA_KEY]: preparedAiConfiguration.runConfigMetadata }
        : {}),
      ...(resolvedInputs ? { [SUBRUN_METADATA_KEYS.inputs]: resolvedInputs } : {}),
      ...(options?.adoptRunId || options?.supersedesRunId
        ? { [CONTINUATION_METADATA_KEY]: { mode: options.adoptRunId ? 'adopt' : 'supersede' } }
        : {}),
    },
    ...(options?.adoptRunId || options?.supersedesRunId
      ? { adopted_from_run_id: options.adoptRunId ?? options.supersedesRunId }
      : {}),
  });
}
