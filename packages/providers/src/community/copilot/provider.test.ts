import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../../test/mocks/logger';

// ─── Mock @archon/paths logger ──────────────────────────────────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// ─── Mock binary-resolver (dev mode: always returns undefined) ──────────

const mockResolveBinaryPath = mock(async () => undefined as string | undefined);
mock.module('./binary-resolver', () => ({
  resolveCopilotBinaryPath: mockResolveBinaryPath,
}));

// ─── Mock event-bridge bridgeCopilotSession ─────────────────────────────
//
// We control what chunks the bridge emits so provider.test.ts doesn't
// exercise the bridge logic (that's event-bridge.test.ts's job).

type BridgeArgs = [session: unknown, client: unknown, prompt: string, abortSignal?: AbortSignal];

const bridgeScriptedChunks: unknown[] = [];
async function* mockBridgeGenerator(
  _session: unknown,
  _client: unknown,
  _prompt: string,
  _abortSignal?: AbortSignal
): AsyncGenerator<unknown> {
  for (const chunk of bridgeScriptedChunks) yield chunk;
}

const mockBridgeCopilotSession = mock((..._args: BridgeArgs) => mockBridgeGenerator(..._args));
mock.module('./event-bridge', () => ({
  bridgeCopilotSession: mockBridgeCopilotSession,
}));

// ─── Mock @github/copilot/copilot-sdk ───────────────────────────────────

const mockCreateSession = mock(async (_config: unknown) => ({
  sessionId: 'new-session-id',
}));
const mockResumeSession = mock(async (_id: string, _config: unknown) => ({
  sessionId: 'resumed-session-id',
}));
const mockClientStop = mock(async () => []);

function makeMockClient() {
  return {
    createSession: mockCreateSession,
    resumeSession: mockResumeSession,
    stop: mockClientStop,
  };
}

const MockCopilotClient = mock((_opts: unknown) => makeMockClient());
const mockApproveAll = mock(async (_req: unknown) => undefined);

mock.module('@github/copilot/copilot-sdk', () => ({
  CopilotClient: MockCopilotClient,
  approveAll: mockApproveAll,
}));

// Import AFTER mocks are set.
import { CopilotSdkProvider } from './provider';
import { COPILOT_CAPABILITIES } from './capabilities';

// ─── Helpers ─────────────────────────────────────────────────────────────

async function consume(
  gen: AsyncGenerator<unknown>
): Promise<{ chunks: unknown[]; error?: Error }> {
  const chunks: unknown[] = [];
  try {
    for await (const chunk of gen) chunks.push(chunk);
    return { chunks };
  } catch (err) {
    return { chunks, error: err as Error };
  }
}

function scriptedChunks(chunks: unknown[]): void {
  bridgeScriptedChunks.length = 0;
  bridgeScriptedChunks.push(...chunks);
}

const DEFAULT_RESULT_CHUNK = {
  type: 'result',
  sessionId: 'new-session-id',
  tokens: { input: 10, output: 5, total: 15 },
};

// ─── Test Suite ──────────────────────────────────────────────────────────

