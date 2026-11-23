/**
 * The structured_output tool on a real Pi agent loop: Pi's faux model provider
 * scripts the model's replies, and the real `createAgentSession` validates and
 * executes the tool calls that `bridgeSession` turns into the node's result.
 *
 * Runs in its own `bun test` process (package.json testGroups): the provider unit tests
 * mock the Pi SDK process-wide through provider-test-fixture.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeTempTree } from '@archon/paths/test-utils';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';

import type { MessageChunk, NativeTool } from '../../types';
import { bridgeSession } from './event-bridge';
import { createStructuredOutputTool } from './structured-output-tool';
import { buildPiNativeToolDefinitions } from './native-tools';
import { buildDefaultPiTools } from './options-translator';

const scratch = mkdtempSync(join(tmpdir(), 'archon-pi-structured-output-'));
afterAll(async () => {
  await removeTempTree(scratch);
});

const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', reasoning: true }] });
const modelRuntime = await ModelRuntime.create({
  authPath: join(scratch, 'auth.json'),
  modelsPath: join(scratch, 'models.json'),
});
modelRuntime.registerNativeProvider(faux.provider);
await modelRuntime.setRuntimeApiKey('faux', 'not-a-secret');

// No extensions, skills or context files: the session sees only the tool under test.
const resourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => 'test',
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => undefined,
  reload: async () => undefined,
} as unknown as ResourceLoader;

const schema = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['done', 'ask'] },
    count: { type: 'integer', minimum: 1 },
  },
  required: ['decision', 'count'],
  additionalProperties: false,
};
const answer = { decision: 'done', count: 2 };

/** Run one prompt through the tool and the bridge; report the result and model calls. */
async function runTurn(
  steps: FauxResponseStep[],
  nativeTools: NativeTool[] = [],
  outputSchema: Record<string, unknown> | null = schema
): Promise<{
  result: Extract<MessageChunk, { type: 'result' }> | undefined;
  modelCalls: number;
  text: string;
}> {
  faux.setResponses(steps);
  const callsBefore = faux.state.callCount;
  const tool = outputSchema ? createStructuredOutputTool(outputSchema) : undefined;
  const extraTools = buildPiNativeToolDefinitions(nativeTools, tool ? [tool.definition] : []);
  const { session } = await createAgentSession({
    cwd: scratch,
    agentDir: scratch,
    model: faux.getModel(),
    thinkingLevel: 'high',
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(scratch),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    customTools: [
      ...buildDefaultPiTools(scratch, undefined, undefined),
      ...extraTools,
      ...(tool ? [tool.definition] : []),
    ],
    noTools: 'builtin',
  });
  tool?.capFailedCalls(session);
  let result: Extract<MessageChunk, { type: 'result' }> | undefined;
  let text = '';
  for await (const chunk of bridgeSession(session, 'prompt', undefined, tool?.output)) {
    if (chunk.type === 'result') result = chunk;
    if (chunk.type === 'agent_message_chunk') text += chunk.text;
  }
  return { result, modelCalls: faux.state.callCount - callsBefore, text };
}

