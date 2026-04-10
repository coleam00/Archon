/**
 * Qwen Code SDK wrapper
 *
 * Provides async generator interface for streaming Qwen responses. The Qwen
 * SDK is closer to the Codex SDK than Claude's Agent SDK, so this client
 * maps streamed SDK messages into Archon's generic MessageChunk stream.
 */
import {
  query,
  isSDKAssistantMessage,
  isSDKPartialAssistantMessage,
  isSDKResultMessage,
  isSDKSystemMessage,
  type QueryOptions,
  type SDKAssistantMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
} from '@qwen-code/sdk';
import type { AssistantRequestOptions, IAssistantClient, MessageChunk, TokenUsage } from '../types';
import { createLogger } from '@archon/paths';
import { buildCleanSubprocessEnv } from '../utils/env-allowlist';
import { scanPathForSensitiveKeys, EnvLeakError } from '../utils/env-leak-scanner';
import * as codebaseDb from '../db/codebases';
import { loadConfig } from '../config/config-loader';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.qwen');
  return cachedLog;
}

const MAX_QUERY_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
const AUTH_PATTERNS = ['unauthorized', 'authentication', 'invalid token', '401', '403'];
const CRASH_PATTERNS = ['exited with code', 'killed', 'signal'];

function isModelAccessError(errorMessage: string): boolean {
  const m = errorMessage.toLowerCase();
  return (
    m.includes('model') &&
    (m.includes('not available') || m.includes('not found') || m.includes('access denied'))
  );
}

function classifyQwenError(
  errorMessage: string
): 'rate_limit' | 'auth' | 'crash' | 'model_access' | 'unknown' {
  if (isModelAccessError(errorMessage)) return 'model_access';
  const m = errorMessage.toLowerCase();
  if (RATE_LIMIT_PATTERNS.some(p => m.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => m.includes(p))) return 'auth';
  if (CRASH_PATTERNS.some(p => m.includes(p))) return 'crash';
  return 'unknown';
}

function buildModelAccessMessage(model?: string): string {
  const normalizedModel = model?.trim();
  const selectedModel = normalizedModel || 'the configured model';
  return (
    `❌ Model "${selectedModel}" is not available for your Qwen account.\n\n` +
    'To fix: update your model in ~/.archon/config.yaml under `assistants.qwen.model` to one your account can access.\n\n' +
    'Or set it per-workflow with `model: qwen-max` (or another available Qwen model).'
  );
}

function extractUsageFromQwenEvent(event: SDKResultMessage): TokenUsage {
  const usage = event.usage;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    ...(typeof usage.total_tokens === 'number' ? { total: usage.total_tokens } : {}),
  };
}

function buildQwenEnv(
  mergedEnv?: Record<string, string>,
  extraEnv?: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const source of [buildCleanSubprocessEnv(), mergedEnv ?? {}, extraEnv ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
  }
  return env;
}

function serializeContentBlockContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map(block => {
        if (block && typeof block === 'object') {
          const typed = block as Record<string, unknown>;
          if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
        }
        return JSON.stringify(block);
      })
      .join('\n');
    return text;
  }
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

function emitAssistantMessageBlocks(
  message: SDKAssistantMessage,
  shouldEmitText: boolean
): MessageChunk[] {
  const chunks: MessageChunk[] = [];
  const toolNames = new Map<string, string>();
  for (const block of message.message.content) {
    switch (block.type) {
      case 'text':
        if (shouldEmitText && block.text) {
          chunks.push({ type: 'assistant', content: block.text });
        }
        break;
      case 'thinking':
        if (shouldEmitText && block.thinking) {
          chunks.push({ type: 'thinking', content: block.thinking });
        }
        break;
      case 'tool_use':
        if (block.id) toolNames.set(block.id, block.name);
        chunks.push({
          type: 'tool',
          toolName: block.name,
          toolInput:
            block.input && typeof block.input === 'object'
              ? (block.input as Record<string, unknown>)
              : undefined,
          toolCallId: block.id,
        });
        break;
      case 'tool_result':
        chunks.push({
          type: 'tool_result',
          toolName:
            (block.tool_use_id && toolNames.get(block.tool_use_id)) || block.tool_use_id || 'tool',
          toolOutput: serializeContentBlockContent(block.content),
          toolCallId: block.tool_use_id,
        });
        break;
    }
  }
  return chunks;
}

function emitPartialMessage(event: SDKPartialAssistantMessage): MessageChunk[] {
  const chunks: MessageChunk[] = [];
  switch (event.event.type) {
    case 'content_block_start': {
      const block = event.event.content_block;
      if (block.type === 'tool_use') {
        chunks.push({
          type: 'tool',
          toolName: block.name,
          toolInput:
            block.input && typeof block.input === 'object'
              ? (block.input as Record<string, unknown>)
              : undefined,
          toolCallId: block.id,
        });
      }
      break;
    }
    case 'content_block_delta': {
      const delta = event.event.delta;
      if (delta.type === 'text_delta' && delta.text) {
        chunks.push({ type: 'assistant', content: delta.text });
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        chunks.push({ type: 'thinking', content: delta.thinking });
      }
      break;
    }
  }
  return chunks;
}

export class QwenClient implements IAssistantClient {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    let mergedConfig: Awaited<ReturnType<typeof loadConfig>> | undefined;
    try {
      mergedConfig = await loadConfig(cwd);
    } catch (configErr) {
      getLog().warn({ err: configErr, cwd }, 'env_leak_gate.config_load_failed_gate_enforced');
    }

