import type {
  ApiPath,
  ApiMethod,
  JsonMethod,
  JsonResponse,
  RequestArgs,
  UrlArgs,
} from './api-types';
/**
 * Tiny HTTP helpers owned by the console. Console skills use this boundary for
 * runtime API calls.
 */

const API_PORT = (import.meta.env.VITE_API_PORT as string | undefined) ?? '3090';

/**
 * SSE base URL. In dev, bypasses Vite proxy by connecting directly to the
 * backend (the proxy buffers SSE). In production, relative URLs (same origin).
 */
export const SSE_BASE_URL = import.meta.env.DEV
  ? `http://${window.location.hostname}:${API_PORT}`
  : '';

export class HttpError extends Error {
  readonly status: number;
  readonly path: string;
  /** The server error body — apiError's JSON `{error, detail?}`, capped at 200
   *  chars of content with a `...` suffix appended when cut off (so up to ~203
   *  chars, possibly mid-JSON). Consumers must guard `JSON.parse` and fall back
   *  to the raw text. */
  readonly bodySnippet: string;
  /** apiError's full `error` message, read from the whole body; undefined when the body
   *  is not apiError JSON. Operator-facing refusals are longer than the snippet. */
  readonly serverError: string | undefined;
  /** apiError's full optional `detail`, read before the diagnostic snippet is capped. */
  readonly serverDetail: string | undefined;
  constructor(
    status: number,
    path: string,
    bodySnippet: string,
    serverError?: string,
    serverDetail?: string
  ) {
    super(`API error ${status.toString()} (${path}): ${bodySnippet}`);
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
    this.bodySnippet = bodySnippet;
    this.serverError = serverError;
    this.serverDetail = serverDetail;
  }
}

function apiErrorFields(body: string): Pick<HttpError, 'serverError' | 'serverDetail'> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof parsed.error === 'string'
    ) {
      return {
        serverError: parsed.error,
        serverDetail:
          'detail' in parsed && typeof parsed.detail === 'string' ? parsed.detail : undefined,
      };
    }
  } catch {
    // Not apiError JSON (a proxy page, an empty body); the snippet still carries it.
  }
  return undefined;
}

/**
 * The server's own message from a failed request: apiError's `{ error, detail? }`
 * body. `bodySnippet` is capped (see HttpError), so a long body may not parse;
 * the raw snippet is the fallback.
 */
export function serverErrorMessage(err: HttpError): string {
  let message = err.bodySnippet || `Request failed (${String(err.status)})`;
  try {
    const parsed = JSON.parse(err.bodySnippet) as { error?: string; detail?: string };
    if (parsed.error) {
      message = parsed.detail ? `${parsed.error}: ${parsed.detail}` : parsed.error;
    }
  } catch {
    /* truncated/non-JSON body — keep the raw snippet */
  }
  return message;
}

/** Best-effort human detail from a thrown error (the server message for an HttpError). */
export function errorDetail(e: unknown): string {
  if (e instanceof HttpError) return serverErrorMessage(e);
  if (e instanceof Error) return e.message;
  return String(e);
}

function mergeHeaders(base: Record<string, string>, extra: HeadersInit | undefined): Headers {
  const headers = new Headers(base);
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return headers;
}

function serializeUrl(
  path: string,
  options: { params?: object; query?: object } | undefined
): string {
  let url = path;
  for (const [key, value] of Object.entries(options?.params ?? {})) {
    url = url.replace(`{${key}}`, encodeURIComponent(String(value)));
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options?.query ?? {})) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query.size > 0 ? `${url}?${query.toString()}` : url;
}

export function buildApiUrl<const P extends ApiPath, const M extends ApiMethod<NoInfer<P>>>(
  path: P,
  _method: M,
  ...args: UrlArgs<NoInfer<P>, NoInfer<M>>
): string {
  return serializeUrl(path, args[0]);
}

export async function requestJson<const P extends ApiPath, const M extends JsonMethod<NoInfer<P>>>(
  route: P,
  method: M,
  ...args: RequestArgs<NoInfer<P>, NoInfer<M>>
): Promise<JsonResponse<P, M>> {
  const options = args[0];
  const url = serializeUrl(route, options);
  const needsJson = options?.body !== undefined && !(options.body instanceof FormData);
  const headers = mergeHeaders(
    needsJson ? { 'Content-Type': 'application/json' } : {},
    options?.headers
  );
  const res = await fetch(url, {
    credentials: 'same-origin',
    method: method.toUpperCase(),
    signal: options?.signal,
    body: needsJson
      ? JSON.stringify(options?.body)
      : options?.body instanceof FormData
        ? options.body
        : undefined,
    headers,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const truncated = body.length > 200 ? `${body.slice(0, 200)}...` : body;
    const path = new URL(url, window.location.origin).pathname;
    const fields = apiErrorFields(body);
    throw new HttpError(res.status, path, truncated, fields?.serverError, fields?.serverDetail);
  }
  return res.json() as Promise<JsonResponse<P, M>>;
}
