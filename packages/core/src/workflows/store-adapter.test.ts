import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { IWorkflowStore } from '@archon/workflows/store';

// Mock DB modules before importing store-adapter
const mockCreateWorkflowRun = mock(() => Promise.resolve({ id: 'run-1' }));
const mockGetWorkflowRun = mock(() => Promise.resolve(null));
const mockGetActiveWorkflowRunByPath = mock(() => Promise.resolve(null));
const mockFailOrphanedRuns = mock(() => Promise.resolve({ count: 0 }));
const mockFindResumableRun = mock(() => Promise.resolve(null));
const mockResumeWorkflowRun = mock(() => Promise.resolve({ id: 'run-1' }));
const mockUpdateWorkflowRun = mock(() => Promise.resolve());
const mockUpdateWorkflowActivity = mock(() => Promise.resolve());
const mockGetWorkflowRunStatus = mock(() => Promise.resolve('running'));
const mockCompleteWorkflowRun = mock(() => Promise.resolve());
const mockFailWorkflowRun = mock(() => Promise.resolve());
const mockCancelWorkflowRun = mock(() => Promise.resolve());
const mockPauseWorkflowRun = mock(() => Promise.resolve());

mock.module('../db/workflows', () => ({
  createWorkflowRun: mockCreateWorkflowRun,
  getWorkflowRun: mockGetWorkflowRun,
  getActiveWorkflowRunByPath: mockGetActiveWorkflowRunByPath,
  failOrphanedRuns: mockFailOrphanedRuns,
  findResumableRun: mockFindResumableRun,
  resumeWorkflowRun: mockResumeWorkflowRun,
  updateWorkflowRun: mockUpdateWorkflowRun,
  updateWorkflowActivity: mockUpdateWorkflowActivity,
  getWorkflowRunStatus: mockGetWorkflowRunStatus,
  completeWorkflowRun: mockCompleteWorkflowRun,
  failWorkflowRun: mockFailWorkflowRun,
  cancelWorkflowRun: mockCancelWorkflowRun,
  pauseWorkflowRun: mockPauseWorkflowRun,
}));

const mockCreateWorkflowEvent = mock(() => Promise.resolve());
const mockGetCompletedDagNodeOutputs = mock(() => Promise.resolve(new Map<string, string>()));
mock.module('../db/workflow-events', () => ({
  createWorkflowEvent: mockCreateWorkflowEvent,
  getCompletedDagNodeOutputs: mockGetCompletedDagNodeOutputs,
}));

const mockGetCodebase = mock(() => Promise.resolve(null));
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
}));

mock.module('@archon/providers', () => ({
  getAgentProvider: mock(() => ({})),
  getRegisteredProviders: mock(() => []),
  // Vendor → env-var map consumed by credentials/delivery (#1955). A realistic
  // subset of the generated map (incl. HF_TOKEN, the upstream var).
  PI_PROVIDER_ENV_VARS: {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    'github-copilot': 'COPILOT_GITHUB_TOKEN',
    openrouter: 'OPENROUTER_API_KEY',
    google: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY',
    huggingface: 'HF_TOKEN',
    'google-vertex': 'GOOGLE_CLOUD_API_KEY',
  },
  PI_AMBIENT_VENDORS: ['amazon-bedrock', 'google-vertex'],
}));

mock.module('../config/config-loader', () => ({
  loadConfig: mock(() => Promise.resolve({ assistant: 'claude' })),
}));

// Per-user provider credentials mocks
const mockIsPerUserProviderKeysEnabled = mock(() => false);
mock.module('../credentials/config', () => ({
  isPerUserProviderKeysEnabled: mockIsPerUserProviderKeysEnabled,
}));

const mockListDecryptedUserProviderCredentials = mock(async () => []);
mock.module('../db/user-provider-key-store', () => ({
  listDecryptedUserProviderCredentials: mockListDecryptedUserProviderCredentials,
  saveUserProviderKey: mock(() => Promise.resolve()),
  getUserProviderKeyRecord: mock(() => Promise.resolve(null)),
  listUserProviderKeys: mock(() => Promise.resolve([])),
  deleteUserProviderKey: mock(() => Promise.resolve()),
  getDecryptedProviderCredential: mock(() => Promise.resolve(null)),
}));

// github-auth mocks (required by store-adapter imports)
mock.module('../github-auth/config', () => ({
  isPerUserGitHubEnabled: mock(() => false),
}));
mock.module('../db/user-github-token-store', () => ({
  getDecryptedAccessToken: mock(() => Promise.resolve(undefined)),
}));
mock.module('../db/env-vars', () => ({
  getCodebaseEnvVars: mock(() => Promise.resolve({})),
}));
mock.module('../db/workflow-node-sessions', () => ({
  getWorkflowNodeSession: mock(() => Promise.resolve(null)),
  setWorkflowNodeSession: mock(() => Promise.resolve()),
  deleteWorkflowNodeSessions: mock(() => Promise.resolve()),
}));

const { createWorkflowStore, createWorkflowDeps } = await import('./store-adapter');

