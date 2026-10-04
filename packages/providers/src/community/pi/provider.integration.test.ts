/**
 * Real-SDK test of a custom-provider turn whose `${VAR}` credential is
 * substituted into a per-call models.json, with a Pi extension that registers
 * its own provider. Each registerProvider() starts a background refresh that
 * re-reads modelsPath, so the per-call file must live for the whole session.
 *
 * Runs in its own `bun test` process (package.json testGroups): provider.test.ts
 * mocks the Pi SDK process-wide.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeTempTree } from '@archon/paths/test-utils';

import type { MessageChunk } from '../../types';
import { PiProvider } from './provider';

const scratch = mkdtempSync(join(tmpdir(), 'archon-pi-provider-int-'));
const agentDir = join(scratch, 'agent');
const repoDir = join(scratch, 'repo');
const perCallTmp = join(scratch, 'tmp');
const savedEnv = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_OFFLINE: process.env.PI_OFFLINE,
  TMPDIR: process.env.TMPDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
};

/** Authorization headers of the upstream requests, in order. */
const authHeaders: (string | null)[] = [];

function sse(chunks: object[]): Response {
  const body = [...chunks.map(c => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function completion(delta: object, finishReason: string): object[] {
  const base = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm1' };
  return [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
  ];
}

// First request: one read tool call. Second: the final text.
const server = Bun.serve({
  port: 0,
  fetch(request) {
    authHeaders.push(request.headers.get('authorization'));
    if (authHeaders.length === 1) {
      return sse(
        completion(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'read', arguments: JSON.stringify({ path: 'hello.txt' }) },
              },
            ],
          },
          'tool_calls'
        )
      );
    }
    return sse(completion({ role: 'assistant', content: 'done' }, 'stop'));
  },
});

beforeAll(() => {
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  mkdirSync(repoDir);
  mkdirSync(perCallTmp);
  writeFileSync(join(repoDir, 'hello.txt'), 'hello\n');
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        mycustom: {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          api: 'openai-completions',
          apiKey: '${MY_KEY}',
          models: [{ id: 'm1' }],
        },
      },
    })
  );
  writeFileSync(
    join(agentDir, 'extensions', 'ext-prov.ts'),
    `export default function (pi) {
  pi.registerProvider('ext-prov', {
    baseUrl: 'http://127.0.0.1:1/v1',
    api: 'openai-completions',
    apiKey: 'ext-key',
    models: [{ id: 'x1', name: 'x1', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
  });
}
`
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  // node:os tmpdir() reads TMPDIR on POSIX and TMP/TEMP on Windows.
  process.env.TMPDIR = perCallTmp;
  process.env.TMP = perCallTmp;
  process.env.TEMP = perCallTmp;
});

afterAll(async () => {
  void server.stop(true);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await removeTempTree(scratch);
});

describe('PiProvider with a substituted custom provider and a provider-registering extension', () => {
  test('a tool call then text both reach the stub with the substituted key', async () => {
    const chunks: MessageChunk[] = [];
    for await (const chunk of new PiProvider().sendQuery('read hello.txt', repoDir, undefined, {
      model: 'mycustom/m1',
      env: { MY_KEY: 'sk-per-call' },
      protectedEnvKeys: [],
    })) {
      chunks.push(chunk);
    }

    const result = chunks.find(c => c.type === 'result');
    expect(result).toBeDefined();
    expect(result && 'failure' in result ? result.failure : undefined).toBeUndefined();
    expect(authHeaders).toEqual(['Bearer sk-per-call', 'Bearer sk-per-call']);
    expect(readdirSync(join(perCallTmp, 'archon-pi-models'))).toEqual([]);
  }, 30_000);
});
