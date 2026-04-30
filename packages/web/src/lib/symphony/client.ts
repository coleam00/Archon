import type {
  SymphonyDispatchActionResponse,
  SymphonyDispatchListResponse,
  SymphonyDispatchRow,
  SymphonyDispatchStatus,
  SymphonyRefreshResponse,
  SymphonyStateResponse,
} from './types';

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    const truncated = body.length > 200 ? body.slice(0, 200) + '...' : body;
    const path = new URL(url, 'http://localhost').pathname;
    const error = new Error(`API error ${String(res.status)} (${path}): ${truncated}`);
    (error as Error & { status: number }).status = res.status;
    throw error;
  }
  return res.json() as Promise<T>;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export async function getSymphonyState(signal?: AbortSignal): Promise<SymphonyStateResponse> {
  return fetchJSON<SymphonyStateResponse>('/api/symphony/state', { signal });
}

export interface ListDispatchesOptions {
  status?: SymphonyDispatchStatus;
  limit?: number;
  signal?: AbortSignal;
}

export async function listSymphonyDispatches(
  options: ListDispatchesOptions = {}
): Promise<SymphonyDispatchRow[]> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const qs = params.toString();
  const url = qs ? `/api/symphony/dispatches?${qs}` : '/api/symphony/dispatches';
  const data = await fetchJSON<SymphonyDispatchListResponse>(url, { signal: options.signal });
  return data.dispatches;
}

export async function dispatchSymphony(
  dispatchKey: string
): Promise<SymphonyDispatchActionResponse> {
  return fetchJSON<SymphonyDispatchActionResponse>('/api/symphony/dispatch', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ dispatch_key: dispatchKey }),
  });
}

export async function cancelSymphony(dispatchKey: string): Promise<SymphonyDispatchActionResponse> {
  return fetchJSON<SymphonyDispatchActionResponse>('/api/symphony/cancel', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ dispatch_key: dispatchKey }),
  });
}

export async function refreshSymphony(): Promise<SymphonyRefreshResponse> {
  return fetchJSON<SymphonyRefreshResponse>('/api/symphony/refresh', {
    method: 'POST',
    headers: JSON_HEADERS,
  });
}
