/**
 * Agent node dispatch: resolve the node's provider and model, choose the session it
 * continues, run it with retry, and carry its session forward for later nodes and runs.
 */
import { join as joinPath } from 'path';
import { requireProvider, sessionPreview } from '@archon/provider-contract';
import type { AgentNode } from '../../../schemas';
import type { WorkflowNodeSession } from '../../../schemas';
import {
  isNodeContextResume,
  isNodeContextSame,
  nodeUsesPersistedScope,
  persistedSessionHandling,
} from '../../../schemas';
import { spellWorkflowCommand } from '../../../deps';
import { readNodeArtifacts } from '../../../artifacts-index';
import { writeInvocationListings } from '../../../invocation-listings';
import { readComposedMeta } from '../../../compiled-command';
import { safeSendMessage } from '../../../platform-messages';
import { getLog } from '../../log';
import { aiConfigTextResolver } from '../../references';
import { resolveNodeProviderAndModel } from '../../provider-resolution';
import { getEffectiveNodeRetryConfig, runBudgetedAttempt, runNodeRetryLoop } from '../../retry';
import {
  checkoutSnapshotExcludes,
  snapshotGuardedNode,
  assertCheckoutUntouched,
} from '../../checkout-guard';
import {
  type LayerNodeResult,
  type PersistScope,
  type RunLayersContext,
  type SessionResumeIntent,
  sessionCheckpoint,
} from '../../run-context';
import { executeAgentNode } from './agent';

interface SessionSelection {
  resumeSessionId: string | undefined;
  resumeIntent: SessionResumeIntent;
  /** The node names its session source with `context: { resume }`. */
  named: boolean;
}

