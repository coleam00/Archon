/**
 * Ollama direct HTTP client.
 *
 * Thin wrapper around `${baseUrl}/api/chat` posting NDJSON streamed response
 * deltas. Used by `OllamaProvider`; tests inject a fake `fetchFn` to assert
 * request shape and stream parsing.
 *
 * Base URL precedence (highest first):
 *   1. `requestOptions.env.OLLAMA_BASE_URL` (per-call codebase env)
 *   2. `process.env.OLLAMA_BASE_URL` (host-side)
 *   3. `DEFAULT_OLLAMA_BASE_URL` (`http://localhost:11434/`)
 *
 * The trailing slash on the default is deliberate: Ollama's API namespace is
 * `/api/...`, and concatenating without normalizing avoids both
 * `http://x:11434//api/...` (double slash) and `http://x:11434api/...` (missing
 * slash) bugs.
 */
import { UnknownOllamaModelError } from './errors';

/** Fetch function type — matches global `fetch` for DI in tests. */
export type FetchFn = typeof fetch;

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/';

const OLLAMA_DEFAULT_TIMEOUT_MS = 300_000; // 5 min — caps a single /api/chat stream

/**
 * Resolve the effective Ollama base URL from the precedence chain.
 *
 * Returns the trimmed, trailing-slash-stripped URL ready for concatenation
 * with `/api/chat`.
 */
export function resolveOllamaBaseUrl(requestOptionsBaseUrl?: string | undefined): string {
  const url =
    requestOptionsBaseUrl ?? (typeof process !== 'undefined' ? process.env.OLLAMA_BASE_URL : undefined) ??
    DEFAULT_OLLAMA_BASE_URL;
  return url.replace(/\/+$/, '');
}

/**
 * A single NDJSON event yielded by `/api/chat` (stream format).
 *
 * Ollama's `/api/chat` streaming wire format emits a top-level `message`
 * object whose `content` field carries the assistant delta for this tick
 * (e.g. `"Sure"`, `","`, `" what's your"`). The flat `response` field is a
 * legacy/some-other-API shape — present in our own early test fixtures but
 * never produced by Ollama itself. `OllamaProvider` reads `message.content`
 * first and only falls back to `response` if the upstream is misrouted.
 */
export interface OllamaChatEvent {
  /** Legacy/shim: flat-string delta. Ollama does NOT emit this; ignore on first. */
  response?: string;
  /** Ollama-shape: assistant message delta carrier. */
  message?: {
    role?: 'user' | 'assistant' | 'system' | string;
    content?: string;
  };
  /** Whether this is the terminal event of the stream. */
  done?: boolean;
  /** Error message if Ollama returned a structured error mid-stream. */
  error?: string;
  /** Ollama model name as reported by the server (free-form metadata). */
  model?: string;
  /** Capture only the fields we care about — Ollama emits many more. */
  [key: string]: unknown;
}

/**
 * Extract the assistant delta from an Ollama NDJSON event.
 *
 * Reads `message.content` first (the live Ollama shape — verified with a raw
 * `curl -N http://100.66.140.50:11434/api/chat` against the operator's
 * shin-blackmamba:11434), falls back to `response` (a non-Ollama legacy). If
 * neither is set, returns `null` and the caller skips the event.
 *
 * Exposed for unit tests; not a hot-path API.
 */
export function ollamaEventContent(ev: OllamaChatEvent): string | null {
  const msg = ev.message?.content;
  if (typeof msg === 'string' && msg.length > 0) return msg;
  const flat = ev.response;
  if (typeof flat === 'string' && flat.length > 0) return flat;
  return null;
}

export interface OllamaChatOptions {
  model: string;
  prompt: string;
  /** Optional abort signal — forwarded into the fetch call. */
  signal?: AbortSignal;
  /** Optional timeout in ms (default 300_000). */
  timeoutMs?: number;
  /** Override the base URL for testing. */
  baseUrl?: string;
}

export class OllamaClient {
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: { fetchFn?: FetchFn; baseUrl?: string; timeoutMs?: number } = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.baseUrl = resolveOllamaBaseUrl(options.baseUrl);
    this.defaultTimeoutMs = options.timeoutMs ?? OLLAMA_DEFAULT_TIMEOUT_MS;
  }

  /**
   * POST `/api/chat` and yield NDJSON events.
   *
   * The Ollama HTTP API returns `application/x-ndjson` with one JSON object per
   * line. We decode the body and split on `\n`, parse each non-empty line, and
   * yield to the caller.
   *
   * Errors:
   *   - non-2xx response → throw `UnknownOllamaModelError(model, bodySnippet)`
   *     with the first 200 chars of the response body (defensive truncation).
   *   - active `signal` mid-stream → throw a plain `Error` (the caller converts
   *     to its aborted-class internally).
   */
  async *chat(opts: OllamaChatOptions): AsyncGenerator<OllamaChatEvent> {
    const url = `${this.baseUrl}/api/chat`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.defaultTimeoutMs);

    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: 'user', content: opts.prompt }],
          stream: true,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const snippet = bodyText.length > 200 ? `${bodyText.slice(0, 200)}…` : bodyText;
      throw new UnknownOllamaModelError(opts.model, snippet);
    }

    if (!response.body) {
      // No body AND no error — emit a synthetic terminal event so the caller
      // can finalize cleanly.
      yield { done: true };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nlIdx = buffer.indexOf('\n');
        while (nlIdx !== -1) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (line.length > 0) {
            try {
              const parsed = JSON.parse(line) as OllamaChatEvent;
              yield parsed;
            } catch {
              // Drop malformed NDJSON line. Conservative — Ollama never emits
              // garbage on a healthy connection, so a parse failure here means
              // the upstream rewrote the stream. Better to skip than to throw
              // and tear down a still-streaming response.
              continue;
            }
          }
          nlIdx = buffer.indexOf('\n');
        }
      }
      // Flush any trailing line at the end of the stream (no final newline).
      const trailing = buffer.trim();
      if (trailing.length > 0) {
        try {
          yield JSON.parse(trailing) as OllamaChatEvent;
        } catch {
          /* drop on parse error */
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }
}
