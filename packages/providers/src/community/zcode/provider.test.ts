import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

/**
 * Behavioral tests for the zcode provider's contract surface. The CLI spawn is
 * replaced through mock.module with a stub that emits recorded epilogue shapes;
 * no real zcode process runs.
 */

interface Stub {
  code: number | null;
  stdout: string;
  stderr: string;
}

let stub: Stub = { code: 0, stdout: '', stderr: '' };

function streamOf(): EventEmitter {
  return new EventEmitter();
}

function makeChild(result: Stub) {
  const child = new EventEmitter() as EventEmitter & {
    killed?: boolean;
    kill?: () => void;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = streamOf();
  child.stderr = streamOf();
  child.kill = () => {
    child.killed = true;
  };
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from(result.stdout, 'utf8'));
    child.stderr.emit('data', Buffer.from(result.stderr, 'utf8'));
    child.emit('close', result.code);
  }, 0);
  return child;
}

mock.module('node:child_process', () => ({
  spawn: () => makeChild(stub),
}));

const { ZcodeProvider } = await import('./provider');

const EPILOGUE_OK = JSON.stringify({
  sessionId: 'sess_test-1234',
  response: 'READY',
  usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
  projection: { turnCount: 1 },
});

async function collect(prompt = 'hi', options?: Record<string, unknown>) {
  const chunks: { type: string }[] = [];
  for await (const c of new ZcodeProvider().sendQuery(
    prompt,
    '/tmp',
    undefined,
    options as never
  )) {
    chunks.push(c as { type: string });
  }
  return chunks;
}

function resultOf(chunks: { type: string }[]) {
  return chunks.find(c => c.type === 'result') as unknown as Record<string, any>;
}

describe('zcode provider contract', () => {
  test('passing epilogue yields message + result(text/sessionId/tokens) + settled', async () => {
    stub = { code: 0, stdout: EPILOGUE_OK, stderr: '' };
    const chunks = await collect();
    expect(chunks.map(c => c.type)).toEqual(['agent_message_chunk', 'result', 'settled']);
    const r = resultOf(chunks);
    expect(r.text).toBe('READY');
    expect(r.sessionId).toBe('sess_test-1234');
    expect(r.tokens).toEqual({ input: 100, output: 5, total: 105 });
    expect(r.numTurns).toBe(1);
    expect(r.failure).toBeUndefined();
  });

  test('stdout with leading noise still parses the epilogue', async () => {
    stub = { code: 0, stdout: `warm-up line\n${EPILOGUE_OK}\n`, stderr: '' };
    const r = resultOf(await collect());
    expect(r.text).toBe('READY');
  });

  test('multi-object stdout parses the first whole object, never the trailing nested one', async () => {
    // Regression: a parser anchored on the last '{' reads the nested projection object
    // as the epilogue and silently drops sessionId/response/usage. The whole-document
    // parse must win, so the first complete object is the epilogue.
    const first = JSON.stringify({
      sessionId: 'sess_a',
      response: 'FIRST',
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    stub = {
      code: 0,
      stdout: `${first}\n${JSON.stringify({ projection: { turnCount: 9 } })}`,
      stderr: '',
    };
    const r = resultOf(await collect());
    expect(r.text).toBe('FIRST');
    expect(r.sessionId).toBe('sess_a');
  });

  test('insufficient balance classifies quota_exhausted', async () => {
    stub = { code: 1, stdout: '', stderr: 'Error: insufficient balance (1008)' };
    const r = resultOf(await collect());
    expect(r.failure).toMatchObject({ class: 'quota_exhausted' });
  });

  test('401 classifies auth', async () => {
    stub = { code: 1, stdout: '', stderr: 'APICallError: 401 unauthorized' };
    const r = resultOf(await collect());
    expect(r.failure).toMatchObject({ class: 'auth' });
  });

  test('429 classifies rate_limited', async () => {
    stub = { code: 1, stdout: '', stderr: 'HTTP 429 rate limit exceeded' };
    const r = resultOf(await collect());
    expect(r.failure).toMatchObject({ class: 'rate_limited' });
  });

  test('no epilogue classifies unknown with exit evidence', async () => {
    stub = { code: 1, stdout: 'plain crash text', stderr: '' };
    const r = resultOf(await collect());
    expect(r.failure).toMatchObject({ class: 'unknown' });
    expect(String(r.failure?.evidence)).toContain('zcode exited 1');
  });

  test('pre-aborted abortSignal throws (cancellation, not a failure result)', async () => {
    stub = { code: 0, stdout: EPILOGUE_OK, stderr: '' };
    const controller = new AbortController();
    controller.abort();
    let threw = false;
    try {
      await collect('hi', { abortSignal: controller.signal });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
