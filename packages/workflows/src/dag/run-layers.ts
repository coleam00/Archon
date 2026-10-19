/**
 * The layer walker: runs a DAG's (or subgraph's) topological layers, deciding per node
 * whether it is replayed from a prior pass, skipped, or dispatched, and folding each
 * layer's results into the shared run context.
 */
import { findFanOutChildRuns } from './nodes/workflow/fan-out-children';
import { nodeInvocationKey } from '../node-record-reader';
import { finishNodeExecution, newNodeInvocation, describeExecutionNode } from '../node-execution';
import { NodeEventWriteError, recordNodeState } from '../node-event-write';
import type { DagNode, NodeOutput, SkipCause } from '../schemas';
import { nodeUsesPersistedScope, readSubrunMetadata, isNodeContextResume } from '../schemas';
import type { PersistedNodeOutput } from '../store';
import { RunBudgetRefusedError } from '../run-budget';
import { TerminalStatusWriteError } from '../terminal-status-write';
import { evaluateCondition } from '../condition-evaluator';
import { writeNodeArtifact } from '../artifacts-index';
import { safeSendMessage } from '../platform-messages';
import { getLog } from './log';
import { sumTokenUsage } from './usage';
import { RunSourceUnreadableError, settledValuesOrThrow } from './node-source';
import { beginExecution, type LayerNodeResult, type RunLayersContext } from './run-context';
import { resolveRunInputs } from './references';
import { formatPersistedNodeOutput, persistedExecutionOutput } from './node-output';
import { isCheckoutGuarded } from './checkout-guard';
import { checkComposedBlockBoundaries, checkTriggerRule } from './trigger-rule';
import { dispatchNode } from './dispatch';

/**
 * Return the IDs of `node`'s dependencies whose current `nodeOutputs` value no
 * longer matches their cached `priorCompletedNodes` snapshot (#2402). A
 * downstream consumer that is being considered for a prior-success skip is
 * stale — it was last computed against the prior snapshot, not against the
 * current `nodeOutputs` — when any of its deps is in this set. The set is
 * built by comparing text output AND structured output so consumers using
 * `$node.output.field` (the #2637 logical-value surface) are also invalidated
 * when only the structured form changed.
 *
 * A dep currently in `state: 'failed'` is always stale, checked first and
 * unconditionally — regardless of whether it had a prior cached success. Every
 * failure arm in the executor returns `output: ''`, so comparing a fresh
 * failure's value against a prior success's value (cases 2/3 below) can find
 * them equal and silently miss the failure; a dependency that failed on THIS
 * resume must never be judged by value equality.
 *
 * Past that, three cases surface a dep as "ran fresh this resume":
 *
 * 1. The dep was never in `priorCompletedNodes` at all (never completed in the
 *    prior run, or never reached) and is now `completed` in `nodeOutputs` — it
 *    re-ran this resume with no prior cache to honour. `'skipped'` is
 *    intentionally left out: its `output: ''` is semantically equivalent to
 *    the absent prior, so honouring the cache is safe.
 * 2. The dep's `prior.output` differs from `nodeOutputs.get(dep).output` —
 *    either an `always_run` upstream that re-executed, or any dep the engine
 *    re-ran with new content. The per-layer aggregation is the only writer of
 *    `nodeOutputs[dep].output` other than the pre-population loop, so a diff is
 *    proof of fresh execution.
 * 3. The dep's `prior.structuredOutput` differs from the current one — a
 *    subtler staleness that only matters for `$dep.output.field` consumers,
 *    covered here so a fresh structured value can't slip past a text-stable
 *    cache. JSON.stringify is sufficient: structured outputs are persisted to
 *    JSONB and therefore JSON-serializable; for `undefined` vs absent values,
 *    `JSON.stringify` normalises both to a missing key.
 *
 * Note: the value-equality comparison (cases 2/3) is conservative in one
 * direction — a dep that re-ran with text- and structured-identical output
 * will NOT be flagged. The cached downstream is therefore semantically
 * equivalent to a fresh execution in that case, which is the safe direction
 * to err in (over-run vs. stale success is the bug we're closing). The
 * failed-state check above is not subject to this leniency: a failure is
 * never treated as equivalent to the prior success it's compared against.
 */
