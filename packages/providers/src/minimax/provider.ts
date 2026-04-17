/**
 * MiniMax provider
 *
 * Wraps MiniMax's OpenAI-compatible Chat Completions API.
 * Uses streaming SSE for real-time token delivery.
 *
 * Authentication: MINIMAX_API_KEY environment variable
 * Base URL: https://api.minimax.io/v1 (overseas, default)
 *
 * Supported models:
 *   - MiniMax-M2.7 (default)
 *   - MiniMax-M2.7-highspeed
 */
import type {
  IAgentProvider,
  SendQueryOptions,
  MessageChunk,
  ProviderCapabilities,
} from '../types';
import { parseMiniMaxConfig } from './config';
import { MINIMAX_CAPABILITIES } from './capabilities';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.minimax');
  return cachedLog;
}

/** Default model when none is specified */
const DEFAULT_MODEL = 'MiniMax-M2.7';

/** Overseas base URL (default) */
const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';

/** Maximum retries on rate-limit or transient errors */
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', '1002', '1039'];
const AUTH_PATTERNS = ['unauthorized', 'authentication', 'invalid', '401', '403', '1004'];

/** Classify MiniMax error for retry decisions */
function classifyError(message: string): 'rate_limit' | 'auth' | 'unknown' {
  const m = message.toLowerCase();
  if (RATE_LIMIT_PATTERNS.some(p => m.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => m.includes(p))) return 'auth';
  return 'unknown';
}

/**
 * OpenAI-compatible SSE chunk shape (simplified subset we care about).
 */
interface ChatChunkDelta {
  content?: string;
  role?: string;
}

interface ChatChunkChoice {
  delta: ChatChunkDelta;
  finish_reason?: string | null;
  index: number;
}

interface ChatCompletionChunk {
  id?: string;
  object?: string;
  choices: ChatChunkChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Parse a single SSE `data:` line into a ChatCompletionChunk.
 * Returns null for non-data lines or the [DONE] sentinel.
 */
function parseSseLine(line: string): ChatCompletionChunk | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as ChatCompletionChunk;
  } catch {
    getLog().warn({ payload }, 'minimax.sse_parse_error');
    return null;
  }
}

/**
 * Stream MiniMax OpenAI-compatible SSE response into Archon MessageChunks.
 */
async function* streamMiniMaxResponse(
  response: Response,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  if (!response.body) {
    throw new Error('MiniMax: response body is null');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let hasContent = false;

  try {
    while (true) {
      if (abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const chunk = parseSseLine(trimmed);
        if (!chunk) continue;

        // Accumulate usage if present
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        }

        for (const choice of chunk.choices) {
          const content = choice.delta.content;
          if (content) {
            hasContent = true;
            yield { type: 'assistant', content };
          }
        }
      }
    }

    // Handle any remaining buffer content
    if (buffer.trim()) {
      const chunk = parseSseLine(buffer.trim());
      if (chunk) {
        for (const choice of chunk.choices) {
          const content = choice.delta.content;
          if (content) {
            hasContent = true;
            yield { type: 'assistant', content };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!hasContent) {
    getLog().warn('minimax.empty_response');
  }

  yield {
    type: 'result',
    ...(inputTokens > 0 || outputTokens > 0
      ? { tokens: { input: inputTokens, output: outputTokens } }
      : {}),
  };
}

/**
 * Build the request body for the chat completions API.
 * Ensures temperature is within MiniMax's accepted range (0.0, 1.0].
 */
function buildRequestBody(
  messages: { role: string; content: string }[],
  model: string,
  systemPrompt?: string
): Record<string, unknown> {
  const allMessages: { role: string; content: string }[] = [];

  if (systemPrompt) {
    allMessages.push({ role: 'system', content: systemPrompt });
  }

  allMessages.push(...messages);

  return {
    model,
    messages: allMessages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 1.0, // MiniMax requires (0.0, 1.0]; 1.0 is the safe default
  };
}

// ─── MiniMax Provider ─────────────────────────────────────────────────────

/**
 * MiniMax chat provider.
 * Implements IAgentProvider using MiniMax's OpenAI-compatible API.
 *
 * Capabilities: streaming chat completions, env injection.
 * Not supported: session resume, MCP, hooks, skills, tool restrictions.
 */
export class MiniMaxProvider implements IAgentProvider {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  getCapabilities(): ProviderCapabilities {
    return MINIMAX_CAPABILITIES;
  }

  getType(): string {
    return 'minimax';
  }

  /**
   * Send a prompt to MiniMax and stream the response.
   *
   * Session resume is not supported — each call starts a fresh context.
   * The prompt is sent as a single user message.
   */
  async *sendQuery(
    prompt: string,
    _cwd: string,
    _resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = parseMiniMaxConfig(requestOptions?.assistantConfig ?? {});
    const model = requestOptions?.model ?? assistantConfig.model ?? DEFAULT_MODEL;
    const baseURL =
      requestOptions?.env?.MINIMAX_BASE_URL ?? assistantConfig.baseURL ?? DEFAULT_BASE_URL;

    // Resolve API key: injected env > process env
    const apiKey = requestOptions?.env?.MINIMAX_API_KEY ?? process.env.MINIMAX_API_KEY;

    if (!apiKey) {
      throw new Error(
        'MiniMax: MINIMAX_API_KEY is not set. ' + 'Set it in your environment or via ~/.env.local.'
      );
    }

    const body = buildRequestBody(
      [{ role: 'user', content: prompt }],
      model,
      requestOptions?.systemPrompt
    );

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      getLog().debug({ model, attempt, baseURL }, 'minimax.query_started');

      let response: Response;
      try {
        response = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: requestOptions?.abortSignal,
        });
      } catch (fetchErr) {
        const err = fetchErr as Error;
        if (err.name === 'AbortError') {
          throw new Error('Query aborted');
        }
        const errorClass = classifyError(err.message);
        const shouldRetry = errorClass === 'rate_limit' && attempt < MAX_RETRIES;
        getLog().error({ err, attempt, errorClass }, 'minimax.fetch_error');
        if (!shouldRetry) throw new Error(`MiniMax fetch error: ${err.message}`);
        const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
        getLog().info({ attempt, delayMs }, 'minimax.retrying');
        await new Promise(resolve => setTimeout(resolve, delayMs));
        lastError = err;
        continue;
      }

      if (!response.ok) {
        let errBody = '';
        try {
          errBody = await response.text();
        } catch {
          // ignore read errors
        }
        const errorMessage = `HTTP ${response.status}: ${errBody}`;
        const errorClass = classifyError(errorMessage);

        getLog().error({ status: response.status, body: errBody, attempt }, 'minimax.http_error');

        if (errorClass === 'auth') {
          throw new Error(`MiniMax auth error: ${errorMessage}`);
        }

        const shouldRetry = errorClass === 'rate_limit' && attempt < MAX_RETRIES;
        if (!shouldRetry) {
          throw new Error(`MiniMax error: ${errorMessage}`);
        }

        const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
        getLog().info({ attempt, delayMs, errorClass }, 'minimax.retrying');
        await new Promise(resolve => setTimeout(resolve, delayMs));
        lastError = new Error(errorMessage);
        continue;
      }

      try {
        yield* streamMiniMaxResponse(response, requestOptions?.abortSignal);
        return;
      } catch (streamErr) {
        const err = streamErr as Error;
        if (err.message === 'Query aborted') throw err;
        getLog().error({ err, attempt }, 'minimax.stream_error');
        if (attempt >= MAX_RETRIES) throw err;
        const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        lastError = err;
      }
    }

    throw lastError ?? new Error('MiniMax query failed after retries');
  }
}
