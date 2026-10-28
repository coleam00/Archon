import { executionClaim } from './store';
import { formatDuration } from '@archon/paths/duration';
import { captureWorkflowTerminal, createLogger } from '@archon/paths';
import { hostname } from 'os';
import { recordCheckoutSample, sampleCheckout, type CheckoutSample } from './checkout-observation';
import { gatherDescendantRunIds } from './child-runs';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { attentionAnswerLines, spellWorkflowCommand } from './deps';
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
  EXECUTION_OWNER_METADATA_KEY,
  RUN_DISPATCH_METADATA_KEY,
  SUBRUN_METADATA_KEYS,
  pendingWorkflowWaitDeadline,
  readSubrunMetadata,
  runAttention,
  type ExecutionOwnerRecord,
} from './schemas';
import type { CheckoutSharedEventData } from './schemas/workflow-event';
import type { WorkflowRunOrigin } from './schemas/workflow-run';
import { TerminalStatusWriteError, requireTerminalStatusWrite } from './terminal-status-write';
import { parseDbTimestamp } from './utils/duration';

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
  // This process is the one executing the run, whether it created the row, claimed a
  // row a launcher pre-created, or resumed one. `abandon` shows this record when no
  // owner answers (#2325).
  const uid = process.getuid?.();
  const executionOwner: ExecutionOwnerRecord = {
    host: hostname(),
    pid: process.pid,
    ...(uid === undefined ? {} : { uid }),
  };

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
      dispatch,
      executionOwner
    );
    if (created.stopped) return created;
    workflowRun = created.value;
  }

  let checkoutBaselineSample: CheckoutSample | undefined;
  if (!dispatch.isContinuation) {
    const claimed = await claimPendingRun(
      deps,
      platform,
      conversationId,
      cwd,
      workflowRun,
      execContext,
      opts.onExecutionClaimed
    );
    if (claimed.stopped) return claimed;
    checkoutBaselineSample = claimed.value;
  }

  if (preCreatedRun) {
    const stamped = await stampPreCreatedRun(
      deps,
      platform,
      conversationId,
      cwd,
      preCreatedRun,
      opts,
      dispatch,
      executionOwner
    );
    if (stamped.stopped) return stamped;
    workflowRun = stamped.value;
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

async function notifyResumingRun(
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowName: string,
  priorCompletedNodes: NonNullable<ExecuteWorkflowOptions['priorCompletedNodes']>
): Promise<void> {
  const resumeMsg =
    priorCompletedNodes.size > 0
      ? `▶️ **Resuming** workflow \`${workflowName}\` — skipping ${String(priorCompletedNodes.size)} already-completed node(s).`
      : `▶️ **Resuming** workflow \`${workflowName}\` — continuing interactive loop.`;
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
  dispatch: RunDispatch,
  executionOwner: ExecutionOwnerRecord
): Promise<RunPhase<WorkflowRun>> {
  const {
    preparedSource,
    codebaseId,
    issueContext,
    inputs: suppliedInputs,
    adoptedFromRunId,
    continuationMode,
  } = opts;
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
        // Declared inputs supplied by a direct top-level invocation (#2554), already
        // validated by the invocation gate. Written only on creation, so a resume, which
        // arrives with `preCreatedRun` set and never creates a row, can never re-stamp or
        // clobber what the original invocation supplied.
        ...(suppliedInputs && Object.keys(suppliedInputs).length > 0
          ? { [SUBRUN_METADATA_KEYS.inputs]: { ...suppliedInputs } }
          : {}),
        // Between-run continuation (#2747): the mode stamp rides the same
        // creation write as `adopted_from_run_id` so both are write-once.
        ...(adoptedFromRunId
          ? { [CONTINUATION_METADATA_KEY]: { mode: continuationMode ?? 'adopt' } }
          : {}),
        ...freshInvocationMetadata(opts, dispatch),
        [EXECUTION_OWNER_METADATA_KEY]: executionOwner,
      },
      ...(adoptedFromRunId ? { adopted_from_run_id: adoptedFromRunId } : {}),
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
    await sendCriticalMessage(
      platform,
      conversationId,
      '❌ **Workflow failed**: Unable to start workflow (database error). Please try again later.'
    );
    return {
      stopped: true,
      result: { success: false, error: 'Database error creating workflow run' },
    };
  }
}

