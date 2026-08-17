/**
 * Ollama direct HTTP provider — implements IAgentProvider via `${OLLAMA_BASE_URL}/api/chat`.
 *
 * Why a dedicated provider? Ollama is technically reachable through AiderDesk's
 * `provider: aiderdesk, model: ollama/<x>` path, but every byte that flows
 * through AiderDesk's run-prompt middleware incurs the agent-profile resolution
 * overhead + the coder-agent tool surface. For `provider:ollama` we want a
 * direct line: no agent profile, no MCP, no hooks — just NDJSON streamed tokens
 * straight into the chunk stream.
 *
 * sendQuery() flow:
 *   1. Resolve `model` (literal Ollama model name) from requestOptions. Throw
 *      `UnknownOllamaModelError` on missing — there is no useful default.
 *   2. Build an `OllamaClient` with the effective base URL.
 *   3. Log + ignore `resumeSessionId` (Ollama has no server-side session today).
 *   4. Yield `{ type: 'assistant', content: <chunk> }` for each /api/chat NDJSON
 *      `response` delta; yield a terminal `{ type: 'result' }` once we observe
 *      `done: true` or the stream ends.
 *   5. Apply best-effort structured-output augmentation (sibling of AiderDesk/Pi).
 *   6. Honour the caller's `abortSignal` via inherited AbortController wiring.
 *   7. On non-2xx response, surface `UnknownOllamaModelError` (the client already
 *      converts the upstream status).
 *
 * Archon's bash cwd-bypass contract means Ollama provider does NOT use
 * `translateProjectDir` (it's not a host-side process) — `cwd` is forwarded only
 * to the message metadata for sibling context.
 */
import { createLogger } from '@archon/paths';
import {
  augmentPromptForJsonSchema,
  tryParseStructuredOutput,
} from '../shared/structured-output';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../types';
import { OLLAMA_CAPABILITIES } from './capabilities';
import { OllamaClient, ollamaEventContent, type FetchFn } from './client';
import { UnknownOllamaModelError } from './errors';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.ollama');
  return cachedLog;
}

export class OllamaProvider implements IAgentProvider {
  private readonly fetchFn: FetchFn | undefined;

  constructor(options?: { fetchFn?: FetchFn; baseUrl?: string }) {
    this.fetchFn = options?.fetchFn;
    // baseUrl is captured by the per-call client, not the provider — keeps
    // the constructor pure and matches the AiderDesk pattern.
    void options?.baseUrl;
  }

  getType(): string {
    return 'ollama';
  }

  getCapabilities(): ProviderCapabilities {
    return OLLAMA_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const log = getLog();
    const abortSignal = requestOptions?.abortSignal;

    // ── 1. Resolve model from requestOptions only ─────────────────────────
    // Ollama is the model — there is no agent-profile concept. The assistant
    // config may carry a universal default `model`, but `requestOptions.model`
    // wins when present (per the universal precedence: node > assistant).
    const model = requestOptions?.model ?? assistantDefaultModel(requestOptions);
    if (!model || typeof model !== 'string' || model.trim().length === 0) {
      throw new UnknownOllamaModelError(
        model ?? '(missing)',
        'No model supplied. Use a literal Ollama model name (e.g. "internlm/internlm2.5:7b-8k").'
      );
    }

    if (resumeSessionId) {
      // Ollama has no server-side session concept in v1; log + ignore.
      log.debug(
        { resumeSessionId },
        'ollama.resume_ignored_no_server_side_session'
      );
    }

    // ── 2. Build per-call client with effective base URL ─────────────────
    const client = new OllamaClient({
      fetchFn: this.fetchFn,
      baseUrl: requestOptions?.env?.OLLAMA_BASE_URL,
    });

    // `cwd` is forwarded only to a metadata chunk — Ollama is stateless for
    // archon's purposes. The provider does NOT own a host-side cwd binding
    // (that's bash's job).
    yield { type: 'system', content: `cwd=${cwd}` };

    // ── 3. Optional structured-output prompt augmentation ───────────────
    let effectivePrompt = prompt;
    if (requestOptions?.outputFormat?.schema) {
      effectivePrompt = augmentPromptForJsonSchema(prompt, requestOptions.outputFormat.schema);
    }

    // ── 4. Stream NDJSON → assistant chunks; yield final result ──────────
    let accumulated = '';
    let doneSeen = false;

    try {
      for await (const ev of client.chat({
        model,
        prompt: effectivePrompt,
        signal: abortSignal,
      })) {
        // Ollama's /api/chat emits `{message:{role,content}}` per chunk; we
        // also accept the flat `{response}` shape as a defensive fallback.
        // See ollamaEventContent(src/ollama/client.ts) for the precedence.
        const delta = ollamaEventContent(ev);
        if (delta !== null) {
          accumulated += delta;
          yield { type: 'assistant', content: delta };
        }
        if (ev.done === true) {
          doneSeen = true;
        }
        if (typeof ev.error === 'string' && ev.error.length > 0) {
          throw new UnknownOllamaModelError(model, ev.error);
        }
      }
    } catch (error) {
      // client.chat already converts non-2xx → UnknownOllamaModelError. Aborts
      // arrive as plain Error — surface as a fatal result chunk so the engine
      // can finalize the lock cleanly.
      const message = error instanceof Error ? error.message : String(error);
      const isAbort = abortSignal?.aborted ?? false;
      log.warn({ error: message, isAbort }, 'ollama.stream_failed');
      yield { type: 'system', content: `⚠️ Ollama stream failed: ${message}` };
      yield {
        type: 'result',
        isError: true,
        errors: [message],
        stopReason: isAbort ? 'interrupted' : 'error',
      };
      return;
    }

    // ── 5. Apply best-effort structured output parse if requested ───────
    let structuredOutput: unknown;
    if (requestOptions?.outputFormat?.schema && accumulated.length > 0) {
      structuredOutput = tryParseStructuredOutput(accumulated);
    }

    yield {
      type: 'result',
      isError: false,
      stopReason: 'end_turn',
      structuredOutput,
      resolvedModel: { id: model },
    };
    // doneSeen is referenced to keep the type signature stable for downstream
    // instrumentation (a future debug-only log here when done isn't carried).
    void doneSeen;
  }
}

/**
 * Extract a generic string `model` from the assistant-defaults bag. The
 * Ollama provider has no dedicated `OllamaProviderDefaults` interface today —
 * using the documented `model` slot keeps the wire simple.
 */
function assistantDefaultModel(opts?: SendQueryOptions): string | undefined {
  const cfg = opts?.assistantConfig;
  if (cfg && typeof cfg === 'object' && typeof (cfg as { model?: unknown }).model === 'string') {
    return (cfg as { model: string }).model;
  }
  return undefined;
}
