/**
 * Real-SDK test that Pi retries a provider failure inside its own agent loop, so a dropped
 * or refused request never reaches Archon as a failed turn, and that the knobs are Pi's own
 * settings rather than an Archon switch. Archon seeds the session from the user's
 * `settings.json` (session-setup.ts) and adds no retry policy of its own.
 *
 * Runs in its own `bun test` process (package.json testGroups): the provider unit tests mock
 * the Pi SDK process-wide through provider-test-fixture.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeTempTree } from '@archon/paths/test-utils';

import type { MessageChunk } from '../../types';
import { PiProvider } from './provider';

const scratch = mkdtempSync(join(tmpdir(), 'archon-pi-retry-'));
const agentDir = join(scratch, 'agent');
const repoDir = join(scratch, 'repo');
const savedEnv = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_OFFLINE: process.env.PI_OFFLINE,
};

/** How many requests the stub refuses before it serves a completion. */
let refusals = 0;
/** Every request the stub saw, so a test can assert whether Pi retried. */
const requests: string[] = [];

function sse(chunks: object[]): Response {
  const body = [...chunks.map(c => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function completion(text: string): object[] {
  const base = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm1' };
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
}

const server = Bun.serve({
  port: 0,
  fetch(request) {
    requests.push(new URL(request.url).pathname);
    if (refusals > 0) {
      refusals--;
      return new Response(JSON.stringify({ error: { message: 'the engine is restarting' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return sse(completion('done'));
  },
});

/** Pi's `retry` settings, as an operator writes them in `$PI_CODING_AGENT_DIR/settings.json`. */
function writeSettings(retry: Record<string, unknown> | undefined): void {
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(retry ? { retry } : {}));
}

async function turn(): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of new PiProvider().sendQuery('hi', repoDir, undefined, {
    model: 'retryprov/m1',
    env: { RETRY_KEY: 'sk-test' },
    protectedEnvKeys: [],
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

beforeAll(() => {
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(repoDir);
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        retryprov: {
          baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
          api: 'openai-completions',
          apiKey: '${RETRY_KEY}',
          models: [{ id: 'm1' }],
        },
      },
    })
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
});

afterAll(async () => {
  void server.stop(true);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await removeTempTree(scratch);
});

describe('Pi retries a refused request before Archon sees a failure', () => {
  test('two refusals then a completion is one successful turn', async () => {
    // A short base delay keeps the test quick; it is Pi's own knob.
    writeSettings({ maxRetries: 2, baseDelayMs: 10 });
    requests.length = 0;
    refusals = 2;

    const chunks = await turn();

    const result = chunks.find(c => c.type === 'result');
    expect(result).toBeDefined();
    expect(result && 'failure' in result ? result.failure : undefined).toBeUndefined();
    expect(
      chunks
        .filter(c => c.type === 'agent_message_chunk')
        .map(c => c.text)
        .join('')
    ).toBe('done');
    // Each attempt is a chunk of its own, so the run log shows the retries.
    expect(
      chunks.filter(c => c.type === 'warning').map(c => ({ code: c.code, message: c.message }))
    ).toEqual([
      { code: 'pi.auto_retry', message: 'retry 1/2: 503: {"message":"the engine is restarting"}' },
      { code: 'pi.auto_retry', message: 'retry 2/2: 503: {"message":"the engine is restarting"}' },
    ]);
    expect(requests).toHaveLength(3);
    refusals = 0;
  }, 60_000);

  test('a turn retried out of its budget fails, classified from the status it ended on', async () => {
    writeSettings({ maxRetries: 1, baseDelayMs: 10 });
    requests.length = 0;
    refusals = 5;

    const chunks = await turn();

    expect(requests).toHaveLength(2);
    const result = chunks.find(c => c.type === 'result');
    if (result?.type !== 'result') throw new Error('expected a result chunk');
    expect(result.isError).toBe(true);
    // The refusal is an HTTP status, so the class survives even though Pi ran out of
    // retries; a connection failure with no status would stay `unknown`.
    expect(result.failure).toMatchObject({ class: 'transient' });
    refusals = 0;
  }, 60_000);

  test('retry: { enabled: false } turns it off, and Archon adds no switch of its own', async () => {
    writeSettings({ enabled: false });
    requests.length = 0;
    refusals = 1;

    const chunks = await turn();

    expect(requests).toHaveLength(1);
    expect(chunks.filter(c => c.type === 'warning')).toEqual([]);
    const result = chunks.find(c => c.type === 'result');
    if (result?.type !== 'result') throw new Error('expected a result chunk');
    expect(result.isError).toBe(true);
    expect(result.failure).toMatchObject({ class: 'transient' });
    refusals = 0;
  }, 60_000);
});
