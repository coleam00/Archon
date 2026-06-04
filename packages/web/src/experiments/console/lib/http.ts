/**
 * Tiny HTTP helpers owned by the console spike. Copied from packages/web/src/lib/api.ts
 * (lines 17-70 at time of spike) rather than imported, so the spike remains
 * decoupled from the production API client.
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
  constructor(status: number, path: string, bodySnippet: string) {
    super(`API error ${status.toString()} (${path}): ${bodySnippet}`);
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
  }
}

function mergeHeaders(
  base: Record<string, string>,
  extra: HeadersInit | undefined
): Record<string, string> {
  if (extra === undefined) return base;
  const out: Record<string, string> = { ...base };
  if (extra instanceof Headers) {
    extra.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(extra)) {
    for (const [k, v] of extra) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

export async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const needsJson = options?.body !== undefined && !(options.body instanceof FormData);
  const headers = mergeHeaders(
    needsJson ? { 'Content-Type': 'application/json' } : {},
    options?.headers
  );
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const truncated = body.length > 200 ? `${body.slice(0, 200)}...` : body;
    const path = new URL(url, window.location.origin).pathname;
    throw new HttpError(res.status, path, truncated);
  }
  return res.json() as Promise<T>;
}
