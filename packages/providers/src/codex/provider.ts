/**
 * Codex SDK wrapper
 * Provides async generator interface for streaming Codex responses
 */
import {
  Codex,
  type ThreadOptions,
  type TurnOptions,
  type TurnCompletedEvent,
} from '@openai/codex-sdk';
import type {
  IAgentProvider,
  SendQueryOptions,
  MessageChunk,
  TokenUsage,
  ProviderCapabilities,
} from '../types';
import { parseCodexConfig } from './config';
import { resolveCodexBinaryPath } from './binary-resolver';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex');
  return cachedLog;
}

// Singleton Codex instance (async because binary path resolution is async)
let codexInstance: Codex | null = null;
let codexInitPromise: Promise<Codex> | null = null;

/** Reset singleton state. Exported for tests only. */
export function resetCodexSingleton(): void {
  codexInstance = null;
  codexInitPromise = null;
}

/**
 * Get or create Codex SDK instance.
 */
async function getCodex(configCodexBinaryPath?: string): Promise<Codex> {
  if (codexInstance) return codexInstance;

  if (!codexInitPromise) {
    codexInitPromise = (async (): Promise<Codex> => {
      const codexPathOverride = await resolveCodexBinaryPath(configCodexBinaryPath);
      const instance = new Codex({ codexPathOverride });
      codexInstance = instance;
      return instance;
    })().catch(err => {
      codexInitPromise = null;
      throw err;
    });
  }
  return codexInitPromise;
}

/**
 * Build thread options for Codex SDK
 */
function buildThreadOptions(
  cwd: string,
  model?: string,
  assistantConfig?: Record<string, unknown>
): ThreadOptions {
  const config = parseCodexConfig(assistantConfig ?? {});
  return {
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access',
    networkAccessEnabled: true,
    approvalPolicy: 'never',
    model: model ?? config.model,
    modelReasoningEffort: config.modelReasoningEffort,
    webSearchMode: config.webSearchMode,
    additionalDirectories: config.additionalDirectories,
  };
}

const CODEX_MODEL_FALLBACKS: Record<string, string> = {
  'gpt-5.3-codex': 'gpt-5.2-codex',
};

function isModelAccessError(errorMessage: string): boolean {
  const m = errorMessage.toLowerCase();
  const hasModel = m.includes('model');
  const hasAvailabilitySignal =
    m.includes('not available') || m.includes('not found') || m.includes('access denied');
  return hasModel && hasAvailabilitySignal;
}

function buildModelAccessMessage(model?: string): string {
  const normalizedModel = model?.trim();
  const selectedModel = normalizedModel || 'the configured model';
  const suggested = normalizedModel ? CODEX_MODEL_FALLBACKS[normalizedModel] : undefined;

  const fixLine = suggested
    ? `To fix: update your model in ~/.archon/config.yaml:\n  assistants:\n    codex:\n      model: ${suggested}`
    : 'To fix: update your model in ~/.archon/config.yaml to one your account can access.';

  const workflowLine = suggested
    ? `Or set it per-workflow with \`model: ${suggested}\` in workflow YAML.`
    : 'Or set it per-workflow with a valid `model:` in workflow YAML.';

  return `❌ Model "${selectedModel}" is not available for your account.\n\n${fixLine}\n\n${workflowLine}`;
}

const MAX_SUBPROCESS_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
const AUTH_PATTERNS = [
  'credit balance',
  'unauthorized',
  'authentication',
  'invalid token',
  '401',
  '403',
];
const SUBPROCESS_CRASH_PATTERNS = ['exited with code', 'killed', 'signal', 'codex exec'];

function classifyCodexError(
  errorMessage: string
): 'rate_limit' | 'auth' | 'crash' | 'model_access' | 'unknown' {
  if (isModelAccessError(errorMessage)) return 'model_access';
  const m = errorMessage.toLowerCase();
  if (RATE_LIMIT_PATTERNS.some(p => m.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => m.includes(p))) return 'auth';
  if (SUBPROCESS_CRASH_PATTERNS.some(p => m.includes(p))) return 'crash';
  return 'unknown';
}

