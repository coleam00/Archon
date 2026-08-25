import { createLogger } from '@archon/paths';

import { ProviderAttemptStopUnconfirmedError } from '../../shared/provider-attempt';
import { mergeTokenUsage } from '../../types';
import type { MessageChunk, ProviderAttemptLease, SendQueryOptions, TokenUsage } from '../../types';
import { getOrderedAgents, type NamedAgentConfig } from './agent-config';
import { errorMessage } from './errors';
import type { OpencodeClientLike } from './runtime';
import {
  abortableStream,
  createSessionPromptBody,
  promptSession,
  resolveSessionId,
} from './session';
import { normalizeTokens } from './tokens';

interface ProviderModel {
  providerID: string;
  modelID: string;
}

interface AgentRunState {
  agent: NamedAgentConfig;
  cwd: string;
  sessionId: string;
  chunks: MessageChunk[];
  latestAssistantInfo?: Record<string, unknown>;
  lastAssistantMessageId?: string;
  lease?: ProviderAttemptLease;
  leaseAbortHandler?: () => void;
  done: boolean;
  stopConfirmed: boolean;
  promptPhase: 'not_started' | 'pending' | 'settled';
  abortPhase?: AgentRunState['promptPhase'];
  abortPromise?: Promise<boolean>;
}

let cachedLog: ReturnType<typeof createLogger> | undefined;

function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode');
  return cachedLog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readStructuredOutput(
  client: OpencodeClientLike,
  cwd: string,
  sessionId: string,
  messageId: string | undefined
): Promise<unknown> {
  if (!messageId) return undefined;
  try {
    const response = await client.session.message({
      path: { id: sessionId, messageID: messageId },
      query: { directory: cwd },
    });
    const info = response.data?.info;
    if (isRecord(info) && 'structured_output' in info) {
      return info.structured_output;
    }
  } catch (error) {
    getLog().warn({ err: error, sessionId, messageId }, 'opencode.structured_output_lookup_failed');
  }
  return undefined;
}

function withAgentNodeConfig(
  requestOptions: SendQueryOptions | undefined,
  agent: NamedAgentConfig
): SendQueryOptions | undefined {
  if (!requestOptions) {
    return {
      nodeConfig: {
        agents: { [agent.key]: agent.config },
      },
    };
  }
  return {
    ...requestOptions,
    nodeConfig: {
      ...(requestOptions.nodeConfig ?? {}),
      agents: { [agent.key]: agent.config },
    },
  };
}

function formatBufferedAssistantOutput(states: AgentRunState[]): string {
  return states
    .map(state => {
      const assistantText = state.chunks
        .filter(
          (chunk): chunk is Extract<MessageChunk, { type: 'assistant' }> =>
            chunk.type === 'assistant'
        )
        .map(chunk => chunk.content)
        .join('');
      const thinkingText = state.chunks
        .filter(
          (chunk): chunk is Extract<MessageChunk, { type: 'thinking' }> => chunk.type === 'thinking'
        )
        .map(chunk => chunk.content)
        .join('');
      const sections: string[] = [`## ${state.agent.key}`];
      if (thinkingText) {
        sections.push(`<thinking>\n${thinkingText}\n</thinking>`);
      }
      sections.push(assistantText || '(no output)');
      return sections.join('\n\n');
    })
    .join('\n\n---\n\n');
}

function collectToolChunksForEmission(states: AgentRunState[]): MessageChunk[] {
  return states.flatMap(state =>
    state.chunks.filter(chunk => chunk.type === 'tool' || chunk.type === 'tool_result')
  );
}

