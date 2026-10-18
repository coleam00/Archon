import { DEFAULT_TOOL_CALL_ATTENTION_MS } from '../../../schemas/run-config';
import { requireProvider } from '@archon/provider-contract';
import { finishNodeExecution } from '../../../node-execution';
import { type NodeExecutionResult } from '../../../node-record-serialization';
import { type NodeExecutionRecord, type NodeFailureKind } from '../../../schemas/node-execution';
import { recordNodeState } from '../../../node-event-write';
import { isSourceReadFailure } from '../../../workflow-source';
import type { SendQueryOptions, TokenUsage, ResolvedModel } from '@archon/provider-contract';
import { sessionPreview, type ProviderFailure } from '@archon/provider-contract';
import { validateStructuredOutput } from '../../../structured-output';
import type { AgentNode, EffortLevel } from '../../../schemas';
import { isNodeContextResume } from '../../../schemas';
import { createAttemptEventSequence, createProviderEventHandler } from '../../../provider-events';
import { declaredOutputPathsFromSchema, canonicalValueText } from '../../../output-ref';
import {
  readComposedBindings,
  readHomeMcpDirectory,
  resolveIncludeOutputAliases,
} from '../../../compiled-command';
import { createWatchdogResetRecorder } from '../../../logger';
import { withIdleTimeout, STEP_IDLE_TIMEOUT_MS } from '../../../utils/idle-timeout';
import {
  buildPromptWithContext,
  safeSendMessage,
  type SendMessageContext,
} from '../../../executor-shared';
import { type TierName } from '../../../model-validation';
import { getLog } from '../../log';
import { sumTokenUsage } from '../../usage';
import {
  assertNodeSourceReadable,
  loadNodeCommandPrompt,
  RunSourceUnreadableError,
} from '../../node-source';
import {
  aiNodeEnvironment,
  beginExecution,
  observeNodeCheckout,
  type RunLayersContext,
  type SessionCheckpoint,
  type SessionResumeIntent,
} from '../../run-context';
import {
  substituteLoopBodyText,
  resolveRunInputs,
  resolveNodeBindings,
  nodeTemplateReferences,
} from '../../references';
import { rejectedArtifactPointer } from '../../node-output';
import {
  shouldContinueStreamingForStatus,
  lastNodeCancelCheck,
  lastNodeActivityUpdate,
  CANCEL_CHECK_INTERVAL_MS,
  ACTIVITY_HEARTBEAT_INTERVAL_MS,
} from '../../run-control';
import { isInsideAny } from '../../checkout-guard';
import { resolveNodeMcp } from '../../provider-resolution';
import {
  type WatchdogReset,
  formatWatchdogResetDiagnostic,
  STRUCTURED_OUTPUT_MAX_REASKS,
  structuredOutputPass,
  unsettledTurnError,
  NodeFailure,
  providerReportedFailure,
} from '../../ai-turn';

