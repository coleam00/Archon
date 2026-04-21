import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  sessionId: 'copilot-session-mcp',
  on: mock((eventType: string, handler: SessionHandler) => {
    registeredHandlers[eventType] ??= [];
    registeredHandlers[eventType].push(handler);
    return () => undefined;
  }),
  sendAndWait: mock(async () => ({
    data: { content: 'ok', messageId: 'm' },
  })),
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

async function collectChunks(generator: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

let workDir = '';

describe('applyMcpServers', () => {
  beforeEach(() => {
    registeredHandlers = {};
    capturedSessionConfigs.length = 0;
    mockCreateSession.mockClear();
    workDir = mkdtempSync(join(tmpdir(), 'copilot-mcp-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    delete process.env.COPILOT_MCP_TEST_TOKEN;
  });

  test('omits mcpServers when nodeConfig.mcp is absent', async () => {
    await collectChunks(
      new CopilotProvider().sendQuery('hi', workDir, undefined, { model: 'gpt-5' })
    );

    const cfg = capturedSessionConfigs[0] ?? {};
    expect(cfg.mcpServers).toBeUndefined();
  });

  test('loads MCP JSON and assigns to SessionConfig.mcpServers', async () => {
    const mcpPath = join(workDir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({
        'example-server': {
          type: 'local',
          command: 'node',
          args: ['server.js'],
          tools: ['*'],
        },
      })
    );

    await collectChunks(
      new CopilotProvider().sendQuery('hi', workDir, undefined, {
        model: 'gpt-5',
        nodeConfig: { mcp: 'mcp.json' },
      })
    );

    const cfg = capturedSessionConfigs[0] ?? {};
    expect(cfg.mcpServers).toEqual({
      'example-server': {
        type: 'local',
        command: 'node',
        args: ['server.js'],
        tools: ['*'],
      },
    });
  });

  test('expands env vars and warns on missing ones', async () => {
    process.env.COPILOT_MCP_TEST_TOKEN = 'secret-value';
    const mcpPath = join(workDir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({
        'env-server': {
          type: 'local',
          command: 'node',
          args: ['server.js'],
          tools: ['*'],
          env: {
            SET_VAR: '$COPILOT_MCP_TEST_TOKEN',
            MISSING_VAR: '$COPILOT_MCP_NOT_DEFINED',
          },
        },
      })
    );

    const chunks = await collectChunks(
      new CopilotProvider().sendQuery('hi', workDir, undefined, {
        model: 'gpt-5',
        nodeConfig: { mcp: 'mcp.json' },
      })
    );

    const cfg = capturedSessionConfigs[0] ?? {};
    const servers = cfg.mcpServers as Record<string, { env?: Record<string, string> }>;
    expect(servers['env-server']?.env?.SET_VAR).toBe('secret-value');
    expect(servers['env-server']?.env?.MISSING_VAR).toBe('');

    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'system',
        content: expect.stringContaining('COPILOT_MCP_NOT_DEFINED'),
      })
    );
  });

  test('propagates loadMcpConfig errors (missing file)', async () => {
    let caught: Error | undefined;
    try {
      await collectChunks(
        new CopilotProvider().sendQuery('hi', workDir, undefined, {
          model: 'gpt-5',
          nodeConfig: { mcp: 'does-not-exist.json' },
        })
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toContain('MCP config file not found');
  });
});
