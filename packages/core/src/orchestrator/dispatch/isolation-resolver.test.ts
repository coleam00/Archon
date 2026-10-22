// @archon-test-isolated
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { toBranchName, toRepoPath } from '@archon/git';
import type {
  IsolationEnvironmentRow,
  IsolationResolver,
  ResolvedIsolation,
} from '@archon/isolation';
import { createMockLogger } from '../../test/mocks/logger';
import { MockPlatformAdapter } from '../../test/mocks/platform';
import type { Conversation, Codebase } from '../../types';

// ─── Mock setup (BEFORE importing module under test) ─────────────────────────

const mockLogger = createMockLogger();
const realPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: mock(() => mockLogger),
}));

const mockUpdateConversation = mock(() => Promise.resolve());
const realConversations = await import('../../db/conversations');
mock.module('../../db/conversations', () => ({
  ...realConversations,
  updateConversation: mockUpdateConversation,
}));

const mockUpdateIsolationStatus = mock(() => Promise.resolve());
const realIsolationEnvironments = await import('../../db/isolation-environments');
mock.module('../../db/isolation-environments', () => ({
  ...realIsolationEnvironments,
  createIsolationStore: mock(() => ({ updateStatus: mockUpdateIsolationStatus })),
}));

const mockResolve = mock<IsolationResolver['resolve']>(() =>
  Promise.resolve({ status: 'none', cwd: '/workspace' })
);
const mockReleaseUnlinked = mock<IsolationResolver['releaseUnlinked']>(() => Promise.resolve());

class MockIsolationResolver {
  resolve = mockResolve;
  releaseUnlinked = mockReleaseUnlinked;
  constructor(_deps: unknown) {}
}

const realIsolation = await import('@archon/isolation');
mock.module('@archon/isolation', () => ({
  ...realIsolation,
  IsolationResolver: MockIsolationResolver,
  configureIsolation: mock(() => undefined),
  getIsolationProvider: mock(() => ({})),
}));

// ─── Import module under test AFTER all mocks ────────────────────────────────

const { validateAndResolveIsolation } = await import('./isolation-resolver');

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeEnvRow(overrides?: Partial<IsolationEnvironmentRow>): IsolationEnvironmentRow {
  return {
    id: 'env-1',
    codebase_id: 'cb-1',
    workflow_type: 'issue',
    workflow_id: '42',
    provider: 'worktree',
    working_path: '/worktrees/issue-42',
    branch_name: 'issue-42',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'web',
    created_by_user_id: null,
    metadata: {},
    ...overrides,
  };
}

// The resolver always reports the environment's own working path as `cwd`.
// Deriving it here stops a call site from setting the two to different values.
function resolvedIsolation(
  method: ResolvedIsolation['method'],
  env: IsolationEnvironmentRow = makeEnvRow()
): ResolvedIsolation {
  return { status: 'resolved', env, cwd: env.working_path, method };
}

type CreatedMethod = Extract<ResolvedIsolation['method'], { type: 'created' }>;

function createdMethod(overrides?: Partial<CreatedMethod>): CreatedMethod {
  return {
    type: 'created',
    creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
    canonicalRepoPath: toRepoPath('/workspace/test-repo'),
    branchCreated: true,
    ...overrides,
  };
}

function makeConversation(overrides?: Partial<Conversation>): Conversation {
  return {
    id: 'conv-1',
    platform_type: 'web',
    platform_conversation_id: 'web-conv-1',
    codebase_id: 'cb-1',
    cwd: '/workspace',
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    title: null,
    hidden: false,
    deleted_at: null,
    last_activity_at: null,
    user_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeCodebase(overrides?: Partial<Codebase>): Codebase {
  return {
    id: 'cb-1',
    name: 'test-repo',
    repository_url: 'https://github.com/test/test-repo.git',
    default_cwd: '/workspace/test-repo',
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateAndResolveIsolation', () => {
  let platform: MockPlatformAdapter;

  beforeEach(() => {
    platform = new MockPlatformAdapter();
    mockUpdateConversation.mockClear();
    mockResolve.mockClear();
    mockReleaseUnlinked.mockClear();
    mockUpdateIsolationStatus.mockClear();
  });

  const linkFailureMethods: ResolvedIsolation['method'][] = [
    { type: 'existing' },
    { type: 'workflow_reuse' },
    { type: 'linked_issue_reuse', issueNumber: 99 },
    createdMethod(),
  ];
  for (const method of linkFailureMethods) {
    test(`link failure on ${method.type} leaves the row to the resolver and rethrows`, async () => {
      const resolution = resolvedIsolation(method);
      mockResolve.mockResolvedValueOnce(resolution);
      const linkError = new Error('conversation update failed');
      mockUpdateConversation.mockRejectedValueOnce(linkError);

      await expect(
        validateAndResolveIsolation(makeConversation(), makeCodebase(), platform, 'conv-1')
      ).rejects.toBe(linkError);

      expect(mockUpdateIsolationStatus).not.toHaveBeenCalled();
      expect(mockReleaseUnlinked).toHaveBeenCalledWith(resolution);
    });
  }

  test('linked_issue_reuse triggers reuse message', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase();

    mockResolve.mockResolvedValueOnce(
      resolvedIsolation({ type: 'linked_issue_reuse', issueNumber: 99 })
    );

    const result = await validateAndResolveIsolation(conversation, codebase, platform, 'conv-1');

    expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', 'Reusing worktree from issue #99');
    expect(result.status).toBe('new');
  });

  test('created with autoCleanedCount triggers cleanup message', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase();

    mockResolve.mockResolvedValueOnce(resolvedIsolation(createdMethod({ autoCleanedCount: 3 })));

    const result = await validateAndResolveIsolation(conversation, codebase, platform, 'conv-1');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      'Cleaned up 3 merged worktree(s) to make room.'
    );
    expect(result.status).toBe('new');
  });

  test('passes codebase default_branch to the resolver as defaultBranch', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase({ default_branch: 'develop' });

    mockResolve.mockResolvedValueOnce(resolvedIsolation(createdMethod()));

    await validateAndResolveIsolation(conversation, codebase, platform, 'conv-1');

    const request = mockResolve.mock.calls.at(-1)?.[0];
    expect(request?.codebase?.defaultBranch).toBe(toBranchName('develop'));
  });

  test('passes null defaultBranch to the resolver when the codebase has none stored', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase({ default_branch: null });

    mockResolve.mockResolvedValueOnce(resolvedIsolation(createdMethod()));

    await validateAndResolveIsolation(conversation, codebase, platform, 'conv-1');

    const request = mockResolve.mock.calls.at(-1)?.[0];
    expect(request?.codebase?.defaultBranch).toBeNull();
  });
});
