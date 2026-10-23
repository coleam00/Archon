// @archon-test-isolated
/** Shared mocks for discovery and chat integration live in `../test/orchestrator-agent-harness`. */
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import {
  DEFAULT_PROVIDER_CAPS,
  makeCodebaseForSync,
  makeConfig,
  makeConversation,
  makePlatform,
  mockDiscoverWorkflowsWithConfig,
  mockDispatchBackgroundWorkflow,
  mockEnsureArchonWorkspacesPath,
  mockGetCodebase,
  mockGetCodebaseEnvVars,
  mockGetDefaultRemote,
  mockGetOrCreateConversation,
  mockGetRecentWorkflowResultMessages,
  mockListCodebases,
  mockLoadConfig,
  mockLoadRepoConfig,
  mockLogger,
  mockSendQuery,
  mockSyncWorkspace,
  operator,
} from '../test/orchestrator-agent-harness';
import { handleMessage } from './orchestrator-agent';
import { discoverAllWorkflows } from './chat-context';
import { buildOrchestratorSystemAppend } from './prompt-builder';

// ─── discoverAllWorkflows — remote sync ───────────────────────────────────────

describe('discoverAllWorkflows — remote sync', () => {
  beforeEach(() => {
    mockSyncWorkspace.mockClear();
    mockGetDefaultRemote.mockClear();
    mockGetDefaultRemote.mockImplementation(() => Promise.resolve('origin'));
    mockLoadRepoConfig.mockClear();
    mockLoadRepoConfig.mockImplementation(() => Promise.resolve({}));
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockSendQuery.mockClear();
    mockGetCodebaseEnvVars.mockReset();
    mockLoadConfig.mockReset();
    mockEnsureArchonWorkspacesPath.mockClear();
    // Reset mocks between tests in this suite and restore safe defaults
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockGetCodebaseEnvVars.mockImplementation(() => Promise.resolve({}));
    mockLoadConfig.mockImplementation(() =>
      Promise.resolve(
        makeConfig({
          assistants: { claude: {}, codex: {} },
          envVars: {},
        })
      )
    );
  });

  test('calls syncWorkspace with codebase.default_cwd when conversation has codebase_id', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?', { actor: operator });

    // Non-destructive default sync (#1864): no explicit reset mode, only the
    // resolved remote rides in the options.
    expect(mockSyncWorkspace).toHaveBeenCalledWith('/repos/test-repo', undefined, {
      remote: 'origin',
    });
    // cwd resolution behavior — scoped chat runs the provider in the repo's
    // default_cwd (not the workspaces root) and skips ensureArchonWorkspacesPath
    // — is covered by the 'provider cwd resolution' describe block (issue #1179).
  });

  test('does not pass reset mode for managed clones during chat sync', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = {
      ...makeCodebaseForSync(),
      default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
    };
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?', { actor: operator });

    expect(mockSyncWorkspace).toHaveBeenCalledWith(
      '/home/test/.archon/workspaces/owner/repo/source',
      undefined,
      { remote: 'origin' }
    );
  });

  test('passes stored default_branch when present', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = { ...makeCodebaseForSync(), default_branch: 'develop' };
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?', { actor: operator });

    expect(mockSyncWorkspace).toHaveBeenCalledWith('/repos/test-repo', 'develop', {
      remote: 'origin',
    });
  });

  test('passes configured worktree.remote through to syncWorkspace', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockLoadRepoConfig.mockResolvedValueOnce({ worktree: { remote: 'mar' } });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?', { actor: operator });

    expect(mockSyncWorkspace).toHaveBeenCalledWith(
      '/repos/test-repo',
      undefined,
      expect.objectContaining({ remote: 'mar' })
    );
    // Explicit config wins — auto-detection must not run
    expect(mockGetDefaultRemote).not.toHaveBeenCalled();
  });

  test('auto-detects the remote when worktree.remote is not configured', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockGetDefaultRemote.mockResolvedValueOnce('upstream');

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?', { actor: operator });

    expect(mockSyncWorkspace).toHaveBeenCalledWith(
      '/repos/test-repo',
      undefined,
      expect.objectContaining({ remote: 'upstream' })
    );
  });

  test('proceeds without throwing when syncWorkspace rejects', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockSyncWorkspace.mockRejectedValueOnce(new Error('Network timeout'));

    const platform = makePlatform();
    // Non-fatal: no exception propagated
    await expect(
      handleMessage(platform, 'conv-1', 'What is the latest commit?', { actor: operator })
    ).resolves.toBeUndefined();
    expect(mockSyncWorkspace).toHaveBeenCalledWith('/repos/test-repo', undefined, {
      remote: 'origin',
    });
  });

  test('does not call syncWorkspace when conversation has no codebase_id', async () => {
    const conversation = makeConversation({ codebase_id: null });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-2', 'Hello', { actor: operator });

    expect(mockSyncWorkspace).not.toHaveBeenCalled();
  });

  test('does not call syncWorkspace for a folder project (no Archon-managed sync)', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = { ...makeCodebaseForSync(), kind: 'folder' as const, repository_url: null };
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Summarize the folder structure.', { actor: operator });

    expect(mockSyncWorkspace).not.toHaveBeenCalled();
  });

  test('logs a warn when syncWorkspace rejects', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockSyncWorkspace.mockRejectedValueOnce(new Error('Network timeout'));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?', { actor: operator });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'codebase-1' }),
      'workspace.sync_failed'
    );
  });

  test('passes merged repo and DB env vars to provider for codebase-scoped chat', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockGetCodebaseEnvVars.mockResolvedValueOnce({ DB_SECRET: 'db-value' });
    mockLoadConfig.mockResolvedValueOnce(
      makeConfig({
        assistants: { claude: {}, codex: {} },
        envVars: { FILE_SECRET: 'file-value' },
      })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?', { actor: operator });

    expect(mockSendQuery).toHaveBeenCalled();
    const requestOptions = mockSendQuery.mock.calls[0][3] as Record<string, unknown>;
    expect(requestOptions.env).toEqual({
      FILE_SECRET: 'file-value',
      DB_SECRET: 'db-value',
    });
  });

  test('does not load codebase env vars when conversation has no codebase_id', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeConversation()));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello', { actor: operator });

    expect(mockGetCodebaseEnvVars).not.toHaveBeenCalled();
  });

  test('falls back to config env when codebase env loading fails', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockGetCodebaseEnvVars.mockRejectedValueOnce(new Error('db unavailable'));
    mockLoadConfig.mockResolvedValueOnce(
      makeConfig({
        assistants: { claude: {}, codex: {} },
        envVars: { FILE_SECRET: 'file-value' },
      })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?', { actor: operator });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'codebase-1' }),
      'codebase_env_vars_load_failed'
    );
    const requestOptions = mockSendQuery.mock.calls[0][3] as Record<string, unknown>;
    expect(requestOptions.env).toEqual({
      FILE_SECRET: 'file-value',
    });
  });

  test.each(['stub-plugin', 'claude'])(
    'sends the orchestrator instructions as appendSystemPrompt to %s',
    async provider => {
      mockGetOrCreateConversation.mockReturnValueOnce(
        Promise.resolve(makeConversation({ ai_assistant_type: provider }))
      );
      mockLoadConfig.mockResolvedValueOnce(
        makeConfig({
          tiers: {
            small: { provider, model: 'small-model' },
            large: { provider, model: 'large-model' },
          },
        })
      );

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', 'Hello', { actor: operator });

      expect(mockSendQuery).toHaveBeenCalled();
      const requestOptions = mockSendQuery.mock.calls[0][3] as Record<string, unknown>;
      expect(requestOptions.appendSystemPrompt).toBe('orchestrator system append');
      expect(requestOptions).not.toHaveProperty('systemPrompt');
    }
  );

  test('selects CLI guidance without native tools for a scoped non-native-tool provider', async () => {
    const providers = await import('@archon/providers');
    const capsMock = providers.getProviderCapabilities as ReturnType<typeof mock>;
    capsMock.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS, nativeTools: false });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ ai_assistant_type: 'codex', codebase_id: 'codebase-1' }))
    );
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));

    try {
      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', 'Hello', { actor: operator });

      const requestOptions = mockSendQuery.mock.calls[0][3] as Record<string, unknown>;
      expect(buildOrchestratorSystemAppend).toHaveBeenLastCalledWith(
        expect.objectContaining({ codebase_id: 'codebase-1' }),
        [codebase],
        expect.any(Array),
        'cli'
      );
      // Providers without native tools get NO in-process tool — bash CLI only.
      expect(requestOptions.nativeTools).toBeUndefined();
    } finally {
      capsMock.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS });
    }
  });

  test('selects native guidance and injects native tools for a scoped native-tool provider', async () => {
    const providers = await import('@archon/providers');
    const capsMock = providers.getProviderCapabilities as ReturnType<typeof mock>;
    capsMock.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS, nativeTools: true });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ ai_assistant_type: 'claude', codebase_id: 'codebase-1' }))
    );
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));

    try {
      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', 'Hello', { actor: operator });

      const requestOptions = mockSendQuery.mock.calls[0][3] as Record<string, unknown>;
      expect(buildOrchestratorSystemAppend).toHaveBeenLastCalledWith(
        expect.objectContaining({ codebase_id: 'codebase-1' }),
        [codebase],
        expect.any(Array),
        'tools'
      );
      // Native-tool provider gets the manage_run tool instead.
      expect(Array.isArray(requestOptions.nativeTools)).toBe(true);
    } finally {
      capsMock.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS });
    }
  });
});