function getStaleCachedDependencies(
  node: DagNode,
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
  priorCompletedNodes: ReadonlyMap<string, PersistedNodeOutput>
): string[] {
  const deps = node.depends_on ?? [];
  if (deps.length === 0) return [];
  const stale: string[] = [];
  for (const depId of deps) {
    const prior = priorCompletedNodes.get(depId);
    const current = nodeOutputs.get(depId);
    // A dep that failed fresh this resume is always stale, checked before — and
    // independently of — the prior-cache lookup below. See the docstring above.
    if (current?.state === 'failed') {
      stale.push(depId);
      continue;
    }
    // Case 1: dep was never cached; if it is now complete it ran fresh this resume.
    // Missing-current (the dep is still pending or running) is intentionally left out:
    // pending/running cannot reach this helper via the resume-skip arm in
    // runLayers (`priorCompletedNodes?.has(node.id)` only fires when the
    // CONSUMER itself was cached, but its dep would be addressed by case 2/3 once it
    // finishes).
    if (prior === undefined) {
      if (current?.state === 'completed') {
        stale.push(depId);
      }
      continue;
    }
    // Case 2: dep's text output differs from the prior snapshot.
    if (current?.output !== prior.output) {
      stale.push(depId);
      continue;
    }
    // Case 3: dep's structured value differs even though text did not — only matters
    // for `$dep.output.field` consumers, but those are exactly the surfaces that would
    // silently read stale structured data through the cached downstream.
    const priorStructured = prior.structuredOutput;
    const currentStructured =
      current !== undefined && 'structuredOutput' in current ? current.structuredOutput : undefined;
    if (!structuredOutputsEqual(priorStructured, currentStructured)) {
      stale.push(depId);
    }
  }
  return stale;
}

/**
 * `true` when two structured-output payloads are semantically equal for the
 * purposes of cache invalidation. JSON.stringify is the comparison because
 * structured outputs are persisted as JSONB — they are guaranteed JSON-shaped
 * (objects/arrays/primitives, no cycles, no functions). `undefined` is treated
 * as the absent payload; an explicit `null` is a real value and is distinct
 * from absent.
 */
function structuredOutputsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

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
 * concurrently, aggregating results into `ctx.nodeOutputs`, and accumulating usage into
 * `ctx`. Stops early (returns) when a between-layer status check sees a non-running run
 * state (paused/cancelled/deleted) — the caller always proceeds to its own terminal tally.
 *
 * Shared by the top-level DAG, `executeLoopGroupNode`'s per-iteration body and each
 * composed fan-out instance; `ctx.stepNamePrefix` is empty for the top-level DAG.
 */
