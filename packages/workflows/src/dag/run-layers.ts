/**
 * The layer walker: runs a DAG's (or subgraph's) topological layers, deciding per node
 * whether it is replayed from a prior pass, skipped, or dispatched, and folding each
 * layer's results into the shared run context.
 */
import { peerAdmissions } from '../interaction-admission';
import { findFanOutChildRuns } from './nodes/workflow/fan-out-children';
import { nodeInvocationKey } from '../node-record-reader';
import { finishNodeExecution, newNodeInvocation, describeExecutionNode } from '../node-execution';
import { NodeEventWriteError, recordNodeState } from '../node-event-write';
import type { DagNode, SkipCause } from '../schemas';
import {
  canSuspend,
  nodeUsesPersistedScope,
  readSubrunMetadata,
  isNodeContextResume,
} from '../schemas';
import type { PersistedNodeOutput } from '../store';
import { RunBudgetRefusedError } from '../run-budget';
import { TerminalStatusWriteError } from '../terminal-status-write';
import { evaluateCondition } from '../condition-evaluator';
import { writeNodeArtifact } from '../artifacts-index';
import { safeSendMessage } from '../platform-messages';
import { getLog } from './log';
import { sumTokenUsage } from './usage';
import { RunSourceUnreadableError, settledValuesOrThrow } from './node-source';
import {
  beginExecution,
  ownsBodySessionCursor,
  type LayerNodeResult,
  type RunLayersContext,
} from './run-context';
import { resolveRunInputs } from './references';
import { formatPersistedNodeOutput, persistedExecutionOutput } from './node-output';
import { isCheckoutGuarded } from './checkout-guard';
import { checkComposedBlockBoundaries, checkTriggerRule } from './trigger-rule';
import { dispatchNode } from './dispatch';
import { getStaleCachedDependencies } from './stale-dependencies';
/**
 * Await thunks one at a time, collecting outcomes in `Promise.allSettled` shape so the
 * caller's result handling is identical for the sequential and concurrent paths.
 */
async function settleSequentially(
  thunks: readonly (() => Promise<LayerNodeResult>)[]
): Promise<PromiseSettledResult<LayerNodeResult>[]> {
  const settled: PromiseSettledResult<LayerNodeResult>[] = [];
  for (const thunk of thunks) {
    try {
      settled.push({ status: 'fulfilled', value: await thunk() });
    } catch (reason) {
      settled.push({ status: 'rejected', reason });
    }
  }
  return settled;
}

/**
 * Walk the topological `layers` of a DAG (or subgraph), executing each layer's nodes
 * concurrently within each admission phase, aggregating results into `ctx.nodeOutputs` and usage into
 * `ctx`. Stops early (returns) when a between-layer status check sees a non-running run
 * state (paused/cancelled/deleted). Returns the observed stop reason so top-level
 * cleanup preserves the pause boundary even if resume has already acquired the run.
 *
 * Shared by the top-level DAG, `executeLoopGroupNode`'s per-iteration body and each
 * composed fan-out instance; `ctx.stepNamePrefix` is empty for the top-level DAG.
 */
export async function runLayers(ctx: RunLayersContext): Promise<'paused' | 'stopped' | undefined> {
  // nodeOutputs + accumulators + lastSequentialSession are mutated in place on `ctx`.

  for (let layerIdx = 0; layerIdx < ctx.layers.length; layerIdx++) {
    await ctx.toolAttention.refresh();
    const layer = ctx.layers[layerIdx];
    const isParallelLayer = layer.length > 1;

    if (isParallelLayer) {
      ctx.lastSequentialSession = undefined; // reset — parallel nodes can't share sessions
    }

    // Build a thunk per node so the layer can run either concurrently or strictly
    // sequentially within an admission phase. The `mutates_checkout: false` assertion snapshots before and
    // asserts after a node's own execution, so when a guarded node shares the layer
    // with any node that isn't checkout-guarded (including loop/loop_group/workflow
    // siblings whose internal execution would overlap the window), that sibling's
    // legitimate write would be blamed on the guarded node: such a mixed layer runs
    // sequentially. A layer of guarded nodes only runs concurrently, since no node in
    // it may write: the writer still sees its own write and fails, and a sibling
    // whose window overlapped fails with it, its error naming the siblings.
    const guardedCount = layer.filter(isCheckoutGuarded).length;
    const serializeLayer = guardedCount > 0 && guardedCount < layer.length;
    const guardedLayerSnapshots = serializeLayer ? undefined : new Set<string>();
    // A nested interaction can persist a pause before its ordinary sibling settles.
    // Settle ordinary peers first inside loop bodies so admission sees their failures.
    const phases = ctx.interactionAdmission
      ? [layer.filter(node => !canSuspend(node)), layer.filter(canSuspend)]
      : [layer];
    for (const phase of phases) {
      const layerHadFailure = await runLayerPhase(
        ctx,
        phase,
        isParallelLayer,
        serializeLayer,
        guardedLayerSnapshots
      );

      if (layerHadFailure) {
        getLog().warn({ layerIdx, nodeCount: layer.length }, 'dag_layer_had_failures');
      }
    }

    await ctx.afterLayer?.();

    const stop = await stopsBetweenLayers(ctx, layerIdx);
    if (stop !== undefined) return stop;
  }
  return undefined;
}

