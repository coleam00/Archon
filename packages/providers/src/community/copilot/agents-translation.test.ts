import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

mock.module('@archon/paths', () => ({
  createLogger: () => mockLogger,
}));

mock.module('./binary-resolver', () => ({
  resolveCopilotCliPath: async () => '/usr/local/bin/copilot',
}));

type SessionHandler = (event: Record<string, unknown>) => void;

let registeredHandlers: Record<string, SessionHandler[]> = {};
const mockSession = {
  sessionId: 'copilot-session-agents',
  on: mock((eventType: string, handler: SessionHandler) => {
    registeredHandlers[eventType] ??= [];
    registeredHandlers[eventType].push(handler);
    return () => undefined;
  }),
  sendAndWait: mock(async () => ({ data: { content: 'ok', messageId: 'm' } })),
  abort: mock(async () => undefined),
  disconnect: mock(async () => undefined),
};

const capturedSessionConfigs: Array<Record<string, unknown>> = [];
const mockCreateSession = mock(async (config: Record<string, unknown>) => {
  capturedSessionConfigs.push(config);
  return mockSession;
});

mock.module('@github/copilot-sdk', () => ({
  approveAll: () => ({ kind: 'approved' }),
  CopilotClient: class MockCopilotClient {
    createSession = mockCreateSession;
    resumeSession = mock(async () => mockSession);
    stop = mock(async () => []);
  },
}));

import { CopilotProvider } from './provider';

async function collect(generator: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

describe('applyAgents', () => {
  beforeEach(() => {
    registeredHandlers = {};
    capturedSessionConfigs.length = 0;
    mockCreateSession.mockClear();
  });

  test('omits customAgents when nodeConfig.agents is absent', async () => {
    await collect(new CopilotProvider().sendQuery('hi', '/repo', undefined, { model: 'gpt-5' }));

    expect(capturedSessionConfigs).toHaveLength(1);
    const cfg = capturedSessionConfigs[0]!;
    expect(cfg.customAgents).toBeUndefined();
  });

  test('omits customAgents when agents is an empty object', async () => {
    await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        model: 'gpt-5',
        nodeConfig: { agents: {} },
      })
    );

    expect(capturedSessionConfigs).toHaveLength(1);
    const cfg = capturedSessionConfigs[0]!;
    expect(cfg.customAgents).toBeUndefined();
  });

  test('maps name/description/prompt verbatim, passes tools allowlist', async () => {
    await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        model: 'gpt-5',
        nodeConfig: {
          agents: {
            'code-searcher': {
              description: 'Searches the repo for relevant code',
              prompt: 'You are a code-search specialist. Be thorough.',
              tools: ['read_file', 'grep'],
            },
          },
        },
      })
    );

    expect(capturedSessionConfigs).toHaveLength(1);
    const cfg = capturedSessionConfigs[0]!;
    expect(cfg.customAgents).toEqual([
      {
        name: 'code-searcher',
        description: 'Searches the repo for relevant code',
        prompt: 'You are a code-search specialist. Be thorough.',
        tools: ['read_file', 'grep'],
      },
    ]);
  });

  test('omits tools when not specified (Copilot treats undefined as "all")', async () => {
    await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        nodeConfig: {
          agents: {
            'free-agent': {
              description: 'has all tools',
              prompt: 'do anything',
            },
          },
        },
      })
    );

    expect(capturedSessionConfigs).toHaveLength(1);
    const cfg = capturedSessionConfigs[0]!;
    const agents = cfg.customAgents as Array<Record<string, unknown>>;
    expect(agents[0]).not.toHaveProperty('tools');
  });

  test('emits one warning per agent listing ignored Claude-specific fields', async () => {
    const chunks = await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        nodeConfig: {
          agents: {
            'over-spec': {
              description: 'has everything',
              prompt: 'hello',
              model: 'claude-sonnet-4.5',
              disallowedTools: ['shell'],
              skills: ['planning'],
              maxTurns: 5,
            },
          },
        },
      })
    );

    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    const match = systemChunks.find(c => c.content.includes("agent 'over-spec'"));
    expect(match).toBeDefined();
    expect(match?.content).toContain('model');
    expect(match?.content).toContain('disallowedTools');
    expect(match?.content).toContain('skills');
    expect(match?.content).toContain('maxTurns');

    // SessionConfig.customAgents still gets the agent with the supported fields only
    expect(capturedSessionConfigs).toHaveLength(1);
    const cfg = capturedSessionConfigs[0]!;
    const agents = cfg.customAgents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toEqual({
      name: 'over-spec',
      description: 'has everything',
      prompt: 'hello',
    });
  });

  test('maps multiple agents preserving key order', async () => {
    await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        nodeConfig: {
          agents: {
            'first-one': { description: 'a', prompt: 'p1' },
            'second-one': { description: 'b', prompt: 'p2' },
          },
        },
      })
    );

    expect(capturedSessionConfigs).toHaveLength(1);
    const cfg = capturedSessionConfigs[0]!;
    const agents = cfg.customAgents as Array<{ name: string }>;
    expect(agents.map(a => a.name)).toEqual(['first-one', 'second-one']);
  });

  test('does NOT set SessionConfig.agent (Archon invokes sub-agents via Task tool)', async () => {
    await collect(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        nodeConfig: {
          agents: {
            'only-agent': { description: 'x', prompt: 'y' },
          },
        },
      })
    );

    expect(capturedSessionConfigs).toHaveLength(1);
    const cfg = capturedSessionConfigs[0]!;
    expect(cfg.agent).toBeUndefined();
  });
});