export async function dispatchAgentNode(
  ctx: RunLayersContext,
  node: AgentNode,
  isParallelLayer: boolean
): Promise<LayerNodeResult> {
  const iteration = ctx.loopGroupPath.at(-1)?.iteration;
  // Agent nodes reach a provider, so AI-configuration text gets this
  // observation; the body prompt is substituted per attempt below.
  const listings = await writeInvocationListings(ctx);
  const {
    provider,
    model: resolvedNodeModel,
    options: nodeOptions,
    tier: resolvedTier,
    effort: resolvedEffort,
  } = await resolveNodeProviderAndModel(ctx, node, {
    resolveAiText: aiConfigTextResolver(ctx, listings),
    warnedProviderConflicts: ctx.warnedProviderConflicts,
  });

  // Strictly opt-in: on only when the node sets persist_session (or inherits the
  // workflow-level persist_sessions default) and its context is neither 'fresh' nor
  // 'same' (which keeps its own cross-run session, under the item).
  // A parallel-layer node CAN still use persist_session — it just doesn't share
  // with siblings. Same predicate gates the scope-artifact mirror below.
  const usesPersistedScope = nodeUsesPersistedScope(node, ctx.workflowPersistSessions);
  const session = await chooseSession(
    ctx,
    node,
    provider,
    resolvedNodeModel,
    isParallelLayer,
    usesPersistedScope
  );
  const resumeSessionId = session.resumeSessionId;

  // Execute with retry for transient failures. AI nodes get the
  // default 2 transient retries; the shared loop applies the same
  // backoff + FATAL-never-retried semantics as deterministic nodes.
  // `mutates_checkout: false` (#2771) is asserted OUTSIDE the retry loop:
  // the snapshot covers every attempt, and a violation fails the node
  // without offering retry another chance to mutate.
  const checkoutExcludes = checkoutSnapshotExcludes(ctx.artifactsDir, ctx.stateDir, ctx.logDir);
  const treeBefore = await snapshotGuardedNode(ctx, node, checkoutExcludes);
  const retriedOutput = await runNodeRetryLoop(
    node,
    ctx.platform,
    ctx.conversationId,
    ctx.workflowRun,
    ctx.deps.store,
    ctx.stepNamePrefix + node.id,
    getEffectiveNodeRetryConfig(node),
    () =>
      runBudgetedAttempt(ctx, node, async reserve => {
        // Fresh per attempt: an attempt after a transient failure observes
        // artifacts published in the interval, and never reuses the
        // listing handed to AI-configuration substitution above.
        const attemptListings = await writeInvocationListings(ctx);
        return executeAgentNode(
          ctx,
          node,
          reserve,
          provider,
          nodeOptions,
          resumeSessionId,
          resolvedNodeModel,
          resolvedTier,
          resolvedEffort,
          ctx.stepNamePrefix,
          iteration,
          sessionCheckpoint(ctx, node, provider),
          attemptListings,
          session.resumeIntent
        );
      }),
    { state: 'failed', output: '', error: 'Node did not execute' },
    iteration
  );
  const output = await assertCheckoutUntouched(
    node,
    ctx.cwd,
    checkoutExcludes,
    treeBefore,
    retriedOutput,
    ctx.deps,
    ctx.logDir,
    ctx.guardedLayerSnapshots
  );

  // Cold-resume surfacing: this node requested a session resume but the
  // provider reported it came back cold (resumed === false) — the prior
  // context is gone. Every provider's cold fallback is already a clean
  // fresh session, so the run we just completed is a valid fresh-context
  // result; we keep it and persist its fresh session id below. Surface the
  // lost continuity to the user (no silent failure) so a degraded run isn't
  // mistaken for a normal resumed one — but do NOT re-run: a replay would
  // only repeat the same fresh run at double the cost and side effects.
  if (
    !session.named &&
    resumeSessionId !== undefined &&
    output.state === 'completed' &&
    output.resumed === false
  ) {
    // By-reference recovery (#1846): the prior session is gone, but prior
    // invocations of this workflow+scope may have left typed artifacts in
    // the stable scope dir. Point at them (paths only — never pasted
    // content) so the lost context is recoverable on demand. Entries from
    // THIS run are excluded — they were produced by the current (fresh)
    // invocation and recover nothing. Best-effort: a scope-dir read
    // failure degrades to the plain warning, never fails the node.
    const recoveryPointer = ctx.scopeArtifactsDir
      ? await buildColdResumeRecoveryPointer(ctx.scopeArtifactsDir, ctx.workflowRun.id, node.id)
      : '';
    getLog().warn(
      {
        nodeId: node.id,
        provider,
        workflowRunId: ctx.workflowRun.id,
        resumeSessionIdPreview: sessionPreview(resumeSessionId),
        priorArtifactsFound: recoveryPointer !== '',
      },
      'dag.session_resume_failed'
    );
    await safeSendMessage(
      ctx.platform,
      ctx.conversationId,
      `⚠️ Node \`${node.id}\`: could not resume the prior session — continued with a fresh session, so the earlier context was not restored.${recoveryPointer}`,
      { workflowId: ctx.workflowRun.id, nodeName: node.id }
    );
  }

  // Advance the scope's cursor to this node's session for the next run. Concurrent
  // runs each write their own session, so the cursor ends at the newest finished
  // one. A completion without a session ID leaves the row alone: deleting it could
  // erase a newer session a sibling run just wrote. A provider that cannot fork
  // still writes its row: the next run never continues it, but reads it to record
  // which session it did not continue. A `context: same` node writes under the item
  // every round, so a later run, or a resume that restarts mid-loop without saved
  // cursors, continues the newest round.
  const writeScope = usesPersistedScope
    ? ctx.persistScope
    : isNodeContextSame(node.context)
      ? ctx.itemScope
      : undefined;
  if (writeScope && output.state === 'completed' && output.sessionId !== undefined) {
    await recordScopedSession(ctx, node, writeScope, {
      // persist_session rows have always keyed on the bare id; `same` rows on the path.
      nodeId: usesPersistedScope ? node.id : ctx.stepNamePrefix + node.id,
      provider,
      model: resolvedNodeModel,
      sessionId: output.sessionId,
    });
  }

  return {
    nodeId: node.id,
    output,
    sessionProvider: provider,
    ...(resolvedNodeModel !== undefined ? { sessionModel: resolvedNodeModel } : {}),
  };
}

/**
 * The session the node starts from: its own (`context: same`), else the in-run choice,
 * replaced by the session a `persist_session` node left in its thread scope when there
 * is one to continue.
 */
