import { ParentStatusReadError } from '../../../parent-status-read';
import { finishNodeExecution } from '../../../node-execution';
import { serializeNodeOutput, type NodeExecutionResult } from '../../../node-record-serialization';
import { type NodeFailureKind } from '../../../schemas/node-execution';
import { recordNodeState } from '../../../node-event-write';
import { discoverWorkflowsWithConfig } from '../../../workflow-discovery';
import { resolveWorkflowCommandContents } from '../../../workflow-discovery/command-scan';
import { findWorkflowLoadError, type WorkflowLoadError } from '../../../schemas/workflow';
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
import type { ComposeFanOutNode, ResolvedWorkflow, WorkflowRunStatus } from '../../../schemas';
import type { DagResumeSnapshot } from '../../../store';
import { type IncludeCommandContent, isIncludeCommandReadError } from '../../../compiled-command';
import { mapWithLimit } from '../../../utils/map-with-limit';
import { collectComposedSuspensionPaths } from '../../../include/suspension';
import { composeFanOutScopeSegment } from '../../../fan-out-identity';
import { safeSendMessage } from '../../../platform-messages';
import { getLog } from '../../log';
import { sumReportedCost, sumFanOutTokens } from '../../usage';
import { RunSourceUnreadableError, settledValuesOrThrow } from '../../node-source';
import { beginExecution, type RunLayersContext } from '../../run-context';
import {
  planComposeInstances,
  resolveComposeItems,
  type ComposeFanOutFailure,
} from './compose-fan-out-expansion';
import { runComposeInstance } from './compose-fan-out-instance';
import { joinComposeOutcomes } from './compose-fan-out-join';

function unresolvedFanOutTarget(
  errors: readonly WorkflowLoadError[],
  targetName: string,
  verifiedFiles: ReadonlySet<string> | undefined
): { unresolved: string } {
  const relevantError =
    findWorkflowLoadError(errors, targetName) ??
    errors.find(
      error => error.workflowName === undefined && isSourceReadFailure(error.cause, verifiedFiles)
    );
  if (relevantError !== undefined && isSourceReadFailure(relevantError.cause, verifiedFiles)) {
    throw relevantError.cause;
  }
  return {
    unresolved: relevantError?.error ?? `no workflow named '${targetName}' was found`,
  };
}

function assertFanOutCommandsReadable(
  commandContents: ReadonlyMap<string, IncludeCommandContent>,
  verifiedFiles: ReadonlySet<string> | undefined
): void {
  for (const content of commandContents.values()) {
    if (isIncludeCommandReadError(content) && isSourceReadFailure(content.cause, verifiedFiles)) {
      throw content.cause;
    }
  }
}

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
      return unresolvedFanOutTarget(errors, targetName, verifiedFiles);
    }
    const commandContents = await resolveWorkflowCommandContents(
      sourceRoots,
      [definition],
      verifiedFiles
    );
    assertFanOutCommandsReadable(commandContents, verifiedFiles);
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
 * Preflight BEFORE any instance spend: the target must still resolve (it may have been
 * renamed or deleted since load), and its complete closure must remain suspension-free.
 */
async function preflightComposedBody(
  node: ComposeFanOutNode,
  ctx: RunLayersContext
): Promise<
  | {
      definition: ResolvedWorkflow;
      commandContents: ReadonlyMap<string, IncludeCommandContent>;
    }
  | ComposeFanOutFailure
> {
  let resolved: Awaited<ReturnType<typeof resolveFanOutChildDefinition>>;
  try {
    resolved = await resolveFanOutChildDefinition(
      ctx.deps,
      ctx.cwd,
      node.include,
      ctx.workflowSourceRoots
    );
  } catch (error) {
    if (isSourceReadFailure(error))
      throw new RunSourceUnreadableError(ctx.stepNamePrefix + node.id, error);
    throw error;
  }
  if ('unresolved' in resolved) {
    return blocked(
      node,
      `composed fan-out node '${node.id}': cannot resolve the composed block '${node.include}' — ` +
        `${resolved.unresolved}. Fix the include target name.`,
      'config'
    );
  }
  const bodySuspensions = collectComposedSuspensionPaths(resolved.definition, resolved.definitions);
  if (bodySuspensions.length > 0) {
    const names = bodySuspensions.map(entry => `'${entry.id}' (${entry.reason})`).join(', ');
    getLog().warn(
      { parentRunId: ctx.workflowRun.id, nodeId: node.id, include: node.include },
      'workflow.compose_fan_out_suspension_rejected'
    );
    return blocked(
      node,
      `composed fan-out node '${node.id}': the composed block '${node.include}' contains ` +
        `suspension-capable path${bodySuspensions.length === 1 ? '' : 's'} ${names}. An in-parent ` +
        'fan-out has no per-instance pause cursor, so it cannot safely resume a partly completed ' +
        "body. Remove the suspension path, or invoke the block once through 'include:' or 'workflow:'.",
      'config'
    );
  }
  return { definition: resolved.definition, commandContents: resolved.commandContents };
}

