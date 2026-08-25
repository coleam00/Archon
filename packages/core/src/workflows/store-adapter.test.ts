import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { IWorkflowStore } from '@archon/workflows/store';

// Mock DB modules before importing store-adapter
const mockCreateWorkflowRun = mock(() => Promise.resolve({ id: 'run-1' }));
const mockGetWorkflowRun = mock(() => Promise.resolve(null));
const mockFindChildRuns = mock(() => Promise.resolve([]));
const mockGetRunAncestry = mock(() => Promise.resolve([]));
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
const mockPauseWorkflowRunForWait = mock(() => Promise.resolve());
const mockClearWorkflowWaitContext = mock(() => Promise.resolve({ cleared: true }));
// Backs createWorkflowStore()'s rewriteApprovalContext (#2707 step 3 pause
// escalation) — per AGENTS.md's mock.module rule, an export the factory omits
// keeps its REAL implementation, so this must be listed even though no test
// here calls rewriteApprovalContext yet.
const mockResolveApprovalGate = mock(() => Promise.resolve({ resolved: true }));

mock.module('../db/workflows', () => ({
  createWorkflowRun: mockCreateWorkflowRun,
  getWorkflowRun: mockGetWorkflowRun,
  findChildRuns: mockFindChildRuns,
  getRunAncestry: mockGetRunAncestry,
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
  pauseWorkflowRunForWait: mockPauseWorkflowRunForWait,
  clearWorkflowWaitContext: mockClearWorkflowWaitContext,
  resolveApprovalGate: mockResolveApprovalGate,
  claimWriteback: mock(() => Promise.resolve({ claimed: true })),
  releaseWritebackClaim: mock(() => Promise.resolve()),
}));

const mockCreateWorkflowEvent = mock(() => Promise.resolve());
const mockGetDagResumeSnapshot = mock(() =>
  Promise.resolve({
    completedNodeOutputs: new Map<string, string>(),
    tokens: { input: 0, output: 0 },
  })
);
mock.module('../db/workflow-events', () => ({
  createWorkflowEvent: mockCreateWorkflowEvent,
  getDagResumeSnapshot: mockGetDagResumeSnapshot,
}));

const mockGetCodebase = mock(() => Promise.resolve(null));
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
}));

mock.module('@archon/providers', () => ({
  getAgentProvider: mock(() => ({})),
  getRegisteredProviders: mock(() => []),
  getRegistration: mock(
    (): { parseRunConfig: (raw: Record<string, unknown>) => Record<string, unknown> } => ({
      parseRunConfig: (raw: Record<string, unknown>): Record<string, unknown> => raw,
    })
  ),
  parseProviderRunModel: mock((_provider: string, model: string): string => model),
  isRegisteredProvider: mock((): boolean => false),
  InvalidProviderRunConfigError: class InvalidProviderRunConfigError extends Error {},
  getProviderCapabilities: mock((): { effortControl: boolean } => ({ effortControl: false })),
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
  // Required even though nothing here calls it: this factory replaces the module
  // for the whole process, and child-isolation-resolver.ts (same `bun test
  // src/workflows/` batch) does `import { loadRepoConfig }`. Omit it and that
  // import fails at module-eval with "Export named 'loadRepoConfig' not found".
  loadRepoConfig: mock(() => Promise.resolve(null)),
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
  upsertWorkflowNodeSession: mock(() => Promise.resolve()),
  deleteWorkflowNodeSessions: mock(() => Promise.resolve()),
}));
mock.module(
  '../db/workflow-run-node-sessions',
  (): {
    listWorkflowRunNodeSessions: () => Promise<never[]>;
    upsertWorkflowRunNodeSession: () => Promise<void>;
  } => ({
    listWorkflowRunNodeSessions: mock((): Promise<never[]> => Promise.resolve([])),
    upsertWorkflowRunNodeSession: mock((): Promise<void> => Promise.resolve()),
  })
);

const { createWorkflowStore, createWorkflowDeps } = await import('./store-adapter');

