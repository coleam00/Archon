import { beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { makeTestResolvedWorkflow, makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { WORKFLOW_SOURCE_METADATA_KEY } from '@archon/workflows/schemas/workflow-run';
import { toBranchName } from '@archon/git';
import {
  makeCodebase,
  makeDispatchConversation,
  makeForegroundPlatform,
  makeIsolationEnvironment,
  makePlatform,
  makeResumableRun,
  mockAdoptedEnvironment,
  mockAdoptionMetadata,
  mockCloseRunLiveOwner,
  mockDiscoverWorkflowsWithConfig,
  mockDispatchBackgroundWorkflow,
  mockExecuteWorkflow,
  mockFailPreparedRun,
  mockFindResumableRunByParentConversation,
  mockGetCodebase,
  mockGetCurrentBranchStrict,
  mockGetOrCreateConversation,
  mockHandleCommand,
  mockHydrateResumableRun,
  mockLogger,
  mockPrepareWorkflowSource,
  mockResolveWorkflowAdoption,
  mockResolveWorkflowSourceRoot,
  mockStartRunLiveOwner,
  mockUpdateConversation,
  mockValidateAndResolveIsolation,
  operator,
  resetDispatchMocks,
} from '../../test/orchestrator-agent-harness';
import { handleMessage } from '../orchestrator-agent';

export function setupRoutingTests() {
  function makeWorkflowResult(
    options: {
      force?: boolean;
      resumeRun?: WorkflowRun;
      args?: string;
      /** Declared `inputs:` on the resolved workflow (#2554). */
      inputs?: Record<string, { required?: boolean; default?: string }>;
    } = {}
  ) {
    return {
      success: true,
      message: 'ok',
      workflow: options.resumeRun
        ? { kind: 'resume' as const, run: options.resumeRun }
        : {
            kind: 'start' as const,
            definition: makeTestResolvedWorkflow({
              name: 'test-workflow',
              ...(options.inputs ? { inputs: options.inputs } : {}),
            }),
            args: options.args ?? 'test message',
            force: options.force,
          },
    };
  }

  beforeEach(resetDispatchMocks);

  /** Drive a refused resume (a lost race by default) with an optional supplied-input map. */
  async function dispatchLosingResumeRace(
    platform: ReturnType<typeof makePlatform>,
    workflowInputs?: Record<string, string>,
    refusal?: Error
  ): Promise<void> {
    // `mock.module` MERGES, so `WorkflowNotResumableError` is the real class here.
    const { WorkflowNotResumableError } = await import('../../db/workflows');
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'raced-run-1',
          working_path: '/repos/test-repo/worktrees/paused',
          status: 'paused',
        })
      )
    );
    mockHydrateResumableRun.mockReturnValueOnce(
      Promise.reject(refusal ?? new WorkflowNotResumableError('raced-run-1', 'running'))
    );
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      ...(workflowInputs ? { workflowInputs } : {}),
    });
  }
  return {
    makeWorkflowResult,
    dispatchLosingResumeRace,
  };
}

