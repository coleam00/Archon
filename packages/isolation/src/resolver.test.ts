import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as git from '@harneeslab/git';

// Mock logger to suppress noisy output
mock.module('@harneeslab/paths', () => ({
  createLogger: () => ({
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => undefined,
  }),
}));

import { IsolationResolver } from './resolver';
import type { IsolationResolverDeps } from './resolver';
import type { IIsolationStore } from './store';
import type { IsolationEnvironmentRow, IsolatedEnvironment } from './types';

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
    metadata: {},
    ...overrides,
  };
}

function makeMockStore(overrides?: Partial<IIsolationStore>): IIsolationStore {
  return {
    getById: async () => null,
    findActiveByWorkflow: async () => null,
    create: async env =>
      makeEnvRow({
        codebase_id: env.codebase_id,
        workflow_type: env.workflow_type,
        workflow_id: env.workflow_id,
        working_path: env.working_path,
        branch_name: env.branch_name,
      }),
    updateStatus: async () => undefined,
    countActiveByCodebase: async () => 0,
    ...overrides,
  };
}

function makeMockProvider() {
  return {
    providerType: 'worktree' as const,
    create: async (_request: unknown): Promise<IsolatedEnvironment> => ({
      id: '/worktrees/new-branch',
      provider: 'worktree',
      workingPath: '/worktrees/new-branch',
      branchName: 'new-branch',
      status: 'active',
      createdAt: new Date(),
      metadata: { adopted: false },
    }),
    destroy: async () => ({
      worktreeRemoved: true,
      branchDeleted: null,
      remoteBranchDeleted: null,
      directoryClean: true,
      warnings: [],
    }),
    get: async () => null,
    list: async () => [],
    healthCheck: async () => true,
  };
}

const defaultCodebase = { id: 'cb-1', defaultCwd: '/repos/myrepo', name: 'my-repo' };