async function runLayerPhase(
  ctx: RunLayersContext,
  layer: readonly DagNode[],
  isParallelLayer: boolean,
  serializeLayer: boolean,
  guardedLayerSnapshots: Set<string> | undefined
): Promise<boolean> {
  const peers =
    ctx.interactionAdmission && layer.some(canSuspend)
      ? peerAdmissions(ctx.interactionAdmission, layer.length)
      : undefined;
  const nodeThunks = layer.map(
    (node, index): (() => Promise<LayerNodeResult>) =>
      async (): Promise<LayerNodeResult> => {
        const nodeCtx: RunLayersContext = {
          ...ctx,
          currentExecution: undefined,
          interactionAdmission: peers?.[index].admission ?? ctx.interactionAdmission,
          guardedLayerSnapshots,
          nodeInvocation:
            ctx.unfinishedInvocations?.get(
              nodeInvocationKey(ctx.stepNamePrefix + node.id, ctx.loopGroupPath)
            )?.invocation ?? newNodeInvocation(ctx.loopGroupPath),
        };
        try {
          const result =
            (await admitNode(nodeCtx, node)) ??
            (await dispatchNode(nodeCtx, node, isParallelLayer));
          if (result.output.state === 'failed') nodeCtx.interactionAdmission?.failed(node.id);
          return result;
        } catch (error) {
          nodeCtx.interactionAdmission?.failed(node.id);
          return await recordPreExecutionFailure(nodeCtx, node, error);
        } finally {
          peers?.[index].finished();
        }
      }
  );
  // Mixed checkout guards still require sequential execution within each phase.
  const layerResults =
    serializeLayer && layer.some(isCheckoutGuarded)
      ? await settleSequentially(nodeThunks)
      : await Promise.allSettled(nodeThunks.map(thunk => thunk()));

  const layerHadFailure = await aggregateLayerResults(ctx, layer, layerResults, isParallelLayer);
  settledValuesOrThrow(layerResults, ctx.workflowRun.id);

  return layerHadFailure;
}

/**
 * A run continued after a pause had already moved past the nodes that failed before
 * the pause: their dependents ran on the failure. Re-running them would be a retry
 * nobody asked for, and would change what those dependents and any answered wait
 * were computed from, so the failure is replayed as it was. The prior pass's
 * `node_failed` row stays the node's latest record. `always_run` keeps re-executing.
 */
function replayPriorFailure(ctx: RunLayersContext, node: DagNode): LayerNodeResult | undefined {
  const failure = ctx.replayedFailures?.get(node.id);
  if (failure === undefined || node.always_run) return undefined;
  getLog().info(
    { workflowRunId: ctx.workflowRun.id, nodeId: node.id },
    'dag.node_prior_failure_replayed'
  );
  return {
    nodeId: node.id,
    output: {
      state: 'failed',
      output: '',
      error: failure.error,
      ...(failure.failureKind !== undefined ? { failureKind: failure.failureKind } : {}),
    },
  };
}

/**
 * Decide whether a node dispatches. Returns the node's settled result when it does not:
 * replayed from a prior pass, or skipped by an enclosing include boundary, its trigger
 * rule, or its `when:` condition.
 */