export async function runLayers(ctx: RunLayersContext): Promise<void> {
  // nodeOutputs + accumulators + lastSequentialSession are mutated in place on `ctx`.

  for (let layerIdx = 0; layerIdx < ctx.layers.length; layerIdx++) {
    await ctx.toolAttention.refresh();
    const layer = ctx.layers[layerIdx];
    const isParallelLayer = layer.length > 1;

    if (isParallelLayer) {
      ctx.lastSequentialSession = undefined; // reset — parallel nodes can't share sessions
    }

    // Build a thunk per node so the layer can run either concurrently or strictly
    // sequentially. The `mutates_checkout: false` assertion snapshots before and
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
    const nodeThunks = layer.map(
      (node): (() => Promise<LayerNodeResult>) =>
        async (): Promise<LayerNodeResult> => {
          const nodeCtx: RunLayersContext = {
            ...ctx,
            currentExecution: undefined,
            guardedLayerSnapshots,
            nodeInvocation:
              ctx.unfinishedInvocations?.get(
                nodeInvocationKey(ctx.stepNamePrefix + node.id, ctx.loopGroupPath)
              )?.invocation ?? newNodeInvocation(ctx.loopGroupPath),
          };
          try {
            return (
              (await admitNode(nodeCtx, node)) ??
              (await dispatchNode(nodeCtx, node, isParallelLayer))
            );
          } catch (error) {
            return recordPreExecutionFailure(nodeCtx, node, error);
          }
        }
    );
    // A layer mixing guarded and unguarded nodes runs sequentially (see the thunk
    // comment above); every other layer keeps the concurrent `allSettled` path.
    const layerResults = serializeLayer
      ? await settleSequentially(nodeThunks)
      : await Promise.allSettled(nodeThunks.map(thunk => thunk()));

    const layerHadFailure = await aggregateLayerResults(ctx, layer, layerResults, isParallelLayer);
    settledValuesOrThrow(layerResults, ctx.workflowRun.id);

    if (layerHadFailure) {
      getLog().warn({ layerIdx, nodeCount: layer.length }, 'dag_layer_had_failures');
    }

    await ctx.afterLayer?.();

    if (await stopsBetweenLayers(ctx, layerIdx)) break;
  }
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
  const priorCompletedNodes = ctx.priorCompletedNodes;
  const isCachedPriorSuccess = priorCompletedNodes?.has(node.id) === true && !node.always_run;
  const composedBoundaryDecision = checkComposedBlockBoundaries(
    node,
    ctx.nodeOutputs,
    resolveRunInputs(ctx.workflowRun),
    isCachedPriorSuccess
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
  // Three sites below (always_run reset, cache invalidation, and the
  // prior-success skip re-emit) all persist THIS node's prior output through
  // the same bounded-preview+spill helper, keyed by its own step_name (#2726)
  // — captured once here rather than repeating the lookup at each call site.
  const formatThisNodesPriorOutput = (
    stepName: string
  ): ReturnType<typeof formatPersistedNodeOutput> =>
    formatPersistedNodeOutput(
      priorCompletedNodes.get(node.id)?.output ?? '',
      ctx.artifactsDir,
      stepName
    );
  if (node.always_run) {
    getLog().info({ nodeId: node.id }, 'dag.node_always_run_resume_forced');
    const alwaysRunStepName = ctx.stepNamePrefix + node.id;
    // The prior value being reset can be arbitrarily large — getDagResumeSnapshot
    // prefers the full spilled text over the bounded preview (#2726), so this
    // audit row must go through the same bounded-preview+spill helper as the
    // primary node_completed/node_skipped_prior_success writers, not the raw text.
    const alwaysRunPriorOutput = formatThisNodesPriorOutput(alwaysRunStepName);
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
    const staleDeps = getStaleCachedDependencies(node, ctx.nodeOutputs, priorCompletedNodes);
    if (staleDeps.length > 0) {
      const invalidatedStepName = ctx.stepNamePrefix + node.id;
      // Same rationale as the always_run reset above: prior.output can now be
      // the full spilled text, so this audit row needs the same bounding (#2726).
      const invalidatedPriorOutput = formatThisNodesPriorOutput(invalidatedStepName);
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
        : formatThisNodesPriorOutput(skipStepName);
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
        isNodeContextResume(ownerNode.context) &&
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

/**
 * Check for non-running status between DAG layers (cancellation, deletion, pause).
 * True when the walk stops here.
 */
async function stopsBetweenLayers(ctx: RunLayersContext, layerIdx: number): Promise<boolean> {
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
        return false;
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
      return true;
    }
  } catch (statusErr) {
    // Non-fatal — status check failure should not crash the workflow
    getLog().warn(
      { err: statusErr as Error, workflowRunId: ctx.workflowRun.id },
      'dag.status_check_failed'
    );
  }
  return false;
}
