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
export const mockFolderBackendReleaseImages = mock(
  async (_runId: string, _envId: string) => undefined
);
export const mockResolveFolderBackend = mock(() => ({
  prepare: mockFolderBackendPrepare,
  resumeEnv: mockFolderBackendPrepare,
  destroy: mockFolderBackendDestroy,
  releaseVerificationImages: mockFolderBackendReleaseImages,
}));

export const mockRefuseUnappliedStartPoint = mock(
  async (_worktreePath: string, _branch: string, _fromBranch: string) => undefined
);

// Mock @archon/isolation (getIsolationProvider moved here from @archon/core)
const {
  worktreeRegistrationMetadata,
  generatedTaskBranch,
  validateWorktreeConfig,
  VerificationImageInventoryError,
  VERIFICATION_IMAGE_RUN_LABEL,
  releaseRunVerificationImages: realReleaseRunVerificationImages,
} = await import('@archon/isolation');
export { realReleaseRunVerificationImages };
mock.module('@archon/isolation', () => ({
  checkWorktreeStartable: mock(async () => undefined),
  readWorktreeBaseBranch: () => undefined,
  generatedTaskBranch,
  validateWorktreeConfig,
  resolveWorktreeBase: mock(async () => {
    throw new Error('resolveWorktreeBase is not mocked here');
  }),
  getPrsForCommit: mock<typeof import('@archon/isolation').getPrsForCommit>(async () => ({
    state: 'NONE',
  })),
  VerificationImageInventoryError,
  VERIFICATION_IMAGE_RUN_LABEL,
  dockerCli: mock(async () => ({ stdout: '', stderr: '' })),
  releaseRunVerificationImages: mock(async () => undefined),
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
  refuseUnappliedStartPoint: mockRefuseUnappliedStartPoint,
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
  toRepoPath: mock((path: string) => path),
  toWorktreePath: mock((path: string) => path),
  toBranchName: mock((branch: string) => branch),
  getDefaultBranch: mock(() => Promise.resolve('dev')),
  getDefaultRemote: mock(() => Promise.resolve('origin')),
  isAncestorOf: mock(() => Promise.resolve(true)),
}));
