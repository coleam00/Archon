/**
 * DAG Workflow Executor
 *
 * Executes a `nodes:`-based workflow in topological order.
 * Independent nodes within the same layer run concurrently via Promise.allSettled.
 * Captures all assistant output regardless of streaming mode for $node_id.output substitution.
 */

import { createRunToolCallAttention } from './tool-call-attention';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import { join as joinPath } from 'path';
import { liveSourceRoots, type WorkflowSourceRoots } from './workflow-source';
import type { WorkflowDeps } from './deps';
import { sourceReleaseNotice } from './deps';
import type { TokenUsage, ExecutionContext } from '@archon/provider-contract';
import type { ContainerRunContext } from './container-context';
import type {
  DagNode,
  NodeOutput,
  WorkflowRun,
  ResolvedWorkflow,
  WorkflowRunOutcome,
  WorkflowRunNodeSession,
  WorkflowUsageLimitWaitContext,
} from './schemas';
import {
  isLoopGroupNode,
  definedOutputPaths,
  runMayPersistSessions,
  isNodeContextResume,
  SUBRUN_METADATA_KEYS,
  persistScopeKey,
} from './schemas';
import { resolvedBodyNodes } from './graph-plan';
import type { RunExitReason } from './schemas/run-terminal-reason';
import { CONTINUATION_RETRY_MS, executionClaim } from './store';
import type { PersistedNodeOutput } from './store';
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
import {
  WORKTREE_DISPOSITION_METADATA_KEY,
  type WorktreeDisposition,
} from './schemas/terminal-record';
import { getWorkflowEventEmitter } from './event-emitter';
import { requireTerminalStatusWrite } from './terminal-status-write';
import {
  rootOutputFields,
  outputRefText,
  type DeclaredOutputPaths,
  resolveNodeOutputField,
} from './output-ref';
import { logWorkflowComplete, logWorkflowError, type WorkflowUsage } from './logger';
import {
  providerLimitResumeAt,
  isProviderLimit,
  type ProviderLimitFailure,
  safeSendMessage,
} from './executor-shared';
import { isTierName } from './model-validation';
import { getLog } from './dag/log';
import { RunSourceUnreadableError } from './dag/node-source';
import {
  type PersistScope,
  type RunInputs,
  type RunLayersContext,
  type SequentialSessionCursor,
} from './dag/run-context';
import { scopedCapabilityMismatchMessage } from './dag/provider-resolution';
import {
  collectScopedCapabilityMismatches,
  collectContainerIncompatibleProviders,
  collectStrictSchemaViolations,
} from './dag/capability-preflight';
import { runLayers } from './dag/run-layers';
import {
  emitContainerLifecycleEvent,
  runContainerWriteBackGate,
  suspendContainerForPause,
} from './dag/container-gate';

/**
 * Usage a resumed run already consumed in earlier passes, rebuilt from its persisted
 * node completion, failure and deferred-usage events by `getDagResumeSnapshot`. Both axes travel
 * together because they are one concept — what this run has spent so far — and seeding
 * only one of them is how cost came to under-report every resumed run while tokens did
 * not (#2469).
 */
export interface PriorRunUsage {
  tokens?: TokenUsage;
  tokensUnknown?: boolean;
  costUsd: number;
}

