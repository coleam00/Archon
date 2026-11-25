import { CONTAINER_ISOLATION_MARKER, ISOLATION_ENV_ID_METADATA_KEY } from './schemas/run-metadata';
import { isWorkflowExecutionInterruption } from './execution-interruption';
import { currentExecutionOwner, executionClaim } from './store';
import { captureWorkflowTerminal, createLogger } from '@archon/paths';
import { recordCheckoutSample, sampleCheckout, type CheckoutSample } from './checkout-observation';
import { checkoutInUseMessage } from './checkout-in-use-message';
import { gatherDescendantRunIds } from './child-runs';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import type { ExecuteWorkflowOptions } from './executor';
import { safeSendMessage, sendCriticalMessage } from './platform-messages';
import { type RunPhase } from './executor-shared';
import { RUN_MODEL_BINDINGS_METADATA_KEY } from './model-validation';
import { RUN_AI_CONFIGURATION_METADATA_KEY } from './run-ai-configuration';
import { WORKFLOW_RUN_CONFIG_METADATA_KEY } from './run-config';
import type { RunDispatch } from './run-dispatch';
import type { ResolvedWorkflow, WorkflowExecutionResult, WorkflowRun } from './schemas';
import {
  CONTINUATION_METADATA_KEY,
  CONTINUATION_MODES,
  EXECUTION_OWNER_METADATA_KEY,
  RUN_DISPATCH_METADATA_KEY,
  SUBRUN_METADATA_KEYS,
  readSubrunMetadata,
  runInputsMetadata,
} from './schemas';
import type { CheckoutSharedEventData } from './schemas/workflow-event';
import { ContinuedItemProjectError, type WorkflowRunOrigin } from './schemas/workflow-run';
import { requireTerminalStatusWrite } from './terminal-status-write';
import { refusePendingStart } from './start-refusal';
import {
  holdWorkflowResource,
  installHold,
  itemHold,
  refuseStart,
  runLimitHold,
  waitForTurn,
} from './resource-hold';
import { resolveResultInputs, unsuppliedResultInputs } from './run-result';
import {
  ConcurrencyConfigError,
  InstallHeldError,
  PendingClaimRefusedError,
  RunLimitError,
  WorkflowItemHeldError,
} from './store/errors';
import { workflowPathPriorityTime } from './workflow-path-lock';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

export interface AdmittedRun {
  workflowRun: WorkflowRun;
  /** The starting checkout, sampled when a fresh run wins execution ownership. */
  checkoutBaselineSample: CheckoutSample | undefined;
}

/**
 * Give this process the run it will execute: create the row, or claim and stamp the one a
 * caller supplied, then hold the checkout's path lock. The caller decides whether to
 * resume by passing `preCreatedRun` (from `hydrateResumableRun`) and `priorCompletedNodes`;
 * when both are absent a fresh row is created.
 */
export async function admitWorkflowRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  userMessage: string,
  origin: WorkflowRunOrigin | undefined,
  opts: ExecuteWorkflowOptions,
  dispatch: RunDispatch
): Promise<RunPhase<AdmittedRun>> {
  const { preCreatedRun, priorCompletedNodes } = opts;
  const execContext = opts.execContext ?? { kind: 'host' };

  if (preCreatedRun && priorCompletedNodes !== undefined) {
    await notifyResumingRun(platform, conversationId, workflow.name, priorCompletedNodes);
  }

  let workflowRun: WorkflowRun;
  if (preCreatedRun) {
    workflowRun = preCreatedRun;
  } else {
    const created = await createWorkflowRunRow(
      deps,
      platform,
      conversationId,
      cwd,
      workflow,
      userMessage,
      origin,
      opts,
      dispatch
    );
    if (created.stopped) return created;
    workflowRun = created.value;
  }

  // A continuation's row already says everything this process adds: the store's resume
  // recorded this process as its owner.
  let checkoutBaselineSample: CheckoutSample | undefined;
  if (!dispatch.isContinuation) {
    const started = await startFreshRun(
      deps,
      platform,
      conversationId,
      cwd,
      workflow,
      workflowRun,
      execContext,
      opts,
      dispatch
    );
    if (started.stopped) return started;
    ({ workflowRun, checkoutBaselineSample } = started.value);
  }

  const blocked = await holdCheckoutPathLock(
    deps,
    platform,
    conversationId,
    cwd,
    workflow,
    workflowRun
  );
  if (blocked) return { stopped: true, result: blocked };
  return { stopped: false, value: { workflowRun, checkoutBaselineSample } };
}

