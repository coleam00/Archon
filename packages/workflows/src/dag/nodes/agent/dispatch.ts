/**
 * Agent node dispatch: resolve the node's provider and model, choose the session it
 * continues, run it with retry, and carry its session forward for later nodes and runs.
 */
import { join as joinPath } from 'path';
import { requireProvider, sessionPreview } from '@archon/provider-contract';
import type { AgentNode } from '../../../schemas';
import {
  isNodeContextResume,
  nodeUsesPersistedScope,
  persistedSessionHandling,
} from '../../../schemas';
import { spellWorkflowCommand } from '../../../deps';
import { readNodeArtifacts, writeNodeArtifactsListing } from '../../../artifacts-index';
import { readComposedMeta } from '../../../compiled-command';
import { safeSendMessage } from '../../../executor-shared';
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
  const typedArtifactsFile = await writeNodeArtifactsListing(ctx.artifactsDir, ctx.workflowRun.id);
  const {
    provider,
    model: resolvedNodeModel,
    options: nodeOptions,
    tier: resolvedTier,
    effort: resolvedEffort,
  } = await resolveNodeProviderAndModel(ctx, node, {
    resolveAiText: aiConfigTextResolver(ctx, typedArtifactsFile),
    warnedProviderConflicts: ctx.warnedProviderConflicts,
  });

  const session = selectSession(ctx, node, provider, isParallelLayer);
  let resumeSessionId = session.resumeSessionId;

  // Strictly opt-in: on only when the node sets persist_session (or inherits the
  // workflow-level persist_sessions default) and doesn't opt out via context:'fresh'.
  // A parallel-layer node CAN still use persist_session — it just doesn't share
  // with siblings. Same predicate gates the scope-artifact mirror below.
  const usesPersistedScope = nodeUsesPersistedScope(node, ctx.workflowPersistSessions);

  if (usesPersistedScope) {
    const handling = persistedSessionHandling(
      requireProvider(ctx.deps.providers, provider).capabilities
    );
    if (handling === 'unsupported') {
      throw new Error(
        `Node '${node.id}' has persist_session: true but resolved provider '${provider}' does not support sessionResume. Remove persist_session, or use a provider with sessionResume capability.`
      );
    }
    const persistScope = ctx.persistScope;
    if (persistScope && !session.named) {
      resumeSessionId =
        (await persistedSessionToContinue(
          ctx,
          node,
          provider,
          persistScope,
          handling === 'fork'
        )) ?? resumeSessionId;
    }
  }

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
        const attemptTypedArtifactsFile = await writeNodeArtifactsListing(
          ctx.artifactsDir,
          ctx.workflowRun.id
        );
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
          attemptTypedArtifactsFile,
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
  // which session it did not continue.
  // context:'fresh' nodes are excluded (the author opted out of any cross-run memory).
  const persistScope = ctx.persistScope;
  if (
    usesPersistedScope &&
    persistScope &&
    output.state === 'completed' &&
    output.sessionId !== undefined
  ) {
    try {
      await ctx.deps.store.upsertWorkflowNodeSession({
        workflow_name: ctx.workflowName,
        node_id: node.id,
        scope_key: persistScope.key,
        provider,
        provider_session_id: output.sessionId,
        last_run_id: ctx.workflowRun.id,
      });
    } catch (err) {
      // Non-fatal: persistence failure does not undo a successful node execution.
      // But the user opted into persistence — the next run will not continue this
      // session, so warn them as well as the logs.
      getLog().warn(
        {
          err: err as Error,
          nodeId: node.id,
          workflow: ctx.workflowName,
          scopeKey: persistScope.key,
          provider,
        },
        'persist_session_upsert_failed'
      );
      await safeSendMessage(
        ctx.platform,
        ctx.conversationId,
        `⚠️ Could not persist the session for node \`${node.id}\` (${provider}). The next run will not continue from it.`,
        { workflowId: ctx.workflowRun.id, nodeName: node.id }
      );
    }
  }

  return { nodeId: node.id, output, sessionProvider: provider };
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
    const sourceNodeId = node.context.resume;
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

  // Legacy scalar/default selection — parallel or context:fresh → always fresh.
  // Parallel layers always get fresh sessions; explicit 'fresh' context also forces it.
  // 'shared' forces continuation. Default: fresh for parallel, inherited for sequential.
  // isFreshSequential controls in-run threading (lastSequentialSession).
  // Cross-provider guard (#1992): a session id can only be resumed by the provider
  // that created it, so the cursor is threaded only into nodes that resolve to the
  // SAME provider — on a provider change the node starts fresh instead of failing
  // (Claude) or silently cold-falling-back (Codex) on a foreign session id.
  //
  // A composed workflow's ENTRY node is the third fresh case (#1764). Standalone,
  // that node runs first and has no cursor to inherit; composed, it would silently
  // pick up the session of whatever the parent ran before it — the same file
  // behaving differently depending on who composed it. The boundary is where a
  // different file's history begins, so the cursor is cleared for the same reason
  // a parallel layer clears it. `context: 'shared'` is the individual opt-out for
  // an author who genuinely wants the parent's thread to continue into the block.
  const composedBlockEntry =
    readComposedMeta(node)?.blockEntry === true && node.context !== 'shared';
  const isFreshSequential = isParallelLayer || node.context === 'fresh' || composedBlockEntry;
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
  try {
    const persisted = (await persistScope.sessionsAtStart).find(
      row => row.node_id === node.id && row.provider === provider
    );
    if (!persisted) return undefined;
    // This event is not a node record, so it carries only the preview.
    const sessionIdPreview = sessionPreview(persisted.provider_session_id);
    ctx.deps.store
      .createWorkflowEvent({
        workflow_run_id: ctx.workflowRun.id,
        event_type: canFork ? 'node_session_resumed' : 'node_session_not_continued',
        step_name: ctx.stepNamePrefix + node.id,
        data: {
          provider,
          scope_key: persistScope.key,
          provider_session_id_preview: sessionIdPreview,
        },
      })
      .catch((err: Error) => {
        getLog().warn({ err, nodeId: node.id }, 'persist_session_event_persist_failed');
      });
    if (canFork) return persisted.provider_session_id;
    await safeSendMessage(
      ctx.platform,
      ctx.conversationId,
      `⚠️ Node \`${node.id}\`: provider \`${provider}\` cannot fork a session, so this run started fresh instead of continuing the persisted session (concurrent runs never share one provider conversation). To carry context across runs, use a provider with sessionFork or pass state through artifacts.`,
      { workflowId: ctx.workflowRun.id, nodeName: node.id }
    );
    return undefined;
  } catch (err) {
    // Non-fatal: the node still runs (fresh, no resume), but the user opted
    // into persistence — a DB error here silently breaks continuity, so warn
    // them as well as the logs. (A "no row" result is not an error: it finds
    // nothing above and this catch never fires for it.)
    getLog().warn(
      {
        err: err as Error,
        nodeId: node.id,
        workflow: ctx.workflowName,
        scopeKey: persistScope.key,
        provider,
      },
      'persist_session_lookup_failed'
    );
    await safeSendMessage(
      ctx.platform,
      ctx.conversationId,
      `⚠️ Could not load the persisted session for node \`${node.id}\` — it will run without prior context. Session continuity may be broken; if this recurs, check server logs or run \`${spellWorkflowCommand(ctx.platform, `reset-sessions ${ctx.workflowName}`)}\`.`,
      { workflowId: ctx.workflowRun.id, nodeName: node.id }
    );
    return undefined;
  }
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