test('native tools reject invalid raw parameters before Pi normalizes them', async () => {
  const seen: unknown[] = [];
  const tools: NativeTool[] = [
    {
      name: 'lookup',
      description: 'Look up an item',
      inputSchema: {
        jsonSchema: {
          type: 'object',
          properties: { count: { type: 'number' }, label: { type: 'string' } },
          required: ['count'],
          additionalProperties: false,
        },
      },
      handler: async input => {
        seen.push(input);
        return 'ok';
      },
    },
  ];
  const { result } = await runTurn(
    [
      fauxAssistantMessage([fauxToolCall('lookup', { count: '7' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('lookup', { count: 7, label: null })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('lookup', { count: 8 })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('structured_output', answer)], { stopReason: 'toolUse' }),
    ],
    tools
  );
  expect(result?.structuredOutput).toEqual(answer);
  expect(seen).toEqual([{ count: 8 }]);
});

test('a declared structured-output collision fails before the real Pi loop dispatches', async () => {
  let handlerCalls = 0;
  const callsBefore = faux.state.callCount;
  const turn = runTurn(
    [fauxAssistantMessage([fauxToolCall('structured_output', answer)], { stopReason: 'toolUse' })],
    [
      {
        name: createStructuredOutputTool(schema).definition.name,
        description: 'Declared script tool',
        inputSchema: { jsonSchema: schema },
        handler: async () => {
          handlerCalls++;
          return 'script ran';
        },
      },
    ]
  );
  await expect(turn).rejects.toThrow('conflicts with a Pi built-in or internal tool');
  expect(faux.state.callCount - callsBefore).toBe(0);
  expect(handlerCalls).toBe(0);
});

test('every tool in the real Pi built-in registry rejects a declared name collision', async () => {
  const { session } = await createAgentSession({
    cwd: scratch,
    agentDir: scratch,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(scratch),
    settingsManager: SettingsManager.inMemory(),
    noTools: 'builtin',
  });
  const callsBefore = faux.state.callCount;
  let handlerCalls = 0;
  try {
    const builtinNames = session.getAllTools().map(tool => tool.name);
    expect(builtinNames.length).toBeGreaterThan(0);
    for (const name of builtinNames) {
      expect(() =>
        buildPiNativeToolDefinitions([
          {
            name,
            description: 'Declared script tool',
            inputSchema: { jsonSchema: { type: 'object' } },
            handler: async () => {
              handlerCalls++;
              return 'script ran';
            },
          },
        ])
      ).toThrow(`Native tool '${name}' conflicts with a Pi built-in or internal tool`);
    }
  } finally {
    session.dispose();
  }
  expect(faux.state.callCount - callsBefore).toBe(0);
  expect(handlerCalls).toBe(0);
});

test('structured_output remains a callable declared tool when no internal output tool is installed', async () => {
  const seen: unknown[] = [];
  const { result, modelCalls, text } = await runTurn(
    [
      fauxAssistantMessage([fauxToolCall('structured_output', answer)], { stopReason: 'toolUse' }),
      fauxAssistantMessage('script finished'),
    ],
    [
      {
        name: createStructuredOutputTool(schema).definition.name,
        description: 'Declared script tool',
        inputSchema: { jsonSchema: schema },
        handler: async input => {
          seen.push(input);
          return 'script ran';
        },
      },
    ],
    null
  );
  expect(result?.isError).toBeUndefined();
  expect(text).toBe('script finished');
  expect(seen).toEqual([answer]);
  expect(modelCalls).toBe(2);
});

describe('Pi structured_output tool on a real agent loop', () => {
  test('a valid tool call is the output and ends the turn without another model call', async () => {
    const { result, modelCalls } = await runTurn([
      fauxAssistantMessage([fauxToolCall('structured_output', answer)], { stopReason: 'toolUse' }),
      fauxAssistantMessage('never requested'),
    ]);

    expect(result?.isError).toBeUndefined();
    expect(result?.structuredOutput).toEqual(answer);
    expect(modelCalls).toBe(1);
  });

  test('the tool call wins over JSON in the reply text', async () => {
    const { result } = await runTurn([
      fauxAssistantMessage(
        [
          fauxText(`Here is my answer: ${JSON.stringify({ decision: 'ask', count: 9 })}`),
          fauxToolCall('structured_output', answer),
        ],
        { stopReason: 'toolUse' }
      ),
    ]);

    expect(result?.structuredOutput).toEqual(answer);
  });

  test('a model that answers in text without the tool falls back to the reply text', async () => {
    const { result } = await runTurn([fauxAssistantMessage(JSON.stringify(answer))]);

    expect(result?.structuredOutput).toEqual(answer);
  });

  test('JSON only in the thinking, with no tool call, yields no output', async () => {
    const { result } = await runTurn([
      fauxAssistantMessage([fauxThinking(JSON.stringify(answer))]),
    ]);

    expect(result?.isError).toBeUndefined();
    expect(result?.structuredOutput).toBeUndefined();
  });

  test('an invalid call is retried in-session with the validation error', async () => {
    const { result, modelCalls } = await runTurn([
      fauxAssistantMessage([fauxToolCall('structured_output', { decision: 'maybe', count: 0 })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('structured_output', answer)], { stopReason: 'toolUse' }),
    ]);

    expect(result?.structuredOutput).toEqual(answer);
    expect(modelCalls).toBe(2);
  });

  test('three invalid calls end the turn with no output', async () => {
    const invalid = fauxAssistantMessage([fauxToolCall('structured_output', { decision: 'no' })], {
      stopReason: 'toolUse',
    });
    const { result, modelCalls } = await runTurn([
      ...Array.from({ length: 5 }, () => invalid),
      fauxAssistantMessage('never requested'),
    ]);

    expect(result?.isError).toBeUndefined();
    expect(result?.structuredOutput).toBeUndefined();
    expect(modelCalls).toBe(3);
  });
});