describe('CopilotSdkProvider', () => {
  beforeEach(() => {
    mockLogger.fatal.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.trace.mockClear();
    mockResolveBinaryPath.mockClear();
    mockBridgeCopilotSession.mockClear();
    MockCopilotClient.mockClear();
    mockCreateSession.mockClear();
    mockResumeSession.mockClear();
    mockClientStop.mockClear();

    bridgeScriptedChunks.length = 0;
    bridgeScriptedChunks.push(DEFAULT_RESULT_CHUNK);

    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  test('getType() returns "copilot"', () => {
    expect(new CopilotSdkProvider().getType()).toBe('copilot');
  });

  test('getCapabilities() matches COPILOT_CAPABILITIES constant', () => {
    expect(new CopilotSdkProvider().getCapabilities()).toEqual(COPILOT_CAPABILITIES);
  });

  test('sendQuery yields chunks from bridge and logs completion', async () => {
    scriptedChunks([{ type: 'assistant', content: 'Hello!' }, DEFAULT_RESULT_CHUNK]);

    const { chunks, error } = await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    expect(error).toBeUndefined();
    expect(chunks).toContainEqual({ type: 'assistant', content: 'Hello!' });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp' }),
      'copilot.prompt_completed'
    );
  });

  test('sendQuery creates a CopilotClient and session', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hello', '/repo'));

    expect(MockCopilotClient).toHaveBeenCalledTimes(1);
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockBridgeCopilotSession).toHaveBeenCalledTimes(1);
  });

  test('sessionConfig includes workingDirectory', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/myproject'));

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect(sessionConfig.workingDirectory).toBe('/myproject');
  });

  test('sessionConfig includes onPermissionRequest: approveAll', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect(sessionConfig.onPermissionRequest).toBe(mockApproveAll);
  });

  // ─── Token resolution ────────────────────────────────────────────────

  test('COPILOT_GITHUB_TOKEN env var highest priority for token', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'copilot-token';
    process.env.GH_TOKEN = 'gh-token';
    process.env.GITHUB_TOKEN = 'github-token';

    await consume(
      new CopilotSdkProvider().sendQuery('hi', '/tmp', undefined, {
        assistantConfig: { githubToken: 'config-token' },
      })
    );

    const [clientOpts] = MockCopilotClient.mock.calls[0] as [Record<string, unknown>];
    expect(clientOpts.githubToken).toBe('copilot-token');
  });

  test('GH_TOKEN used when COPILOT_GITHUB_TOKEN absent', async () => {
    process.env.GH_TOKEN = 'gh-token';
    process.env.GITHUB_TOKEN = 'github-token';

    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    const [clientOpts] = MockCopilotClient.mock.calls[0] as [Record<string, unknown>];
    expect(clientOpts.githubToken).toBe('gh-token');
  });

  test('GITHUB_TOKEN used when COPILOT_GITHUB_TOKEN and GH_TOKEN absent', async () => {
    process.env.GITHUB_TOKEN = 'github-token';

    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    const [clientOpts] = MockCopilotClient.mock.calls[0] as [Record<string, unknown>];
    expect(clientOpts.githubToken).toBe('github-token');
  });

  test('assistantConfig.githubToken used when no env vars set', async () => {
    await consume(
      new CopilotSdkProvider().sendQuery('hi', '/tmp', undefined, {
        assistantConfig: { githubToken: 'config-token' },
      })
    );

    const [clientOpts] = MockCopilotClient.mock.calls[0] as [Record<string, unknown>];
    expect(clientOpts.githubToken).toBe('config-token');
  });

  test('no token → githubToken absent from clientOptions (SDK uses its own auth)', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    const [clientOpts] = MockCopilotClient.mock.calls[0] as [Record<string, unknown>];
    expect('githubToken' in clientOpts).toBe(false);
  });

  // ─── Model wiring ────────────────────────────────────────────────────

  test('requestOptions.model forwarded to sessionConfig', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp', undefined, { model: 'gpt-4o' }));

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect(sessionConfig.model).toBe('gpt-4o');
  });

  test('assistantConfig.model used when requestOptions.model absent', async () => {
    await consume(
      new CopilotSdkProvider().sendQuery('hi', '/tmp', undefined, {
        assistantConfig: { model: 'claude-opus' },
      })
    );

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect(sessionConfig.model).toBe('claude-opus');
  });

  test('requestOptions.model wins over assistantConfig.model', async () => {
    await consume(
      new CopilotSdkProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'request-model',
        assistantConfig: { model: 'config-model' },
      })
    );

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect(sessionConfig.model).toBe('request-model');
  });

  test('no model → model key absent from sessionConfig', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect('model' in sessionConfig).toBe(false);
  });

  // ─── Tool restrictions ───────────────────────────────────────────────

  test('nodeConfig.allowed_tools forwarded to sessionConfig.availableTools', async () => {
    await consume(
      new CopilotSdkProvider().sendQuery('hi', '/tmp', undefined, {
        nodeConfig: { allowed_tools: ['read', 'write'] },
      })
    );

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect(sessionConfig.availableTools).toEqual(['read', 'write']);
  });

  test('nodeConfig.denied_tools forwarded to sessionConfig.excludedTools', async () => {
    await consume(
      new CopilotSdkProvider().sendQuery('hi', '/tmp', undefined, {
        nodeConfig: { denied_tools: ['bash'] },
      })
    );

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect(sessionConfig.excludedTools).toEqual(['bash']);
  });

  test('no tool restrictions → availableTools and excludedTools absent', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect('availableTools' in sessionConfig).toBe(false);
    expect('excludedTools' in sessionConfig).toBe(false);
  });

  // ─── Effort control ──────────────────────────────────────────────────

  test('nodeConfig.effort forwarded to sessionConfig.reasoningEffort', async () => {
    await consume(
      new CopilotSdkProvider().sendQuery('hi', '/tmp', undefined, {
        nodeConfig: { effort: 'high' },
      })
    );

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect(sessionConfig.reasoningEffort).toBe('high');
  });

  test('no effort → reasoningEffort absent from sessionConfig', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect('reasoningEffort' in sessionConfig).toBe(false);
  });

  // ─── System prompt ───────────────────────────────────────────────────

  test('requestOptions.systemPrompt forwarded to sessionConfig.systemMessage', async () => {
    await consume(
      new CopilotSdkProvider().sendQuery('hi', '/tmp', undefined, {
        systemPrompt: 'Be concise.',
      })
    );

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect(sessionConfig.systemMessage).toEqual({ mode: 'append', content: 'Be concise.' });
  });

  test('no systemPrompt → systemMessage absent from sessionConfig', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect('systemMessage' in sessionConfig).toBe(false);
  });

  // ─── Env injection ───────────────────────────────────────────────────

  test('requestOptions.env merged into clientOptions.env over process.env', async () => {
    await consume(
      new CopilotSdkProvider().sendQuery('hi', '/tmp', undefined, {
        env: { MY_VAR: 'injected' },
      })
    );

    const [clientOpts] = MockCopilotClient.mock.calls[0] as [Record<string, unknown>];
    const env = clientOpts.env as Record<string, string>;
    expect(env.MY_VAR).toBe('injected');
    // process.env entries should be present too
    expect(typeof env.PATH).toBe('string');
  });

  test('empty requestOptions.env → env key absent from clientOptions', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp', undefined, { env: {} }));

    const [clientOpts] = MockCopilotClient.mock.calls[0] as [Record<string, unknown>];
    expect('env' in clientOpts).toBe(false);
  });

  test('no requestOptions.env → env key absent from clientOptions', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    const [clientOpts] = MockCopilotClient.mock.calls[0] as [Record<string, unknown>];
    expect('env' in clientOpts).toBe(false);
  });

  // ─── Session resume ──────────────────────────────────────────────────

  test('resumeSessionId triggers resumeSession call', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp', 'existing-session-id'));

    expect(mockResumeSession).toHaveBeenCalledTimes(1);
    const [resumeId] = mockResumeSession.mock.calls[0] as [string, unknown];
    expect(resumeId).toBe('existing-session-id');
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test('resume failure falls back to fresh session + system warning chunk', async () => {
    mockResumeSession.mockImplementationOnce(() => {
      throw new Error('session not found');
    });
    // Bridge is called after session created — prepend a system chunk via spy
    let capturedSession: unknown;
    mockBridgeCopilotSession.mockImplementationOnce(async function* (
      session: unknown,
      _client: unknown,
      _prompt: string
    ) {
      capturedSession = session;
      yield DEFAULT_RESULT_CHUNK;
    });

    const { chunks, error } = await consume(
      new CopilotSdkProvider().sendQuery('hi', '/tmp', 'bad-id')
    );

    expect(error).toBeUndefined();
    // Fell back to createSession
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    // System warning yielded before bridge
    const systemChunks = chunks.filter(
      (c): c is { type: string; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('Could not resume'))).toBe(true);
    expect(capturedSession).toBeDefined();
  });

  test('no resumeSessionId → createSession called, resumeSession not called', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockResumeSession).not.toHaveBeenCalled();
  });

  // ─── Bridge integration ──────────────────────────────────────────────

  test('bridgeCopilotSession receives prompt, session, client, and abortSignal', async () => {
    const controller = new AbortController();

    await consume(
      new CopilotSdkProvider().sendQuery('my prompt', '/tmp', undefined, {
        abortSignal: controller.signal,
      })
    );

    expect(mockBridgeCopilotSession).toHaveBeenCalledTimes(1);
    const [_session, _client, prompt, signal] = mockBridgeCopilotSession.mock
      .calls[0] as BridgeArgs;
    expect(prompt).toBe('my prompt');
    expect(signal).toBe(controller.signal);
  });

  test('bridge error is re-thrown and logged', async () => {
    const bridgeError = new Error('bridge blew up');
    mockBridgeCopilotSession.mockImplementationOnce(async function* () {
      throw bridgeError;
    });

    const { error } = await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    expect(error?.message).toBe('bridge blew up');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp' }),
      'copilot.prompt_failed'
    );
  });

  // ─── MCP config ──────────────────────────────────────────────────────

  test('nodeConfig.mcp empty string → mcpServers absent from sessionConfig', async () => {
    await consume(
      new CopilotSdkProvider().sendQuery('hi', '/tmp', undefined, {
        nodeConfig: { mcp: '' },
      })
    );

    const [sessionConfig] = mockCreateSession.mock.calls[0] as [Record<string, unknown>];
    expect('mcpServers' in sessionConfig).toBe(false);
  });

  // ─── ClientOptions ───────────────────────────────────────────────────

  test('useStdio: true always set in clientOptions', async () => {
    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    const [clientOpts] = MockCopilotClient.mock.calls[0] as [Record<string, unknown>];
    expect(clientOpts.useStdio).toBe(true);
  });

  test('cliPath from binary resolver forwarded to clientOptions', async () => {
    mockResolveBinaryPath.mockImplementationOnce(async () => '/usr/local/bin/copilot');

    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    const [clientOpts] = MockCopilotClient.mock.calls[0] as [Record<string, unknown>];
    expect(clientOpts.cliPath).toBe('/usr/local/bin/copilot');
  });

  test('undefined cliPath → cliPath absent from clientOptions', async () => {
    mockResolveBinaryPath.mockImplementationOnce(async () => undefined);

    await consume(new CopilotSdkProvider().sendQuery('hi', '/tmp'));

    const [clientOpts] = MockCopilotClient.mock.calls[0] as [Record<string, unknown>];
    expect('cliPath' in clientOpts).toBe(false);
  });
});
