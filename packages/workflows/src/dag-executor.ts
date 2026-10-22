/**
 * DAG Workflow Executor
 *
 * Runs one pass of a `nodes:`-based workflow: refuses it before any node runs when a node
 * could not work (`dag/capability-preflight`), restores what earlier passes left
 * (`dag/resume-state`), walks the topological layers (`dag/run-layers`), keeps the run's
 * usage, authored outcome and budget durable whatever happens to the pass, and ends it
 * (`dag/run-terminal`).
 */

import { serializeRunUsage } from './schemas/run-usage';
import { readInterruptedRunUsage } from './dag/interrupted-usage';
import { isWorkflowExecutionInterruption } from './execution-interruption';
import { createRunToolCallAttention } from './tool-call-attention';
import { liveSourceRoots, type WorkflowSourceRoots } from './workflow-source';
import { releaseUnreadableRunSource } from './source-release';
import { sourceReleaseNotice } from './deps';
import type { ExecutionContext } from '@archon/provider-contract';
import { resolveRunExecutionMode, type ContainerRunContext } from './container-context';
import type { ResolvedWorkflow, WorkflowRunOutcome, WorkflowRunNodeSession } from './schemas';
import { CONTINUATION_RETRY_MS, executionClaim } from './store';
import type { DagResumeSnapshot, PersistedNodeOutput, PriorFailedNode } from './store';
import {
  RUN_BUDGET_REFUSED_EVENT_TYPE,
  RunBudgetRefusedError,
  createRunBudgetLedger,
  describeRunBudgetRefusal,
  runBudgetRefusalEventData,
  runBudgetStartRefusal,
  type RunBudgetLedger,
  type RunBudgetRefusal,
} from './run-budget';
import { outputRefText, resolveNodeOutputField } from './output-ref';
import { logWorkflowError } from './logger';
import { safeSendMessage } from './platform-messages';
import { isTierName, selectModelRef } from './model-validation';
import { getLog } from './dag/log';
import { runUsageMismatch, type RunUsageFigures } from './dag/usage';
import { RunSourceUnreadableError } from './dag/node-source';
import { type RunInputs, type RunLayersContext } from './dag/run-context';
import { assertRunCapabilities } from './dag/capability-preflight';
import { runLayers } from './dag/run-layers';
import { restoreRunState } from './dag/resume-state';
import { failRun, finishRun, skipIfStatusChanged } from './dag/run-terminal';
import { announceContainerRun, suspendContainerForPause } from './dag/container-gate';

/**
 * Usage a resumed run already consumed in earlier passes, rebuilt from its persisted
 * node completion, failure and deferred-usage events by `getDagResumeSnapshot`. Both axes travel
 * together because they are one concept — what this run has spent so far — and seeding
 * only one of them is how cost came to under-report every resumed run while tokens did
 * not (#2469).
 */
export type PriorRunUsage = Pick<DagResumeSnapshot, 'tokens' | 'tokensUnknown' | 'costUsd'>;

/** Inputs accepted by {@link executeDagWorkflow}. */
export interface ExecuteDagWorkflowOptions extends RunInputs {
  workflow: ResolvedWorkflow;
  priorCompletedNodes?: Map<string, PersistedNodeOutput>;
  /** Failures from before a pause, replayed instead of re-running their nodes. */
  replayedFailures?: ReadonlyMap<string, PriorFailedNode>;
  /**
   * Stable cross-invocation artifact scope dir (`scopes/<workflow>/<scope>/`),
   * resolved by executor.ts when the workflow uses session persistence (#1846).
   * Undefined otherwise — no mirroring, no cold-resume pointer.
   */
  scopeArtifactsDir?: string;
  /**
   * Execution context for this run (host by default; the container backend
   * threads a container context in Phase B). Threaded onto every node's
   * `RunLayersContext` so provider turns and subprocesses exec in the right place.
   */
  execContext?: ExecutionContext;
  /**
   * Container run context (Phase C): the write-back backend port + env id + policy.
   * Present only for container runs. Drives suspend-on-pause and the engine-level
   * write-back gate that runs after the last node before the run completes.
   */
  containerCtx?: ContainerRunContext;
  /** Cumulative usage restored on resume, from prior completion AND failure events. */
  priorUsage?: PriorRunUsage;
  /** Private run-scoped handles restored before a cold resume transitions to running. */
  priorNodeSessions?: readonly WorkflowRunNodeSession[];
  /**
   * Roots this run's commands and scripts are read from. Undefined here means the caller
   * has no capture (an in-process caller with a hand-built definition); the boundary below
   * normalizes it to live roots ONCE so nothing downstream has to.
   */
  workflowSourceRoots?: WorkflowSourceRoots;
}