/**
 * Claim a fresh run and record a pre-created row's invocation, then fill its `result_of`
 * inputs: read after the resource wait, they are the latest when the run starts work.
 */
async function startFreshRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  execContext: NonNullable<ExecuteWorkflowOptions['execContext']>,
  opts: ExecuteWorkflowOptions,
  dispatch: RunDispatch
): Promise<RunPhase<AdmittedRun>> {
  const notStarted = await refuseRunBeforeClaim(
    deps,
    platform,
    conversationId,
    workflow,
    workflowRun,
    dispatch.startInputs
  );
  if (notStarted) return { stopped: true, result: notStarted };
  const claimed = await claimPendingRun(
    deps,
    platform,
    conversationId,
    cwd,
    workflow,
    workflowRun,
    execContext,
    opts
  );
  if (claimed.stopped) return claimed;
  let run = workflowRun;
  if (opts.preCreatedRun) {
    const stamped = await stampPreCreatedRun(
      deps,
      platform,
      conversationId,
      cwd,
      opts.preCreatedRun,
      opts,
      dispatch
    );
    if (stamped.stopped) return stamped;
    run = stamped.value;
  }
  const resolved = await resolveResultInputs(
    deps,
    platform,
    conversationId,
    run,
    unsuppliedResultInputs(workflow, dispatch.startInputs),
    claimed.value
  );
  if (resolved.stopped) return resolved;
  return {
    stopped: false,
    value: { workflowRun: resolved.value, checkoutBaselineSample: claimed.value },
  };
}

async function notifyResumingRun(
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowName: string,
  priorCompletedNodes: NonNullable<ExecuteWorkflowOptions['priorCompletedNodes']>
): Promise<void> {
  const resumeMsg =
    priorCompletedNodes.size > 0
      ? `▶️ **Resuming** workflow \`${workflowName}\` — skipping ${String(priorCompletedNodes.size)} already-completed node(s).`
      : `▶️ **Resuming** workflow \`${workflowName}\`.`;
  await safeSendMessage(platform, conversationId, resumeMsg);
}

async function createWorkflowRunRow(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  userMessage: string,
  origin: WorkflowRunOrigin | undefined,
  opts: ExecuteWorkflowOptions,
  dispatch: RunDispatch
): Promise<RunPhase<WorkflowRun>> {
  const { preparedSource, codebaseId, issueContext, adoptedFromRunId, continuationMode } = opts;
  const { prepared, runSource } = dispatch;
  try {
    const workflowRun = await deps.store.createWorkflowRun({
      // Reserved by `prepareWorkflowSource` so the row and its already-written source
      // capture share one id; absent for callers that prepared nothing.
      ...(preparedSource ? { id: preparedSource.runId } : {}),
      workflow_name: workflow.name,
      origin,
      codebase_id: codebaseId,
      user_message: userMessage,
      working_path: cwd,
      metadata: {
        ...(issueContext ? { github_context: issueContext } : {}),
        // Between-run continuation (#2747): the mode stamp rides the same
        // creation write as `adopted_from_run_id` so both are write-once.
        ...(adoptedFromRunId
          ? { [CONTINUATION_METADATA_KEY]: { mode: continuationMode ?? CONTINUATION_MODES.adopt } }
          : {}),
        ...freshInvocationMetadata(opts, dispatch),
        // `abandon` shows this record when no owner answers (#2325). The pending claim
        // records it again, in the update that makes the run `running`.
        [EXECUTION_OWNER_METADATA_KEY]: currentExecutionOwner(),
      },
      ...(adoptedFromRunId ? { adopted_from_run_id: adoptedFromRunId } : {}),
      ...(opts.item === undefined ? {} : { item_key: opts.item }),
    });
    workflowRun.metadata = {
      ...workflowRun.metadata,
      [RUN_AI_CONFIGURATION_METADATA_KEY]: prepared.aiConfigurationSnapshot,
    };
    return { stopped: false, value: workflowRun };
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, workflowName: workflow.name, conversationId },
      'db_create_workflow_run_failed'
    );
    // No row, so no store transition will report this run: count it here, the one
    // terminal telemetry capture outside the run store.
    captureWorkflowTerminal({
      outcome: 'failed',
      workflowName: workflow.name,
      workflowSource: runSource,
      exitReason: 'run_not_created',
    });
    // A refused item is the caller's to fix, not a database fault: say what was refused.
    const refusal = err.cause instanceof ContinuedItemProjectError ? err.cause.message : null;
    await sendCriticalMessage(
      platform,
      conversationId,
      `❌ **Workflow failed**: ${refusal ?? 'Unable to start workflow (database error). Please try again later.'}`
    );
    return {
      stopped: true,
      result:
        refusal === null
          ? { success: false, error: 'Database error creating workflow run' }
          : { success: false, error: refusal, continuedItemRefused: true },
    };
  }
}

