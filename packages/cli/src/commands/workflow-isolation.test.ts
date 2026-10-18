import {
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
import { workflowRunCommand } from './workflow';
import { resolveContainerBackendConfig, hasUnresolvedWriteback } from './workflow-isolation';

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