async function chooseSession(
  ctx: RunLayersContext,
  node: AgentNode,
  provider: string,
  model: string | undefined,
  isParallelLayer: boolean,
  usesPersistedScope: boolean
): Promise<SessionSelection> {
  if (isNodeContextSame(node.context)) return selectOwnSession(ctx, node, provider, model);
  const session = selectSession(ctx, node, provider, isParallelLayer);
  if (!usesPersistedScope) return session;
  const handling = persistedSessionHandling(
    requireProvider(ctx.deps.providers, provider).capabilities
  );
  if (handling === 'unsupported') {
    throw new Error(
      `Node '${node.id}' has persist_session: true but resolved provider '${provider}' does not support sessionResume. Remove persist_session, or use a provider with sessionResume capability.`
    );
  }
  const persistScope = ctx.persistScope;
  if (!persistScope || session.named) return session;
  const persisted = await persistedSessionToContinue(
    ctx,
    node,
    provider,
    persistScope,
    handling === 'fork'
  );
  return persisted === undefined ? session : { ...session, resumeSessionId: persisted };
}

const FRESH_SESSION: SessionSelection = {
  resumeSessionId: undefined,
  resumeIntent: 'ordinary',
  named: false,
};

/** Why a recorded session is not continued by a node now resolving to another pair. */
function sessionPairChange(
  recorded: { provider: string; model?: string | null },
  provider: string,
  model: string | undefined
): 'provider_changed' | 'model_changed' | undefined {
  if (recorded.provider !== provider) return 'provider_changed';
  // No recorded model means the node resolved none then; it matches only an unresolved one now.
  if ((recorded.model ?? undefined) !== model) return 'model_changed';
  return undefined;
}

/**
 * `context: same`: the session this node itself last had. Its own cursor from an earlier
 * round of this loop invocation continues in place; otherwise the newest session it left
 * on the run's item, in whichever run, is forked, so two runs never append to one
 * session. A session from another provider or model is never continued, and the run says
 * so. With neither, the node starts fresh. Never the shared sequential cursor, and never
 * reset by a parallel layer, `fresh_context`, or the start of a composed block.
 */
async function selectOwnSession(
  ctx: RunLayersContext,
  node: AgentNode,
  provider: string,
  model: string | undefined
): Promise<SessionSelection> {
  const handling = persistedSessionHandling(
    requireProvider(ctx.deps.providers, provider).capabilities
  );
  if (handling === 'unsupported') {
    throw new Error(
      `Node '${node.id}' has context: same but resolved provider '${provider}' does not support sessionResume. Use another context, or a provider with sessionResume capability.`
    );
  }

  const cursor = ctx.bodySessionCursors?.get(node.id);
  if (cursor !== undefined) {
    const change = sessionPairChange(cursor, provider, model);
    if (change === undefined) {
      return {
        resumeSessionId: cursor.sessionId,
        resumeIntent: 'owner-continuation',
        named: false,
      };
    }
    // The earlier round's session is this run's own work; an older item session would skip
    // it, so a changed pair starts fresh rather than falling back to the item.
    await reportOwnSessionNotContinued(ctx, node, {
      reason: change,
      provider,
      model,
      recorded: cursor,
      sessionId: cursor.sessionId,
      scopeKey: undefined,
    });
    return FRESH_SESSION;
  }

  const itemScope = ctx.itemScope;
  if (itemScope === undefined) return FRESH_SESSION;
  let newest: WorkflowNodeSession[];
  try {
    newest = newestSessions(await itemScope.sessionsAtStart, ctx.stepNamePrefix + node.id);
  } catch (err) {
    await reportLookupFailed(ctx, node, provider, itemScope, err as Error);
    return FRESH_SESSION;
  }
  const [recorded, ...tied] = newest;
  if (recorded === undefined) return FRESH_SESSION;
  // Rows are one per provider, and a store may record seconds only, so two providers'
  // sessions can tie as newest. Neither is provably the last one; continuing either could
  // restore stale context, so the node starts fresh and says why.
  if (tied.length > 0) {
    await reportOwnSessionNotContinued(ctx, node, {
      reason: 'ambiguous',
      provider,
      model,
      recorded,
      sessionId: recorded.provider_session_id,
      scopeKey: itemScope.key,
    });
    return FRESH_SESSION;
  }

  const change = sessionPairChange(recorded, provider, model);
  if (change !== undefined || handling === 'fresh') {
    await reportOwnSessionNotContinued(ctx, node, {
      reason: change ?? 'no_fork',
      provider,
      model,
      recorded,
      sessionId: recorded.provider_session_id,
      scopeKey: itemScope.key,
    });
    return FRESH_SESSION;
  }
  recordSessionEvent(ctx, node, 'node_session_resumed', {
    provider,
    scope_key: itemScope.key,
    provider_session_id_preview: sessionPreview(recorded.provider_session_id),
  });
  // 'ordinary' requests a fork: the earlier run's session stays as it was.
  return { resumeSessionId: recorded.provider_session_id, resumeIntent: 'ordinary', named: false };
}

