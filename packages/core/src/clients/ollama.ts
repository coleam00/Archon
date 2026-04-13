/**
 * Ollama local LLM client
 *
 * POSTs to the Ollama /api/chat endpoint with `stream: true` and reads
 * the response as newline-delimited JSON. Each line is parsed as an
 * OllamaChatChunk; content deltas are yielded as MessageChunks until
 * the server sends `done: true` with final token counts.
 *
 * Of the AssistantRequestOptions fields, `model`, `systemPrompt`, and
 * `abortSignal` are forwarded to the /api/chat payload.
 *
 * Extending Ollama's agentic footprint — running local models as domain-expert
 * nodes in multi-step workflows, cross-domain consults, and offline-capable
 * pipeline steps — is a natural next direction for this integration.
 */
import type { IAssistantClient, AssistantRequestOptions, MessageChunk } from '../types';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.ollama');
  return cachedLog;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const CHAT_PATH = '/api/chat';

/** Shape of each streamed NDJSON chunk from Ollama /api/chat */
interface OllamaChatChunk {
  model: string;
  message?: { role: string; content: string };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama AI assistant client.
 * Implements IAssistantClient via the Ollama REST API.
 */
export class OllamaClient implements IAssistantClient {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL;
  }

  /**
   * Send a prompt to Ollama and stream the response as MessageChunks.
   * Requires `options.model` to be set — Ollama has no default model.
   */
  async *sendQuery(
    prompt: string,
    _cwd: string,
    _resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    const model = options?.model;
    if (!model) {
      throw new Error(
        'Ollama requires a model to be specified. ' +
          'Set `model` in your workflow or .archon/config.yaml assistants.ollama.model.'
      );
    }

    const messages: { role: string; content: string }[] = [];
    if (options?.systemPrompt && typeof options.systemPrompt === 'string') {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const url = `${this.baseUrl}${CHAT_PATH}`;
    getLog().info({ model, url, messageCount: messages.length }, 'ollama.query_started');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true }),
        signal: options?.abortSignal,
      });
    } catch (err) {
      const error = err as Error;
      if (error.name === 'AbortError') throw new Error('Query aborted');
      throw new Error(
        `Ollama connection failed at ${url}: ${error.message}. ` +
          'Is Ollama running? Try: ollama serve'
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Ollama API error ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`
      );
    }

    if (!response.body) {
      throw new Error('Ollama API returned no response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep incomplete last line in buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk: OllamaChatChunk;
          try {
            chunk = JSON.parse(trimmed) as OllamaChatChunk;
          } catch {
            getLog().warn({ line: trimmed }, 'ollama.unparseable_chunk');
            continue;
          }

          if (!chunk.done) {
            const content = chunk.message?.content ?? '';
            if (content) {
              yield { type: 'assistant', content };
            }
          } else {
            inputTokens = chunk.prompt_eval_count ?? 0;
            outputTokens = chunk.eval_count ?? 0;
            getLog().info(
              { model, inputTokens, outputTokens, doneReason: chunk.done_reason },
              'ollama.query_completed'
            );
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      type: 'result',
      ...(inputTokens || outputTokens
        ? {
            tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
          }
        : {}),
    };
  }

  /** Returns the assistant type identifier used by the factory and config. */
  getType(): string {
    return 'ollama';
  }
}
