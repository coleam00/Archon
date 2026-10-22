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

import type { MessageChunk } from '../../types';
import { bridgeSession } from './event-bridge';
import { createStructuredOutputTool } from './structured-output-tool';

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
async function runTurn(steps: FauxResponseStep[]): Promise<{
  result: Extract<MessageChunk, { type: 'result' }> | undefined;
  modelCalls: number;
}> {
  faux.setResponses(steps);
  const callsBefore = faux.state.callCount;
  const tool = createStructuredOutputTool(schema);
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
    customTools: [tool.definition],
    noTools: 'builtin',
  });
  tool.capFailedCalls(session);
  let result: Extract<MessageChunk, { type: 'result' }> | undefined;
  for await (const chunk of bridgeSession(session, 'prompt', undefined, tool.output)) {
    if (chunk.type === 'result') result = chunk;
  }
  return { result, modelCalls: faux.state.callCount - callsBefore };
}

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
