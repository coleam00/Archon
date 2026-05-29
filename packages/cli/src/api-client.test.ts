/**
 * Tests for the CLI REST API client — base-URL resolution and fail-fast errors.
 */
import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import {
  createApiClient,
  resolveServerUrl,
  extractErrorMessage,
  ApiClientError,
  DEFAULT_SERVER_URL,
} from './api-client';

describe('resolveServerUrl', () => {
  const original = process.env.ARCHON_SERVER_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.ARCHON_SERVER_URL;
    else process.env.ARCHON_SERVER_URL = original;
  });

  it('prefers the explicit arg over env and default', () => {
    process.env.ARCHON_SERVER_URL = 'http://env:9999';
    expect(resolveServerUrl('http://arg:1234')).toBe('http://arg:1234');
  });

  it('falls back to ARCHON_SERVER_URL when no arg is given', () => {
    process.env.ARCHON_SERVER_URL = 'http://env:9999';
    expect(resolveServerUrl()).toBe('http://env:9999');
  });

  it('defaults when neither arg nor env is set', () => {
    delete process.env.ARCHON_SERVER_URL;
    expect(resolveServerUrl()).toBe(DEFAULT_SERVER_URL);
  });

  it('strips a trailing slash', () => {
    expect(resolveServerUrl('http://x:1/')).toBe('http://x:1');
  });
});

describe('extractErrorMessage', () => {
  it('formats zod-openapi validation issues', () => {
    expect(
      extractErrorMessage({ error: { issues: [{ path: ['a', 'b'], message: 'required' }] } })
    ).toBe('a.b: required');
  });

  it('extracts an error string', () => {
    expect(extractErrorMessage({ error: 'boom' })).toBe('boom');
  });

  it('extracts a message string', () => {
    expect(extractErrorMessage({ message: 'nope' })).toBe('nope');
  });

  it('returns undefined for unrecognized shapes', () => {
    expect(extractErrorMessage({ foo: 1 })).toBeUndefined();
  });
});

describe('createApiClient', () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchSpy?.mockRestore();
    delete process.env.ARCHON_API_KEY;
  });

  it('returns parsed JSON on a 2xx response', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const api = createApiClient('http://localhost:3090');
    await expect(api.get('/x')).resolves.toEqual({ ok: true });
  });

  it('throws ApiClientError(unreachable) when fetch rejects', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const api = createApiClient('http://localhost:3090');
    const err = (await api.post('/x', {}).catch((e: unknown) => e)) as ApiClientError;
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.kind).toBe('unreachable');
    expect(err.message).toContain('Archon server is not running');
  });

  it('throws ApiClientError(http) with the server message on a 4xx response', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'bad input' }), { status: 400 })
    );
    const api = createApiClient('http://localhost:3090');
    const err = (await api.del('/x').catch((e: unknown) => e)) as ApiClientError;
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.kind).toBe('http');
    expect(err.status).toBe(400);
    expect(err.message).toContain('bad input');
  });

  it('attaches an Authorization header when ARCHON_API_KEY is set', async () => {
    process.env.ARCHON_API_KEY = 'secret-key';
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const api = createApiClient('http://localhost:3090');
    await api.get('/x');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
  });
});