async function admitNode(
  ctx: RunLayersContext,
  node: DagNode
): Promise<LayerNodeResult | undefined> {
  // Lifecycle events expose only the immediate enclosing iteration; artifact
  // identity retains the complete outermost-to-innermost lineage.
  const iteration = ctx.loopGroupPath.at(-1)?.iteration;
  // A prior success is reusable only while every enclosing include is still active.
  // Unlike ordinary node-local rules, a composed boundary governs the whole block,
  // so resume must not let a stale completed descendant cross a newly-false gate.
  const replayedFailure = replayPriorFailure(ctx, node);
  if (replayedFailure !== undefined) return replayedFailure;
  const priorCompletedNodes = ctx.priorCompletedNodes;
  const isCachedPriorSuccess = priorCompletedNodes?.has(node.id) === true && !node.always_run;
  const composedBoundaryDecision = checkComposedBlockBoundaries(
    node,
    ctx.nodeOutputs,
    resolveRunInputs(ctx.workflowRun),
    {
      evaluateEntryBoundary: isCachedPriorSuccess,
      loopBodyScopes: ctx.loopBodyScopes,
    }
  );

  // 0. Skip if this node completed successfully in a prior run (resume path),
  // unless its composed boundary is now inactive. `always_run: true` opts the
  // node out of resume caching and re-executes it.
  if (priorCompletedNodes?.has(node.id)) {
    const replayed = await replayPriorSuccess(
      ctx,
      node,
      priorCompletedNodes,
      composedBoundaryDecision
    );
    if (replayed !== undefined) return replayed;
  }

  // 1. Enforce every enclosing include boundary before this node's local rule.
  const triggerDecision =
    composedBoundaryDecision.decision === 'skip'
      ? composedBoundaryDecision
      : checkTriggerRule(node, ctx.nodeOutputs);
  if (triggerDecision.decision === 'skip') {
    const { cause } = triggerDecision;
    getLog().info({ nodeId: node.id, reason: 'trigger_rule' }, 'dag_node_skipped');
    const output = await recordNodeState(
      { store: ctx.deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        beginExecution(ctx, node),
        { status: 'skipped', reason: 'trigger_rule', cause },
        { output: { text: '' }, diagnostics: { iteration, expr: node.when } }
      )
    );
    return { nodeId: node.id, output };
  }

  // 2. Evaluate when: condition
  if (node.when !== undefined) {
    // This run's named inputs are threaded in so `when: "$INPUTS.mode == 'fast'"`
    // branches on a caller's `with:` value. Without it a sub-run child could READ
    // `$INPUTS.mode` in a prompt but never branch on it — the ref parsed as a node
    // called `INPUTS` and failed the node (#2453 defect 1).
    const { result: conditionPasses, parsed: conditionParsed } = evaluateCondition(
      node.when,
      ctx.nodeOutputs,
      resolveRunInputs(ctx.workflowRun),
      { loopPrevOutputs: ctx.loopPrevOutputs }
    );
    if (!conditionParsed) {
      const cause: SkipCause = {
        kind: 'condition_parse_error',
        expr: node.when,
      };
      const parseErrMsg = `⚠️ Node '${node.id}': unparseable \`when:\` expression "${node.when}" — node skipped (fail-closed). Check syntax: \`$nodeId.output == 'VALUE'\`, \`$nodeId.output > '5'\`, or compound \`$a.output == 'X' && $b.output != 'Y'\`.`;
      await safeSendMessage(ctx.platform, ctx.conversationId, parseErrMsg, {
        workflowId: ctx.workflowRun.id,
        nodeName: node.id,
      });
      getLog().error(
        { nodeId: node.id, when: node.when },
        'dag_node_skipped_condition_parse_error'
      );
      const output = await recordNodeState(
        { store: ctx.deps.store, logDir: ctx.logDir },
        finishNodeExecution(
          beginExecution(ctx, node),
          { status: 'skipped', reason: 'when_condition_parse_error', cause },
          { output: { text: '' }, diagnostics: { iteration, expr: node.when } }
        )
      );
      return { nodeId: node.id, output };
    }
    if (!conditionPasses) {
      const cause: SkipCause = { kind: 'condition', expr: node.when };
      getLog().info({ nodeId: node.id, when: node.when }, 'dag_node_skipped_condition');
      const output = await recordNodeState(
        { store: ctx.deps.store, logDir: ctx.logDir },
        finishNodeExecution(
          beginExecution(ctx, node),
          { status: 'skipped', reason: 'when_condition', cause },
          { output: { text: '' }, diagnostics: { iteration, expr: node.when } }
        )
      );
      return { nodeId: node.id, output };
    }
  }
  return suppressFailedLoopInteraction(ctx, node);
}