export function registerAdoptionTests(fixture: ReturnType<typeof setupRoutingTests>) {
  test('a terminal status write failure during worktree preparation is not retried', async () => {
    const { IsolationBlockedError } = await import('@archon/isolation');
    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    mockHandleCommand.mockResolvedValueOnce(fixture.makeWorkflowResult());
    mockValidateAndResolveIsolation.mockRejectedValueOnce(
      new IsolationBlockedError('setup failed', 'creation_failed')
    );
    mockFailPreparedRun.mockRejectedValueOnce(new Error('database write unavailable'));
    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });
    expect(mockFailPreparedRun).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockCloseRunLiveOwner).toHaveBeenCalledTimes(1);
  });

  test('calls executeWorkflow (not dispatchBackground) on a foreground-default adapter', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(
      Promise.resolve(makeCodebase({ default_branch: 'develop' }))
    );
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('prepared-run-id');
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    const opts = callArgs[callArgs.length - 1] as {
      baseBranch?: string;
    };
    expect(callArgs[6]).toMatchObject({
      conversationId: 'conv-1-db',
      parentConversationId: 'conv-1-db',
    });
    // The codebase's stored default branch rides along as the $BASE_BRANCH fallback.
    expect(opts.baseBranch).toBe('develop');
  });

  // Adoption lane on the FOREGROUND dispatch (#2747 review): the background path
  // inherits the adopted estate; the foreground path must honor it too.
  test('adopt with reuse-worktree lane runs the foreground dispatch in the adopted worktree', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ args: 'test message' }))
    );
    mockResolveWorkflowAdoption.mockImplementationOnce(() =>
      Promise.resolve({
        adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
        lane: {
          kind: 'reuse-worktree',
          environment: makeIsolationEnvironment({ working_path: '/wt/adopted' }),
        },
      })
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowAdoptRunId: 'prior-run',
    });

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
    expect(mockAdoptionMetadata).toHaveBeenCalledWith(
      'env-1',
      {
        adopted: true,
        worktree_registration_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
      },
      expect.objectContaining({ id: 'env-1' })
    );
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('/wt/adopted');
    const opts = callArgs[callArgs.length - 1] as {
      adoptedFromRunId?: string;
      continuationMode?: string;
    };
    expect(opts.adoptedFromRunId).toBe('prior-run');
    expect(opts.continuationMode).toBe('adopt');
    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1-db', {
      cwd: '/wt/adopted',
      isolation_env_id: 'env-1',
    });
  });

  test('background adoption leaves recording to dispatch', async () => {
    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    mockHandleCommand.mockResolvedValueOnce(fixture.makeWorkflowResult());
    const lane = {
      kind: 'reuse-worktree' as const,
      environment: makeIsolationEnvironment({ working_path: '/wt/adopted' }),
    };
    mockResolveWorkflowAdoption.mockResolvedValueOnce({
      adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
      lane,
    });
    mockAdoptionMetadata.mockClear();
    mockLogger.warn.mockClear();
    let recordedByDispatcher = false;
    mockDispatchBackgroundWorkflow.mockImplementationOnce(async ctx => {
      expect(mockAdoptionMetadata).not.toHaveBeenCalled();
      const { adoptRegisteredWorktree } = await import('../../operations/workflow-adoption');
      if (ctx.adoptionLane?.kind !== 'reuse-worktree') throw new Error('Missing reuse lane');
      await adoptRegisteredWorktree(
        { getById: mockAdoptedEnvironment, updateMetadata: mockAdoptionMetadata },
        ctx.adoptionLane,
        '/test/cwd'
      );
      recordedByDispatcher = true;
    });
    await handleMessage(makePlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowAdoptRunId: 'prior-run',
    });
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledTimes(1);
    expect(recordedByDispatcher).toBe(true);
    expect(mockAdoptionMetadata).toHaveBeenCalledTimes(1);
    expect(
      mockLogger.warn.mock.calls.filter(([, event]) => event === 'worktree_adopted')
    ).toHaveLength(1);
  });

  test.each([
    ['missing', null, 'Isolation environment env-1 not found', undefined],
    [
      'mismatched',
      makeIsolationEnvironment({ working_path: '/wt/from-branch' }),
      'does not match',
      undefined,
    ],
    [
      'replaced',
      makeIsolationEnvironment({
        working_path: '/wt/adopted',
        metadata: { worktree_registration_id: 'replacement' },
      }),
      'changed during adoption',
      undefined,
    ],
    [
      'switched',
      makeIsolationEnvironment({ working_path: '/wt/adopted' }),
      'expected branch',
      'other',
    ],
    [
      'detached',
      makeIsolationEnvironment({ working_path: '/wt/adopted' }),
      'expected branch',
      null,
    ],
  ] as const)(
    'foreground adoption refuses a %s environment before capture',
    async (_reason, environment, message, branch) => {
      mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
      mockGetCodebase.mockResolvedValueOnce(makeCodebase());
      mockHandleCommand.mockResolvedValueOnce(fixture.makeWorkflowResult());
      mockResolveWorkflowAdoption.mockResolvedValueOnce({
        adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
        lane: {
          kind: 'reuse-worktree',
          environment: makeIsolationEnvironment({ working_path: '/wt/adopted' }),
        },
      });
      if (branch !== undefined) mockGetCurrentBranchStrict.mockResolvedValueOnce(branch);
      mockAdoptedEnvironment.mockResolvedValueOnce(environment);
      mockPrepareWorkflowSource.mockClear();
      mockAdoptionMetadata.mockClear();
      mockLogger.warn.mockClear();
      const platform = makeForegroundPlatform();
      await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
        actor: operator,
        workflowAdoptRunId: 'prior-run',
      });
      expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', expect.stringContaining(message));
      expect(mockPrepareWorkflowSource).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(mockAdoptionMetadata).not.toHaveBeenCalled();
      expect(
        mockLogger.warn.mock.calls.filter(([, event]) => event === 'worktree_adopted')
      ).toHaveLength(0);
    }
  );

  test('adopt with checkout-branch lane materializes the exact adopted branch', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ args: 'test message' }))
    );
    mockResolveWorkflowAdoption.mockImplementationOnce(() =>
      Promise.resolve({
        adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
        lane: {
          kind: 'checkout-branch',
          taskBranch: { kind: 'existing', branch: toBranchName('feature/adopted') },
        },
      })
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowAdoptRunId: 'prior-run',
    });

    expect(mockValidateAndResolveIsolation).toHaveBeenCalled();
    const isoArgs = mockValidateAndResolveIsolation.mock.calls[0] as unknown[];
    const hints = isoArgs[4] as {
      workflowType?: string;
      taskBranch?: { kind: string; branch?: string };
    };
    expect(hints.workflowType).toBe('task');
    expect(hints.taskBranch).toEqual({ kind: 'existing', branch: 'feature/adopted' });
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    const opts = callArgs[callArgs.length - 1] as { adoptedFromRunId?: string };
    expect(opts.adoptedFromRunId).toBe('prior-run');
  });

  // R7: the resolver short-circuits on `existingEnvId` before hints are read, so a
  // checkout-branch adoption must neutralize the conversation's stale env and key
  // its reuse lookup with a unique per-dispatch workflow id.
  test('adopt checkout-branch ignores a stale isolation env and keys a unique worktree', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeDispatchConversation({ isolation_env_id: 'env-stale' }))
    );
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ args: 'test message' }))
    );
    mockResolveWorkflowAdoption.mockImplementationOnce(() =>
      Promise.resolve({
        adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
        lane: {
          kind: 'checkout-branch',
          taskBranch: { kind: 'existing', branch: toBranchName('feature/adopted') },
        },
      })
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowAdoptRunId: 'prior-run',
    });

    expect(mockValidateAndResolveIsolation).toHaveBeenCalled();
    const isoArgs = mockValidateAndResolveIsolation.mock.calls[0] as unknown[];
    const convArg = isoArgs[0] as { isolation_env_id?: string | null };
    expect(convArg.isolation_env_id).toBeNull();
    const hints = isoArgs[4] as {
      workflowId?: string;
      taskBranch?: { kind: string; branch?: string };
    };
    expect(hints.taskBranch).toEqual({ kind: 'existing', branch: 'feature/adopted' });
    expect(typeof hints.workflowId).toBe('string');
    expect(hints.workflowId!.length).toBeGreaterThan(0);
  });

  // R8: a reuse-worktree adoption executes inside the inherited worktree, so the
  // frozen source must come from there — not from the parent checkout.
  test('adopt with reuse-worktree captures workflow source from the inherited worktree', async () => {
    mockResolveWorkflowSourceRoot.mockResolvedValue('/canonical/repo');
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ args: 'test message' }))
    );
    mockResolveWorkflowAdoption.mockImplementationOnce(() =>
      Promise.resolve({
        adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
        lane: {
          kind: 'reuse-worktree',
          environment: makeIsolationEnvironment({ working_path: '/wt/adopted' }),
        },
      })
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowAdoptRunId: 'prior-run',
    });

    expect(mockPrepareWorkflowSource).toHaveBeenCalled();
    const lastCaptureCall = mockPrepareWorkflowSource.mock.calls.at(-1) as unknown[];
    const captureArg = lastCaptureCall[1] as {
      sourceRoot?: string;
    };
    expect(captureArg.sourceRoot).toBe('/wt/adopted');
    expect(mockResolveWorkflowSourceRoot).not.toHaveBeenCalledWith('/wt/adopted');
  });

  // R10: a checkout-branch adoption runs in a worktree on the adopted branch,
  // so its frozen source must come from that worktree — not from the parent checkout.
  test('adopt with checkout-branch captures workflow source from the created worktree', async () => {
    mockResolveWorkflowSourceRoot.mockResolvedValue('/canonical/repo');
    mockValidateAndResolveIsolation.mockImplementationOnce(() =>
      Promise.resolve({
        cwd: '/wt/from-branch',
        status: 'new',
        env: makeIsolationEnvironment(),
      })
    );
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ args: 'test message' }))
    );
    mockResolveWorkflowAdoption.mockImplementationOnce(() =>
      Promise.resolve({
        adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
        lane: {
          kind: 'checkout-branch',
          taskBranch: { kind: 'existing', branch: toBranchName('feature/adopted') },
        },
      })
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowAdoptRunId: 'prior-run',
    });

    expect(mockPrepareWorkflowSource).toHaveBeenCalled();
    const lastCaptureCall = mockPrepareWorkflowSource.mock.calls.at(-1) as unknown[];
    const captureArg = lastCaptureCall[1] as {
      sourceRoot?: string;
    };
    expect(captureArg.sourceRoot).toBe('/adopted/snapshot');
    expect(mockResolveWorkflowSourceRoot).not.toHaveBeenCalledWith('/wt/from-branch');
  });

  // The run row exists before the worktree, so its recorded source must be rewritten
  // with the created worktree as origin; the executor keeps a recorded source as-is.
  test('adopt with checkout-branch records the created worktree as the run source origin', async () => {
    const adapter = await import('../../workflows/store-adapter');
    const original = adapter.createWorkflowDeps();
    const updates: Array<Record<string, unknown>> = [];
    const factory = spyOn(adapter, 'createWorkflowDeps').mockImplementation(() => ({
      ...original,
      store: {
        ...original.store,
        updateWorkflowRun: async (_id: string, data: { metadata?: Record<string, unknown> }) => {
          if (data.metadata) updates.push(data.metadata);
        },
      },
    }));
    mockValidateAndResolveIsolation.mockImplementationOnce(() =>
      Promise.resolve({ cwd: '/wt/from-branch', status: 'new', env: makeIsolationEnvironment() })
    );
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ args: 'test message' }))
    );
    mockResolveWorkflowAdoption.mockImplementationOnce(() =>
      Promise.resolve({
        adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
        lane: {
          kind: 'checkout-branch',
          taskBranch: { kind: 'existing', branch: toBranchName('feature/adopted') },
        },
      })
    );
    try {
      await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
        actor: operator,
        workflowAdoptRunId: 'prior-run',
      });
      const recorded = updates
        .map(metadata => metadata[WORKFLOW_SOURCE_METADATA_KEY] as { origin?: string } | undefined)
        .filter(record => record !== undefined);
      expect(recorded.at(-1)?.origin).toBe('/wt/from-branch');
    } finally {
      factory.mockRestore();
      (adapter.createWorkflowDeps as ReturnType<typeof mock>).mockImplementation(() => original);
    }
  });

  // F1: the deferred capture swaps the executed graph for the branch's vintage, so the
  // invocation gates must be judged against THAT definition — a required input declared
  // only on the branch must refuse the run instead of slipping through on the parent's
  // vintage.
  test('adopt with checkout-branch enforces an input declared only on the branch', async () => {
    mockPrepareWorkflowSource.mockImplementationOnce(() =>
      Promise.resolve({
        runId: 'prepared-run-id',
        origin: '/wt/from-branch',
        manifest: {
          version: 1,
          engine_version: 'test',
          origin: '/wt/from-branch',
          captured_at: '2026-08-21T00:00:00.000Z',
          digest: 'branch-digest',
          file_count: 1,
          byte_count: 1,
          scopes: ['project'],
          source_config: {
            load_default_workflows: true,
            load_default_commands: true,
          },
        },
        anchor: {
          root: '/capture-branch',
          digest: 'branch-digest',
          config: {
            load_default_workflows: true,
            load_default_commands: true,
          },
        },
        roots: {
          project: '/capture-branch/project',
          globalWorkflows: '/capture-branch/global/workflows',
          globalCommands: '/capture-branch/global/commands',
          globalScripts: '/capture-branch/global/scripts',
          bundledWorkflows: '/capture-branch/bundled/workflows',
          bundledCommands: '/capture-branch/bundled/commands/defaults',
          installed: { kind: 'captured', captureRoot: '/capture-branch' },
          kind: 'captured',
          anchor: {
            root: '/capture-branch',
            digest: 'branch-digest',
            config: {
              load_default_workflows: true,
              load_default_commands: true,
            },
          },
        },
      })
    );
    // Discovery off the branch capture resolves a definition that requires an input
    // the caller did not supply — a contract the parent checkout's YAML never had.
    mockDiscoverWorkflowsWithConfig.mockImplementationOnce(() =>
      Promise.resolve({
        workflows: [
          makeTestWorkflowWithSource({
            name: 'test-workflow',
            inputs: { diff: { required: true } },
          }),
        ],
        errors: [],
      })
    );
    mockValidateAndResolveIsolation.mockImplementationOnce(() =>
      Promise.resolve({
        cwd: '/wt/from-branch',
        status: 'new',
        env: makeIsolationEnvironment(),
      })
    );
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ args: 'test message' }))
    );
    mockResolveWorkflowAdoption.mockImplementationOnce(() =>
      Promise.resolve({
        adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
        lane: {
          kind: 'checkout-branch',
          taskBranch: { kind: 'existing', branch: toBranchName('feature/adopted') },
        },
      })
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowAdoptRunId: 'prior-run',
    });

    expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', expect.stringContaining('diff'));
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('adopt is refused when the conversation already continues a resumable run', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ args: 'test message' }))
    );
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(makeResumableRun({ status: 'paused' }))
    );
    mockResolveWorkflowAdoption.mockImplementationOnce(() =>
      Promise.resolve({
        adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
        lane: {
          kind: 'reuse-worktree',
          environment: makeIsolationEnvironment({ working_path: '/wt/adopted' }),
        },
      })
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowAdoptRunId: 'prior-run',
    });

    // handleMessage funnels dispatch refusals into its user-facing error notice.
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('already continues run')
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });
}
