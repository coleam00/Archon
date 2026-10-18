import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { nodeInvocationKey } from '../../../node-record-reader';
import {
  startNodeExecution,
  finishNodeExecution,
  newNodeInvocation,
} from '../../../node-execution';
import {
  serializeNodeEmitter,
  serializeNodeStateRecord,
  serializeNodeTranscript,
  serializeNodeOutput,
  type NodeExecutionResult,
} from '../../../node-record-serialization';
import { type NodeExecutionRecord, type NodeFailureKind } from '../../../schemas/node-execution';
import { NodeEventWriteError, recordNodeState } from '../../../node-event-write';
import {
  discoverWorkflowsWithConfig,
  resolveWorkflowCommandContents,
} from '../../../workflow-discovery';
import { findWorkflowLoadError } from '../../../schemas/workflow';
import {
  assertWorkflowSourceIntegrity,
  isSourceReadFailure,
  liveSourceRoots,
  WorkflowSourceIntegrityError,
  WorkflowSourceUnavailableError,
  type WorkflowSourceRoots,
} from '../../../workflow-source';
import { resolveWorkflowName } from '../../../router';
import type { WorkflowDeps } from '../../../deps';
import type { TokenUsage } from '@archon/provider-contract';
import { type ProviderFailure } from '@archon/provider-contract';
import type {
  DagNode,
  IncludeDirective,
  ComposeFanOutNode,
  NodeOutput,
  ResolvedWorkflow,
  WorkflowRunStatus,
} from '../../../schemas';
import { planGraph } from '../../../graph-plan';
import type { DagResumeSnapshot, PersistedNodeOutput } from '../../../store';
import { getWorkflowEventEmitter } from '../../../event-emitter';
import { TerminalStatusWriteError } from '../../../terminal-status-write';
import { type JsonValue } from '../../../output-ref';
import { type IncludeCommandContent, isIncludeCommandReadError } from '../../../compiled-command';
import { logWorkflowEvent } from '../../../logger';
import { mapWithLimit } from '../../../utils/map-with-limit';
import {
  collectComposedSuspensionPaths,
  instantiateResolvedInclude,
} from '../../../include-expander';
import { buildInstanceSnapshots, composeFanOutScopeSegment } from '../../../fan-out-identity';
import {
  aggregateProviderFailure,
  substituteWorkflowVariables,
  safeSendMessage,
} from '../../../executor-shared';
import { getLog } from '../../log';
import { runLayers } from '../../../dag-executor';
import { sumFanOutCost, sumFanOutTokens } from '../../usage';
import { RunSourceUnreadableError, settledValuesOrThrow } from '../../node-source';
import { beginExecution, type RunLayersContext } from '../../run-context';
import {
  resolveRunInputs,
  nodeTemplateReferences,
  type ShellInputContext,
  resolveWorkflowValue,
} from '../../references';

/**
 * Resolve a composed fan-out's `include:` target at run time. The body may be a support
 * workflow of its own installed pack.
 */
export async function resolveFanOutChildDefinition(
  deps: WorkflowDeps,
  cwd: string,
  targetName: string,
  /** Frozen source roots owned by composed execution. */
  source?: WorkflowSourceRoots
): Promise<
  | {
      definition: ResolvedWorkflow;
      definitions: ResolvedWorkflow[];
      commandContents: ReadonlyMap<string, IncludeCommandContent>;
    }
  | { unresolved: string }