describe('createWorkflowStore', () => {
  test('returns object with all IWorkflowStore methods', () => {
    const store = createWorkflowStore();
    const requiredMethods: (keyof IWorkflowStore)[] = [
      'createWorkflowRun',
      'getWorkflowRun',
      'getActiveWorkflowRunByPath',
      'failOrphanedRuns',
      'findResumableRun',
      'resumeWorkflowRun',
      'updateWorkflowRun',
      'updateWorkflowActivity',
      'getWorkflowRunStatus',
      'completeWorkflowRun',
      'failWorkflowRun',
      'pauseWorkflowRun',
      'cancelWorkflowRun',
      'createWorkflowEvent',
      'getCompletedDagNodeOutputs',
      'getCodebase',
      'getCodebaseEnvVars',
    ];
    for (const method of requiredMethods) {
      expect(typeof store[method]).toBe('function');
    }
  });

  test('delegates getWorkflowRunStatus to DB and returns typed status', async () => {
    mockGetWorkflowRunStatus.mockResolvedValueOnce('completed');
    const store = createWorkflowStore();
    const result = await store.getWorkflowRunStatus('run-123');
    expect(result).toBe('completed');
    expect(mockGetWorkflowRunStatus).toHaveBeenCalledWith('run-123');
  });

  test('delegates getWorkflowRunStatus returns null for missing run', async () => {
    mockGetWorkflowRunStatus.mockResolvedValueOnce(null);
    const store = createWorkflowStore();
    const result = await store.getWorkflowRunStatus('nonexistent');
    expect(result).toBeNull();
  });

  test('createWorkflowEvent catches and logs unexpected throws', async () => {
    mockCreateWorkflowEvent.mockRejectedValueOnce(new Error('DB connection lost'));
    const store = createWorkflowStore();
    // Should not throw — the wrapper guarantees the non-throwing contract
    await expect(
      store.createWorkflowEvent({
        workflow_run_id: 'run-1',
        event_type: 'step_started',
        step_index: 0,
        step_name: 'test-step',
      })
    ).resolves.toBeUndefined();
  });

  test('delegates getCompletedDagNodeOutputs to DB', async () => {
    const expected = new Map([['step1', 'output text']]);
    mockGetCompletedDagNodeOutputs.mockResolvedValueOnce(expected);
    const store = createWorkflowStore();
    const result = await store.getCompletedDagNodeOutputs('run-123');
    expect(result).toBe(expected);
    expect(mockGetCompletedDagNodeOutputs).toHaveBeenCalledWith('run-123');
  });

  test('delegates cancelWorkflowRun to DB', async () => {
    mockCancelWorkflowRun.mockResolvedValueOnce(undefined);
    const store = createWorkflowStore();
    await store.cancelWorkflowRun('run-123');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-123');
  });

  test('delegates getCodebase to DB', async () => {
    mockGetCodebase.mockResolvedValueOnce({
      id: 'cb-1',
      name: 'owner/repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/workspace/repo',
    });
    const store = createWorkflowStore();
    const result = await store.getCodebase('cb-1');
    expect(result).toEqual({
      id: 'cb-1',
      name: 'owner/repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/workspace/repo',
    });
  });
});

describe('createWorkflowDeps', () => {
  test('returns WorkflowDeps with store, getAgentProvider, and loadConfig', () => {
    const deps = createWorkflowDeps();
    expect(deps.store).toBeDefined();
    expect(typeof deps.getAgentProvider).toBe('function');
    expect(typeof deps.loadConfig).toBe('function');
  });

  test('store from createWorkflowDeps has all IWorkflowStore methods', () => {
    const deps = createWorkflowDeps();
    expect(typeof deps.store.createWorkflowRun).toBe('function');
    expect(typeof deps.store.getWorkflowRun).toBe('function');
    expect(typeof deps.store.createWorkflowEvent).toBe('function');
    expect(typeof deps.store.getCodebase).toBe('function');
  });

  describe('provider credential fields', () => {
    beforeEach(() => {
      mockListDecryptedUserProviderCredentials.mockReset();
      mockListDecryptedUserProviderCredentials.mockImplementation(async () => []);
      mockIsPerUserProviderKeysEnabled.mockReset();
      mockIsPerUserProviderKeysEnabled.mockImplementation(() => false);
    });

    test('exposes isPerUserProviderKeysEnabled and getUserProviderEnv', () => {
      const deps = createWorkflowDeps();
      expect(typeof deps.isPerUserProviderKeysEnabled).toBe('function');
      expect(typeof deps.getUserProviderEnv).toBe('function');
    });

    test('getUserProviderEnv returns { env: {}, files: [] } when list query throws', async () => {
      mockListDecryptedUserProviderCredentials.mockRejectedValueOnce(new Error('db gone'));
      const deps = createWorkflowDeps();
      const result = await deps.getUserProviderEnv?.('u-1', '/tmp/art');
      expect(result).toEqual({ env: {}, files: [] });
    });

    test('getUserProviderEnv aggregates env from multiple providers', async () => {
      mockListDecryptedUserProviderCredentials.mockResolvedValueOnce([
        { provider: 'openrouter', cred: { kind: 'api_key', apiKey: 'or-k' } },
        { provider: 'google', cred: { kind: 'api_key', apiKey: 'g-k' } },
      ]);
      const deps = createWorkflowDeps();
      const result = await deps.getUserProviderEnv?.('u-1', '/tmp/art');
      expect(result?.env).toMatchObject({ OPENROUTER_API_KEY: 'or-k', GEMINI_API_KEY: 'g-k' });
    });
  });
});
