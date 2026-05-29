/**
 * Minimal REST API client for CLI mutation commands.
 *
 * The CLI follows a two-layer model (see docs/plan/cli-parity.md): reads hit
 * the DB / filesystem directly (no server required), while mutations go through
 * the running server's REST API so they inherit the route handlers' validation
 * and business logic. This wrapper centralizes base-URL resolution and error
 * handling for those mutation calls.
 */
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.api');
  return cachedLog;
}

export const DEFAULT_SERVER_URL = 'http://localhost:3090';

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Resolve the server base URL. Precedence: explicit `--server-url` arg >
 * `ARCHON_SERVER_URL` env > default (`http://localhost:3090`).
 */
export function resolveServerUrl(serverUrl?: string): string {
  const fromArg = serverUrl?.trim();
  if (fromArg) return stripTrailingSlash(fromArg);
  const fromEnv = process.env.ARCHON_SERVER_URL?.trim();
  if (fromEnv) return stripTrailingSlash(fromEnv);
  return DEFAULT_SERVER_URL;
}

/**
 * Error thrown when an API request fails. Carries a user-facing `message` that
 * the CLI surfaces (cli.ts prepends `Error: `). `kind` distinguishes a
 * server-unreachable failure (actionable: start the server) from an HTTP error.
 */
export class ApiClientError extends Error {
  readonly kind: 'unreachable' | 'http';
  readonly status?: number;
  constructor(message: string, kind: 'unreachable' | 'http', status?: number) {
    super(message);
    this.name = 'ApiClientError';
    this.kind = kind;
    this.status = status;
  }
}

export interface ApiClient {
  readonly baseUrl: string;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  del<T = unknown>(path: string, body?: unknown): Promise<T>;
}

/** Parse JSON, falling back to the raw string when the body is not JSON. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Extract a human-readable message from a parsed JSON error body. */
export function extractErrorMessage(parsed: unknown): string | undefined {
  if (typeof parsed === 'string') return parsed.length > 0 ? parsed : undefined;
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;

  // Hono zod-openapi validation error: { success: false, error: { issues: [...] } }
  const errVal = obj.error;
  if (errVal && typeof errVal === 'object') {
    const issues = (errVal as Record<string, unknown>).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues
        .map(raw => {
          const issue = raw as Record<string, unknown>;
          const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
          return path ? `${path}: ${String(issue.message)}` : String(issue.message);
        })
        .join('; ');
    }
  }

  for (const key of ['error', 'message', 'detail'] as const) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    return obj.errors.map(e => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ');
  }
  return undefined;
}

/**
 * Create an API client bound to a resolved base URL.
 *
 * Fail-fast error handling (no silent fallback): a network failure throws an
 * `ApiClientError` of kind `unreachable` with start-the-server guidance; a
 * non-2xx response throws kind `http` with the server's error message.
 */
export function createApiClient(serverUrl?: string): ApiClient {
  const baseUrl = resolveServerUrl(serverUrl);

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Auth hook: the server does not yet require authentication, but honor an
    // API key when present so CLI usage keeps working once auth lands.
    const apiKey = process.env.ARCHON_API_KEY?.trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      getLog().debug({ err: error as Error, url, method }, 'api.request_unreachable');
      throw new ApiClientError(
        'Archon server is not running.\n' +
          'Start it with: archon serve   or   bun run dev:server\n' +
          `Server URL: ${baseUrl} (override with --server-url or ARCHON_SERVER_URL)`,
        'unreachable'
      );
    }

    const text = await res.text();
    const parsed = text ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      const detail = extractErrorMessage(parsed) ?? `${res.status} ${res.statusText}`;
      getLog().debug({ url, method, status: res.status, detail }, 'api.request_failed');
      throw new ApiClientError(`Request failed (${res.status}): ${detail}`, 'http', res.status);
    }

    return parsed as T;
  }

  return {
    baseUrl,
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
    del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
  };
}