/** Win execution ownership of a pending row, then sample the checkout the run starts from. */
async function claimPendingRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  execContext: NonNullable<ExecuteWorkflowOptions['execContext']>,
  onExecutionClaimed: ExecuteWorkflowOptions['onExecutionClaimed']
): Promise<RunPhase<CheckoutSample>> {
  let claimed: WorkflowRun | null;
  try {
    claimed = await deps.store.claimPendingWorkflowRun(workflowRun.id, cwd);
  } catch (error) {
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
  if (!claimed) {
    getLog().warn({ workflowRunId: workflowRun.id }, 'workflow.pending_claim_lost');
    return {
      stopped: true,
      result: {
        success: false,
        workflowRunId: workflowRun.id,
        error:
          'Workflow run is no longer pending, no longer owns its admitted resource, or its worktree was released',
      },
    };
  }
  onExecutionClaimed?.(executionClaim(claimed.metadata));
  workflowRun.status = claimed.status;
  workflowRun.started_at = claimed.started_at;
  // The run's starting checkout is sampled the moment execution ownership is won, with
  // the final cwd and backend bound and before anything else can touch the checkout.
  // Its manifest is written, and the baseline persisted, once the run's artifacts
  // directory exists. A resume never samples: it keeps the baseline the run started with.
  return { stopped: false, value: await sampleCheckout(cwd, execContext) };
}

async function stampPreCreatedRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  preCreatedRun: WorkflowRun,
  opts: ExecuteWorkflowOptions,
  dispatch: RunDispatch,
  executionOwner: ExecutionOwnerRecord
): Promise<RunPhase<WorkflowRun>> {
  const { isContinuation } = dispatch;
  const invocationMetadata: Record<string, unknown> = {
    ...(!isContinuation ? freshInvocationMetadata(opts, dispatch, preCreatedRun.metadata) : {}),
    [EXECUTION_OWNER_METADATA_KEY]: executionOwner,
  };
  try {
    await deps.store.updateWorkflowRun(preCreatedRun.id, {
      metadata: invocationMetadata,
      ...(!isContinuation && preCreatedRun.working_path === null ? { working_path: cwd } : {}),
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
      working_path: preCreatedRun.working_path ?? (isContinuation ? null : cwd),
      metadata: {
        ...preCreatedRun.metadata,
        ...invocationMetadata,
      },
    },
  };
}

// Container stamps let a later process rediscover the environment through backend.resumeEnv.
function freshInvocationMetadata(
  opts: ExecuteWorkflowOptions,
  { prepared, dispatchMetadata }: RunDispatch,
  existingMetadata: WorkflowRun['metadata'] = {}
) {
  const { modelBindingsMetadata, runConfigMetadata } = prepared;
  const containerCtx = opts.container;
  return {
    ...(Object.hasOwn(existingMetadata, RUN_AI_CONFIGURATION_METADATA_KEY)
      ? {}
      : { [RUN_AI_CONFIGURATION_METADATA_KEY]: prepared.aiConfigurationSnapshot }),
    [RUN_MODEL_BINDINGS_METADATA_KEY]: modelBindingsMetadata,
    [RUN_DISPATCH_METADATA_KEY]: dispatchMetadata,
    ...(runConfigMetadata ? { [WORKFLOW_RUN_CONFIG_METADATA_KEY]: runConfigMetadata } : {}),
    ...(opts.execContext?.kind === 'container' ? { isolation: 'container' } : {}),
    ...(containerCtx ? { isolation_env_id: containerCtx.envId } : {}),
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
 * created) so we always have self-ID + started_at for the deterministic
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
          startedAt: new Date(parseDbTimestamp(workflowRun.started_at)),
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
    if (error instanceof TerminalStatusWriteError) throw error;
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

/** Spell a workflow action the way the surface rendering the message accepts it. */
function formatRunCommand(platform: IWorkflowPlatform, action: string, shortId?: string): string {
  return spellWorkflowCommand(platform, shortId ? `${action} ${shortId}` : action);
}

/** Explain which run holds the checkout and what the user can do about it. */
function checkoutInUseMessage(platform: IWorkflowPlatform, activeWorkflow: WorkflowRun): string {
  const elapsedMs = Date.now() - parseDbTimestamp(activeWorkflow.started_at);
  const duration = formatDuration(elapsedMs);
  const shortId = activeWorkflow.id.slice(0, 8);

  let stateLine: string;
  let actionLines: string;
  if (activeWorkflow.status === 'paused') {
    ({ stateLine, actionLines } = pausedCheckoutState(platform, activeWorkflow, duration, shortId));
    actionLines +=
      // Cancel stops live work, and a paused run has none: abandon discards it.
      `• Discard it: \`${formatRunCommand(platform, 'abandon', shortId)}\`\n` +
      '• Use a different branch: `--branch <other>`';
  } else {
    const verb = activeWorkflow.status === 'pending' ? 'starting' : 'running';
    stateLine = `${verb} ${duration}, run \`${shortId}\``;
    // Cancel only accepts a running run; a pending one has nothing executing yet.
    const cancelLine =
      activeWorkflow.status === 'running'
        ? `• Cancel it: \`${formatRunCommand(platform, 'cancel', shortId)}\`\n`
        : '';
    actionLines =
      `• Wait for it to finish: \`${formatRunCommand(platform, 'status')}\`\n` +
      cancelLine +
      `• If its process is gone: \`${formatRunCommand(platform, 'abandon', shortId)}\`\n` +
      '• Use a different branch: `--branch <other>`';
  }
  return (
    `❌ **This worktree is in use** by \`${activeWorkflow.workflow_name}\` ` +
    `(${stateLine}).\n${actionLines}`
  );
}

function pausedCheckoutState(
  platform: IWorkflowPlatform,
  activeWorkflow: WorkflowRun,
  duration: string,
  shortId: string
): { stateLine: string; actionLines: string } {
  let stateLine: string;
  let actionLines: string;
  const attention = runAttention(activeWorkflow);
  const wait = pendingWorkflowWaitDeadline(activeWorkflow);
  if (attention?.kind === 'attention') {
    stateLine = `paused, needs attention (${duration} since started, run \`${shortId}\`)`;
    actionLines = `• Answer it: ${attention.message}\n${attentionAnswerLines(platform, attention)
      .map(line => `• ${line}\n`)
      .join('')}`;
  } else if (wait) {
    const waitingFor =
      wait.kind === 'event'
        ? `for event \`${wait.event}\` until`
        : wait.kind === 'quota'
          ? 'on a provider usage or rate limit, trying again at'
          : 'until';
    stateLine = `paused waiting ${waitingFor} ${wait.resumeAt} (${duration} since started, run \`${shortId}\`)`;
    actionLines =
      (wait.kind === 'event'
        ? `• Signal event \`${wait.event}\` for run \`${activeWorkflow.id}\`\n`
        : '') + `• Wait until ${wait.resumeAt}: \`${formatRunCommand(platform, 'status')}\`\n`;
  } else if (attention?.kind === 'blocked_on_child' || attention?.kind === 'blocked_on_children') {
    // The parent takes no answer of its own; it continues when its sub-runs finish.
    const childRunIds =
      attention.kind === 'blocked_on_child' ? [attention.childRunId] : attention.childRunIds;
    stateLine = `paused waiting on sub-runs (${duration} since started, run \`${shortId}\`)`;
    actionLines = `• Check sub-runs ${childRunIds.map(id => `\`${id}\``).join(', ')}: \`${formatRunCommand(platform, 'status')}\`\n`;
  } else {
    stateLine = `paused waiting for user input (${duration} since started, run \`${shortId}\`)`;
    actionLines =
      `• Approve it: \`${formatRunCommand(platform, 'approve', shortId)}\`\n` +
      `• Reject it: \`${formatRunCommand(platform, 'reject', shortId)}\`\n`;
  }
  return { stateLine, actionLines };
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
