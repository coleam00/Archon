/**
 * GitHub Copilot SDK wrapper
 * Provides async generator interface for streaming Copilot responses
 *
 * The Copilot SDK delivers response content via sendAndWait()'s return value
 * (AssistantMessageEvent), NOT through streaming delta events. Metadata events
 * (usage, session state) ARE delivered via the event handler during sendAndWait.
 * This provider subscribes to events for metadata, then yields the final content
 * from sendAndWait's result.
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
      if (nodeConfig?.[opt] !== undefined) {
        getLog().warn({ option: opt, value: nodeConfig[opt] }, 'copilot.option_not_supported');
      }
    }

    if (nodeConfig?.forkSession === true) {
      throw new Error('forkSession is not supported by Copilot provider');
    }
    if (nodeConfig?.persistSession === true) {
      throw new Error('persistSession is not supported by Copilot provider');
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

    getLog().info({ sessionId: session.sessionId }, 'copilot.session_created');

    try {
      // The Copilot SDK delivers response content via sendAndWait's return value
      // rather than through streaming delta events. We subscribe to events for
      // metadata (usage, errors) but yield content from the sendAndWait result.
      const metadataEvents: SessionEvent[] = [];
      const unsubscribe = session.on((event: SessionEvent) => {
        metadataEvents.push(event);
      });

      let sendAndWaitResult;
      try {
        sendAndWaitResult = await session.sendAndWait({ prompt });
      } finally {
        unsubscribe();
      }

      getLog().info(
        { sessionId: session.sessionId, hasResult: !!sendAndWaitResult },
        'copilot.sendAndWait_completed'
      );

      // Yield any usage events collected during the session
      const toolCallIdToName = new Map<string, string>();
      let usageTokens: TokenUsage | undefined;
      for (const event of metadataEvents) {
        switch (event.type) {
          case 'assistant.reasoning': {
            const reasoningEvent = event as { data: { content: string } };
            if (reasoningEvent.data.content) {
              yield { type: 'thinking', content: reasoningEvent.data.content };
            }
            break;
          }
          case 'assistant.reasoning_delta': {
            const deltaEvent = event as { data: { deltaContent: string } };
            if (deltaEvent.data.deltaContent) {
              yield { type: 'thinking', content: deltaEvent.data.deltaContent };
            }
            break;
          }
          case 'assistant.message_delta': {
            const deltaEvent = event as { data: { deltaContent: string } };
            if (deltaEvent.data.deltaContent) {
              yield { type: 'assistant', content: deltaEvent.data.deltaContent };
            }
            break;
          }
          case 'assistant.usage': {
            const usageEvent = event as {
              data?: { inputTokens?: number; outputTokens?: number };
            };
            if (usageEvent.data) {
              const usage = normalizeCopilotUsage(usageEvent.data);
              if (usage) {
                // Defer result yield until after content — dag-executor breaks on result
                usageTokens = usage;
              }
            }
            break;
          }
          case 'tool.execution_start': {
            const startEvent = event as { data: { toolCallId: string; toolName: string } };
            toolCallIdToName.set(startEvent.data.toolCallId, startEvent.data.toolName);
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
            const toolName = toolCallIdToName.get(completeEvent.data.toolCallId) ?? 'unknown';
            let output = '';
            if (completeEvent.data.result) {
              output =
                completeEvent.data.result.detailedContent ?? completeEvent.data.result.content;
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
          case 'session.error': {
            const errorEvent = event as { data: { message: string } };
            getLog().error(
              { sessionId: session.sessionId, error: errorEvent.data.message },
              'copilot.session_error'
            );
            break;
          }
          default:
            getLog().debug(
              { sessionId: session.sessionId, eventType: event.type },
              'copilot.unhandled_event_type'
            );
            break;
        }
      }

      // Yield content from sendAndWait result if we didn't get it from streaming deltas
      if (sendAndWaitResult?.data?.content) {
        const hadStreamingContent = metadataEvents.some(
          e =>
            e.type === 'assistant.message_delta' &&
            (e as { data: { deltaContent: string } }).data?.deltaContent
        );
        if (!hadStreamingContent) {
          yield { type: 'assistant', content: sendAndWaitResult.data.content };
        }
      }

      // Yield tool requests from sendAndWait result
      if (sendAndWaitResult?.data?.toolRequests && sendAndWaitResult.data.toolRequests.length > 0) {
        for (const tool of sendAndWaitResult.data.toolRequests) {
          yield {
            type: 'tool',
            toolName: tool.name,
            toolInput: tool.arguments ?? {},
            toolCallId: tool.toolCallId,
          };
        }
      }

      // Yield result LAST — dag-executor breaks on result type
      if (usageTokens) {
        yield {
          type: 'result',
          sessionId: session.sessionId,
          tokens: usageTokens,
        };
      }

      // If we got no content at all, log a warning
      if (
        !sendAndWaitResult?.data?.content &&
        !metadataEvents.some(e => e.type === 'assistant.message_delta')
      ) {
        getLog().warn({ sessionId: session.sessionId }, 'copilot.no_content_received');
      }
    } finally {
      await session.disconnect();
    }
  }

  getType(): string {
    return 'copilot';
  }
}
