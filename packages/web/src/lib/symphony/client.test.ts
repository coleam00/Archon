import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  cancelSymphony,
  dispatchSymphony,
  getSymphonyState,
  listSymphonyDispatches,
  refreshSymphony,
} from './client';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];
let nextResponse: { ok: boolean; status: number; body: unknown } = {
  ok: true,
  status: 200,
  body: {},
};
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  calls = [];
  nextResponse = { ok: true, status: 200, body: {} };
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return {
      ok: nextResponse.ok,
      status: nextResponse.status,
      json: async () => nextResponse.body,
      text: async () => JSON.stringify(nextResponse.body),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getSymphonyState', () => {
  test('GETs /api/symphony/state', async () => {
    nextResponse.body = {
      generated_at: 'x',
      counts: { running: 0, retrying: 0, completed: 0 },
      running: [],
      retrying: [],
    };
    await getSymphonyState();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/symphony/state');
    expect(calls[0]?.init?.method).toBeUndefined();
  });
});

describe('listSymphonyDispatches', () => {
  test('omits query string when no options', async () => {
    nextResponse.body = { dispatches: [] };
    await listSymphonyDispatches();
    expect(calls[0]?.url).toBe('/api/symphony/dispatches');
  });

  test('serialises status and limit', async () => {
    nextResponse.body = { dispatches: [] };
    await listSymphonyDispatches({ status: 'failed', limit: 25 });
    expect(calls[0]?.url).toBe('/api/symphony/dispatches?status=failed&limit=25');
  });

  test('returns dispatches array unwrapped', async () => {
    nextResponse.body = { dispatches: [{ id: '1' }] };
    const r = await listSymphonyDispatches({ limit: 1 });
    expect(r).toEqual([{ id: '1' }] as unknown as never);
  });
});

describe('dispatchSymphony', () => {
  test('POSTs JSON body with dispatch_key', async () => {
    nextResponse.body = { ok: true, dispatch_key: 'linear:APP-1' };
    await dispatchSymphony('linear:APP-1');
    const c = calls[0];
    expect(c?.url).toBe('/api/symphony/dispatch');
    expect(c?.init?.method).toBe('POST');
    expect(c?.init?.body).toBe(JSON.stringify({ dispatch_key: 'linear:APP-1' }));
    expect((c?.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});

describe('cancelSymphony', () => {
  test('POSTs JSON body to /cancel', async () => {
    nextResponse.body = { ok: true };
    await cancelSymphony('github:Ddell12/archon-symphony#42');
    const c = calls[0];
    expect(c?.url).toBe('/api/symphony/cancel');
    expect(c?.init?.method).toBe('POST');
    expect(c?.init?.body).toBe(
      JSON.stringify({ dispatch_key: 'github:Ddell12/archon-symphony#42' })
    );
  });
});

describe('refreshSymphony', () => {
  test('POSTs to /refresh with no body', async () => {
    nextResponse.body = { coalesced: false };
    const r = await refreshSymphony();
    expect(calls[0]?.url).toBe('/api/symphony/refresh');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(r).toEqual({ coalesced: false });
  });
});

describe('error handling', () => {
  test('throws helpful error on non-OK response', async () => {
    nextResponse = { ok: false, status: 500, body: { error: 'boom' } };
    await expect(getSymphonyState()).rejects.toThrow(/API error 500/);
  });
});
