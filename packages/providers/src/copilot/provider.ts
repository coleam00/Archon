/**
 * GitHub Copilot SDK wrapper
 * Provides async generator interface for streaming Copilot responses
 */
import { CopilotClient, approveAll } from '@github/copilot-sdk';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
import type {
  IAgentProvider,
  SendQueryOptions,
  MessageChunk,
  TokenUsage,
  ProviderCapabilities,
} from '../types';
import { parseCopilotConfig } from './config';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot');
  return cachedLog;
}

let copilotClient: CopilotClient | null = null;

function getCopilotClient(): CopilotClient {
  if (!copilotClient) {
    copilotClient = new CopilotClient();
  }
  return copilotClient;
}

interface CopilotStreamState {
  toolCallIdToName: Map<string, string>;
  accumulatedAssistantContent: string;
  accumulatedThinkingContent: string;
}

async function* streamCopilotEvents(
  session: CopilotSession,
  state: CopilotStreamState
): AsyncGenerator<MessageChunk> {
  const eventQueue: SessionEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let hasError = false;
  let errorMessage = '';

  const handleEvent = (event: SessionEvent): void => {
    if (event.type === 'session.error') {
      hasError = true;
      errorMessage = (event as { data: { message: string } }).data.message;
    }
    eventQueue.push(event);
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  };

  const unsubscribe = session.on(handleEvent);

  try {
    while (true) {
      if (hasError) {
        yield { type: 'system', content: `⚠️ ${errorMessage}` };
        break;
      }

      if (eventQueue.length === 0) {
        await new Promise<void>(resolve => {
          resolveNext = resolve;
        });
        continue;
      }

      const event = eventQueue.shift();
      if (!event) continue;

      switch (event.type) {
        case 'assistant.message': {
          const msgEvent = event as {
            data: {
              content: string;
              toolRequests?: {
                toolCallId: string;
                name: string;
                arguments?: Record<string, unknown>;
              }[];
            };
          };
          if (msgEvent.data.content) {
            state.accumulatedAssistantContent += msgEvent.data.content;
          }
          if (msgEvent.data.toolRequests) {
            for (const tool of msgEvent.data.toolRequests) {
              state.toolCallIdToName.set(tool.toolCallId, tool.name);
              yield {
                type: 'tool',
                toolName: tool.name,
                toolInput: tool.arguments ?? {},
                toolCallId: tool.toolCallId,
              };
            }
          }
          break;
        }

        case 'assistant.reasoning': {
          const reasoningEvent = event as { data: { content: string } };
          if (reasoningEvent.data.content) {
            state.accumulatedThinkingContent += reasoningEvent.data.content;
            yield { type: 'thinking', content: reasoningEvent.data.content };
          }
          break;
        }

        case 'assistant.reasoning_delta': {
          const deltaEvent = event as { data: { deltaContent: string } };
          if (deltaEvent.data.deltaContent) {
            state.accumulatedThinkingContent += deltaEvent.data.deltaContent;
            yield { type: 'thinking', content: deltaEvent.data.deltaContent };
          }
          break;
        }

        case 'assistant.message_delta': {
          const deltaEvent = event as { data: { deltaContent: string } };
          if (deltaEvent.data.deltaContent) {
            state.accumulatedAssistantContent += deltaEvent.data.deltaContent;
            yield { type: 'assistant', content: deltaEvent.data.deltaContent };
          }
          break;
        }

        case 'tool.execution_start': {
          const startEvent = event as { data: { toolCallId: string; toolName: string } };
          state.toolCallIdToName.set(startEvent.data.toolCallId, startEvent.data.toolName);
          break;
        }

        case 'tool.execution_complete': {
          const completeEvent = event as {
            data: {
              toolCallId: string;
              success: boolean;
              result?: { content: string; detailedContent?: string };
            };
          };
          const toolName = state.toolCallIdToName.get(completeEvent.data.toolCallId) ?? 'unknown';
          let output = '';
          if (completeEvent.data.result) {
            output = completeEvent.data.result.detailedContent ?? completeEvent.data.result.content;
          }
          if (!completeEvent.data.success) {
            output = `❌ ${output}`;
          }
          yield {
            type: 'tool_result',
            toolName,
            toolOutput: output,
            toolCallId: completeEvent.data.toolCallId,
          };
          break;
        }

        case 'tool.execution_partial_result': {
          const partialEvent = event as { data: { toolCallId: string; partialOutput: string } };
          const toolName = state.toolCallIdToName.get(partialEvent.data.toolCallId) ?? 'unknown';
          yield {
            type: 'tool_result',
            toolName,
            toolOutput: partialEvent.data.partialOutput,
            toolCallId: partialEvent.data.toolCallId,
          };
          break;
        }

        case 'session.idle': {
          const idleEvent = event as { data: { aborted?: boolean } };
          if (idleEvent.data.aborted) {
            getLog().info('session_idle_aborted');
          }
          break;
        }

        case 'session.start':
        case 'session.resume':
          break;

        case 'assistant.usage': {
          const usageEvent = event as { data?: { inputTokens?: number; outputTokens?: number } };
          if (usageEvent.data) {
            const usage = normalizeCopilotUsage(usageEvent.data);
            if (usage) {
              yield {
                type: 'result',
                sessionId: session.sessionId,
                tokens: usage,
              };
            }
          }
          break;
        }

        default:
          getLog().debug({ eventType: event.type }, 'copilot.unhandled_event_type');
          break;
      }

      if (event.type === 'session.idle') {
        break;
      }
    }
  } finally {
    unsubscribe();
  }
}