export async function executeAgentNode(
  ctx: RunLayersContext,
  node: AgentNode,
  reserveBudget: () => Promise<void>,
  provider: string,
  nodeOptions: SendQueryOptions | undefined,
  resumeSessionId: string | undefined,
  resolvedModel?: string,
  resolvedTier?: TierName,
  resolvedEffort?: EffortLevel,
  stepNamePrefix = '',
  iteration?: number,
  checkpointSession?: SessionCheckpoint,
  typedArtifactsFile?: string,
  resumeIntent: SessionResumeIntent = 'ordinary',
  /** `$REJECTION_REASON` for an approval gate's rework prompt; undefined elsewhere. */
  rejectionReason?: string
): Promise<NodeExecutionResult> {
  const {
    deps,
    platform,
    conversationId,
    cwd,
    workflowRun,
    artifactsDir,
    stateDir,
    logDir,
    baseBranch,
    docsDir,
    issueContext,
    workflowSourceRoots,
  } = ctx;
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Command file name when this agent node is command-sourced, undefined for an
  // inline prompt — replaces the old `node.command` field access throughout.
  const commandName =
    node.source.kind === 'command'
      ? substituteLoopBodyText(node.source.name, ctx.loopBodyScopes)
      : undefined;
  // Include expansion compiles a command body into an inline prompt and moves the node's
  // `with:` map to the engine-private payload, so a composed node binds exactly as the
  // same node does standalone (#2964).
  const nodeWith = node.source.kind === 'command' ? node.source.with : readComposedBindings(node);
  // Persisted step_name is namespaced ('<groupId>.' prefix) for loop_group bodies;
  // '' for the top-level DAG → identical to node.id. The in-process emitter payloads
  // below stay raw (node.id) — live SSE/CLI consumers key off those. See #2090.
  const stepName = stepNamePrefix + node.id;
  // Only present inside a loop_group body — tags lifecycle rows with the iteration so
  // multi-iteration runs are disaggregatable in the event log.
  const namedResumeSourceNodeId = isNodeContextResume(node.context)
    ? node.context.resume
    : undefined;
  const commandPrompt =
    commandName === undefined ? undefined : await loadNodeCommandPrompt(ctx, commandName, stepName);
  const homeMcpDirectory = readHomeMcpDirectory(node);
  const verifiedMcpFiles =
    homeMcpDirectory !== undefined
      ? await assertNodeSourceReadable(workflowSourceRoots, stepName)
      : undefined;
  const capabilities = requireProvider(deps.providers, provider).capabilities;
  const nodeMcp = await resolveNodeMcp(
    node.mcp,
    capabilities,
    cwd,
    homeMcpDirectory,
    verifiedMcpFiles
  );
  if (nodeMcp.kind === 'read_error') {
    const sourceRoot =
      workflowSourceRoots.kind === 'captured'
        ? workflowSourceRoots.anchor.root
        : workflowSourceRoots.globalWorkflows;
    if (
      homeMcpDirectory !== undefined &&
      isInsideAny(nodeMcp.path, [sourceRoot]) &&
      isSourceReadFailure(nodeMcp.error, verifiedMcpFiles)
    ) {
      throw new RunSourceUnreadableError(stepName, nodeMcp.error);
    }
    throw nodeMcp.error;
  }
  await reserveBudget();
  const aiClient = deps.getAgentProvider(provider);
  const execution: NodeExecutionRecord = {
    ...beginExecution(ctx, node, {
      provider,
      model: resolvedModel,
      tier: resolvedTier,
      effort: resolvedEffort,
      sessionId: resumeSessionId,
      capabilities,
      checkoutStart: await observeNodeCheckout(ctx),
    }),
    diagnostics: {
      ...(iteration !== undefined ? { iteration } : {}),
      ...(namedResumeSourceNodeId !== undefined
        ? {
            sessionSourceNodeId: namedResumeSourceNodeId,
            sessionForkRequested: resumeIntent !== 'owner-continuation',
          }
        : {}),
      ...(nodeMcp.kind === 'unavailable' ? { mcpUnavailable: nodeMcp.record } : {}),
    },
  };
  getLog().info({ nodeId: node.id, provider }, 'dag_node_started');
  await recordNodeState({ store: deps.store, logDir }, execution);
  if (nodeMcp.kind === 'unavailable') {
    const { record, fullPath } = nodeMcp;
    getLog().warn(
      { nodeId: node.id, path: record.path, fullPath, reason: record.reason },
      'dag.mcp_optional_unavailable'
    );
    const why =
      record.reason === 'provider_unsupported'
        ? `provider '${provider}' cannot load MCP servers`
        : (nodeMcp.diagnostic ?? `config file not found at ${fullPath}`);
    await safeSendMessage(
      platform,
      conversationId,
      `Node '${node.id}' runs without its optional MCP servers (${record.path}): ${why}.`,
      nodeContext
    );
  }
  // Every stream pass of this attempt (a structured-output reask is a second pass)
  // numbers its provider events from one sequence.
  const attemptEvents = createAttemptEventSequence(execution.attempt.id);

  let nodeTokens: TokenUsage | undefined;
  let nodeTokensUnknown = false;
  let nodeCostUsd: number | undefined;
  // Attempt-wide: some stream pass ended without a result, or a result without a
  // finite cost, so `nodeCostUsd` is at most a floor of what the attempt spent.
  let costReportMissing = false;
  let passSawResult = false;
  let nodeStopReason: string | undefined;
  let nodeNumTurns: number | undefined;
  let nodeResolvedModel: ResolvedModel | undefined;
  // Declared before `failAgentNode`, which records it and can run before the stream starts.
  let newSessionId: string | undefined;
  const nodeKey = `${workflowRun.id}:${node.id}`;

  const failAgentNode = async (
    error: string,
    failureKind: NodeFailureKind,
    extras: { output?: string; providerFailure?: ProviderFailure; providerNotCalled?: boolean } = {}
  ): Promise<NodeExecutionResult> => {
    const result = await recordNodeState(
      { store: deps.store, logDir },
      finishNodeExecution(
        execution,
        {
          status: 'failed',
          error,
          failureKind,
          ...(extras.providerFailure !== undefined
            ? { providerFailure: extras.providerFailure }
            : {}),
        },
        {
          output: { text: extras.output ?? '' },
          tokens: nodeTokens,
          tokensUnknown: nodeTokensUnknown,
          costUsd: nodeCostUsd,
          costPartial: costReportMissing,
          stopReason: nodeStopReason,
          numTurns: nodeNumTurns,
          resolvedModel: nodeResolvedModel?.id,
          sessionId: newSessionId,
          providerNotCalled: extras.providerNotCalled,
        }
      )
    );
    lastNodeCancelCheck.delete(nodeKey);
    lastNodeActivityUpdate.delete(nodeKey);
    return result;
  };
  // The provider is bound but was never called, so the attempt records no spend rather
  // than unreported spend that would refuse a spend-limited run.
  const failBeforeProviderCall = (error: string): Promise<NodeExecutionResult> =>
    failAgentNode(error, 'config', { providerNotCalled: true });

  // Load prompt
  let rawPrompt: string;
  if (commandName !== undefined) {
    const promptResult = commandPrompt;
    if (promptResult === undefined) throw new Error(`Missing prepared command for '${stepName}'`);
    if (!promptResult.success) {
      const errMsg = promptResult.message;
      getLog().error({ nodeId: node.id, error: errMsg }, 'dag_node_command_load_failed');
      return failBeforeProviderCall(errMsg);
    }
    rawPrompt = resolveIncludeOutputAliases(node, promptResult.content);
  } else {
    // commandName undefined implies node.source.kind === 'inline' by construction
    // (AgentBody.source is a two-member union) — but the compiler can't correlate
    // that back across the two independent derivations, so fail loud rather than
    // silently defaulting if that ever stops being true.
    if (node.source.kind !== 'inline') {
      throw new Error(
        `unreachable: node '${node.id}' has no commandName but source.kind is not 'inline'`
      );
    }
    rawPrompt = node.source.prompt;
  }

  let finalPrompt: string;
  try {
    // Node-local bindings (#2637): a command node's `with:` map resolves against
    // upstream outputs and merges OVER the run's inputs into the `$INPUTS` bag —
    // nearest-wins, the same precedence the shell env channel documents. A binding
    // that cannot be satisfied throws here and fails the node via the catch below.
    const runInputs = resolveRunInputs(workflowRun);
    const nodeBindings =
      nodeWith !== undefined ? resolveNodeBindings(node.id, nodeWith, ctx, runInputs) : undefined;
    const promptInputs =
      nodeBindings !== undefined ? { ...(runInputs ?? {}), ...nodeBindings } : runInputs;
    // An inline prompt and a command file loaded only now resolve alike: variables,
    // enclosing loop_group scopes and upstream outputs in one pass.
    finalPrompt = buildPromptWithContext(
      rawPrompt,
      workflowRun.id,
      workflowRun.user_message,
      artifactsDir,
      baseBranch,
      docsDir,
      issueContext,
      `dag node '${node.id}' prompt`,
      {
        stateDir,
        inputs: promptInputs,
        typedArtifactsFile,
        rejectionReason,
        references: nodeTemplateReferences(rawPrompt, ctx),
      }
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ nodeId: node.id, error: err.message }, 'dag.node_prompt_substitution_failed');
    const result = await failBeforeProviderCall(err.message);
    await safeSendMessage(
      platform,
      conversationId,
      `Node '${node.id}' failed: ${err.message}`,
      nodeContext
    );
    return result;
  }

  const streamingMode = platform.getStreamingMode();

  let nodeOutputText = ''; // Always accumulate regardless of streaming mode
  let structuredOutput: unknown;
  let nodeResumed: boolean | undefined;
  const batchMessages: string[] = [];

  // Create per-node abort controller for idle timeout cleanup
  const nodeAbortController = new AbortController();
  const shouldForkSession = resumeSessionId !== undefined && resumeIntent !== 'owner-continuation';
  const nodeOptionsWithAbort: SendQueryOptions | undefined = {
    ...nodeOptions,
    env: { ...nodeOptions?.env, ...aiNodeEnvironment(ctx, execution) },
    ...(nodeMcp.kind === 'load' || nodeMcp.kind === 'missing'
      ? { nodeConfig: { ...nodeOptions?.nodeConfig, mcp: nodeMcp.path } }
      : {}),
    abortSignal: nodeAbortController.signal,
    ...(resumeIntent === 'owner-continuation'
      ? { forkSession: false }
      : shouldForkSession
        ? { forkSession: true }
        : {}),
  };
  let nodeIdleTimedOut = false;
  let lastWatchdogReset: WatchdogReset | undefined;
  let watchdogResets = createWatchdogResetRecorder(logDir, workflowRun.id, node.id);
  const effectiveIdleTimeout = node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS;
  // Task ids still live when the stream ended abnormally (idle timeout /
  // subprocess death) — recorded on the node_completed event so an incomplete
  // node never masquerades as a clean success (#2083).
  let backgroundTasksIncomplete: string[] = [];
  // Whether the last stream pass ended on the provider's `settled`. Output without it
  // means the turn was cut off, not finished.
  let streamSettled = false;

  // Best-effort providers (Pi/Copilot) get a bounded validate-and-reask loop: on a
  // structured-output validation miss, re-run the stream with the schema errors
  // appended. Enforced providers and non-output_format nodes get 0 reasks.
  const maxReasks =
    capabilities.structuredOutput === 'best-effort' && nodeOptions?.outputFormat
      ? STRUCTURED_OUTPUT_MAX_REASKS
      : 0;
  let accumulatedCostUsd: number | undefined;
  let accumulatedTokens: TokenUsage | undefined;

  // One sendQuery stream pass. Resets the per-attempt accumulators it mutates
  // (output text, structured output, the batched-message buffer, per-pass cost,
  // idle-timeout flag) so a prior reask attempt's state never leaks into this one,
  // then streams. Throws on SDK error / budget cap (propagates to the outer catch
  // — those failures are never reasked).
  const runStreamPass = async (
    attemptPrompt: string,
    pass: ReturnType<typeof structuredOutputPass>
  ): Promise<void> => {
    nodeOutputText = '';
    structuredOutput = undefined;
    if (pass.threadsSession) {
      newSessionId = undefined;
      nodeResumed = undefined;
    }
    batchMessages.length = 0; // else a failed attempt's prose flushes during reask
    nodeCostUsd = undefined;
    passSawResult = false;
    nodeTokens = undefined;
    nodeIdleTimedOut = false;
    streamSettled = false;
    lastWatchdogReset = undefined;
    watchdogResets = createWatchdogResetRecorder(logDir, workflowRun.id, node.id);
    backgroundTasksIncomplete = [];
    const providerEvents = createProviderEventHandler({
      toolAttention: ctx.toolAttention.createStream({
        nodeId: stepName,
        reportedBackgroundWork: capabilities.backgroundWork === 'reported',
        provider: provider,
        thresholdMs: ctx.config.workflows?.toolCallAttentionMs ?? DEFAULT_TOOL_CALL_ATTENTION_MS,
        env: {
          ...(ctx.execContext.kind === 'host' ? process.env : {}),
          ...nodeOptionsWithAbort.env,
        },
        protectedEnvKeys: ctx.config.protectedEnvKeys,
        protectedCredentialValues: ctx.config.protectedCredentialValues,
      }),
      store: deps.store,
      platform,
      conversationId,
      messageContext: nodeContext,
      logDir,
      runId: workflowRun.id,
      nodeId: node.id,
      stepName,
      attempt: attemptEvents,
      configuredMcpServers: nodeMcp.kind === 'load' ? nodeMcp.servers : new Set(),
      onMessageText: async text => {
        nodeOutputText += text; // ALWAYS capture for $node_id.output
        if (streamingMode === 'stream') {
          await safeSendMessage(platform, conversationId, text, nodeContext);
        } else {
          batchMessages.push(text);
        }
      },
      // A warning goes out at once (a Pi extension's review URL must reach the user
      // before the node blocks), so the batched reply before it goes out first. A
      // structured-output node is left alone: its batch is replaced by the parsed output.
      beforeWarning: async () => {
        if (batchMessages.length === 0 || nodeOptions?.outputFormat) return;
        await safeSendMessage(platform, conversationId, batchMessages.join('\n\n'), nodeContext);
        batchMessages.length = 0;
      },
    });
    const shouldStopStream = async (): Promise<boolean> => {
      await ctx.toolAttention.refresh();
      await providerEvents.refreshAttention();
      const tickNow = Date.now();
      if (tickNow - (lastNodeCancelCheck.get(nodeKey) ?? 0) > CANCEL_CHECK_INTERVAL_MS) {
        lastNodeCancelCheck.set(nodeKey, tickNow);
        try {
          const streamStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
          if (!shouldContinueStreamingForStatus(streamStatus)) {
            getLog().info(
              { workflowRunId: workflowRun.id, nodeId: node.id, status: streamStatus ?? 'deleted' },
              'dag.stop_detected_during_streaming'
            );
            nodeAbortController.abort();
            return true;
          }
        } catch (cancelCheckErr) {
          getLog().warn(
            { err: cancelCheckErr as Error, workflowRunId: workflowRun.id, nodeId: node.id },
            'dag.status_check_failed'
          );
        }
      }

      return false;
    };
    try {
      for await (const msg of withIdleTimeout(
        aiClient.sendQuery(attemptPrompt, cwd, pass.resumeSessionId, nodeOptionsWithAbort),
        effectiveIdleTimeout,
        () => {
          nodeIdleTimedOut = true;
          getLog().warn(
            {
              nodeId: node.id,
              timeoutMs: effectiveIdleTimeout,
              ...(lastWatchdogReset
                ? {
                    lastResetType: lastWatchdogReset.type,
                    lastResetAt: new Date(lastWatchdogReset.at).toISOString(),
                  }
                : {}),
            },
            'dag_node_idle_timeout_reached'
          );
          nodeAbortController.abort();
        },
        (msg, resetAt) => {
          const type = msg.type;
          lastWatchdogReset = { type, at: resetAt };
          watchdogResets.observe(type, resetAt);
        },
        () =>
          providerEvents.hasOpenTools() ||
          (capabilities.backgroundWork === 'reported' &&
            providerEvents.liveSubtaskIds().length > 0),
        shouldStopStream
      )) {
        const tickNow = Date.now();

        if (await shouldStopStream()) break;

        // Activity heartbeat — write, throttled to every 60s (only for stale/zombie detection)
        if (tickNow - (lastNodeActivityUpdate.get(nodeKey) ?? 0) > ACTIVITY_HEARTBEAT_INTERVAL_MS) {
          lastNodeActivityUpdate.set(nodeKey, tickNow);
          try {
            await deps.store.updateWorkflowActivity(workflowRun.id);
          } catch (e) {
            getLog().warn(
              { err: e as Error, workflowRunId: workflowRun.id },
              'dag.activity_update_failed'
            );
          }
        }

        if (msg.type === 'result') {
          if (pass.threadsSession) {
            newSessionId = msg.sessionId;
            if (msg.resumed !== undefined) nodeResumed = msg.resumed;
          }
          nodeTokensUnknown ||= msg.tokensUnknown === true;
          if (nodeTokensUnknown) {
            nodeTokens = undefined;
          } else if (msg.tokens !== undefined) {
            nodeTokens = sumTokenUsage([...(nodeTokens ? [nodeTokens] : []), msg.tokens], {
              nodeId: node.id,
            });
          }
          passSawResult = true;
          if (msg.cost === undefined || !Number.isFinite(msg.cost)) costReportMissing = true;
          if (msg.cost !== undefined) {
            if (Number.isFinite(msg.cost)) {
              nodeCostUsd = (nodeCostUsd ?? 0) + msg.cost;
            } else {
              getLog().warn(
                { nodeId: node.id, costUsd: msg.cost },
                'dag_node.usage_cost_non_finite_ignored'
              );
            }
          }
          if (msg.stopReason !== undefined) nodeStopReason = msg.stopReason;
          if (msg.numTurns !== undefined) nodeNumTurns = msg.numTurns;
          // Assigned UNCONDITIONALLY. A guarded assignment cannot CLEAR a stale value:
          // Pi/Copilot reask loops yield several result chunks, and Pi omits resolvedModel
          // when its later assistant message has no responseModel — so an earlier attempt's
          // model would be persisted as the final attempt's answer. Fabricated attribution
          // is the exact defect #2314 exists to prevent; absence must stay absence.
          nodeResolvedModel = msg.resolvedModel;
          if (msg.text !== undefined) {
            nodeOutputText = msg.text;
            batchMessages.splice(0, batchMessages.length, msg.text);
          }
          structuredOutput = msg.structuredOutput;
          if (msg.failure !== undefined) {
            throw providerReportedFailure(
              `Node '${node.id}'`,
              msg.failure,
              nodeOptions?.maxBudgetUsd,
              {
                nodeId: node.id,
                durationMs: Date.now() - nodeStartTime,
              }
            );
          }
          // Fail loudly on any other SDK error result. Previously we broke out of
          // the stream silently, producing empty/partial output without signaling
          // failure — which let failed iterations masquerade as successes.
          // Exception: errorSubtype === 'success' is the Claude SDK's marker for a
          // clean stop_sequence termination. The Claude provider already filters
          // this out, but the guard here keeps a third-party IAgentProvider that
          // forwards the SDK pair raw from producing a "SDK returned success"
          // false failure.
          if (msg.isError && msg.errorSubtype !== 'success') {
            const subtype = msg.errorSubtype ?? 'unknown';
            const errorsDetail = msg.errors?.length ? ` — ${msg.errors.join('; ')}` : '';
            getLog().error(
              {
                nodeId: node.id,
                errorSubtype: subtype,
                errors: msg.errors,
                ...(msg.sessionId ? { sessionIdPreview: sessionPreview(msg.sessionId) } : {}),
                stopReason: msg.stopReason,
                durationMs: Date.now() - nodeStartTime,
              },
              'dag.node_sdk_error_result'
            );
            throw new Error(`Node '${node.id}' failed: SDK returned ${subtype}${errorsDetail}`);
          }
        } else if (msg.type === 'settled') {
          streamSettled =
            capabilities.backgroundWork !== 'reported' ||
            providerEvents.liveSubtaskIds().length === 0;
          break;
        } else {
          await providerEvents.handle(msg);
        }
      }
    } finally {
      await providerEvents.clearAttention();
    }

    // Stream ended with subtasks still live: the SDK subprocess died or the idle
    // timeout fired mid-wait, so the tasks' artifacts may be missing (#2083).
    // Record them for the audit trail. The operator hears about it once, from the
    // node's failure: a stream that produced output and never settled fails the node
    // and names these tasks (see unsettledTurnError).
    if (providerEvents.liveSubtaskIds().length > 0) {
      backgroundTasksIncomplete = providerEvents.liveSubtaskIds();
      getLog().warn(
        {
          nodeId: node.id,
          taskIds: backgroundTasksIncomplete,
          idleTimedOut: nodeIdleTimedOut,
          cancelled: nodeAbortController.signal.aborted && !nodeIdleTimedOut,
        },
        'dag.node_stream_ended_with_live_background_tasks'
      );
    }
  };

  // Build a reask prompt: the original prompt + a correction block listing the
  // schema errors. The provider still augments with the JSON schema itself
  // (best-effort providers add their own JSON-only instruction), so this only
  // appends the per-attempt feedback.
  const buildReaskPrompt = (errors: string[]): string =>
    `${finalPrompt}\n\n--- CORRECTION ---\n` +
    `Your previous response did not satisfy the required JSON schema: ${errors.join('; ')}. ` +
    'Respond again with ONLY a JSON object matching the schema — no prose, no code fences.';

  // Observability: log every reask; notify the user once (first reask) so a
  // best-effort provider being auto-corrected isn't invisible.
  const emitReask = async (attempt: number): Promise<void> => {
    getLog().warn(
      { nodeId: node.id, workflowRunId: workflowRun.id, attempt, maxReasks },
      'dag.structured_output_reask'
    );
    if (attempt === 1) {
      await safeSendMessage(
        platform,
        conversationId,
        `⚠️ Node \`${node.id}\`: structured output didn't match the schema — asking the model to correct it (up to ${maxReasks} attempt(s)).`,
        nodeContext
      );
    }
  };

  const runWorkload = async (): Promise<
    | (NodeExecutionResult & { state: 'completed' })
    | { state: 'failed'; output: string; error: string; failureKind: NodeFailureKind }
  > => {
    // Validate-and-reask loop. Enforced / non-output_format nodes run exactly once
    // (maxReasks = 0). A best-effort node whose structured output is missing or
    // schema-invalid is re-run with the errors appended, up to maxReasks times;
    // exhaustion (or a non-best-effort failure) throws → failed node.
    let reaskAttempt = 0;
    let reaskPrompt = finalPrompt;
    // Set up the next reask attempt (increment, augment the prompt, notify).
    const scheduleReask = async (errors: string[]): Promise<void> => {
      reaskAttempt++;
      reaskPrompt = buildReaskPrompt(errors);
      await emitReask(reaskAttempt);
    };
    while (true) {
      try {
        await runStreamPass(
          reaskPrompt,
          structuredOutputPass(reaskAttempt, resumeSessionId, resumeIntent === 'source-fork')
        );
      } finally {
        await watchdogResets.flush();
        if (!passSawResult) costReportMissing = true;
        if (nodeCostUsd !== undefined) {
          accumulatedCostUsd = (accumulatedCostUsd ?? 0) + nodeCostUsd;
        }
        if (nodeTokensUnknown) {
          accumulatedTokens = undefined;
        } else if (nodeTokens !== undefined) {
          accumulatedTokens = sumTokenUsage(
            [...(accumulatedTokens !== undefined ? [accumulatedTokens] : []), nodeTokens],
            { nodeId: node.id }
          );
        }
        // Keep cumulative usage on the node result even when this pass throws.
        nodeCostUsd = accumulatedCostUsd;
        nodeTokens = accumulatedTokens;
      }

      // When output_format is set and the provider returned structured_output, use
      // it instead of the concatenated assistant text. Each provider normalizes its
      // own structured output onto the result chunk — no provider branching here.
      if (!nodeOptions?.outputFormat) break;

      // Don't reask after an idle-timeout/abort — those are genuine failures, not
      // validation misses; they fall through to a cause-specific throw below.
      const canReask =
        reaskAttempt < maxReasks && !nodeIdleTimedOut && !nodeAbortController.signal.aborted;

      if (structuredOutput !== undefined) {
        // Validate against the declared schema for EVERY provider — SDK-enforced
        // ones still bypass grammar-constrained decoding on a refusal / max_tokens
        // truncation. An uncompilable schema FAILS the node (#2453): the loader
        // compiles every declared `output_format`, so reaching this branch means a
        // definition bypassed the loader — continuing would let a declared contract
        // cross the boundary unenforced, after the turn was already paid for.
        let schemaCompileError: string | undefined;
        const validation = validateStructuredOutput(
          structuredOutput,
          node.output_format ?? {},
          compileMsg => {
            schemaCompileError = compileMsg;
          }
        );
        if (schemaCompileError !== undefined) {
          getLog().warn(
            { nodeId: node.id, workflowRunId: workflowRun.id, compileMsg: schemaCompileError },
            'dag.structured_output_schema_uncompilable'
          );
          throw new NodeFailure(
            'config',
            `Node '${node.id}': its output_format schema cannot be compiled (${schemaCompileError}), so its declared contract cannot be enforced. Fix the schema.`
          );
        }
        if (validation.valid) {
          try {
            nodeOutputText = canonicalValueText(structuredOutput);
          } catch (serializeErr) {
            const err = serializeErr as Error;
            throw new NodeFailure(
              'output_contract',
              `Node '${node.id}': failed to serialize structured_output to JSON: ${err.message}`
            );
          }
          getLog().debug({ nodeId: node.id, streamingMode }, 'dag.structured_output_override');
          break;
        }
        // Invalid payload.
        getLog().warn(
          { nodeId: node.id, workflowRunId: workflowRun.id, errors: validation.errors },
          'dag.structured_output_invalid'
        );
        if (canReask) {
          await scheduleReask(validation.errors);
          continue;
        }
        throw new NodeFailure(
          'output_contract',
          `Node '${node.id}': output_format declared but the provider's structured output failed schema validation: ${validation.errors.join('; ')}`
        );
      }

      // No structured output at all (prose / refusal / parse miss / timeout).
      getLog().warn(
        { nodeId: node.id, workflowRunId: workflowRun.id },
        'dag.structured_output_missing'
      );
      if (canReask) {
        await scheduleReask(['no JSON object was found in the response']);
        continue;
      }
      // Surface the real cause: a timeout/abort produces no structured output too,
      // and reporting it as "the model replied with prose" would mislead.
      if (nodeIdleTimedOut) {
        throw new NodeFailure(
          'timeout',
          `Node '${node.id}': timed out (no output for ${String(effectiveIdleTimeout / 60000)} min) before producing the required structured output.${formatWatchdogResetDiagnostic(lastWatchdogReset)}`
        );
      }
      throw new NodeFailure(
        'output_contract',
        `Node '${node.id}': output_format declared but the provider returned no schema-valid structured output. ` +
          'The model likely replied with prose, refused, or emitted unparseable JSON.'
      );
    }

    // Every provider ends a turn with `settled`. Output without it means the stream was
    // cut off (idle timeout, a provider that died or broke the contract), so the node
    // fails rather than completing on a turn that may not be done. Zero output falls
    // through to the empty-output guard below; cancellation is handled just after.
    const cancelledMidStream = nodeAbortController.signal.aborted && !nodeIdleTimedOut;
    if (
      !streamSettled &&
      !cancelledMidStream &&
      (nodeOutputText.trim() !== '' || structuredOutput !== undefined)
    ) {
      throw new NodeFailure(
        nodeIdleTimedOut ? 'timeout' : 'unknown',
        `Node '${node.id}' failed: ${unsettledTurnError(
          nodeIdleTimedOut ? effectiveIdleTimeout : undefined,
          lastWatchdogReset,
          backgroundTasksIncomplete
        )}`
      );
    }

    // If cancelled during streaming (not idle timeout), return as failed with cancel reason
    if (nodeAbortController.signal.aborted && !nodeIdleTimedOut) {
      const duration = Date.now() - nodeStartTime;
      getLog().info(
        { nodeId: node.id, durationMs: duration },
        'dag_node_cancelled_during_streaming'
      );
      return {
        state: 'failed',
        output: nodeOutputText,
        error: 'Cancelled by user',
        failureKind: 'cancelled',
      };
    }

    if (streamingMode === 'batch' && batchMessages.length > 0) {
      const batchContent =
        structuredOutput !== undefined && nodeOptions?.outputFormat
          ? nodeOutputText
          : batchMessages.join('\n\n');
      await safeSendMessage(platform, conversationId, batchContent, nodeContext);
    }

    // Fail for zero output: covers both silent non-timeout exits AND idle-timeout before first token (time-to-first-token exceeded the window).
    if (nodeOutputText.trim() === '' && structuredOutput === undefined) {
      const duration = Date.now() - nodeStartTime;
      const emptyError = nodeIdleTimedOut
        ? `Node '${node.id}' timed out with no output (idle for ${String(effectiveIdleTimeout / 60000)} min).${formatWatchdogResetDiagnostic(lastWatchdogReset)} Consider increasing idle_timeout or reducing prompt size.`
        : `Node '${node.id}' produced no assistant output. The provider stream closed without yielding content — likely a silent provider rejection or stream interruption.`;
      getLog().error({ nodeId: node.id, durationMs: duration }, 'dag.node_empty_output');
      return {
        state: 'failed',
        output: '',
        error: emptyError,
        failureKind: nodeIdleTimedOut ? 'timeout' : 'transient',
      };
    }

    if (namedResumeSourceNodeId !== undefined) {
      if (nodeResumed !== true) {
        throw new Error(
          `Node '${node.id}' could not resume the exact session from '${namedResumeSourceNodeId}'. The provider reported that prior context was not restored.`
        );
      }
      if (newSessionId === undefined || newSessionId.trim() === '') {
        throw new Error(
          `Node '${node.id}' resumed '${namedResumeSourceNodeId}' but the provider returned no branch session ID.`
        );
      }
      if (resumeIntent === 'owner-continuation' && newSessionId !== resumeSessionId) {
        throw new Error(
          `Node '${node.id}' did not continue its private owner session: the provider replaced the session ID.`
        );
      }
      if (resumeIntent !== 'owner-continuation' && newSessionId === resumeSessionId) {
        throw new Error(
          `Node '${node.id}' did not create an immutable fork of '${namedResumeSourceNodeId}': the provider reused the source session ID.`
        );
      }
    }

    if (newSessionId !== undefined) {
      await checkpointSession?.(newSessionId);
    }

    // Artifact pointers are validated here, before any node_completed row exists, so a
    // result naming a file it may not address fails this node instead of handing a
    // downstream consumer a location the engine never checked (#2453).
    if (structuredOutput !== undefined) {
      const badPointer = await rejectedArtifactPointer(workflowRun, structuredOutput);
      if (badPointer !== null) {
        throw new NodeFailure('output_contract', `Node '${node.id}': ${badPointer}.`);
      }
    }

    // Capture the producer's declared field set so downstream `$node.output.field`
    // refs can tell a declared-optional-absent field ('') from a typo (throws).
    // Only present when output_format declares an object with `properties`.
    const declaredOutputPaths = declaredOutputPathsFromSchema(node.output_format);

    return {
      state: 'completed',
      output: nodeOutputText,
      sessionId: newSessionId,
      costUsd: nodeCostUsd,
      ...(nodeTokens !== undefined ? { tokens: nodeTokens } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
      ...(nodeResumed !== undefined ? { resumed: nodeResumed } : {}),
    };
  };
  let result: Awaited<ReturnType<typeof runWorkload>>;
  try {
    result = await runWorkload();
  } catch (error) {
    const err = error as Error;

    const cancelled = nodeAbortController.signal.aborted && !nodeIdleTimedOut;
    const failureMessage = cancelled
      ? 'Cancelled by user'
      : nodeMcp.kind === 'missing'
        ? `${err.message}\n${nodeMcp.diagnostic}`
        : err.message;
    if (cancelled) {
      getLog().info({ nodeId: node.id }, 'dag_node_cancelled_via_abort');
    } else {
      getLog().error({ err, nodeId: node.id }, 'dag_node_failed');
    }
    const failureKind: NodeFailureKind = cancelled
      ? 'cancelled'
      : err instanceof NodeFailure
        ? err.kind
        : 'unknown';
    const providerFailure =
      !cancelled && err instanceof NodeFailure ? err.providerFailure : undefined;
    return failAgentNode(failureMessage, failureKind, {
      ...(providerFailure !== undefined ? { providerFailure } : {}),
    });
  }
  if (result.state === 'failed') {
    return failAgentNode(result.error, result.failureKind, { output: result.output });
  }
  const duration = Date.now() - nodeStartTime;
  getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');

  const completed = await recordNodeState(
    { store: deps.store, logDir },
    finishNodeExecution(
      execution,
      { status: 'completed' },
      {
        output: {
          text: result.output,
          structured: result.structuredOutput,
          declaredOutputPaths: result.declaredOutputPaths,
        },
        tokens: nodeTokens,
        tokensUnknown: nodeTokensUnknown,
        costUsd: nodeCostUsd,
        costPartial: costReportMissing,
        stopReason: nodeStopReason,
        numTurns: nodeNumTurns,
        resolvedModel: nodeResolvedModel?.id,
        sessionId: result.sessionId,
        resumed: result.resumed,
        durationMs: duration,
        diagnostics: {
          ...execution.diagnostics,
          ...(node.output_type !== undefined ? { outputType: node.output_type } : {}),
          ...(namedResumeSourceNodeId !== undefined
            ? { sessionForked: resumeIntent !== 'owner-continuation' }
            : {}),
          ...(backgroundTasksIncomplete.length > 0 ? { backgroundTasksIncomplete } : {}),
        },
      }
    ),
    { resumed: result.resumed }
  );

  // Clean up throttle entries on completion
  lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
  lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

  return completed;
}