export async function* streamMultiAgentOpencodeSession(
  client: OpencodeClientLike,
  cwd: string,
  nodeId: string,
  prompt: string,
  model: ProviderModel,
  requestOptions: SendQueryOptions | undefined
): AsyncGenerator<MessageChunk> {
  const agents = getOrderedAgents(requestOptions?.nodeConfig);
  if (agents.length <= 1) {
    throw new Error('streamMultiAgentOpencodeSession requires multiple agents');
  }

  getLog().info({ nodeId, agentCount: agents.length, cwd }, 'opencode.multi_agent_starting');

  const events = await client.event.subscribe({ query: { directory: cwd } });
  getLog().info({ nodeId }, 'opencode.multi_agent_events_subscribed');
  const lifecycleController = new AbortController();
  const sessionToAgent = new Map<string, AgentRunState>();
  let aborted = requestOptions?.abortSignal?.aborted === true;
  let promptError: Error | undefined;
  let promptTasks: Promise<void>[] = [];
  let completed = false;
  let failed = false;
  let failure: unknown;

  const releaseStateLease = async (state: AgentRunState): Promise<void> => {
    if (!state.lease) return;
    if (state.leaseAbortHandler) {
      state.lease.signal.removeEventListener('abort', state.leaseAbortHandler);
    }
    const lease = state.lease;
    state.lease = undefined;
    state.leaseAbortHandler = undefined;
    await lease.release({ upstreamStopped: state.stopConfirmed });
  };

  const abortAll = (): Promise<void> => {
    const aborts = Array.from(sessionToAgent.values(), state => {
      if (state.stopConfirmed) return Promise.resolve(true);
      let abort = state.abortPhase === state.promptPhase ? state.abortPromise : undefined;
      if (!abort) {
        const abortPhase = state.promptPhase;
        abort = client.session
          .abort({
            path: { id: state.sessionId },
            query: { directory: state.cwd },
          })
          .then(
            () => {
              // A cancellation issued while prompt submission is pending can resolve
              // before the prompt is accepted. Only a stable pre-submit state or a
              // post-submit abort proves that no upstream work remains.
              if (abortPhase !== 'pending' && state.promptPhase === abortPhase) {
                state.stopConfirmed = true;
              }
              return true;
            },
            error => {
              getLog().debug(
                { err: error, sessionId: state.sessionId },
                'opencode.multi_agent_abort_failed'
              );
              return false;
            }
          );
        state.abortPhase = abortPhase;
        state.abortPromise = abort;
      }
      return abort;
    });
    return Promise.all(aborts).then(() => undefined);
  };

  const abortHandler = (): void => {
    aborted = true;
    lifecycleController.abort(requestOptions?.abortSignal?.reason);
    void abortAll();
  };

  if (requestOptions?.abortSignal?.aborted) {
    abortHandler();
  } else {
    requestOptions?.abortSignal?.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    // Phase 1: Create all child sessions in the shared sessionCwd so a single
    // event subscription receives events from every child session.
    getLog().info({ nodeId }, 'opencode.multi_agent_creating_sessions');
    const states = await Promise.all(
      agents.map(async agent => {
        const { sessionId } = await resolveSessionId(client, cwd, undefined);
        getLog().info({ agent: agent.key, sessionId, cwd }, 'opencode.multi_agent_session_created');
        const state: AgentRunState = {
          agent,
          cwd,
          sessionId,
          chunks: [],
          done: false,
          stopConfirmed: false,
          promptPhase: 'not_started',
        };
        sessionToAgent.set(sessionId, state);
        return state;
      })
    );

    // Phase 2: Fire prompts in parallel. Under an install-wide cap, each
    // child owns its own slot from prompt submission until that exact session
    // becomes idle. Acquiring all slots before listening would deadlock when
    // the cap is lower than the fan-out width, so admission and event demux run
    // concurrently.
    getLog().info({ nodeId, sessionCount: states.length }, 'opencode.multi_agent_prompting');
    promptTasks = states.map(async state => {
      try {
        const lease = requestOptions?.providerAttemptGate
          ? await requestOptions.providerAttemptGate.acquire(lifecycleController.signal)
          : undefined;
        if (lease) {
          state.lease = lease;
          const onLeaseLost = (): void => {
            promptError ??=
              lease.signal.reason instanceof Error
                ? lease.signal.reason
                : new Error(`OpenCode capacity lease lost for agent '${state.agent.key}'`);
            lifecycleController.abort(promptError);
            void abortAll();
          };
          state.leaseAbortHandler = onLeaseLost;
          if (lease.signal.aborted) {
            onLeaseLost();
            throw (
              promptError ??
              new Error(`OpenCode capacity lease lost for agent '${state.agent.key}'`)
            );
          }
          lease.signal.addEventListener('abort', onLeaseLost, { once: true });
        }
        const agentRequestOptions = withAgentNodeConfig(requestOptions, state.agent);
        const promptBody = createSessionPromptBody(prompt, model, agentRequestOptions, state.agent);
        lifecycleController.signal.throwIfAborted();
        state.promptPhase = 'pending';
        state.stopConfirmed = false;
        getLog().info(
          { agent: state.agent.key, sessionId: state.sessionId },
          'opencode.multi_agent_prompt_sending'
        );
        try {
          await promptSession(client, cwd, state.sessionId, promptBody);
        } finally {
          state.promptPhase = 'settled';
        }
        lifecycleController.signal.throwIfAborted();
        getLog().info(
          { agent: state.agent.key, sessionId: state.sessionId },
          'opencode.multi_agent_prompt_sent'
        );
      } catch (error) {
        promptError ??= error instanceof Error ? error : new Error(String(error));
        lifecycleController.abort(promptError);
        void abortAll();
        throw promptError;
      }
    });
    // Without a gate every prompt is admitted immediately, so retain the old
    // guarantee that all submissions complete before consuming scripted/live
    // events. Gated fan-out must consume events concurrently to release slots.
    if (!requestOptions?.providerAttemptGate) {
      await Promise.all(promptTasks);
      getLog().info({ nodeId }, 'opencode.multi_agent_all_prompts_sent');
    } else {
      for (const task of promptTasks) void task.catch(() => undefined);
    }

    const seenToolCalls = new Set<string>();
    const completedToolCalls = new Set<string>();

    // Phase 3: Listen to events and demux by sessionID
    getLog().info({ nodeId }, 'opencode.multi_agent_listening');
    let eventCount = 0;
    for await (const rawEvent of abortableStream(events.stream, lifecycleController.signal)) {
      eventCount++;
      if (eventCount <= 5) {
        getLog().info(
          { nodeId, eventCount, eventType: (rawEvent as { type?: string })?.type },
          'opencode.multi_agent_event_received'
        );
      }
      const event = rawEvent as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      const properties = isRecord(event.properties) ? event.properties : {};

      if (event.type === 'message.updated') {
        const info = isRecord(properties.info) ? properties.info : undefined;
        const sessionId = typeof info?.sessionID === 'string' ? info.sessionID : undefined;
        const state = sessionId ? sessionToAgent.get(sessionId) : undefined;
        if (!state || info?.role !== 'assistant') continue;
        state.latestAssistantInfo = info;
        if (typeof info.id === 'string') {
          state.lastAssistantMessageId = info.id;
        }
        continue;
      }

      if (event.type === 'message.part.updated') {
        const part = isRecord(properties.part) ? properties.part : undefined;
        const sessionId = typeof part?.sessionID === 'string' ? part.sessionID : undefined;
        const state = sessionId ? sessionToAgent.get(sessionId) : undefined;
        if (!state || typeof part?.type !== 'string') continue;

        if (part.type === 'text') {
          const delta = typeof properties.delta === 'string' ? properties.delta : undefined;
          const text = delta ?? (typeof part.text === 'string' ? part.text : '');
          if (text) {
            state.chunks.push({ type: 'assistant', content: text });
          }
          continue;
        }

        if (part.type === 'reasoning') {
          const delta = typeof properties.delta === 'string' ? properties.delta : undefined;
          const text = delta ?? (typeof part.text === 'string' ? part.text : '');
          if (text) {
            state.chunks.push({ type: 'thinking', content: text });
          }
          continue;
        }

        if (part.type === 'tool') {
          const rawCallId = typeof part.callID === 'string' ? part.callID : undefined;
          const toolName = typeof part.tool === 'string' ? part.tool : 'unknown';
          const stateRecord = isRecord(part.state) ? part.state : undefined;
          const toolInput = isRecord(stateRecord?.input) ? stateRecord.input : undefined;
          const status = typeof stateRecord?.status === 'string' ? stateRecord.status : undefined;
          const scopedCallId = rawCallId ? `${state.agent.key}:${rawCallId}` : undefined;

          if (scopedCallId && !seenToolCalls.has(scopedCallId)) {
            seenToolCalls.add(scopedCallId);
            state.chunks.push({
              type: 'tool',
              toolName,
              ...(toolInput ? { toolInput } : {}),
              toolCallId: scopedCallId,
            });
          }

          if (scopedCallId && !completedToolCalls.has(scopedCallId)) {
            if (status === 'completed') {
              completedToolCalls.add(scopedCallId);
              state.chunks.push({
                type: 'tool_result',
                toolName,
                toolOutput: typeof stateRecord?.output === 'string' ? stateRecord.output : '',
                toolCallId: scopedCallId,
                toolOutcome: 'success',
              });
            } else if (status === 'error') {
              completedToolCalls.add(scopedCallId);
              state.chunks.push({
                type: 'tool_result',
                toolName,
                toolOutput:
                  typeof stateRecord?.error === 'string' ? stateRecord.error : 'Tool failed',
                toolCallId: scopedCallId,
                toolOutcome: 'error',
              });
            }
          }
        }
        continue;
      }

      if (event.type === 'session.error') {
        const sessionId =
          typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
        const state = sessionId ? sessionToAgent.get(sessionId) : undefined;
        if (!state) continue;
        const rawError = isRecord(properties.error) ? properties.error : properties;
        const err = new Error(`[${state.agent.key}] ${errorMessage(rawError)}`);
        err.cause = rawError;
        lifecycleController.abort(err);
        state.stopConfirmed = true;
        await releaseStateLease(state);
        await abortAll();
        throw err;
      }

      if (event.type === 'session.idle') {
        const sessionId =
          typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
        const state = sessionId ? sessionToAgent.get(sessionId) : undefined;
        if (!state) continue;
        state.done = true;
        state.stopConfirmed = true;
        await releaseStateLease(state);
        getLog().info(
          {
            nodeId,
            agent: state.agent.key,
            sessionId,
            doneCount: states.filter(s => s.done).length,
            totalCount: states.length,
          },
          'opencode.multi_agent_session_idle'
        );

        // Check if all agents are done
        if (states.every(candidate => candidate.done)) {
          // Emit collected tool chunks first
          const toolChunks = collectToolChunksForEmission(states);
          for (const chunk of toolChunks) {
            yield chunk;
          }

          // Emit combined assistant output
          yield {
            type: 'assistant',
            content: formatBufferedAssistantOutput(states),
          };

          // Aggregate tokens across sub-agents. The cache axes follow the shared floor
          // rule (#2662): one sub-agent without cache telemetry narrows the total and
          // flags it, instead of erasing cache the others did report. `total` and `cost`
          // keep OpenCode's own composition, including its `input + output` fallback.
          const perAgentUsage = states
            .map(candidate => normalizeTokens(candidate.latestAssistantInfo))
            .filter((usage): usage is TokenUsage => usage !== undefined);
          const mergedUsage = mergeTokenUsage(perAgentUsage);
          const tokens: TokenUsage | undefined =
            // A lone sub-agent passes through verbatim, as before — synthesizing `total`
            // and `cost` for it would change what a single-agent turn reports.
            perAgentUsage.length === 1
              ? { ...perAgentUsage[0] }
              : mergedUsage && {
                  ...mergedUsage,
                  total: perAgentUsage.reduce(
                    (sum, usage) => sum + (usage.total ?? usage.input + usage.output),
                    0
                  ),
                  cost: perAgentUsage.reduce((sum, usage) => sum + (usage.cost ?? 0), 0),
                };

          // Fetch structured outputs from all agents
          const structuredOutputs = await Promise.all(
            states.map(async state => {
              const output = await readStructuredOutput(
                client,
                state.cwd,
                state.sessionId,
                state.lastAssistantMessageId
              );
              return output !== undefined ? ([state.agent.key, output] as const) : undefined;
            })
          ).then(results => {
            const filtered = results.filter(entry => entry !== undefined) as [string, unknown][];
            return filtered.length > 0 ? Object.fromEntries(filtered) : undefined;
          });

          // Multi-agent runs span multiple sessions; there is no single canonical
          // sessionId to resume, so we omit it rather than returning an arbitrary one.
          yield {
            type: 'result',
            ...(tokens ? { tokens } : {}),
            ...(structuredOutputs ? { structuredOutput: structuredOutputs } : {}),
          };
          completed = true;
          getLog().info({ nodeId }, 'opencode.multi_agent_completed');
          return;
        }
      }
    }

    getLog().info({ nodeId, aborted, eventCount }, 'opencode.multi_agent_loop_exited');
    if (promptError) throw promptError;
    if (aborted) {
      const abortReason = requestOptions?.abortSignal?.reason;
      throw new Error(
        `OpenCode query aborted (nodeId: ${nodeId}, agents: ${agents.length}, cwd: ${cwd})` +
          (abortReason ? `: ${String(abortReason)}` : '')
      );
    }
    throw new Error('OpenCode multi-agent stream ended before all agents completed');
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    requestOptions?.abortSignal?.removeEventListener('abort', abortHandler);
    lifecycleController.abort();
    if (!completed) {
      await abortAll();
      await Promise.allSettled(promptTasks);
      // Prompts that were already in flight when cancellation started need a
      // fresh abort after their submissions settle.
      await abortAll();
    }
    await Promise.all(Array.from(sessionToAgent.values(), state => releaseStateLease(state)));
  }

  if (failed && Array.from(sessionToAgent.values()).some(state => !state.stopConfirmed)) {
    const message = failure instanceof Error ? failure.message : String(failure);
    throw new ProviderAttemptStopUnconfirmedError(message, { cause: failure });
  }
  if (failed) throw failure;
}
