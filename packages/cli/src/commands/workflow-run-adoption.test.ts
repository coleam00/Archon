import { capturedSourceRoots } from '@archon/workflows/run-source';
import {
  mockGetCurrentBranchStrict,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { prepareWorkflowSource } from '@archon/workflows/run-source';
import type * as WorkflowRunSource from '@archon/workflows/run-source';
import type { AdoptionLane } from '@archon/core/operations/workflow-adoption';
import { toBranchName } from '@archon/git';

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';

const git = await import('@archon/git');

describe('workflowRunCommand — adopt lane source recapture (#2660/#2747)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  const trackTempRoot = trackTempRoots();

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  function adoptedEnvironment(): import('@archon/isolation').IsolationEnvironmentRow {
    return {
      id: 'env-9',
      codebase_id: 'cb-adopt',
      workflow_type: 'task',
      workflow_id: 'adopt',
      provider: 'worktree',
      working_path: '/wt/adopted',
      branch_name: 'feature/adopted',
      status: 'active',
      metadata: {},
      created_at: new Date('2026-01-01'),
      created_by_platform: 'cli',
      created_by_user_id: null,
    };
  }

  function setupAdoptMocks(
    lane: Exclude<AdoptionLane, { kind: 'in-place' }> = {
      kind: 'reuse-worktree',
      environment: adoptedEnvironment(),
    }
  ): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    const prepareMock = require('@archon/workflows/run-source').prepareWorkflowSource as ReturnType<
      typeof mock
    >;
    discoverMock.mockReset();
    prepareMock.mockClear();
    // First discovery runs against the invoking checkout; the second must run against
    // the adopted lane's worktree and resolve the branch's vintage of the workflow.
    discoverMock
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Parent vintage' })],
        errors: [],
      })
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Branch vintage' })],
        errors: [],
      });

    const conversationDb = require('@archon/core/db/conversations');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-adopt',
      platform_type: 'cli',
      platform_conversation_id: 'cli-adopt',
      title: null,
      is_active: true,
      codebase_id: null,
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValue(undefined);
    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-adopt',
      name: 'test-repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });

    if (lane.kind === 'reuse-worktree') {
      (
        require('@archon/core/db/isolation-environments').getById as ReturnType<typeof mock>
      ).mockResolvedValueOnce({
        ...lane.environment,
      });
    }
    const adoption = require('@archon/core/operations/workflow-adoption');
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockResolvedValueOnce({
      adoptedRun: { id: 'run-old' },
      lane,
    });
  }

  // Keep source-capture I/O real: equal run IDs replace one physical directory.
  // This exposes cleanup deleting the replacement even with the executor mocked.
  async function stageRealCapture(
    tempRoot: string,
    opts: { sourceRoot: string; runId?: string }
  ): Promise<WorkflowRunSource.PreparedWorkflowSource> {
    const runId = opts.runId ?? randomUUID();
    const captureRoot = join(tempRoot, 'staged-source', runId);
    await removeTempTree(captureRoot);
    mkdirSync(captureRoot, { recursive: true });
    const anchor = {
      root: captureRoot,
      digest: `digest-${opts.sourceRoot}`,
      config: { load_default_workflows: true, load_default_commands: true },
    };
    const manifest = {
      version: 1 as const,
      engine_version: 'test',
      origin: opts.sourceRoot,
      captured_at: new Date().toISOString(),
      digest: anchor.digest,
      file_count: 0,
      byte_count: 0,
      scopes: [],
      source_config: anchor.config,
    };
    writeFileSync(join(captureRoot, 'manifest.json'), JSON.stringify(manifest));
    const roots = capturedSourceRoots(anchor);
    return { runId, origin: opts.sourceRoot, manifest, anchor, roots };
  }

  it('adopts a normal run from a unique short run id prefix', async () => {
    const adoptedRunId = '0b1ee8da-1111-2222-3333-444455556666';
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockClear();
    setupAdoptMocks();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-adopt',
      name: 'test-folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: adoptedRunId },
    ]);

    await workflowRunCommand(createTestWorkflowHost(), '/test/path/subdir', 'assist', 'hello', {
      adoptRunId: '0b1ee8da',
    });

    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-adopt');
    expect(adoption.resolveWorkflowAdoption).toHaveBeenCalledWith(
      expect.objectContaining({ adoptedRunId })
    );
  });

  it('rejects an ambiguous adopted run prefix with its candidates', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockClear();
    setupAdoptMocks();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-adopt',
      name: 'test-repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        adoptRunId: '0b1ee8da',
      })
    ).rejects.toThrow(
      '0b1ee8da-1111-2222-3333-444455556666\n  0b1ee8da-9999-8888-7777-666655554444'
    );
    expect(adoption.resolveWorkflowAdoption).not.toHaveBeenCalled();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockReset();
  });

  it('passes a full adopted run id through unchanged', async () => {
    const adoptedRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockClear();
    setupAdoptMocks();

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: adoptedRunId,
    });

    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(adoption.resolveWorkflowAdoption).toHaveBeenCalledWith(
      expect.objectContaining({ adoptedRunId })
    );
  });

  const adoptionRefusals = ['missing', 'mismatched', 'replaced', 'switched', 'detached'] as const;
  function refusedEnvironment(reason: (typeof adoptionRefusals)[number]) {
    if (reason === 'missing') return null;
    const environment = adoptedEnvironment();
    if (reason === 'replaced') environment.metadata = { worktree_registration_id: 'replacement' };
    if (reason === 'mismatched') environment.working_path = '/foreign/worktree';
    return environment;
  }

  it.each([...adoptionRefusals])(
    'refuses a %s adoption environment before lane capture or execution',
    async reason => {
      setupAdoptMocks();
      const isolationDb = await import('@archon/core/db/isolation-environments');
      const getById = isolationDb.getById as ReturnType<typeof mock>;
      getById.mockReset();
      if (reason === 'switched' || reason === 'detached') {
        mockGetCurrentBranchStrict.mockResolvedValueOnce(reason === 'switched' ? 'other' : null);
      }
      getById.mockResolvedValueOnce(refusedEnvironment(reason));
      (isolationDb.updateMetadata as ReturnType<typeof mock>).mockClear();
      const { executeWorkflow } = await import('@archon/workflows/executor');
      (executeWorkflow as ReturnType<typeof mock>).mockClear();
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          adoptRunId: 'run-old',
        })
      ).rejects.toThrow(
        reason === 'missing'
          ? 'Isolation environment env-9 not found'
          : reason === 'replaced'
            ? 'changed during adoption'
            : reason === 'switched' || reason === 'detached'
              ? 'expected branch'
              : 'does not match'
      );
      expect(executeWorkflow).not.toHaveBeenCalled();
      expect(isolationDb.updateMetadata).not.toHaveBeenCalled();
      const captures = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls;
      expect(
        captures.every(call => (call[1] as { sourceRoot: string }).sourceRoot === '/test/path')
      ).toBe(true);
    }
  );

  it('re-freezes workflow source from the inherited worktree on the reuse-worktree lane', async () => {
    setupAdoptMocks();
    const isolationDb = await import('@archon/core/db/isolation-environments');
    (isolationDb.updateMetadata as ReturnType<typeof mock>).mockClear();
    const { executeWorkflow } = await import('@archon/workflows/executor');

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: 'run-old',
    });

    const prepareCalls = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls;
    expect(prepareCalls).toHaveLength(2);
    expect((prepareCalls[0][1] as { sourceRoot: string }).sourceRoot).toBe('/test/path');
    expect((prepareCalls[1][1] as { sourceRoot: string }).sourceRoot).toBe('/wt/adopted');
    // The executor receives the branch-vintage graph, not the parent checkout's.
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1) as unknown[];
    expect((executed[4] as { description: string }).description).toBe('Branch vintage');
    expect(executed[3]).toBe('/wt/adopted');
    expect((isolationDb.updateMetadata as ReturnType<typeof mock>).mock.calls).toEqual([
      [
        'env-9',
        {
          adopted: true,
          worktree_registration_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          ),
        },
        expect.objectContaining({ id: 'env-9' }),
      ],
    ]);
  });

  it('checks out the exact adopted branch when the prior worktree is gone', async () => {
    setupAdoptMocks({
      kind: 'checkout-branch',
      taskBranch: { kind: 'existing', branch: toBranchName('feature/live-pr') },
    });
    const isolation = await import('@archon/isolation');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const create = mock(() =>
      Promise.resolve({
        provider: 'worktree' as const,
        id: '/wt/recreated',
        workingPath: '/wt/recreated',
        branchName: 'feature/live-pr',
        status: 'active' as const,
        createdAt: new Date(),
        metadata: { provenance: 'adopted', adopted: true },
      })
    );
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockReturnValueOnce({
      create,
      healthCheck: mock(() => Promise.resolve(true)),
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: 'run-old',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: 'task',
        taskBranch: { kind: 'existing', branch: toBranchName('feature/live-pr') },
      }),
      expect.any(Function)
    );
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1) as unknown[];
    expect(executed[3]).toBe('/wt/recreated');
    const opts = executed.at(-1) as { adoptedFromRunId?: string };
    expect(opts.adoptedFromRunId).toBe('run-old');
  });

  it('preserves an explicit source when adoption recreates the prior branch checkout', async () => {
    setupAdoptMocks({
      kind: 'checkout-branch',
      taskBranch: { kind: 'existing', branch: toBranchName('feature/live-pr') },
    });
    const isolation = await import('@archon/isolation');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockReturnValueOnce({
      create: mock(() =>
        Promise.resolve({
          provider: 'worktree' as const,
          id: '/wt/recreated',
          workingPath: '/wt/recreated',
          branchName: 'feature/live-pr',
          status: 'active' as const,
          createdAt: new Date(),
          metadata: { provenance: 'adopted', adopted: true },
        })
      ),
      healthCheck: mock(() => Promise.resolve(true)),
    });

    // Explicit selection matters even when it names the invoking checkout.
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: 'run-old',
      discoveryCwd: '/test/path',
    });

    expect(prepareWorkflowSource).toHaveBeenCalledTimes(1);
    expect(prepareWorkflowSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceRoot: '/test/path' })
    );
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1) as unknown[];
    expect(executed[3]).toBe('/wt/recreated');
    expect((executed[4] as { description: string }).description).toBe('Parent vintage');
  });

  it('re-judges the declared-input gate against the branch vintage after recapture', async () => {
    // The parent checkout's YAML declares no inputs, so the invocation gate on entry
    // passes an input-less call; only the adopted branch's YAML requires one.
    setupAdoptMocks();
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockReset();
    discoverMock
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Parent vintage' })],
        errors: [],
      })
      .mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({
            name: 'assist',
            description: 'Branch vintage',
            inputs: { diff: { required: true } },
          }),
        ],
        errors: [],
      });
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        adoptRunId: 'run-old',
      })
    ).rejects.toThrow(/requires input/);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it(
    'preserves the replacement capture when a detached child recaptures onto its own ' +
      'pre-created run id (real files, #3217)',
    async () => {
      // Both capture calls use the detached child's pre-created run ID.
      setupAdoptMocks();
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-detached-child',
        metadata: { cli_detached_launch_token: 'launch-token' },
        workflow_name: 'assist',
        status: 'pending',
      });
      const prepareMock = prepareWorkflowSource as ReturnType<typeof mock>;

      const tempRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-recapture-same-root-')));
      // Matches the mocked DETACHED_RUN_OWNER_ENV value the SUT reads from
      // '../utils/detached-run-control' (mocked at the top of this file).
      const ownerEnvVar = 'ARCHON_DETACHED_RUN_OWNER';
      const previousOwnerEnv = process.env[ownerEnvVar];
      process.env[ownerEnvVar] = '1';
      process.env.ARCHON_DETACHED_LAUNCH_TOKEN = 'launch-token';
      try {
        prepareMock
          .mockImplementationOnce((_deps: unknown, opts: { sourceRoot: string; runId?: string }) =>
            stageRealCapture(tempRoot, opts)
          )
          .mockImplementationOnce((_deps: unknown, opts: { sourceRoot: string; runId?: string }) =>
            stageRealCapture(tempRoot, opts)
          );

        await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          adoptRunId: 'run-old',
          detachedRunId: 'run-detached-child',
        });

        const calls = prepareMock.mock.calls;
        expect(calls).toHaveLength(2);
        expect((calls[0][1] as { runId?: string }).runId).toBe('run-detached-child');
        expect((calls[1][1] as { runId?: string }).runId).toBe('run-detached-child');

        const replacementRoot = join(tempRoot, 'staged-source', 'run-detached-child');
        const manifestPath = join(replacementRoot, 'manifest.json');
        // The assertion the old code fails: the recapture's own cleanup deleted this
        // file right after writing it, because stale.anchor.root === replacement's.
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { origin: string };
        expect(manifest.origin).toBe('/wt/adopted');
      } finally {
        if (previousOwnerEnv === undefined) delete process.env[ownerEnvVar];
        else process.env[ownerEnvVar] = previousOwnerEnv;
      }
    }
  );

  it('still cleans up the superseded staged capture when the replacement lands at a different root', async () => {
    // Ordinary adoption uses separate roots and must reclaim the first capture.
    setupAdoptMocks();
    const prepareMock = prepareWorkflowSource as ReturnType<typeof mock>;

    const tempRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-recapture-distinctroot-')));
    const capturedRoots: string[] = [];
    prepareMock
      .mockImplementationOnce(
        async (_deps: unknown, opts: { sourceRoot: string; runId?: string }) => {
          const prepared = await stageRealCapture(tempRoot, opts);
          capturedRoots.push(prepared.anchor.root);
          return prepared;
        }
      )
      .mockImplementationOnce(
        async (_deps: unknown, opts: { sourceRoot: string; runId?: string }) => {
          const prepared = await stageRealCapture(tempRoot, opts);
          capturedRoots.push(prepared.anchor.root);
          return prepared;
        }
      );

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: 'run-old',
    });

    expect(capturedRoots).toHaveLength(2);
    const [originalRoot, replacementRoot] = capturedRoots;
    expect(originalRoot).not.toBe(replacementRoot);
    // The superseded original is reclaimed...
    expect(existsSync(originalRoot as string)).toBe(false);
    // ...and the replacement it was superseded BY survives.
    expect(existsSync(join(replacementRoot as string, 'manifest.json'))).toBe(true);
  });
});
