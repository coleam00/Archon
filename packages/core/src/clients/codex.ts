/**
 * Codex SDK wrapper
 * Provides async generator interface for streaming Codex responses
 *
 * With Bun runtime, we can directly import ESM packages without the
 * dynamic import workaround that was needed for CommonJS/Node.js.
 */
import {
  Codex,
  type ThreadOptions,
  type TurnOptions,
  type TurnCompletedEvent,
} from '@openai/codex-sdk';
import {
  type AssistantRequestOptions,
  type IAssistantClient,
  type MessageChunk,
  type TokenUsage,
} from '../types';
import { createLogger } from '@archon/paths';
import { scanPathForSensitiveKeys, EnvLeakError } from '../utils/env-leak-scanner';
import * as codebaseDb from '../db/codebases';
import { loadConfig } from '../config/config-loader';
import { resolveCodexBinaryPath } from '../utils/codex-binary-resolver';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.codex');
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
 * Async because in compiled binary mode, binary path resolution is async.
 * Once initialized, the binary path is fixed for the process lifetime.
 */
async function getCodex(configCodexBinaryPath?: string): Promise<Codex> {
  if (codexInstance) return codexInstance;

  // Prevent concurrent initialization race
  if (!codexInitPromise) {
    codexInitPromise = (async (): Promise<Codex> => {
      const codexPathOverride = await resolveCodexBinaryPath(configCodexBinaryPath);
      const instance = new Codex({ codexPathOverride });
      codexInstance = instance;
      return instance;
    })().catch(err => {
      // Clear promise so next call can retry (e.g. after user installs Codex)
      codexInitPromise = null;
      throw err;
    });
  }
  return codexInitPromise;
}

/**
 * Build thread options for Codex SDK
 * Extracted to avoid duplication across thread creation paths
 */
function buildThreadOptions(cwd: string, options?: AssistantRequestOptions): ThreadOptions {
  return {
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access', // Full filesystem access (needed for git worktree operations)
    networkAccessEnabled: true, // Allow network calls (GitHub CLI, HTTP requests)
    approvalPolicy: 'never', // Auto-approve all operations without user confirmation
    model: options?.model,
    modelReasoningEffort: options?.modelReasoningEffort,
    webSearchMode: options?.webSearchMode,
    additionalDirectories: options?.additionalDirectories,
  };
}

const CODEX_MODEL_FALLBACKS: Record<string, string> = {
  'gpt-5.4': 'gpt-5.3-codex',
  'gpt-5.4-mini': 'gpt-5.4',
  'gpt-5.3-codex': 'gpt-5.2-codex',
};

function isModelAccessError(errorMessage: string): boolean {
  const m = errorMessage.toLowerCase();
  const hasModel = m.includes('model');
  const hasAvailabilitySignal =
    m.includes('not available') ||
    m.includes('not found') ||
    m.includes('access denied') ||
    m.includes('not supported');
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

  return `❌ Model "${selectedModel}" is not available for your account.\n\nThis can happen when the model is unavailable or not supported in your current Codex runtime.\n\n${fixLine}\n\n${workflowLine}`;
}

/** Max retries for transient failures (3 = 4 total attempts).
 *  Mirrors ClaudeClient retry logic — Codex process crashes are similarly intermittent. */
const MAX_SUBPROCESS_RETRIES = 3;

/** Delay between retries in milliseconds */
const RETRY_BASE_DELAY_MS = 2000;

/** Patterns indicating rate limiting in error messages */
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];

/** Patterns indicating auth issues in error messages */
const AUTH_PATTERNS = [
  'credit balance',
  'unauthorized',
  'authentication',
  'invalid token',
  '401',
  '403',
];

/** Patterns indicating a transient process crash (worth retrying) */
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
 * Codex AI assistant client
 * Implements generic IAssistantClient interface
 */