async function suppressFailedLoopInteraction(
  ctx: RunLayersContext,
  node: DagNode
): Promise<LayerNodeResult | undefined> {
  if (node.kind === 'gate' || node.kind === 'wait') {
    await ctx.interactionAdmission?.beforeInteraction();
  }
  const origin = ctx.interactionAdmission?.failure();
  if (origin !== undefined && node.kind !== 'loop_group' && canSuspend(node)) {
    const output = await recordNodeState(
      { store: ctx.deps.store, logDir: ctx.logDir },
      finishNodeExecution(beginExecution(ctx, node), {
        status: 'skipped',
        reason: 'trigger_rule',
        cause: { kind: 'upstream_failed', origin },
      })
    );
    return { nodeId: node.id, output };
  }
  return undefined;
}

/**
 * Replay a node's prior-pass success, or record why it re-executes instead: `always_run`,
 * or a dependency whose value changed since (#2402). Undefined when the node re-executes.
 */
async function replayPriorSuccess(
  ctx: RunLayersContext,
  node: DagNode,
  priorCompletedNodes: ReadonlyMap<string, PersistedNodeOutput>,
  composedBoundaryDecision: ReturnType<typeof checkComposedBlockBoundaries>
): Promise<LayerNodeResult | undefined> {
  const formatThisNodesPriorOutput = (): ReturnType<typeof formatPersistedNodeOutput> =>
    formatPersistedNodeOutput(priorCompletedNodes.get(node.id)?.output ?? '', ctx.artifactsDir);
  if (node.always_run) {
    getLog().info({ nodeId: node.id }, 'dag.node_always_run_resume_forced');
    const alwaysRunStepName = ctx.stepNamePrefix + node.id;
    // The prior value being reset can be arbitrarily large — getDagResumeSnapshot
    // prefers the full spilled text over the bounded preview (#2726), so this
    // audit row must go through the same bounded-preview+spill helper as the
    // primary node_completed/node_skipped_prior_success writers, not the raw text.
    const alwaysRunPriorOutput = formatThisNodesPriorOutput();
    await recordNodeState(
      { store: ctx.deps.store, logDir: ctx.logDir },
      {
        runId: ctx.workflowRun.id,
        path: alwaysRunStepName,
        node: describeExecutionNode(node),
        cache: {
          action: 'reset',
          prior: persistedExecutionOutput(alwaysRunPriorOutput),
        },
      }
    );
    // falls through to re-execute the node
  } else if (
    composedBoundaryDecision.decision === 'run' &&
    // A join cached before failure-cascade skips blocked this rule must
    // satisfy its current eligibility before that success can be reused.
    (node.trigger_rule !== 'none_failed_min_one_success' ||
      checkTriggerRule(node, ctx.nodeOutputs).decision === 'run')
  ) {
    // #2402 — a cached prior-success skip is only safe when every
    // dependency's current value still matches the prior snapshot.
    // If any dep re-ran during this resume (e.g. an `always_run: true`
    // upstream forced a re-execution, or any dep produced fresh
    // output), the cached value reflects the OLD dep output and would
    // otherwise report success over stale synthesis. Invalidate and
    // fall through to a fresh execution instead.
    const staleDeps = getStaleCachedDependencies(
      node,
      ctx.nodeOutputs,
      priorCompletedNodes,
      ctx.replayedFailures
    );
    if (staleDeps.length > 0) {
      const invalidatedStepName = ctx.stepNamePrefix + node.id;
      // Same rationale as the always_run reset above: prior.output can now be
      // the full spilled text, so this audit row needs the same bounding (#2726).
      const invalidatedPriorOutput = formatThisNodesPriorOutput();
      getLog().info(
        { nodeId: node.id, invalidatingDeps: staleDeps },
        'dag.node_prior_cache_invalidated'
      );
      await recordNodeState(
        { store: ctx.deps.store, logDir: ctx.logDir },
        {
          runId: ctx.workflowRun.id,
          path: invalidatedStepName,
          node: describeExecutionNode(node),
          cache: {
            action: 'invalidated',
            invalidatingDeps: staleDeps,
            prior: {
              ...persistedExecutionOutput(invalidatedPriorOutput),
              structured: priorCompletedNodes.get(node.id)?.structuredOutput,
            },
          },
        }
      );
      // falls through to re-execute the node with fresh dep output
    } else {
      getLog().info({ nodeId: node.id }, 'dag.node_skipped_prior_success');
      const skipStepName = ctx.stepNamePrefix + node.id;
      // Preserve incomplete recovery as a preview with its original provenance.
      // Re-spilling that preview would falsely certify it as the full result.
      const prior = priorCompletedNodes.get(node.id);
      const truncation = prior?.outputTruncation;
      const priorSkipOutput = truncation
        ? {
            nodeOutput: prior?.output ?? '',
            truncated: true,
            ...(truncation.originalBytes !== null
              ? { originalBytes: truncation.originalBytes }
              : {}),
            ...(truncation.spillPath !== null ? { spillPath: truncation.spillPath } : {}),
          }
        : formatThisNodesPriorOutput();
      // Return the pre-populated output (already in nodeOutputs)
      const cachedOutput = ctx.nodeOutputs.get(node.id);
      if (cachedOutput === undefined) {
        throw new Error(`Cached output for node '${node.id}' was not pre-populated`);
      }
      if (node.kind === 'workflow' && node.fan_out !== undefined) {
        const aggregate: unknown =
          'structuredOutput' in cachedOutput && cachedOutput.structuredOutput !== undefined
            ? cachedOutput.structuredOutput
            : JSON.parse(cachedOutput.output);
        if (!Array.isArray(aggregate)) {
          throw new Error(`Cached fan_out node '${node.id}' aggregate is not a JSON array`);
        }
        const children = await findFanOutChildRuns(
          ctx.deps.store,
          ctx.workflowRun.id,
          skipStepName
        );
        const started = new Set(
          children
            .map(child => readSubrunMetadata(child.metadata).childIndex)
            .filter(
              (index): index is number =>
                index !== undefined && index >= 0 && index < aggregate.length
            )
        );
        const refused = aggregate.length - started.size;
        if (refused > 0) {
          await safeSendMessage(
            ctx.platform,
            ctx.conversationId,
            `Skipping fan_out node '${node.id}': fan-out previously refused ${String(refused)} of ${String(aggregate.length)} children.`,
            { workflowId: ctx.workflowRun.id, nodeName: node.id }
          );
        }
      }
      await recordNodeState(
        { store: ctx.deps.store, logDir: ctx.logDir },
        {
          runId: ctx.workflowRun.id,
          path: skipStepName,
          node: describeExecutionNode(node),
          cache: {
            action: 'replayed',
            output: {
              ...persistedExecutionOutput(priorSkipOutput, prior?.output ?? ''),
              structured:
                'structuredOutput' in cachedOutput ? cachedOutput.structuredOutput : undefined,
              declaredOutputPaths:
                'declaredOutputPaths' in cachedOutput
                  ? cachedOutput.declaredOutputPaths
                  : undefined,
            },
          },
        }
      );
      return {
        nodeId: node.id,
        output: cachedOutput,
      };
    }
  }
  return undefined;
}

