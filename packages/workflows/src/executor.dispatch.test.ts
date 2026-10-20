// @archon-test-isolated
import { WorkflowStatusReadError } from './workflow-status-read';
import {
  configWith,
  containerBackend,
  dagCall,
  logged,
  makeDeps,
  makePlatform,
  makeRun,
  makeStore,
  mockCaptureWorkflowInvoked,
  mockExecuteDagWorkflow,
  mockGetDefaultBranch,
  repoCodebase,
  resetExecutorMocks,
  resumeOf,
  sentMessages,
  startWorkflow,
} from './executor/test-utils';
import { removeTempTree } from '@archon/paths/test-utils';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'path';
import type { ExecuteWorkflowOptions } from './executor';
import { resolveWorkflow } from './graph-plan';
import {
  RUN_DISPATCH_METADATA_KEY,
  readRunDispatchMetadata,
  workflowDefinitionSchema,
} from './schemas';
import { keepAwake } from './utils/keep-awake';

/** What a run resolves before it starts: refusals, the container guard, $BASE_BRANCH and $DOCS_DIR. */

beforeEach(resetExecutorMocks);

const parsedWorkflow = (definition: object) =>
  resolveWorkflow(workflowDefinitionSchema.parse(definition));

describe('refusals before any side effect', () => {
  it('rejects a structurally valid but semantically invalid outcome declaration', async () => {
    const store = makeStore();
    const deps = makeDeps(store);
    const workflow = parsedWorkflow({
      name: 'invalid-authored-outcome',
      description: 'missing selected return node',
      outcome_field: 'green',
      nodes: [{ id: 'node1', prompt: 'Do something' }],
    });
    await expect(startWorkflow({ deps, workflow, cwd: '/tmp/ops' })).rejects.toThrow(
      'without returns:'
    );
    expect(store.createWorkflowRun).not.toHaveBeenCalled();
    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a budgeted workflow whose loop the run budget cannot count', async () => {
    const store = makeStore();
    const workflow = parsedWorkflow({
      name: 'budgeted-loop',
      description: 'loop under a run budget',
      budget: { max_work_units: 5 },
      nodes: [{ id: 'spin', loop: { until: 'done', max_iterations: 2, prompt: 'p' } }],
    });
    await expect(startWorkflow({ store, workflow, cwd: '/tmp/ops' })).rejects.toThrow(
      "node 'spin' is a loop node"
    );
    expect(store.createWorkflowRun).not.toHaveBeenCalled();
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  // The guard keys on "is this a fresh dispatch", not on who wrote the row: a row
  // pre-created by a launching process (#2872, `--detach`) is still a fresh dispatch.
  it.each([
    ['a fresh run', {}],
    [
      'a pre-created fresh row',
      { preCreatedRun: makeRun({ id: 'pending-run', status: 'pending' }) },
    ],
  ])('refuses a container durable wait on %s before creating a run', async (_label, options) => {
    const store = makeStore();
    await expect(
      startWorkflow({
        store,
        cwd: '/tmp/ops',
        workflow: parsedWorkflow({
          name: 'container-wait',
          description: 'unsupported durable wait in container isolation',
          nodes: [{ id: 'delay', wait: { duration_ms: 1000 } }],
        }),
        options: { ...options, execContext: { kind: 'container', containerId: 'cid' } },
      })
    ).rejects.toThrow('durable wait, which is not supported in container isolation');
    expect(store.createWorkflowRun).not.toHaveBeenCalled();
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });
});

describe('container resume guard', () => {
  const containerRun = (id: string, overrides: Parameters<typeof makeRun>[0] = {}) =>
    makeRun({
      id,
      ...overrides,
      metadata: { isolation: 'container', isolation_env_id: 'env-x', ...overrides.metadata },
    });
  const inContainer = (): ExecuteWorkflowOptions => ({
    execContext: { kind: 'container', containerId: 'cid' },
    container: { envId: 'env-x', writeBack: 'approve', backend: containerBackend() },
  });

  it('fails a container run resumed without a container context, pointing at the CLI', async () => {
    const store = makeStore();
    const result = await startWorkflow({
      store,
      cwd: '/tmp/ops',
      options: resumeOf(containerRun('crun'), [['node1', { output: 'out' }]]),
    });
    if (result.success) throw new Error('Expected missing-container-context failure');
    expect(result.error).toMatch(/executed inside an isolation container/);
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  it('proceeds when the container context is provided', async () => {
    const result = await startWorkflow({
      cwd: '/tmp/ops',
      options: {
        ...resumeOf(containerRun('crun2'), [['node1', { output: 'out' }]]),
        priorUsage: { tokens: { input: 40, output: 4 }, costUsd: 0.5 },
        ...inContainer(),
      },
    });
    expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
    expect(dagCall()?.priorUsage).toEqual({ tokens: { input: 40, output: 4 }, costUsd: 0.5 });
    expect(result.success).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'propagates an unreadable row while reconciling a refused source release',
    async () => {
      const captureRoot = await mkdtemp(join(tmpdir(), 'archon-unreadable-reconcile-'));
      const cause = new Error('Unsupported persisted status');
      const store = makeStore({
        releaseRunForUnreadableSource: mock(async () => ({ released: false })),
        getWorkflowRun: mock(async () => {
          throw new WorkflowStatusReadError('corrupt', cause);
        }),
      });
      const platform = makePlatform();
      const run = makeRun({
        metadata: {
          workflow_source: {
            version: 1,
            root: captureRoot,
            origin: captureRoot,
            captured_at: new Date().toISOString(),
            digest: 'unread',
            file_count: 0,
            byte_count: 0,
          },
        },
      });
      await chmod(captureRoot, 0o000);
      try {
        await expect(
          startWorkflow({ store, platform, cwd: '/tmp/ops', options: resumeOf(run) })
        ).rejects.toMatchObject({ name: 'WorkflowStatusReadError', cause });
      } finally {
        await chmod(captureRoot, 0o755);
        await removeTempTree(captureRoot);
      }
      expect(store.releaseRunForUnreadableSource).toHaveBeenCalledTimes(1);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.cancelWorkflowRun).not.toHaveBeenCalled();
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
      expect(sentMessages(platform).some(message => /failed/i.test(message))).toBe(false);
    }
  );

  describe.each([
    ['no adoption', undefined],
    ['an adopted run with no output root', null],
    ['an adopted run with an out-of-tree output root', '/old-machine/.archon/workspaces/old/name'],
  ] as const)('unreadable container source with %s', (_label, outputRoot) => {
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'refuses invalid adoption before releasing the run for unreadable source',
      async () => {
        const captureRoot = await mkdtemp(join(tmpdir(), 'archon-unreadable-capture-'));
        const release = mock(async () => ({ released: true }));
        const store = makeStore({
          releaseRunForUnreadableSource: release,
          getWorkflowRun: mock(async () => makeRun({ output_root: outputRoot ?? null })),
        });
        const platform = makePlatform();
        const preCreatedRun = containerRun('crun3', {
          adopted_from_run_id: outputRoot === undefined ? null : 'prior-run',
          metadata: {
            workflow_source: {
              version: 1,
              root: captureRoot,
              origin: captureRoot,
              captured_at: new Date().toISOString(),
              digest: 'unread',
              file_count: 0,
              byte_count: 0,
            },
          },
        });
        await chmod(captureRoot, 0o000);
        try {
          const result = await startWorkflow({
            store,
            platform,
            cwd: '/tmp/ops',
            options: {
              ...resumeOf(preCreatedRun, [['node1', { output: 'out' }]]),
              ...inContainer(),
            },
          });
          if (outputRoot === undefined) {
            expect(result).toMatchObject({ success: true, paused: true });
          } else {
            expect(result).toMatchObject({
              success: false,
              error: expect.stringContaining("Cannot adopt run 'prior-run'"),
            });
            expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
            expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
            expect(keepAwake.activeCount()).toBe(0);
          }
        } finally {
          await chmod(captureRoot, 0o755);
          await removeTempTree(captureRoot);
        }
        expect(release).toHaveBeenCalledTimes(outputRoot === undefined ? 1 : 0);
        const sent = sentMessages(platform);
        expect(sent.some(text => text.includes('resume it by hand'))).toBe(
          outputRoot === undefined
        );
        expect(sent.some(text => text.includes('continuation scan'))).toBe(false);
      }
    );
  });
});

describe('docsDir resolution', () => {
  it.each([
    ['docs/ by default', undefined, 'docs/'],
    [
      'the configured docsPath',
      'packages/docs-web/src/content/docs',
      'packages/docs-web/src/content/docs',
    ],
  ])('passes %s', async (_label, docsPath, expected) => {
    await startWorkflow({ deps: { ...makeDeps(), loadConfig: configWith({ docsPath }) } });
    expect(dagCall()?.docsDir).toBe(expected);
  });
});

describe('base branch resolution ($BASE_BRANCH)', () => {
  const inWorktree = (options: ExecuteWorkflowOptions, configBaseBranch?: string) =>
    startWorkflow({
      deps: {
        ...makeDeps(),
        ...(configBaseBranch ? { loadConfig: configWith({ baseBranch: configBaseBranch }) } : {}),
      },
      cwd: '/tmp/worktree',
      options,
    });
  const recorded = (base_branch: string) =>
    makeRun({ metadata: { [RUN_DISPATCH_METADATA_KEY]: { base_branch } } });

  it.each(['checkout-base', ''])(
    'uses the caller-resolved base %p ahead of config',
    async resolvedBaseBranch => {
      await inWorktree({ resolvedBaseBranch }, 'configured');
      expect(mockGetDefaultBranch).not.toHaveBeenCalled();
      expect(dagCall()?.baseBranch).toBe(resolvedBaseBranch);
    }
  );

  // The per-dispatch `--base` override ranks above repo config. Otherwise a repo that sets
  // `worktree.baseBranch` would cut its worktree from the override but report the
  // configured branch as $BASE_BRANCH, and target `gh pr create --base` at the wrong one.
  it.each([
    [
      'the caller branch when repo config is unset',
      { baseBranch: 'develop' },
      undefined,
      'develop',
    ],
    ['repo config over the caller branch', { baseBranch: 'develop' }, 'main', 'main'],
    [
      'baseOverride over repo config',
      { baseBranch: 'develop', baseOverride: 'epic/foo' },
      'main',
      'epic/foo',
    ],
  ] as const)('uses %s without git auto-detection', async (_label, options, config, expected) => {
    // Auto-detect would throw — every explicit source must short-circuit before it.
    mockGetDefaultBranch.mockImplementation(async () => {
      throw new Error('Cannot detect default branch: neither origin/HEAD nor origin/main exist');
    });
    await inWorktree(options, config);
    expect(mockGetDefaultBranch).not.toHaveBeenCalled();
    expect(dagCall()?.baseBranch).toBe(expected);
  });

  it.each([
    ['no codebase', undefined],
    ['a repo-kind codebase', 'cb-repo'],
  ])('falls back to git auto-detection for %s', async (_label, codebaseId) => {
    await startWorkflow({
      store: makeStore(codebaseId ? { getCodebase: mock(async () => repoCodebase) } : {}),
      cwd: '/tmp/worktree',
      options: { codebaseId },
    });
    expect(mockGetDefaultBranch).toHaveBeenCalledWith('/tmp/worktree', 'origin');
    expect(dagCall()?.baseBranch).toBe('main');
  });

  it('skips git auto-detection for a folder-kind codebase, no ERROR/WARN spam (#2159)', async () => {
    const store = makeStore({
      getCodebase: mock(async () => ({
        id: 'cb-folder',
        name: 'Ops Root',
        repository_url: null,
        default_cwd: '/tmp/ops',
        kind: 'folder' as const,
      })),
    });
    await startWorkflow({ store, cwd: '/tmp/ops', options: { codebaseId: 'cb-folder' } });
    // A non-git root never shells out to git, so $BASE_BRANCH resolves to empty
    // (unresolved-but-not-referenced) without the benign auto-detect warning.
    expect(mockGetDefaultBranch).not.toHaveBeenCalled();
    expect(dagCall()?.baseBranch).toBe('');
    expect(logged('workflow.base_branch_auto_detect_failed')).toEqual([]);
  });

  it('records what it resolved on the fresh run row (#2454)', async () => {
    const store = makeStore();
    await startWorkflow({
      store,
      cwd: '/tmp/worktree',
      options: { baseBranch: 'develop', source: 'bundled' },
    });
    const created = (store.createWorkflowRun as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown>;
    };
    expect(readRunDispatchMetadata(created.metadata)).toEqual({
      base_branch: 'develop',
      source: 'bundled',
    });
  });

  // The gate-resumed half of a run must answer $BASE_BRANCH the way its first half did,
  // though repo config and the caller's codebase default changed since the start. Empty is
  // a resolved answer, not a missing one: folder projects and repos where auto-detection
  // failed record it, so the restore must branch on the record's presence, not its value.
  it.each(['release-2026', ''])(
    'a continuation keeps the recorded base branch %p over the current environment (#2454)',
    async baseBranch => {
      await inWorktree(
        {
          ...resumeOf(recorded(baseBranch)),
          baseBranch: 'develop',
          resolvedBaseBranch: 'new-checkout-base',
        },
        'main'
      );
      expect(mockGetDefaultBranch).not.toHaveBeenCalled();
      expect(dagCall()?.baseBranch).toBe(baseBranch);
    }
  );

  // `--base` on a resume is a deliberate act by whoever is resuming; the record restores
  // what was dropped, it does not overrule what this invocation asked for.
  it('a resume that re-passes --base still retargets $BASE_BRANCH (#2454)', async () => {
    await inWorktree({
      ...resumeOf(recorded('release-2026')),
      baseOverride: 'hotfix/urgent',
      resolvedBaseBranch: 'new-checkout-base',
    });
    expect(dagCall()?.baseBranch).toBe('hotfix/urgent');
  });

  // A CLI `--resume` re-resolves a source and passes it in; adopting it would report a
  // guess as the run's original attribution.
  it('a continuation whose record holds no source keeps it absent instead of adopting a live one (#2454)', async () => {
    await inWorktree({ ...resumeOf(recorded('release-2026')), source: 'bundled' });
    expect(mockCaptureWorkflowInvoked).toHaveBeenCalledTimes(1);
    expect(mockCaptureWorkflowInvoked.mock.calls[0]?.[0].workflowSource).toBeUndefined();
  });

  // A run started before the record existed re-resolves, but silently doing so is what let
  // $BASE_BRANCH change value mid-run unnoticed.
  it('reports a continuation that has nothing recorded to restore (#2454)', async () => {
    await inWorktree(resumeOf(makeRun()));
    expect(dagCall()?.baseBranch).toBe('main');
    expect(logged('workflow.dispatch_not_recorded_resolving_live')).toHaveLength(1);
  });
});
