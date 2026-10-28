/** Fakes for `@archon/core`'s config, registration and provider seams. */
import { mock } from 'bun:test';

mock.module('@archon/core/services/provider-admission', () => ({
  getAgentProvider: () => ({
    checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
  }),
}));

const realRunConfig = await import('@archon/core/config/run-config');
const realSealRunConfig = realRunConfig.sealWorkflowRunConfig;
mock.module('@archon/core/config/run-config', () => ({
  sealWorkflowRunConfig: (...args: Parameters<typeof realSealRunConfig>) => {
    const previous = process.env.TOKEN_ENCRYPTION_KEY;
    try {
      process.env.TOKEN_ENCRYPTION_KEY ??= 'ab'.repeat(32);
      return realSealRunConfig(...args);
    } finally {
      if (previous === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previous;
    }
  },
}));
mock.module('@archon/core/credentials/config', () => ({
  isPerUserProviderKeysEnabled: () => false,
}));
mock.module('@archon/core/db/env-vars', () => ({ getCodebaseEnvVars: async () => ({}) }));
mock.module('@archon/core/workflows/branch-launch-source', () => ({
  withBranchLaunchSource: async (
    _repo: string,
    _branch: string,
    prepare: (path: string) => Promise<unknown>
  ) => prepare('/adopted/snapshot'),
}));

export const mockCreateWorkflowEvent = mock(() => Promise.resolve());
export const mockPersistWorkflowEvent = mock(() => Promise.resolve());

// Mock the @archon/core modules
mock.module('@archon/core', () => ({
  registerRepository: mock(() =>
    Promise.resolve({
      codebaseId: 'cb-auto',
      name: 'test/repo',
      repositoryUrl: null,
      defaultCwd: '/test/path',
      commandCount: 0,
      alreadyExisted: false,
    })
  ),
  registerFolder: mock(() =>
    Promise.resolve({
      codebaseId: 'cb-folder',
      name: 'platform',
      repositoryUrl: null,
      defaultCwd: '/test/path',
      defaultBranch: null,
      commandCount: 0,
      alreadyExisted: false,
    })
  ),
  loadConfig: mock(() =>
    Promise.resolve({ defaults: {}, assistant: 'claude', assistants: { claude: {} }, commands: {} })
  ),
  generateAndSetTitle: mock(() => Promise.resolve()),
  resolveTitleRequest: mock((provider: string) => Promise.resolve({ provider, options: {} })),
  loadRepoConfig: mock(() => Promise.resolve({})),
  getUserAiPrefs: mock(() => Promise.resolve({})),
  createWorkflowStore: mock(() => ({
    getCodebaseEnvVars: async () => ({}),
    createWorkflowEvent: mockCreateWorkflowEvent,
    persistWorkflowEvent: mockPersistWorkflowEvent,
  })),
  // requires: [github] gate. Default to a solo-install posture (disabled) so the
  // gate is a no-op for every existing test; the gate-specific tests flip
  // isPerUserGitHubEnabled on per-invocation.
  isPerUserGitHubEnabled: mock(() => false),
  getDecryptedAccessToken: mock(() => Promise.resolve(null)),
}));

class MockProjectRegistrationError extends Error {}
const mockedCore = await import('@archon/core');
mock.module('@archon/core/config/config-loader', () => ({
  loadConfig: (...args: Parameters<typeof mockedCore.loadConfig>) => mockedCore.loadConfig(...args),
  loadRepoConfig: (...args: Parameters<typeof mockedCore.loadRepoConfig>) =>
    mockedCore.loadRepoConfig(...args),
}));
mock.module('@archon/core/handlers/clone', () => ({
  registerRepository: (
    _records: unknown,
    ...args: Parameters<typeof mockedCore.registerRepository>
  ) => mockedCore.registerRepository(...args),
  registerFolder: (_records: unknown, ...args: Parameters<typeof mockedCore.registerFolder>) =>
    mockedCore.registerFolder(...args),
  ProjectRegistrationError: MockProjectRegistrationError,
}));

mock.module('@archon/core/operations/workflow-adoption', () => ({
  // No test adopts unless it opts in; a loud default keeps an unexpected lane from
  // silently falling through to a fresh run.
  resolveWorkflowAdoption: mock(() => Promise.reject(new Error('adoption not expected'))),
}));
