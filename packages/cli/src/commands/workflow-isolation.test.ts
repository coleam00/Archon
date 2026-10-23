import * as chatScope from '../workflow-scope';
import {
  mockLogger,
  mockRunLiveOwnerClose,
  capturedSourceOwnerCalls,
  mockCanonicalizeProjectPath,
  mockDiscoverWorkflowsWithConfig,
  mockCreateWorkflowRun,
  captureError,
  createDetachedChildFixture,
  finishStartupWindow,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { InvalidCodebaseDefaultCwdError } from '@archon/core/utils/codebase-path';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock, jest } from 'bun:test';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';
import {
  folderRunsInContainer,
  resolveContainerBackendConfig,
  hasUnresolvedWriteback,
} from './workflow-isolation';

const scopeSpy = spyOn(chatScope, 'readChatProjectScope');

const git = await import('@archon/git');
const codebases = await import('@archon/core/db/codebases');
const core = await import('@archon/core');
const executor = await import('@archon/workflows/executor');

const runConversationDb = await import('@archon/core/db/conversations');

describe('hasUnresolvedWriteback (H2 teardown-preserve decision)', () => {
  it('true when the gate was raised but never resolved (failed/partial apply)', () => {
    expect(hasUnresolvedWriteback({ pending_writeback: { envId: 'e' } })).toBe(true);
  });
  it('false once the write-back resolved (applied/discarded)', () => {
    expect(
      hasUnresolvedWriteback({ pending_writeback: { envId: 'e' }, writeback_resolved: true })
    ).toBe(false);
  });
  it('false for a run that never raised a write-back gate', () => {
    expect(hasUnresolvedWriteback({ isolation: 'container' })).toBe(false);
    expect(hasUnresolvedWriteback(undefined)).toBe(false);
  });
});

describe('folderRunsInContainer', () => {
  const containerRun = { metadata: { isolation: 'container' } };
  const inPlaceRun = { metadata: {} };
  const configOn = { container: { enabled: true } };

  it('a resume follows the run it resumes, not the current flag or config', () => {
    expect(folderRunsInContainer({ resume: true }, {}, {}, containerRun)).toBe(true);
    expect(
      folderRunsInContainer(
        { resume: true, container: true },
        { container: { enabled: true } },
        configOn,
        inPlaceRun
      )
    ).toBe(false);
  });

  it('a fresh run takes the flag, then the workflow, then the config', () => {
    expect(
      folderRunsInContainer({ container: false }, { container: { enabled: true } }, configOn, null)
    ).toBe(false);
    expect(folderRunsInContainer({}, { container: { enabled: false } }, configOn, null)).toBe(
      false
    );
    expect(folderRunsInContainer({}, {}, configOn, containerRun)).toBe(true);
    expect(folderRunsInContainer({}, {}, undefined, containerRun)).toBe(false);
  });

  it.each([null, undefined, { metadata: {} }])(
    'a resume without recorded isolation stays on the host: %j',
    resumable => {
      expect(
        folderRunsInContainer(
          { resume: true, container: true },
          { container: { enabled: true } },
          configOn,
          resumable
        )
      ).toBe(false);
    }
  );
});

describe('resolveContainerBackendConfig', () => {
  it('applies defaults when config is absent', () => {
    const cfg = resolveContainerBackendConfig(undefined);
    expect(cfg).toEqual({
      image: 'archon-runner:latest',
      network: 'bridge',
      memoryMb: 4096,
      pidsLimit: 512,
    });
  });

  it('passes through valid values', () => {
    const cfg = resolveContainerBackendConfig({
      image: '  my-runner:1  ',
      network: 'none',
      memoryMb: 2048,
      pidsLimit: 256,
    });
    expect(cfg).toEqual({
      image: 'my-runner:1',
      network: 'none',
      memoryMb: 2048,
      pidsLimit: 256,
    });
  });

  it('rejects a non bridge/none network (no silent --network host)', () => {
    expect(() => resolveContainerBackendConfig({ network: 'host' })).toThrow(/bridge.*none/);
  });

  it('rejects a fractional memoryMb (docker --memory needs an integer)', () => {
    expect(() => resolveContainerBackendConfig({ memoryMb: 512.5 })).toThrow(/positive integer/);
  });

  it('rejects a non-integer / non-positive pidsLimit', () => {
    expect(() => resolveContainerBackendConfig({ pidsLimit: 10.5 })).toThrow(/positive integer/);
    expect(() => resolveContainerBackendConfig({ pidsLimit: 0 })).toThrow(/positive integer/);
  });
});