> {
  const sourceRoots = source ?? liveSourceRoots(cwd);
  let verifiedFiles: ReadonlySet<string> | undefined;
  try {
    // Verified first, so a capture this host cannot read throws a typed error rather
    // than surfacing as a discovery error string.
    verifiedFiles = await assertWorkflowSourceIntegrity(sourceRoots);
    const { workflows, support, errors } = await discoverWorkflowsWithConfig(
      cwd,
      deps.loadConfig,
      deps.providers,
      sourceRoots
    );
    // Discovery qualified a pack's composed targets to that pack, so a support workflow
    // is reachable here only by the composition that names it.
    const definitions = [...workflows, ...(support ?? [])].map(w => w.workflow);
    const definition = resolveWorkflowName(targetName, definitions);
    // resolveWorkflowName returns undefined for an unknown name and THROWS only on
    // ambiguity, so the undefined branch is ordinary rather than exceptional.
    if (!definition) {
      const relevantError =
        findWorkflowLoadError(errors, targetName) ??
        errors.find(
          error =>
            error.workflowName === undefined && isSourceReadFailure(error.cause, verifiedFiles)
        );
      if (relevantError !== undefined && isSourceReadFailure(relevantError.cause, verifiedFiles)) {
        throw relevantError.cause;
      }
      return {
        unresolved: relevantError?.error ?? `no workflow named '${targetName}' was found`,
      };
    }
    const commandContents = await resolveWorkflowCommandContents(
      sourceRoots,
      [definition],
      verifiedFiles
    );
    for (const content of commandContents.values()) {
      if (isIncludeCommandReadError(content) && isSourceReadFailure(content.cause, verifiedFiles)) {
        throw content.cause;
      }
    }
    return { definition, definitions, commandContents };
  } catch (err) {
    if (err instanceof WorkflowSourceIntegrityError || isSourceReadFailure(err)) throw err;
    if (isSourceReadFailure(err, verifiedFiles)) {
      throw new WorkflowSourceUnavailableError(
        sourceRoots.kind === 'captured' ? sourceRoots.anchor.root : cwd,
        err
      );
    }
    return { unresolved: (err as Error).message };
  }
}

/**
 * Instantiate ONE composed fan-out item through the same narrow primitive used by a
 * static include. The target closure was already resolved and validated at load time;
 * only input materialization and instance namespacing vary per item.
 */
function expandComposeInstance(
  node: ComposeFanOutNode,
  identity: string,
  inputs: Record<string, JsonValue>,
  definition: ResolvedWorkflow,
  commandContents: ReadonlyMap<string, IncludeCommandContent>
): { nodes: DagNode[]; primarySink: string } | { error: string } {
  const directiveId = `${node.id}__${identity}`;
  const directive: IncludeDirective = {
    id: directiveId,
    kind: 'include',
    include: node.include,
    ...(Object.keys(inputs).length > 0 ? { with: inputs } : {}),
  };
  const expanded = instantiateResolvedInclude(directive, definition, commandContents);
  const primarySink = expanded.primarySink;
  if (primarySink === '') {
    return { error: `composed block '${definition.name}' has no sink node` };
  }
  return { nodes: expanded.namespaced, primarySink };
}

/** One settled composed fan-out instance, reduced into the aggregate (#2512). */
interface ComposeInstanceOutcome {
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
  output: string;
  structuredOutput?: unknown;
  error?: string;
  /** The failed instance's typed provider failure, from {@link aggregateProviderFailure}. */
  providerFailure?: ProviderFailure;
  costUsd?: number;
  tokens?: TokenUsage;
  tokensUnknown?: boolean;
}

/**
 * Execute a composed fan-out (`include:` + `fan_out:`) node (#2512): resolve the item
 * list at run time, then execute the statically named composed body ONCE PER ITEM inside
 * THIS run — one workflow_runs row, events under the parent's run id under instance-
 * qualified step names, bounded by `max_parallel`, aggregated in input order. No child
 * run rows are created; cancellation propagates through the parent's own lifecycle.
 *
 * Resume keys on CONTENT-hash identity (`fan-out-identity.ts`) from the first durable
 * ordered snapshot. Completed instance outcomes and completed inner nodes are threaded;
 * a started instance with no terminal row is ambiguous and never replayed automatically.
 */