/**
 * Settle a node whose dispatch threw. This dispatch boundary also owns provider/binding
 * preparation failures.
 */
async function recordPreExecutionFailure(
  ctx: RunLayersContext,
  node: DagNode,
  error: unknown
): Promise<LayerNodeResult> {
  // This dispatch boundary also owns provider/binding preparation failures.
  // Durable-write rejection and a budget refusal must reach run recovery
  // without becoming a node outcome: a refused node never started.
  if (
    error instanceof TerminalStatusWriteError ||
    error instanceof NodeEventWriteError ||
    error instanceof RunBudgetRefusedError
  )
    throw error;

  const err = error as Error;
  getLog().error({ err, nodeId: node.id }, 'dag_node_pre_execution_failed');
  // Before the node's execution began, this is a preparation fault (provider,
  // binding, session source). After it, the executor itself threw something
  // it did not classify, such as a store read failing between iterations.
  const failureKind = ctx.currentExecution === undefined ? 'config' : 'unknown';
  const failed = await recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(
      ctx.currentExecution ?? beginExecution(ctx, node),
      { status: 'failed', error: err.message, failureKind },
      {
        output: { text: '' },
        diagnostics: isNodeContextResume(node.context)
          ? { sessionSourceNodeId: node.context.resume }
          : undefined,
      }
    )
  );
  // The attempt is recorded so it does not read as running; the run itself is
  // released once the layer settles.
  if (error instanceof RunSourceUnreadableError) throw error;
  await safeSendMessage(
    ctx.platform,
    ctx.conversationId,
    `Node '${node.id}' failed before execution: ${err.message}`,
    { workflowId: ctx.workflowRun.id, nodeName: node.id }
  );
  return {
    nodeId: node.id,
    output: failed,
  };
}

