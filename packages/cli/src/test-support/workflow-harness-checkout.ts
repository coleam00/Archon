/** Fakes for the checkout a run works in: `@archon/isolation` and `@archon/git`. */
import { mock } from 'bun:test';
import {
  ISOLATION_PROVIDER_TYPES,
  ISOLATION_WORKFLOW_TYPES,
  ENVIRONMENT_STATUSES,
  WORKTREE_REMOVAL_OWNER,
  WorktreeRemovalInProgressError,
} from '@archon/isolation/types';

export const mockFolderBackendPrepare = mock(
  async (): Promise<import('@archon/isolation').PreparedEnv> => ({
    cwd: '/test/path',
    execContext: { kind: 'host' },
    envId: 'container-env-1',
    overlayMode: 'fuse',
  })
);
export const mockFolderBackendDestroy = mock(() => Promise.resolve());
export const mockResolveFolderBackend = mock(() => ({
  prepare: mockFolderBackendPrepare,
  resumeEnv: mockFolderBackendPrepare,
  destroy: mockFolderBackendDestroy,
}));

// Mock @archon/isolation (getIsolationProvider moved here from @archon/core)
const { worktreeRegistrationMetadata } = await import('@archon/isolation');
mock.module('@archon/isolation', () => ({
  ISOLATION_PROVIDER_TYPES,
  ISOLATION_WORKFLOW_TYPES,
  ENVIRONMENT_STATUSES,
  WORKTREE_REMOVAL_OWNER,
  WorktreeRemovalInProgressError,
  worktreeRegistrationMetadata,
  configureIsolation: mock(() => undefined),
  // Marked rather than reimplemented: these tests prove a failure path routes
  // through the classifier, while what the real one produces is the isolation
  // package's own test.
  classifyIsolationError: (error: Error) => `classified: ${error.message}`,
  getIsolationProvider: mock(() => ({
    create: mock(() =>
      Promise.resolve({
        provider: 'worktree',
        id: '/test/path',
        workingPath: '/test/path',
        branchName: 'test-branch',
        status: 'active',
        createdAt: new Date(),
        metadata: {
          provenance: 'created',
          adopted: false,
          creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
          branchCreated: true,
        },
      })
    ),
    healthCheck: mock(() => Promise.resolve(true)),
  })),
  resolveFolderBackend: mockResolveFolderBackend,
}));

class MockCanonicalRepoPathUnavailableError extends Error {
  constructor(
    readonly checkoutPath: string,
    readonly commonGitDir: string
  ) {
    super(`Cannot determine the primary checkout for ${checkoutPath}`);
    this.name = 'CanonicalRepoPathUnavailableError';
  }
}

export const mockGetCurrentBranchStrict = mock(
  async (): Promise<string | null> => 'feature/adopted'
);
mock.module('@archon/git', () => ({
  getCurrentBranchStrict: mockGetCurrentBranchStrict,
  verifyWorktreeOwnership: mock(async () => undefined),
  findRepoRoot: mock(() => Promise.resolve(null)),
  getCanonicalRepoPath: mock((path: string) => Promise.resolve(path)),
  getGitCheckoutIdentity: mock((path: string) =>
    Promise.resolve({
      gitDir: `${path}/.git`,
      commonGitDir: `${path}/.git`,
      linkedWorktree: false,
    })
  ),
  CanonicalRepoPathUnavailableError: MockCanonicalRepoPathUnavailableError,
  getRemoteUrl: mock(() => Promise.resolve(null)),
  checkout: mock(() => Promise.resolve()),
  toRepoPath: mock((path: string) => path),
  toWorktreePath: mock((path: string) => path),
  toBranchName: mock((branch: string) => branch),
  getDefaultBranch: mock(() => Promise.resolve('dev')),
  getDefaultRemote: mock(() => Promise.resolve('origin')),
  isAncestorOf: mock(() => Promise.resolve(true)),
}));
