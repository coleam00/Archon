/**
 * Real-SDK test of a custom-provider turn whose `${VAR}` credential is
 * substituted into a per-call models.json, with a Pi extension that registers
 * its own provider. Each registerProvider() starts a background refresh that
 * re-reads modelsPath, so the per-call file must live for the whole session.
 *
 * Runs in its own `bun test` process (package.json testGroups): the provider unit tests
 * mock the Pi SDK process-wide through provider-test-fixture.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeTempTree } from '@archon/paths/test-utils';
import { SessionManager, createAgentSession } from '@earendil-works/pi-coding-agent';

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
let responseGate: { started: () => void; released: Promise<void> } | undefined;

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
  async fetch(request) {
    authHeaders.push(request.headers.get('authorization'));
    if (responseGate) {
      responseGate.started();
      await responseGate.released;
    }
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
  pi.registerTool({
    name: 'ext_echo',
    label: 'ext_echo',
    description: 'Echo',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'echo' }] }),
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
    const sessions = await SessionManager.list(repoDir);
    expect(sessions).toHaveLength(1);
    expect(result).toMatchObject({ sessionId: sessions[0].id });
  }, 30_000);

  test('an ephemeral title turn writes no session file', async () => {
    const before = await SessionManager.list(repoDir);
    const sessionDir = join(agentDir, 'sessions');
    const filesBefore = readdirSync(sessionDir, { recursive: true });
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    responseGate = { started: started.resolve, released: released.promise };
    const chunks: MessageChunk[] = [];
    const turn = (async () => {
      for await (const chunk of new PiProvider().sendQuery(
        'Generate a short title',
        repoDir,
        undefined,
        {
          model: 'mycustom/m1',
          env: { MY_KEY: 'sk-per-call' },
          purpose: 'title-generation',
          nodeConfig: { allowed_tools: [] },
        }
      )) {
        chunks.push(chunk);
      }
    })();
    try {
      await Promise.race([
        started.promise,
        turn.then(() => {
          throw new Error('Title turn ended before reaching the local provider');
        }),
      ]);
      expect(readdirSync(sessionDir, { recursive: true })).toEqual(filesBefore);
      expect(await SessionManager.list(repoDir)).toEqual(before);
    } finally {
      released.resolve();
      responseGate = undefined;
      await turn;
    }
    expect(chunks.find(c => c.type === 'result')).toMatchObject({ stopReason: 'end_turn' });
    expect(
      chunks
        .filter(c => c.type === 'agent_message_chunk')
        .map(c => c.text)
        .join('')
    ).toBe('done');
    expect(chunks.find(c => c.type === 'result' && c.failure !== undefined)).toBeUndefined();
    expect(readdirSync(sessionDir, { recursive: true })).toEqual(filesBefore);
    expect(await SessionManager.list(repoDir)).toEqual(before);
  });
});

test('persisted Pi resume and fork report only the current prompt usage', async () => {
  const contexts: number[] = [];
  const stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: unknown[] };
      contexts.push(body.messages.length);
      const input = contexts.length === 1 ? 100 : 200;
      const output = contexts.length === 1 ? 10 : 20;
      const frames = completion({ role: 'assistant', content: 'done' }, 'stop');
      return sse([
        ...frames,
        {
          id: 'usage',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'spend',
          choices: [],
          usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
        },
      ]);
    },
  });
  const modelsPath = join(agentDir, 'models.json');
  const savedModels = readFileSync(modelsPath, 'utf8');
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        spend: {
          baseUrl: `http://127.0.0.1:${stub.port}/v1`,
          api: 'openai-completions',
          apiKey: 'stub',
          models: [
            {
              id: 'spend',
              name: 'spend',
              reasoning: false,
              input: ['text'],
              contextWindow: 10000,
              maxTokens: 100,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    })
  );
  try {
    async function turn(resume?: string, forkSession = false) {
      for await (const chunk of new PiProvider().sendQuery('reply done', repoDir, resume, {
        model: 'spend/spend',
        forkSession,
        nodeConfig: { allowed_tools: [] },
      })) {
        if (chunk.type === 'result') return chunk;
      }
      throw new Error('missing Pi result');
    }
    const fresh = await turn();
    expect(fresh.failure).toBeUndefined();
    expect(fresh.tokens).toMatchObject({ input: 100, output: 10 });
    expect(fresh.cost).toBeCloseTo(0.00012, 10);
    expect(fresh.sessionId).toBeDefined();
    for (const forkSession of [false, true]) {
      const result = await turn(fresh.sessionId, forkSession);
      expect(result.failure).toBeUndefined();
      expect(result.resumed).toBe(true);
      expect(result.tokens).toMatchObject({ input: 200, output: 20 });
      expect(result.cost).toBeCloseTo(0.00024, 10);
    }
    expect(contexts).toEqual([2, 4, 6]);
  } finally {
    void stub.stop(true);
    writeFileSync(modelsPath, savedModels);
  }
});

test('a Pi session’s per-prompt usage sums to the SDK’s own session stats', async () => {
  let requests = 0;
  let toolCallSent = false;
  const stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { tools?: unknown[] };
      requests++;
      const usage = {
        id: 'usage',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'spend',
        choices: [],
        usage: {
          prompt_tokens: 100 * requests,
          completion_tokens: 10 * requests,
          total_tokens: 110 * requests,
        },
      };
      // The first prompt makes one tool call, so it spans two assistant messages.
      if (!toolCallSent && (body.tools?.length ?? 0) > 0) {
        toolCallSent = true;
        const toolCall = {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ path: 'hello.txt' }) },
            },
          ],
        };
        return sse([...completion(toolCall, 'tool_calls'), usage]);
      }
      return sse([...completion({ role: 'assistant', content: 'done' }, 'stop'), usage]);
    },
  });
  const modelsPath = join(agentDir, 'models.json');
  const savedModels = readFileSync(modelsPath, 'utf8');
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        spend: {
          baseUrl: `http://127.0.0.1:${stub.port}/v1`,
          api: 'openai-completions',
          apiKey: 'stub',
          models: [
            {
              id: 'spend',
              name: 'spend',
              reasoning: false,
              input: ['text'],
              contextWindow: 10000,
              maxTokens: 100,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    })
  );
  try {
    async function turn(resume?: string) {
      for await (const chunk of new PiProvider().sendQuery('reply done', repoDir, resume, {
        model: 'spend/spend',
        nodeConfig: { allowed_tools: ['read'] },
      })) {
        if (chunk.type === 'result') return chunk;
      }
      throw new Error('missing Pi result');
    }
    const first = await turn();
    if (first.sessionId === undefined) throw new Error('missing Pi session id');
    const chain = [first, await turn(first.sessionId), await turn(first.sessionId)];
    expect(requests).toBe(4);
    for (const result of chain) expect(result.failure).toBeUndefined();

    const file = SessionManager.findById(repoDir, first.sessionId);
    if (!file) throw new Error('missing Pi session file');
    const { session } = await createAgentSession({
      cwd: repoDir,
      agentDir,
      sessionManager: SessionManager.open(file),
    });
    try {
      const stats = session.getSessionStats();
      const sum = (pick: (result: (typeof chain)[number]) => number | undefined) =>
        chain.reduce((total, result) => total + (pick(result) ?? Number.NaN), 0);
      expect(sum(result => result.cost)).toBeCloseTo(stats.cost, 12);
      expect(sum(result => result.tokens?.input)).toBe(
        stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite
      );
      expect(sum(result => result.tokens?.output)).toBe(stats.tokens.output);
    } finally {
      session.dispose();
    }
  } finally {
    void stub.stop(true);
    writeFileSync(modelsPath, savedModels);
  }
});

test('a resumed or forked Pi node without tool restrictions gets the tools of a fresh node, not those of the node it resumes', async () => {
  const toolsPerRequest: string[][] = [];
  const stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { tools?: { function: { name: string } }[] };
      toolsPerRequest.push((body.tools ?? []).map(t => t.function.name).sort());
      return sse(completion({ role: 'assistant', content: 'done' }, 'stop'));
    },
  });
  const modelsPath = join(agentDir, 'models.json');
  const settingsPath = join(agentDir, 'settings.json');
  const savedModels = readFileSync(modelsPath, 'utf8');
  writeFileSync(settingsPath, JSON.stringify({ defaultTools: ['+grep'] }));
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        tools: {
          baseUrl: `http://127.0.0.1:${stub.port}/v1`,
          api: 'openai-completions',
          apiKey: 'stub',
          models: [{ id: 'tools' }],
        },
      },
    })
  );
  try {
    async function turn(
      nodeConfig: { allowed_tools?: string[] },
      resume?: string,
      forkSession = false
    ) {
      for await (const chunk of new PiProvider().sendQuery('reply done', repoDir, resume, {
        model: 'tools/tools',
        forkSession,
        nodeConfig,
      })) {
        if (chunk.type === 'result') return chunk;
      }
      throw new Error('missing Pi result');
    }
    await turn({});
    const restricted = await turn({ allowed_tools: ['read'] });
    expect(restricted.sessionId).toBeDefined();
    for (const forkSession of [false, true]) {
      const result = await turn({}, restricted.sessionId, forkSession);
      expect(result.resumed).toBe(true);
    }
    const fresh = ['bash', 'edit', 'ext_echo', 'grep', 'read', 'write'];
    expect(toolsPerRequest).toEqual([fresh, ['ext_echo', 'read'], fresh, fresh]);
  } finally {
    void stub.stop(true);
    writeFileSync(modelsPath, savedModels);
    rmSync(settingsPath);
  }
});