function normalizeCopilotUsage(usage?: {
  inputTokens?: number;
  outputTokens?: number;
}): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  return {
    input,
    output,
  };
}

const UNSUPPORTED_OPTIONS = [
  'tools',
  'disallowedTools',
  'outputFormat',
  'hooks',
  'mcpServers',
  'allowedTools',
  'agents',
  'agent',
  'settingSources',
  'env',
  'effort',
  'thinking',
  'maxBudgetUsd',
  'fallbackModel',
  'betas',
  'sandbox',
  'additionalDirectories',
  'webSearchMode',
  'idle_timeout',
  'mcp',
  'skills',
];

const UNSUPPORTED_BOOLEAN_OPTIONS = ['forkSession', 'persistSession'];

export class CopilotProvider implements IAgentProvider {
  getCapabilities(): ProviderCapabilities {
    return {
      sessionResume: true,
      mcp: false,
      hooks: false,
      skills: false,
      toolRestrictions: false,
      structuredOutput: false,
      envInjection: false,
      costControl: false,
      effortControl: true,
      thinkingControl: true,
      fallbackModel: false,
      sandbox: false,
    };
  }

  warnUnsupportedOptions(options: SendQueryOptions): void {
    const nodeConfig = options?.nodeConfig;
    for (const opt of UNSUPPORTED_OPTIONS) {
      if (nodeConfig?.[opt] !== undefined) {
        getLog().warn({ option: opt }, 'copilot.option_not_supported');
      }
    }

    for (const opt of UNSUPPORTED_BOOLEAN_OPTIONS) {
      if (nodeConfig?.[opt] != null) {
        getLog().warn({ option: opt, value: nodeConfig[opt] }, 'copilot.option_not_supported');
      }
    }

    if ((options as Record<string, unknown>).forkSession === true) {
      throw new Error('forkSession is not supported by Copilot provider');
    }
    if ((options as Record<string, unknown>).persistSession === false) {
      throw new Error('persistSession=false is not supported by Copilot provider');
    }
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    if (requestOptions) {
      this.warnUnsupportedOptions(requestOptions);
    }

    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const copilotConfig = parseCopilotConfig(assistantConfig);

    const model = requestOptions?.model ?? copilotConfig.model;
    const rawEffort = requestOptions?.nodeConfig?.effort ?? assistantConfig.modelReasoningEffort;
    const modelReasoningEffort =
      typeof rawEffort === 'string' ? (rawEffort as ReasoningEffort) : undefined;

    const client = getCopilotClient();

    let session: CopilotSession;

    if (resumeSessionId) {
      getLog().debug({ sessionId: resumeSessionId }, 'copilot.resuming_session');
      session = await client.resumeSession(resumeSessionId, {
        workingDirectory: cwd,
        model,
        reasoningEffort: modelReasoningEffort,
        onPermissionRequest: approveAll,
      });
    } else {
      getLog().debug({ cwd }, 'copilot.creating_session');
      session = await client.createSession({
        workingDirectory: cwd,
        model,
        reasoningEffort: modelReasoningEffort,
        onPermissionRequest: approveAll,
      });
    }

    const state: CopilotStreamState = {
      toolCallIdToName: new Map(),
      accumulatedAssistantContent: '',
      accumulatedThinkingContent: '',
    };

    try {
      await session.sendAndWait({ prompt });

      yield* streamCopilotEvents(session, state);
    } finally {
      await session.disconnect();
    }
  }

  getType(): string {
    return 'copilot';
  }
}