/** Inputs accepted by {@link executeDagWorkflow}. */
export interface ExecuteDagWorkflowOptions extends RunInputs {
  workflow: ResolvedWorkflow;
  priorCompletedNodes?: Map<string, PersistedNodeOutput>;
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
 * Decide what happens to a completed run's worktree. The check is optional cleanup, so a
 * failure leaves the disposition unset and never blocks the completion write.
 */
async function assessCompletedWorktree(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun
): Promise<{ completedRun: WorkflowRun; worktreeDisposition?: WorktreeDisposition | null }> {
  if (!deps.completedRunWorktree) return { completedRun: workflowRun };
  try {
    // Read fresh: a pre-created run's `owned_worktree` proof is stamped on the row after
    // this object was loaded.
    const completedRun = (await deps.store.getWorkflowRun(workflowRun.id)) ?? workflowRun;
    return {
      completedRun,
      worktreeDisposition: await deps.completedRunWorktree.assess(completedRun),
    };
  } catch (err) {
    getLog().warn(
      { err, workflowRunId: workflowRun.id },
      'workflow.completed_worktree_assess_failed'
    );
    return { completedRun: workflowRun };
  }
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
  const providers = deps.providers;
  const dagStartTime = Date.now();

  // Scoped-capability fail-fast: before ANY node runs, so no node spends in a run
  // that would later reach a node whose MCP servers, skills or plugins cannot load.
  const capabilityMismatches = collectScopedCapabilityMismatches(
    providers,
    workflow.nodes,
    workflowProvider,
    aiProfile
  );
  if (capabilityMismatches.length > 0) {
    throw new Error(scopedCapabilityMismatchMessage(capabilityMismatches));
  }

  // Container capability fail-fast: before ANY node runs (and before any
  // container work), reject a container run whose AI nodes resolve to a provider
  // that can't spawn in-container. No silent downgrade to the host — the user
  // asked for isolation and must get it or a clear error.
  if (execContext.kind === 'container') {
    const incompatible = collectContainerIncompatibleProviders(
      providers,
      workflow.nodes,
      workflowProvider,
      aiProfile
    );
    if (incompatible.size > 0) {
      const list = [...incompatible].sort().join(', ');
      throw new Error(
        `Provider${incompatible.size === 1 ? '' : 's'} '${list}' cannot run inside a ` +
          'container yet (containerExec capability). Use provider claude, or run without ' +
          '--container.'
      );
    }

    // Container is live for this run — surface it in all three logging layers. A
    // resume (the container was rediscovered + restarted by the caller) emits
    // `container_resumed` rather than `container_created` so the timeline is honest.
    const isResume = priorCompletedNodes !== undefined && priorCompletedNodes.size > 0;
    // H4 — native overlay mode grants CAP_SYS_ADMIN, so an adversarial in-container
    // agent can remount the read-only lower read-write and bypass the write-back
    // gate. Warn LOUDLY at run start (console/platform + the lifecycle event) so the
    // operator knows the isolation is accident-protection, not a hostile-agent
    // sandbox, in this mode. Warning-only in v1 (see SECURITY.md).
    const nativeOverlay = containerCtx?.overlayMode === 'native';
    emitContainerLifecycleEvent(
      deps,
      workflowRun.id,
      isResume ? 'resumed' : 'created',
      isResume ? 'container_resumed' : 'container_created',
      execContext.containerId,
      nativeOverlay ? { overlayMode: 'native', gateBypassable: true } : {}
    );

    if (nativeOverlay) {
      await safeSendMessage(
        platform,
        conversationId,
        '⚠️ Container is running in NATIVE overlay mode (CAP_SYS_ADMIN). An adversarial ' +
          'agent could bypass the write-back review by remounting the project root — treat ' +
          'this run as accident-protection, not a sandbox against hostile code. (See SECURITY.md.)',
        { workflowId: workflowRun.id }
      );
      getLog().warn({ workflowRunId: workflowRun.id }, 'dag.container_native_mode_gate_bypassable');
    }
  }

  // Strict-schema preflight: before ANY node runs, reject a workflow whose AI
  // nodes would send a schema that a strict provider will reject at the first
  // turn (OpenAI/Codex requires explicit object properties and complete required
  // coverage). Container scoping is irrelevant — this fires on host too, and it
  // protects the setup costs a first-turn 400 would otherwise burn.
  {
    const violations = collectStrictSchemaViolations(
      providers,
      workflow.nodes,
      workflowProvider,
      aiProfile
    );
    if (violations.length > 0) {
      const [first] = violations;
      const more = violations.length > 1 ? ` (+${violations.length - 1} more)` : '';
      const location =
        `output_format schema strict-mode violation: workflow '${workflow.name}', ` +
        `node '${first.nodeId}', ${first.schemaPath}`;
      if (first.kind === 'missing-properties') {
        throw new Error(
          `${location} is an object schema without 'properties'${more}. ` +
            `Provider '${first.provider}' (OpenAI strict mode) rejects it. ` +
            'Declare the object properties and list every property in required; ' +
            'use a nullable object (e.g. type: ["object","null"]) when the value may be absent.'
        );
      }
      throw new Error(
        `${location} declares ${first.missing.join(', ')} not in 'required'${more}. ` +
          `Provider '${first.provider}' (OpenAI strict mode) rejects it. ` +
          'List every property in required; express optionality in-type ' +
          '(e.g. a ["string","null"] union or an enum sentinel).'
      );
    }
  }

  const workflowTier = workflow.model && isTierName(workflow.model) ? workflow.model : undefined;
  const workflowLevelOptions = {
    effort: workflow.effort,
    fallbackModel: workflow.fallbackModel,
    betas: workflow.betas,
    sandbox: workflow.sandbox,
    webSearchMode: workflow.webSearchMode,
    workflowTier,
  };
  const layers = workflow.plan.layers;
  const nodeOutputs = new Map<string, NodeOutput>();

  // Pre-populate nodeOutputs from prior run so already-completed nodes are
  // treated as done for trigger-rule and $nodeId.output substitution purposes.
  // Nodes flagged `always_run: true` are excluded — they re-execute on resume
  // and downstream consumers must see the fresh output, not the cached one.
  if (priorCompletedNodes && priorCompletedNodes.size > 0) {
    const nodesById = new Map(workflow.nodes.map(n => [n.id, n]));
    let prepopulatedCount = 0;
    for (const [nodeId, prior] of priorCompletedNodes) {
      const node = nodesById.get(nodeId);
      // Nodes flagged always_run re-execute on resume — leave them for fresh output.
      if (node?.always_run) continue;
      // A local producer's loaded definition owns its contract, so its strict
      // `$node.output.<path>` contract survives resume (#2091) and matches the load-time
      // check, even when the row was written by an older binary that recorded only
      // top-level fields. The persisted contract serves producers whose definition states
      // none: a `workflow:` node's is the CHILD's (#2453), and a wait node's is fixed by
      // the engine. A loop_group gets none: its output_format is ignored, but its
      // persisted terminal payload (below) still rehydrates, matching fresh completion
      // since #2637.
      const declaredOutputPaths =
        (node !== undefined ? definedOutputPaths(node) : undefined) ?? prior.declaredOutputPaths;
      nodeOutputs.set(nodeId, {
        state: 'completed',
        output: prior.output,
        // The persisted logical value (#2637): downstream whole-value and `.field`
        // consumers observe exactly what fresh execution exposed. Absent for rows
        // persisted before the key existed — those keep the text-parse fallback.
        ...(prior.structuredOutput !== undefined
          ? { structuredOutput: prior.structuredOutput }
          : {}),
        ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
        ...(prior.execution !== undefined ? { execution: prior.execution } : {}),
      });
      prepopulatedCount++;
    }
    getLog().info(
      {
        workflowRunId: workflowRun.id,
        priorCompletedCount: priorCompletedNodes.size,
        prepopulatedCount,
        alwaysRunResumedCount: priorCompletedNodes.size - prepopulatedCount,
      },
      'dag.workflow_resume_prepopulated'
    );
  }

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

  // Per-node session persistence across workflow re-runs, keyed by the thread that
  // launched the run (see `persistScopeKey`). The `|| undefined` guard keeps an empty
  // key from scoping every invocation to the same blank scope — persistence is simply
  // skipped in that case.
  const runPersistScopeKey: string | undefined = persistScopeKey(workflowRun) || undefined;
  const workflowPersistSessions = workflow.persist_sessions === true;
  let persistScope: PersistScope | undefined;
  if (runPersistScopeKey !== undefined && runMayPersistSessions(workflow)) {
    const sessionsAtStart = deps.store.listWorkflowNodeSessions({
      workflow_name: workflow.name,
      scope_key: runPersistScopeKey,
    });
    // A persisted node that never dispatches (skipped by `when:`, or after a failure)
    // never awaits this; a failed read must not become an unhandled rejection there.
    // Nodes that await it still see the rejection.
    sessionsAtStart.catch(() => undefined);
    persistScope = { key: runPersistScopeKey, sessionsAtStart };
  }
  const namedResumeSourceIds = new Set<string>();
  const collectNamedSources = (nodes: readonly DagNode[]): void => {
    for (const node of nodes) {
      if (isNodeContextResume(node.context)) namedResumeSourceIds.add(node.context.resume);
      if (isLoopGroupNode(node)) collectNamedSources(resolvedBodyNodes(node.loop_group));
    }
  };
  collectNamedSources(workflow.nodes);
  const nodeSessionHandles = new Map<string, SequentialSessionCursor>();
  for (const row of priorNodeSessions ?? []) {
    // The completed-output snapshot is the authority for which nodes actually
    // survived the previous pass. Never resurrect a handle without its completion.
    if (namedResumeSourceIds.has(row.node_id) && nodeOutputs.has(row.node_id)) {
      nodeSessionHandles.set(row.node_id, {
        sessionId: row.provider_session_id,
        provider: row.provider,
      });
    }
  }

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
  // step_names are the raw node ids (identical to pre-refactor behavior). Fields stay
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
   */
  const persistRunUsage = async (): Promise<void> => {
    const usage = {
      // No usage stays absent: a bash-only workflow must not read as a free AI run.
      ...(runCtx.totalCostUsd !== undefined ? { total_cost_usd: runCtx.totalCostUsd } : {}),
      ...(runCtx.totalTokensUnknown
        ? {
            total_tokens_unknown: true,
            total_tokens_in: null,
            total_tokens_out: null,
            total_cache_read_tokens: null,
            total_cache_write_tokens: null,
            total_cache_partial: null,
          }
        : {}),
      ...(runCtx.totalTokens !== undefined
        ? {
            total_tokens_in: runCtx.totalTokens.input,
            total_tokens_out: runCtx.totalTokens.output,
            ...(runCtx.totalTokens.cacheRead !== undefined
              ? { total_cache_read_tokens: runCtx.totalTokens.cacheRead }
              : {}),
            ...(runCtx.totalTokens.cacheWrite !== undefined
              ? { total_cache_write_tokens: runCtx.totalTokens.cacheWrite }
              : {}),
            // Marks the two cache totals above as a floor rather than an exact figure.
            ...(runCtx.totalTokens.cachePartial ? { total_cache_partial: true } : {}),
          }
        : {}),
    };
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
   * The wait a failed pass takes instead of failing, when every failed node either hit a
   * provider usage limit whose reset the provider reported and that is still ahead, or hit a
   * rate limit that outlasted its retries (deadline: its reported reset when still ahead,
   * else a jittered backoff). The run cannot progress before the last of those deadlines, so
   * it waits for it. Any other failure, a usage limit without a reported reset,
   * `autoResumeOnQuotaReset: false`, or a container run (the continuation host does not
   * continue one) leaves the run to fail. Only the typed class says a limit is hit; the
   * error text never does.
   */
  const usageLimitWait = async (): Promise<
    { wait: WorkflowUsageLimitWaitContext; cause: ProviderLimitFailure['class'] } | undefined
  > => {
    const skip = async (
      nodeId: string,
      reason: 'reset_unavailable' | 'disabled' | 'reset_passed' | 'container_unsupported'
    ): Promise<undefined> => {
      await deps.store.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'quota_resume_skipped',
        step_name: nodeId,
        data: { reason },
      });
      return undefined;
    };
    const now = Date.now();
    let latest:
      | { nodeId: string; resumeAt: number; cause: ProviderLimitFailure['class'] }
      | undefined;
    for (const [nodeId, output] of runCtx.nodeOutputs) {
      if (output.state !== 'failed') continue;
      const failure = output.providerFailure;
      if (!isProviderLimit(failure)) return undefined;
      const resumeAt = providerLimitResumeAt(failure, now);
      if (resumeAt === undefined) return skip(nodeId, 'reset_unavailable');
      if (latest === undefined || resumeAt > latest.resumeAt)
        latest = { nodeId, resumeAt, cause: failure.class };
    }
    if (latest === undefined) return undefined;
    if (config.workflows?.autoResumeOnQuotaReset === false) return skip(latest.nodeId, 'disabled');
    if (latest.resumeAt <= now) return skip(latest.nodeId, 'reset_passed');
    if (execContext.kind === 'container') return skip(latest.nodeId, 'container_unsupported');
    return {
      wait: {
        owner: 'node',
        nodeId: latest.nodeId,
        kind: 'quota',
        pauseId: randomUUID(),
        waitingSince: new Date(now).toISOString(),
        resumeAt: new Date(latest.resumeAt).toISOString(),
      },
      cause: latest.cause,
    };
  };

