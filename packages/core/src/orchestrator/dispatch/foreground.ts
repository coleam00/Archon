import * as sqlIsolation from '@archon/core/db/isolation-environments';
import {
  admitNativeResourceStart,
  readResourceStartAfterFailure,
} from '@archon/workflows/resource-start-store';
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
      (workflow.resource || workflow.worktree?.enabled !== false) &&
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
    await admitForegroundResource(scope, launch, setupDeps, setupRun);
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
    if (
      setupRun &&
      !foregroundSubmitted &&
      (await canFailSetupRun(setupDeps, workflow, setupRun, error))
    )
      await requireTerminalStatusWrite(
        setupDeps.store.failWorkflowRun(setupRun.id, toError(error).message, {
          exitReason: 'launch_failed',
          pendingOnly: true,
        }),
        { workflowRunId: setupRun.id, site: 'foreground.preparation_failed' }
      );
    throw error;
  } finally {
    await setupOwner?.close();
  }
}

async function canFailSetupRun(
  deps: ReturnType<typeof createWorkflowDeps>,
  workflow: ResolvedWorkflow,
  run: WorkflowRun,
  error: unknown
): Promise<boolean> {
  if (error instanceof TerminalStatusWriteError) return false;
  if (!workflow.resource) return true;
  return (await readResourceStartAfterFailure(deps.store, run.id, error))?.status !== 'queued';
}

async function admitForegroundResource(
  scope: DispatchScope,
  launch: ForegroundLaunch,
  setupDeps: ReturnType<typeof createWorkflowDeps>,
  setupRun: WorkflowRun | undefined
): Promise<void> {
  const { workflow, adoptionLane } = launch;
  if (!workflow.resource || !setupRun) return;
  const existingEnvironment =
    workflow.worktree?.enabled !== false &&
    scope.codebase.kind !== 'folder' &&
    !adoptionLane &&
    scope.conversation.isolation_env_id
      ? await sqlIsolation.getById(scope.conversation.isolation_env_id)
      : null;
  const reusableEnvironment =
    launch.adoptedEnvironment ??
    (existingEnvironment?.status === 'active' ? existingEnvironment : undefined);
  await admitNativeResourceStart(
    setupDeps.store,
    workflow,
    setupRun,
    {
      cwd: reusableEnvironment?.working_path ?? scope.codebase.default_cwd,
      conversationId: scope.conversationId,
      isolation:
        workflow.worktree?.enabled === false || scope.codebase.kind === 'folder'
          ? { kind: 'in-place' }
          : {
              kind: 'worktree',
              ...(adoptionLane?.kind === 'checkout-branch'
                ? { branch: adoptionLane.taskBranch.branch }
                : reusableEnvironment
                  ? { branch: reusableEnvironment.branch_name }
                  : {}),
            },
    },
    {
      onWaiting: async (resource, requestId) => {
        await scope.platform.sendMessage(
          scope.conversationId,
          `Waiting for resource '${resource}' (request ${requestId}).`
        );
      },
    }
  );
}

function createSetupRun(
  setupDeps: ReturnType<typeof createWorkflowDeps>,
  { conversation, codebase, userId, userMessage, declaredContinuation }: DispatchScope,
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
      ...(declaredContinuation ? { [CONTINUATION_METADATA_KEY]: declaredContinuation.stamp } : {}),
    },
    ...(declaredContinuation ? { adopted_from_run_id: declaredContinuation.run.id } : {}),
  });
}