/**
 * Execute a complete DAG workflow.
 * Called from executeWorkflow() in executor.ts.
 */
export async function executeDagWorkflow(
  options: ExecuteDagWorkflowOptions
): Promise<string | undefined | { kind: 'source_release'; released: boolean }> {
  const {
    deps,
    platform,
    conversationId,
    cwd,
    workflow,
    workflowRun,
    workflowProvider,
    workflowModel,
    artifactsDir,
    stateDir,
    logDir,
    baseBranch,
    docsDir,
    config,
    configuredCommandFolder,
    issueContext,
    priorCompletedNodes,
    replayedFailures,
    aiProfile,
    workflowPreset,
    scopeArtifactsDir,
    execContext = { kind: 'host' },
    containerCtx,
    runChildWorkflow,
    priorUsage,
    priorNodeSessions,
    workflowSourceRoots,
  } = options;
  const dagStartTime = Date.now();

  assertRunCapabilities(deps.providers, workflow, workflowProvider, aiProfile, execContext);

  if (execContext.kind === 'container') {
    await announceContainerRun(
      deps,
      platform,
      conversationId,
      workflowRun.id,
      execContext,
      containerCtx,
      priorCompletedNodes !== undefined && priorCompletedNodes.size > 0
    );
  }

  const workflowRef = selectModelRef(workflow.model, aiProfile);
  const workflowTier = workflowRef && isTierName(workflowRef) ? workflowRef : undefined;
  const workflowLevelOptions = {
    effort: workflow.effort,
    fallbackModel: workflow.fallbackModel,
    betas: workflow.betas,
    sandbox: workflow.sandbox,
    webSearchMode: workflow.webSearchMode,
    workflowTier,
  };
  const layers = workflow.plan.layers;
  const { nodeOutputs, persistScope, namedResumeSourceIds, nodeSessionHandles } = restoreRunState(
    deps.store,
    workflow,
    workflowRun,
    priorCompletedNodes,
    priorNodeSessions
  );
  const workflowPersistSessions = workflow.persist_sessions === true;

  getLog().info(
    {
      workflowName: workflow.name,
      nodeCount: workflow.nodes.length,
      layerCount: layers.length,
      hasIssueContext: !!issueContext,
      issueContextLength: issueContext?.length ?? 0,
    },
    'dag_workflow_starting'
  );

  // Persist the authored verdict as soon as the selected result is available,
  // independently from every lifecycle branch below (#2618). The initial call
  // covers a selected node rehydrated from node_completed events on resume; the
  // awaited per-layer hook captures a fresh result before later work can pause or
  // fail; and the unwind backstop covers a fatal throw while aggregating that layer.
  // A same-value write is skipped, but a genuine re-execution may replace the
  // prior verdict.
  let persistedOutcome: WorkflowRunOutcome | null = workflowRun.outcome;
  const persistAuthoredOutcome = async (): Promise<void> => {
    const field = workflow.outcome_field;
    const returns = workflow.returns;
    if (field === undefined || returns === undefined) return;
    const selectedOutput = nodeOutputs.get(returns);
    if (selectedOutput?.state !== 'completed') return;

    const resolution = resolveNodeOutputField(
      selectedOutput,
      returns,
      field,
      outputRefText(returns, field)
    );
    if (resolution.kind !== 'value' || typeof resolution.value !== 'boolean') {
      throw new Error(
        `Workflow outcome_field '${field}' on returns node '${returns}' did not resolve to a boolean`
      );
    }
    const outcome: WorkflowRunOutcome = resolution.value ? 'succeeded' : 'failed';
    if (outcome === persistedOutcome) return;
    await deps.store.updateWorkflowRun(workflowRun.id, { outcome });
    persistedOutcome = outcome;
  };

  // Run the topological layers. runLayers mutates the context's mutable fields in place
  // (nodeOutputs, lastSequentialSession, usage accumulators); we read them back below
  // for the terminal tally. stepNamePrefix is '' for the top-level DAG so node event
  // step_names are the raw node ids. Fields stay
  // explicit because spreading options would also copy executor-only state into this
  // context without an excess-property check.
  // A budget always seeds from the run's own rows, never from `priorUsage`: a re-driven
  // run can arrive without prior usage, and a reset ledger would replay spent work.
  const resumeSnapshot =
    priorCompletedNodes !== undefined || workflow.budget !== undefined
      ? await deps.store.getDagResumeSnapshot(workflowRun.id)
      : undefined;
  const unfinishedInvocations =
    priorCompletedNodes === undefined ? undefined : resumeSnapshot?.unfinishedInvocations;
  const runBudget =
    workflow.budget !== undefined && resumeSnapshot !== undefined
      ? createRunBudgetLedger(workflow.budget, resumeSnapshot.budget)
      : undefined;
  const runCtx: RunLayersContext = {
    toolAttention: createRunToolCallAttention({ store: deps.store, runId: workflowRun.id }),
    unfinishedInvocations,
    reportedChildUsage: resumeSnapshot?.reportedChildUsage,
    unattributedChildUsagePaths: resumeSnapshot?.unattributedChildUsagePaths,
    runBudget,
    deps,
    platform,
    conversationId,
    cwd,
    execContext,
    runChildWorkflow,
    workflowRun,
    workflowName: workflow.name,
    workflowSourceRoots: workflowSourceRoots ?? liveSourceRoots(cwd),
    config,
    workflowProvider,
    workflowModel,
    workflowLevelOptions,
    aiProfile,
    workflowPreset,
    artifactsDir,
    stateDir,
    logDir,
    baseBranch,
    docsDir,
    configuredCommandFolder,
    issueContext,
    persistScope,
    workflowPersistSessions,
    // Scope-keyed persistence surface: without a scope key there is no durable
    // scope to mirror into or recover from, so the dir is dropped alongside it.
    scopeArtifactsDir: persistScope !== undefined ? scopeArtifactsDir : undefined,
    layers,
    nodeOutputs,
    afterLayer: persistAuthoredOutcome,
    priorCompletedNodes,
    replayedFailures,
    nodeSessionHandles,
    namedResumeSourceIds,
    lastSequentialSession: undefined,
    warnedProviderConflicts: new Set<string>(),
    totalCostUsd: priorUsage?.costUsd,
    totalTokens: priorUsage?.tokens,
    totalTokensUnknown: priorUsage?.tokensUnknown,
    stepNamePrefix: '',
    loopGroupPath: [],
    loopBodyScopes: [],
  };

  /** Log both figures when the run total and its node events disagree; never fails the run. */
  const reconcileRunUsage = async (): Promise<void> => {
    try {
      const events = await deps.store.getDagResumeSnapshot(workflowRun.id);
      const run: RunUsageFigures = {
        costUsd: runCtx.totalCostUsd,
        tokens: runCtx.totalTokens,
        tokensUnknown: runCtx.totalTokensUnknown,
      };
      const eventFigures: RunUsageFigures = {
        costUsd: events.costUsd,
        tokens: events.tokens,
        tokensUnknown: events.tokensUnknown,
      };
      const mismatched = runUsageMismatch(run, eventFigures);
      if (mismatched.length > 0) {
        getLog().error(
          { workflowRunId: workflowRun.id, mismatched, run, events: eventFigures },
          'dag.run_usage_reconciliation_mismatch'
        );
      }
    } catch (err) {
      getLog().warn(
        { err, workflowRunId: workflowRun.id },
        'dag.run_usage_reconciliation_read_failed'
      );
    }
  };

  /**
   * Persist what this run spent, whatever becomes of it (#2469).
   *
   * Usage used to be written in exactly one place — the metadata argument of
   * `completeWorkflowRun` below — which tied the record to a single outcome. A run
   * that burned tokens and then failed, was cancelled out of band, or paused at a
   * gate recorded no spend at all, and since `childOutcomeFromRun` reads cost and
   * tokens straight off the child's row, a fan-out aggregate silently became Σ of
   * *completed* children. With `all_done` the default join, that made partial failure
   * — the ordinary case — under-report with no warning.
   *
   * Every disposition below (container pause, external cancel/pause, the two failure
   * branches, the evidence gate, the write-back gate, completion) is reached from the
   * one point where the accumulators are settled and identical, so the write belongs
   * HERE rather than in each of them. It goes through `updateWorkflowRun`, not the
   * terminal writers, because that merge carries no `WHERE status = 'running'` guard
   * and so still lands on a row another process has already flipped to `cancelled`.
   * Same ordering as the evidence gate: metadata first, terminal status after.
   *
   * Best-effort by design — a bookkeeping write must not fail an otherwise-fine run —
   * but never silent: the whole defect was a number quietly going missing.
   *
   * At debug or trace level this one point also compares the totals it writes with the
   * fold of the run's node events, the figure resume and terminal telemetry read.
   */
  const persistRunUsage = async (): Promise<void> => {
    const level = getLog().level;
    if (level === 'debug' || level === 'trace') await reconcileRunUsage();
    const usage = serializeRunUsage({
      costUsd: runCtx.totalCostUsd,
      tokens: runCtx.totalTokens,
      tokensUnknown: runCtx.totalTokensUnknown,
    });
    if (Object.keys(usage).length === 0) return;
    await deps.store
      .updateWorkflowRun(workflowRun.id, { metadata: usage })
      .catch((dbErr: Error) => {
        getLog().error(
          { err: dbErr, workflowRunId: workflowRun.id },
          'dag.run_usage_persist_failed'
        );
      });
  };

  /**
   * Fail the run on a budget refusal. Returns normally, like the other engine refusals,
   * so the outer executor catch does not emit a second failure. A run paused or cancelled
   * meanwhile keeps its status; its next pass rebuilds the ledger and refuses again.
   */
  const failRunForBudget = async (
    ledger: RunBudgetLedger,
    refusal: RunBudgetRefusal
  ): Promise<void> => {
    if (await skipIfStatusChanged(deps, workflowRun, 'dag.run_budget_refusal_status_changed'))
      return;
    const failMsg = describeRunBudgetRefusal(refusal, workflow.name);
    getLog().error({ workflowRunId: workflowRun.id, refusal }, 'dag.run_budget_refused');
    await deps.store.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: RUN_BUDGET_REFUSED_EVENT_TYPE,
      step_name: refusal.path,
      data: runBudgetRefusalEventData(refusal, ledger.limits, ledger.usage),
    });
    await logWorkflowError(logDir, workflowRun.id, failMsg, {
      ...(runCtx.totalCostUsd !== undefined ? { cost_usd: runCtx.totalCostUsd } : {}),
      ...(runCtx.totalTokens !== undefined ? { tokens: runCtx.totalTokens } : {}),
    }).catch((logErr: Error) => {
      getLog().error(
        { err: logErr, workflowRunId: workflowRun.id },
        'dag.workflow_error_log_write_failed'
      );
    });
    await safeSendMessage(platform, conversationId, `❌ ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    await failRun(
      deps,
      workflowRun,
      workflow.name,
      failMsg,
      'budget_refused',
      'dag.run_budget_refused_fail'
    );
  };

  const startRefusal = runBudget && runBudgetStartRefusal(runBudget);
  if (runBudget !== undefined && startRefusal !== undefined) {
    await failRunForBudget(runBudget, startRefusal);
    return;
  }

  /**
   * Pause the run instead of failing it: this host could not read its source (#4209).
   * The release compares status and execution claim, so an operator's abandon or a
   * sibling gate that already moved the row wins. It runs after the layer settled, so
   * nothing of this run still executes here when another host may claim it.
   */
  const releaseRunForUnreadableSource = async (
    error: RunSourceUnreadableError
  ): Promise<boolean> => {
    getLog().warn(
      { workflowRunId: workflowRun.id, nodeId: error.nodeId, path: error.path, err: error.cause },
      'dag.run_released_source_unreadable'
    );
    const { released } = await releaseUnreadableRunSource(
      deps,
      platform,
      conversationId,
      workflowRun.id,
      {
        claimId: executionClaim(workflowRun.metadata),
        nodeId: error.nodeId,
        ...(error.path !== undefined ? { path: error.path } : {}),
        error: error.message,
        retryAt: new Date(Date.now() + CONTINUATION_RETRY_MS).toISOString(),
      },
      resolveRunExecutionMode(execContext, containerCtx, workflowRun.metadata)
    );
    if (!released) {
      getLog().info({ workflowRunId: workflowRun.id }, 'dag.source_release_skipped_status_changed');
      return false;
    }
    await safeSendMessage(
      platform,
      conversationId,
      sourceReleaseNotice(platform, workflowRun.id, {
        path: error.path,
        nodeId: error.nodeId,
        container: execContext.kind === 'container',
      }),
      { workflowId: workflowRun.id, nodeName: error.nodeId }
    );
    return true;
  };

  await persistAuthoredOutcome();
  let sourceUnreadable: RunSourceUnreadableError | undefined;
  try {
    await runLayers(runCtx);
  } catch (error) {
    // runLayers guards almost everything, but a failed durable write (terminal status or
    // node event) escapes through its layer join. Persist both durable facts before rethrowing that
    // exact value (including an exotic `throw undefined`). Usage is best-effort. An
    // outcome write failure is secondary here: record it, but never let it mask the
    // execution error already in flight. A run-budget refusal also escapes the join; it
    // fails the run here instead of propagating. An unreadable source escapes it too; the
    // run is released below after persisting the settled usage and outcome.
    if (
      error instanceof RunBudgetRefusedError ||
      error instanceof RunSourceUnreadableError ||
      isWorkflowExecutionInterruption(error)
    ) {
      // The thunk that threw never reported its spend, nor did its settled siblings, so
      // the in-memory totals miss it. Rebuild from node events and child run telemetry.
      try {
        const durable = await readInterruptedRunUsage(deps.store, workflowRun.id, error);
        runCtx.totalCostUsd = durable.costUsd;
        runCtx.totalTokens = durable.tokens;
        runCtx.totalTokensUnknown = durable.tokensUnknown;
      } catch (readError) {
        getLog().error(
          { err: readError as Error, workflowRunId: workflowRun.id },
          'dag.unwind_usage_refresh_failed'
        );
      }
    }
    if (error instanceof RunSourceUnreadableError) {
      sourceUnreadable = error;
    } else {
      await persistRunUsage();
      try {
        await persistAuthoredOutcome();
      } catch (outcomeError) {
        getLog().error(
          { err: outcomeError as Error, workflowRunId: workflowRun.id },
          'dag.authored_outcome_persist_failed_during_unwind'
        );
      }
      if (error instanceof RunBudgetRefusedError && runBudget !== undefined) {
        await failRunForBudget(runBudget, error.refusal);
        return;
      }
      throw error;
    }
  } finally {
    await runCtx.toolAttention.refresh();
  }

  // Normal return has no primary error to preserve, so a verdict persistence failure
  // remains visible to the caller. These two small calls intentionally mirror the
  // unwind path above; extracting a policy flag would hide which error owns the throw.
  await persistRunUsage();
  await persistAuthoredOutcome();
  if (sourceUnreadable !== undefined) {
    return {
      kind: 'source_release',
      released: await releaseRunForUnreadableSource(sourceUnreadable),
    };
  }

  // Container pause economics (Phase C): if a node paused the run (approval /
  // interactive gate), suspend the container so a multi-day wait costs ~0 RAM/CPU.
  // The pause happens BETWEEN layers, after node completion — the #2134 background-
  // task wait gate has already drained and no `docker exec` is in flight (docker
  // stop would kill any live exec) — so it is safe to stop here. Resume rediscovers
  // and restarts. Terminal (failed / cancelled) runs are left for teardown, not
  // suspended. Only 'paused' triggers this.
  if (execContext.kind === 'container' && containerCtx) {
    const pausedStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (pausedStatus === 'paused') {
      await suspendContainerForPause(
        deps,
        platform,
        conversationId,
        containerCtx,
        execContext,
        workflowRun.id
      );
      return;
    }
  }

  return finishRun({ ...runCtx, workflow, containerCtx, startedAt: dagStartTime });
}
