import { createLogger } from '@archon/paths';

import type { MessageChunk, SendQueryOptions, TokenUsage } from '../../types';
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
  done: boolean;
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
    getLog().debug(
      { err: error, sessionId, messageId },
      'opencode.structured_output_lookup_failed'
    );
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
  const streamController = new AbortController();
  const sessionToAgent = new Map<string, AgentRunState>();
  let aborted = requestOptions?.abortSignal?.aborted === true;

  const abortAll = async (): Promise<void> => {
    await Promise.all(
      Array.from(sessionToAgent.values()).map(state =>
        client.session
          .abort({ path: { id: state.sessionId }, query: { directory: state.cwd } })
          .catch(error => {
            getLog().debug(
              { err: error, sessionId: state.sessionId, agent: state.agent.key },
              'opencode.multi_agent_abort_failed'
            );
          })
      )
    );
  };

  const abortHandler = (): void => {
    aborted = true;
    void abortAll();
    streamController.abort();
  };

  requestOptions?.abortSignal?.addEventListener('abort', abortHandler, { once: true });

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
        };
        sessionToAgent.set(sessionId, state);
        return state;
      })
    );

    // Phase 2: Fire all prompts in parallel
    getLog().info({ nodeId, sessionCount: states.length }, 'opencode.multi_agent_prompting');
    await Promise.all(
      states.map(async state => {
        const agentRequestOptions = withAgentNodeConfig(requestOptions, state.agent);
        const promptBody = createSessionPromptBody(prompt, model, agentRequestOptions, state.agent);
        getLog().info(
          { agent: state.agent.key, sessionId: state.sessionId },
          'opencode.multi_agent_prompt_sending'
        );
        await promptSession(client, cwd, state.sessionId, promptBody);
        getLog().info(
          { agent: state.agent.key, sessionId: state.sessionId },
          'opencode.multi_agent_prompt_sent'
        );
      })
    );
    getLog().info({ nodeId }, 'opencode.multi_agent_all_prompts_sent');

    const seenToolCalls = new Set<string>();
    const completedToolCalls = new Set<string>();

    // Phase 3: Listen to events and demux by sessionID
    getLog().info({ nodeId }, 'opencode.multi_agent_listening');
    let eventCount = 0;
    for await (const rawEvent of abortableStream(events.stream, streamController.signal)) {
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
              });
            } else if (status === 'error') {
              completedToolCalls.add(scopedCallId);
              state.chunks.push({
                type: 'tool_result',
                toolName,
                toolOutput:
                  typeof stateRecord?.error === 'string' ? stateRecord.error : 'Tool failed',
                toolCallId: scopedCallId,
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
        await abortAll();
        const rawError = isRecord(properties.error) ? properties.error : properties;
        const err = new Error(`[${state.agent.key}] ${errorMessage(rawError)}`);
        err.cause = rawError;
        throw err;
      }

      if (event.type === 'session.idle') {
        const sessionId =
          typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
        const state = sessionId ? sessionToAgent.get(sessionId) : undefined;
        if (!state) continue;
        state.done = true;
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

          // Aggregate tokens
          const tokens = states.reduce<TokenUsage | undefined>((acc, candidate) => {
            const next = normalizeTokens(candidate.latestAssistantInfo);
            if (!next) return acc;
            if (!acc) return { ...next };
            return {
              input: acc.input + next.input,
              output: acc.output + next.output,
              total:
                (acc.total ?? acc.input + acc.output) + (next.total ?? next.input + next.output),
              cost: (acc.cost ?? 0) + (next.cost ?? 0),
            };
          }, undefined);

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
          getLog().info({ nodeId }, 'opencode.multi_agent_completed');
          return;
        }
      }
    }

    getLog().info({ nodeId, aborted, eventCount }, 'opencode.multi_agent_loop_exited');
    if (aborted) {
      const abortReason = requestOptions?.abortSignal?.reason;
      throw new Error(
        `OpenCode query aborted (nodeId: ${nodeId}, agents: ${agents.length}, cwd: ${cwd})` +
          (abortReason ? `: ${String(abortReason)}` : '')
      );
    }
    throw new Error('OpenCode multi-agent stream ended before all agents completed');
  } finally {
    requestOptions?.abortSignal?.removeEventListener('abort', abortHandler);
    streamController.abort();
  }
}