// ─── discoverAllWorkflows — merge with WorkflowWithSource ────────────────────

describe('discoverAllWorkflows — merge repo workflows over global', () => {
  beforeEach(() => {
    mockSyncWorkspace.mockClear();
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDispatchBackgroundWorkflow.mockClear();
    mockLogger.warn.mockClear();

    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
  });

  test('repo-specific workflows override global workflows by name without changing their order', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    mockGetCodebase.mockResolvedValueOnce(makeCodebaseForSync());
    const globalOnly = makeTestWorkflowWithSource({ name: 'global-only' });
    const globalAssist = makeTestWorkflowWithSource({
      name: 'assist',
      description: 'Global assist',
    });
    const repoAssist = makeTestWorkflowWithSource(
      { name: 'assist', description: 'Repo assist' },
      'project'
    );
    const repoOnly = makeTestWorkflowWithSource({ name: 'repo-only' }, 'project');
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [globalAssist, globalOnly],
      errors: [],
    });
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [repoAssist, repoOnly],
      errors: [],
    });

    const result = await discoverAllWorkflows(conversation);

    expect(result.workflows).toEqual([repoAssist, globalOnly, repoOnly]);
    expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledTimes(2);
  });

  test('a repository config that fails to load fails the turn instead of listing no repo workflows', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ codebase_id: 'codebase-1' }))
    );
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebaseForSync()));
    const configError = new Error(
      "Invalid model binding config in '/repos/test-repo/.archon/config.yaml': tiers.medium.thinking"
    );
    mockLoadConfig.mockRejectedValueOnce(configError);
    mockSendQuery.mockClear();

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?', { actor: operator });

    expect(mockSendQuery).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('tiers.medium.thinking')
    );
  });
});

