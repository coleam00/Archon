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
import { CODEX_CAPABILITIES } from './capabilities';
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

function buildCodexEnv(requestEnv: Record<string, string>): Record<string, string> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  // Managed project env intentionally overrides inherited process env for project-scoped execution.
  return { ...baseEnv, ...requestEnv };
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

// ─── Turn Options Builder ────────────────────────────────────────────────

/**
 * Build turn options for a single Codex turn.
 * Handles output schema from both requestOptions and nodeConfig (workflow path).
 */
function buildTurnOptions(requestOptions?: SendQueryOptions): {
  turnOptions: TurnOptions;
  hasOutputFormat: boolean;
} {
  const turnOptions: TurnOptions = {};
  const hasOutputFormat = !!(
    requestOptions?.outputFormat ?? requestOptions?.nodeConfig?.output_format
  );
  if (requestOptions?.outputFormat) {
    turnOptions.outputSchema = requestOptions.outputFormat.schema;
  }
  if (requestOptions?.nodeConfig?.output_format && !requestOptions?.outputFormat) {
    turnOptions.outputSchema = requestOptions.nodeConfig.output_format;
  }
  if (requestOptions?.abortSignal) {
    turnOptions.signal = requestOptions.abortSignal;
  }
  return { turnOptions, hasOutputFormat };
}

// ─── Stream Normalizer ───────────────────────────────────────────────────

/** State maintained across Codex event stream normalization. */
interface CodexStreamState {
  lastTodoListSignature?: string;
}

/**
 * Normalize raw Codex SDK events into Archon MessageChunks.
 * Handles structured output normalization (Codex returns JSON inline in text).
 */
