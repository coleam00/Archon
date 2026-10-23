import type { OwnedRunLease } from '../utils/owned-run-lease';
import { disposeWorkflowSource } from '@archon/workflows/run-source';
import {
  WorkflowExecutionHandoffError,
  type IWorkflowEngine,
  type WorkflowRunSubscription,
} from '@archon/workflows/engine-port';
import { WorkflowResourceBusyError } from '@archon/workflows/store';
import { isTerminalRunStatus, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { createCodebaseChildResolver } from '@archon/core/workflows/child-isolation-resolver';
import {
  registerOwnedRunTermination,
  registerResumePreparationTermination,
} from '../utils/owned-run-termination';
import { getLog } from './workflow-shared';
import { type OpenToolCalls, presentRunResult, workflowEventLine } from './workflow-run-output';
import { maybePrintTierNotice } from './workflow-run-preflight';
import {
  destroyRunContainer,
  readUnresolvedWriteback,
  warnPreservedContainer,
} from './workflow-isolation';
import type { PendingWaitContinuation } from './workflow-wait-continuation';
import {
  defersContainerResume,
  provisionWorkspace,
  recordConversationLaunch,
  type ForegroundLaunch,
  type RunWorkspace,
} from './workflow-run-launch';

type RunResult = Awaited<ReturnType<IWorkflowEngine['submit']>>;
type CommonRunOptions = Parameters<IWorkflowEngine['resume']>[0]['options'];
type OnExecutionClaimed = NonNullable<CommonRunOptions>['onExecutionClaimed'];

/** What the foreground wait observed; the signal teardown reads it while the run is live. */
interface RunExecution {
  result: RunResult | undefined;
  progress: WorkflowRunSubscription | undefined;
  /**
   * Set once container ownership passes on (a pause, handoff, or un-applied write-back),
   * so a signal during the final progress drain does not destroy it.
   */
  containerPreserved: boolean;
}

/** The container this process tears down: one the folder seam prepared an env for. */
function ownedContainer(
  workspace: RunWorkspace
): { backend: NonNullable<RunWorkspace['container']>['backend']; envId: string } | undefined {
  const container = workspace.container;
  return container?.envId ? { backend: container.backend, envId: container.envId } : undefined;
}

/**
 * Execute the provisioned run in this process, wait for it to settle, and report it.
 *
 * Graceful-termination guard rails (#1123) settle only THE run this process is
 * driving. The run id is reserved by source capture before a fresh execution and
 * already exists on resume or a detached handoff — never from a conversation-wide
 * "active run" query, which can match a run driven by another process (children
 * share parent_conversation_id).
 */
export async function executeOwnedRun(
  launch: ForegroundLaunch,
  lease: OwnedRunLease
): Promise<PendingWaitContinuation | undefined> {
  const { request, admission, workspace } = launch;
  const { host, options } = request;
  const ownedRunId =
    launch.resumable?.id ?? admission.preCreatedRun?.id ?? admission.preparedSource?.runId;
  if (ownedRunId === undefined) throw new Error('Workflow execution has no resolved run ID');
  const execution: RunExecution = {
    result: undefined,
    progress: undefined,
    containerPreserved: false,
  };
  let ownedExecutionClaim: string | null | undefined;
  const onExecutionClaimed: OnExecutionClaimed = claim => {
    ownedExecutionClaim = claim;
  };
  let deregisterTermination: (() => void) | undefined;
  const registerTermination = (): void => {
    deregisterTermination = registerOwnedRunTermination({
      store: host.deps.store,
      runId: ownedRunId,
      getExecutionClaim: () => ownedExecutionClaim,
      isExecutionSettled: () => execution.result !== undefined,
      logModule: 'cli.workflow',
      liveOwner: {
        isStopRequested: () => lease.isStopRequested(),
        close: () => lease.close(),
        registerTerminationPreparation: prepare => lease.registerTerminationPreparation(prepare),
      },
      detachedProcessOwner: request.detachedProcessOwner,
      teardown: signal => teardownOnSignal(launch, execution, signal),
    });
  };

  // A genuine container-teardown failure captured in the finally, rethrown AFTER
  // the finally when the run itself succeeded — so a leaked privileged container
  // fails the CLI instead of reporting success + exit 0.
  let containerTeardownError: Error | undefined;
  const preparationTermination = defersContainerResume(launch)
    ? registerResumePreparationTermination()
    : undefined;
  if (!preparationTermination) registerTermination();
  try {
    // One-time-per-version notice when the workflow uses unconfigured tier keywords.
    await maybePrintTierNotice(
      host,
      admission.workflow,
      workspace.workingCwd,
      admission.cliUserId,
      options.quiet
    );
    await announceDispatch(launch);

    // Progress lines render from the run's committed rows, its sub-runs' included.
    // Subscribed before submit or resume so the run's first row cannot be missed.
    if (!options.quiet) execution.progress = await subscribeProgress(launch, ownedRunId);
    // Leased before resume admission: an attempt racing a live owner stops here,
    // before the engine claims the run or the container restarts.
    await lease.start(ownedRunId);
    preparationTermination?.signal.throwIfAborted();
    const prepareExecution = preparationTermination
      ? async (run: WorkflowRun) => {
          preparationTermination.signal.throwIfAborted();
          await provisionWorkspace(launch, lease, run);
          preparationTermination.signal.throwIfAborted();
          await recordConversationLaunch(launch);
          preparationTermination.signal.throwIfAborted();
          registerTermination();
          preparationTermination.dispose();
          return {
            cwd: workspace.workingCwd,
            options: commonRunOptions(launch, onExecutionClaimed),
          };
        }
      : undefined;
    execution.result = await driveRun(launch, lease, onExecutionClaimed, prepareExecution);
  } catch (error) {
    if (error instanceof WorkflowExecutionHandoffError) execution.containerPreserved = true;
    throw error;
  } finally {
    try {
      containerTeardownError = await settleRun(
        launch,
        execution,
        ownedRunId,
        deregisterTermination
      );
    } finally {
      preparationTermination?.dispose();
    }
  }
  const { result } = execution;

  // A container teardown failure on an otherwise-SUCCESSFUL run must fail the CLI
  // (non-zero exit) — a leaked privileged container is not a success. On a failed
  // run the workflow-failed error below already exits non-zero (the leak was
  // logged loudly above), so don't mask it.
  if (containerTeardownError && result?.success) {
    throw containerTeardownError;
  }
  if (!result) {
    // The engine threw and it was re-thrown out of the try; this line is unreachable in
    // practice (the throw propagates), but it satisfies the narrowing below.
    throw new Error('Workflow did not produce a result.');
  }
  return presentRunResult({
    host,
    workflow: admission.workflow,
    result,
    adapter: launch.adapter,
    conversationId: launch.conversationId,
    destination: launch.destination,
    detachedProcessOwner: request.detachedProcessOwner,
  });
}

async function teardownOnSignal(
  launch: ForegroundLaunch,
  execution: RunExecution,
  signal: string
): Promise<void> {
  // Destroy the isolation container so Ctrl-C / SIGTERM doesn't orphan a
  // PRIVILEGED container — the forced exit bypasses the teardown `finally`.
  const container = ownedContainer(launch.workspace);
  if (container && !execution.containerPreserved) {
    try {
      await container.backend.destroy(container.envId);
    } catch (destroyErr) {
      console.error(
        `\nWARNING: could not remove the isolation container on ${signal}: ` +
          `${(destroyErr as Error).message}. Remove it manually: ` +
          'docker ps -a --filter label=diy.archon.managed=true'
      );
    }
  }
  // Reclaim the staged capture for the same reason: the ownership `finally` —
  // whose whole premise is "whichever way we leave" — never runs. Ctrl-C during
  // isolation resolution or worktree creation would otherwise strand a complete
  // frozen tree.
  //
  // The rm targets the ORIGINAL staged path pinned at prepare time, not
  // `preparedSource.anchor.root` (see `originalStagedRoot`'s note).
  // For container runs that path was renamed away by `finalizeWorkflowSource`
  // and `preparedSource.anchor.root` is now the LIVE source directory —
  // rm-ing it mid-execution would destroy the run's source.
  const { originalStagedRoot } = launch.admission;
  if (originalStagedRoot) {
    await disposeWorkflowSource({ captureRoot: originalStagedRoot });
  }
}

/**
 * Notify Web UI that a workflow is dispatching.
 * Mirrors the orchestrator dispatch message structure (category/segment/workflowDispatch),
 * but omits the rocket emoji and "(background)" qualifier since the CLI runs synchronously.
 * In the CLI path there is no separate worker conversation — the CLI itself
 * is both the dispatcher and the executor, so workerConversationId === conversationId.
 */
async function announceDispatch(launch: ForegroundLaunch): Promise<void> {
  const { adapter, conversationId } = launch;
  const workflowName = launch.admission.workflow.name;
  try {
    await adapter.sendMessage(conversationId, `Dispatching workflow: **${workflowName}**`, {
      category: 'workflow_dispatch_status',
      segment: 'new',
      workflowDispatch: { workerConversationId: conversationId, workflowName },
    });
  } catch (dispatchError) {
    getLog().warn(
      { err: dispatchError as Error, conversationId },
      'cli.workflow_dispatch_surface_failed'
    );
  }
}

async function subscribeProgress(
  launch: ForegroundLaunch,
  runId: string
): Promise<WorkflowRunSubscription | undefined> {
  const openToolCalls: OpenToolCalls = new Map();
  const verbose = launch.request.options.verbose ?? false;
  try {
    return await launch.request.host.engine.subscribe(runId, ({ event }) => {
      const line = workflowEventLine(event, verbose, openToolCalls);
      if (line !== undefined) process.stderr.write(`${line}\n`);
    });
  } catch (subscribeErr) {
    getLog().warn({ err: subscribeErr as Error, runId }, 'cli.workflow_progress_subscribe_failed');
    process.stderr.write(
      `[workflow] Progress output unavailable: ${(subscribeErr as Error).message}\n`
    );
    return undefined;
  }
}

/** Resume the bound run, or submit a fresh one, and wait for it to settle. */
async function driveRun(
  launch: ForegroundLaunch,
  lease: OwnedRunLease,
  onExecutionClaimed: OnExecutionClaimed,
  prepareExecution: Parameters<IWorkflowEngine['resume']>[0]['prepareExecution']
): Promise<RunResult> {
  const { resumable } = launch;
  if (launch.request.options.resume && resumable) {
    return resumeRun(launch, resumable, onExecutionClaimed, prepareExecution);
  }
  return submitRun(launch, lease, commonRunOptions(launch, onExecutionClaimed));
}

function commonRunOptions(
  launch: ForegroundLaunch,
  onExecutionClaimed: OnExecutionClaimed
): CommonRunOptions {
  const { request, admission, codebase, workspace, codebaseDefaultBranch } = launch;
  // Container run context for the engine (Phase C): the write-back backend port +
  // env id + policy. The executor drives suspend-on-pause and the write-back gate
  // through this. Absent for host/in-place runs.
  const container = ownedContainer(workspace);
  const overlayMode = workspace.container?.overlayMode;
  const containerRunCtx = container
    ? {
        envId: container.envId,
        writeBack: admission.workflow.container?.write_back ?? ('approve' as const),
        backend: container.backend,
        ...(overlayMode ? { overlayMode } : {}),
      }
    : undefined;
  const resolveChildIsolation = codebase
    ? createCodebaseChildResolver(
        request.host.records.isolation,
        codebase,
        {
          baseBranch: codebaseDefaultBranch,
          createdByPlatform: 'cli',
          createdByUserId: admission.cliUserId,
        },
        request.host.deps
      )
    : undefined;
  return {
    codebaseId: codebase?.id,
    source: admission.workflowEntry?.source,
    parseWarnings: admission.workflowEntry?.parseWarnings,
    baseBranch: codebaseDefaultBranch,
    baseOverride: admission.flagBase,
    execContext: workspace.execContext,
    container: containerRunCtx,
    resolveChildIsolation,
    onExecutionClaimed,
  };
}

async function resumeRun(
  launch: ForegroundLaunch,
  resumable: WorkflowRun,
  onExecutionClaimed: OnExecutionClaimed,
  prepareExecution: Parameters<IWorkflowEngine['resume']>[0]['prepareExecution']
): Promise<RunResult> {
  const { request, admission } = launch;
  const { workflowName } = request;
  // The engine calls preparation only after it admits the run, and fails the run
  // when preparation throws.
  let admitted = false;
  const prepareAdmitted =
    prepareExecution &&
    ((run: WorkflowRun) => {
      admitted = true;
      return prepareExecution(run);
    });
  let resumeAdmission: Awaited<ReturnType<IWorkflowEngine['resume']>>;
  try {
    resumeAdmission = await request.host.engine.resume({
      platform: launch.adapter,
      conversationId: launch.conversationId,
      cwd: launch.workspace.workingCwd,
      legacyWorkflow: admission.workflow,
      userMessage: request.userMessage,
      run: resumable,
      cursor: request.options.continuationCursor,
      options: prepareAdmitted ? undefined : commonRunOptions(launch, onExecutionClaimed),
      ...(prepareAdmitted ? { prepareExecution: prepareAdmitted } : {}),
    });
  } catch (error) {
    // The run is intact; only its resource is busy, so say that and nothing else.
    if (error instanceof WorkflowResourceBusyError)
      throw new Error(`Cannot resume workflow '${workflowName}' now: ${error.message}`, {
        cause: error,
      });
    const err = error as Error;
    if (admitted) {
      getLog().error(
        { err, workflowName, runId: resumable.id },
        'cli.workflow_resume_preparation_failed'
      );
      throw new Error(
        `Workflow '${workflowName}' failed while preparing its resumed run — ${err.message}\n` +
          `The run is marked failed; resume it with: archon workflow resume ${resumable.id}`,
        { cause: err }
      );
    }
    getLog().error(
      { err, workflowName, runId: resumable.id },
      'cli.workflow_hydrate_resume_failed'
    );
    throw new Error(
      `Cannot resume workflow '${workflowName}': failed to load prior run state — ${err.message}`,
      { cause: err }
    );
  }
  if (!resumeAdmission.accepted) throw nothingToResumeError(launch, resumable);
  request.notifyResumeAccepted?.(resumeAdmission.runId);
  return resumeAdmission.settled;
}

function nothingToResumeError(launch: ForegroundLaunch, resumable: WorkflowRun): Error {
  const { workflowName } = launch.request;
  // `--branch` is only runnable when the prior run used worktree isolation:
  // folder projects reject worktree options outright, and an in-place repo run
  // cannot be relaunched onto the branch its own checkout holds. A stale-running
  // orphan cannot be superseded until it is released, so name that step first.
  const worktreeBranch = launch.isFolderCodebase ? undefined : launch.resumeBranch;
  const unblock = isTerminalRunStatus(resumable.status)
    ? ''
    : `The run is still marked ${resumable.status}; release it before relaunching:\n` +
      `  archon workflow abandon ${resumable.id}\n`;
  const relaunch = [
    'archon workflow run',
    workflowName,
    ...(worktreeBranch ? ['--branch', worktreeBranch] : []),
    '--supersedes',
    resumable.id,
  ].join(' ');
  return new Error(
    `Cannot resume: the prior run for '${workflowName}' has no completed nodes and no interactive-loop state.\n` +
      unblock +
      (worktreeBranch
        ? 'Nothing can be skipped, so relaunch on the same branch instead:\n'
        : 'Nothing can be skipped, so start a fresh run instead:\n') +
      `  ${relaunch}`
  );
}

function submitRun(
  launch: ForegroundLaunch,
  lease: OwnedRunLease,
  commonOptions: CommonRunOptions
): Promise<RunResult> {
  const { request, admission, workspace, continuation, conversation } = launch;
  const { modelOverrides, runConfig, preCreatedRun } = admission;
  const { adoptedFromRunId, continuationMode } = continuation;
  const opts = {
    ...commonOptions,
    // A resume replays the inputs already on its row.
    inputs: admission.resolvedInputs,
    ...(modelOverrides
      ? { modelOverrideLayer: { kind: 'raw' as const, overrides: modelOverrides } }
      : {}),
    ...(runConfig ? { runConfig } : {}),
    preparedAiConfiguration: launch.preparedAiConfiguration,
    // The frozen source this run executes, captured before the workflow was even
    // selected. A resume ignores it and loads the source recorded on its own row.
    preparedSource: admission.preparedSource,
    capturedSourceOwner: request.owner,
    // Between-run continuation (#2747): written once onto the fresh row.
    ...(adoptedFromRunId !== undefined ? { adoptedFromRunId, continuationMode } : {}),
    ...(preCreatedRun ? { preCreatedRun } : {}),
    ...(workspace.cutFromCommit !== undefined ? { cutFromCommit: workspace.cutFromCommit } : {}),
    ownedWorktree: workspace.ownedWorktree,
  };
  lease.executionSubmitted = true;
  return request.host.engine.submit({
    platform: launch.adapter,
    conversationId: launch.conversationId,
    cwd: workspace.workingCwd,
    workflow: admission.workflow,
    userMessage: request.userMessage,
    origin: {
      ...(conversation ? { conversationId: conversation.id } : {}),
      userId: admission.cliUserId,
    },
    options: opts,
  });
}

/**
 * A published pause relinquishes cleanup authority even when execution rejects.
 * Resumes that throw before returning a result also retain their overlay for retry,
 * including prepared-context validation failures.
 * Earlier setup failures still need teardown to avoid orphaning a privileged container.
 */
async function settleRun(
  launch: ForegroundLaunch,
  execution: RunExecution,
  runId: string,
  deregisterTermination: (() => void) | undefined
): Promise<Error | undefined> {
  const { result } = execution;
  const store = launch.request.host.deps.store;
  const container = ownedContainer(launch.workspace);
  const keepContainer =
    execution.containerPreserved ||
    Boolean(
      result && ('handedOff' in result || (result.success && 'paused' in result && result.paused))
    );
  if (keepContainer) deregisterTermination?.();
  // H2 — preserve the container+volume whenever the un-applied overlay is still the
  // only copy of the run's changes: a PAUSED run (awaiting the decision) OR a
  // TERMINAL run whose write-back never resolved (e.g. a partial applyChanges threw
  // → run failed with pending_writeback still un-applied). Destroying then would
  // silently discard the changes despite the "reconcile manually" message. A failed
  // run stays resumable, so `archon workflow resume <id>` re-runs the apply.
  let unresolvedWriteback = false;
  // Kept until the lookup below proves it may go: a signal mid-lookup must not
  // destroy an overlay that may be the only copy of the changes.
  execution.containerPreserved = true;
  if (container && !keepContainer && result?.workflowRunId) {
    unresolvedWriteback = await readUnresolvedWriteback(
      store,
      result.workflowRunId,
      container.envId
    );
  }
  execution.containerPreserved =
    (defersContainerResume(launch) && result === undefined) || keepContainer || unresolvedWriteback;

  // Renders the rows the run committed since the last poll, up to its settled state.
  // Retain signal teardown only while this process still owns execution cleanup.
  await execution.progress?.close().catch((drainErr: unknown) => {
    getLog().warn({ err: drainErr as Error, runId }, 'cli.workflow_progress_drain_failed');
    process.stderr.write(
      `[workflow] Progress output may be incomplete: ${(drainErr as Error).message}\n`
    );
  });

  // Deregister the signal handlers now that the run's lifecycle is settled
  // (paused / completed / failed, or the throw propagating out of this
  // finally). A signal from here on gets default handling — the destructive
  // failWorkflowRun cleanup must never fire against a settled run (#1123),
  // and removal keeps repeated workflowRunCommand calls in one process from
  // stacking handlers.
  deregisterTermination?.();

  if (container && unresolvedWriteback) {
    warnPreservedContainer(container.envId, result?.workflowRunId);
  }
  if (container && !execution.containerPreserved) {
    return destroyRunContainer(store, container.backend, container.envId, result?.workflowRunId);
  }
  return undefined;
}
