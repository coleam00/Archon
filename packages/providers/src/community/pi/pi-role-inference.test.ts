/**
 * The one behaviour change SDK 1.6 brings: which role carries the instructions.
 *
 * Pi picks it as `model.reasoning && compat.supportsDeveloperRole ? "developer" : "system"`, and
 * `supportsDeveloperRole` defaults to whether the endpoint is OpenAI's own (provider id
 * `openai`, or a base URL at `api.openai.com`). Before 1.6 an OpenAI-compatible host with a
 * custom id and URL got `developer`, which many chat templates reject. This captures the
 * request the SDK actually builds, so a future SDK that flips the default again fails here.
 */
import { describe, expect, test } from 'bun:test';
import type { Context, Model, OpenAICompletionsCompat } from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai/compat';

const MODEL: Model<'openai-completions'> = {
  id: 'local-reasoner',
  name: 'Local reasoner',
  api: 'openai-completions',
  provider: 'local-host',
  baseUrl: 'http://127.0.0.1:9/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

const CONTEXT: Context = {
  systemPrompt: 'You are a test.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], timestamp: 0 }],
};

/** The request body the SDK hands to its transport for this model, and nothing else. */
async function sentPayload(model: Model<'openai-completions'>): Promise<{
  messages: { role: string; content: unknown }[];
}> {
  let payload: unknown;
  const fetch = Object.assign(
    async () => {
      throw new Error('captured');
    },
    { preconnect: (() => {}) as typeof globalThis.fetch.preconnect }
  );
  await completeSimple(model, CONTEXT, {
    apiKey: 'test-key',
    fetch,
    onPayload: body => {
      payload = body;
    },
  }).catch(() => undefined);
  expect(payload).toBeDefined();
  return payload as { messages: { role: string; content: unknown }[] };
}

function instructionRole(payload: { messages: { role: string; content: unknown }[] }): string[] {
  return payload.messages
    .filter(message => ['system', 'developer'].includes(message.role))
    .map(message => message.role);
}

describe('the role that carries the instructions', () => {
  test('a reasoning model on a non-OpenAI host gets `system`', async () => {
    expect(instructionRole(await sentPayload(MODEL))).toEqual(['system']);
  });

  test('OpenAI itself still gets `developer` for a reasoning model', async () => {
    const payload = await sentPayload({ ...MODEL, provider: 'openai' });
    expect(instructionRole(payload)).toEqual(['developer']);
  });

  test.each([
    { compat: { supportsDeveloperRole: false } as OpenAICompletionsCompat, expected: 'system' },
    { compat: { supportsDeveloperRole: true } as OpenAICompletionsCompat, expected: 'developer' },
  ])('an explicit compat entry wins: %o', async ({ compat, expected }) => {
    const payload = await sentPayload({ ...MODEL, provider: 'openai', compat });
    expect(instructionRole(payload)).toEqual([expected]);
  });
});