export async function executeComposeFanOutNode(
  node: ComposeFanOutNode,
  ctx: RunLayersContext,
  fanOut: ComposeFanOutNode['fan_out']
): Promise<NodeExecutionResult> {
  const { deps, platform, conversationId, cwd, workflowRun: parentRun } = ctx;
  const msgContext = { workflowId: parentRun.id, nodeName: node.id };
  const execution = beginExecution(ctx, node);
  let tokensUnknown = false;
  await recordNodeState({ store: deps.store, logDir: ctx.logDir }, execution);

  const failResult = async (
    error: string,
    failureKind: NodeFailureKind,
    costUsd?: number,
    tokens?: TokenUsage,
    providerFailure?: ProviderFailure
  ): Promise<NodeExecutionResult> => {
    return recordNodeState(
      { store: deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        execution,
        {
          status: 'failed',
          error,
          failureKind,
          ...(providerFailure !== undefined ? { providerFailure } : {}),
        },
        {
          output: { text: '' },
          costUsd,
          tokens,
          tokensUnknown,
          diagnostics: { fanOut: true },
        }
      )
    );
  };

  // Written ONLY when the join is satisfied, mirroring executeFanOutWorkflowNode — so
  // cold resume skips a finished fan-out but re-runs an unfinished one.
  const writeCompleted = async (
    output: string,
    costUsd?: number,
    tokens?: TokenUsage,
    structured?: unknown
  ): Promise<NodeExecutionResult> => {
    return recordNodeState(
      { store: deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        execution,
        { status: 'completed' },
        {
          output: { text: output, ...(structured !== undefined ? { structured } : {}) },
          costUsd,
          tokens,
          tokensUnknown,
          diagnostics: { fanOut: true },
        }
      )
    );
  };

  const notify = async (text: string): Promise<void> => {
    await safeSendMessage(platform, conversationId, text, msgContext);
  };

  // Load the durable plan before touching the live item producer. Once a plan exists,
  // it owns the instance set; current output is only a best-effort drift diagnostic.
  const fanOutScopeName =
    ctx.stepNamePrefix + composeFanOutScopeSegment(node.id, ctx.loopGroupPath);
  let resumeSnapshot: DagResumeSnapshot;
  try {
    resumeSnapshot = await deps.store.getDagResumeSnapshot(parentRun.id);
  } catch (err) {
    const msg =
      `composed fan-out node '${node.id}' could not load durable resume state: ` +
      (err as Error).message;
    getLog().error(
      { err: err as Error, parentRunId: parentRun.id, nodeId: node.id },
      'workflow.compose_fan_out_resume_snapshot_failed'
    );
    await notify(`❌ **Composed fan-out blocked** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'unknown');
  }
  const priorOutputs = resumeSnapshot.completedNodeOutputs;
  const persistedSnapshots = resumeSnapshot.fanOutSnapshots.get(fanOutScopeName);

  const resolveCurrentItems = (): { items: JsonValue[] } | { error: string } => {
    try {
      const { prompt: itemsResolved } = substituteWorkflowVariables(
        fanOut.items,
        parentRun.id,
        parentRun.user_message ?? '',
        ctx.artifactsDir,
        ctx.baseBranch,
        ctx.docsDir,
        ctx.issueContext,
        undefined,
        undefined,
        undefined,
        { references: nodeTemplateReferences(fanOut.items, ctx) }
      );
      const parsed: unknown = JSON.parse(itemsResolved);
      if (!Array.isArray(parsed)) {
        return {
          error:
            `fan_out.items on '${node.id}' resolved to ${typeof parsed}, not a JSON array. ` +
            `'${fanOut.items}' must reference a node output that produces a JSON array.`,
        };
      }
      return { items: parsed };
    } catch (err) {
      return {
        error: `fan_out.items on '${node.id}' could not be resolved to a JSON array: ${(err as Error).message}`,
      };
    }
  };

  const currentItems = resolveCurrentItems();
  if ('error' in currentItems && persistedSnapshots === undefined) {
    await notify(`❌ **Composed fan-out failed** (node \`${node.id}\`): ${currentItems.error}`);
    return failResult(currentItems.error, 'config');
  }
  if ('error' in currentItems) {
    getLog().warn(
      { parentRunId: parentRun.id, nodeId: node.id, error: currentItems.error },
      'workflow.compose_fan_out_item_drift_unreadable'
    );
  }

  // Preflight BEFORE any instance spend: the target must still resolve (it may have been
  // renamed or deleted since load), and its complete closure must remain suspension-free.
  let resolved: Awaited<ReturnType<typeof resolveFanOutChildDefinition>>;
  try {
    resolved = await resolveFanOutChildDefinition(deps, cwd, node.include, ctx.workflowSourceRoots);
  } catch (error) {
    if (isSourceReadFailure(error))
      throw new RunSourceUnreadableError(ctx.stepNamePrefix + node.id, error);
    throw error;
  }
  if ('unresolved' in resolved) {
    const msg =
      `composed fan-out node '${node.id}': cannot resolve the composed block '${node.include}' — ` +
      `${resolved.unresolved}. Fix the include target name.`;
    await notify(`❌ **Composed fan-out blocked** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'config');
  }
  const bodySuspensions = collectComposedSuspensionPaths(resolved.definition, resolved.definitions);
  if (bodySuspensions.length > 0) {
    const names = bodySuspensions.map(entry => `'${entry.id}' (${entry.reason})`).join(', ');
    const msg =
      `composed fan-out node '${node.id}': the composed block '${node.include}' contains ` +
      `suspension-capable path${bodySuspensions.length === 1 ? '' : 's'} ${names}. An in-parent ` +
      'fan-out has no per-instance pause cursor, so it cannot safely resume a partly completed ' +
      "body. Remove the suspension path, or invoke the block once through 'include:' or 'workflow:'.";
    getLog().warn(
      { parentRunId: parentRun.id, nodeId: node.id, include: node.include },
      'workflow.compose_fan_out_suspension_rejected'
    );
    await notify(`❌ **Composed fan-out blocked** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'config');
  }

  let computedSnapshots: ReturnType<typeof buildInstanceSnapshots>;
  if (persistedSnapshots === undefined) {
    // Freeze every resolved binding together with the item before any instance starts.
    // A resumed run must never combine completed work from the old bindings with a
    // retried instance resolved from changed upstream output.
    let staticInputs: Record<string, JsonValue> = {};
    const parentInputs = resolveRunInputs(parentRun);
    try {
      if (node.with !== undefined) {
        const resolutionCtx: ShellInputContext = {
          workflowRun: parentRun,
          artifactsDir: ctx.artifactsDir,
          stateDir: ctx.stateDir,
          baseBranch: ctx.baseBranch,
          docsDir: ctx.docsDir,
          issueContext: ctx.issueContext,
          nodeOutputs: ctx.nodeOutputs,
          loopBodyScopes: ctx.loopBodyScopes,
        };
        staticInputs = Object.fromEntries(
          Object.entries(node.with).map(([name, rawValue]) => [
            name,
            resolveWorkflowValue(rawValue, resolutionCtx, parentInputs, false),
          ])
        );
      }
    } catch (err) {
      const msg = `fan_out 'with:' on '${node.id}' could not be resolved: ${(err as Error).message}`;
      await notify(`❌ **Composed fan-out failed** (node \`${node.id}\`): ${msg}`);
      return failResult(msg, 'config');
    }
    if ('error' in currentItems) {
      throw new Error('unreachable: fresh composed fan-out has no resolved item list');
    }
    computedSnapshots = buildInstanceSnapshots(currentItems.items, staticInputs, fanOut.as);
  } else {
    // Only compare item identity for drift diagnostics. The persisted input map is the
    // authority on resume, so current `with:` references are intentionally not resolved.
    computedSnapshots =
      'items' in currentItems
        ? buildInstanceSnapshots(currentItems.items, {}, fanOut.as)
        : [...persistedSnapshots];
  }
  const snapshots = persistedSnapshots ?? computedSnapshots;

  if (persistedSnapshots === undefined) {
    try {
      await deps.store.persistWorkflowEvent({
        workflow_run_id: parentRun.id,
        event_type: 'fan_out_instances',
        step_name: fanOutScopeName,
        data: { instances: computedSnapshots },
      });
    } catch (err) {
      const msg =
        `composed fan-out node '${node.id}' could not persist its item snapshot before ` +
        `execution: ${(err as Error).message}`;
      await notify(`❌ **Composed fan-out blocked** (node \`${node.id}\`): ${msg}`);
      return failResult(msg, 'unknown');
    }
  } else if (
    persistedSnapshots.length !== computedSnapshots.length ||
    persistedSnapshots.some((snapshot, index) => {
      const current = computedSnapshots[index];
      return (
        snapshot.identity !== current?.identity ||
        JSON.stringify(snapshot.item) !== JSON.stringify(current?.item)
      );
    })
  ) {
    getLog().warn(
      { parentRunId: parentRun.id, nodeId: node.id },
      'workflow.compose_fan_out_using_persisted_instances'
    );
  }

  if (snapshots.length === 0) {
    getLog().info({ parentRunId: parentRun.id, nodeId: node.id }, 'workflow.compose_fan_out_empty');
    return writeCompleted('[]', undefined, undefined, []);
  }

  const ambiguousIdentity = snapshots.find(snapshot =>
    resumeSnapshot.unresolvedNodeStarts.has(`${fanOutScopeName}__${snapshot.identity}`)
  );
  if (ambiguousIdentity !== undefined) {
    const msg =
      `composed fan-out node '${node.id}' has instance '${ambiguousIdentity.identity}' with ` +
      'a durable start but no terminal event. It may still be running or may have completed ' +
      'before its result was stored. Archon will not replay it automatically; inspect the ' +
      'run and deliberately abandon it or start a new run.';
    await notify(`❌ **Composed fan-out blocked** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'unknown');
  }

  // Execute incomplete identities through a bounded sliding window. Each instance runs
  // the composed body via runLayers in its own context: fresh output map, events under
  // the parent run id with engine-owned, instance-qualified step names. The authored
  // node ids remain ordinary DAG ids inside that isolated execution context.
  const settled = await mapWithLimit(
    snapshots,
    fanOut.max_parallel,
    async (snapshot): Promise<ComposeInstanceOutcome> => {
      let expanded: { nodes: DagNode[]; primarySink: string } | { error: string };
      try {
        expanded = expandComposeInstance(
          node,
          snapshot.identity,
          snapshot.inputs,
          resolved.definition,
          resolved.commandContents
        );
      } catch (err) {
        expanded = { error: (err as Error).message };
      }
      if ('error' in expanded) {
        return {
          status: 'failed',
          output: '',
          error: `instance ${snapshot.identity} failed to compose: ${expanded.error}`,
        };
      }
      const instanceScopeName = `${fanOutScopeName}__${snapshot.identity}`;
      const instanceStepNamePrefix = `${instanceScopeName}__`;
      const prior = priorOutputs.get(instanceScopeName);
      if (prior !== undefined) {
        const spend = prior.execution?.spend;
        return {
          ...(spend?.tokens.source === 'unavailable' && spend.tokens.reason === 'incomplete'
            ? { tokensUnknown: true }
            : {}),
          status: 'completed',
          output: prior.output,
          ...(prior.structuredOutput !== undefined
            ? { structuredOutput: prior.structuredOutput }
            : {}),
        };
      }
      const instancePriorNodes = new Map<string, PersistedNodeOutput>();
      const instanceNodeOutputs = new Map<string, NodeOutput>();
      for (const innerNode of expanded.nodes) {
        const persisted = priorOutputs.get(instanceStepNamePrefix + innerNode.id);
        if (persisted === undefined) continue;
        instancePriorNodes.set(innerNode.id, persisted);
        instanceNodeOutputs.set(innerNode.id, {
          state: 'completed',
          output: persisted.output,
          ...(persisted.structuredOutput !== undefined
            ? { structuredOutput: persisted.structuredOutput }
            : {}),
          ...(persisted.execution !== undefined ? { execution: persisted.execution } : {}),
        });
      }
      const instanceExecution: NodeExecutionRecord = {
        ...startNodeExecution({
          runId: parentRun.id,
          path: instanceScopeName,
          node: { kind: 'compose_fan_out_instance', id: instanceScopeName },
          invocation:
            resumeSnapshot.unfinishedInvocations?.get(
              nodeInvocationKey(instanceScopeName, ctx.loopGroupPath)
            )?.invocation ?? newNodeInvocation(ctx.loopGroupPath),
        }),
        diagnostics: { identity: snapshot.identity, ordinal: snapshot.ordinal },
      };
      const deriveInstanceSinks = async (record: NodeExecutionRecord): Promise<void> => {
        const transcript = serializeNodeTranscript(record);
        if (transcript) await logWorkflowEvent(ctx.logDir, parentRun.id, transcript);
        const emitted = serializeNodeEmitter(record);
        if (emitted) getWorkflowEventEmitter().emit(emitted);
      };
      try {
        const startEvent = serializeNodeStateRecord(instanceExecution);
        const claim = await deps.store.persistWorkflowEventIfRunning(startEvent, {
          allowPaused: ctx.claimedWorkPausePolicy === 'finish_through_parent_pause',
        });
        if (!claim.persisted) {
          return {
            status: 'cancelled',
            output: '',
            error: 'parent run is no longer running; instance was not started',
          };
        }
        await deriveInstanceSinks(instanceExecution);
      } catch (err) {
        return {
          status: 'failed',
          output: '',
          error: `instance ${snapshot.identity} could not persist its start: ${(err as Error).message}`,
        };
      }
      const instanceCtx: RunLayersContext = {
        toolAttention: ctx.toolAttention,
        unfinishedInvocations: resumeSnapshot.unfinishedInvocations,
        deps: ctx.deps,
        platform: ctx.platform,
        conversationId: ctx.conversationId,
        cwd: ctx.cwd,
        workflowSourceRoots: ctx.workflowSourceRoots,
        runChildWorkflow: ctx.runChildWorkflow,
        execContext: ctx.execContext,
        workflowRun: parentRun,
        workflowName: ctx.workflowName,
        config: ctx.config,
        workflowProvider: ctx.workflowProvider,
        workflowModel: ctx.workflowModel,
        workflowLevelOptions: ctx.workflowLevelOptions,
        aiProfile: ctx.aiProfile,
        workflowPreset: ctx.workflowPreset,
        artifactsDir: ctx.artifactsDir,
        stateDir: ctx.stateDir,
        logDir: ctx.logDir,
        baseBranch: ctx.baseBranch,
        docsDir: ctx.docsDir,
        configuredCommandFolder: ctx.configuredCommandFolder,
        issueContext: ctx.issueContext,
        persistScope: ctx.persistScope,
        workflowPersistSessions: ctx.workflowPersistSessions,
        scopeArtifactsDir: undefined,
        // Runtime cardinality changes only the deterministic instance prefix; the body
        // was fully resolved and validated before any parent node ran.
        layers: planGraph(expanded.nodes).layers,
        nodeOutputs: instanceNodeOutputs,
        priorCompletedNodes: instancePriorNodes,
        claimedWorkPausePolicy: 'finish_through_parent_pause',
        lastSequentialSession: undefined,
        warnedProviderConflicts: ctx.warnedProviderConflicts,
        totalCostUsd: undefined,
        totalTokens: undefined,
        totalTokensUnknown: false,
        stepNamePrefix: instanceStepNamePrefix,
        loopGroupPath: ctx.loopGroupPath,
        // A composed instance is its own workflow: its prompts never took the enclosing
        // loop's substitution pass, so its command bodies don't either.
        loopBodyScopes: [],
      };
      try {
        await runLayers(instanceCtx);
      } catch (error) {
        // Without a terminal record the resumed fan-out would find this instance started
        // and never finished, and refuse to replay it.
        if (error instanceof RunSourceUnreadableError) {
          let releasedRecord = finishNodeExecution(
            instanceExecution,
            { status: 'failed', error: error.message, failureKind: 'child_failed' },
            { output: { text: '' } }
          );
          try {
            const rows = await deps.store.listWorkflowEvents(parentRun.id);
            let start = rows.length - 1;
            while (
              start >= 0 &&
              !(
                rows[start].step_name === instanceScopeName &&
                rows[start].event_type === 'node_started'
              )
            ) {
              start--;
            }
            const usage = await foldDagResumeSnapshot(
              rows
                .slice(start + 1)
                .filter(row => row.step_name?.startsWith(instanceStepNamePrefix)),
              parentRun.id
            );
            releasedRecord = finishNodeExecution(
              instanceExecution,
              { status: 'failed', error: error.message, failureKind: 'child_failed' },
              {
                costUsd: usage.costUsd,
                tokens: usage.tokens,
                tokensUnknown: usage.tokensUnknown,
                output: { text: '' },
                diagnostics: { identity: snapshot.identity, ordinal: snapshot.ordinal },
              }
            );
            await deps.store.persistWorkflowEvent(serializeNodeStateRecord(releasedRecord));
          } catch (closureError) {
            if (
              closureError instanceof NodeEventWriteError ||
              closureError instanceof TerminalStatusWriteError
            )
              throw closureError;
            // The terminal owns the scope's spend. If accounting cannot be read, recovery
            // must retain the open start rather than close it with incomplete usage.
            throw new NodeEventWriteError(serializeNodeStateRecord(releasedRecord), closureError);
          }
          try {
            await deriveInstanceSinks(releasedRecord);
          } catch (cleanupError) {
            if (
              cleanupError instanceof NodeEventWriteError ||
              cleanupError instanceof TerminalStatusWriteError
            )
              throw cleanupError;
            getLog().error(
              { err: cleanupError, parentRunId: parentRun.id, instance: instanceScopeName },
              'workflow.compose_fan_out_release_sinks_failed'
            );
          }
        }
        throw error;
      }
      // Every instance exit carries the work it already paid for.
      const instanceUsage: Pick<ComposeInstanceOutcome, 'costUsd' | 'tokens' | 'tokensUnknown'> = {
        ...(instanceCtx.totalCostUsd !== undefined ? { costUsd: instanceCtx.totalCostUsd } : {}),
        ...(instanceCtx.totalTokens !== undefined ? { tokens: instanceCtx.totalTokens } : {}),
        tokensUnknown: instanceCtx.totalTokensUnknown,
      };
      const failed = [...instanceCtx.nodeOutputs.values()].filter(o => o.state === 'failed');
      if (failed.length > 0) {
        const providerFailure = aggregateProviderFailure(
          failed.map(o => o.providerFailure),
          Date.now()
        );
        const outcome: ComposeInstanceOutcome = {
          status: 'failed',
          output: '',
          error: failed[0].error ?? 'composed instance node failed',
          ...(providerFailure !== undefined ? { providerFailure } : {}),
          ...instanceUsage,
        };
        try {
          const failedRecord = finishNodeExecution(
            instanceExecution,
            {
              status: 'failed',
              error: outcome.error ?? 'composed instance node failed',
              failureKind: 'child_failed',
              ...(providerFailure !== undefined ? { providerFailure } : {}),
            },
            {
              output: { text: '' },
              costUsd: outcome.costUsd,
              tokens: outcome.tokens,
              tokensUnknown: outcome.tokensUnknown,
              diagnostics: { identity: snapshot.identity, ordinal: snapshot.ordinal },
            }
          );
          await deps.store.persistWorkflowEvent(serializeNodeStateRecord(failedRecord));
          await deriveInstanceSinks(failedRecord);
        } catch (err) {
          return {
            ...outcome,
            status: 'ambiguous',
            error: `instance ${snapshot.identity} failed and its terminal state could not be stored: ${(err as Error).message}`,
          };
        }
        return outcome;
      }
      // Cancellation or another terminal status can stop runLayers early. A claimed
      // deterministic instance finishes through a sibling's pause and reaches its sink.
      // Surface any remaining incompleteness rather than treating absent output as success.
      const terminal = instanceCtx.nodeOutputs.get(expanded.primarySink);
      if (terminal?.state !== 'completed') {
        return {
          status: 'ambiguous',
          output: '',
          ...instanceUsage,
          error:
            `composed instance ${snapshot.identity} stopped without a terminal state; ` +
            'automatic replay is unsafe',
        };
      }
      const outcome: ComposeInstanceOutcome = {
        status: 'completed',
        output: terminal.output,
        ...(terminal.structuredOutput !== undefined
          ? { structuredOutput: terminal.structuredOutput }
          : {}),
        ...instanceUsage,
      };
      try {
        const completedRecord = finishNodeExecution(
          instanceExecution,
          { status: 'completed' },
          {
            output: {
              text: outcome.output,
              ...(outcome.structuredOutput !== undefined
                ? { structured: outcome.structuredOutput }
                : {}),
            },
            costUsd: outcome.costUsd,
            tokens: outcome.tokens,
            tokensUnknown: outcome.tokensUnknown,
            diagnostics: { identity: snapshot.identity, ordinal: snapshot.ordinal },
          }
        );
        await deps.store.persistWorkflowEvent(serializeNodeStateRecord(completedRecord));
        await deriveInstanceSinks(completedRecord);
      } catch (err) {
        return {
          ...outcome,
          status: 'ambiguous',
          error: `instance ${snapshot.identity} completed but its result could not be stored: ${(err as Error).message}`,
        };
      }
      return outcome;
    }
  );

  const outcomes = settledValuesOrThrow(settled, parentRun.id);

  const totalCostUsd = sumFanOutCost(outcomes);
  const totalTokens = sumFanOutTokens(outcomes);
  tokensUnknown = outcomes.some(outcome => outcome.tokensUnknown === true);

  // If the run stopped underneath us (external pause/cancel mid-flight), do NOT write a
  // terminal aggregate — leave the node unwritten so resume re-drives the incomplete
  // instances. Mirrors the between-layer early-return posture of runLayers itself.
  let runStatus: WorkflowRunStatus | null;
  try {
    runStatus = await deps.store.getWorkflowRunStatus(parentRun.id);
  } catch (err) {
    const msg = `could not verify parent status after composed fan-out: ${(err as Error).message}`;
    return failResult(msg, 'unknown', totalCostUsd, totalTokens);
  }
  const claimedWorkMayFinishPaused =
    runStatus === 'paused' && ctx.claimedWorkPausePolicy === 'finish_through_parent_pause';
  if (runStatus !== 'running' && !claimedWorkMayFinishPaused) {
    getLog().info(
      { parentRunId: parentRun.id, nodeId: node.id, runStatus },
      'workflow.compose_fan_out_interrupted'
    );
    return {
      ...serializeNodeOutput(execution),
      ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
      ...(totalTokens !== undefined ? { tokens: totalTokens } : {}),
      ...(tokensUnknown ? { tokensUnknown: true } : {}),
    };
  }

  const ambiguous = outcomes.find(outcome => outcome.status === 'ambiguous');
  if (ambiguous !== undefined) {
    const msg = ambiguous.error ?? 'a composed instance has ambiguous non-terminal work';
    await notify(`❌ **Composed fan-out blocked** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'unknown', totalCostUsd, totalTokens);
  }

  if (fanOut.join === 'all_success') {
    const firstBad = outcomes.findIndex(o => o.status !== 'completed');
    if (firstBad !== -1) {
      const bad = outcomes[firstBad];
      const ref = `instance ${snapshots[firstBad].identity}`;
      await notify(
        `❌ **Composed fan-out failed** (node \`${node.id}\`): ${ref} ${bad.status}` +
          (bad.error ? ` — ${bad.error}` : '')
      );
      return failResult(
        `composed fan_out node '${node.id}' (join: all_success): ${ref} ${bad.status}` +
          (bad.error ? `: ${bad.error}` : ''),
        'child_failed',
        totalCostUsd,
        totalTokens,
        aggregateProviderFailure(
          outcomes.filter(o => o.status !== 'completed').map(o => o.providerFailure),
          Date.now()
        )
      );
    }
  }

  // all_done represents a failure as a marker object; all_success reaching here is all-completed.
  const elements = outcomes.map(o =>
    o.status === 'completed'
      ? ((o.structuredOutput !== undefined ? o.structuredOutput : o.output) as JsonValue)
      : {
          archon_failed: true,
          error: o.error ?? `instance ${o.status}`,
          status: o.status === 'cancelled' ? 'cancelled' : 'failed',
        }
  );
  const aggregate = JSON.stringify(elements);
  return writeCompleted(aggregate, totalCostUsd, totalTokens, elements);
}
