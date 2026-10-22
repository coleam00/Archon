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
} from '../../../node-record-serialization';
import { type NodeExecutionRecord } from '../../../schemas/node-execution';
import { NodeEventWriteError } from '../../../node-event-write';
import type { TokenUsage } from '@archon/provider-contract';
import { type ProviderFailure } from '@archon/provider-contract';
import type { ComposeFanOutNode, DagNode, NodeOutput, ResolvedWorkflow } from '../../../schemas';
import { planGraph } from '../../../graph-plan';
import type { DagResumeSnapshot, PersistedNodeOutput } from '../../../store';
import { getWorkflowEventEmitter } from '../../../event-emitter';
import { TerminalStatusWriteError } from '../../../terminal-status-write';
import type { IncludeCommandContent } from '../../../compiled-command';
import type { FanOutInstanceSnapshot } from '../../../fan-out-identity';
import { logWorkflowEvent } from '../../../logger';
import { aggregateProviderFailure, rootFailures } from '../../../executor-shared';
import { getLog } from '../../log';
import { runLayers } from '../../run-layers';
import { RunSourceUnreadableError } from '../../node-source';
import { sumReportedCost, sumFanOutTokens, type RunUsageFigures } from '../../usage';
import { type RunLayersContext } from '../../run-context';
import { expandComposeInstance } from './compose-fan-out-expansion';