function extractUsageFromCodexEvent(event: TurnCompletedEvent): TokenUsage {
  if (!event.usage) {
    getLog().warn({ eventType: event.type }, 'codex.usage_null_on_turn_completed');
    return { input: 0, output: 0 };
  }
  return {
    input: event.usage.input_tokens,
    output: event.usage.output_tokens,
  };
}

/**
 * Codex AI agent provider.
 * Implements IAgentProvider with Codex SDK integration.
 */
export class CodexProvider implements IAgentProvider {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      sessionResume: true,
      mcp: false,
      hooks: false,
      skills: false,
      toolRestrictions: false,
      structuredOutput: true,
      envInjection: false,
      costControl: false,
      effortControl: false,
      thinkingControl: false,
      fallbackModel: false,
      sandbox: false,
    };
  }

  // TODO(#1135): Pre-spawn env-leak gate was removed during provider extraction.
  // Caller-side enforcement (orchestrator, dag-executor) is tracked in #1135.
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const codexConfig = parseCodexConfig(assistantConfig);

    // Initialize Codex SDK with binary path override
    const codex = await getCodex(codexConfig.codexBinaryPath);
    const threadOptions = buildThreadOptions(cwd, requestOptions?.model, assistantConfig);

    if (requestOptions?.abortSignal?.aborted) {
      throw new Error('Query aborted');
    }

    let sessionResumeFailed = false;
    let thread;
    if (resumeSessionId) {
      getLog().debug({ sessionId: resumeSessionId }, 'resuming_thread');
      try {
        thread = codex.resumeThread(resumeSessionId, threadOptions);
      } catch (error) {
        getLog().error({ err: error, sessionId: resumeSessionId }, 'resume_thread_failed');
        try {
          thread = codex.startThread(threadOptions);
        } catch (startError) {
          const err = startError as Error;
          if (isModelAccessError(err.message)) {
            throw new Error(buildModelAccessMessage(requestOptions?.model));
          }
          throw new Error(`Codex query failed: ${err.message}`);
        }
        sessionResumeFailed = true;
      }
    } else {
      getLog().debug({ cwd }, 'starting_new_thread');
      try {
        thread = codex.startThread(threadOptions);
      } catch (error) {
        const err = error as Error;
        if (isModelAccessError(err.message)) {
          throw new Error(buildModelAccessMessage(requestOptions?.model));
        }
        throw new Error(`Codex query failed: ${err.message}`);
      }
    }

    if (sessionResumeFailed) {
      yield {
        type: 'system',
        content: '⚠️ Could not resume previous session. Starting fresh conversation.',
      };
    }

    let lastTodoListSignature: string | undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      if (attempt > 0) {
        getLog().debug({ cwd, attempt }, 'starting_new_thread');
        try {
          thread = codex.startThread(threadOptions);
        } catch (startError) {
          const err = startError as Error;
          if (isModelAccessError(err.message)) {
            throw new Error(buildModelAccessMessage(requestOptions?.model));
          }
          throw new Error(`Codex query failed: ${err.message}`);
        }
      }

      try {
        const turnOptions: TurnOptions = {};
        const hasOutputFormat = !!(
          requestOptions?.outputFormat ?? requestOptions?.nodeConfig?.output_format
        );
        if (requestOptions?.outputFormat) {
          turnOptions.outputSchema = requestOptions.outputFormat.schema;
        }
        // Also check nodeConfig.output_format (workflow path)
        if (requestOptions?.nodeConfig?.output_format && !requestOptions?.outputFormat) {
          turnOptions.outputSchema = requestOptions.nodeConfig.output_format;
        }
        // Track accumulated text for structured output normalization
        let accumulatedText = '';
        if (requestOptions?.abortSignal) {
          turnOptions.signal = requestOptions.abortSignal;
        }

        const result = await thread.runStreamed(prompt, turnOptions);

        for await (const event of result.events) {
          if (requestOptions?.abortSignal?.aborted) {
            getLog().info('query_aborted_between_events');
            break;
          }

          if (event.type === 'item.started') {
            const item = event.item;
            getLog().debug(
              { eventType: event.type, itemType: item.type, itemId: item.id },
              'item_started'
            );
          }

          if (event.type === 'error') {
            getLog().error({ message: event.message }, 'stream_error');
            if (!event.message.includes('MCP client')) {
              yield { type: 'system', content: `⚠️ ${event.message}` };
            }
            continue;
          }

          if (event.type === 'turn.failed') {
            const errorObj = event.error as { message?: string } | undefined;
            const errorMessage = errorObj?.message ?? 'Unknown error';
            getLog().error({ errorMessage }, 'turn_failed');
            yield {
              type: 'system',
              content: `❌ Turn failed: ${errorMessage}`,
            };
            break;
          }

          if (event.type === 'item.completed') {
            const item = event.item;

            const logContext: Record<string, unknown> = {
              eventType: event.type,
              itemType: item.type,
              itemId: item.id,
            };
            if (item.type === 'command_execution' && item.command) {
              logContext.command = item.command;
            }
            getLog().debug(logContext, 'item_completed');

            switch (item.type) {
              case 'agent_message':
                if (item.text) {
                  if (hasOutputFormat) accumulatedText += item.text;
                  yield { type: 'assistant', content: item.text };
                }
                break;

              case 'command_execution':
                if (item.command) {
                  yield { type: 'tool', toolName: item.command };
                  const exitSuffix =
                    item.exit_code != null && item.exit_code !== 0
                      ? `\n[exit code: ${item.exit_code}]`
                      : '';
                  yield {
                    type: 'tool_result',
                    toolName: item.command,
                    toolOutput: (item.aggregated_output ?? '') + exitSuffix,
                  };
                } else {
                  getLog().warn({ itemId: item.id }, 'command_execution_missing_command');
                }
                break;

              case 'reasoning':
                if (item.text) {
                  yield { type: 'thinking', content: item.text };
                }
                break;

              case 'web_search':
                if (item.query) {
                  const searchToolName = `🔍 Searching: ${item.query}`;
                  yield { type: 'tool', toolName: searchToolName };
                  yield { type: 'tool_result', toolName: searchToolName, toolOutput: '' };
                } else {
                  getLog().debug({ itemId: item.id }, 'web_search_missing_query');
                }
                break;

              case 'todo_list':
                if (Array.isArray(item.items) && item.items.length > 0) {
                  const normalizedItems = item.items.map(t => ({
                    text: typeof t.text === 'string' ? t.text : '(unnamed task)',
                    completed: t.completed ?? false,
                  }));
                  const signature = JSON.stringify(normalizedItems);
                  if (signature !== lastTodoListSignature) {
                    lastTodoListSignature = signature;
                    const taskList = normalizedItems
                      .map(t => `${t.completed ? '✅' : '⬜'} ${t.text}`)
                      .join('\n');
                    yield { type: 'system', content: `📋 Tasks:\n${taskList}` };
                  }
                } else {
                  getLog().debug({ itemId: item.id }, 'todo_list_empty_or_invalid');
                }
                break;

              case 'file_change': {
                const statusIcon = item.status === 'failed' ? '❌' : '✅';
                const rawError = 'error' in item ? (item as { error?: unknown }).error : undefined;
                const fileErrorMessage =
                  typeof rawError === 'string'
                    ? rawError
                    : typeof rawError === 'object' && rawError !== null && 'message' in rawError
                      ? String((rawError as { message: unknown }).message)
                      : undefined;

                if (Array.isArray(item.changes) && item.changes.length > 0) {
                  const changeList = item.changes
                    .map(c => {
                      const icon = c.kind === 'add' ? '➕' : c.kind === 'delete' ? '➖' : '📝';
                      return `${icon} ${c.path ?? '(unknown file)'}`;
                    })
                    .join('\n');
                  const errorSuffix =
                    item.status === 'failed' && fileErrorMessage ? `\n${fileErrorMessage}` : '';
                  yield {
                    type: 'system',
                    content: `${statusIcon} File changes:\n${changeList}${errorSuffix}`,
                  };
                } else if (item.status === 'failed') {
                  getLog().warn(
                    { itemId: item.id, status: item.status },
                    'file_change_failed_no_changes'
                  );
                  const failMsg = fileErrorMessage
                    ? `❌ File change failed: ${fileErrorMessage}`
                    : '❌ File change failed';
                  yield { type: 'system', content: failMsg };
                } else {
                  getLog().debug(
                    { itemId: item.id, status: item.status },
                    'file_change_no_changes'
                  );
                }
                break;
              }

              case 'mcp_tool_call': {
                const toolInfo =
                  item.server && item.tool
                    ? `${item.server}/${item.tool}`
                    : (item.tool ?? item.server ?? 'MCP tool');
                const mcpToolName = `🔌 MCP: ${toolInfo}`;

                yield { type: 'tool', toolName: mcpToolName };

                if (item.status === 'failed') {
                  getLog().warn(
                    {
                      server: item.server,
                      tool: item.tool,
                      error: item.error,
                      itemId: item.id,
                    },
                    'mcp_tool_call_failed'
                  );
                  const errMsg = item.error?.message
                    ? `❌ Error: ${item.error.message}`
                    : '❌ Error: MCP tool failed';
                  yield { type: 'tool_result', toolName: mcpToolName, toolOutput: errMsg };
                } else {
                  let toolOutput = '';
                  if (item.result?.content) {
                    if (Array.isArray(item.result.content)) {
                      toolOutput = JSON.stringify(item.result.content);
                    } else {
                      getLog().warn(
                        {
                          itemId: item.id,
                          server: item.server,
                          tool: item.tool,
                          resultType: typeof item.result.content,
                        },
                        'mcp_tool_call_unexpected_result_shape'
                      );
                    }
                  }
                  yield { type: 'tool_result', toolName: mcpToolName, toolOutput };
                }
                break;
              }
            }
          }

          if (event.type === 'turn.completed') {
            getLog().debug('turn_completed');
            const usage = extractUsageFromCodexEvent(event);

            // Codex returns structured output inline in agent_message text.
            // Normalize: parse as JSON and put on structuredOutput so the
            // dag-executor can handle all providers uniformly.
            let structuredOutput: unknown;
            if (hasOutputFormat && accumulatedText) {
              try {
                structuredOutput = JSON.parse(accumulatedText);
                getLog().debug('codex.structured_output_parsed');
              } catch {
                getLog().warn(
                  { outputPreview: accumulatedText.slice(0, 200) },
                  'codex.structured_output_not_json'
                );
                yield {
                  type: 'system',
                  content:
                    '⚠️ Structured output requested but Codex returned non-JSON text. ' +
                    'Downstream $nodeId.output.field references may not evaluate correctly.',
                };
              }
            }

            yield {
              type: 'result',
              sessionId: thread.id ?? undefined,
              tokens: usage,
              ...(structuredOutput !== undefined ? { structuredOutput } : {}),
            };
            break;
          }
        }
        return;
      } catch (error) {
        const err = error as Error;

        if (requestOptions?.abortSignal?.aborted) {
          throw new Error('Query aborted');
        }

        const errorClass = classifyCodexError(err.message);
        getLog().error(
          { err, errorClass, attempt, maxRetries: MAX_SUBPROCESS_RETRIES },
          'query_error'
        );

        if (errorClass === 'model_access') {
          throw new Error(buildModelAccessMessage(requestOptions?.model));
        }

        if (errorClass === 'auth') {
          const enrichedError = new Error(`Codex auth error: ${err.message}`);
          enrichedError.cause = error;
          throw enrichedError;
        }

        if (
          attempt < MAX_SUBPROCESS_RETRIES &&
          (errorClass === 'rate_limit' || errorClass === 'crash')
        ) {
          const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
          getLog().info({ attempt, delayMs, errorClass }, 'retrying_query');
          await new Promise(resolve => setTimeout(resolve, delayMs));
          lastError = err;
          continue;
        }

        const enrichedError = new Error(`Codex ${errorClass}: ${err.message}`);
        enrichedError.cause = error;
        throw enrichedError;
      }
    }

    throw lastError ?? new Error('Codex query failed after retries');
  }

  getType(): string {
    return 'codex';
  }
}
