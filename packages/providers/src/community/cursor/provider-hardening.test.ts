/**
 * Hardening tests for CursorProvider — defensive behaviors.
 * Runs in its own bun test invocation — mocks @cursor/sdk and @archon/paths.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SDKMessage } from '@cursor/sdk';

import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

type FakeRun = {
  id: string;
  streamEvents: SDKMessage[];
  waitResult: { status: 'finished' | 'error' | 'cancelled'; result?: string };
  stream(): AsyncGenerator<SDKMessage>;
  wait(): Promise<FakeRun['waitResult']>;
  supports(op: string): boolean;
  cancel(): Promise<void>;
};

function makeFakeRun(
  events: SDKMessage[] = [],
  waitResult: FakeRun['waitResult'] = { status: 'finished', result: 'ok' }
): FakeRun {
  return {
    id: 'run-hardening',
    streamEvents: events,
    waitResult,
    async *stream() {
      for (const event of this.streamEvents) yield event;
    },
    wait: async () => waitResult,
    supports: op => op === 'cancel',
    cancel: async () => undefined,
  };
}

let lastCreateOptions: Record<string, unknown> | undefined;
let lastSendOptions: Record<string, unknown> | undefined;
let createShouldFailWithAuth = false;
let closeShouldThrow = false;
let lastSendPrompt = '';

class FakeAgent {
  agentId = 'agent-hardening';
  closed = false;

  async send(prompt: string, options?: Record<string, unknown>) {
    lastSendPrompt = prompt;
    lastSendOptions = options;
    return makeFakeRun([
      {
        type: 'assistant',
        agent_id: this.agentId,
        run_id: 'run-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    ]);
  }

  close() {
    this.closed = true;
    if (closeShouldThrow) {
      throw new Error('close failed');
    }
  }

  async [Symbol.asyncDispose]() {
    this.close();
  }

  async reload() {
    /* noop */
  }

  async listArtifacts() {
    return [];
  }

  async downloadArtifact() {
    return Buffer.from('');
  }
}

mock.module('@cursor/sdk', () => ({
  Agent: {
    create: mock(async (options: Record<string, unknown>) => {
      lastCreateOptions = options;
      if (createShouldFailWithAuth) {
        throw new Error('unauthorized: invalid api key');
      }
      return new FakeAgent();
    }),
    resume: mock(async (agentId: string, options: Record<string, unknown>) => {
      lastCreateOptions = options;
      const agent = new FakeAgent();
      agent.agentId = agentId;
      return agent;
    }),
  },
}));

async function collect(
  generator: AsyncGenerator<unknown>
): Promise<{ chunks: unknown[]; error?: Error }> {
  const chunks: unknown[] = [];
  try {
    for await (const chunk of generator) chunks.push(chunk);
    return { chunks };
  } catch (error) {
    return { chunks, error: error as Error };
  }
}

describe('CursorProvider hardening', () => {
  beforeEach(() => {
    lastCreateOptions = undefined;
    lastSendOptions = undefined;
    lastSendPrompt = '';
    createShouldFailWithAuth = false;
    closeShouldThrow = false;
    process.env.CURSOR_API_KEY = 'test-key';
  });

  test('uses auto model and low thinking by default', async () => {
    const { CursorProvider } = await import('./provider');
    await collect(new CursorProvider().sendQuery('hi', '/repo'));

    const model = lastCreateOptions?.model as {
      id: string;
      params?: { id: string; value: string }[];
    };
    expect(model.id).toBe('auto');
    expect(model.params).toEqual(expect.arrayContaining([{ id: 'thinking', value: 'low' }]));
  });

  test('uses apiKey from assistantConfig when env unset', async () => {
    delete process.env.CURSOR_API_KEY;
    const { CursorProvider } = await import('./provider');
    await collect(
      new CursorProvider().sendQuery('hi', '/repo', undefined, {
        assistantConfig: { apiKey: 'config-key' },
      })
    );
    expect(lastCreateOptions?.apiKey).toBe('config-key');
  });

  test('auth errors include setup hint', async () => {
    createShouldFailWithAuth = true;
    const { CursorProvider } = await import('./provider');
    const { error } = await collect(new CursorProvider().sendQuery('hi', '/repo'));
    expect(error?.message).toContain('CURSOR_API_KEY');
  });

  test('throws when cloud runtime lacks cloudRepos', async () => {
    const { CursorProvider } = await import('./provider');
    const { error } = await collect(
      new CursorProvider().sendQuery('hi', '/repo', undefined, {
        assistantConfig: { runtime: 'cloud' },
      })
    );
    expect(error?.message).toContain('cloudRepos');
  });

  test('warns and uses fresh agent when forkSession requested', async () => {
    const { CursorProvider } = await import('./provider');
    const { chunks } = await collect(
      new CursorProvider().sendQuery('hi', '/repo', 'agent-old', {
        forkSession: true,
      })
    );
    expect(chunks.some(c => (c as { content?: string }).content?.includes('forking'))).toBe(true);
    expect(lastSendOptions?.local).toEqual({ force: true });
  });

  test('warns when node sandbox is set', async () => {
    const { CursorProvider } = await import('./provider');
    const { chunks } = await collect(
      new CursorProvider().sendQuery('hi', '/repo', undefined, {
        nodeConfig: { sandbox: true },
      })
    );
    expect(chunks.some(c => (c as { content?: string }).content?.includes('sandbox'))).toBe(true);
  });

  test('prepends system prompt to send payload', async () => {
    const { CursorProvider } = await import('./provider');
    await collect(
      new CursorProvider().sendQuery('user ask', '/repo', undefined, {
        systemPrompt: 'Be concise',
      })
    );

    expect(lastSendPrompt.startsWith('Be concise')).toBe(true);
    expect(lastSendPrompt).toContain('user ask');
  });

  test('close failure does not mask successful result', async () => {
    closeShouldThrow = true;
    const { CursorProvider } = await import('./provider');
    const { chunks, error } = await collect(new CursorProvider().sendQuery('hi', '/repo'));
    expect(error).toBeUndefined();
    expect(chunks.some(c => (c as { type: string }).type === 'result')).toBe(true);
  });
});
