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
  AiderDeskTask,
  AiderDeskTaskFull,
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

    // If caller provides an abort signal, forward its abort to our controller
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

  // ─── Run Prompt ──────────────────────────────────────────────────────────

  /**
   * Run a prompt against an AiderDesk task.
   *
   * This is a BLOCKING POST — the call does not return until the AiderDesk
   * agent finishes processing (or the request times out). There is no SSE
   * or WebSocket streaming; completion is determined by the HTTP response.
   */
  async runPrompt(
    projectDir: string,
    taskId: string,
    prompt: string,
    mode: AiderDeskRunMode = 'code',
    options?: { abortSignal?: AbortSignal; timeoutMs?: number }
  ): Promise<AiderDeskTaskFull> {
    return this.request<AiderDeskTaskFull>(
      'POST',
      '/run-prompt',
      { taskId, prompt, mode, projectDir },
      options
    );
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