    const codebase =
      (await codebaseDb.findCodebaseByDefaultCwd(cwd)) ??
      (await codebaseDb.findCodebaseByPathPrefix(cwd));
    if (codebase && !codebase.allow_env_keys) {
      const allowTargetRepoKeys = mergedConfig?.allowTargetRepoKeys ?? false;
      if (!allowTargetRepoKeys) {
        const report = scanPathForSensitiveKeys(cwd);
        if (report.findings.length > 0) {
          throw new EnvLeakError(report, 'spawn-existing');
        }
      }
    }

    const qwenDefaults = mergedConfig?.assistants.qwen;
    const includePartialMessages = qwenDefaults?.includePartialMessages ?? true;
    const permissionMode = qwenDefaults?.permissionMode ?? 'yolo';
    const authType = qwenDefaults?.authType ?? 'openai';
    const pathToQwenExecutable = qwenDefaults?.pathToQwenExecutable;

    const queryOptions: QueryOptions = {
      cwd,
      model: options?.model ?? qwenDefaults?.model,
      pathToQwenExecutable,
      env: buildQwenEnv(mergedConfig?.envVars, options?.env),
      systemPrompt: options?.systemPrompt,
      permissionMode,
      mcpServers: options?.mcpServers,
      allowedTools: options?.allowedTools,
      excludeTools: options?.disallowedTools,
      coreTools: options?.tools,
      authType,
      includePartialMessages,
      resume: resumeSessionId,
      abortController: options?.abortSignal
        ? ((): AbortController => {
            const controller = new AbortController();
            if (options.abortSignal.aborted) controller.abort();
            else {
              options.abortSignal.addEventListener(
                'abort',
                () => {
                  controller.abort();
                },
                { once: true }
              );
            }
            return controller;
          })()
        : undefined,
    };

    if (options?.abortSignal?.aborted) {
      throw new Error('Query aborted');
    }

    let sessionResumeFailed = false;
    let lastError: Error | undefined;
    let resumeEnabled = Boolean(resumeSessionId);

    for (let attempt = 0; attempt <= MAX_QUERY_RETRIES; attempt++) {
      if (options?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      const shouldStreamPartials = includePartialMessages;
      let sawPartialAssistantMessage = false;
      const attemptOptions: QueryOptions = {
        ...queryOptions,
        resume: resumeEnabled ? resumeSessionId : undefined,
      };

      try {
        const stream = query({ prompt, options: attemptOptions });
        for await (const message of stream) {
          if (options?.abortSignal?.aborted) {
            throw new Error('Query aborted');
          }

          if (isSDKPartialAssistantMessage(message)) {
            sawPartialAssistantMessage = true;
            for (const chunk of emitPartialMessage(message)) {
              yield chunk;
            }
            continue;
          }

          if (isSDKAssistantMessage(message)) {
            for (const chunk of emitAssistantMessageBlocks(
              message,
              !shouldStreamPartials || !sawPartialAssistantMessage
            )) {
              yield chunk;
            }
            continue;
          }

          if (isSDKSystemMessage(message)) {
            if (message.subtype && message.subtype !== 'init') {
              yield { type: 'system', content: `⚠️ ${message.subtype}` };
            }
            continue;
          }

          if (isSDKResultMessage(message)) {
            yield {
              type: 'result',
              sessionId: message.session_id,
              tokens: extractUsageFromQwenEvent(message),
              isError: message.is_error,
              errorSubtype: message.subtype,
              numTurns: message.num_turns,
              modelUsage: message.modelUsage,
            };
            break;
          }
        }
        return;
      } catch (error) {
        const err = error as Error;
        if (options?.abortSignal?.aborted) {
          throw new Error('Query aborted');
        }

        const errorClass = classifyQwenError(err.message);
        getLog().error({ err, errorClass, attempt, maxRetries: MAX_QUERY_RETRIES }, 'query_error');

        if (errorClass === 'model_access') {
          throw new Error(buildModelAccessMessage(options?.model ?? qwenDefaults?.model));
        }

        if (errorClass === 'auth') {
          const enrichedError = new Error(`Qwen auth error: ${err.message}`);
          enrichedError.cause = error;
          throw enrichedError;
        }

        if (
          resumeEnabled &&
          !sessionResumeFailed &&
          errorClass !== 'rate_limit' &&
          errorClass !== 'crash'
        ) {
          sessionResumeFailed = true;
          resumeEnabled = false;
          getLog().warn(
            { sessionId: resumeSessionId, err },
            'resume_session_failed_falling_back_to_fresh_turn'
          );
          yield {
            type: 'system',
            content: '⚠️ Could not resume previous Qwen session. Starting a fresh conversation.',
          };
          lastError = err;
          continue;
        }

        if (
          attempt < MAX_QUERY_RETRIES &&
          (errorClass === 'rate_limit' || errorClass === 'crash')
        ) {
          const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          getLog().info({ attempt, delayMs, errorClass }, 'retrying_query');
          await new Promise(resolve => setTimeout(resolve, delayMs));
          lastError = err;
          continue;
        }

        const enrichedError = new Error(`Qwen ${errorClass}: ${err.message}`);
        enrichedError.cause = error;
        throw enrichedError;
      }
    }

    throw lastError ?? new Error('Qwen query failed after retries');
  }

  getType(): string {
    return 'qwen';
  }
}