export class CodexClient implements IAssistantClient {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  /**
   * Send a query to Codex and stream responses
   * @param prompt - User message or prompt
   * @param cwd - Working directory for Codex
   * @param resumeSessionId - Optional thread ID to resume
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    // Load config once — used for env-leak gate and (on first call) codexBinaryPath resolution.
    let mergedConfig: Awaited<ReturnType<typeof loadConfig>> | undefined;
    try {
      mergedConfig = await loadConfig(cwd);
    } catch (configErr) {
      // Fail-closed: config load failure enforces the env-leak gate (allowTargetRepoKeys stays false)
      getLog().warn({ err: configErr, cwd }, 'env_leak_gate.config_load_failed_gate_enforced');
    }

    // Pre-spawn: check for env key leak if codebase is not explicitly consented.
    // Use prefix lookup so worktree paths (e.g. .../worktrees/feature-branch) still
    // match the registered source cwd (e.g. .../source).
    const codebase =
      (await codebaseDb.findCodebaseByDefaultCwd(cwd)) ??
      (await codebaseDb.findCodebaseByPathPrefix(cwd));
    if (codebase && !codebase.allow_env_keys) {
      // Fail-closed: a config load failure must NOT silently bypass the gate.
      const allowTargetRepoKeys = mergedConfig?.allowTargetRepoKeys ?? false;
      if (!allowTargetRepoKeys) {
        const report = scanPathForSensitiveKeys(cwd);
        if (report.findings.length > 0) {
          throw new EnvLeakError(report, 'spawn-existing');
        }
      }
    }

    // Initialize Codex SDK with binary path override (resolved from env/config/vendor).
    // In dev mode, resolveCodexBinaryPath returns undefined and the SDK uses node_modules.
    // In binary mode, it resolves from env/config/vendor or throws with install instructions.
    const codex = await getCodex(mergedConfig?.assistants.codex.codexBinaryPath);
    const threadOptions = buildThreadOptions(cwd, options);

    // Check if already aborted before starting
    if (options?.abortSignal?.aborted) {
      throw new Error('Query aborted');
    }

    // Track if we fell back from a failed resume (to notify user)
    let sessionResumeFailed = false;

    // Get or create thread (synchronous operations!)
    let thread;
    if (resumeSessionId) {
      getLog().debug({ sessionId: resumeSessionId }, 'resuming_thread');
      try {
        // NOTE: resumeThread is synchronous, not async
        // IMPORTANT: Must pass options when resuming!
        thread = codex.resumeThread(resumeSessionId, threadOptions);
      } catch (error) {
        getLog().error({ err: error, sessionId: resumeSessionId }, 'resume_thread_failed');
        // Fall back to creating new thread
        try {
          thread = codex.startThread(threadOptions);
        } catch (startError) {
          const err = startError as Error;
          if (isModelAccessError(err.message)) {
            throw new Error(buildModelAccessMessage(options?.model));
          }
          throw new Error(`Codex query failed: ${err.message}`);
        }
        sessionResumeFailed = true;
      }
    } else {
      getLog().debug({ cwd }, 'starting_new_thread');
      // NOTE: startThread is synchronous, not async
      try {
        thread = codex.startThread(threadOptions);
      } catch (error) {
        const err = error as Error;
        if (isModelAccessError(err.message)) {
          throw new Error(buildModelAccessMessage(options?.model));
        }
        throw new Error(`Codex query failed: ${err.message}`);
      }
    }

    // Notify user if session resume failed (don't silently lose context)
    if (sessionResumeFailed) {
      yield {
        type: 'system',
        content: '⚠️ Could not resume previous session. Starting fresh conversation.',
      };
    }

    let lastTodoListSignature: string | undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
      // Check abort signal before each attempt
      if (options?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      // On retries, create a fresh thread (crashed thread is invalid)
      if (attempt > 0) {
        getLog().debug({ cwd, attempt }, 'starting_new_thread');
        try {
          thread = codex.startThread(threadOptions);
        } catch (startError) {
          const err = startError as Error;
          if (isModelAccessError(err.message)) {
            throw new Error(buildModelAccessMessage(options?.model));
          }
          throw new Error(`Codex query failed: ${err.message}`);
        }
      }

      try {
        // Build per-turn options (structured output schema, abort signal)
        const turnOptions: TurnOptions = {};
        if (options?.outputFormat) {
          turnOptions.outputSchema = options.outputFormat.schema;
        }
        if (options?.abortSignal) {
          turnOptions.signal = options.abortSignal;
        }

        // Run streamed query (this IS async)
        const result = await thread.runStreamed(prompt, turnOptions);

        // Process streaming events
        for await (const event of result.events) {
          // Check abort signal between events
          if (options?.abortSignal?.aborted) {
            getLog().info('query_aborted_between_events');
            break;
          }

          // Log progress for item.started (visibility fix for Codex appearing to hang)
          if (event.type === 'item.started') {
            const item = event.item;
            getLog().debug(
              { eventType: event.type, itemType: item.type, itemId: item.id },
              'item_started'
            );
          }

          // Handle error events
          if (event.type === 'error') {
            getLog().error({ message: event.message }, 'stream_error');
            // Don't send MCP timeout errors (they're optional)
            if (!event.message.includes('MCP client')) {
              yield { type: 'system', content: `⚠️ ${event.message}` };
            }
            continue;
          }

          // Handle turn failed events
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

          // Handle item.completed events - map to MessageChunk types
          if (event.type === 'item.completed') {
            const item = event.item;

            // Log progress with context for debugging
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
                // Agent text response
                if (item.text) {
                  yield { type: 'assistant', content: item.text };
                }
                break;

              case 'command_execution':
                // Tool/command execution. The Codex SDK only emits item.completed
                // once the command has fully run, so we emit the start + result
                // back-to-back to close the UI's tool card immediately. Without
                // the paired tool_result, the card spins forever until lock release.
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
                // Agent reasoning/thinking
                if (item.text) {
                  yield { type: 'thinking', content: item.text };
                }
                break;

              case 'web_search':
                if (item.query) {
                  const searchToolName = `🔍 Searching: ${item.query}`;
                  yield { type: 'tool', toolName: searchToolName };
                  // Web search items only fire on completion, so close the card immediately.
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

                // Always emit start+result so the UI card closes. item.completed
                // fires once the call is final (completed or failed).
                yield { type: 'tool', toolName: mcpToolName };

                if (item.status === 'failed') {
                  getLog().warn(
                    { server: item.server, tool: item.tool, error: item.error, itemId: item.id },
                    'mcp_tool_call_failed'
                  );
                  const errMsg = item.error?.message
                    ? `❌ Error: ${item.error.message}`
                    : '❌ Error: MCP tool failed';
                  yield { type: 'tool_result', toolName: mcpToolName, toolOutput: errMsg };
                } else {
                  // status === 'completed' (or 'in_progress', which shouldn't reach
                  // item.completed but is closed defensively).
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

              // Other item types are ignored (like file edits, etc.)
            }
          }

          // Handle turn.completed event
          if (event.type === 'turn.completed') {
            getLog().debug('turn_completed');
            // Yield result with thread ID for persistence
            const usage = extractUsageFromCodexEvent(event);
            yield {
              type: 'result',
              sessionId: thread.id ?? undefined,
              tokens: usage,
            };
            // CRITICAL: Break out of event loop - turn is complete!
            // Without this, the loop waits for stream to end (causes 90s timeout)
            break;
          }
        }
        return; // Success - exit retry loop
      } catch (error) {
        const err = error as Error;

        // Don't retry aborted queries
        if (options?.abortSignal?.aborted) {
          throw new Error('Query aborted');
        }

        const errorClass = classifyCodexError(err.message);
        getLog().error(
          { err, errorClass, attempt, maxRetries: MAX_SUBPROCESS_RETRIES },
          'query_error'
        );

        // Model access errors are never retryable
        if (errorClass === 'model_access') {
          throw new Error(buildModelAccessMessage(options?.model));
        }

        // Auth errors won't resolve on retry
        if (errorClass === 'auth') {
          const enrichedError = new Error(`Codex auth error: ${err.message}`);
          enrichedError.cause = error;
          throw enrichedError;
        }

        // Retry transient failures (rate limit, crash)
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

        // Final failure - enrich and throw
        const enrichedError = new Error(`Codex ${errorClass}: ${err.message}`);
        enrichedError.cause = error;
        throw enrichedError;
      }
    }

    // Should not reach here, but handle defensively
    throw lastError ?? new Error('Codex query failed after retries');
  }

  /**
   * Get the assistant type identifier
   */
  getType(): string {
    return 'codex';
  }
}