/**
 * Refuse a pending row before the claim, for every reason `refusePendingStart` decides,
 * and tell the conversation why.
 */
async function refuseRunBeforeClaim(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  startInputs: RunDispatch['startInputs']
): Promise<WorkflowExecutionResult | undefined> {
  const reason = await refusePendingStart(deps, workflow, workflowRun, startInputs);
  if (reason === undefined) return undefined;
  await sendCriticalMessage(platform, conversationId, `❌ **Workflow not started**: ${reason}`);
  return { success: false, workflowRunId: workflowRun.id, error: reason };
}

/**
 * Take the workflow's resource slot, win execution ownership of a pending row, then sample
 * the checkout the run starts from. While another run of the workflow holds the run's item,
 * or the install hold is set, the claim waits for it like a full resource, or is refused
 * under `noWait`.
 */
async function claimPendingRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  execContext: NonNullable<ExecuteWorkflowOptions['execContext']>,
  { onExecutionClaimed, noWait }: ExecuteWorkflowOptions
): Promise<RunPhase<CheckoutSample>> {
  const refused = await holdWorkflowResource(
    deps,
    platform,
    conversationId,
    cwd,
    workflow,
    workflowRun,
    noWait === true
  );
  if (refused) return { stopped: true, result: refused };
  const claim: { run?: WorkflowRun | null; error?: unknown } = {};
  const itemRefused = await waitForTurn({
    deps,
    platform,
    conversationId,
    workflowRun,
    noWait: noWait === true,
    attempt: async () => {
      try {
        claim.run = await deps.store.claimPendingWorkflowRun(workflowRun.id, cwd);
      } catch (error) {
        if (error instanceof WorkflowItemHeldError)
          return { held: itemHold(error.itemKey, error.holderRunId, error.workflow) };
        if (error instanceof InstallHeldError) return { held: installHold(error.hold) };
        if (error instanceof RunLimitError) return { held: runLimitHold(error.runLimit) };
        // The claim refused before writing anything, so the start is refused with the fix.
        if (error instanceof ConcurrencyConfigError)
          return {
            done: await refuseStart(deps, platform, conversationId, workflowRun, error.message),
          };
        // No claimant can start it, so this process, which knows why, ends it with the reason.
        if (error instanceof PendingClaimRefusedError)
          return { done: await failRefusedClaim(deps, platform, conversationId, error) };
        claim.error = error;
      }
      return { done: undefined };
    },
  });
  if (itemRefused) return { stopped: true, result: itemRefused };
  if ('error' in claim) {
    const error = claim.error;
    getLog().error({ err: error, workflowRunId: workflowRun.id }, 'workflow.pending_claim_failed');
    // A lost connection may hide a committed claim. Do not release ownership or
    // write a terminal state when this process cannot confirm the transition.
    await sendCriticalMessage(
      platform,
      conversationId,
      `Unable to confirm execution ownership for workflow run '${workflowRun.id}'. Please inspect the run before retrying.`
    );
    return {
      stopped: true,
      result: {
        success: false,
        workflowRunId: workflowRun.id,
        error: 'Unable to confirm workflow execution claim; inspect the run before retrying',
      },
    };
  }
  const claimed = claim.run;
  if (!claimed) {
    // The run left pending first: whoever moved it owns it, so this process writes nothing.
    getLog().warn({ workflowRunId: workflowRun.id }, 'workflow.pending_claim_lost');
    return {
      stopped: true,
      result: {
        success: false,
        workflowRunId: workflowRun.id,
        error: 'Workflow run is no longer pending',
      },
    };
  }
  onExecutionClaimed?.(executionClaim(claimed.metadata));
  workflowRun.status = claimed.status;
  workflowRun.started_at = claimed.started_at;
  workflowRun.active_phase_started_at = claimed.active_phase_started_at;
  // The run's starting checkout is sampled the moment execution ownership is won, with
  // the final cwd and backend bound and before anything else can touch the checkout.
  // Its manifest is written, and the baseline persisted, once the run's artifacts
  // directory exists. A resume never samples: it keeps the baseline the run started with.
  return { stopped: false, value: await sampleCheckout(cwd, execContext) };
}

