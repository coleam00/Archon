/**
 * AiderDesk REST API client.
 *
 * Wraps all AiderDesk REST endpoints (localhost:24337/api) using a thin
 * fetch-based client with an injectable fetchFn for testability (DI pattern
 * matching Claude's Spawner approach — avoids mock.module pollution).
 *
 * AiderDesk's REST API uses NO authentication. The base URL is resolved from
 * env var AIDERDESK_API_URL, defaulting to the Docker bridge gateway when
 * running inside a container.
 */
import type {
  AiderDeskContextFile,
  AiderDeskHealth,
  AiderDeskMessage,
  AiderDeskModel,
  AiderDeskModelsResponse,
  AiderDeskProvider,
  AiderDeskRunMode,
  AiderDeskSseEvent,
  AiderDeskTask,
  AiderDeskTaskFull,
  AiderDeskTaskUpdate,
} from './types';
import { AiderDeskApiError } from './errors';

/**
 * Default AiderDesk API URL resolution.
 *
 * Inside Docker: the container reaches the host via the bridge gateway at
 * 172.18.0.1 (confirmed working on the archon-v2 user-defined bridge network).
 * Outside Docker: localhost is correct for host development.
 */
export function resolveDefaultApiUrl(): string {
  const envUrl = process.env.AIDERDESK_API_URL;
  if (envUrl) return envUrl;

  // Detect Docker environment — ARCHON_DOCKER is set by the Archon Dockerfile
  // and docker-compose; IS_DOCKER is a generic convention.
  if (process.env.ARCHON_DOCKER === 'true' || process.env.IS_DOCKER === 'true') {
    return 'http://172.18.0.1:24337';
  }

  return 'http://localhost:24337';
}

/**
 * Fetch function type — matches global fetch signature.
 * Injectable for unit tests (DI pattern).
 */
export type FetchFn = typeof fetch;

/**
 * AiderDesk REST API client.
 *
 * All endpoints use the `/api` prefix. The base URL should NOT include `/api`
 * — it is appended automatically.
 */