/**
 * Fold one layer's settled results into the run context: outputs, usage, session
 * cursors, and typed artifacts. Returns whether any node in the layer failed.
 */
async function aggregateLayerResults(
  ctx: RunLayersContext,
  layer: readonly DagNode[],
  layerResults: readonly PromiseSettledResult<LayerNodeResult>[],
  isParallelLayer: boolean
): Promise<boolean> {
  const nodeById = new Map(layer.map(n => [n.id, n]));
  const bodyNodeIds = new Set(ctx.layers.flat().map(n => n.id));
  let layerHadFailure = false;
  for (const result of layerResults) {
    if (result.status === 'fulfilled') {
      const { nodeId, output, sessionProvider } = result.value;
      // SINGLE aggregation point for this segment's run-level usage: the run
      // row's persisted totals and the transcript. Per-node cost/tokens must be
      // summed here and ONLY here. Terminal telemetry does not read this: it
      // folds the persisted node events (getDagResumeSnapshot) across segments.
      if (output.costUsd !== undefined) {
        // Same guard as tokens below, and for the same reason: cost comes from
        // providers (incl. community ones), and one NaN poisons the run total for
        // every other node — NaN > 0 is false, so the cost is dropped from the run
        // row with no trace. Exactly the silent loss #2469 exists to
        // remove. Guarded here, at the single aggregation point, so one bad node
        // costs only its own contribution.
        if (Number.isFinite(output.costUsd)) {
          ctx.totalCostUsd = (ctx.totalCostUsd ?? 0) + output.costUsd;
        } else {
          getLog().warn({ nodeId, costUsd: output.costUsd }, 'dag.usage_cost_non_finite_ignored');
        }
      }
      ctx.totalTokensUnknown ||= output.tokensUnknown === true;
      if (ctx.totalTokensUnknown) {
        ctx.totalTokens = undefined;
      } else if (output.tokens !== undefined) {
        ctx.totalTokens = sumTokenUsage(
          [...(ctx.totalTokens !== undefined ? [ctx.totalTokens] : []), output.tokens],
          { nodeId }
        );
      }
      ctx.nodeOutputs.set(nodeId, output);
      if (
        ctx.nodeSessionHandles !== undefined &&
        ctx.namedResumeSourceIds?.has(nodeId) === true &&
        output.state === 'completed' &&
        output.sessionId !== undefined &&
        sessionProvider !== undefined
      ) {
        ctx.nodeSessionHandles.set(nodeId, {
          sessionId: output.sessionId,
          provider: sessionProvider,
        });
      }
      const ownerNode = nodeById.get(nodeId);
      if (
        ownerNode &&
        ownsBodySessionCursor(ownerNode, bodyNodeIds) &&
        output.state === 'completed' &&
        output.sessionId !== undefined &&
        sessionProvider !== undefined
      ) {
        ctx.bodySessionCursors?.set(nodeId, {
          sessionId: output.sessionId,
          provider: sessionProvider,
        });
      }
      // Typed artifact: when a node declares `output_type`, persist its output
      // as a typed sidecar so other nodes and later runs can locate it by type.
      // The writer keeps top-level node paths stable and qualifies loop body
      // paths with ctx.loopGroupPath. Best-effort — a metadata write must never
      // fail an otherwise-successful node.
      const completedNode = nodeById.get(nodeId);
      if (output.state === 'completed' && completedNode?.output_type) {
        const meta = {
          nodeId,
          outputType: completedNode.output_type,
          runId: ctx.workflowRun.id,
          producedAt: new Date().toISOString(),
          ...(ctx.loopGroupPath.length > 0 ? { loopGroupPath: ctx.loopGroupPath } : {}),
        };
        try {
          await writeNodeArtifact(ctx.artifactsDir, meta, output.output);
        } catch (err) {
          getLog().warn(
            { err: err as Error, nodeId, workflowRunId: ctx.workflowRun.id },
            'artifacts.write_failed'
          );
        }
        // Scope mirror (#1846): persistence-participating nodes also write their
        // typed sidecar into the stable `scopes/<workflow>/<scope>/` dir, so the
        // NEXT invocation can recover this output by reference if its persisted
        // session comes back cold. Per-node files; concurrent same-scope runs are
        // last-writer-wins for a given node. Best-effort, like the run-dir write.
        if (
          ctx.scopeArtifactsDir &&
          nodeUsesPersistedScope(completedNode, ctx.workflowPersistSessions)
        ) {
          try {
            await writeNodeArtifact(ctx.scopeArtifactsDir, meta, output.output);
          } catch (err) {
            getLog().warn(
              {
                err: err as Error,
                nodeId,
                workflowRunId: ctx.workflowRun.id,
                scopeArtifactsDir: ctx.scopeArtifactsDir,
              },
              'artifacts.scope_write_failed'
            );
          }
        }
      }
      if (output.state === 'completed' && !isParallelLayer && output.sessionId !== undefined) {
        // Tag the cursor with the provider that created the session (#1992). A session
        // id from a path that can't attest its provider is never threaded — fail-safe:
        // a fresh downstream session beats a guaranteed-broken cross-provider resume.
        ctx.lastSequentialSession =
          sessionProvider !== undefined
            ? { sessionId: output.sessionId, provider: sessionProvider }
            : undefined;
      }
      if (output.state === 'failed') layerHadFailure = true;
    }
  }
  return layerHadFailure;
}