function blocked(
  node: ComposeFanOutNode,
  error: string,
  failureKind: NodeFailureKind
): ComposeFanOutFailure {
  return {
    error,
    failureKind,
    notice: `❌ **Composed fan-out blocked** (node \`${node.id}\`): ${error}`,
  };
}

/**
 * If the run stopped underneath us (external pause/cancel mid-flight), do NOT write a
 * terminal aggregate — leave the node unwritten so resume re-drives the incomplete
 * instances. Mirrors the between-layer early-return posture of runLayers itself.
 */
async function readParentStatus(
  ctx: RunLayersContext,
  node: ComposeFanOutNode
): Promise<'accepting' | 'stopped'> {
  const parentRunId = ctx.workflowRun.id;
  let runStatus: WorkflowRunStatus | null;
  try {
    runStatus = await ctx.deps.store.getWorkflowRunStatus(parentRunId);
  } catch (err) {
    throw new ParentStatusReadError(parentRunId, ctx.stepNamePrefix + node.id, err);
  }
  const claimedWorkMayFinishPaused =
    runStatus === 'paused' && ctx.claimedWorkPausePolicy === 'finish_through_parent_pause';
  if (runStatus === 'running' || claimedWorkMayFinishPaused) return 'accepting';
  getLog().info(
    { parentRunId, nodeId: node.id, runStatus },
    'workflow.compose_fan_out_interrupted'
  );
  return 'stopped';
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
  const { deps, platform, conversationId, workflowRun: parentRun } = ctx;
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

  const failWith = async (failure: ComposeFanOutFailure): Promise<NodeExecutionResult> => {
    await notify(failure.notice);
    return failResult(failure.error, failure.failureKind);
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
    return failWith(blocked(node, msg, 'unknown'));
  }
  const persistedSnapshots = resumeSnapshot.fanOutSnapshots.get(fanOutScopeName);

  const currentItems = resolveComposeItems(node, ctx, fanOut);
  if ('error' in currentItems && persistedSnapshots === undefined) {
    return failWith({
      error: currentItems.error,
      failureKind: 'config',
      notice: `❌ **Composed fan-out failed** (node \`${node.id}\`): ${currentItems.error}`,
    });
  }
  if ('error' in currentItems) {
    getLog().warn(
      { parentRunId: parentRun.id, nodeId: node.id, error: currentItems.error },
      'workflow.compose_fan_out_item_drift_unreadable'
    );
  }

  const body = await preflightComposedBody(node, ctx);
  if ('error' in body) return failWith(body);

  const plan = await planComposeInstances(
    node,
    ctx,
    fanOut,
    fanOutScopeName,
    currentItems,
    persistedSnapshots
  );
  if ('error' in plan) return failWith(plan);
  const { snapshots } = plan;

  if (snapshots.length === 0) {
    getLog().info({ parentRunId: parentRun.id, nodeId: node.id }, 'workflow.compose_fan_out_empty');
    return writeCompleted('[]', undefined, undefined, []);
  }

  const ambiguousIdentity = snapshots.find(snapshot =>
    resumeSnapshot.unresolvedNodeStarts.has(`${fanOutScopeName}__${snapshot.identity}`)
  );
  if (ambiguousIdentity !== undefined) {
    return failWith(
      blocked(
        node,
        `composed fan-out node '${node.id}' has instance '${ambiguousIdentity.identity}' with ` +
          'a durable start but no terminal event. It may still be running or may have completed ' +
          'before its result was stored. Archon will not replay it automatically; inspect the ' +
          'run and deliberately abandon it or start a new run.',
        'unknown'
      )
    );
  }

  // Execute incomplete identities through a bounded sliding window.
  const scope = { ctx, node, fanOutScopeName, resumeSnapshot, ...body };
  const settled = await mapWithLimit(snapshots, fanOut.max_parallel, snapshot =>
    runComposeInstance(scope, snapshot)
  );

  const outcomes = settledValuesOrThrow(settled, parentRun.id);

  const totalCostUsd = sumReportedCost(outcomes);
  const totalTokens = sumFanOutTokens(outcomes);
  tokensUnknown = outcomes.some(outcome => outcome.tokensUnknown === true);

  const parent = await readParentStatus(ctx, node);
  if (parent === 'stopped') {
    return {
      ...serializeNodeOutput(execution),
      ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
      ...(totalTokens !== undefined ? { tokens: totalTokens } : {}),
      ...(tokensUnknown ? { tokensUnknown: true } : {}),
    };
  }

  const joined = joinComposeOutcomes(node, fanOut.join, snapshots, outcomes);
  if (joined.status === 'failed') {
    await notify(joined.notice);
    return failResult(
      joined.error,
      joined.failureKind,
      totalCostUsd,
      totalTokens,
      joined.providerFailure
    );
  }
  return writeCompleted(
    JSON.stringify(joined.elements),
    totalCostUsd,
    totalTokens,
    joined.elements
  );
}
