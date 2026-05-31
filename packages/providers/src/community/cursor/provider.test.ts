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
  cancelled: boolean;
  stream(): AsyncGenerator<SDKMessage>;
  wait(): Promise<FakeRun['waitResult']>;
  supports(op: string): boolean;
  cancel(): Promise<void>;
};

function makeFakeRun(
  events: SDKMessage[],
  waitResult: FakeRun['waitResult'] = { status: 'finished', result: 'done' }
): FakeRun {
  const run: FakeRun = {
    id: 'run-1',
    streamEvents: events,
    waitResult,
    cancelled: false,
    async *stream() {
      for (const event of run.streamEvents) {
        yield event;
      }
    },
    wait: async () => run.waitResult,
    supports: op => op === 'cancel',
    cancel: async () => {
      run.cancelled = true;
    },
  };
  return run;
}

let lastCreateOptions: Record<string, unknown> | undefined;
let lastResumeId: string | undefined;
let lastSendPrompt: string | undefined;
let lastSendOptions: Record<string, unknown> | undefined;
let nextAgentId = 'agent-abc';
let resumeShouldFail = false;

class FakeAgent {
  agentId: string;
  closed = false;

  constructor() {
    this.agentId = nextAgentId;
  }

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
          content: [{ type: 'text', text: 'Hello from Cursor' }],
        },
      },
    ]);
  }

  close() {
    this.closed = true;
  }

  async reload() {
    /* noop */
  }

  async [Symbol.asyncDispose]() {
    this.close();
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
      return new FakeAgent();
    }),
    resume: mock(async (agentId: string, options: Record<string, unknown>) => {
      lastResumeId = agentId;
      lastCreateOptions = options;
      if (resumeShouldFail) {
        throw new Error('agent not found');
      }
      const agent = new FakeAgent();
      agent.agentId = agentId;
      return agent;
    }),
  },
}));

describe('CursorProvider', () => {
  beforeEach(() => {
    lastCreateOptions = undefined;
    lastResumeId = undefined;
    lastSendPrompt = undefined;
    lastSendOptions = undefined;
    nextAgentId = 'agent-abc';
    resumeShouldFail = false;
    process.env.CURSOR_API_KEY = 'test-key';
  });

  test('creates a local agent and streams assistant output with terminal result', async () => {
    const { CursorProvider } = await import('./provider');
    const provider = new CursorProvider();
    const chunks = [];
    for await (const chunk of provider.sendQuery('Say hi', '/tmp/repo')) {
      chunks.push(chunk);
    }

    expect(
      chunks.some(c => c.type === 'assistant' && c.content.includes('Hello from Cursor'))
    ).toBe(true);
    const result = chunks.find(c => c.type === 'result');
    expect(result?.sessionId).toBe('agent-abc');
    expect(lastCreateOptions?.apiKey).toBe('test-key');
    expect(lastCreateOptions?.local).toEqual(
      expect.objectContaining({ cwd: '/tmp/repo', settingSources: [] })
    );
    const model = lastCreateOptions?.model as {
      id: string;
      params?: { id: string; value: string }[];
    };
    expect(model.id).toBe('auto');
    expect(model.params).toEqual(expect.arrayContaining([{ id: 'thinking', value: 'low' }]));
    expect(lastSendPrompt).toBe('Say hi');
  });

  test('resumes agent when resumeSessionId is provided', async () => {
    const { CursorProvider } = await import('./provider');
    const provider = new CursorProvider();
    const chunks = [];
    for await (const chunk of provider.sendQuery('Continue', '/tmp/repo', 'agent-old')) {
      chunks.push(chunk);
    }

    expect(lastResumeId).toBe('agent-old');
    expect(chunks.some(c => c.type === 'result' && c.sessionId === 'agent-old')).toBe(true);
  });

  test('falls back to fresh agent when resume fails', async () => {
    resumeShouldFail = true;
    const { CursorProvider } = await import('./provider');
    const provider = new CursorProvider();
    const chunks = [];
    for await (const chunk of provider.sendQuery('Continue', '/tmp/repo', 'agent-missing')) {
      chunks.push(chunk);
    }

    expect(lastResumeId).toBe('agent-missing');
    expect(chunks.some(c => c.type === 'system' && c.content.includes('Could not resume'))).toBe(
      true
    );
    expect(lastCreateOptions).toBeDefined();
  });

  test('throws when API key is missing', async () => {
    delete process.env.CURSOR_API_KEY;
    const { CursorProvider } = await import('./provider');
    const provider = new CursorProvider();

    await expect(async () => {
      for await (const _chunk of provider.sendQuery('Hi', '/tmp/repo')) {
        /* drain */
      }
    }).toThrow(/API key is required/);
  });
});