// ─── handleMessage — workflow context injection ───────────────────────────────

describe('handleMessage — workflow context injection', () => {
  beforeEach(() => {
    mockGetRecentWorkflowResultMessages.mockClear();
    mockGetOrCreateConversation.mockReset();
    mockListCodebases.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockLogger.warn.mockClear();

    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    mockGetRecentWorkflowResultMessages.mockImplementation(() => Promise.resolve([]));
  });

  test('calls getRecentWorkflowResultMessages for the conversation', async () => {
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What happened?', { actor: operator });

    expect(mockGetRecentWorkflowResultMessages).toHaveBeenCalledWith('conv-1-db', 3);
  });

  test('does not throw when getRecentWorkflowResultMessages returns empty array', async () => {
    mockGetRecentWorkflowResultMessages.mockResolvedValueOnce([]);
    const platform = makePlatform();

    await expect(
      handleMessage(platform, 'conv-1', 'Hello', { actor: operator })
    ).resolves.toBeUndefined();
  });

  test('handles malformed metadata JSON without throwing', async () => {
    const badRow = {
      id: 'msg-1',
      conversation_id: 'conv-1',
      role: 'assistant' as const,
      content: 'Summary.',
      metadata: 'not-valid-json',
      user_id: null,
      created_at: '2026-01-01T00:00:00Z',
    };
    mockGetRecentWorkflowResultMessages.mockResolvedValueOnce([badRow]);
    const platform = makePlatform();

    await expect(
      handleMessage(platform, 'conv-1', 'What did the workflow do?', { actor: operator })
    ).resolves.toBeUndefined();
  });

  test('handles metadata with missing workflowResult key gracefully', async () => {
    const rowNoWorkflowResult = {
      id: 'msg-2',
      conversation_id: 'conv-1',
      role: 'assistant' as const,
      content: 'Summary.',
      metadata: '{"someOtherKey":"value"}',
      user_id: null,
      created_at: '2026-01-01T00:00:00Z',
    };
    mockGetRecentWorkflowResultMessages.mockResolvedValueOnce([rowNoWorkflowResult]);
    const platform = makePlatform();

    await expect(
      handleMessage(platform, 'conv-1', 'Follow-up', { actor: operator })
    ).resolves.toBeUndefined();
  });

  test('continues without workflow context when outer fetch throws', async () => {
    mockGetRecentWorkflowResultMessages.mockRejectedValueOnce(new Error('unexpected'));
    const platform = makePlatform();

    // Non-critical path — must not block message handling
    await expect(
      handleMessage(platform, 'conv-1', 'Hello', { actor: operator })
    ).resolves.toBeUndefined();
  });
});
