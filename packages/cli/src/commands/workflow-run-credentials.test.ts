import {
  mockFolderBackendPrepare,
  mockFolderBackendDestroy,
  mockCreateWorkflowRun,
  mockResolveFolderBackend,
  mockDiscoverWorkflowsWithConfig,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';

import { beforeEach, afterEach, describe, it, expect, spyOn, mock } from 'bun:test';

import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';

// Imported harness hooks do not reset mocks between files in a grouped Bun process.
async function readSharedLaunchSettings() {
  const core = await import('@archon/core');
  const codebases = await import('@archon/core/db/codebases');
  return {
    codebase: await codebases.findCodebaseByDefaultCwd('/test/path'),
    discovery: await mockDiscoverWorkflowsWithConfig(
      '/test/path',
      core.loadConfig,
      createTestWorkflowHost().deps.providers
    ),
    config: await core.loadConfig('/test/path'),
  };
}

let sharedLaunchSettings: Awaited<ReturnType<typeof readSharedLaunchSettings>>;
beforeEach(async () => {
  sharedLaunchSettings = await readSharedLaunchSettings();
});
afterEach(async () => {
  expect(await readSharedLaunchSettings()).toEqual(sharedLaunchSettings);
});

describe('workflow run credential launch refusal', () => {
  it.each(
    [false, true].flatMap(detach => [
      { detach, adopt: false },
      { detach, adopt: true },
    ])
  )('blocks before isolation, title generation and spawning (%j)', async ({ detach, adopt }) => {
    const adapter = await import('@archon/core/workflows/store-adapter');
    const original = adapter.createWorkflowDeps;
    const createDeps = spyOn(adapter, 'createWorkflowDeps').mockImplementation(() => ({
      ...original(),
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderCredential: async (_userId, vendor) => ({
        kind: 'api_key',
        getStatus: async () =>
          adopt && vendor === 'anthropic'
            ? { state: 'usable', source: 'archon' }
            : {
                state: 'unusable',
                source: 'archon',
                evidence: 'stored credential unreadable',
              },
      }),
    }));
    const isolation = await import('@archon/isolation');
    const core = await import('@archon/core');
    const codebases = await import('@archon/core/db/codebases');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const discover = async (path: string | null) => ({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'credential-run',
          provider: adopt && path === '/adopted/snapshot' ? 'codex' : 'claude',
        }),
      ],
      errors: [],
    });
    mockDiscoverWorkflowsWithConfig.mockImplementationOnce(discover);
    if (adopt) mockDiscoverWorkflowsWithConfig.mockImplementationOnce(discover);
    const adoptedRunId = '11111111-1111-1111-1111-111111111111';
    if (adopt) {
      const { resolveWorkflowAdoption } = await import('@archon/core/operations/workflow-adoption');
      (resolveWorkflowAdoption as ReturnType<typeof mock>).mockResolvedValueOnce({
        adoptedRun: { id: adoptedRunId, status: 'completed', working_path: '/old' },
        lane: { kind: 'checkout-branch', taskBranch: { kind: 'existing', branch: 'feature/dead' } },
      });
    }
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockClear();
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb',
      name: 'test/repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
    (core.generateAndSetTitle as ReturnType<typeof mock>).mockClear();
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockClear();
    mockResolveFolderBackend.mockClear();
    const spawn = spyOn(Bun, 'spawn');
    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'credential-run', 'go', {
          detach,
          ...(adopt ? { adoptRunId: adoptedRunId } : {}),
        })
      ).rejects.toThrow(
        `Credential preflight failed for provider '${adopt ? 'codex' : 'claude'}' (vendor '${adopt ? 'openai' : 'anthropic'}'): credential cannot be used: stored credential unreadable`
      );
      expect(codebases.findCodebaseByDefaultCwd).toHaveBeenCalledTimes(1);
      expect(isolation.getIsolationProvider).not.toHaveBeenCalled();
      expect(mockResolveFolderBackend).not.toHaveBeenCalled();
      expect(core.generateAndSetTitle).not.toHaveBeenCalled();
      expect(executeWorkflow).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      createDeps.mockRestore();
    }
  });

  it.each([false, true])(
    'a database-store worktree run with no native login is refused before its run row and worktree (detach: %p)',
    async detach => {
      const isolation = await import('@archon/isolation');
      const codebases = await import('@archon/core/db/codebases');
      mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'native-run', provider: 'claude' })],
        errors: [],
      });
      (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockClear();
      (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'cb',
        name: 'test/repo',
        default_cwd: '/test/path',
        kind: 'repo',
      });
      const host = createTestWorkflowHost();
      const original = host.deps.getAgentProvider;
      const check = mock(
        async (_request: Parameters<ReturnType<typeof original>['checkCredential']>[0]) => ({
          state: 'not_connected' as const,
          source: 'native' as const,
        })
      );
      host.deps.getAgentProvider = id => ({ ...original(id), checkCredential: check });
      (isolation.getIsolationProvider as ReturnType<typeof mock>).mockClear();
      mockCreateWorkflowRun.mockClear();
      const spawn = spyOn(Bun, 'spawn');
      try {
        await expect(
          workflowRunCommand(host, '/test/path', 'native-run', 'go', { detach })
        ).rejects.toThrow('no usable login');
        expect(check.mock.calls[0]?.[0]).toMatchObject({ cwd: '/test/path' });
        expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
        expect(codebases.findCodebaseByDefaultCwd).toHaveBeenCalledTimes(1);
        expect(isolation.getIsolationProvider).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        spawn.mockRestore();
      }
    }
  );
});

for (const selection of ['flag', 'workflow', 'config'] as const) {
  it(`container credential check (${selection} selection) uses the runner and destroys a refused fresh container`, async () => {
    const codebases = await import('@archon/core/db/codebases');
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockClear();
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'folder-cb',
      name: 'folder',
      default_cwd: '/test/path',
      kind: 'folder',
      default_branch: null,
    });
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'container-auth',
          provider: 'claude',
          nodes: [{ id: 'ai', prompt: 'hello' }],
          ...(selection === 'workflow' ? { container: { enabled: true } } : {}),
        }),
      ],
      errors: [],
    });
    mockFolderBackendPrepare.mockImplementationOnce(async () => ({
      cwd: '/runner',
      execContext: { kind: 'container', containerId: 'runner-id' },
      envId: 'container-env-auth',
      overlayMode: 'fuse',
    }));
    const host = createTestWorkflowHost();
    if (selection === 'config') {
      const loadConfig = host.deps.loadConfig;
      host.deps.loadConfig = async cwd => ({
        ...(await loadConfig(cwd)),
        container: { enabled: true },
      });
    }
    const original = host.deps.getAgentProvider;
    const check = mock(
      async (_request: Parameters<ReturnType<typeof original>['checkCredential']>[0]) => ({
        state: 'not_connected' as const,
        source: 'native' as const,
      })
    );
    host.deps.getAgentProvider = id => ({ ...original(id), checkCredential: check });
    mockFolderBackendDestroy.mockClear();
    await expect(
      workflowRunCommand(
        host,
        '/test/path',
        'container-auth',
        'go',
        selection === 'flag' ? { container: true } : { noWorktree: true }
      )
    ).rejects.toThrow('no usable login');
    expect(codebases.findCodebaseByDefaultCwd).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]?.[0]).toMatchObject({
      cwd: '/runner',
      execContext: { kind: 'container', containerId: 'runner-id' },
    });
    expect(mockFolderBackendDestroy).toHaveBeenCalledWith('container-env-auth');
  });
}