/** Every session for one node path that ties as the most recently written, over every provider. */
function newestSessions(
  rows: readonly WorkflowNodeSession[],
  nodePath: string
): WorkflowNodeSession[] {
  let newest: WorkflowNodeSession[] = [];
  for (const row of rows) {
    if (row.node_id !== nodePath) continue;
    const latest = newest[0]?.updated_at;
    if (latest === undefined || row.updated_at > latest) newest = [row];
    else if (row.updated_at === latest) newest.push(row);
  }
  return newest;
}

function recordSessionEvent(
  ctx: RunLayersContext,
  node: AgentNode,
  eventType: 'node_session_resumed' | 'node_session_not_continued',
  data: Record<string, unknown>
): void {
  // This event is not a node record, so it carries only the session preview.
  ctx.deps.store
    .createWorkflowEvent({
      workflow_run_id: ctx.workflowRun.id,
      event_type: eventType,
      step_name: ctx.stepNamePrefix + node.id,
      data,
    })
    .catch((err: Error) => {
      getLog().warn({ err, nodeId: node.id }, 'persist_session_event_persist_failed');
    });
}

async function reportOwnSessionNotContinued(
  ctx: RunLayersContext,
  node: AgentNode,
  report: {
    reason: 'provider_changed' | 'model_changed' | 'no_fork' | 'ambiguous';
    provider: string;
    model: string | undefined;
    recorded: { provider: string; model?: string | null };
    sessionId: string;
    scopeKey: string | undefined;
  }
): Promise<void> {
  const recordedModel = report.recorded.model ?? null;
  recordSessionEvent(ctx, node, 'node_session_not_continued', {
    reason: report.reason,
    provider: report.provider,
    model: report.model ?? null,
    recorded_provider: report.recorded.provider,
    recorded_model: recordedModel,
    ...(report.scopeKey !== undefined ? { scope_key: report.scopeKey } : {}),
    provider_session_id_preview: sessionPreview(report.sessionId),
  });
  const pair = (p: string, m: string | null | undefined): string =>
    `\`${p}\`${m ? ` / \`${m}\`` : ''}`;
  const message =
    report.reason === 'no_fork'
      ? `⚠️ Node \`${node.id}\`: provider \`${report.provider}\` cannot fork a session, so this run started fresh instead of continuing the session the node last had on this item (concurrent runs never share one provider conversation).`
      : report.reason === 'ambiguous'
        ? `⚠️ Node \`${node.id}\`: started fresh, because sessions it left on this item under more than one provider were recorded at the same time and the last one cannot be told apart.`
        : `⚠️ Node \`${node.id}\`: started fresh instead of continuing its last session, which ran on ${pair(report.recorded.provider, recordedModel)}; the node now resolves to ${pair(report.provider, report.model)}.`;
  await safeSendMessage(ctx.platform, ctx.conversationId, message, {
    workflowId: ctx.workflowRun.id,
    nodeName: node.id,
  });
}

async function reportLookupFailed(
  ctx: RunLayersContext,
  node: AgentNode,
  provider: string,
  scope: PersistScope,
  err: Error
): Promise<void> {
  // Non-fatal: the node still runs (fresh, no resume), but the user opted into
  // continuity, and a DB error here silently breaks it, so warn them as well as the
  // logs. (A "no row" result is not an error and never reaches this.)
  getLog().warn(
    { err, nodeId: node.id, workflow: scope.workflowName, scopeKey: scope.key, provider },
    'persist_session_lookup_failed'
  );
  await safeSendMessage(
    ctx.platform,
    ctx.conversationId,
    `⚠️ Could not load the persisted session for node \`${node.id}\` — it will run without prior context. Session continuity may be broken; if this recurs, check server logs or run \`${spellWorkflowCommand(ctx.platform, `reset-sessions ${scope.workflowName}`)}\`.`,
    { workflowId: ctx.workflowRun.id, nodeName: node.id }
  );
}