/**
 * Fail a run whose claim was refused for a reason no claimant gets past, while it is still
 * pending, so it ends with that reason instead of staying pending and holding its slot.
 */
async function failRefusedClaim(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  refusal: PendingClaimRefusedError
): Promise<WorkflowExecutionResult> {
  getLog().warn(
    { workflowRunId: refusal.runId, reason: refusal.reason },
    'workflow.pending_claim_refused'
  );
  const { failed } = await requireTerminalStatusWrite(
    deps.store.failWorkflowRun(refusal.runId, refusal.message, {
      pendingOnly: true,
      exitReason: 'launch_failed',
    }),
    { workflowRunId: refusal.runId, site: 'workflow.pending_claim_refused', failure: refusal }
  );
  if (failed) await sendCriticalMessage(platform, conversationId, `❌ ${refusal.message}`);
  return { success: false, workflowRunId: refusal.runId, error: refusal.message };
}

async function stampPreCreatedRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  preCreatedRun: WorkflowRun,
  opts: ExecuteWorkflowOptions,
  dispatch: RunDispatch
): Promise<RunPhase<WorkflowRun>> {
  const invocationMetadata = freshInvocationMetadata(opts, dispatch, preCreatedRun.metadata);
  try {
    await deps.store.updateWorkflowRun(preCreatedRun.id, {
      metadata: invocationMetadata,
      ...(preCreatedRun.working_path === null ? { working_path: cwd } : {}),
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, workflowRunId: preCreatedRun.id },
      'workflow.invocation_metadata_persist_failed'
    );
    // Notify before the terminal write: the write can now reject, and the operator
    // must still learn why the run stopped when it does.
    await sendCriticalMessage(
      platform,
      conversationId,
      '❌ **Workflow failed**: Unable to record the run invocation settings. Please try again later.'
    );
    await requireTerminalStatusWrite(
      deps.store.failWorkflowRun(
        preCreatedRun.id,
        'Database error recording workflow invocation settings'
      ),
      {
        workflowRunId: preCreatedRun.id,
        site: 'workflow.invocation_metadata_failure_record_failed',
      }
    );
    return {
      stopped: true,
      result: {
        success: false,
        workflowRunId: preCreatedRun.id,
        error: 'Database error recording workflow invocation settings',
      },
    };
  }
  return {
    stopped: false,
    value: {
      ...preCreatedRun,
      working_path: preCreatedRun.working_path ?? cwd,
      metadata: {
        ...preCreatedRun.metadata,
        ...invocationMetadata,
      },
    },
  };
}

/**
 * What a fresh run fixed when it started: its dispatch record, and its complete `$INPUTS`
 * (pack settings, declared defaults, supplied values), which every later read of the row
 * takes as is. Written only on a fresh dispatch, so a resume can never re-stamp them.
 */
function runStartMetadata(
  { dispatchMetadata, startInputs }: RunDispatch,
  existingMetadata: WorkflowRun['metadata'] = {}
): Record<string, unknown> {
  return {
    [RUN_DISPATCH_METADATA_KEY]: dispatchMetadata,
    ...(startInputs !== undefined
      ? runInputsMetadata(
          startInputs,
          Object.hasOwn(existingMetadata, SUBRUN_METADATA_KEYS.inputsValues)
        )
      : {}),
  };
}

// Container stamps let a later process rediscover the environment through backend.resumeEnv.
function freshInvocationMetadata(
  opts: ExecuteWorkflowOptions,
  dispatch: RunDispatch,
  existingMetadata: WorkflowRun['metadata'] = {}
) {
  const { prepared } = dispatch;
  const { modelBindingsMetadata, runConfigMetadata } = prepared;
  const containerCtx = opts.container;
  return {
    ...(Object.hasOwn(existingMetadata, RUN_AI_CONFIGURATION_METADATA_KEY)
      ? {}
      : { [RUN_AI_CONFIGURATION_METADATA_KEY]: prepared.aiConfigurationSnapshot }),
    [RUN_MODEL_BINDINGS_METADATA_KEY]: modelBindingsMetadata,
    ...runStartMetadata(dispatch, existingMetadata),
    ...(runConfigMetadata ? { [WORKFLOW_RUN_CONFIG_METADATA_KEY]: runConfigMetadata } : {}),
    ...(opts.execContext?.kind === 'container'
      ? { [CONTAINER_ISOLATION_MARKER.key]: CONTAINER_ISOLATION_MARKER.value }
      : {}),
    ...(containerCtx ? { [ISOLATION_ENV_ID_METADATA_KEY]: containerCtx.envId } : {}),
    ...(opts.ownedWorktree ? { owned_worktree: opts.ownedWorktree } : {}),
  };
}

