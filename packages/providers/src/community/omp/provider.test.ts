import { describe, expect, test } from 'bun:test';

import { augmentPromptForJsonSchema, OmpProvider } from './provider';
import type { OmpCodingAgentSdk, OmpSession } from './sdk-loader';

function makeSdk(options: { model?: unknown; apiKey?: string } = {}): OmpCodingAgentSdk {
  const session: OmpSession = {
    sessionId: 'sess-1',
    subscribe(listener) {
      this.listener = listener;
      return () => undefined;
    },
    async prompt() {
      const listener = this.listener as ((event: unknown) => void) | undefined;
      listener?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '{"ok":true}' },
      });
      listener?.({
        type: 'agent_end',
        messages: [{ role: 'assistant', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }],
      });
    },
    async abort() {
      return undefined;
    },
    dispose() {
      return undefined;
    },
  } as OmpSession & { listener?: (event: unknown) => void };

  return {
    async createAgentSession() {
      return {
        session,
        setToolUIContext() {
          return undefined;
        },
      };
    },
    async discoverAuthStorage() {
      return {
        setRuntimeApiKey() {
          return undefined;
        },
        async getApiKey() {
          return options.apiKey ?? 'sk-test';
        },
      };
    },
    ModelRegistry: class {
      refreshInBackground() {
        return undefined;
      }
      find() {
        return options.model ?? { provider: 'anthropic', id: 'claude-sonnet-4-5' };
      }
    },
    Settings: {
      isolated() {
        return {};
      },
    },
    SessionManager: {
      create() {
        return {};
      },
      async list() {
        return [];
      },
      async open() {
        return {};
      },
    },
    async discoverSkills() {
      return { skills: [] };
    },
  };
}

describe('OmpProvider', () => {
  test('reports type and capabilities', () => {
    const provider = new OmpProvider(async () => makeSdk());
    expect(provider.getType()).toBe('omp');
    expect(provider.getCapabilities().sessionResume).toBe(true);
  });

  test('throws on missing model', async () => {
    const provider = new OmpProvider(async () => makeSdk());
    await expect(async () => {
      for await (const _chunk of provider.sendQuery('hi', '/repo')) {
        // consume
      }
    }).toThrow('requires a model');
  });

  test('streams assistant and result chunks', async () => {
    const provider = new OmpProvider(async () => makeSdk());
    const chunks = [];
    for await (const chunk of provider.sendQuery('hi', '/repo', undefined, {
      model: 'anthropic/claude-sonnet-4-5',
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({ type: 'assistant', content: '{"ok":true}' });
    expect(chunks.at(-1)).toEqual({
      type: 'result',
      tokens: { input: 1, output: 1 },
      stopReason: 'end_turn',
      sessionId: 'sess-1',
      structuredOutput: { ok: true },
    });
  });
});

describe('augmentPromptForJsonSchema', () => {
  test('adds JSON-only instruction and schema', () => {
    const result = augmentPromptForJsonSchema('answer', { type: 'object' });
    expect(result).toContain('Respond with ONLY a JSON object');
    expect(result).toContain('"type": "object"');
  });
});