async function recordScopedSession(
  ctx: RunLayersContext,
  node: AgentNode,
  scope: PersistScope,
  session: { nodeId: string; provider: string; model: string | undefined; sessionId: string }
): Promise<void> {
  try {
    await ctx.deps.store.upsertWorkflowNodeSession({
      workflow_name: scope.workflowName,
      node_id: session.nodeId,
      scope_key: scope.key,
      provider: session.provider,
      model: session.model ?? null,
      provider_session_id: session.sessionId,
      last_run_id: ctx.workflowRun.id,
    });
  } catch (err) {
    // Non-fatal: persistence failure does not undo a successful node execution. But the
    // author opted into continuity, and the next run will not continue this session, so
    // warn them as well as the logs.
    getLog().warn(
      {
        err: err as Error,
        nodeId: node.id,
        workflow: scope.workflowName,
        scopeKey: scope.key,
        provider: session.provider,
      },
      'persist_session_upsert_failed'
    );
    await safeSendMessage(
      ctx.platform,
      ctx.conversationId,
      `⚠️ Could not persist the session for node \`${node.id}\` (${session.provider}). The next run will not continue from it.`,
      { workflowId: ctx.workflowRun.id, nodeName: node.id }
    );
  }
}

/**
 * Choose the session the node continues within this run. An explicit named ancestor has
 * first priority and is independent of the ambient sequential cursor and parallel-layer
 * reset.
 */
function selectSession(
  ctx: RunLayersContext,
  node: AgentNode,
  provider: string,
  isParallelLayer: boolean
): SessionSelection {
  if (isNodeContextResume(node.context)) {
    return selectNamedSession(ctx, node, provider, node.context.resume);
  }

  // Legacy scalar/default selection — parallel or context:fresh → always fresh.
  // Parallel layers always get fresh sessions; explicit 'fresh' context also forces it.
  // 'shared' forces continuation. Default: fresh for parallel, inherited for sequential.
  // isFreshSequential controls in-run threading (lastSequentialSession).
  // Cross-provider guard (#1992): a session id can only be resumed by the provider
  // that created it, so the cursor is threaded only into nodes that resolve to the
  // SAME provider — on a provider change the node starts fresh instead of failing
  // (Claude) or silently cold-falling-back (Codex) on a foreign session id.
  //
  // The first AI node of a composed workflow is the third fresh case (#1764, #5740).
  // Standalone, no session exists before that node, so it has no cursor to inherit;
  // composed, it would silently pick up the session of whatever the parent ran
  // before it — the same file behaving differently depending on who composed it. The boundary is where a
  // different file's history begins, so the cursor is cleared for the same reason
  // a parallel layer clears it. `context: 'shared'` is the individual opt-out for
  // an author who genuinely wants the parent's thread to continue into the block.
  const composedSessionStart =
    readComposedMeta(node)?.blockSessionStart === true && node.context !== 'shared';
  const isFreshSequential = isParallelLayer || node.context === 'fresh' || composedSessionStart;
  const cursor = ctx.lastSequentialSession;
  if (isFreshSequential || cursor === undefined) {
    return { resumeSessionId: undefined, resumeIntent: 'ordinary', named: false };
  }
  if (cursor.provider === provider) {
    return { resumeSessionId: cursor.sessionId, resumeIntent: 'ordinary', named: false };
  }
  getLog().info(
    { nodeId: node.id, provider, cursorProvider: cursor.provider },
    'dag.session_provider_boundary_fresh'
  );
  return { resumeSessionId: undefined, resumeIntent: 'ordinary', named: false };
}