  /** Pause the run on a provider-limit wait. False when the pass must fail instead. */
  const pauseForUsageLimit = async (): Promise<boolean> => {
    const limit = await usageLimitWait();
    if (limit === undefined) return false;
    const { wait, cause } = limit;
    try {
      await deps.store.pauseWorkflowRunForWait(workflowRun.id, wait, {
        kind: 'started',
        stepName: wait.nodeId,
      });
    } catch (pauseError) {
      // A run cancelled or paused meanwhile keeps that status, exactly as the failure
      // branches below leave it.
      if ((await deps.store.getWorkflowRunStatus(workflowRun.id)) === 'running') throw pauseError;
      getLog().warn({ workflowRunId: workflowRun.id }, 'dag.usage_limit_wait_status_changed');
      return true;
    }
    getLog().info(
      { workflowRunId: workflowRun.id, nodeId: wait.nodeId, resumeAt: wait.resumeAt, cause },
      'dag.usage_limit_wait_started'
    );
    await safeSendMessage(
      platform,
      conversationId,
      cause === 'rate_limited'
        ? `⏸️ Workflow '${workflow.name}' hit a provider rate limit at node '${wait.nodeId}' ` +
            `and ran out of retries. It tries again at ${wait.resumeAt}; resume it to try ` +
            'sooner, or abandon it to stop it.'
        : `⏸️ Workflow '${workflow.name}' hit a provider usage limit at node '${wait.nodeId}'. ` +
            `It waits until the limit resets at ${wait.resumeAt}, then continues.`,
      { workflowId: workflowRun.id }
    );
    return true;
  };

