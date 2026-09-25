import { afterEach, describe, expect, test } from 'bun:test';
import { HttpError, errorDetail, requestJson } from './http';

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;

function respond(status: number, body: string): void {
  (globalThis as { window?: unknown }).window = { location: { origin: 'http://localhost' } };
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(body, { status }))) as typeof fetch;
}

async function caught(): Promise<HttpError> {
  try {
    await requestJson('/api/workflows/runs/r1/cancel', { method: 'POST' });
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
