import { afterEach, describe, expect, test } from 'bun:test';
import { HttpError, errorDetail, requestJson, buildApiUrl } from './http';

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;

function respond(status: number, body: string): void {
  (globalThis as { window?: unknown }).window = { location: { origin: 'http://localhost' } };
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(body, { status }))) as typeof fetch;
}

async function caught(): Promise<HttpError> {
  try {
    await requestJson('/api/workflows/runs/{runId}/cancel', 'post', { params: { runId: 'r1' } });
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('requestJson did not throw');
}

describe('requestJson errors', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  // A cancel refusal lists the recorded owner facts and runs past the 200-character
  // snippet; the console shows `serverError`, so it must be the whole message.
  test('carries the full apiError message beyond the snippet cap', async () => {
    const message = `No live owner answered for this run on this host.\n${'x'.repeat(300)}`;
    respond(409, JSON.stringify({ error: message }));

    const error = await caught();

    expect(error.status).toBe(409);
    expect(error.bodySnippet.length).toBeLessThan(message.length);
    expect(error.serverError).toBe(message);
  });

  test('preserves full apiError detail independently of the snippet', async () => {
    const detail = `No codebase with id ${'x'.repeat(250)}-DETAIL-TAIL`;
    respond(400, JSON.stringify({ error: 'Codebase not found', detail }));

    const error = await caught();

    expect(error.serverError).toBe('Codebase not found');
    expect(error.serverDetail).toBe(detail);
    expect(error.bodySnippet).not.toContain('DETAIL-TAIL');
  });

  test('ignores a non-string apiError detail', async () => {
    respond(400, JSON.stringify({ error: 'Refused', detail: { internal: true } }));

    const error = await caught();

    expect(error.serverError).toBe('Refused');
    expect(error.serverDetail).toBeUndefined();
  });

  test('leaves serverError undefined for a body that is not apiError JSON', async () => {
    respond(502, '<html>Bad gateway</html>');

    const error = await caught();

    expect(error.serverError).toBeUndefined();
    expect(error.bodySnippet).toBe('<html>Bad gateway</html>');
  });
});

describe('errorDetail', () => {
  test('HttpError → parsed server message', () => {
    const err = new HttpError(403, '/api/workflows/foo', JSON.stringify({ error: 'denied' }));
    expect(errorDetail(err)).toBe('denied');
  });

  test('generic Error → message; non-Error → String()', () => {
    expect(errorDetail(new Error('boom'))).toBe('boom');
    expect(errorDetail(42)).toBe('42');
  });
});

describe('request serialization', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('encodes complete path values once and omits undefined query values', () => {
    expect(
      buildApiUrl('/api/workflows/{name}', 'put', {
        params: { name: 'pack/name %?' },
        query: { cwd: '', source: undefined },
      })
    ).toBe('/api/workflows/pack%2Fname%20%25%3F?cwd=');
    expect(
      buildApiUrl('/api/artifacts/{runId}/{filename}', 'get', {
        params: { runId: 'run/1', filename: 'nested/a b%.md' },
      })
    ).toBe('/api/artifacts/run%2F1/nested%2Fa%20b%25.md');
  });

  test('encodes JSON bodies and preserves headers, credentials and signal', async () => {
    const signal = new AbortController().signal;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(_input).toBe('/api/conversations/web%2F1/message');
      expect(init?.method).toBe('POST');
      expect(init?.credentials).toBe('same-origin');
      expect(init?.signal).toBe(signal);
      expect(init?.body).toBe(JSON.stringify({ message: 'hello' }));
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/vnd.test+json');
      expect(new Headers(init?.headers).get('X-Test')).toBe('yes');
      return Promise.resolve(Response.json({ accepted: true, status: 'started' }));
    }) as typeof fetch;
    await requestJson('/api/conversations/{id}/message', 'post', {
      params: { id: 'web/1' },
      body: { message: 'hello' },
      signal,
      headers: new Headers({ 'Content-Type': 'application/vnd.test+json', 'X-Test': 'yes' }),
    });
  });

  test('leaves multipart content type and boundary to the browser', async () => {
    const form = new FormData();
    form.append('message', 'hello');
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBe(form);
      expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
      return Promise.resolve(Response.json({ accepted: true, status: 'started' }));
    }) as typeof fetch;
    await requestJson('/api/conversations/{id}/message', 'post', {
      params: { id: 'web-1' },
      body: form,
    });
  });
});