export class AiderDeskClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(
    options: {
      apiUrl?: string;
      fetchFn?: FetchFn;
      apiKey?: string;
      timeoutMs?: number;
    } = {}
  ) {
    this.baseUrl = (options.apiUrl ?? resolveDefaultApiUrl()).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
    this.apiKey = options.apiKey ?? process.env.AIDERDESK_API_KEY;
    this.timeoutMs = options.timeoutMs ?? 300_000; // 5 min default for blocking run-prompt
  }

  /** Build the full URL for an API path. */
  private url(path: string): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}/api${cleanPath}`;
  }

  /** Build request headers including optional auth. */
  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Make an HTTP request with timeout support.
   * Uses AbortController for timeout (not cancellation — the caller's
   * abortSignal is separate and can be passed via the options).
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number }
  ): Promise<T> {
    const url = this.url(path);
    const timeout = options?.timeoutMs ?? this.timeoutMs;

    // Combine caller's abort signal with our timeout signal
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);

    if (options?.abortSignal) {
      if (options.abortSignal.aborted) {
        controller.abort();
      } else {
        options.abortSignal.addEventListener(
          'abort',
          () => {
            controller.abort();
          },
          { once: true }
        );
      }
    }

    try {
      const response = await this.fetchFn(url, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new AiderDeskApiError(
          response.status,
          `AiderDesk API ${method} ${path} failed: ${response.status} ${response.statusText}`,
          bodyText
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        return (await response.json()) as T;
      }

      // Non-JSON response — return as text for echo endpoints
      const text = await response.text();
      return text as unknown as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ─── Health ──────────────────────────────────────────────────────────────

  /** Check AiderDesk backend health. */
  async health(): Promise<AiderDeskHealth> {
    return this.request<AiderDeskHealth>('GET', '/health', undefined, { timeoutMs: 5_000 });
  }

  // ─── Tasks ──────────────────────────────────────────────────────────────

  /** List tasks for a project directory. */
  async listTasks(projectDir: string): Promise<AiderDeskTask[]> {
    return this.request<AiderDeskTask[]>(
      'GET',
      `/project/tasks?projectDir=${encodeURIComponent(projectDir)}`
    );
  }

  /** Create a new task. Returns the created task object. */
  async createTask(projectDir: string, name?: string): Promise<AiderDeskTask> {
    return this.request<AiderDeskTask>('POST', '/project/tasks/new', {
      projectDir,
      name,
      activate: true,
    });
  }

  /**
   * Update a task's properties. Per AiderDesk REST docs this is the supported
   * way to bind `mainModel`, `currentMode`, `workingMode`, `agentProfileId`,
   * and other task-level fields. Returns the updated `TaskData`.
   *
   * Critically: this is required to bind a model to a fresh task before
   * run-prompt, because `/api/project/tasks/new` returns a task that resolves
   * its agent from project defaults (which may not match the requested
   * model — claude 401 fallback in our AiderDesk host).
   */
  async updateTask(
    projectDir: string,
    taskId: string,
    updates: AiderDeskTaskUpdate
  ): Promise<AiderDeskTask> {
    return this.request<AiderDeskTask>('POST', '/project/tasks', {
      projectDir,
      id: taskId,
      updates,
    });
  }

  /** Load a task with full conversation data (messages, files, etc.). */
  async loadTask(projectDir: string, taskId: string): Promise<AiderDeskTaskFull> {
    return this.request<AiderDeskTaskFull>('POST', '/project/tasks/load', {
      projectDir,
      id: taskId,
    });
  }

  /** Clear conversation context for a task. */
  async clearContext(projectDir: string, taskId: string): Promise<void> {
    await this.request('POST', '/project/clear-context', {
      taskId,
      projectDir,
    });
  }

  // ─── Run Prompt (SSE streaming) ────────────────────────────────────────

  /**
   * Run a prompt against an AiderDesk task — streaming variant.
   *
   * Negotiates `Accept: text/event-stream` against AiderDesk's run-prompt
   * endpoint. Returns an async generator that yields parsed SSE events. The
   * stream terminates when AiderDesk writes the final `stream-end` event or
   * when the underlying fetch response body is fully consumed.
   *
   * Per the REST docs the stream events are: `user-message`, `log`,
   * `task-updated`, `response-chunk` (text deltas of the assistant message),
   * `response-completed` (final assistant message), `tool`, `ask-question`,
   * and `stream-end` (terminal).
   *
   * Verified against live AiderDesk on /home/lfontanez/dev/archon-v2 (host
   * :24337) with this exact ordering on a healthy task bound to a real model:
   *   user-message → log → task-updated → response-chunk(*)
   *                 → response-completed → stream-end.
   */
  async *runPromptStream(options: {
    projectDir: string;
    taskId: string;
    prompt: string;
    mode?: AiderDeskRunMode;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }): AsyncGenerator<AiderDeskSseEvent> {
    const url = this.url('/run-prompt');
    const timeout = options.timeoutMs ?? this.timeoutMs;
    const mode: AiderDeskRunMode = options.mode ?? 'agent';

    // Combine caller's abort signal with our timeout signal
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        controller.abort();
      } else {
        options.abortSignal.addEventListener(
          'abort',
          () => {
            controller.abort();
          },
          { once: true }
        );
      }
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          taskId: options.taskId,
          prompt: options.prompt,
          mode,
          projectDir: options.projectDir,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new AiderDeskApiError(
        response.status,
        `AiderDesk stream open failed: ${response.status} ${response.statusText}`,
        bodyText
      );
    }

    if (!response.body) {
      // No body AND no error — extremely unusual. Treat as a stream-end so
      // the provider can finalize cleanly rather than hang.
      yield { kind: 'stream-end' };
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

        // SSE frames are delimited by a blank line. On the wire these arrive
        // as \n\n, but we also accept \r\n\r\n (CRLF) in case the upstream
        // hop rewrites endings.
        let nlStart = indexOfFrameSeparator(buffer);
        while (nlStart !== -1) {
          const nlEnd = nlStart;
          const matchLen = matchLengthAt(buffer, nlStart);
          const frame = buffer.slice(0, nlEnd);
          buffer = buffer.slice(nlEnd + matchLen);

          const evt = parseSseFrame(frame);
          if (evt) yield evt;

          nlStart = indexOfFrameSeparator(buffer);
        }
      }

      // Flush any trailing frame that the reader delivered without a final
      // blank-line separator (AiderDesk sometimes omits the trailing blank
      // line on the very last `stream-end` event).
      const trailing = buffer.trim();
      if (trailing.length > 0) {
        const evt = parseSseFrame(trailing);
        if (evt) yield evt;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* noop — already released */
      }
    }

    if (options.abortSignal?.aborted) {
      // The caller aborted mid-stream — flag the abort here so the provider
      // can finalize the result chunk with the correct outcome instead of
      // just letting the stream end silently.
      yield { kind: 'unknown', eventName: 'aborted', payload: null };
    }
  }

  // ─── Context Files ───────────────────────────────────────────────────────

  /** Add a context file to a task. */
  async addContextFile(
    projectDir: string,
    taskId: string,
    path: string,
    readOnly = false
  ): Promise<void> {
    await this.request('POST', '/add-context-file', {
      taskId,
      path,
      readOnly,
      projectDir,
    });
  }

  /** Remove a context file from a task. */
  async dropContextFile(projectDir: string, taskId: string, path: string): Promise<void> {
    await this.request('POST', '/drop-context-file', {
      taskId,
      path,
      projectDir,
    });
  }

  /** Get all context files for a task. */
  async getContextFiles(projectDir: string, taskId: string): Promise<AiderDeskContextFile[]> {
    return this.request<AiderDeskContextFile[]>('POST', '/get-context-files', {
      taskId,
      projectDir,
    });
  }

  /** Get files that can be added to a task's context. */
  async getAddableFiles(
    projectDir: string,
    taskId: string,
    searchRegex?: string
  ): Promise<unknown[]> {
    return this.request<unknown[]>('POST', '/get-addable-files', {
      taskId,
      searchRegex,
      projectDir,
    });
  }

  /** Get files that were created, modified, or deleted during the task. */
  async getUpdatedFiles(projectDir: string, taskId: string): Promise<unknown> {
    return this.request('POST', '/get-updated-files', {
      taskId,
      projectDir,
    });
  }

  // ─── Models & Providers ──────────────────────────────────────────────────

  /** List available models from AiderDesk. */
  async getModels(): Promise<AiderDeskModel[]> {
    const response = await this.request<AiderDeskModelsResponse>('GET', '/models');
    return response.models;
  }

  /** List configured providers from AiderDesk. */
  async getProviders(): Promise<AiderDeskProvider[]> {
    return this.request<AiderDeskProvider[]>('GET', '/providers');
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Get messages from a task (convenience wrapper around loadTask).
   * Returns messages in conversation order.
   */
  async getMessages(projectDir: string, taskId: string): Promise<AiderDeskMessage[]> {
    const task = await this.loadTask(projectDir, taskId);
    return task.messages ?? [];
  }
}

// ─── SSE separator helpers ────────────────────────────────────────────────
//
// We accept both LF (\n\n) and CRLF (\r\n\r\n) frame separators because
// AiderDesk has been observed to use either depending on backend version.
// Splitting manually (rather than `frame.split('\n\n')`) keeps the matched
// width so we can advance the buffer by the exact bytes we consumed.

function indexOfFrameSeparator(buf: string): number {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function matchLengthAt(buf: string, start: number): number {
  // We already know the match exists (indexOfFrameSeparator returned >= 0),
  // so we peek at the next 4 chars to choose the length.
  if (buf.startsWith('\r\n\r\n', start)) return 4;
  return 2;
}

// ─── Free function: parseSseFrame ─────────────────────────────────────────

/**
 * Parses a single SSE frame into a typed {@link AiderDeskSseEvent}.
 *
 * A frame is a series of `event:` and `data:` lines, terminated by a blank
 * line. We tolerate CRLF line endings, missing `event:` lines (fallback
 * default name `message`), and non-JSON payloads (returned under the
 * `unknown` kind so the provider can still see them in diagnostics).
 *
 * @param frame Raw frame text WITHOUT the trailing blank-line separator.
 * @returns A typed event or `null` for empty / keep-alive frames.
 */
export function parseSseFrame(frame: string): AiderDeskSseEvent | null {
  let eventName = 'message';
  const dataLines: string[] = [];

  for (const raw of frame.split(/\r?\n/)) {
    if (raw.length === 0) continue;
    if (raw.startsWith(':')) continue; // comment / keep-alive
    const colon = raw.indexOf(':');
    if (colon === -1) continue; // malformed line — drop silently
    const field = raw.slice(0, colon);
    // SSE strips a single leading space after the colon.
    const valueStart = raw[colon + 1] === ' ' ? colon + 2 : colon + 1;
    const value = raw.slice(valueStart);

    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    // `id:` and `retry:` are legal SSE but we don't track them.
  }

  const dataStr = dataLines.join('\n');
  if (!dataStr) return null;

  // Conventional [DONE] sentinel — AiderDesk uses `stream-end` events instead,
  // but some proxies still forward [DONE]; treat them as stream-end.
  if (dataStr.trim() === '[DONE]' || eventName === 'stream-end') {
    return { kind: 'stream-end' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(dataStr);
  } catch {
    // Non-JSON payload — preserve the raw bytes for diagnostics.
    return { kind: 'unknown', eventName, payload: dataStr };
  }

  if (!payload || typeof payload !== 'object') {
    return { kind: 'unknown', eventName, payload };
  }

  const p = payload as Record<string, unknown>;
  const taskId = typeof p.taskId === 'string' ? p.taskId : '';
  const baseDir = typeof p.baseDir === 'string' ? p.baseDir : '';

  switch (eventName) {
    case 'user-message':
      return {
        kind: 'user-message',
        taskId,
        baseDir,
        content: typeof p.content === 'string' ? p.content : '',
      };
    case 'log': {
      const level = typeof p.level === 'string' ? p.level : 'info';
      const message = typeof p.message === 'string' ? p.message : undefined;
      const finished = typeof p.finished === 'boolean' ? p.finished : Boolean(p.finished);
      return { kind: 'log', taskId, baseDir, level, message, finished };
    }
    case 'response-chunk':
      return {
        kind: 'response-chunk',
        taskId,
        messageId: typeof p.messageId === 'string' ? p.messageId : '',
        chunk: typeof p.chunk === 'string' ? p.chunk : '',
        reasoning: typeof p.reasoning === 'string' ? p.reasoning : undefined,
      };
    case 'response-completed':
      return {
        kind: 'response-completed',
        taskId,
        messageId: typeof p.messageId === 'string' ? p.messageId : '',
        content: typeof p.content === 'string' ? p.content : '',
        reasoning: typeof p.reasoning === 'string' ? p.reasoning : undefined,
      };
    case 'ask-question':
      return {
        kind: 'ask-question',
        taskId,
        question: typeof p.question === 'string' ? p.question : '',
        options: Array.isArray(p.options)
          ? p.options.filter((o): o is string => typeof o === 'string')
          : undefined,
      };
    case 'task-updated':
      // Per the verified live probe, the data payload of a `task-updated`
      // event is the entire task object (not a wrapper). We trust the shape
      // and cast — the provider only reads a few fields.
      return { kind: 'task-updated', task: p as unknown as AiderDeskTask };
    case 'tool':
      return {
        kind: 'tool',
        taskId,
        messageId: typeof p.messageId === 'string' ? p.messageId : undefined,
        toolName: typeof p.toolName === 'string' ? p.toolName : 'unknown',
        finished: typeof p.finished === 'boolean' ? p.finished : Boolean(p.finished),
        result: typeof p.result === 'string' ? p.result : undefined,
      };
    default:
      return { kind: 'unknown', eventName, payload };
  }
}