  /**
   * The engine's terminal failure write. The live `workflow_failed` event is published only
   * when this call committed the failure: a run another writer already finished (a
   * cancellation during the failure notification, or a competing failure) keeps that
   * writer's outcome and announcement. A rejected write throws the typed marker, which the
   * outer executor catch rethrows without emitting.
   */
  const failRun = async (failMsg: string, exitReason: RunExitReason, site: string) => {
    const emitter = getWorkflowEventEmitter();
    try {
      const { failed } = await requireTerminalStatusWrite(
        deps.store.failWorkflowRun(workflowRun.id, failMsg, { exitReason }),
        { workflowRunId: workflowRun.id, site }
      );
      if (failed) {
        emitter.emit({
          type: 'workflow_failed',
          runId: workflowRun.id,
          workflowName: workflow.name,
          error: failMsg,
        });
      }
    } finally {
      emitter.unregisterRun(workflowRun.id);
    }
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
    if (await skipIfStatusChanged('dag.run_budget_refusal_status_changed')) return;
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
    await failRun(failMsg, 'budget_refused', 'dag.run_budget_refused_fail');
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
    const { released } = await deps.store.releaseRunForUnreadableSource(workflowRun.id, {
      claimId: executionClaim(workflowRun.metadata),
      nodeId: error.nodeId,
      ...(error.path !== undefined ? { path: error.path } : {}),
      error: error.message,
      retryAt: new Date(Date.now() + CONTINUATION_RETRY_MS).toISOString(),
    });
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
    if (error instanceof RunBudgetRefusedError || error instanceof RunSourceUnreadableError) {
      // The thunk that threw never reported its spend, nor did its settled siblings, so
      // the in-memory totals miss it. The durable rows hold all of it.
      try {
        const durable = await deps.store.getDagResumeSnapshot(workflowRun.id);
        // The fold sums to 0 when nothing reported cost; keep a run with no AI usage absent.
        if (runCtx.totalCostUsd !== undefined || durable.costUsd !== 0) {
          runCtx.totalCostUsd = durable.costUsd;
        }
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
  const sourceReleased =
    sourceUnreadable !== undefined && (await releaseRunForUnreadableSource(sourceUnreadable));
  // Pull the mutated accumulators back into local scope for the terminal tally below.
  const totalCostUsd = runCtx.totalCostUsd;
  const totalTokens = runCtx.totalTokens;

  // Container pause economics (Phase C): if a node paused the run (approval /
  // interactive gate), suspend the container so a multi-day wait costs ~0 RAM/CPU.
  // The pause happens BETWEEN layers, after node completion — the #2134 background-
  // task wait gate has already drained and no `docker exec` is in flight (docker
  // stop would kill any live exec) — so it is safe to stop here. Resume rediscovers
  // and restarts. Terminal (failed / cancelled) runs are left for teardown, not
  // suspended. Only 'paused' triggers this.
  if (execContext.kind === 'container' && containerCtx) {
    try {
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
        return sourceUnreadable !== undefined
          ? { kind: 'source_release', released: sourceReleased }
          : undefined;
      }
    } catch (error) {
      if (sourceUnreadable === undefined) throw error;
      getLog().error(
        { err: error, workflowRunId: workflowRun.id },
        'dag.source_release_container_cleanup_failed'
      );
    }
  }

  if (sourceUnreadable !== undefined) return { kind: 'source_release', released: sourceReleased };

  /**
   * Bail out of the final completion/failure write if the run was transitioned
   * externally. Strict `!== 'running'` check is correct here because we don't
   * want to mark a paused run as complete — the approval gate is still live.
   *
   * Emitter unregister is conditional: terminal states (cancelled / deleted /
   * completed / failed) unregister to release subscription resources, but
   * `paused` keeps the emitter registered so SSE stays connected while the
   * approval gate awaits the user — crucial for resume observability.
   */
  async function skipIfStatusChanged(logEvent: string): Promise<boolean> {
    const status = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (status === 'running') return false;
    getLog().info({ workflowRunId: workflowRun.id, status: status ?? 'deleted' }, logEvent);
    if (status !== 'paused') {
      getWorkflowEventEmitter().unregisterRun(workflowRun.id);
    }
    return true;
  }

  // Single-pass: compute node outcome counts and derive success/failure booleans
  const nodeCounts = { completed: 0, failed: 0, skipped: 0, total: workflow.nodes.length };
  for (const o of nodeOutputs.values()) {
    if (o.state === 'completed') nodeCounts.completed++;
    else if (o.state === 'failed') nodeCounts.failed++;
    else if (o.state === 'skipped') nodeCounts.skipped++;
  }
  const anyCompleted = nodeCounts.completed > 0;
  const anyFailed = nodeCounts.failed > 0;
  const runTranscriptUsage: WorkflowUsage = {
    ...(totalCostUsd !== undefined ? { cost_usd: totalCostUsd } : {}),
    ...(totalTokens !== undefined ? { tokens: totalTokens } : {}),
  };

  getLog().info(
    { nodeCount: workflow.nodes.length, anyCompleted, anyFailed },
    'dag_workflow_finished'
  );

  if (!anyCompleted) {
    if (await skipIfStatusChanged('dag.skip_fail_status_changed')) return;
    if (anyFailed && (await pauseForUsageLimit())) return;
    const failedNodes: string[] = [];
    for (const [nodeId, o] of nodeOutputs) {
      if (o.state === 'failed') failedNodes.push(nodeId);
    }
    const failMsg =
      failedNodes.length > 0
        ? `DAG workflow '${workflow.name}' failed: node${failedNodes.length > 1 ? 's' : ''} ${failedNodes.join(', ')} failed. ` +
          `${nodeCounts.skipped} downstream node${nodeCounts.skipped !== 1 ? 's were' : ' was'} skipped.`
        : `DAG workflow '${workflow.name}' completed with no successful nodes. ` +
          'Check node conditions, trigger rules, and upstream failures.';
    // Note: nodeCounts not stored for failed runs — failWorkflowRun only stores { error }.
    // Frontend guards with isValidNodeCounts so missing node_counts is safe. (Usage IS
    // stored: persistRunUsage wrote it at the run tail, before this branch — #2469.)
    await logWorkflowError(logDir, workflowRun.id, failMsg, runTranscriptUsage).catch(
      (logErr: Error) => {
        getLog().error(
          { err: logErr, workflowRunId: workflowRun.id },
          'dag.workflow_error_log_write_failed'
        );
      }
    );
    await safeSendMessage(platform, conversationId, `\u274c ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    await failRun(
      failMsg,
      // A first-node failure completes nothing, but it is still a node failure.
      anyFailed ? 'node_error' : 'no_nodes_completed',
      'dag.no_nodes_completed_fail'
    );
    return;
  }

  if (anyFailed) {
    if (await skipIfStatusChanged('dag.skip_fail_status_changed')) return;
    if (await pauseForUsageLimit()) return;
    const failedNodes = [...nodeOutputs.entries()]
      .filter(([, o]) => o.state === 'failed')
      .map(([id, o]) => `'${id}': ${o.state === 'failed' ? o.error : 'unknown'}`)
      .join('; ');
    const failMsg = `DAG workflow '${workflow.name}' completed with failures: ${failedNodes}`;
    await logWorkflowError(logDir, workflowRun.id, failMsg, runTranscriptUsage).catch(
      (logErr: Error) => {
        getLog().error(
          { err: logErr, workflowRunId: workflowRun.id },
          'dag.workflow_error_log_write_failed'
        );
      }
    );
    await safeSendMessage(platform, conversationId, `\u274c ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    await failRun(failMsg, 'node_error', 'dag.node_failure_fail');
    return;
  }

  // Check if status was changed externally (e.g. cancelled) before marking complete.
  if (await skipIfStatusChanged('dag.skip_complete_status_changed')) return;

  // Evidence gate (#2230): thin terminal file-presence gate, a sibling of the
  // approval/write-back gates (run-status transitions are engine governance).
  // When the workflow declares `evidence_policy.required: true`, refuse to flip
  // the run to `completed` unless `$ARTIFACTS_DIR/evidence.json` exists — the
  // engine checks presence only (no schema validation, no content checks, no
  // git/gh I/O). Any contents satisfy this convention; deterministic checks
  // and authored outcomes remain separate. Placed BEFORE
  // the container write-back gate so a run that cannot complete never pauses
  // for (or applies) write-back — mirroring how node-failure runs skip that
  // gate entirely. Resume-safe: the run id (and therefore artifactsDir) is
  // stable across resume, so a failed run resumed after evidence.json is
  // produced re-enters here with all nodes prior-completed and completes.
  if (workflow.evidence_policy?.required === true) {
    const evidencePath = joinPath(artifactsDir, 'evidence.json');
    if (!existsSync(evidencePath)) {
      const failMsg =
        `DAG workflow '${workflow.name}' failed the evidence marker gate: ` +
        `evidence_policy.required is true but its conventional marker file is absent at ${evidencePath}. ` +
        'The policy checks only that path; create the marker in the host artifacts directory, ' +
        'then resume the run.';
      getLog().error({ workflowRunId: workflowRun.id, evidencePath }, 'dag.evidence_gate_failed');
      // Structured, machine-readable note first (metadata merge), then the
      // failed-status write — so metadata.evidence_validation is already present
      // the moment the run reads as failed.
      await deps.store
        .updateWorkflowRun(workflowRun.id, {
          metadata: {
            evidence_validation: {
              status: 'missing',
              policy: 'evidence_policy.required',
              expected_path: evidencePath,
              checked_at: new Date().toISOString(),
            },
          },
        })
        .catch((dbErr: Error) => {
          getLog().error(
            { err: dbErr, workflowRunId: workflowRun.id },
            'dag.evidence_metadata_write_failed'
          );
        });
      // Persist the reason into the workflow-events log (contract: never throws).
      await deps.store.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'evidence_validation_failed',
        data: { policy: 'evidence_policy.required', expected_path: evidencePath },
      });
      await logWorkflowError(logDir, workflowRun.id, failMsg, runTranscriptUsage).catch(
        (logErr: Error) => {
          getLog().error(
            { err: logErr, workflowRunId: workflowRun.id },
            'dag.workflow_error_log_write_failed'
          );
        }
      );
      await safeSendMessage(platform, conversationId, `❌ ${failMsg}`, {
        workflowId: workflowRun.id,
      });
      // The metadata merge above precedes the terminal write, so
      // `metadata.evidence_validation` is present the moment the run reads as failed.
      await failRun(failMsg, 'evidence_missing', 'dag.evidence_gate_fail');
      return;
    }
    getLog().info({ workflowRunId: workflowRun.id, evidencePath }, 'dag.evidence_gate_passed');
  }

  // Container write-back gate (Phase C): all nodes succeeded — before completing,
  // present the overlay diff and (unless auto) pause for approval. This is an
  // ENGINE-level gate with no DAG node. On the FIRST arrival it either pauses
  // (approve policy, non-empty diff) or applies (auto / has changes) / skips
  // (empty diff). On a RESUME after the decision, the DAG re-ran with every node
  // skipped and lands here again with `pending_writeback` set — it applies or
  // discards and falls through to completion. `paused` short-circuits (the gate
  // suspended the container); any other outcome falls through to completeWorkflowRun.
  if (execContext.kind === 'container' && containerCtx) {
    const gate = await runContainerWriteBackGate(
      deps,
      platform,
      conversationId,
      workflowRun.id,
      containerCtx,
      execContext
    );
    if (gate === 'paused') return;
  }

  // Terminal output (the run's "summary"). Computed BEFORE completeWorkflowRun so a
  // sub-run can persist it into its own metadata: a `workflow:` parent re-reads it from
  // there on auto-resume (the child's executeWorkflow return value is discarded across the
  // human gate).
  //
  // #2470: when a CHILD run's workflow declares `returns:`, its terminal output is THAT
  // node's output — even a non-sink — instead of the positional first-sink scan. Gated on
  // parent_run_id: a top-level run's summary stays the sink-scan chat/CLI affordance, not a
  // caller contract. A `returns` node that didn't complete / produced blank output threads
  // '' with a WARN and does NOT fall through to the sink scan (that would resurrect the
  // positional accident under a new name). The loop_group per-iteration terminal scan
  // (~executeLoopGroupNode) is byte-identical and DELIBERATELY unchanged — its result is
  // the iteration's, never a caller's.
  let terminalOutput: string | undefined;
  // The selected terminal node's structured payload (#2637), stamped beside the text
  // summary as `metadata.summary_value` so a parent `workflow:` node threads the
  // LOGICAL value back (fan-out aggregation and `.field` access keep the type).
  let terminalStructuredOutput: unknown;
  // The selected node's declared field paths (#2453) — the callee-owned half of the
  // result contract. Stamped beside `summary_value` so the parent's `workflow:` node can
  // authorize `$<node>.output.a.b` from the CHILD's schema instead of requiring the
  // caller to repeat it. Only the projection travels; the schema stays in captured source.
  let terminalDeclaredOutputPaths: DeclaredOutputPaths | undefined;
  if (workflow.returns !== undefined && workflowRun.parent_run_id) {
    const returnsOutput = nodeOutputs.get(workflow.returns);
    const value = returnsOutput?.state === 'completed' ? returnsOutput.output : undefined;
    if (value !== undefined && value.trim().length > 0) {
      terminalOutput = value;
      terminalStructuredOutput =
        returnsOutput !== undefined && 'structuredOutput' in returnsOutput
          ? returnsOutput.structuredOutput
          : undefined;
      // Taken from the completed node rather than re-derived from the definition: the
      // node already resolved its own contract (a wait node's fixed schema, a resumed
      // node's persisted projection), and re-deriving here would silently disagree.
      terminalDeclaredOutputPaths =
        returnsOutput?.state === 'completed' ? returnsOutput.declaredOutputPaths : undefined;
    } else {
      getLog().warn(
        { workflowRunId: workflowRun.id, returns: workflow.returns },
        'workflow.returns_node_blank_output'
      );
      terminalOutput = '';
    }
  } else {
    const terminalSink = workflow.plan.sinks
      .map(nodeId => nodeOutputs.get(nodeId))
      .find(o => o?.state === 'completed' && o.output.trim().length > 0);
    terminalOutput = terminalSink?.output;
    // The sink scan's node owns its contract exactly as a `returns:` node does. Stamping
    // it here too keeps the two channels together: a child without `returns:` has threaded
    // its terminal LOGICAL value to the parent since #2637, and a value whose field
    // authorization stayed behind would read as schemaless downstream.
    terminalDeclaredOutputPaths =
      terminalSink?.state === 'completed' ? terminalSink.declaredOutputPaths : undefined;
    terminalStructuredOutput =
      terminalSink !== undefined && 'structuredOutput' in terminalSink
        ? terminalSink.structuredOutput
        : undefined;
  }

  const duration = Date.now() - dagStartTime;

  // Emit completion, then record it. The transcript and the live event do not depend
  // on the status write and used to run whether or not it succeeded, so the
  // (now-throwing) write goes last. Terminal telemetry is reported by the run store
  // after the write commits.
  await logWorkflowComplete(logDir, workflowRun.id, runTranscriptUsage);
  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'workflow_completed',
    runId: workflowRun.id,
    workflowName: workflow.name,
    duration,
  });
  emitter.unregisterRun(workflowRun.id);

  const { completedRun, worktreeDisposition } = await assessCompletedWorktree(deps, workflowRun);

  await requireTerminalStatusWrite(
    deps.store.completeWorkflowRun(
      workflowRun.id,
      { duration_ms: duration },
      {
        node_counts: nodeCounts,
        // Cost and token totals are NOT written here — `persistRunUsage` already wrote
        // them at the run tail, before this branch was chosen (#2469). Keeping a second
        // copy here would be two writers of the same three keys, free to drift.
        // A sub-run persists its terminal summary so the parent can thread it as
        // `$<node>.output` on re-entry. Gated on parent_run_id to bound metadata
        // growth to child runs only (top-level runs return the summary directly).
        // `summary_value` is the additive logical sibling (#2637): old binaries keep
        // reading `summary`, new parents prefer the typed value when present.
        ...(workflowRun.parent_run_id && terminalOutput ? { summary: terminalOutput } : {}),
        ...(workflowRun.parent_run_id && terminalOutput && terminalStructuredOutput !== undefined
          ? { [SUBRUN_METADATA_KEYS.summaryValue]: terminalStructuredOutput }
          : {}),
        // The callee-owned field contract (#2453). Gated on the same terminal output as
        // the two keys above, so a blank/incomplete `returns:` node stamps no contract
        // at all rather than one nothing satisfies. `summary_declared_fields` is derived
        // from the paths and still written for older binaries, which read only it.
        ...(workflowRun.parent_run_id && terminalOutput && terminalDeclaredOutputPaths !== undefined
          ? {
              [SUBRUN_METADATA_KEYS.summaryDeclaredOutputPaths]: terminalDeclaredOutputPaths,
              [SUBRUN_METADATA_KEYS.summaryDeclaredFields]: rootOutputFields(
                terminalDeclaredOutputPaths
              ),
            }
          : {}),
        ...(worktreeDisposition
          ? { [WORKTREE_DISPOSITION_METADATA_KEY]: worktreeDisposition }
          : {}),
      }
    ),
    { workflowRunId: workflowRun.id, site: 'dag_db_complete_failed' }
  );

  // The terminal record already carries the decision. Removing the checkout is cleanup
  // of terminal data, so a refusal or failure leaves it in place and the run completed.
  if (worktreeDisposition?.disposition === 'release') {
    try {
      await deps.completedRunWorktree?.release(completedRun);
      getLog().info({ workflowRunId: workflowRun.id }, 'workflow.completed_worktree_released');
    } catch (err) {
      getLog().warn(
        { err, workflowRunId: workflowRun.id },
        'workflow.completed_worktree_release_failed'
      );
    }
  }

  // terminalOutput (computed above, before the completion write) is the run's
  // summary for the parent conversation and the `workflow:` re-entry path.
  return terminalOutput;
}