describe('createWorkflowStore', () => {
  test('returns object with all IWorkflowStore methods', () => {
    const store = createWorkflowStore();
    const requiredMethods: (keyof IWorkflowStore)[] = [
      'createWorkflowRun',
      'getWorkflowRun',
      'findChildRuns',
      'getRunAncestry',
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
      'pauseWorkflowRunForWait',
      'clearWorkflowWaitContext',
      'rewriteApprovalContext',
      'claimWriteback',
      'releaseWritebackClaim',
      'cancelWorkflowRun',
      'createWorkflowEvent',
      'getDagResumeSnapshot',
      'getCodebase',
      'getCodebaseEnvVars',
      'getWorkflowNodeSession',
      'upsertWorkflowNodeSession',
      'deleteWorkflowNodeSessions',
      'listWorkflowRunNodeSessions',
      'upsertWorkflowRunNodeSession',
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

  test('serializes fire-and-forget event writes within one workflow run', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const committed: string[] = [];
    mockCreateWorkflowEvent.mockImplementation(async data => {
      committed.push(data.event_type);
      if (data.event_type === 'provider_slot_queued') await firstBlocked;
    });
    const store = createWorkflowStore();

    const queued = store.createWorkflowEvent({
      workflow_run_id: 'run-order',
      event_type: 'provider_slot_queued',
    });
    const acquired = store.createWorkflowEvent({
      workflow_run_id: 'run-order',
      event_type: 'provider_slot_acquired',
    });
    await Bun.sleep(0);
    expect(committed).toEqual(['provider_slot_queued']);

    releaseFirst?.();
    await Promise.all([queued, acquired]);
    expect(committed).toEqual(['provider_slot_queued', 'provider_slot_acquired']);
    mockCreateWorkflowEvent.mockImplementation(() => Promise.resolve());
  });

  test('delegates getDagResumeSnapshot to DB', async () => {
    const expected = {
      completedNodeOutputs: new Map([['step1', 'output text']]),
      tokens: { input: 40, output: 4 },
    };
    mockGetDagResumeSnapshot.mockResolvedValueOnce(expected);
    const store = createWorkflowStore();
    const result = await store.getDagResumeSnapshot('run-123');
    expect(result).toBe(expected);
    expect(mockGetDagResumeSnapshot).toHaveBeenCalledWith('run-123');
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

    test('getUserProviderEnv returns empty delivery bags when list query throws', async () => {
      mockListDecryptedUserProviderCredentials.mockRejectedValueOnce(new Error('db gone'));
      const deps = createWorkflowDeps();
      const result = await deps.getUserProviderEnv?.('u-1', '/tmp/art');
      expect(result).toEqual({ env: {}, files: [], protectedValues: [] });
    });

    // Regression guard for #2035: enabling the credential vault (auto-key on by
    // default) must be ADDITIVE. An unconnected user yields an empty env bag, so
    // their ambient ANTHROPIC_API_KEY / OPENAI_API_KEY pass through untouched —
    // there is no scrub on the AI-provider path (unlike the GitHub org-token path).
    // A future change that scrubbed ambient provider keys would fail this.
    test('getUserProviderEnv is additive: unconnected user gets empty env (no ambient scrub)', async () => {
      mockListDecryptedUserProviderCredentials.mockResolvedValueOnce([]);
      const deps = createWorkflowDeps();
      const result = await deps.getUserProviderEnv?.('u-unconnected', '/tmp/art');
      expect(result).toEqual({ env: {}, files: [], protectedValues: [] });
    });

    test('getUserProviderEnv aggregates env from multiple providers', async () => {
      mockListDecryptedUserProviderCredentials.mockResolvedValueOnce([
        { provider: 'openrouter', cred: { kind: 'api_key', apiKey: 'or-k' } },
        { provider: 'google', cred: { kind: 'api_key', apiKey: 'g-k' } },
      ]);
      const deps = createWorkflowDeps();
      const result = await deps.getUserProviderEnv?.('u-1', '/tmp/art');
      expect(result?.env).toMatchObject({ OPENROUTER_API_KEY: 'or-k', GEMINI_API_KEY: 'g-k' });
      expect(result?.protectedValues).toEqual(['or-k', 'g-k']);
    });

    test('getUserProviderEnv protects OAuth secrets without hiding public metadata', async () => {
      mockListDecryptedUserProviderCredentials.mockResolvedValueOnce([
        {
          provider: 'openai',
          cred: {
            kind: 'oauth',
            oauthApiKey: 'derived-bearer',
            rawCreds: {
              type: 'oauth',
              access: 'access-token',
              refresh: 'refresh-token',
              id_token: 'id-token',
              accountId: 'account-id',
              enterpriseUrl: 'company.ghe.com',
              availableModelIds: ['claude-sonnet-4', 'gpt-5'],
              expires: 123,
            },
          },
        },
      ]);
      const deps = createWorkflowDeps();
      const result = await deps.getUserProviderEnv?.('u-1', '/tmp/art');
      expect(result?.protectedValues).toEqual([
        'derived-bearer',
        'access-token',
        'refresh-token',
        'id-token',
      ]);
      expect(result?.protectedValues).not.toContain('oauth');
      expect(result?.protectedValues).not.toContain('account-id');
      expect(result?.protectedValues).not.toContain('company.ghe.com');
      expect(result?.protectedValues).not.toContain('claude-sonnet-4');
      expect(result?.protectedValues).not.toContain('gpt-5');
    });
  });
});