async function stopsBetweenLayers(
  ctx: RunLayersContext,
  layerIdx: number
): Promise<'paused' | 'stopped' | undefined> {
  // Check for non-running status between DAG layers (cancellation, deletion, pause)
  try {
    const dagStatus = await ctx.deps.store.getWorkflowRunStatus(ctx.workflowRun.id);
    if (dagStatus === null || dagStatus !== 'running') {
      const effectiveStatus = dagStatus ?? 'deleted';
      if (
        effectiveStatus === 'paused' &&
        ctx.claimedWorkPausePolicy === 'finish_through_parent_pause'
      ) {
        getLog().debug(
          { workflowRunId: ctx.workflowRun.id, layerIdx, totalLayers: ctx.layers.length },
          'dag.claimed_work_continues_through_parent_pause'
        );
        return undefined;
      }
      getLog().info(
        {
          workflowRunId: ctx.workflowRun.id,
          layerIdx,
          totalLayers: ctx.layers.length,
          status: effectiveStatus,
        },
        'dag.stop_detected_between_layers'
      );
      // Paused is intentional (approval gate) — the approval message was already sent
      if (effectiveStatus !== 'paused') {
        await safeSendMessage(
          ctx.platform,
          ctx.conversationId,
          `⚠️ **Workflow stopped** (${effectiveStatus}): DAG execution stopped after layer ${String(layerIdx + 1)}/${String(ctx.layers.length)}`,
          { workflowId: ctx.workflowRun.id }
        );
      }
      return effectiveStatus === 'paused' ? 'paused' : 'stopped';
    }
  } catch (statusErr) {
    // Non-fatal — status check failure should not crash the workflow
    getLog().warn(
      { err: statusErr as Error, workflowRunId: ctx.workflowRun.id },
      'dag.status_check_failed'
    );
  }
  return undefined;
}