async function* streamCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
  hasOutputFormat: boolean,
  threadId: string | null | undefined,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  const state: CodexStreamState = {};
  let accumulatedText = '';

  for await (const event of events) {
    if (abortSignal?.aborted) {
      getLog().info('query_aborted_between_events');
      throw new Error('Query aborted');
    }

    if (event.type === 'item.started') {
      const item = event.item as { type: string; id: string };
      getLog().debug(
        { eventType: event.type, itemType: item.type, itemId: item.id },
        'item_started'
      );
    }

    if (event.type === 'error') {
      const errorEvent = event as { message: string };
      getLog().error({ message: errorEvent.message }, 'stream_error');
      if (!errorEvent.message.includes('MCP client')) {
        yield { type: 'system', content: `⚠️ ${errorEvent.message}` };
      }
      continue;
    }

    if (event.type === 'turn.failed') {
      const errorObj = (event as { error?: { message?: string } }).error;
      const errorMessage = errorObj?.message ?? 'Unknown error';
      getLog().error({ errorMessage }, 'turn_failed');
      yield { type: 'system', content: `❌ Turn failed: ${errorMessage}` };
      break;
    }

    if (event.type === 'item.completed') {
      const item = event.item as Record<string, unknown>;
      const itemType = item.type as string;

      const logContext: Record<string, unknown> = {
        eventType: event.type,
        itemType,
        itemId: item.id,
      };
      if (itemType === 'command_execution' && item.command) {
        logContext.command = item.command;
      }
      getLog().debug(logContext, 'item_completed');

      switch (itemType) {
        case 'agent_message':
          if (item.text) {
            if (hasOutputFormat) accumulatedText += item.text as string;
            yield { type: 'assistant', content: item.text as string };
          }
          break;

        case 'command_execution':
          if (item.command) {
            const cmd = item.command as string;
            yield { type: 'tool', toolName: cmd };
            const exitCode = item.exit_code as number | null | undefined;
            const exitSuffix =
              exitCode != null && exitCode !== 0 ? `\n[exit code: ${String(exitCode)}]` : '';
            yield {
              type: 'tool_result',
              toolName: cmd,
              toolOutput: ((item.aggregated_output as string) ?? '') + exitSuffix,
            };
          } else {
            getLog().warn({ itemId: item.id }, 'command_execution_missing_command');
          }
          break;

        case 'reasoning':
          if (item.text) {
            yield { type: 'thinking', content: item.text as string };
          }
          break;

        case 'web_search':
          if (item.query) {
            const searchToolName = `🔍 Searching: ${item.query as string}`;
            yield { type: 'tool', toolName: searchToolName };
            yield { type: 'tool_result', toolName: searchToolName, toolOutput: '' };
          } else {
            getLog().debug({ itemId: item.id }, 'web_search_missing_query');
          }
          break;

        case 'todo_list': {
          const items = item.items as { text?: string; completed?: boolean }[] | undefined;
          if (Array.isArray(items) && items.length > 0) {
            const normalizedItems = items.map(t => ({
              text: typeof t.text === 'string' ? t.text : '(unnamed task)',
              completed: t.completed ?? false,
            }));
            const signature = JSON.stringify(normalizedItems);
            if (signature !== state.lastTodoListSignature) {
              state.lastTodoListSignature = signature;
              const taskList = normalizedItems
                .map(t => `${t.completed ? '✅' : '⬜'} ${t.text}`)
                .join('\n');
              yield { type: 'system', content: `📋 Tasks:\n${taskList}` };
            }
          } else {
            getLog().debug({ itemId: item.id }, 'todo_list_empty_or_invalid');
          }
          break;
        }

        case 'file_change': {
          const statusIcon = (item.status as string) === 'failed' ? '❌' : '✅';
          const rawError = 'error' in item ? (item as { error?: unknown }).error : undefined;
          const fileErrorMessage =
            typeof rawError === 'string'
              ? rawError
              : typeof rawError === 'object' && rawError !== null && 'message' in rawError
                ? String((rawError as { message: unknown }).message)
                : undefined;

          const changes = item.changes as { kind: string; path?: string }[] | undefined;
          if (Array.isArray(changes) && changes.length > 0) {
            const changeList = changes
              .map(c => {
                const icon = c.kind === 'add' ? '➕' : c.kind === 'delete' ? '➖' : '📝';
                return `${icon} ${c.path ?? '(unknown file)'}`;
              })
              .join('\n');
            const errorSuffix =
              (item.status as string) === 'failed' && fileErrorMessage
                ? `\n${fileErrorMessage}`
                : '';
            yield {
              type: 'system',
              content: `${statusIcon} File changes:\n${changeList}${errorSuffix}`,
            };
          } else if ((item.status as string) === 'failed') {
            getLog().warn(
              { itemId: item.id, status: item.status },
              'file_change_failed_no_changes'
            );
            const failMsg = fileErrorMessage
              ? `❌ File change failed: ${fileErrorMessage}`
              : '❌ File change failed';
            yield { type: 'system', content: failMsg };
          } else {
            getLog().debug({ itemId: item.id, status: item.status }, 'file_change_no_changes');
          }
          break;
        }

        case 'mcp_tool_call': {
          const server = item.server as string | undefined;
          const tool = item.tool as string | undefined;
          const toolInfo = server && tool ? `${server}/${tool}` : (tool ?? server ?? 'MCP tool');
          const mcpToolName = `🔌 MCP: ${toolInfo}`;

          yield { type: 'tool', toolName: mcpToolName };

          if ((item.status as string) === 'failed') {
            getLog().warn(
              { server, tool, error: item.error, itemId: item.id },
              'mcp_tool_call_failed'
            );
            const mcpError = item.error as { message?: string } | undefined;
            const errMsg = mcpError?.message
              ? `❌ Error: ${mcpError.message}`
              : '❌ Error: MCP tool failed';
            yield { type: 'tool_result', toolName: mcpToolName, toolOutput: errMsg };
          } else {
            let toolOutput = '';
            const mcpResult = item.result as { content?: unknown } | undefined;
            if (mcpResult?.content) {
              if (Array.isArray(mcpResult.content)) {
                toolOutput = JSON.stringify(mcpResult.content);
              } else {
                getLog().warn(
                  {
                    itemId: item.id,
                    server,
                    tool,
                    resultType: typeof mcpResult.content,
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
      const usage = extractUsageFromCodexEvent(event as TurnCompletedEvent);

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
        sessionId: threadId ?? undefined,
        tokens: usage,
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      };
      break;
    }
  }
}

// ─── Error Classification & Retry ────────────────────────────────────────

/**
 * Classify a Codex error and determine retry eligibility.
 */
function classifyAndEnrichCodexError(
  error: Error,
  model?: string
): { enrichedError: Error; errorClass: string; shouldRetry: boolean } {
  const errorClass = classifyCodexError(error.message);

  if (errorClass === 'model_access') {
    return {
      enrichedError: new Error(buildModelAccessMessage(model)),
      errorClass,
      shouldRetry: false,
    };
  }

  if (errorClass === 'auth') {
    const enrichedError = new Error(`Codex auth error: ${error.message}`);
    enrichedError.cause = error;
    return { enrichedError, errorClass, shouldRetry: false };
  }

  const enrichedError = new Error(`Codex ${errorClass}: ${error.message}`);
  enrichedError.cause = error;
  const shouldRetry = errorClass === 'rate_limit' || errorClass === 'crash';
  return { enrichedError, errorClass, shouldRetry };
}

// ─── Codex Provider ──────────────────────────────────────────────────────

/**
 * Codex AI agent provider.
 * Implements IAgentProvider with Codex SDK integration.
 *
 * sendQuery orchestrates the following internal helpers:
 * - buildThreadOptions: SDK thread configuration
 * - buildTurnOptions: per-turn configuration (output schema, abort signal)
 * - streamCodexEvents: raw SDK event normalization into MessageChunks
 * - classifyAndEnrichCodexError: error classification for retry decisions
 */
export class CodexProvider implements IAgentProvider {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  private async createCodexClient(
    configCodexBinaryPath: string | undefined,
    requestEnv?: Record<string, string>
  ): Promise<Codex> {
    if (!requestEnv || Object.keys(requestEnv).length === 0) {
      return getCodex(configCodexBinaryPath);
    }

    try {
      return new Codex({
        codexPathOverride: await resolveCodexBinaryPath(configCodexBinaryPath),
        env: buildCodexEnv(requestEnv),
      });
    } catch (error) {
      const err = error as Error;
      if (isModelAccessError(err.message)) {
        throw new Error(buildModelAccessMessage());
      }
      throw new Error(`Codex query failed: ${err.message}`);
    }
  }

  getCapabilities(): ProviderCapabilities {
    return CODEX_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const codexConfig = parseCodexConfig(assistantConfig);

    // 1. Initialize SDK and build thread options
    const codex = await this.createCodexClient(codexConfig.codexBinaryPath, requestOptions?.env);
    const threadOptions = buildThreadOptions(cwd, requestOptions?.model, assistantConfig);

    if (requestOptions?.abortSignal?.aborted) {
      throw new Error('Query aborted');
    }

    // 2. Create or resume thread
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

    // 3. Build turn options
    const { turnOptions, hasOutputFormat } = buildTurnOptions(requestOptions);
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
        // 4. Run streamed turn
        const result = await thread.runStreamed(prompt, turnOptions);

        // 5. Stream normalized events (fresh state per attempt to avoid dedup leaks)
        yield* streamCodexEvents(
          result.events as AsyncIterable<Record<string, unknown>>,
          hasOutputFormat,
          thread.id,
          requestOptions?.abortSignal
        );
        return;
      } catch (error) {
        const err = error as Error;

        if (requestOptions?.abortSignal?.aborted) {
          throw new Error('Query aborted');
        }

        const { enrichedError, errorClass, shouldRetry } = classifyAndEnrichCodexError(
          err,
          requestOptions?.model
        );

        getLog().error(
          { err, errorClass, attempt, maxRetries: MAX_SUBPROCESS_RETRIES },
          'query_error'
        );

        if (!shouldRetry || attempt >= MAX_SUBPROCESS_RETRIES) {
          throw enrichedError;
        }

        const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
        getLog().info({ attempt, delayMs, errorClass }, 'retrying_query');
        await new Promise(resolve => setTimeout(resolve, delayMs));
        lastError = enrichedError;
      }
    }

    throw lastError ?? new Error('Codex query failed after retries');
  }

  getType(): string {
    return 'codex';
  }
}