function selectNamedSession(
  ctx: RunLayersContext,
  node: AgentNode,
  provider: string,
  sourceNodeId: string
): SessionSelection {
  const ownerCursor = ctx.bodySessionCursors?.get(node.id);
  const resumeIntent: SessionResumeIntent =
    ownerCursor !== undefined ? 'owner-continuation' : 'source-fork';
  const sourceHandle = ownerCursor ?? ctx.nodeSessionHandles?.get(sourceNodeId);
  if (sourceHandle === undefined) {
    throw new Error(
      `Node '${node.id}' cannot resume '${sourceNodeId}': the completed source has no available provider session.`
    );
  }
  if (sourceHandle.sessionId.trim() === '') {
    throw new Error(
      `Node '${node.id}' cannot resume '${sourceNodeId}': the completed source has no available provider session.`
    );
  }
  if (sourceHandle.provider !== provider) {
    throw new Error(
      `Node '${node.id}' cannot resume '${sourceNodeId}': source provider '${sourceHandle.provider}' does not match resolved provider '${provider}'.`
    );
  }
  const caps = requireProvider(ctx.deps.providers, provider).capabilities;
  if (!caps.sessionResume || (resumeIntent === 'source-fork' && caps.sessionFork !== true)) {
    throw new Error(
      `Node '${node.id}' cannot resume '${sourceNodeId}': resolved provider '${provider}' does not support immutable session forks.`
    );
  }
  return { resumeSessionId: sourceHandle.sessionId, resumeIntent, named: true };
}

/**
 * The persisted session this node continues from an earlier run in its scope, or
 * undefined when it has none to continue. A provider that cannot fork never continues
 * one: concurrent runs never share one provider conversation.
 */
async function persistedSessionToContinue(
  ctx: RunLayersContext,
  node: AgentNode,
  provider: string,
  persistScope: PersistScope,
  canFork: boolean
): Promise<string | undefined> {
  let persisted: WorkflowNodeSession | undefined;
  try {
    persisted = (await persistScope.sessionsAtStart).find(
      row => row.node_id === node.id && row.provider === provider
    );
  } catch (err) {
    await reportLookupFailed(ctx, node, provider, persistScope, err as Error);
    return undefined;
  }
  if (!persisted) return undefined;
  recordSessionEvent(ctx, node, canFork ? 'node_session_resumed' : 'node_session_not_continued', {
    provider,
    scope_key: persistScope.key,
    provider_session_id_preview: sessionPreview(persisted.provider_session_id),
  });
  if (canFork) return persisted.provider_session_id;
  await safeSendMessage(
    ctx.platform,
    ctx.conversationId,
    `⚠️ Node \`${node.id}\`: provider \`${provider}\` cannot fork a session, so this run started fresh instead of continuing the persisted session (concurrent runs never share one provider conversation). To carry context across runs, use a provider with sessionFork or pass state through artifacts.`,
    { workflowId: ctx.workflowRun.id, nodeName: node.id }
  );
  return undefined;
}

/**
 * Build the by-reference recovery suffix for a cold-resume warning (#1846): list
 * the typed artifacts that PRIOR invocations of this workflow+scope left in the
 * stable scope dir, as absolute file paths — never pasted content. Entries
 * produced by the current run are excluded (they can't recover anything the
 * fresh session doesn't already have). Returns `''` when there is nothing to
 * point at, or when the scope dir can't be read — recovery is best-effort and
 * must never turn a successful (if cold) node into a failure.
 */
async function buildColdResumeRecoveryPointer(
  scopeArtifactsDir: string,
  currentRunId: string,
  nodeId: string
): Promise<string> {
  try {
    const { artifactsByType, errors } = await readNodeArtifacts(scopeArtifactsDir, {
      scope: 'resolved-scope',
    });
    if (errors.length > 0) {
      getLog().warn(
        { errors, scopeArtifactsDir, nodeId },
        'dag.cold_resume_artifacts_partial_read'
      );
    }
    const priorArtifacts = Object.values(artifactsByType)
      .flat()
      .filter(entry => entry.runId !== currentRunId)
      .sort((a, b) => b.producedAt.localeCompare(a.producedAt));
    if (priorArtifacts.length === 0) return '';
    const lines = priorArtifacts.map(
      entry =>
        `- ${entry.outputType} (\`${entry.nodeId}\`): ${joinPath(scopeArtifactsDir, entry.path)}`
    );
    return `\nArtifacts from the previous invocation are available for recovery (read on demand):\n${lines.join('\n')}`;
  } catch (err) {
    getLog().warn(
      { err: err as Error, scopeArtifactsDir, nodeId },
      'dag.cold_resume_artifacts_read_failed'
    );
    return '';
  }
}