/** One composed fan-out instance's execution outcome, reduced into the aggregate (#2512). */
export interface ComposeInstanceOutcome {
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

/** What every instance of one composed fan-out pass shares. */
export interface ComposeInstanceScope {
  ctx: RunLayersContext;
  node: ComposeFanOutNode;
  fanOutScopeName: string;
  resumeSnapshot: DagResumeSnapshot;
  definition: ResolvedWorkflow;
  commandContents: ReadonlyMap<string, IncludeCommandContent>;
}

/** One instance's identity inside the parent run. */
interface InstanceRun {
  scope: ComposeInstanceScope;
  snapshot: FanOutInstanceSnapshot;
  /** The instance's own step name, which its lifecycle rows carry. */
  scopeName: string;
  /** The prefix on every inner node's step name. */
  stepNamePrefix: string;
  execution: NodeExecutionRecord;
  priorUsage: RunUsageFigures;
}

/** A previously completed instance, threaded without re-running it. */
function threadedOutcome(prior: PersistedNodeOutput): ComposeInstanceOutcome {
  const spend = prior.execution?.spend;
  return {
    ...(spend?.tokens.source === 'unavailable' && spend.tokens.reason === 'incomplete'
      ? { tokensUnknown: true }
      : {}),
    status: 'completed',
    output: prior.output,
    ...(prior.structuredOutput !== undefined ? { structuredOutput: prior.structuredOutput } : {}),
  };
}

/** The instance's inner nodes that already completed, keyed by their authored ids. */
function threadCompletedInnerNodes(
  nodes: readonly DagNode[],
  priorOutputs: ReadonlyMap<string, PersistedNodeOutput>,
  stepNamePrefix: string
): { priorNodes: Map<string, PersistedNodeOutput>; nodeOutputs: Map<string, NodeOutput> } {
  const priorNodes = new Map<string, PersistedNodeOutput>();
  const nodeOutputs = new Map<string, NodeOutput>();
  for (const innerNode of nodes) {
    const persisted = priorOutputs.get(stepNamePrefix + innerNode.id);
    if (persisted === undefined) continue;
    priorNodes.set(innerNode.id, persisted);
    nodeOutputs.set(innerNode.id, {
      state: 'completed',
      output: persisted.output,
      ...(persisted.structuredOutput !== undefined
        ? { structuredOutput: persisted.structuredOutput }
        : {}),
      ...(persisted.execution !== undefined ? { execution: persisted.execution } : {}),
    });
  }
  return { priorNodes, nodeOutputs };
}

function startInstanceExecution(
  scope: ComposeInstanceScope,
  scopeName: string,
  snapshot: FanOutInstanceSnapshot
): NodeExecutionRecord {
  const { ctx, resumeSnapshot } = scope;
  return {
    ...startNodeExecution({
      runId: ctx.workflowRun.id,
      path: scopeName,
      node: { kind: 'compose_fan_out_instance', id: scopeName },
      invocation:
        resumeSnapshot.unfinishedInvocations?.get(nodeInvocationKey(scopeName, ctx.loopGroupPath))
          ?.invocation ?? newNodeInvocation(ctx.loopGroupPath),
    }),
    diagnostics: { identity: snapshot.identity, ordinal: snapshot.ordinal },
  };
}

async function deriveInstanceSinks(
  ctx: RunLayersContext,
  record: NodeExecutionRecord
): Promise<void> {
  const transcript = serializeNodeTranscript(record);
  if (transcript) await logWorkflowEvent(ctx.logDir, ctx.workflowRun.id, transcript);
  const emitted = serializeNodeEmitter(record);
  if (emitted) getWorkflowEventEmitter().emit(emitted);
}

/** Claim the instance's start; an outcome when it must not run. */
async function claimInstanceStart(
  instance: InstanceRun
): Promise<ComposeInstanceOutcome | undefined> {
  const { ctx } = instance.scope;
  try {
    const startEvent = serializeNodeStateRecord(instance.execution);
    const claim = await ctx.deps.store.persistWorkflowEventIfRunning(startEvent, {
      allowPaused: ctx.claimedWorkPausePolicy === 'finish_through_parent_pause',
    });
    if (!claim.persisted) {
      return {
        status: 'cancelled',
        output: '',
        error: 'parent run is no longer running; instance was not started',
      };
    }
    await deriveInstanceSinks(ctx, instance.execution);
  } catch (err) {
    return {
      status: 'failed',
      output: '',
      error: `instance ${instance.snapshot.identity} could not persist its start: ${(err as Error).message}`,
    };
  }
  return undefined;
}

/**
 * The context the composed body runs in: fresh output map, events under the parent run
 * id with engine-owned, instance-qualified step names.
 */
function instanceRunContext(
  instance: InstanceRun,
  nodes: DagNode[],
  threaded: ReturnType<typeof threadCompletedInnerNodes>
): RunLayersContext {
  const { ctx, resumeSnapshot } = instance.scope;
  return {
    toolAttention: ctx.toolAttention,
    unfinishedInvocations: resumeSnapshot.unfinishedInvocations,
    reportedChildUsage: resumeSnapshot.reportedChildUsage,
    unattributedChildUsagePaths: resumeSnapshot.unattributedChildUsagePaths,
    deps: ctx.deps,
    platform: ctx.platform,
    conversationId: ctx.conversationId,
    cwd: ctx.cwd,
    workflowSourceRoots: ctx.workflowSourceRoots,
    runChildWorkflow: ctx.runChildWorkflow,
    execContext: ctx.execContext,
    workflowRun: ctx.workflowRun,
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
    layers: planGraph(nodes).layers,
    nodeOutputs: threaded.nodeOutputs,
    priorCompletedNodes: threaded.priorNodes,
    claimedWorkPausePolicy: 'finish_through_parent_pause',
    lastSequentialSession: undefined,
    warnedProviderConflicts: ctx.warnedProviderConflicts,
    totalCostUsd: undefined,
    totalTokens: undefined,
    totalTokensUnknown: false,
    stepNamePrefix: instance.stepNamePrefix,
    loopGroupPath: ctx.loopGroupPath,
    // A composed instance is its own workflow: its prompts never took the enclosing
    // loop's substitution pass, so its command bodies don't either.
    loopBodyScopes: [],
  };
}

async function readOpenInstanceUsage(
  instance: Pick<InstanceRun, 'scope' | 'scopeName' | 'stepNamePrefix'>
): Promise<RunUsageFigures> {
  const { ctx } = instance.scope;
  const rows = await ctx.deps.store.listWorkflowEvents(ctx.workflowRun.id);
  let lastTerminal = rows.length - 1;
  while (lastTerminal >= 0) {
    const row = rows[lastTerminal];
    if (
      row.step_name === instance.scopeName &&
      (row.event_type === 'node_completed' || row.event_type === 'node_failed')
    )
      break;
    lastTerminal--;
  }
  // Earlier instance terminals already own their segment's usage. An unfinished
  // segment can span multiple starts, so a recovery start must not reset its spend.
  return foldDagResumeSnapshot(
    rows.slice(lastTerminal + 1).filter(row => row.step_name?.startsWith(instance.stepNamePrefix)),
    ctx.workflowRun.id
  );
}

function isLifecycleWriteError(error: unknown): boolean {
  return error instanceof NodeEventWriteError || error instanceof TerminalStatusWriteError;
}

/**
 * Close an instance whose body could not read its source. Without a terminal record the
 * resumed fan-out would find this instance started and never finished, and refuse to
 * replay it.
 */
async function releaseSourceUnreadableInstance(
  instance: InstanceRun,
  error: RunSourceUnreadableError
): Promise<void> {
  const { ctx } = instance.scope;
  const parentRunId = ctx.workflowRun.id;
  const { snapshot, execution, scopeName } = instance;
  let releasedRecord = finishNodeExecution(
    execution,
    { status: 'failed', error: error.message, failureKind: 'child_failed' },
    { output: { text: '' } }
  );
  try {
    const usage = await readOpenInstanceUsage(instance);
    releasedRecord = finishNodeExecution(
      execution,
      { status: 'failed', error: error.message, failureKind: 'child_failed' },
      {
        costUsd: usage.costUsd,
        tokens: usage.tokens,
        tokensUnknown: usage.tokensUnknown,
        output: { text: '' },
        diagnostics: { identity: snapshot.identity, ordinal: snapshot.ordinal },
      }
    );
    await ctx.deps.store.persistWorkflowEvent(serializeNodeStateRecord(releasedRecord));
  } catch (closureError) {
    if (isLifecycleWriteError(closureError)) throw closureError;
    // The terminal owns the scope's spend. If accounting cannot be read, recovery
    // must retain the open start rather than close it with incomplete usage.
    throw new NodeEventWriteError(serializeNodeStateRecord(releasedRecord), closureError);
  }
  try {
    await deriveInstanceSinks(ctx, releasedRecord);
  } catch (cleanupError) {
    if (isLifecycleWriteError(cleanupError)) throw cleanupError;
    getLog().error(
      { err: cleanupError, parentRunId, instance: scopeName },
      'workflow.compose_fan_out_release_sinks_failed'
    );
  }
}

/**
 * Store the instance's terminal record. An outcome whose record cannot be stored is
 * ambiguous: resume would find the instance started and never finished.
 */
async function recordInstanceTerminal(
  instance: InstanceRun,
  outcome: ComposeInstanceOutcome,
  lifecycle: Extract<NodeExecutionRecord['lifecycle'], { status: 'completed' | 'failed' }>,
  storeFailure: string
): Promise<ComposeInstanceOutcome> {
  const { ctx } = instance.scope;
  const { snapshot } = instance;
  try {
    const record = finishNodeExecution(instance.execution, lifecycle, {
      output: {
        text: outcome.output,
        ...(outcome.structuredOutput !== undefined ? { structured: outcome.structuredOutput } : {}),
      },
      costUsd: sumReportedCost([instance.priorUsage, outcome]),
      tokens: sumFanOutTokens([instance.priorUsage, outcome]),
      tokensUnknown: instance.priorUsage.tokensUnknown === true || outcome.tokensUnknown === true,
      diagnostics: { identity: snapshot.identity, ordinal: snapshot.ordinal },
    });
    await ctx.deps.store.persistWorkflowEvent(serializeNodeStateRecord(record));
    await deriveInstanceSinks(ctx, record);
  } catch (err) {
    return {
      ...outcome,
      status: 'ambiguous',
      error: `instance ${snapshot.identity} ${storeFailure}: ${(err as Error).message}`,
    };
  }
  return outcome;
}

/** Reduce a finished body run to the instance outcome, storing its terminal record. */
async function settleInstance(
  instance: InstanceRun,
  instanceCtx: RunLayersContext,
  primarySink: string
): Promise<ComposeInstanceOutcome> {
  // Every instance exit carries the work it already paid for.
  const instanceUsage: Pick<ComposeInstanceOutcome, 'costUsd' | 'tokens' | 'tokensUnknown'> = {
    ...(instanceCtx.totalCostUsd !== undefined ? { costUsd: instanceCtx.totalCostUsd } : {}),
    ...(instanceCtx.totalTokens !== undefined ? { tokens: instanceCtx.totalTokens } : {}),
    tokensUnknown: instanceCtx.totalTokensUnknown,
  };
  const failed = [...instanceCtx.nodeOutputs.values()].filter(o => o.state === 'failed');
  if (failed.length > 0) {
    const providerFailure = aggregateProviderFailure(
      rootFailures(instanceCtx.layers.flat(), instanceCtx.nodeOutputs).map(
        ({ output }) => output.providerFailure
      ),
      Date.now()
    );
    const outcome: ComposeInstanceOutcome = {
      status: 'failed',
      output: '',
      error: failed[0].error ?? 'composed instance node failed',
      ...(providerFailure !== undefined ? { providerFailure } : {}),
      ...instanceUsage,
    };
    return recordInstanceTerminal(
      instance,
      outcome,
      {
        status: 'failed',
        error: outcome.error ?? 'composed instance node failed',
        failureKind: 'child_failed',
        ...(providerFailure !== undefined ? { providerFailure } : {}),
      },
      'failed and its terminal state could not be stored'
    );
  }
  // Cancellation or another terminal status can stop runLayers early. A claimed
  // deterministic instance finishes through a sibling's pause and reaches its sink.
  // Surface any remaining incompleteness rather than treating absent output as success.
  const terminal = instanceCtx.nodeOutputs.get(primarySink);
  if (terminal?.state !== 'completed') {
    return {
      status: 'ambiguous',
      output: '',
      ...instanceUsage,
      error:
        `composed instance ${instance.snapshot.identity} stopped without a terminal state; ` +
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
  return recordInstanceTerminal(
    instance,
    outcome,
    { status: 'completed' },
    'completed but its result could not be stored'
  );
}

/**
 * Execute one composed fan-out instance: thread it whole when it already completed,
 * otherwise run the composed body via runLayers in its own context, threading inner
 * nodes that already completed. The authored node ids remain ordinary DAG ids inside
 * that isolated execution context.
 */
export async function runComposeInstance(
  scope: ComposeInstanceScope,
  snapshot: FanOutInstanceSnapshot
): Promise<ComposeInstanceOutcome> {
  let expanded: { nodes: DagNode[]; primarySink: string } | { error: string };
  try {
    expanded = expandComposeInstance(
      scope.node,
      snapshot.identity,
      snapshot.inputs,
      scope.definition,
      scope.commandContents
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
  const priorOutputs = scope.resumeSnapshot.completedNodeOutputs;
  const scopeName = `${scope.fanOutScopeName}__${snapshot.identity}`;
  const prior = priorOutputs.get(scopeName);
  if (prior !== undefined) return threadedOutcome(prior);

  const stepNamePrefix = `${scopeName}__`;
  const threaded = threadCompletedInnerNodes(expanded.nodes, priorOutputs, stepNamePrefix);
  let priorUsage: RunUsageFigures;
  try {
    priorUsage = await readOpenInstanceUsage({ scope, scopeName, stepNamePrefix });
  } catch (error) {
    return {
      status: 'ambiguous',
      output: '',
      error: `instance ${snapshot.identity} could not read its prior usage: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const instance: InstanceRun = {
    scope,
    snapshot,
    scopeName,
    stepNamePrefix,
    execution: startInstanceExecution(scope, scopeName, snapshot),
    priorUsage,
  };
  const notStarted = await claimInstanceStart(instance);
  if (notStarted !== undefined) return notStarted;

  const instanceCtx = instanceRunContext(instance, expanded.nodes, threaded);
  try {
    await runLayers(instanceCtx);
  } catch (error) {
    if (error instanceof RunSourceUnreadableError) {
      await releaseSourceUnreadableInstance(instance, error);
    }
    throw error;
  }
  return settleInstance(instance, instanceCtx, expanded.primarySink);
}