describe('IsolationResolver', () => {
  let worktreeExistsSpy: ReturnType<typeof spyOn>;
  let getCanonicalSpy: ReturnType<typeof spyOn>;
  let findWorktreeByBranchSpy: ReturnType<typeof spyOn>;
  let isAncestorOfSpy: ReturnType<typeof spyOn>;
  let verifyWorktreeOwnershipSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    worktreeExistsSpy = spyOn(git, 'worktreeExists').mockResolvedValue(true);
    getCanonicalSpy = spyOn(git, 'getCanonicalRepoPath').mockResolvedValue(
      '/repos/myrepo' as git.RepoPath
    );
    findWorktreeByBranchSpy = spyOn(git, 'findWorktreeByBranch').mockResolvedValue(null);
    isAncestorOfSpy = spyOn(git, 'isAncestorOf').mockResolvedValue(true);
    // Default: ownership verification passes. Tests that exercise cross-clone
    // behavior override this with a rejection.
    verifyWorktreeOwnershipSpy = spyOn(git, 'verifyWorktreeOwnership').mockResolvedValue(undefined);
  });

  afterEach(() => {
    worktreeExistsSpy.mockRestore();
    getCanonicalSpy.mockRestore();
    findWorktreeByBranchSpy.mockRestore();
    isAncestorOfSpy.mockRestore();
    verifyWorktreeOwnershipSpy.mockRestore();
  });

  function createResolver(overrides?: Partial<IsolationResolverDeps>): IsolationResolver {
    return new IsolationResolver({
      store: makeMockStore(),
      provider: makeMockProvider(),
      staleThresholdDays: 14,
      ...overrides,
    });
  }

  test('existing env valid — returns resolved with method existing', async () => {
    const env = makeEnvRow();
    const resolver = createResolver({
      store: makeMockStore({ getById: async () => env }),
    });

    const result = await resolver.resolve({
      existingEnvId: 'env-1',
      codebase: defaultCodebase,
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('existing');
      expect(result.env.id).toBe('env-1');
      expect(result.cwd).toBe('/worktrees/issue-42');
    }
  });

  test('existing env stale (not on disk) — returns stale_cleaned', async () => {
    const env = makeEnvRow();
    worktreeExistsSpy.mockResolvedValue(false);

    const resolver = createResolver({
      store: makeMockStore({ getById: async () => env }),
    });

    const result = await resolver.resolve({
      existingEnvId: 'env-1',
      codebase: defaultCodebase,
      platformType: 'web',
    });

    expect(result.status).toBe('stale_cleaned');
    if (result.status === 'stale_cleaned') {
      expect(result.previousEnvId).toBe('env-1');
    }
  });

  test('existing env stale with no DB record — returns stale_cleaned', async () => {
    worktreeExistsSpy.mockResolvedValue(false);

    const resolver = createResolver({
      store: makeMockStore({ getById: async () => null }),
    });

    const result = await resolver.resolve({
      existingEnvId: 'env-1',
      codebase: defaultCodebase,
      platformType: 'web',
    });

    expect(result.status).toBe('stale_cleaned');
  });

  test('no codebase — returns none', async () => {
    const resolver = createResolver();

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: null,
      platformType: 'web',
    });

    expect(result.status).toBe('none');
    if (result.status === 'none') {
      expect(result.cwd).toBe('/workspace');
    }
  });

  test('workflow reuse — returns resolved with workflow_reuse method', async () => {
    const env = makeEnvRow();
    const resolver = createResolver({
      store: makeMockStore({
        findActiveByWorkflow: async (_cid, wt, wid) =>
          wt === 'issue' && wid === '42' ? env : null,
      }),
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '42' },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('workflow_reuse');
    }
  });

  test('linked issue reuse — returns resolved with issueNumber', async () => {
    const linkedEnv = makeEnvRow({
      id: 'env-linked',
      workflow_type: 'issue',
      workflow_id: '10',
      working_path: '/worktrees/issue-10',
    });

    const resolver = createResolver({
      store: makeMockStore({
        findActiveByWorkflow: async (_cid, wt, wid) =>
          wt === 'issue' && wid === '10' ? linkedEnv : null,
      }),
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'pr', workflowId: '55', linkedIssues: [10] },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('linked_issue_reuse');
      if (result.method.type === 'linked_issue_reuse') {
        expect(result.method.issueNumber).toBe(10);
      }
    }
  });

  test('PR branch adoption — returns resolved with branch_adoption', async () => {
    findWorktreeByBranchSpy.mockResolvedValue('/worktrees/feature-branch' as git.WorktreePath);

    const adoptedEnv = makeEnvRow({
      working_path: '/worktrees/feature-branch',
      branch_name: 'feature-branch',
    });
    const resolver = createResolver({
      store: makeMockStore({
        create: async () => adoptedEnv,
      }),
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'pr', workflowId: '99', prBranch: 'feature-branch' },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('branch_adoption');
      if (result.method.type === 'branch_adoption') {
        expect(result.method.branch).toBe('feature-branch');
      }
    }
  });

  test('create new — returns resolved with created method', async () => {
    const resolver = createResolver();

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '100' },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('created');
    }
  });

  test('passes fromBranch hint when creating task isolation', async () => {
    let capturedRequest: unknown;
    const resolver = createResolver({
      provider: {
        ...makeMockProvider(),
        create: async request => {
          capturedRequest = request;
          return {
            id: '/worktrees/new-branch',
            provider: 'worktree',
            workingPath: '/worktrees/new-branch',
            branchName: 'new-branch',
            status: 'active',
            createdAt: new Date(),
            metadata: { adopted: false },
          };
        },
      },
    });

    await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: {
        workflowType: 'task',
        workflowId: 'test-adapters',
        fromBranch: 'feature/extract-adapters',
      },
      platformType: 'web',
    });

    expect(capturedRequest).toEqual(
      expect.objectContaining({
        workflowType: 'task',
        identifier: 'test-adapters',
        fromBranch: 'feature/extract-adapters',
      })
    );
  });

  test('creation error — returns blocked with creation_failed', async () => {
    const resolver = createResolver({
      provider: {
        ...makeMockProvider(),
        create: async () => {
          throw new Error('permission denied');
        },
      },
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '400' },
      platformType: 'web',
    });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('creation_failed');
      expect(result.userMessage).toContain('Permission denied');
    }
  });

  // --- Edge-case tests for stale cleanup ---

  test('checkExisting marks stale DB record as destroyed', async () => {
    const env = makeEnvRow();
    worktreeExistsSpy.mockResolvedValue(false);

    let updatedStatus: string | null = null;
    const resolver = createResolver({
      store: makeMockStore({
        getById: async () => env,
        updateStatus: async (_id, status) => {
          updatedStatus = status;
        },
      }),
    });

    await resolver.resolve({
      existingEnvId: 'env-1',
      codebase: defaultCodebase,
      platformType: 'web',
    });

    expect(updatedStatus).toBe('destroyed');
  });

  test('findReusable marks stale DB record as destroyed when worktree gone', async () => {
    const env = makeEnvRow({ workflow_type: 'issue', workflow_id: '42' });
    // worktreeExists returns false — worktree is gone
    worktreeExistsSpy.mockResolvedValue(false);

    let updatedId: string | null = null;
    let updatedStatus: string | null = null;
    const resolver = createResolver({
      store: makeMockStore({
        findActiveByWorkflow: async (_cid, wt, wid) =>
          wt === 'issue' && wid === '42' ? env : null,
        updateStatus: async (id, status) => {
          updatedId = id;
          updatedStatus = status;
        },
      }),
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '42' },
      platformType: 'web',
    });

    // Should have cleaned up the stale record and then created a new environment
    expect(updatedId).toBe('env-1');
    expect(updatedStatus).toBe('destroyed');
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('created');
    }
  });

  test('findLinkedIssueEnv marks stale DB record as destroyed when worktree gone', async () => {
    const linkedEnv = makeEnvRow({
      id: 'env-linked',
      workflow_type: 'issue',
      workflow_id: '10',
      working_path: '/worktrees/issue-10',
    });

    // worktreeExists returns false — worktree is gone
    worktreeExistsSpy.mockResolvedValue(false);

    let updatedId: string | null = null;
    let updatedStatus: string | null = null;
    const resolver = createResolver({
      store: makeMockStore({
        findActiveByWorkflow: async (_cid, wt, wid) =>
          wt === 'issue' && wid === '10' ? linkedEnv : null,
        updateStatus: async (id, status) => {
          updatedId = id;
          updatedStatus = status;
        },
      }),
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'pr', workflowId: '55', linkedIssues: [10] },
      platformType: 'web',
    });

    expect(updatedId).toBe('env-linked');
    expect(updatedStatus).toBe('destroyed');
    // Should proceed to create new since linked env was stale
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('created');
    }
  });

  test('stale cleanup error in findReusable does not crash resolution', async () => {
    const env = makeEnvRow({ workflow_type: 'issue', workflow_id: '42' });
    worktreeExistsSpy.mockResolvedValue(false);

    const resolver = createResolver({
      store: makeMockStore({
        findActiveByWorkflow: async (_cid, wt, wid) =>
          wt === 'issue' && wid === '42' ? env : null,
        updateStatus: async () => {
          throw new Error('DB connection lost');
        },
      }),
    });

    // Should not throw — cleanup errors are caught and logged
    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '42' },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('created');
    }
  });

  // --- Unknown error propagation tests ---

  test('unknown error from provider.create() propagates instead of returning blocked', async () => {
    const unexpectedError = new TypeError('cannot read property of null');
    const resolver = createResolver({
      provider: {
        ...makeMockProvider(),
        create: async () => {
          throw unexpectedError;
        },
      },
    });

    await expect(
      resolver.resolve({
        existingEnvId: null,
        codebase: defaultCodebase,
        hints: { workflowType: 'issue', workflowId: '600' },
        platformType: 'web',
      })
    ).rejects.toThrow(TypeError);
  });

  test('known infrastructure error from provider.create() returns blocked', async () => {
    const resolver = createResolver({
      provider: {
        ...makeMockProvider(),
        create: async () => {
          throw new Error('permission denied');
        },
      },
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '601' },
      platformType: 'web',
    });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('creation_failed');
    }
  });

  test('store.create() failure triggers orphan worktree cleanup and rethrows', async () => {
    let destroyCalled = false;
    let destroyCalledWithForce = false;

    const resolver = createResolver({
      provider: {
        ...makeMockProvider(),
        destroy: async (_envId, options) => {
          destroyCalled = true;
          destroyCalledWithForce = options?.force === true;
          return {
            worktreeRemoved: true,
            branchDeleted: null,
            remoteBranchDeleted: null,
            directoryClean: true,
            warnings: [],
          };
        },
      },
      store: makeMockStore({
        create: async () => {
          throw new Error('DB constraint violation');
        },
      }),
    });

    await expect(
      resolver.resolve({
        existingEnvId: null,
        codebase: defaultCodebase,
        hints: { workflowType: 'issue', workflowId: '602' },
        platformType: 'web',
      })
    ).rejects.toThrow('DB constraint violation');

    expect(destroyCalled).toBe(true);
    expect(destroyCalledWithForce).toBe(true);
  });

  test('store.create() failure still rethrows when orphan cleanup also fails', async () => {
    const resolver = createResolver({
      provider: {
        ...makeMockProvider(),
        destroy: async () => {
          throw new Error('cleanup failed');
        },
      },
      store: makeMockStore({
        create: async () => {
          throw new Error('DB constraint violation');
        },
      }),
    });

    // Should rethrow the original store error, not the cleanup error
    await expect(
      resolver.resolve({
        existingEnvId: null,
        codebase: defaultCodebase,
        hints: { workflowType: 'issue', workflowId: '603' },
        platformType: 'web',
      })
    ).rejects.toThrow('DB constraint violation');
  });

  // --- Warnings propagation tests ---

  test('warnings from provider.create() are propagated in resolved result', async () => {
    const resolver = createResolver({
      provider: {
        ...makeMockProvider(),
        create: async (): Promise<IsolatedEnvironment> => ({
          id: '/worktrees/new-branch',
          provider: 'worktree',
          workingPath: '/worktrees/new-branch',
          branchName: 'new-branch',
          status: 'active',
          createdAt: new Date(),
          metadata: { adopted: false },
          warnings: ['Config file could not be loaded — copyFiles not applied.'],
        }),
      },
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '700' },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.warnings).toEqual(['Config file could not be loaded — copyFiles not applied.']);
    }
  });

  test('resolved result has no warnings when provider.create() returns none', async () => {
    const resolver = createResolver();

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '701' },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.warnings).toBeUndefined();
    }
  });

  // --- codebaseName propagation test ---

  test('passes codebaseName from codebase to isolation request', async () => {
    const capturedRequests: unknown[] = [];
    const resolver = createResolver({
      provider: {
        ...makeMockProvider(),
        create: async (request: unknown) => {
          capturedRequests.push(request);
          return {
            id: '/worktrees/new-branch',
            provider: 'worktree' as const,
            workingPath: '/worktrees/new-branch',
            branchName: 'new-branch',
            status: 'active' as const,
            createdAt: new Date(),
            metadata: { adopted: false },
          };
        },
      },
    });

    worktreeExistsSpy.mockResolvedValue(false);

    await resolver.resolve({
      existingEnvId: null,
      codebase: { id: 'cb-1', name: 'owner/repo', defaultCwd: '/local/repo' },
      hints: { workflowType: 'task', workflowId: 'wf-1' },
      platformType: 'web',
    });

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toMatchObject({ codebaseName: 'owner/repo' });
  });

  // --- Constructor validation tests ---

  test('throws on zero staleThresholdDays', () => {
    expect(
      () =>
        new IsolationResolver({
          store: makeMockStore(),
          provider: makeMockProvider(),
          staleThresholdDays: 0,
        })
    ).toThrow('staleThresholdDays must be positive, got 0');
  });

  test('throws on negative staleThresholdDays', () => {
    expect(
      () =>
        new IsolationResolver({
          store: makeMockStore(),
          provider: makeMockProvider(),
          staleThresholdDays: -1,
        })
    ).toThrow('staleThresholdDays must be positive, got -1');
  });

  test('existing env — emits warning when base branch mismatches', async () => {
    const env = makeEnvRow();
    isAncestorOfSpy.mockResolvedValue(false);
    const resolver = createResolver({
      store: makeMockStore({ getById: async () => env }),
    });

    const result = await resolver.resolve({
      existingEnvId: 'env-1',
      codebase: defaultCodebase,
      hints: { baseBranch: git.toBranchName('dev') },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.[0]).toContain("not based on 'dev'");
    }
  });

  test('existing env — no warning when base branch matches', async () => {
    const env = makeEnvRow();
    isAncestorOfSpy.mockResolvedValue(true);
    const resolver = createResolver({
      store: makeMockStore({ getById: async () => env }),
    });

    const result = await resolver.resolve({
      existingEnvId: 'env-1',
      codebase: defaultCodebase,
      hints: { baseBranch: git.toBranchName('dev') },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.warnings).toBeUndefined();
    }
  });

  test('workflow reuse — emits warning when base branch mismatches', async () => {
    const env = makeEnvRow();
    isAncestorOfSpy.mockResolvedValue(false);
    const resolver = createResolver({
      store: makeMockStore({
        findActiveByWorkflow: async (_cid, wt, wid) =>
          wt === 'issue' && wid === '42' ? env : null,
      }),
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '42', baseBranch: git.toBranchName('dev') },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.[0]).toContain("not based on 'dev'");
    }
  });

  test('workflow reuse — no warning when base branch matches', async () => {
    const env = makeEnvRow();
    isAncestorOfSpy.mockResolvedValue(true);
    const resolver = createResolver({
      store: makeMockStore({
        findActiveByWorkflow: async (_cid, wt, wid) =>
          wt === 'issue' && wid === '42' ? env : null,
      }),
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '42', baseBranch: git.toBranchName('dev') },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.warnings).toBeUndefined();
    }
  });

  test('existing env — no base branch check when baseBranch not in hints', async () => {
    const env = makeEnvRow();
    const resolver = createResolver({
      store: makeMockStore({ getById: async () => env }),
    });

    await resolver.resolve({
      existingEnvId: 'env-1',
      codebase: defaultCodebase,
      platformType: 'web',
    });

    expect(isAncestorOfSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Cross-checkout ownership guard (#1183, #1188 part 1)
  //
  // Two clones of the same remote share codebase_id because identity is
  // derived from owner/repo. Without these guards, clone B would adopt
  // worktrees owned by clone A via the DB-driven resolver paths, bypassing
  // the WorktreeProvider.findExisting guard.
  // -------------------------------------------------------------------------
  describe('cross-checkout guard', () => {
    test('findReusable throws when worktree belongs to a different clone', async () => {
      const env = makeEnvRow();
      const updateStatusSpy = mock(() => Promise.resolve());
      const resolver = createResolver({
        store: makeMockStore({
          findActiveByWorkflow: async () => env,
          updateStatus: updateStatusSpy,
        }),
      });
      // .git file points to a different clone than request.canonicalRepoPath
      verifyWorktreeOwnershipSpy.mockRejectedValue(
        new Error(
          'Worktree at /worktrees/issue-42 belongs to a different clone (/other/clone). ' +
            'Remove it from that clone or use a different codebase registration.'
        )
      );

      await expect(
        resolver.resolve({
          existingEnvId: null,
          codebase: defaultCodebase,
          hints: { workflowType: 'issue', workflowId: '42' },
          platformType: 'web',
        })
      ).rejects.toThrow(/belongs to a different clone/);

      // DB row is preserved — it legitimately belongs to the other clone
      expect(updateStatusSpy).not.toHaveBeenCalled();
    });

    test('findReusable succeeds when worktree belongs to the same clone', async () => {
      const env = makeEnvRow();
      const resolver = createResolver({
        store: makeMockStore({ findActiveByWorkflow: async () => env }),
      });
      // Default ownership spy resolves — same-clone match

      const result = await resolver.resolve({
        existingEnvId: null,
        codebase: defaultCodebase,
        hints: { workflowType: 'issue', workflowId: '42' },
        platformType: 'web',
      });

      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.method.type).toBe('workflow_reuse');
      }
      expect(verifyWorktreeOwnershipSpy).toHaveBeenCalledWith(
        '/worktrees/issue-42',
        '/repos/myrepo'
      );
    });

    test('findLinkedIssueEnv throws when linked env belongs to a different clone', async () => {
      const linkedEnv = makeEnvRow({
        workflow_type: 'issue',
        workflow_id: '100',
        working_path: '/worktrees/issue-100',
        branch_name: 'issue-100',
      });
      const updateStatusSpy = mock(() => Promise.resolve());
      const resolver = createResolver({
        store: makeMockStore({
          // First path (findReusable) misses — no active env for requested workflowId
          // Second path (findLinkedIssueEnv) returns linkedEnv for issue 100
          findActiveByWorkflow: async (_c, type, id) =>
            type === 'issue' && id === '100' ? linkedEnv : null,
          updateStatus: updateStatusSpy,
        }),
      });
      verifyWorktreeOwnershipSpy.mockRejectedValue(
        new Error(
          'Worktree at /worktrees/issue-100 belongs to a different clone (/other/clone). ' +
            'Remove it from that clone or use a different codebase registration.'
        )
      );

      await expect(
        resolver.resolve({
          existingEnvId: null,
          codebase: defaultCodebase,
          hints: {
            workflowType: 'thread',
            workflowId: 'some-thread',
            linkedIssues: [100],
          },
          platformType: 'web',
        })
      ).rejects.toThrow(/belongs to a different clone/);

      // Linked DB row preserved — belongs to the other clone
      expect(updateStatusSpy).not.toHaveBeenCalled();
    });

    test('findLinkedIssueEnv succeeds when linked env belongs to the same clone', async () => {
      const linkedEnv = makeEnvRow({
        workflow_type: 'issue',
        workflow_id: '100',
        working_path: '/worktrees/issue-100',
        branch_name: 'issue-100',
      });
      const resolver = createResolver({
        store: makeMockStore({
          findActiveByWorkflow: async (_c, type, id) =>
            type === 'issue' && id === '100' ? linkedEnv : null,
        }),
      });
      // Default ownership spy resolves — same-clone match

      const result = await resolver.resolve({
        existingEnvId: null,
        codebase: defaultCodebase,
        hints: {
          workflowType: 'thread',
          workflowId: 'some-thread',
          linkedIssues: [100],
        },
        platformType: 'web',
      });

      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.method.type).toBe('linked_issue_reuse');
      }
    });

    test('tryBranchAdoption throws when discovered worktree belongs to a different clone', async () => {
      findWorktreeByBranchSpy.mockResolvedValue('/worktrees/feature-auth');
      verifyWorktreeOwnershipSpy.mockRejectedValue(
        new Error(
          'Worktree at /worktrees/feature-auth belongs to a different clone (/other/clone). ' +
            'Remove it from that clone or use a different codebase registration.'
        )
      );
      const createSpy = mock(async () => makeEnvRow());
      const resolver = createResolver({ store: makeMockStore({ create: createSpy }) });

      await expect(
        resolver.resolve({
          existingEnvId: null,
          codebase: defaultCodebase,
          hints: {
            workflowType: 'pr',
            workflowId: 'pr-42',
            prBranch: git.toBranchName('feature-auth'),
          },
          platformType: 'web',
        })
      ).rejects.toThrow(/belongs to a different clone/);

      // Symmetry with paths 1+2: no DB mutation on cross-clone rejection.
      // Here it's create (vs updateStatus) because tryBranchAdoption writes
      // a new row rather than reusing an existing one.
      expect(createSpy).not.toHaveBeenCalled();
    });

    test('tryBranchAdoption succeeds when discovered worktree belongs to the same clone', async () => {
      findWorktreeByBranchSpy.mockResolvedValue('/worktrees/feature-auth');
      // Default ownership spy resolves — same-clone match

      const resolver = createResolver();

      const result = await resolver.resolve({
        existingEnvId: null,
        codebase: defaultCodebase,
        hints: {
          workflowType: 'pr',
          workflowId: 'pr-42',
          prBranch: git.toBranchName('feature-auth'),
        },
        platformType: 'web',
      });

      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.method.type).toBe('branch_adoption');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Canonical path resolution failures
  //
  // getCanonicalRepoPath() runs early in resolve() (before any adoption path)
  // because every downstream step needs the canonical repo root. Failures
  // must mirror createNewEnvironment's contract: known infrastructure errors
  // become a `blocked` result; unknown errors propagate as crashes.
  // -------------------------------------------------------------------------
  describe('canonical path resolution failure handling', () => {
    test('known infrastructure error returns blocked with classified user message', async () => {
      const eaccesError = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      eaccesError.code = 'EACCES';
      getCanonicalSpy.mockRejectedValue(eaccesError);

      const resolver = createResolver();

      const result = await resolver.resolve({
        existingEnvId: null,
        codebase: defaultCodebase,
        platformType: 'web',
      });

      expect(result.status).toBe('blocked');
      if (result.status === 'blocked') {
        expect(result.reason).toBe('creation_failed');
        expect(result.userMessage).toMatch(/Permission denied/);
        expect(result.userMessage).toMatch(/Execution blocked/);
      }
    });

    test('unknown error propagates as crash (programming bug visibility)', async () => {
      // Deliberately not a known isolation pattern so isKnownIsolationError returns false
      getCanonicalSpy.mockRejectedValue(new Error('Internal invariant violation: foo'));

      const resolver = createResolver();

      await expect(
        resolver.resolve({
          existingEnvId: null,
          codebase: defaultCodebase,
          platformType: 'web',
        })
      ).rejects.toThrow(/Internal invariant violation/);
    });
  });
});
