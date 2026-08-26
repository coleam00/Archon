import { expect, mock, test } from 'bun:test';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageChunk } from '../../types';

import { OpencodeProvider } from './provider';

function sse(data: unknown[]): Response {
  return new Response(
    `${data.map(item => `data: ${JSON.stringify(item)}\n\n`).join('')}data: [DONE]\n\n`,
    {
      headers: { 'content-type': 'text/event-stream' },
    }
  );
}

test('pinned V2 daemon invokes a native tool through the provider boundary', async () => {
  const requests: Record<string, unknown>[] = [];
  const modelServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const hasToolResult = messages.some(
        message =>
          typeof message === 'object' &&
          message !== null &&
          'role' in message &&
          message.role === 'tool'
      );
      if (!Array.isArray(body.tools)) {
        return sse([
          {
            id: 'chatcmpl-title',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test-model',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'test title' },
                finish_reason: null,
              },
            ],
          },
          {
            id: 'chatcmpl-title',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
        ]);
      }
      if (!hasToolResult) {
        return sse([
          {
            id: 'chatcmpl-tool',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test-model',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_manage_run',
                      type: 'function',
                      function: { name: 'manage_run', arguments: '{"action":"list"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: 'chatcmpl-tool',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          },
        ]);
      }
      return sse([
        {
          id: 'chatcmpl-result',
          object: 'chat.completion.chunk',
          created: 2,
          model: 'test-model',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'native tool complete' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'chatcmpl-result',
          object: 'chat.completion.chunk',
          created: 2,
          model: 'test-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        },
      ]);
    },
  });
  const cwd = await mkdtemp(join(tmpdir(), 'archon-opencode-native-tools-'));
  const modelsPath = join(cwd, 'models.json');
  await writeFile(
    modelsPath,
    JSON.stringify({
      archon: {
        id: 'archon',
        env: [],
        npm: '@ai-sdk/openai-compatible',
        api: `http://127.0.0.1:${modelServer.port}/v1`,
        name: 'Archon test provider',
        models: {
          'test-model': {
            id: 'test-model',
            name: 'Test model',
            family: 'test',
            attachment: false,
            reasoning: false,
            tool_call: true,
            structured_output: true,
            temperature: true,
            knowledge: '2024-01',
            release_date: '2024-01-01',
            last_updated: '2024-01-01',
            modalities: { input: ['text'], output: ['text'] },
            open_weights: false,
            limit: { context: 10_000, output: 1_000 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    })
  );
  const handler = mock(async (input: Record<string, unknown>) => `runs:${input.action}`);
  const previousConfig = process.env.OPENCODE_CONFIG_CONTENT;
  const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const previousProjectConfig = process.env.OPENCODE_CONFIG_PROJECT_DISABLE;
  const previousModelsPath = process.env.OPENCODE_MODELS_PATH;
  const previousModelsFetch = process.env.OPENCODE_DISABLE_MODELS_FETCH;
  process.env.OPENCODE_CONFIG_DIR = cwd;
  process.env.OPENCODE_CONFIG_PROJECT_DISABLE = '1';
  process.env.OPENCODE_MODELS_PATH = modelsPath;
  process.env.OPENCODE_DISABLE_MODELS_FETCH = '1';
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    provider: {
      archon: {
        options: { baseURL: `http://127.0.0.1:${modelServer.port}/v1`, apiKey: 'test' },
      },
    },
  });

  try {
    const chunks: MessageChunk[] = [];
    for await (const chunk of new OpencodeProvider({ useV2: true }).sendQuery(
      'Use manage_run to list runs, then report completion.',
      cwd,
      undefined,
      {
        assistantConfig: { model: 'archon/test-model' },
        abortSignal: AbortSignal.timeout(15_000),
        nativeTools: [
          {
            name: 'manage_run',
            description: 'Manage workflow runs',
            inputSchema: {
              type: 'object',
              properties: { action: { type: 'string' } },
              required: ['action'],
            },
            handler,
          },
        ],
      }
    )) {
      chunks.push(chunk);
    }

    expect(requests.find(request => Array.isArray(request.tools))?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: 'manage_run' }) }),
      ])
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ action: 'list' });
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'tool', toolName: 'manage_run' })
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'tool_result', toolOutput: 'runs:list' })
    );
    expect(chunks).toContainEqual({ type: 'assistant', content: 'native tool complete' });
    expect(chunks.at(-1)).toEqual(expect.objectContaining({ type: 'result' }));
  } finally {
    if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = previousConfig;
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    if (previousProjectConfig === undefined) delete process.env.OPENCODE_CONFIG_PROJECT_DISABLE;
    else process.env.OPENCODE_CONFIG_PROJECT_DISABLE = previousProjectConfig;
    if (previousModelsPath === undefined) delete process.env.OPENCODE_MODELS_PATH;
    else process.env.OPENCODE_MODELS_PATH = previousModelsPath;
    if (previousModelsFetch === undefined) delete process.env.OPENCODE_DISABLE_MODELS_FETCH;
    else process.env.OPENCODE_DISABLE_MODELS_FETCH = previousModelsFetch;
    modelServer.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