describe('run codebase resolution', () => {
  const childRoot = '/parent/projects/child';
  const child = { id: 'cb-child', name: 'owner/child', default_cwd: childRoot, kind: 'repo' };
  const parent = { id: 'cb-parent', name: 'owner/parent', default_cwd: '/parent', kind: 'repo' };
  let consoleSpy: ReturnType<typeof spyOn>;

  function resetLookups(): void {
    (git.findRepoRoot as ReturnType<typeof mock>).mockReset().mockResolvedValue(null);
    (git.getCanonicalRepoPath as ReturnType<typeof mock>)
      .mockReset()
      .mockImplementation(async (path: string) => path);
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>)
      .mockReset()
      .mockResolvedValue(null);
    (codebases.findCodebaseByPathPrefix as ReturnType<typeof mock>)
      .mockReset()
      .mockResolvedValue(null);
    (codebases.getCodebase as ReturnType<typeof mock>).mockReset().mockResolvedValue(null);
    (core.registerRepository as ReturnType<typeof mock>).mockReset().mockResolvedValue({
      codebaseId: 'cb-auto',
      name: 'test/repo',
      defaultCwd: '/test/path',
      alreadyExisted: false,
    });
  }

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    resetLookups();
    (runConversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockClear();
    mockCreateWorkflowRun.mockClear();
    (executor.executeWorkflow as ReturnType<typeof mock>).mockClear();
    mockDiscoverWorkflowsWithConfig.mockReset().mockResolvedValue({
      workflows: [makeTestWorkflowWithSource({ name: 'probe' })],
      errors: [],
    });
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValue(childRoot);
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockImplementation(
      async (path: string) => (path === '/parent' ? parent : null)
    );
    (codebases.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValue(parent);
    (core.registerRepository as ReturnType<typeof mock>).mockResolvedValue({
      codebaseId: child.id,
      name: child.name,
      defaultCwd: childRoot,
      alreadyExisted: false,
    });
    (codebases.getCodebase as ReturnType<typeof mock>).mockImplementation(async (id: string) =>
      id === child.id ? child : null
    );
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    resetLookups();
  });

  function expectChildExecution(): void {
    expect(runConversationDb.getOrCreateConversation).not.toHaveBeenCalled();
    expect(
      (executor.executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1)?.[7]
    ).toMatchObject({ codebaseId: child.id });
  }

  it.each([
    { noWorktree: true },
    { detach: true },
    { noWorktree: true, codebaseId: child.id },
    { detach: true, codebaseId: child.id },
    { noWorktree: true, folder: true },
  ])('refuses foreign chat launches before registration or execution (%j)', async options => {
    scopeSpy.mockReturnValue(parent.id);
    (codebases.getCodebase as ReturnType<typeof mock>).mockImplementation(async (id: string) =>
      id === parent.id ? parent : child
    );
    (core.registerRepository as ReturnType<typeof mock>).mockClear();
    (core.registerFolder as ReturnType<typeof mock>).mockClear();
    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', options)
      ).rejects.toThrow('/setproject');
      expect(core.registerRepository).not.toHaveBeenCalled();
      expect(core.registerFolder).not.toHaveBeenCalled();
      expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
      expect(executor.executeWorkflow).not.toHaveBeenCalled();
    } finally {
      scopeSpy.mockReturnValue(undefined);
    }
  });

  it.each([
    { detach: false, pinned: false },
    { detach: true, pinned: false },
    { detach: false, pinned: true },
    { detach: true, pinned: true },
  ])(
    'refuses a selected project ID executing in a foreign checkout (%j)',
    async ({ detach, pinned }) => {
      scopeSpy.mockReturnValue(child.id);
      (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(parent);
      if (pinned) {
        mockDiscoverWorkflowsWithConfig.mockResolvedValue({
          workflows: [makeTestWorkflowWithSource({ name: 'probe', worktree: { enabled: false } })],
          errors: [],
        });
      }
      try {
        await expect(
          workflowRunCommand(createTestWorkflowHost(), '/parent', 'probe', 'go', {
            codebaseId: child.id,
            noWorktree: !pinned,
            detach,
          })
        ).rejects.toThrow('/setproject');
        expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
        expect(executor.executeWorkflow).not.toHaveBeenCalled();
      } finally {
        scopeSpy.mockReturnValue(undefined);
      }
    }
  );

  it.each(['reuse-worktree', 'checkout-branch', 'foreign-worktree'] as const)(
    'checks the resolved detached adoption checkout (%s)',
    async laneKind => {
      const { resolveWorkflowAdoption } = await import('@archon/core/operations/workflow-adoption');
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
        { id: 'run-adopted' },
      ]);
      scopeSpy.mockReturnValue(child.id);
      const workingPath = laneKind === 'foreign-worktree' ? '/parent' : `${childRoot}/worktree`;
      (git.findRepoRoot as ReturnType<typeof mock>).mockImplementation(async (path: string) =>
        path === '/parent' ? '/parent' : childRoot
      );
      (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockImplementation(
        async (path: string) => (path === childRoot ? child : path === '/parent' ? parent : null)
      );
      mockDiscoverWorkflowsWithConfig.mockResolvedValue({
        workflows: [makeTestWorkflowWithSource({ name: 'probe', worktree: { enabled: false } })],
        errors: [],
      });
      (resolveWorkflowAdoption as ReturnType<typeof mock>).mockResolvedValueOnce({
        adoptedRun: { id: 'run-adopted', status: 'completed', codebase_id: child.id },
        lane:
          laneKind === 'checkout-branch'
            ? { kind: 'checkout-branch', taskBranch: { kind: 'existing', branch: 'feature/adopt' } }
            : {
                kind: 'reuse-worktree',
                environment: { id: 'env-adopted', working_path: workingPath },
              },
      });
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(createDetachedChildFixture().child);
      jest.useFakeTimers();
      try {
        const command = workflowRunCommand(createTestWorkflowHost(), '/parent', 'probe', 'go', {
          codebaseId: child.id,
          adoptRunId: 'run-adopted',
          detach: true,
        });
        if (laneKind === 'foreign-worktree') {
          await expect(command).rejects.toThrow('/setproject');
          expect(spawnSpy).not.toHaveBeenCalled();
          expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
        } else {
          await finishStartupWindow(command, spawnSpy);
          expect(spawnSpy).toHaveBeenCalledTimes(1);
          expect(mockCreateWorkflowRun).toHaveBeenCalledWith(
            expect.objectContaining({ codebase_id: child.id, adopted_from_run_id: 'run-adopted' })
          );
        }
        expect(resolveWorkflowAdoption).toHaveBeenCalledWith(
          expect.objectContaining({ adoptedRunId: 'run-adopted', codebaseId: child.id })
        );
        expect(executor.executeWorkflow).not.toHaveBeenCalled();
      } finally {
        scopeSpy.mockReturnValue(undefined);
        jest.useRealTimers();
        spawnSpy.mockRestore();
        (resolveWorkflowAdoption as ReturnType<typeof mock>)
          .mockReset()
          .mockRejectedValue(new Error('adoption not expected'));
      }
    }
  );

  it.each([undefined, child.id])(
    'allows a launch in the selected chat checkout (id=%s)',
    async codebaseId => {
      scopeSpy.mockReturnValue(child.id);
      (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(child);
      try {
        await workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
          codebaseId,
          noWorktree: true,
        });
        expectChildExecution();
      } finally {
        scopeSpy.mockReturnValue(undefined);
      }
    }
  );

  it('allows a detached explicit project launch in the selected chat checkout', async () => {
    scopeSpy.mockReturnValue(child.id);
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(child);
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(createDetachedChildFixture().child);
    jest.useFakeTimers();
    try {
      const command = workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
        codebaseId: child.id,
        noWorktree: true,
        detach: true,
      });
      await finishStartupWindow(command, spawnSpy);
      expect(mockCreateWorkflowRun).toHaveBeenCalledWith(
        expect.objectContaining({ codebase_id: child.id })
      );
    } finally {
      jest.useRealTimers();
      spawnSpy.mockRestore();
      scopeSpy.mockReturnValue(undefined);
    }
  });

  it.each([false, true])(
    'refuses foreign name-based resume before reading its source (detach=%s)',
    async detach => {
      scopeSpy.mockReturnValue(child.id);
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'foreign-run',
        codebase_id: parent.id,
        workflow_name: 'probe',
        status: 'paused',
      });
      const { mockResolveContinuationWorkflow } = await import(
        '../test-support/workflow-command-harness'
      );
      mockResolveContinuationWorkflow.mockClear();
      try {
        await expect(
          workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
            resume: true,
            detach,
          })
        ).rejects.toThrow('/setproject');
        expect(mockResolveContinuationWorkflow).not.toHaveBeenCalled();
        expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
        expect(executor.executeWorkflow).not.toHaveBeenCalled();
      } finally {
        scopeSpy.mockReturnValue(undefined);
      }
    }
  );

  it('passes the registration choice while leaving this run base unset', async () => {
    await workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
      noWorktree: true,
      registrationBaseBranch: 'release',
    });
    expect(core.registerRepository).toHaveBeenCalledWith(childRoot, { baseBranch: 'release' });
    expectChildExecution();
  });

  it.each([{ noWorktree: true }, { detach: true }])(
    'refuses to launch when a newly registered project cannot be read back (%j)',
    async options => {
      (codebases.getCodebase as ReturnType<typeof mock>).mockResolvedValue(null);
      await expect(
        workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', options)
      ).rejects.toThrow('cb-child');
      expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
      expect(executor.executeWorkflow).not.toHaveBeenCalled();
    }
  );

  it.each(['missing', 'error'] as const)(
    'requires the supplied project ID when its lookup is %s',
    async mode => {
      const lookup = codebases.getCodebase as ReturnType<typeof mock>;
      if (mode === 'error') lookup.mockRejectedValue(new Error('stored project lookup failed'));
      else lookup.mockResolvedValue(null);
      (core.registerRepository as ReturnType<typeof mock>).mockClear();
      await expect(
        workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
          noWorktree: true,
          codebaseId: 'stored-project',
        })
      ).rejects.toThrow(
        mode === 'error'
          ? 'Cannot run workflow: project lookup failed.\nError: stored project lookup failed'
          : /^Project "stored-project" no longer exists\.$/
      );
      expect(core.registerRepository).not.toHaveBeenCalled();
      expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
      expect(executor.executeWorkflow).not.toHaveBeenCalled();
    }
  );

  it('uses the supplied project ID even when the path matches another project', async () => {
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(parent);
    await workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
      noWorktree: true,
      codebaseId: child.id,
    });
    expectChildExecution();
  });

  it('a registration failure is fatal instead of running unregistered', async () => {
    (core.registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("EACCES: permission denied, mkdir '/w/_local/child'")
    );
    const error = await captureError(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', { noWorktree: true })
    );
    expect(error.message).toContain('Cannot run workflow: project registration failed.');
    expect(error.message).toContain('Check your Archon workspace registration');
    expect(executor.executeWorkflow).not.toHaveBeenCalled();
  });

  it('reports a registration refusal without a workspace hint', async () => {
    const { ProjectRegistrationError } = await import('@archon/core/handlers/clone');
    (core.registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new ProjectRegistrationError('Project "acme/app" is already registered at /prod/app')
    );
    const error = await captureError(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', { noWorktree: true })
    );
    expect(error.message).toBe(
      'Cannot run workflow: project registration failed.\n' +
        'Error: Project "acme/app" is already registered at /prod/app'
    );
    expect(executor.executeWorkflow).not.toHaveBeenCalled();
  });

  it('explicit registration failure is fatal even without worktrees', async () => {
    (core.registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("Configured base branch 'unknown' not found on remote 'origin'")
    );
    await expect(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
        noWorktree: true,
        registrationBaseBranch: 'unknown',
      })
    ).rejects.toThrow("Configured base branch 'unknown'");
    expect(executor.executeWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a registration choice for an existing project', async () => {
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(child);
    await expect(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
        noWorktree: true,
        registrationBaseBranch: 'release',
      })
    ).rejects.toThrow('already registered');
    expect(core.registerRepository).not.toHaveBeenCalled();
  });

  it('rejects a registration choice for a folder project', async () => {
    (core.registerFolder as ReturnType<typeof mock>).mockClear();
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValue(null);
    await expect(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
        noWorktree: true,
        folder: true,
        registrationBaseBranch: 'release',
      })
    ).rejects.toThrow('Folder projects have no base branch');
    expect(core.registerFolder).not.toHaveBeenCalled();
  });

  for (const incompatible of [
    { resume: true },
    { adoptRunId: 'old' },
    { supersedesRunId: 'old' },
    { dryRun: true },
  ]) {
    it(`rejects registration choice with ${Object.keys(incompatible)[0]}`, async () => {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', {
          ...incompatible,
          registrationBaseBranch: 'release',
        })
      ).rejects.toThrow('initial registration');
      expect(core.registerRepository).not.toHaveBeenCalled();
    });
  }

  it('registers an unregistered child from its nearest Git root', async () => {
    await workflowRunCommand(createTestWorkflowHost(), `${childRoot}/tools`, 'probe', 'go', {
      noWorktree: true,
    });
    expect(core.registerRepository).toHaveBeenCalledWith(childRoot, { baseBranch: undefined });
    expectChildExecution();
  });

  it('registers the child even when the workflow disables worktrees', async () => {
    mockDiscoverWorkflowsWithConfig.mockResolvedValue({
      workflows: [makeTestWorkflowWithSource({ name: 'probe', worktree: { enabled: false } })],
      errors: [],
    });
    await workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go');
    expect(core.registerRepository).toHaveBeenCalledWith(childRoot, { baseBranch: undefined });
    expectChildExecution();
  });

  it('registers the child during detached preflight and attributes the pending run', async () => {
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(createDetachedChildFixture().child);
    jest.useFakeTimers();
    try {
      const command = workflowRunCommand(
        createTestWorkflowHost(),
        `${childRoot}/tools`,
        'probe',
        'go',
        {
          detach: true,
          noWorktree: true,
        }
      );
      await finishStartupWindow(command, spawnSpy);
      expect(runConversationDb.getOrCreateConversation).not.toHaveBeenCalled();
      expect(mockCreateWorkflowRun).toHaveBeenCalledWith(
        expect.objectContaining({ codebase_id: child.id })
      );
      expect(core.registerRepository).toHaveBeenCalledWith(childRoot, { baseBranch: undefined });
    } finally {
      jest.useRealTimers();
      spawnSpy.mockRestore();
    }
  });

  for (const cwd of [childRoot, `${childRoot}/tools`]) {
    it(`reuses the registered repository from ${cwd}`, async () => {
      (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockImplementation(
        async (path: string) => (path === childRoot ? child : path === '/parent' ? parent : null)
      );
      await workflowRunCommand(createTestWorkflowHost(), cwd, 'probe', 'go', { noWorktree: true });
      expect(core.registerRepository).not.toHaveBeenCalled();
      expectChildExecution();
    });
  }

  it('maps a linked worktree subdirectory to the registered primary checkout', async () => {
    const worktree = '/parent/worktrees/child-probe';
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValue(worktree);
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockImplementation(
      async (path: string) => (path === worktree ? childRoot : path)
    );
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockImplementation(
      async (path: string) => (path === childRoot ? child : path === '/parent' ? parent : null)
    );
    await workflowRunCommand(createTestWorkflowHost(), `${worktree}/tools`, 'probe', 'go', {
      noWorktree: true,
    });
    expect(core.registerRepository).not.toHaveBeenCalled();
    expectChildExecution();
  });

  it('uses the resolver for canonical lookup and passes the Git top level to registration', async () => {
    // Git prints `C:/...` on Windows while `default_cwd` is stored canonically.
    const gitSpelling = 'C:/parent/projects/child';
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValue(gitSpelling);
    mockCanonicalizeProjectPath.mockImplementation(async (path: string) =>
      path === gitSpelling ? childRoot : path
    );
    try {
      await workflowRunCommand(createTestWorkflowHost(), `${childRoot}/tools`, 'probe', 'go', {
        noWorktree: true,
      });
      expect(codebases.findCodebaseByDefaultCwd).toHaveBeenCalledWith(childRoot);
      expect(codebases.findCodebaseByDefaultCwd).not.toHaveBeenCalledWith(gitSpelling);
      expect(core.registerRepository).toHaveBeenCalledWith(gitSpelling, { baseBranch: undefined });
      expectChildExecution();
    } finally {
      mockCanonicalizeProjectPath.mockReset().mockImplementation(async (path: string) => path);
    }
  });

  for (const options of [
    { folder: true, noWorktree: true },
    { folder: true, detach: true },
  ]) {
    it(`explicit folder lookup failure stops execution before registration (${JSON.stringify(options)})`, async () => {
      const registerFolder = core.registerFolder as ReturnType<typeof mock>;
      registerFolder.mockClear();
      (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
        new Error('registration lookup unavailable')
      );
      await expect(
        workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', options)
      ).rejects.toThrow('registration lookup unavailable');
      expect(registerFolder).not.toHaveBeenCalled();
      expect(core.registerRepository).not.toHaveBeenCalled();
      expect(executor.executeWorkflow).not.toHaveBeenCalled();
      expect(git.findRepoRoot).not.toHaveBeenCalled();
    });
  }

  it('retains prefix resolution for a non-Git folder subdirectory', async () => {
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValue(null);
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(null);
    (codebases.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValue({
      id: 'cb-folder',
      name: 'folder',
      default_cwd: '/folder',
      kind: 'folder',
    });
    await workflowRunCommand(createTestWorkflowHost(), '/folder/tools', 'probe', 'go');
    expect(codebases.findCodebaseByPathPrefix).toHaveBeenCalledWith('/folder/tools');
    expect(core.registerRepository).not.toHaveBeenCalled();
    expect(
      (executor.executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1)?.[7]
    ).toMatchObject({ codebaseId: 'cb-folder' });
  });

  it('preserves a legacy path error during registration without falling back', async () => {
    const error = new InvalidCodebaseDefaultCwdError('legacy', 'projects/repo');
    (core.registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(error);
    await expect(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', { noWorktree: true })
    ).rejects.toThrow(error.message);
    expect(executor.executeWorkflow).not.toHaveBeenCalled();
  });

  for (const options of [{ noWorktree: true }, { detach: true }, { codebaseId: 'legacy' }]) {
    it(`treats an invalid stored path as terminal with ${JSON.stringify(options)}`, async () => {
      const error = new InvalidCodebaseDefaultCwdError('legacy', 'projects/repo');
      if ('codebaseId' in options) {
        (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(null);
        (codebases.getCodebase as ReturnType<typeof mock>).mockRejectedValueOnce(error);
      } else {
        (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
          error
        );
      }
      await expect(
        workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go', options)
      ).rejects.toThrow(error.message);
      expect(core.registerRepository).not.toHaveBeenCalled();
      expect(executor.executeWorkflow).not.toHaveBeenCalled();
    });
  }

  it('surfaces checkout identity errors without parent fallback or registration', async () => {
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('checkout identity unavailable')
    );
    await expect(
      workflowRunCommand(createTestWorkflowHost(), childRoot, 'probe', 'go')
    ).rejects.toThrow('checkout identity unavailable');
    expect(core.registerRepository).not.toHaveBeenCalled();
  });
});

describe('workflowRunCommand — isolation and worktree flags', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.info.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when codebase lookup fails (isolation is default)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    );

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello')
    ).rejects.toThrow('Cannot run workflow: project lookup failed');
  });

  it('refuses a failed project lookup with --no-worktree before execution', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    const codebaseDb = await import('@archon/core/db/codebases');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    );
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        noWorktree: true,
      })
    ).rejects.toThrow('project lookup failed');
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('passes --from as a new task branch start point', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      branchName: 'test-adapters',
      fromBranch: 'feature/extract-adapters',
    });

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;

    expect(provider?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: 'task',
        identifier: 'test-adapters',
        taskBranch: {
          kind: 'new',
          branch: 'test-adapters',
          fromBranch: 'feature/extract-adapters',
        },
      }),
      expect.any(Function)
    );
  });

  it('throws when --branch is used with --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    // Validation throws before codebase lookup — no need to mock findCodebaseByDefaultCwd
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'test-branch',
        noWorktree: true,
      })
    ).rejects.toThrow('--branch and --no-worktree are mutually exclusive');
  });

  it('throws when --from is used with --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    // Validation throws before codebase lookup — no need to mock findCodebaseByDefaultCwd
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        fromBranch: 'dev',
        noWorktree: true,
      })
    ).rejects.toThrow('--from/--from-branch has no effect with --no-worktree');
  });

  // ── Folder projects ──────────────────────────────────────────────────────
  it('registers a folder project and runs in place with --folder', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const core = await import('@archon/core');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // No codebase found → auto-register as folder (registerFolder mock returns cb-folder)
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const registerSpy = core.registerFolder as ReturnType<typeof mock>;
    const isolation = await import('@archon/isolation');
    const isolationSpy = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const isolationBefore = isolationSpy.mock.calls.length;
    const execBefore = executeSpy.mock.calls.length;
    const registerBefore = registerSpy.mock.calls.length;
    executeSpy.mockResolvedValueOnce({ success: true, workflowRunId: 'run-folder' });

    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    let printed = '';
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'do it', {
        folder: true,
      });
      printed = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    } finally {
      consoleSpy.mockRestore();
    }

    // Explicit folder registration also applies to git roots.
    expect(registerSpy.mock.calls.length).toBe(registerBefore + 1);
    // The run executed in place
    expect(executeSpy.mock.calls.length).toBe(execBefore + 1);
    expect(executeSpy.mock.calls.at(-1)?.[3]).toBe('/test/path');
    expect(isolationSpy.mock.calls.length).toBe(isolationBefore);
    // The in-place notice was printed
    expect(printed).toContain('running in place');
  });

  it('rejects --branch against a registered folder project', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // Registered folder project resolved by the main lookup (Once — never leak
    // the folder kind into sibling tests via a persistent mock).
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'feature-x',
      })
    ).rejects.toThrow('Worktree options require a git-repo project');
  });

  it('rejects --base against a registered folder project', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });

    // A folder project creates no worktree, so --base cannot drive a cut-from —
    // but it WOULD still reach $BASE_BRANCH. Half-applied is worse than rejected.
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        baseBranch: 'epic/foo',
      })
    ).rejects.toThrow('Worktree options require a git-repo project');
  });

  it('rejects --folder --branch synchronously (flag-based, before any DB/registration)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    const registerSpy = core.registerFolder as ReturnType<typeof mock>;
    const registerBefore = registerSpy.mock.calls.length;

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        folder: true,
        branchName: 'x',
      })
    ).rejects.toThrow('Worktree options require a git-repo project');
    // The flag-based guard fires before any registration work.
    expect(registerSpy.mock.calls.length).toBe(registerBefore);
  });

  it('rejects a worktree-pinned workflow against a registered folder project', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'assist',
          description: 'Help',
          worktree: { enabled: true },
        }),
      ],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {})
    ).rejects.toThrow('requires a worktree');
  });

  it('creates worktree with auto-generated branch when no --branch given', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');
    const isolationDb = await import('@archon/core/db/isolation-environments');

    // Snapshot call counts before this test (process-global mocks)
    const findActiveCallsBefore = (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mock
      .calls.length;

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // No branchName, no noWorktree — should auto-isolate
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {});

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;

    // provider.create should have been called with an auto-generated identifier
    expect(provider?.create).toHaveBeenCalled();
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      identifier: string;
      workflowType: string;
    };
    expect(lastCreateCall.workflowType).toBe('task');
    expect(lastCreateCall.identifier).toMatch(/^assist-\d+$/);

    // findActiveByWorkflow should NOT have been called during this test (no explicit --branch)
    const findActiveCallsAfter = (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mock
      .calls.length;
    expect(findActiveCallsAfter).toBe(findActiveCallsBefore);
  });

  it('keeps a failed worktree launch queryable and retains its source without executing nodes', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const isolation = await import('@archon/isolation');
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-setup',
      default_cwd: '/test/path',
    });
    const create = mock(async () => {
      expect(mockCreateWorkflowRun.mock.calls.at(-1)?.[0]).toMatchObject({ id: 'test-run-id' });
      throw new Error('post-create failed with exit code 7');
    });
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockReturnValueOnce({
      create,
      healthCheck: async () => true,
    });
    const executeCount = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    capturedSourceOwnerCalls.length = 0;
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'go')
    ).rejects.toThrow('exit code 7');
    expect((executeWorkflow as ReturnType<typeof mock>).mock.calls).toHaveLength(executeCount);
    expect(workflowDb.failWorkflowRun).toHaveBeenCalledWith(
      'test-run-id',
      expect.stringContaining('exit code 7'),
      { exitReason: 'launch_failed' }
    );
    expect(capturedSourceOwnerCalls).toContain('adopt');
    expect(capturedSourceOwnerCalls.some(call => call.startsWith('reclaim:'))).toBe(false);
  });

  it('records a preparation failure before releasing its live-owner lock', async () => {
    const isolation = await import('@archon/isolation');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-owner',
      default_cwd: '/test/path',
    });
    (isolation.configureIsolation as ReturnType<typeof mock>)
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('child resolver configuration failed');
      });
    const closesBefore = mockRunLiveOwnerClose.mock.calls.length;
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      expect(mockRunLiveOwnerClose.mock.calls).toHaveLength(closesBefore);
      return { failed: true };
    });
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'go')
    ).rejects.toThrow('child resolver configuration failed');
    expect(mockRunLiveOwnerClose.mock.calls).toHaveLength(closesBefore + 1);
  });

  it('surfaces a classified worktree creation failure, not the raw error', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    // A setup failure whose rollback left a directory behind carries the leftover
    // note beside its message; only the classifier reads it (#3448).
    const failure = Object.assign(new Error('Submodule initialization failed: no network'), {
      cleanupFailure: 'The incomplete workspace at /test/path/wt was left behind',
    });
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockReturnValueOnce({
      create: mock(() => Promise.reject(failure)),
      healthCheck: mock(() => Promise.resolve(true)),
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {})
    ).rejects.toThrow(/^classified: Submodule initialization failed/);
  });

  it('skips isolation when --no-worktree flag is set', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    // Snapshot provider.create call count before this test
    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const providerBefore = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const createCallsBefore = providerBefore?.create.mock.calls.length ?? 0;

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      noWorktree: true,
    });

    // provider.create should NOT have been called during this test
    const providerAfter = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const createCallsAfter = providerAfter?.create.mock.calls.length ?? 0;
    expect(createCallsAfter).toBe(createCallsBefore);
  });

  // -------------------------------------------------------------------------
  // Auto-registration failure → truthful CLI error
  // -------------------------------------------------------------------------

  it('surfaces auto-registration failures on --resume instead of claiming the repo is invalid', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { registerRepository } = await import('@archon/core');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (gitModule.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce('/test/path');
    (registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("EACCES: permission denied, mkdir '/home/test/.archon/workspaces/acme'")
    );

    const error = await captureError(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        resume: true,
      })
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Cannot run workflow: project registration failed.');
    expect(error.message).toContain('EACCES: permission denied');
    expect(error.message).not.toContain('Not in a git repository');
  });

  it('falls back to generic workspace hint when registration error has an unrecognized shape', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { registerRepository } = await import('@archon/core');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (gitModule.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce('/test/path');
    (registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("EACCES: permission denied, mkdir '/home/test/.archon/workspaces/acme'")
    );

    const error = await captureError(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {})
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Cannot run workflow: project registration failed.');
    expect(error.message).toContain('EACCES: permission denied');
    // Path-separator-agnostic check: on Windows path.join normalizes to `\`,
    // on POSIX to `/`. Assert the hint prefix + the final segment separately.
    expect(error.message).toContain('Check your Archon workspace registration under');
    expect(error.message).toMatch(/workspaces\b/);
  });

  // -------------------------------------------------------------------------
  // Workflow-level `worktree.enabled` policy
  // -------------------------------------------------------------------------

  it('skips isolation when workflow YAML pins worktree.enabled: false', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const providerBefore = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const createCallsBefore = providerBefore?.create.mock.calls.length ?? 0;

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // No flags — policy alone should disable isolation
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'triage', 'go', {});

    const providerAfter = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const createCallsAfter = providerAfter?.create.mock.calls.length ?? 0;
    expect(createCallsAfter).toBe(createCallsBefore);
  });

  it('throws when workflow pins worktree.enabled: false but caller passes --branch', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'triage', 'go', {
        branchName: 'feat-x',
      })
    ).rejects.toThrow(/worktree\.enabled: false/);
  });

  it('throws when workflow pins worktree.enabled: false but caller passes --from', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'triage', 'go', {
        fromBranch: 'dev',
      })
    ).rejects.toThrow(/worktree\.enabled: false/);
  });

  it('throws when workflow pins worktree.enabled: false but caller passes --base', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });

    // A live-checkout run cuts no worktree, so --base can only half-apply:
    // it would still move $BASE_BRANCH. Reject it like --from rather than
    // silently retargeting the PR of a run that has no worktree.
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'triage', 'go', {
        baseBranch: 'epic/foo',
      })
    ).rejects.toThrow(/worktree\.enabled: false/);
  });

  it('accepts worktree.enabled: false + --no-worktree as redundant (no error)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // Should not throw — redundant, not contradictory
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'triage', 'go', {
      noWorktree: true,
    });
  });

  it('throws when workflow pins worktree.enabled: true but caller passes --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'build',
          description: 'Requires a worktree',
          worktree: { enabled: true },
        }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'build', 'go', {
        noWorktree: true,
      })
    ).rejects.toThrow(/worktree\.enabled: true/);
  });

  it('throws when isolation cannot be created due to missing codebase', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    // No codebase found
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    // Not in a git repo
    (gitModule.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {})
    ).rejects.toThrow('Cannot create worktree: not in a git repository');
  });

  it('emits warning when reused worktree has mismatched base branch', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      provider: 'worktree',
      branch_name: 'feature-old',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    (gitModule.isAncestorOf as ReturnType<typeof mock>).mockResolvedValueOnce(false);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'my-feature',
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("not based on 'dev'"));
      expect(isolationDb.updateMetadata).toHaveBeenCalledWith(
        'env-1',
        {
          adopted: true,
          worktree_registration_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          ),
        },
        expect.objectContaining({ id: 'env-1' })
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ envId: 'env-1' }),
        'worktree_adopted'
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('warns that --base did not change the cut-from when reusing a worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      provider: 'worktree',
      branch_name: 'feature-old',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    // Base is valid, so the mismatch warning stays silent and this test asserts
    // only the reuse notice.
    (gitModule.isAncestorOf as ReturnType<typeof mock>).mockResolvedValueOnce(true);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'my-feature',
        baseBranch: 'epic/foo',
      });
      // Unlike --from (which is fully ignored on reuse), --base is PARTIALLY
      // applied: the cut-from is already fixed, but $BASE_BRANCH still moves.
      // The wording has to say so, or it trades one silent surprise for another.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('--base epic/foo did not change the cut-from')
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('it still applies to the PR target')
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('validates a reused worktree against --base rather than repo config', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      provider: 'worktree',
      branch_name: 'feature-old',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    (gitModule.isAncestorOf as ReturnType<typeof mock>).mockResolvedValueOnce(false);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'my-feature',
        baseBranch: 'epic/foo',
      });
      // Repo config says 'dev'; the dispatch said 'epic/foo'. Checking ancestry
      // against 'dev' would report a mismatch nobody asked about.
      expect(gitModule.isAncestorOf as ReturnType<typeof mock>).toHaveBeenCalledWith(
        '/worktrees/feat',
        'origin/epic/foo'
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("not based on 'epic/foo'")
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('validates an automatic reused worktree against the configured upstream remote', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      provider: 'worktree',
      branch_name: 'feature-valid',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    const core = await import('@archon/core');
    const gitModule = await import('@archon/git');
    (core.loadRepoConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      worktree: { remote: ' upstream ' },
    });
    // isAncestorOf returns true by default — no warning expected
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'my-feature',
      });
      expect(gitModule.getDefaultBranch).toHaveBeenCalledWith('/test/path', 'upstream');
      expect(gitModule.isAncestorOf).toHaveBeenCalledWith('/worktrees/feat', 'upstream/dev');
      const baseBranchWarnCalls = consoleWarnSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('not based on')
      );
      expect(baseBranchWarnCalls).toHaveLength(0);
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('uses codebase default_branch for reuse validation instead of git auto-detection', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    const gitModule = await import('@archon/git');

    const getDefaultBranchCallsBefore = (gitModule.getDefaultBranch as ReturnType<typeof mock>).mock
      .calls.length;

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      provider: 'worktree',
      branch_name: 'feature-old',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    (gitModule.isAncestorOf as ReturnType<typeof mock>).mockResolvedValueOnce(false);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        branchName: 'my-feature',
      });
      // Warning names the codebase default branch, not the auto-detected 'dev'
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("not based on 'develop'")
      );
      // The stored default branch short-circuits git auto-detection entirely
      const getDefaultBranchCallsAfter = (gitModule.getDefaultBranch as ReturnType<typeof mock>)
        .mock.calls.length;
      expect(getDefaultBranchCallsAfter).toBe(getDefaultBranchCallsBefore);
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('threads codebase default_branch into provider.create and executeWorkflow opts', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // No branchName, no noWorktree — auto-isolates via provider.create
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {});

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      baseBranch?: string;
    };
    expect(lastCreateCall.baseBranch).toBe('develop');

    // executeWorkflow opts (trailing arg) carry the same fallback for $BASE_BRANCH
    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const lastExecuteArgs = executeSpy.mock.calls.at(-1) as unknown[];
    const opts = lastExecuteArgs[lastExecuteArgs.length - 1] as { baseBranch?: string };
    expect(opts.baseBranch).toBe('develop');
  });

  it('rejects --base combined with --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'go', {
        noWorktree: true,
        baseBranch: 'epic/foo',
      })
    ).rejects.toThrow(/--base has no effect with --no-worktree/i);
  });

  it('threads --base override into provider.create (baseOverride) and executeWorkflow opts (PR target)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // --base epic/foo dispatched via the baseBranch option (from the CLI flag)
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      baseBranch: 'epic/foo',
    });

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      baseBranch?: string;
      baseOverride?: string;
    };
    // Flag flows as the override (wins over config + codebase default in the
    // provider); codebase default stays in the request as the fallback.
    expect(lastCreateCall.baseOverride).toBe('epic/foo');
    expect(lastCreateCall.baseBranch).toBe('develop');

    // PR target / $BASE_BRANCH: the flag rides its own `baseOverride` channel so
    // it outranks `worktree.baseBranch` inside executeWorkflow. `baseBranch`
    // keeps carrying the codebase default as the fallback — the same split the
    // provider request uses above. Asserting the flag in `baseBranch` here would
    // pass while $BASE_BRANCH still resolved to repo config (see the
    // 'baseOverride over repo config' case in
    // packages/workflows/src/executor.dispatch.test.ts, which covers the resolution).
    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const lastExecuteArgs = executeSpy.mock.calls.at(-1) as unknown[];
    const opts = lastExecuteArgs[lastExecuteArgs.length - 1] as {
      baseBranch?: string;
      baseOverride?: string;
    };
    expect(opts.baseOverride).toBe('epic/foo');
    expect(opts.baseBranch).toBe('develop');
  });

  it('warns that --base did not change the cut-from when resuming a run', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // A null hydration aborts the resume before executeWorkflow, so the run must
    // carry prior state for this path to reach the dispatch.
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      preCreatedRun: { id: 'run-prior', workflow_name: 'assist' },
      priorCompletedNodes: new Map([['node-a', 'done']]),
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    // working_path null keeps the resume on the caller cwd, skipping the
    // existsSync probe (fs is deliberately not mocked in this suite).
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-prior',
      working_path: null,
      workflow_name: 'assist',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        resume: true,
        baseBranch: 'epic/foo',
      });
      // --resume adopts the prior run's worktree, so its cut-from is as fixed as
      // it is on --branch reuse -- but flagBase still reaches executeWorkflow as
      // baseOverride and moves $BASE_BRANCH. Same half-applied shape, same
      // warning.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('--base epic/foo did not change the cut-from')
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('it still applies to the PR target')
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('lets --from win the cut-from while --base still drives the PR target', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      fromBranch: 'origin/release/2.0',
      baseBranch: 'dev',
    });

    // INTENTIONAL, not an oversight: --base sets both halves of "base" by
    // default, and --from is the lever that decouples them. Combining them is
    // how you express "branch from release/2.0, but open the PR against dev" —
    // the one case a single flag cannot say. Making one flag win outright would
    // delete that capability, so this pairing is deliberately left unguarded.
    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      taskBranch?: { kind: string; fromBranch?: string };
      baseOverride?: string;
    };
    expect(lastCreateCall.taskBranch).toEqual({
      kind: 'new',
      fromBranch: 'origin/release/2.0',
    });
    expect(lastCreateCall.baseOverride).toBe('dev');

    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const lastExecuteArgs = executeSpy.mock.calls.at(-1) as unknown[];
    const opts = lastExecuteArgs[lastExecuteArgs.length - 1] as { baseOverride?: string };
    expect(opts.baseOverride).toBe('dev');
  });

  it('threads codebase name into provider.create so single-segment checkout paths resolve', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    // Single-segment checkout path — the stored owner/repo name must reach the
    // provider so worktrees use the registered identity instead of the
    // _local/<basename> path fallback (#2022, #2227).
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      name: 'owner/repo',
      default_cwd: '/workspace',
      default_branch: 'main',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/workspace', 'assist', 'hello', {});

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      codebaseName?: string;
    };
    expect(lastCreateCall.codebaseName).toBe('owner/repo');
  });

  it('omits baseBranch when the codebase has no stored default_branch', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: null,
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {});

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      baseBranch?: string;
    };
    expect(lastCreateCall.baseBranch).toBeUndefined();

    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const lastExecuteArgs = executeSpy.mock.calls.at(-1) as unknown[];
    const opts = lastExecuteArgs[lastExecuteArgs.length - 1] as { baseBranch?: string };
    expect(opts.baseBranch).toBeUndefined();
  });
});