/**
 * Path-lock guard: ensure no other workflow run holds this working_path.
 *
 * Skipped when `workflow.mutates_checkout` is false — the author asserts
 * that concurrent runs will not race (e.g. all writes are per-run-scoped).
 *
 * Excluded from the lock: this run's ancestors and descendants, which share its
 * checkout by construction (#2121), and its fan-out siblings — children of the same
 * parent and `fan_out` node on the same path — plus their descendants (#2777). The
 * walk repeats for every ancestor that is itself a fan-out child, so a grandchild
 * does not collide with its parent's siblings in a nested fan-out. Sharing is the
 * author's choice; agents coordinate their own edits, and every sibling pair is
 * recorded as `workflow.checkout_shared` events. A fan-out child still runs this
 * block under `mutates_checkout: false`, only to record those events.
 *
 * Runs after workflowRun is finalized (pre-created, resumed, or freshly
 * created) so we always have self-ID + path priority for the deterministic
 * older-wins tiebreaker. The query treats `pending` rows older than 5 min
 * as orphaned, so leaks from crashed dispatches or resume orphans don't
 * permanently block the path.
 */
async function holdCheckoutPathLock(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun
): Promise<WorkflowExecutionResult | undefined> {
  const subrun = readSubrunMetadata(workflowRun.metadata);
  if (workflow.mutates_checkout === false && subrun.childIndex === undefined) return undefined;
  try {
    const { pathLockExclude, sharedCheckoutSiblings } = await findSharedCheckoutRuns(
      deps,
      cwd,
      workflowRun
    );
    const skipPathLock = workflow.mutates_checkout === false;
    if (!skipPathLock) {
      pathLockExclude.push(...(await gatherDescendantRunIds(deps, workflowRun.id)));
    }
    const activeWorkflow = skipPathLock
      ? null
      : await deps.store.getActiveWorkflowRunByPath(cwd, {
          id: workflowRun.id,
          startedAt: workflowPathPriorityTime(workflowRun),
          ...(pathLockExclude.length > 0 ? { excludeRunIds: pathLockExclude } : {}),
        });
    if (activeWorkflow) {
      await sendCriticalMessage(
        platform,
        conversationId,
        checkoutInUseMessage(platform, activeWorkflow)
      );
      // The notification explains the block; it does not prove cleanup succeeded.
      // Release our lock token, preserving a rejected write instead of returning.
      await requireTerminalStatusWrite(
        deps.store.cancelWorkflowRun(workflowRun.id, { cancel_reason: 'precondition_failed' }),
        {
          workflowRunId: workflowRun.id,
          site: 'executor.guard_self_cancel',
        }
      );

      return {
        success: false,
        error: `Workflow already active on this path (${activeWorkflow.status}): ${activeWorkflow.workflow_name}`,
      };
    }
    await recordCheckoutSharing(
      deps,
      cwd,
      workflowRun,
      subrun.parentNodeId,
      sharedCheckoutSiblings
    );
  } catch (error) {
    if (isWorkflowExecutionInterruption(error)) throw error;
    const err = error as Error;
    getLog().error(
      { err, conversationId, cwd, pendingRunId: workflowRun.id },
      'db_active_workflow_check_failed'
    );
    await sendCriticalMessage(
      platform,
      conversationId,
      '❌ **Workflow blocked**: Unable to verify if another workflow is running (database error). Please try again in a moment.'
    );
    // Even if notification delivery failed, release this run's lock token.
    // A rejected cleanup must escape rather than become an ordinary guard result.
    // A fan-out child is cancelled with a fan-out reason so the parent's resume
    // re-drives it; an untagged cancel reads as a user's and is never re-run (#2180).
    await requireTerminalStatusWrite(
      subrun.childIndex !== undefined
        ? deps.store.cancelFanOutRun(workflowRun.id, 'fan_out_checkout_check')
        : deps.store.cancelWorkflowRun(workflowRun.id, { cancel_reason: 'precondition_failed' }),
      {
        workflowRunId: workflowRun.id,
        site: 'executor.guard_query_failure_cleanup',
      }
    );
    return { success: false, error: 'Database error checking for active workflow' };
  }
  return undefined;
}

