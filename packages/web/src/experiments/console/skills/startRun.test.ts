/**
 * Request-shape tests for startRun's declared-inputs channel (#2554).
 *
 * The JSON and multipart branches carry the same map two different ways, and the
 * multipart encoding has to agree byte-for-byte with what the run route's multipart
 * branch parses — a disagreement there is invisible until a real run silently starts
 * without its inputs.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { startRun } from './startRun';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
let calls: Captured[] = [];

function stubFetch(): void {
  calls = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const payload = url.includes('/api/conversations')
      ? { conversationId: 'web-test-1' }
      : { accepted: true, status: 'started' };
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as typeof fetch;
}

/** The run dispatch is the second call; the first creates the conversation. */
function runCall(): Captured {
  const call = calls.find(c => c.url.includes('/run'));
  if (call === undefined) throw new Error('no run dispatch captured');
  return call;
}

describe('startRun — declared inputs (#2554)', () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('JSON branch carries `inputs` alongside the message', async () => {
    await startRun({
      projectId: 'p1',
      workflow: 'review-block',
      message: 'go',
      inputs: { diff: 'D1', style: 'terse' },
    });

    const body = JSON.parse(String(runCall().init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      conversationId: 'web-test-1',
      message: 'go',
      inputs: { diff: 'D1', style: 'terse' },
    });
  });

  test('JSON branch omits `inputs` entirely when none are supplied', async () => {
    await startRun({ projectId: 'p1', workflow: 'plain', message: 'go' });

    const body = JSON.parse(String(runCall().init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('inputs');
  });

  test('JSON branch omits `inputs` for an empty map rather than sending {}', async () => {
    await startRun({ projectId: 'p1', workflow: 'plain', message: 'go', inputs: {} });

    const body = JSON.parse(String(runCall().init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('inputs');
  });

  test('multipart branch carries `inputs` as one JSON-encoded form field', async () => {
    // A form field can only be a string — this is the encoding the run route's
    // multipart branch JSON.parses back.
    await startRun({
      projectId: 'p1',
      workflow: 'review-block',
      message: 'go',
      files: [new File(['x'], 'a.txt', { type: 'text/plain' })],
      inputs: { diff: 'D1' },
    });

    const form = runCall().init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(String(form.get('inputs')))).toEqual({ diff: 'D1' });
    expect(form.get('message')).toBe('go');
    expect(form.getAll('files')).toHaveLength(1);
  });

  test('multipart branch omits the `inputs` field when none are supplied', async () => {
    await startRun({
      projectId: 'p1',
      workflow: 'plain',
      message: 'go',
      files: [new File(['x'], 'a.txt', { type: 'text/plain' })],
    });

    const form = runCall().init?.body as FormData;
    expect(form.get('inputs')).toBeNull();
  });
});