async function findSharedCheckoutRuns(
  deps: WorkflowDeps,
  cwd: string,
  workflowRun: WorkflowRun
): Promise<{ pathLockExclude: string[]; sharedCheckoutSiblings: WorkflowRun[] }> {
  const ancestry = workflowRun.parent_run_id ? await deps.store.getRunAncestry(workflowRun.id) : [];
  const pathLockExclude = ancestry.map(run => run.id);
  const sharedCheckoutSiblings: WorkflowRun[] = [];
  for (const branch of [workflowRun, ...ancestry]) {
    const branchMetadata = readSubrunMetadata(branch.metadata);
    if (
      branch.working_path !== cwd ||
      !branch.parent_run_id ||
      branchMetadata.parentNodeId === undefined ||
      branchMetadata.childIndex === undefined
    ) {
      continue;
    }
    const siblings = (await deps.store.findChildRuns(branch.parent_run_id)).filter(peer => {
      const peerMetadata = readSubrunMetadata(peer.metadata);
      return (
        peer.id !== branch.id &&
        peer.working_path === cwd &&
        peerMetadata.parentNodeId === branchMetadata.parentNodeId &&
        peerMetadata.childIndex !== undefined
      );
    });
    if (branch.id === workflowRun.id) sharedCheckoutSiblings.push(...siblings);
    for (const sibling of siblings) {
      pathLockExclude.push(sibling.id, ...(await gatherDescendantRunIds(deps, sibling.id)));
    }
  }
  return { pathLockExclude, sharedCheckoutSiblings };
}

async function recordCheckoutSharing(
  deps: WorkflowDeps,
  cwd: string,
  workflowRun: WorkflowRun,
  parentNodeId: string | undefined,
  sharedCheckoutSiblings: WorkflowRun[]
): Promise<void> {
  if (workflowRun.parent_run_id && parentNodeId !== undefined) {
    for (const sibling of sharedCheckoutSiblings) {
      // Append on both runs: the earlier child may already have finished before
      // this child exists. No read/modify/write metadata race is needed.
      for (const [runId, siblingId] of [
        [workflowRun.id, sibling.id],
        [sibling.id, workflowRun.id],
      ]) {
        await deps.store.persistWorkflowEvent({
          workflow_run_id: runId,
          event_type: 'workflow.checkout_shared',
          data: {
            parent_run_id: workflowRun.parent_run_id,
            parent_node_id: parentNodeId,
            working_path: cwd,
            sibling_run_id: siblingId,
          } satisfies CheckoutSharedEventData,
        });
      }
    }
  }
}

/** Persist the baseline sampled at claim time, now that the run's artifacts directory exists. */
export async function recordRunCheckoutBaseline(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  checkoutBaselineSample: CheckoutSample,
  artifactsDir: string,
  cutFromCommit: string | undefined
): Promise<WorkflowExecutionResult | undefined> {
  // Persisting the baseline is run infrastructure: a run that cannot record where it
  // started fails before its first node. An unobservable checkout is not a
  // failure — it is recorded as an `unavailable` observation.
  try {
    workflowRun.checkout_baseline = await deps.store.recordWorkflowRunCheckoutBaseline(
      workflowRun.id,
      await recordCheckoutSample(
        checkoutBaselineSample,
        { runId: workflowRun.id, artifactsDir },
        cutFromCommit !== undefined ? { cutFromCommit } : {}
      )
    );
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, workflowRunId: workflowRun.id },
      'workflow.checkout_baseline_persist_failed'
    );
    await sendCriticalMessage(
      platform,
      conversationId,
      '❌ **Workflow failed**: Unable to record the run checkout baseline.'
    );
    await requireTerminalStatusWrite(
      deps.store.failWorkflowRun(
        workflowRun.id,
        `Checkout baseline could not be recorded: ${err.message}`
      ),
      { workflowRunId: workflowRun.id, site: 'workflow.checkout_baseline_fail_db_record_failed' }
    );
    return {
      success: false,
      workflowRunId: workflowRun.id,
      error: `Checkout baseline could not be recorded: ${err.message}`,
    };
  }
  return undefined;
}
