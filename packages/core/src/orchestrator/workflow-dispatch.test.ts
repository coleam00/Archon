// @archon-test-isolated
/** Covers workflow-dispatch.ts, directly and through `handleMessage`; shared mocks live in `../test/orchestrator-agent-harness`. */
import { WORKFLOW_SOURCE_METADATA_KEY } from '@archon/workflows/schemas/workflow-run';
import { mock, describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeTestResolvedWorkflow, makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import type { IPlatformAdapter } from '../types';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { toBranchName } from '@archon/git';
import { captureWorkflowSource, capturedSourceRoots } from '../../../workflows/src/workflow-source';
import { trackTempRoots } from '@archon/paths/test-utils';

import {
  DEFAULT_PROVIDER_CAPS,
  CAPTURED_SOURCE_ROOTS,
  capturedSourceOwnerCalls,
  makeCodebase,
  makeCodebaseForSync,
  makeConversation,
  makeIsolationEnvironment,
  makePlatform,
  makeRun,
  mockAdoptedEnvironment,
  mockAdoptionMetadata,
  mockCloseRunLiveOwner,
  mockCreateWorkflowRun,
  mockDiscoverWorkflowsWithConfig,
  mockDispatchBackgroundWorkflow,
  mockExecuteWorkflow,
  mockFailPreparedRun,
  mockFindResumableRunByParentConversation,
  mockGetCodebase,
  mockGetCurrentBranchStrict,
  mockGetOrCreateConversation,
  mockGetWorkflowRunDb,
  mockHandleCommand,
  mockHydrateResumableRun,
  mockInspectResumableRun,
  mockListCodebases,
  mockLogger,
  mockParseCommand,
  mockPrepareWorkflowSource,
  mockResolveContinuationWorkflow,
  mockResolveWorkflowAdoption,
  mockResolveWorkflowSourceRoot,
  mockResumedEnvironment,
  mockSendQuery,
  mockStartRunLiveOwner,
  mockStartWorkflow,
  mockUpdateConversation,
  mockValidateAndResolveIsolation,
  mockWithRunLiveOwner,
  operator,
  realDiscoverWorkflowsWithConfig,
  realResolveContinuationWorkflow,
  makeDispatchConversation,
  makeForegroundPlatform,
  makeResumableRun,
  resetDispatchMocks,
} from '../test/orchestrator-agent-harness';
import { SqliteAdapter } from '../db/adapters/sqlite';
import { assertNewRunCheckoutAvailable } from '../db/checkout-ownership';
import * as conversationDb from '../db/conversations';
import { handleMessage } from './orchestrator-agent';
import { continueResolvedGateRun } from './workflow-dispatch';
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';

const trackTempRoot = trackTempRoots();
const mockClearConversationCheckout = spyOn(conversationDb, 'clearConversationCheckout');

// ─── Workflow dispatch routing ────────────────────────────────────────────────

describe('workflow dispatch routing', () => {
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

  beforeEach(() => {
    resetDispatchMocks();
    mockClearConversationCheckout.mockReset();
  });

  test.each(['fresh', 'checkout-branch'] as const)(
    'a %s foreground setup clears a retired conversation checkout before insertion',
    async lane => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'foreground-retired-')));
      const database = new SqliteAdapter(join(root, 'db.sqlite'));
      const codebase = makeCodebase();
      const conversation = makeDispatchConversation({ isolation_env_id: 'retired-env' });
      const retiredPath = join(root, 'retired');
      try {
        await database.query(
          'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
          [codebase.id, codebase.name, root]
        );
        await database.query(
          `INSERT INTO remote_agent_isolation_environments (id, codebase_id, workflow_type, workflow_id, working_path, branch_name, status)
        VALUES ('retired-env', $1, 'task', 'prior', $2, 'prior', 'destroyed')`,
          [codebase.id, retiredPath]
        );
        await database.query(
          `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, isolation_env_id)
        VALUES ($1, 'cli', $1, 'retired-env')`,
          [conversation.id]
        );
        const setupInput = {
          workflow_name: 'test-workflow',
          user_message: '',
          origin: { conversationId: conversation.id },
        };
        await expect(
          assertNewRunCheckoutAvailable(database.query.bind(database), setupInput)
        ).rejects.toThrow(retiredPath);
        mockGetOrCreateConversation.mockResolvedValueOnce(conversation);
        mockGetCodebase.mockResolvedValueOnce(codebase);
        mockHandleCommand.mockResolvedValueOnce(makeWorkflowResult());
        mockAdoptedEnvironment.mockResolvedValueOnce(
          makeIsolationEnvironment({
            id: 'retired-env',
            working_path: retiredPath,
            status: 'destroyed',
          })
        );
        mockClearConversationCheckout.mockImplementation(async (id, expectedEnvId) => {
          await database.query(
            'UPDATE remote_agent_conversations SET isolation_env_id = NULL WHERE id = $1 AND isolation_env_id = $2',
            [id, expectedEnvId]
          );
          return { ...conversation, isolation_env_id: null };
        });
        await mkdir(retiredPath);
        if (lane === 'checkout-branch')
          mockResolveWorkflowAdoption.mockResolvedValueOnce({
            adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
            lane: {
              kind: 'checkout-branch',
              taskBranch: { kind: 'existing', branch: toBranchName('feature/adopted') },
            },
          });
        mockCreateWorkflowRun.mockImplementationOnce(async data => {
          await assertNewRunCheckoutAvailable(database.query.bind(database), data);
          return makeRun({
            id: data.id,
            workflow_name: data.workflow_name,
            status: 'pending',
            metadata: data.metadata ?? {},
          });
        });
        await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
          actor: operator,
          ...(lane === 'checkout-branch' ? { workflowAdoptRunId: 'prior-run' } : {}),
        });
        expect(mockValidateAndResolveIsolation.mock.calls[0]?.[0].isolation_env_id).toBeNull();
        expect(mockCreateWorkflowRun).toHaveBeenCalledTimes(1);
        expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
        expect(mockFailPreparedRun).not.toHaveBeenCalled();
        expect(
          (
            await database.query<{ isolation_env_id: string | null }>(
              'SELECT isolation_env_id FROM remote_agent_conversations WHERE id = $1',
              [conversation.id]
            )
          ).rows[0]?.isolation_env_id
        ).toBeNull();
      } finally {
        await database.close();
      }
    }
  );

  test.each(['removed', 'replaced'] as const)(
    'fresh foreground captures reconciled source when its checkout was %s',
    async state => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'foreground-source-')));
      const retiredPath = join(root, 'retired');
      const replacementPath = join(root, 'replacement');
      const projectPath = join(root, 'project');
      for (const [path, description] of [
        [retiredPath, 'obsolete source'],
        [replacementPath, 'replacement source'],
        [projectPath, 'registered source'],
      ]) {
        await mkdir(join(path, '.archon', 'workflows'), { recursive: true });
        await writeFile(
          join(path, '.archon', 'workflows', 'test-workflow.yaml'),
          `name: test-workflow\ndescription: ${description}\nnodes:\n  - id: work\n    prompt: Work\n`
        );
      }
      if (state === 'removed') await rm(retiredPath, { recursive: true });
      const conversation = makeDispatchConversation({
        isolation_env_id: 'retired-env',
        cwd: retiredPath,
      });
      mockGetOrCreateConversation.mockResolvedValueOnce(conversation);
      mockGetCodebase.mockResolvedValueOnce(makeCodebase({ default_cwd: projectPath }));
      mockHandleCommand.mockResolvedValueOnce(makeWorkflowResult());
      mockAdoptedEnvironment.mockResolvedValueOnce(
        makeIsolationEnvironment({
          id: 'retired-env',
          working_path: retiredPath,
          status: 'destroyed',
        })
      );
      mockClearConversationCheckout.mockResolvedValueOnce({
        ...conversation,
        isolation_env_id: state === 'replaced' ? 'new-env' : null,
        cwd: state === 'replaced' ? replacementPath : retiredPath,
      });
      if (state === 'replaced')
        mockAdoptedEnvironment.mockResolvedValueOnce(
          makeIsolationEnvironment({ id: 'new-env', working_path: replacementPath })
        );
      const captureRoot = join(root, 'capture');
      mockPrepareWorkflowSource.mockImplementationOnce(async (_deps, options) => {
        const capture = await captureWorkflowSource({ ...options, captureRoot });
        return { ...capture, runId: 'prepared-run-id', roots: capturedSourceRoots(capture.anchor) };
      });
      mockDiscoverWorkflowsWithConfig.mockImplementation((...args) =>
        realDiscoverWorkflowsWithConfig(...args)
      );
      await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
        actor: operator,
      });
      const expectedDescription = state === 'replaced' ? 'replacement source' : 'registered source';
      expect(mockClearConversationCheckout).toHaveBeenCalledWith(conversation.id, 'retired-env');
      expect(mockValidateAndResolveIsolation.mock.calls[0]?.[0].isolation_env_id).toBe(
        state === 'replaced' ? 'new-env' : null
      );
      expect(
        await readFile(join(captureRoot, 'project/.archon/workflows/test-workflow.yaml'), 'utf8')
      ).toContain(expectedDescription);
      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      expect(mockExecuteWorkflow.mock.calls[0]?.[4].description).toBe(expectedDescription);
    }
  );

  test('a terminal status write failure during worktree preparation is not retried', async () => {
    const { IsolationBlockedError } = await import('@archon/isolation');
    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    mockHandleCommand.mockResolvedValueOnce(makeWorkflowResult());
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
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));

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
      Promise.resolve(makeWorkflowResult({ args: 'test message' }))
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
    mockHandleCommand.mockResolvedValueOnce(makeWorkflowResult());
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
      const { adoptRegisteredWorktree } = await import('../operations/workflow-adoption');
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

  test.each(['missing', 'mismatched', 'replaced', 'switched', 'detached'] as const)(
    'foreground adoption refuses a %s environment before capture',
    async reason => {
      mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
      mockGetCodebase.mockResolvedValueOnce(makeCodebase());
      mockHandleCommand.mockResolvedValueOnce(makeWorkflowResult());
      mockResolveWorkflowAdoption.mockResolvedValueOnce({
        adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
        lane: {
          kind: 'reuse-worktree',
          environment: makeIsolationEnvironment({ working_path: '/wt/adopted' }),
        },
      });
      if (reason === 'switched' || reason === 'detached') {
        mockGetCurrentBranchStrict.mockResolvedValueOnce(reason === 'switched' ? 'other' : null);
      }
      mockAdoptedEnvironment.mockResolvedValueOnce(
        reason === 'missing'
          ? null
          : reason === 'replaced'
            ? makeIsolationEnvironment({
                working_path: '/wt/adopted',
                metadata: { worktree_registration_id: 'replacement' },
              })
            : makeIsolationEnvironment({
                working_path: reason === 'mismatched' ? '/wt/from-branch' : '/wt/adopted',
              })
      );
      mockPrepareWorkflowSource.mockClear();
      mockAdoptionMetadata.mockClear();
      mockLogger.warn.mockClear();
      const platform = makeForegroundPlatform();
      await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
        actor: operator,
        workflowAdoptRunId: 'prior-run',
      });
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        expect.stringContaining(
          reason === 'missing'
            ? 'Isolation environment env-1 not found'
            : reason === 'replaced'
              ? 'changed during adoption'
              : reason === 'switched' || reason === 'detached'
                ? 'expected branch'
                : 'does not match'
        )
      );
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
      Promise.resolve(makeWorkflowResult({ args: 'test message' }))
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
      Promise.resolve(makeWorkflowResult({ args: 'test message' }))
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
      Promise.resolve(makeWorkflowResult({ args: 'test message' }))
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
      Promise.resolve(makeWorkflowResult({ args: 'test message' }))
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
    const adapter = await import('../workflows/store-adapter');
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
      Promise.resolve(makeWorkflowResult({ args: 'test message' }))
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
      Promise.resolve(makeWorkflowResult({ args: 'test message' }))
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
      Promise.resolve(makeWorkflowResult({ args: 'test message' }))
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

  test('adopt and supersede together refuse before dispatch', async () => {
    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    mockHandleCommand.mockResolvedValueOnce(makeWorkflowResult());
    const resolveAdoption = mockResolveWorkflowAdoption.getMockImplementation();
    if (!resolveAdoption) throw new Error('Missing adoption implementation');
    mockResolveWorkflowAdoption.mockResolvedValue({
      adoptedRun: makeResumableRun({ id: 'adopted-run', status: 'completed' }),
      lane: { kind: 'in-place' },
    });
    mockPrepareWorkflowSource.mockClear();
    const platform = makeForegroundPlatform();
    try {
      await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
        actor: operator,
        workflowAdoptRunId: 'adopted-run',
        workflowSupersedesRunId: 'replaced-run',
      });
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        expect.stringContaining('adoptRunId and supersedesRunId are mutually exclusive')
      );
      expect(mockResolveWorkflowAdoption).not.toHaveBeenCalled();
      expect(mockHydrateResumableRun).not.toHaveBeenCalled();
      expect(mockStartRunLiveOwner).not.toHaveBeenCalled();
      expect(mockPrepareWorkflowSource).not.toHaveBeenCalled();
      expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
      expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    } finally {
      mockResolveWorkflowAdoption.mockImplementation(resolveAdoption);
    }
  });

  test.each([
    { label: 'implicit continuation of a paused run', explicit: false },
    { label: 'explicit resume of a failed run', explicit: true },
  ])('supersede is refused before $label', async ({ explicit }) => {
    const run = makeResumableRun({ status: explicit ? 'failed' : 'paused' });
    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    mockHandleCommand.mockResolvedValueOnce(makeWorkflowResult(explicit ? { resumeRun: run } : {}));
    if (!explicit) mockFindResumableRunByParentConversation.mockResolvedValueOnce(run);
    mockPrepareWorkflowSource.mockClear();
    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowSupersedesRunId: 'replaced-run',
    });
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining(
        `Cannot supersede run 'replaced-run': this conversation already continues run '${run.id}' (${run.status}). Resume or abandon that run first`
      )
    );
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockStartRunLiveOwner).not.toHaveBeenCalled();
    expect(mockPrepareWorkflowSource).not.toHaveBeenCalled();
    expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });

  test.each([false, true])('fresh supersede records provenance (force=%s)', async force => {
    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    mockHandleCommand.mockResolvedValueOnce(makeWorkflowResult({ force }));
    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowSupersedesRunId: 'replaced-run',
    });
    expect(mockCreateWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkflowRun.mock.calls[0][0]).toMatchObject({
      adopted_from_run_id: 'replaced-run',
      metadata: { continuation: { mode: 'supersede' } },
    });
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow.mock.calls[0][7]).toMatchObject({
      adoptedFromRunId: 'replaced-run',
      continuationMode: 'supersede',
    });
  });

  test('fresh background supersede forwards provenance to dispatch', async () => {
    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    mockHandleCommand.mockResolvedValueOnce(makeWorkflowResult());
    await handleMessage(makePlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowSupersedesRunId: 'replaced-run',
    });
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ supersedesRunId: 'replaced-run' }),
      expect.objectContaining({ name: 'test-workflow' })
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('adopt is refused when the workflow opts out of worktrees', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    const noWorktreeResult = makeWorkflowResult({ args: 'test message' });
    if (noWorktreeResult.workflow.kind !== 'start') throw new Error('expected start request');
    noWorktreeResult.workflow.definition.worktree = { enabled: false };
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(noWorktreeResult));
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

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('disables worktrees')
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('failed_resume_user_prompted: failed runs are not auto-resumed', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(makeResumableRun())
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Found a prior failed run of **test-workflow**')
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('/workflow resume resumable-run-1')
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('/workflow abandon resumable-run-1')
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('/workflow run test-workflow --force "test message"')
    );
  });

  test('failed_resume_user_prompted: stale running orphan gates with status-accurate copy', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    // findResumableRunByParentConversation also surfaces stale 'running' orphans,
    // not just 'failed' runs — the prompt must not mislabel them as "failed".
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(makeResumableRun({ status: 'running' }))
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    // Gate still fires (no silent auto-resume) ...
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('/workflow resume resumable-run-1')
    );
    // ... but the copy reflects the real status, not "failed".
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Found a prior interrupted run of **test-workflow**')
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Discard the interrupted run')
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('leave the interrupted run as-is')
    );
    expect(platform.sendMessage).not.toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('failed run')
    );
  });

  test('failed_resume_user_prompted: prompt includes normalized truncated prior prompt preview', async () => {
    const priorMessage = `line one\n${'x'.repeat(220)}`;
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'resumable-run-preview',
          user_message: priorMessage,
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    const prompt = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.at(-1)?.[1] as
      | string
      | undefined;
    expect(prompt).toContain(`> line one ${'x'.repeat(151)}…`);
    expect(prompt).not.toContain('\nline one\n');
  });

  test('failed_resume_user_prompted: escapes backslash, double quote, and backtick in suggested commands', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ args: 'fix \\ path "quoted" `tick`' }))
    );
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'resumable-run-escape',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    const prompt = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.at(-1)?.[1] as
      | string
      | undefined;
    expect(prompt).toContain('/workflow run test-workflow "fix \\\\ path \\"quoted\\" \\`tick\\`"');
    expect(prompt).toContain(
      '/workflow run test-workflow --force "fix \\\\ path \\"quoted\\" \\`tick\\`"'
    );
  });

  test('--force flag: skips resume detection and dispatches a fresh run', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult({ force: true })));

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow --force', {
      actor: operator,
    });

    expect(mockFindResumableRunByParentConversation).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('/test/cwd');
  });

  test('resume request hydrates the requested run without latest-run lookup', async () => {
    mockAdoptionMetadata.mockClear();
    mockResumedEnvironment.mockResolvedValueOnce(makeIsolationEnvironment());
    const requestedRun = makeResumableRun({
      id: 'old-run',
      user_message: 'requested prompt',
      working_path: '/repos/test-repo/worktrees/old',
    });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ resumeRun: requestedRun }))
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow resume old-run', { actor: operator });

    expect(mockAdoptionMetadata.mock.calls).toEqual([
      [
        'env-1',
        {
          adopted: true,
          worktree_registration_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          ),
        },
        expect.objectContaining({ id: 'env-1' }),
      ],
    ]);
    expect(mockFindResumableRunByParentConversation).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'old-run' }),
      undefined
    );
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/old');
    expect(platform.sendMessage).not.toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Found a prior failed run')
    );
  });

  test('resume request reports requested run with missing working path', async () => {
    const requestedRun = makeResumableRun({
      id: 'old-run-missing-path',
      user_message: 'requested prompt',
      working_path: null,
    });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ resumeRun: requestedRun }))
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow resume old-run-missing-path', {
      actor: operator,
    });

    expect(mockFindResumableRunByParentConversation).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      'Cannot resume old-run-missing-path: missing working path.'
    );
  });

  for (const entry of ['slash command', 'batch invocation', 'stream invocation'] as const) {
    for (const [label, actor, starter, role, allowed] of [
      ['other member', { kind: 'user', userId: 'member-b' }, 'starter-a', 'member', false],
      ['unidentified', { kind: 'unidentified' }, 'starter-a', undefined, false],
      ['null starter', { kind: 'user', userId: 'member-b' }, null, 'member', false],
      ['starter', { kind: 'user', userId: 'starter-a' }, 'starter-a', 'member', true],
      ['admin', { kind: 'user', userId: 'admin-b' }, 'starter-a', 'admin', true],
      ['operator', { kind: 'operator' }, null, undefined, true],
    ] as const) {
      test(`implicit continuation authorization: ${entry}, ${label}`, async () => {
        const users = await import('../db/users');
        const lookup = spyOn(users, 'getUserById').mockResolvedValue(
          role
            ? {
                id: actor.kind === 'user' ? actor.userId : 'unused',
                role,
                display_name: null,
                email: null,
                created_at: new Date(),
                updated_at: new Date(),
              }
            : null
        );
        const run = makeResumableRun({ status: 'paused', user_id: starter });
        mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
        mockGetCodebase.mockResolvedValueOnce(makeCodebase());
        mockFindResumableRunByParentConversation.mockResolvedValueOnce(run);
        mockValidateAndResolveIsolation.mockClear();
        const providers = await import('@archon/providers');
        const caps = providers.getProviderCapabilities as ReturnType<typeof mock>;
        caps.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS, nativeTools: true });
        const platform = makeForegroundPlatform();
        if (entry === 'slash command')
          mockHandleCommand.mockResolvedValueOnce(makeWorkflowResult());
        else {
          mockListCodebases.mockResolvedValue([makeCodebase()]);
          platform.getStreamingMode.mockReturnValue(
            entry === 'stream invocation' ? 'stream' : 'batch'
          );
          mockSendQuery.mockImplementationOnce(async function* (_prompt, _cwd, _session, options) {
            const tool = options?.nativeTools?.find(t => t.name === 'invoke_workflow');
            if (!tool) throw new Error('Missing workflow launch tool');
            const result = await tool.handler({
              workflow: 'test-workflow',
              project: 'test-repo',
              prompt: 'Continue the workflow',
            });
            expect(result).toContain('Queued');
            yield { type: 'agent_message_chunk', text: 'Continuing.' };
            yield { type: 'result', sessionId: 'session-1' };
          });
        }
        try {
          await handleMessage(
            platform,
            'conv-1',
            entry === 'slash command' ? '/workflow run test-workflow' : 'Continue the workflow',
            { actor }
          );
          if (allowed) {
            expect(mockStartRunLiveOwner).toHaveBeenCalledWith(run.id);
            expect(mockHydrateResumableRun).toHaveBeenCalled();
            expect(mockExecuteWorkflow).toHaveBeenCalled();
          } else {
            expect(platform.sendMessage).toHaveBeenCalledWith(
              'conv-1',
              expect.stringContaining(
                starter
                  ? 'Only the user who started this run or an admin'
                  : 'This run has no recorded starter'
              )
            );
            expect(mockStartRunLiveOwner).not.toHaveBeenCalled();
            expect(mockHydrateResumableRun).not.toHaveBeenCalled();
            expect(mockExecuteWorkflow).not.toHaveBeenCalled();
            expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
          }
        } finally {
          lookup.mockRestore();
          caps.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS });
        }
      });
    }
  }

  test('foreground_resume_detected: preserves origin when a paused run exists', async () => {
    // Regression for the foreground-resume branch: when
    // findResumableRunByParentConversation returns a paused run, the
    // orchestrator must hydrate it (single DB roundtrip — no second
    // findResumableRun) and hand the resumed run + priorCompletedNodes to
    // executeWorkflow via opts.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(
      Promise.resolve(makeCodebase({ default_branch: 'develop' }))
    );
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          status: 'paused',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    // cwd (position 3) should come from the resumable run's working_path.
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/feature');
    // Resume payload lives on the opts bag (the trailing arg).
    const opts = callArgs[callArgs.length - 1] as {
      baseBranch?: string;
      preCreatedRun?: { id: string };
      priorCompletedNodes?: Map<string, string>;
    };
    expect(callArgs[6]).toMatchObject({
      conversationId: 'conv-1',
      parentConversationId: 'conv-1',
    });
    // Resume dispatch carries the codebase default as the $BASE_BRANCH fallback too.
    expect(opts.baseBranch).toBe('develop');
    expect(opts.preCreatedRun?.id).toBe('resumable-run-1');
    expect(opts.priorCompletedNodes?.size).toBeGreaterThan(0);
  });

  test('a plain workflow run does not consume an attention pause', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          status: 'paused',
          metadata: {
            wait: {
              owner: 'node',
              nodeId: 'rerun-ci',
              kind: 'attention',
              waitingSince: '2026-09-01T10:00:00.000Z',
              message: 'Re-run the failing check, then resume.',
            },
          },
        })
      )
    );

    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
    });

    expect(mockFindResumableRunByParentConversation).toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
  });

  test('an explicit workflow resume consumes an attention pause', async () => {
    const requestedRun = makeResumableRun({
      status: 'paused',
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'rerun-ci',
          kind: 'attention',
          waitingSince: '2026-09-01T10:00:00.000Z',
          message: 'Re-run the failing check, then resume.',
        },
      },
    });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ resumeRun: requestedRun }))
    );

    await handleMessage(makeForegroundPlatform(), 'conv-1', `/workflow resume ${requestedRun.id}`, {
      actor: operator,
    });

    expect(mockFindResumableRunByParentConversation).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: requestedRun.id }),
      undefined
    );
  });

  test('foreground_resume_detected: falls through to fresh run when hydration returns null', async () => {
    // When findResumableRunByParentConversation returns a run but
    // hydrateResumableRun finds nothing worth resuming (zero completed nodes,
    // no interactive-loop state), the orchestrator must NOT throw — it sends
    // a user-visible notice and starts a fresh run on the same worktree.
    // (#2686) The fresh run row must freeze its OWN workflow source — not
    // inherit the prior run's frozen graph against live commands/scripts.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(
      Promise.resolve(makeCodebase({ default_branch: 'develop' }))
    );
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'empty-prior-run',
          status: 'paused',
        })
      )
    );
    mockHydrateResumableRun.mockReturnValueOnce(Promise.resolve(null));

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    // cwd still points at the prior run's worktree.
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/feature');
    // Opts bag carries no resume payload — fresh run.
    const opts = callArgs[callArgs.length - 1] as {
      baseBranch?: string;
      preCreatedRun?: unknown;
      priorCompletedNodes?: unknown;
      preparedSource?: { anchor?: { root?: string }; manifest?: { captured_at?: string } };
    };
    expect(callArgs[6]).toMatchObject({
      conversationId: 'conv-1-db',
      parentConversationId: 'conv-1-db',
    });
    // The fresh-run-in-same-worktree branch still threads the codebase default.
    expect(opts.baseBranch).toBe('develop');
    expect(opts.preCreatedRun).toBeUndefined();
    expect(opts.priorCompletedNodes).toBeUndefined();
    // (#2686) This is the key regression assertion: the fresh run row carries
    // the captured source so its run row records `workflow_source` from this
    // moment, not the prior run's frozen bytes. Before the fix, `preparedSource`
    // was undefined here because the outer `if (!willContinueExistingRun)` block
    // was skipped.
    expect(opts.preparedSource).toBeDefined();
    expect(opts.preparedSource?.anchor?.root).toBe('/capture');
    expect(opts.preparedSource?.manifest?.captured_at).toBe('2026-08-21T00:00:00.000Z');
  });

  test('applies a run config when a resume candidate hydrates to a fresh run', async () => {
    const runConfig = {
      source: { kind: 'http' as const, label: 'inline' },
      layer: { docsPath: 'handbook' },
    };
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(makeResumableRun({ id: 'empty-config-run', status: 'paused' }))
    );
    mockInspectResumableRun.mockReturnValueOnce(Promise.resolve(null));

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowRunConfig: runConfig,
    });

    expect(mockInspectResumableRun).toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow.mock.calls[0]?.[7]?.runConfig).toEqual(runConfig);
    expect(platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n')).not.toContain(
      'a new run config cannot be applied'
    );
  });

  test('foreground_resume_detected: fresh-run-in-same-worktree refuses with the capture-failure message when prepareWorkflowSource rejects (#2686)', async () => {
    // The new capture call inside the resume-null fallback introduces a SECOND call site
    // of `captureFreshSource(...)` whose failure path is unexercised by the success-only
    // test above. A regression that drops `if (!captured) return;` or reorders the
    // user-visible notice would land uncaught without this test — `executeWorkflow`
    // would be called against an undefined capture and the user would see the generic
    // "starting fresh in the same worktree" notice instead of the capture-failure one.
    //
    // Note on the lifecycle: `captureFreshSource` calls `owner.hold` AFTER
    // `prepareWorkflowSource` returns, so a `prepareWorkflowSource` rejection skips
    // the hold entirely (no reclaim because nothing was held). The
    // `['hold:/capture', 'reclaim:/capture']` shape is exercised separately by the
    // "keeps holding the capture when the dispatch refuses after taking it" test
    // above — that one runs `prepareWorkflowSource` cleanly and trips a gate AFTER
    // the hold.
    const { prepareWorkflowSource } = await import('@archon/workflows/run-source');
    (prepareWorkflowSource as ReturnType<typeof mock>).mockImplementationOnce(() =>
      Promise.reject(new Error('disk full'))
    );

    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'empty-prior-run',
          status: 'paused',
        })
      )
    );
    mockHydrateResumableRun.mockReturnValueOnce(Promise.resolve(null));

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    // No run started against an undefined capture.
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    // The user-visible failure notice names the workflow and the underlying error.
    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain(
      'Could not capture the workflow source for **test-workflow**: disk full'
    );
    // The generic "starting fresh in the same worktree" notice must NOT fire — that
    // would mislead the user into thinking a fresh run started when none did.
    expect(sent).not.toContain('starting fresh in the same worktree');
    // The capture was never held (rejection landed BEFORE `owner.hold`), so the
    // owner has nothing to reclaim.
    expect(capturedSourceOwnerCalls).toEqual([]);
  });

  test('foreground_resume_detected: fresh-run-in-same-worktree captures and executes the FRESHLY captured graph (#2686)', async () => {
    // (#2686) Regression for the mixed-vintage shape: when a paused run had nothing to
    // resume, the orchestrator must capture source here and execute the freshly resolved
    // graph — not the prior run's frozen definition against live command/script bytes.
    // Before the fix, the outer `if (!willContinueExistingRun)` block was skipped because
    // `willContinueExistingRun` was true, leaving `preparedSource` undefined and the
    // executor in `source_unprepared_live` mode against the prior run's frozen graph.
    const { prepareWorkflowSource } = await import('@archon/workflows/run-source');
    const freshWorkflow = makeTestResolvedWorkflow({
      name: 'test-workflow',
      description: 'freshly captured from disk',
    });
    // Capture returns a non-empty scope so the helper actually re-resolves the workflow.
    (prepareWorkflowSource as ReturnType<typeof mock>).mockImplementationOnce(() =>
      Promise.resolve({
        runId: 'prepared-run-id',
        origin: '/origin',
        manifest: {
          version: 1,
          engine_version: 'test',
          origin: '/origin',
          captured_at: '2026-08-21T00:00:00.000Z',
          digest: 'test-digest',
          file_count: 1,
          byte_count: 1,
          scopes: ['project'],
        },
        anchor: CAPTURED_SOURCE_ROOTS.anchor,
        roots: {
          project: '/capture/project',
          globalWorkflows: '/capture/global/workflows',
          globalCommands: '/capture/global/commands',
          globalScripts: '/capture/global/scripts',
          bundledWorkflows: '/capture/bundled/workflows',
          bundledCommands: '/capture/bundled/commands/defaults',
          kind: 'captured',
          anchor: CAPTURED_SOURCE_ROOTS.anchor,
        },
      })
    );
    // Discovery off the FRESH capture returns a workflow distinct from the one the
    // resume-input would otherwise feed executeWorkflow. If the orchestrator handed
    // `executeWorkflow` the wrong graph, the description below would mismatch.
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [makeTestWorkflowWithSource({ name: 'test-workflow' })],
        errors: [],
      })
    );
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [{ workflow: freshWorkflow, source: 'project' }],
        errors: [],
      })
    );

    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'empty-prior-run',
          status: 'paused',
        })
      )
    );
    mockHydrateResumableRun.mockReturnValueOnce(Promise.resolve(null));

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(prepareWorkflowSource).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    // The workflow argument (position 4) is the freshly resolved graph, NOT the
    // resume-input graph. Before the fix this was the prior run's frozen graph.
    expect(callArgs[4]).toBe(freshWorkflow);
    // A fresh run records launch AI config prepared here, not in the prior run's worktree.
    expect(
      (callArgs[7] as { preparedAiConfiguration?: unknown }).preparedAiConfiguration
    ).toBeDefined();
    // Capture lifecycle: hold then adopt — the prior branch's `if (preparedSource)
    // owner.adopt()` is now a live guard, not inert.
    expect(capturedSourceOwnerCalls).toEqual(['hold:/capture', 'adopt']);
    // The user-visible notice still fires.
    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('starting fresh in the same worktree');
  });

  test('calls dispatchBackgroundWorkflow for a fresh run on web', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));

    const platform = makePlatform(); // getPlatformType returns 'web'
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('calls dispatchBackgroundWorkflow for a fresh run on a background-default adapter', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));

    const platform = { ...makePlatform(), getPlatformType: mock(() => 'matrix-chat') };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Declared inputs supplied by the run route (#2554)
  // -------------------------------------------------------------------------

  test('context.workflowName starts that workflow with the message verbatim, never parsed as a command', async () => {
    // A message that would be a command, and would set --force, if it were parsed (#4159).
    const message = '/detach-project "acme" --force\n  keep this indent';
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockStartWorkflow.mockReturnValueOnce(Promise.resolve(makeWorkflowResult({ args: message })));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', message, {
      actor: operator,
      workflowName: 'test-workflow',
      workflowInputs: { diff: 'D1' },
    });

    expect(mockParseCommand).not.toHaveBeenCalled();
    expect(mockHandleCommand).not.toHaveBeenCalled();
    expect(mockStartWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ id: makeDispatchConversation().id }),
      'test-workflow',
      message,
      false,
      platform
    );
    const ctx = mockDispatchBackgroundWorkflow.mock.calls[0][0] as {
      originalMessage: string;
      inputs?: Record<string, string>;
    };
    expect(ctx.originalMessage).toBe(message);
    expect(ctx.inputs).toEqual({ diff: 'D1' });
  });

  test('threads context.workflowInputs into executeWorkflow for a fresh foreground run', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );

    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowInputs: { diff: 'D1' },
    });

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const opts = mockExecuteWorkflow.mock.calls[0][7] as { inputs?: Record<string, string> };
    expect(opts.inputs).toEqual({ diff: 'D1' });
  });

  test('threads context.workflowInputs into dispatchBackgroundWorkflow — the console default path', async () => {
    // Fresh web runs never touch the executeWorkflow branches, so dropping
    // the map here would ship a console run form that silently does nothing.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );

    await handleMessage(makePlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowInputs: { diff: 'D1' },
    });

    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    const ctx = mockDispatchBackgroundWorkflow.mock.calls[0][0] as {
      inputs?: Record<string, string>;
    };
    expect(ctx.inputs).toEqual({ diff: 'D1' });
  });

  test('a fresh run reads launch AI config from the registered checkout, not the conversation worktree', async () => {
    // The conversation already sits in a worktree holding only committed config; the
    // registered checkout carries an uncommitted codex selection.
    const adapter = await import('../workflows/store-adapter');
    const original = adapter.createWorkflowDeps();
    const loadConfig = mock(async (cwd?: string) => ({
      ...(await original.loadConfig(cwd)),
      assistant: cwd === '/repos/test-repo' ? 'codex' : 'claude',
    }));
    const factory = spyOn(adapter, 'createWorkflowDeps').mockImplementation(() => ({
      ...original,
      loadConfig,
    }));
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeDispatchConversation({ cwd: '/worktrees/conv' }))
    );
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    try {
      await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
        actor: operator,
      });
      expect(loadConfig).toHaveBeenCalledWith('/repos/test-repo');
      expect(loadConfig).not.toHaveBeenCalledWith('/worktrees/conv');
      const opts = mockExecuteWorkflow.mock.calls[0]?.[7] as {
        preparedAiConfiguration?: { config: { assistant: string } };
      };
      expect(opts.preparedAiConfiguration?.config.assistant).toBe('codex');
    } finally {
      factory.mockRestore();
      (adapter.createWorkflowDeps as ReturnType<typeof mock>).mockImplementation(() => original);
    }
  });

  test('foreground credential refusal stops before isolation or execution', async () => {
    const adapter = await import('../workflows/store-adapter');
    const original = adapter.createWorkflowDeps();
    const factory = spyOn(adapter, 'createWorkflowDeps').mockImplementation(() => ({
      ...original,
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderCredential: async () => ({
        kind: 'api_key',
        getStatus: async () => ({ state: 'unusable', source: 'archon', evidence: 'cannot read' }),
      }),
    }));
    const platform = makeForegroundPlatform();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    try {
      await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
        actor: { kind: 'user', userId: 'origin' },
      });
      expect(platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n')).toContain(
        'credential cannot be used: cannot read'
      );
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
    } finally {
      factory.mockRestore();
      (adapter.createWorkflowDeps as ReturnType<typeof mock>).mockImplementation(() => original);
    }
  });

  test('threads context.workflowModelOverrides into a fresh foreground run', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));

    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowModelOverrides: { tiers: { large: 'openai/gpt-5.6' } },
    });

    const opts = mockExecuteWorkflow.mock.calls[0][7] as { modelOverrideLayer?: unknown };
    expect(opts.modelOverrideLayer).toEqual({
      kind: 'raw',
      overrides: { tiers: { large: 'openai/gpt-5.6' } },
    });
  });

  test('threads context.workflowModelOverrides into the console background path', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));

    await handleMessage(makePlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowModelOverrides: { aliases: { '@planner': 'codex/gpt-5.6-sol' } },
    });

    const ctx = mockDispatchBackgroundWorkflow.mock.calls[0][0] as { modelOverrides?: unknown };
    expect(ctx.modelOverrides).toEqual({
      aliases: { '@planner': 'codex/gpt-5.6-sol' },
    });
  });

  test('threads context.workflowRunConfig into fresh foreground and background runs', async () => {
    const runConfig = {
      source: { kind: 'http' as const, label: 'inline' },
      layer: { docsPath: 'handbook' },
    };
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowRunConfig: runConfig,
    });
    expect(mockExecuteWorkflow.mock.calls[0]?.[7]?.runConfig).toEqual(runConfig);

    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    await handleMessage(makePlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowRunConfig: runConfig,
    });
    expect(mockDispatchBackgroundWorkflow.mock.calls[0]?.[0]?.runConfig).toEqual(runConfig);
  });

  test('refuses a required-input workflow when nothing is supplied, starting nothing', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain("requires input 'diff'");
    expect(sent).toContain('--input');
    expect(sent).not.toContain('reusable block');
  });

  test('hands the capture to a fresh foreground run', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));

    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
    });

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(capturedSourceOwnerCalls).toEqual(['hold:/capture', 'hold:/capture', 'adopt', 'adopt']);
  });

  test('keeps holding the capture when the dispatch refuses after taking it', async () => {
    // The invocation gate fires AFTER the capture, so every refusal past that point has a
    // frozen tree to reclaim. Nothing starts, so nothing owns it.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );

    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
    });

    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(capturedSourceOwnerCalls).toEqual(['hold:/capture', 'reclaim:/capture']);
  });

  test('a continuation takes no capture at all', async () => {
    // It executes the source its run already froze. Capturing here would freeze current
    // bytes the run never agreed to AND leave a staged tree nothing adopts.
    const { prepareWorkflowSource } = await import('@archon/workflows/run-source');
    (prepareWorkflowSource as ReturnType<typeof mock>).mockClear();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(makeResumableRun({ id: 'paused-run', status: 'paused' }))
    );

    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
    });

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(prepareWorkflowSource).not.toHaveBeenCalled();
    expect(capturedSourceOwnerCalls).toEqual([]);
  });

  test('refuses an undeclared supplied key, starting nothing', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowInputs: { diff: 'D1', stlye: 'terse' },
    });

    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('stlye');
  });

  test('an IMPLICIT auto-resume of a required-input workflow is not re-gated', async () => {
    // The dangerous case: a plain `/workflow run <name>` (a start request) on a
    // workflow with a paused run. `dispatchOrchestratorWorkflow` auto-detects that run
    // for every platform, so gating only against an EXPLICIT resume refused a legitimate
    // continuation — the run row already holds its validated inputs, and a user saying
    // "run it" again supplies nothing. Reachable from chat and from a repeat
    // POST /api/workflows/:name/run that reuses a conversation id.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'implicit-resume-1',
          working_path: '/repos/test-repo/worktrees/paused',
          status: 'paused',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).not.toContain("requires input 'diff'");
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('implicit-resume-1');
    expect(mockCloseRunLiveOwner).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow.mock.calls[0][3]).toBe('/repos/test-repo/worktrees/paused');
  });

  test('tells the caller when supplied inputs could not be applied to an auto-resumed run', async () => {
    // The resume replays its own row's inputs; values supplied on this call cannot
    // reach it. Accepting them and silently running something else is the failure this
    // guards — the caller gets a 200 and no way to tell their values were dropped.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'implicit-resume-2',
          working_path: '/repos/test-repo/worktrees/paused',
          status: 'paused',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowInputs: { diff: 'D-new' },
    });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('not applied');
    expect(sent).toContain('diff');
    expect(sent).toContain('implicit-resume-2');
    // Names only — a supplied value is user content and must never be echoed back.
    expect(sent).not.toContain('D-new');
    // The resume still proceeds; the run holds real work and a worktree.
    expect(mockExecuteWorkflow).toHaveBeenCalled();
  });

  test('tells the caller when model bindings could not be applied to an auto-resumed run', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'implicit-model-resume',
          working_path: '/repos/test-repo/worktrees/paused',
          status: 'paused',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowModelOverrides: {
        tiers: { large: 'openai/gpt-5.6' },
        aliases: { '@planner': 'codex/gpt-5.6-sol' },
      },
    });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('were not applied');
    expect(sent).toContain('@planner, large');
    expect(sent).toContain('implicit-model-resume');
    expect(sent).not.toContain('openai/gpt-5.6');
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockExecuteWorkflow.mock.calls[0]?.[7]?.modelOverrideLayer).toBeUndefined();
  });

  test('refuses a new run config when the command would auto-resume existing work', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'implicit-config-resume',
          working_path: '/repos/test-repo/worktrees/paused',
          status: 'paused',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowRunConfig: {
        source: { kind: 'http', label: 'inline' },
        layer: { docsPath: 'handbook' },
      },
    });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('a new run config cannot be applied');
    expect(sent).toContain('force a fresh run');
    expect(mockInspectResumableRun).toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });

  test('uses the actual state when explicit resume ignores supplied model bindings', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(
        makeWorkflowResult({
          resumeRun: makeResumableRun({ id: 'failed-model-resume', status: 'failed' }),
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow resume failed-model-resume', {
      actor: operator,
      workflowModelOverrides: { tiers: { large: 'openai/gpt-5.6' } },
    });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('Resuming the failed run');
    expect(sent).not.toContain('Resuming the paused run');
    expect(mockExecuteWorkflow).toHaveBeenCalled();
  });

  test('re-raises the deferred input error when hydration finds nothing to resume', async () => {
    // The gate defers a contract violation while a continuation looks possible. This is
    // the ONE branch where that prediction turns out wrong — hydration returns null, so
    // a FRESH run row gets created after all — and the deferred error has to come back.
    // Without the re-raise, a required-input workflow would silently start with the
    // input never supplied and never validated: neither a safe refusal nor a real resume.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'nothing-to-resume-1',
          working_path: '/repos/test-repo/worktrees/paused',
          status: 'paused',
        })
      )
    );
    // Nothing worth resuming → the fresh-run fallthrough.
    mockHydrateResumableRun.mockReturnValueOnce(Promise.resolve(null));
    const capturedWorkflow = makeTestResolvedWorkflow({
      name: 'test-workflow',
      inputs: { diff: { required: true } },
    });
    mockResolveContinuationWorkflow.mockResolvedValueOnce({
      workflow: capturedWorkflow,
      roots: CAPTURED_SOURCE_ROOTS,
      workflows: [{ workflow: capturedWorkflow, source: 'project' }],
      errors: [],
    });

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain("requires input 'diff'");
    // Must NOT reach the generic "starting fresh in the same worktree" dispatch.
    expect(sent).not.toContain('starting fresh in the same worktree');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('nothing-to-resume-1');
    expect(mockCloseRunLiveOwner).toHaveBeenCalledTimes(1);
    expect(mockWithRunLiveOwner).not.toHaveBeenCalled();
  });

  /** Drive a refused resume (a lost race by default) with an optional supplied-input map. */
  async function dispatchLosingResumeRace(
    platform: ReturnType<typeof makePlatform>,
    workflowInputs?: Record<string, string>,
    refusal?: Error
  ): Promise<void> {
    // `mock.module` MERGES, so `WorkflowNotResumableError` is the real class here.
    const { WorkflowNotResumableError } = await import('../db/workflows');
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

  test('reports a deferred input error on a lost resume race when values were supplied', async () => {
    // The last exit that can abandon the dispatch after the gate deferred. The caller
    // supplied an undeclared key, so the violation is about something they actually did
    // and is worth surfacing — it is never re-raised anywhere else on this path.
    const platform = makePlatform();
    await dispatchLosingResumeRace(platform, { stlye: 'terse' });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('already being resumed');
    expect(sent).toContain('stlye');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('stays quiet about the deferred error on a lost race when nothing was supplied', async () => {
    // With nothing supplied the deferred violation is just "you must supply X", which is
    // moot when nothing will run. Appending it unconditionally produced nonsense on chat:
    // a demand to pass `--input`, immediately followed by a note that chat cannot, tacked
    // onto a message whose first line is already "No action taken".
    const platform = makePlatform();
    await dispatchLosingResumeRace(platform);

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('already being resumed');
    expect(sent).not.toContain('--input');
    expect(sent).not.toContain("requires input 'diff'");
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('a resume refused for capacity says so and starts no fresh run', async () => {
    const { WorkflowResourceBusyError } = await import('../db/workflows');
    const platform = makePlatform();
    await dispatchLosingResumeRace(
      platform,
      undefined,
      new WorkflowResourceBusyError('raced-run-1', { kind: 'run', id: 'holder-1' }, 'paused')
    );

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('**test-workflow** cannot resume yet.');
    expect(sent).toContain("resource owner 'holder-1' has priority. It stays paused");
    expect(sent).not.toContain('Error:');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'raced-run-1', refusal: 'paused' }),
      'orchestrator.resume_resource_busy'
    );
  });

  test('refuses immediately when the resumable run is not a continuation candidate', async () => {
    // A FAILED (non-paused) prior run is not continued — the user gets a
    // resume/abandon/force menu. Deferring the gate for that case swallowed the input
    // error entirely: the caller saw a generic menu and was never told which input was
    // wrong. Such an invocation must be refused up front, before isolation resolution.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'failed-prior-1',
          working_path: '/repos/test-repo/worktrees/failed',
          status: 'failed',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain("requires input 'diff'");
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    // Refused at the gate, so the resume menu never rendered and no isolation ran.
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
  });

  test('a resume of a required-input workflow is not re-gated', async () => {
    // The row already carries inputs validated at creation; re-gating with nothing
    // supplied would make every such resume impossible — a regression this feature
    // would otherwise introduce.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(
        makeWorkflowResult({
          inputs: { diff: { required: true } },
          resumeRun: makeResumableRun({ status: 'paused' }),
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).not.toContain("requires input 'diff'");
    expect(mockExecuteWorkflow).toHaveBeenCalled();
  });

  test('web workflow with resumable run resumes foreground (not background)', async () => {
    // Pins the priority order: resume detection comes before the background-dispatch
    // gate. If a resumable run exists, web workflows must resume foreground rather
    // than dispatching a fresh background run, or they would lose the paused run's
    // worktree state.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'web-noninteractive-resume-1',
          working_path: '/repos/test-repo/worktrees/web-feature',
          status: 'paused',
        })
      )
    );

    const platform = makePlatform(); // getPlatformType returns 'web'
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/web-feature');
  });

  test('a background-default adapter workflow with resumable run resumes foreground (not background)', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'web-noninteractive-resume-1',
          working_path: '/repos/test-repo/worktrees/web-feature',
          status: 'paused',
        })
      )
    );

    const platform = { ...makePlatform(), getPlatformType: mock(() => 'matrix-chat') };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/web-feature');
  });

  test('calls executeWorkflow on a non-web foreground platform', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));

    const platform = {
      ...makeForegroundPlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'slack' as const),
    };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });

  test('chat resume: resumes a paused run on chat platform when one exists', async () => {
    // Regression for #1741: chat platforms (slack/telegram/discord/github) used
    // to skip the resume lookup entirely and always start a fresh run, losing
    // the prior worktree and re-asking approval questions indefinitely. The
    // resume lookup must now run for ALL platforms; if a prior run is paused
    // or failed-by-approval, executeWorkflow runs on the prior worktree with
    // hydrated state.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'chat-resume-run-1',
          working_path: '/repos/test-repo/worktrees/chat-feature',
          status: 'paused',
        })
      )
    );

    const platform = {
      ...makeForegroundPlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'telegram' as const),
    };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    // cwd (position 3) is the prior run's working_path, not a fresh resolution
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/chat-feature');
    const opts = callArgs[callArgs.length - 1] as {
      preCreatedRun?: { id: string };
      priorCompletedNodes?: Map<string, string>;
    };
    expect(opts.preCreatedRun?.id).toBe('chat-resume-run-1');
    expect(opts.priorCompletedNodes?.size).toBeGreaterThan(0);
  });

  test('scopes resume query to (workflow, conversation, codebase)', async () => {
    // Persistent chat conversation IDs (Telegram chat_id, Slack thread) can
    // accumulate runs from multiple projects. The resume lookup must include
    // codebase_id so a fresh invocation for project A never resumes a stale
    // run from project B.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));

    const platform = {
      ...makeForegroundPlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'slack' as const),
    };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockFindResumableRunByParentConversation).toHaveBeenCalledWith(
      'test-workflow',
      'conv-1-db',
      'codebase-1'
    );
  });

  test('starts fresh run when no resumable run exists on chat platform', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult()));
    // Default mock returns null — no resumable run

    const platform = {
      ...makeForegroundPlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'discord' as const),
    };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    // cwd comes from validateAndResolveIsolation (default '/test/cwd'), not a prior worktree
    expect(callArgs[3]).toBe('/test/cwd');
    const opts = callArgs[callArgs.length - 1] as {
      preCreatedRun?: unknown;
      priorCompletedNodes?: unknown;
    };
    expect(opts.preCreatedRun).toMatchObject({
      id: 'prepared-run-id',
      status: 'pending',
      working_path: null,
    });
    expect(opts.priorCompletedNodes).toBeUndefined();
  });
});

// ─── handleWorkflowRunCommand — no project attached ──────────────────────────

describe('handleWorkflowRunCommand — no project attached', () => {
  const assistWorkflow = makeTestResolvedWorkflow({ name: 'assist' });

  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockListCodebases.mockReset();
    mockParseCommand.mockReset();
    mockHandleCommand.mockReset();
    mockUpdateConversation.mockClear();
    mockDispatchBackgroundWorkflow.mockClear();
    mockExecuteWorkflow.mockClear();

    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(makeConversation({ codebase_id: null }))
    );
    mockListCodebases.mockImplementation(() => Promise.resolve([makeCodebaseForSync()]));
  });

  test('asks for a project even when only one is registered', async () => {
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', 'assist'] });
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({
        success: true,
        message: 'Running workflow assist...',
        workflow: { kind: 'start', definition: assistWorkflow, args: 'test prompt' },
      })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
      actor: operator,
    });

    expect(mockUpdateConversation).not.toHaveBeenCalledWith(
      'conv-1-db',
      expect.objectContaining({ codebase_id: expect.anything() })
    );
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      'Which project should this workflow run on?\n\n- test-repo\n\n' +
        'Reply with the project name, or choose one with `/setproject <name>` and then use: /workflow run assist "test prompt"'
    );
  });

  test('asks for a project before resuming when only one is registered', async () => {
    const run = makeRun({ id: 'paused-run', workflow_name: 'assist', status: 'paused' });
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['resume', run.id] });
    mockHandleCommand.mockResolvedValueOnce({
      success: true,
      message: 'Resume requested.',
      workflow: { kind: 'resume', run },
    });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', `/workflow resume ${run.id}`, { actor: operator });

    expect(mockUpdateConversation).not.toHaveBeenCalledWith(
      'conv-1-db',
      expect.objectContaining({ codebase_id: expect.anything() })
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      'Choose a project for this conversation with `/setproject <name>`, then retry `/workflow resume paused-run`.\n\n- test-repo'
    );
  });
});

// ─── dispatchOrchestratorWorkflow — run-start notices ────────────────────────

// #2213 — every chat and console run funnels through dispatchOrchestratorWorkflow,
// so this is the one place that covers them all. The console's Start button
// synthesizes `/workflow run <name>` into exactly this path, which is why a picker
// badge alone was not enough.
describe('dispatchOrchestratorWorkflow — run-start notices', () => {
  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockParseCommand.mockReset();
    mockHandleCommand.mockReset();
    mockDispatchBackgroundWorkflow.mockClear();

    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(makeConversation({ codebase_id: 'codebase-1' }))
    );
    mockGetCodebase.mockImplementation(() => Promise.resolve(makeCodebaseForSync()));
  });

  function runsWorkflow(definition: ResolvedWorkflow, parseWarnings?: string[]): void {
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', definition.name] });
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({
        success: true,
        message: `Running workflow ${definition.name}...`,
        workflow: { kind: 'start', definition, args: 'test prompt', parseWarnings },
      })
    );
  }

  test('mirrors parse warnings into the conversation before the run starts', async () => {
    runsWorkflow(makeTestResolvedWorkflow({ name: 'assist' }), [
      "Node 'plan': unknown key 'interactive' will be ignored.",
    ]);

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
      actor: operator,
    });

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining("unknown key 'interactive' will be ignored")
    );
    // The warning must not replace the run — it precedes it.
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
  });

  // The contract behind persisting warnings on the run: a failed chat delivery
  // must not take the record with it. If this ever regresses, a Slack hiccup at
  // dispatch reproduces #2213 exactly — a dropped `interactive:` gate with
  // nothing anywhere to show for it.
  test('still hands warnings to the executor when sendMessage throws', async () => {
    runsWorkflow(makeTestResolvedWorkflow({ name: 'assist' }), [
      "Node 'plan': unknown key 'interactive' will be ignored.",
    ]);

    const platform = makePlatform();
    // Fail ONLY the warning delivery — a rate limit or over-length message on
    // that one call. Failing every send instead would throw out of an unrelated,
    // pre-existing `sendMessage` earlier in the turn and never reach this code.
    (platform.sendMessage as ReturnType<typeof mock>).mockImplementation(
      (_id: string, text: string) =>
        text.includes('declares keys the engine ignores')
          ? Promise.reject(new Error('rate limited'))
          : Promise.resolve()
    );

    // Must not throw: an undeliverable warning cannot fail the run.
    await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
      actor: operator,
    });

    // The run still started, and it carries the warnings — so the executor
    // records them as a `workflow_parse_warnings` event regardless of delivery.
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    const ctx = (mockDispatchBackgroundWorkflow as ReturnType<typeof mock>).mock.calls[0][0] as {
      parseWarnings?: readonly string[];
    };
    expect(ctx.parseWarnings).toEqual(["Node 'plan': unknown key 'interactive' will be ignored."]);
  });

  test('sends no parse-warning message for a clean workflow', async () => {
    runsWorkflow(makeTestResolvedWorkflow({ name: 'assist' }));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
      actor: operator,
    });

    expect(platform.sendMessage).not.toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('declares keys the engine ignores')
    );
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
  });

  // #2781 — a deprecated bundled default announces its removal on the surface
  // the run reports to, before any background dispatch.
  test('sends the deprecation notice at run start for a workflow declaring deprecated:', async () => {
    runsWorkflow(
      makeTestResolvedWorkflow({
        name: 'assist',
        deprecated: { message: 'Switch to the sdlc pack instead.' },
      })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
      actor: operator,
    });

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      '⚠️ `assist` is deprecated and will be removed in an upcoming release. ' +
        'Switch to the sdlc pack instead. ' +
        'To keep using this workflow after removal, copy the workflow file into your project ' +
        '`.archon/workflows/` or your global `~/.archon/workflows/`.'
    );
    // The notice must not replace the run — it precedes it.
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
  });

  test('sends no deprecation notice for a clean workflow', async () => {
    runsWorkflow(makeTestResolvedWorkflow({ name: 'assist' }));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
      actor: operator,
    });

    expect(platform.sendMessage).not.toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('will be removed in an upcoming release')
    );
  });

  test('a failed deprecation delivery does not stop the run', async () => {
    runsWorkflow(
      makeTestResolvedWorkflow({ name: 'assist', deprecated: { message: 'Switch instead.' } })
    );

    const platform = makePlatform();
    (platform.sendMessage as ReturnType<typeof mock>).mockImplementation(
      (_id: string, text: string) =>
        text.includes('will be removed in an upcoming release')
          ? Promise.reject(new Error('rate limited'))
          : Promise.resolve()
    );

    await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
      actor: operator,
    });
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
  });
});

describe('continueResolvedGateRun — chat gate continuation source (#2646)', () => {
  function makeGateRun(): WorkflowRun {
    return makeRun({
      id: 'run-gated',
      workflow_name: 'gated',
      conversation_id: 'conv-1-db',
      parent_conversation_id: 'conv-1-db',
      user_message: 'go',
      working_path: '/repos/test-repo/worktrees/feature',
    });
  }

  async function writeGateWorkflow(
    root: string,
    description: string,
    disableWorktree: boolean
  ): Promise<void> {
    await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
    await writeFile(
      join(root, '.archon', 'workflows', 'gated.yaml'),
      [
        'name: gated',
        `description: ${description}`,
        ...(disableWorktree ? ['worktree:', '  enabled: false'] : []),
        'nodes:',
        '  - id: work',
        '    prompt: Do the work',
        '',
      ].join('\n')
    );
  }

  beforeEach(async () => {
    mockGetWorkflowRunDb.mockResolvedValue(makeGateRun());
    mockExecuteWorkflow.mockClear();
    mockHydrateResumableRun.mockClear();
    mockValidateAndResolveIsolation.mockClear();
    // Reset, not clear: a queued `…Once` value that a test never consumes would otherwise
    // leak into the next one. Restores the factory default — a run predating captures.
    mockResolveContinuationWorkflow.mockReset();
    mockResolveContinuationWorkflow.mockImplementation(() => Promise.resolve(undefined));
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockResolvedValue({ workflows: [], errors: [] });
  });

  test("continues with the graph the run froze, not the chat turn's discovery list", async () => {
    const frozen = makeTestResolvedWorkflow({ name: 'gated', description: 'frozen' });
    mockResolveContinuationWorkflow.mockResolvedValueOnce({
      workflow: frozen,
      roots: CAPTURED_SOURCE_ROOTS,
      workflows: [{ workflow: frozen, source: 'project' }],
      errors: [],
    });

    await continueResolvedGateRun(
      makePlatform(),
      'conv-1',
      makeConversation({ codebase_id: 'codebase-1' }),
      makeCodebase(),
      makeGateRun(),
      'approve',
      operator
    );

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    const executed = (mockExecuteWorkflow.mock.calls[0] as unknown[])[4] as {
      description?: string;
    };
    expect(executed.description).toBe('frozen');
  });

  test('uses the captured graph for host worktree policy', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-host-captured-policy-')));
    const source = join(root, 'source');
    await writeGateWorkflow(source, 'Captured graph', true);
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: join(root, 'capture'),
    });
    // Same name, opposite policy. A host that bypasses the run capture creates
    // isolation here; the recorded graph explicitly disables it.
    await writeGateWorkflow(source, 'Conflicting live graph', false);
    mockResolveContinuationWorkflow.mockImplementationOnce((...args) =>
      realResolveContinuationWorkflow(...args)
    );
    mockDiscoverWorkflowsWithConfig.mockImplementation((...args) =>
      realDiscoverWorkflowsWithConfig(...args)
    );
    const run = makeGateRun();
    run.working_path = source;
    run.metadata = {
      workflow_source: {
        version: 1,
        root: capture.anchor.root,
        origin: capture.origin,
        captured_at: capture.manifest.captured_at,
        digest: capture.manifest.digest,
        source_config: capture.manifest.source_config,
        file_count: capture.manifest.file_count,
        byte_count: capture.manifest.byte_count,
      },
    };

    await continueResolvedGateRun(
      makePlatform(),
      'conv-1',
      makeConversation({ codebase_id: 'codebase-1' }),
      makeCodebase({ default_cwd: source }),
      run,
      'approve',
      operator
    );

    expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(
      ((mockExecuteWorkflow.mock.calls[0] as unknown[])[4] as { description: string }).description
    ).toBe('Captured graph');
  });

  test('continues a run whose workflow the current checkout no longer has', async () => {
    // The refusal this replaces was a false one: the chat turn's list describes the
    // checkout, and a workflow deleted or renamed since the run started is missing from
    // it — while the run's own captured source still holds exactly what it was running.
    const frozen = makeTestResolvedWorkflow({ name: 'gated', description: 'frozen' });
    mockResolveContinuationWorkflow.mockResolvedValueOnce({
      workflow: frozen,
      roots: CAPTURED_SOURCE_ROOTS,
      workflows: [{ workflow: frozen, source: 'project' }],
      errors: [],
    });

    const platform = makePlatform();
    await continueResolvedGateRun(
      platform,
      'conv-1',
      makeConversation({ codebase_id: 'codebase-1' }),
      makeCodebase(),
      makeGateRun(),
      'approve',
      operator
    );

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
      c => (c as unknown[])[1] as string
    );
    expect(messages.some(m => m.includes('was not found'))).toBe(false);
  });

  test('a run predating captures still resolves from the live list', async () => {
    // resolveContinuationWorkflow returns undefined for it, and the fallback is the only
    // thing that can name its graph.
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'gated', description: 'live' })],
      errors: [],
    });
    await continueResolvedGateRun(
      makePlatform(),
      'conv-1',
      makeConversation({ codebase_id: 'codebase-1' }),
      makeCodebase(),
      makeGateRun(),
      'approve',
      operator
    );

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    const executed = (mockExecuteWorkflow.mock.calls[0] as unknown[])[4] as {
      description?: string;
    };
    expect(executed.description).toBe('live');
  });

  test('an unreadable captured source refuses instead of running something else', async () => {
    mockResolveContinuationWorkflow.mockRejectedValueOnce(
      new Error('captured source digest mismatch')
    );

    const platform = makePlatform();
    await continueResolvedGateRun(
      platform,
      'conv-1',
      makeConversation({ codebase_id: 'codebase-1' }),
      makeCodebase(),
      makeGateRun(),
      'approve',
      operator
    );

    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
      c => (c as unknown[])[1] as string
    );
    expect(messages[0]).toContain('Continuation requested');
    expect(messages.some(m => m.includes('digest mismatch'))).toBe(true);
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
  });

  // #2910: both sides of the recovery branch. An ordinary resume failure leaves the
  // run resumable, so `/workflow resume` is right. A rejected terminal write leaves the
  // row non-terminal — `/workflow resume` refuses those, so that advice would send the
  // operator down a dead end for a run that may well have finished its work.
  async function continueWithRejection(
    platform: ReturnType<typeof makePlatform>,
    rejection: unknown
  ): Promise<string[]> {
    mockExecuteWorkflow.mockRejectedValueOnce(rejection);
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'gated', description: 'live' })],
      errors: [],
    });
    await continueResolvedGateRun(
      platform,
      'conv-1',
      makeConversation({ codebase_id: 'codebase-1' }),
      makeCodebase(),
      makeGateRun(),
      'approve',
      operator
    );
    return (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
      c => (c as unknown[])[1] as string
    );
  }

  test('an ordinary resume failure points at /workflow resume', async () => {
    const messages = await continueWithRejection(makePlatform(), new Error('resume boom'));

    expect(messages.some(m => m.includes('retry with `/workflow resume run-gated`'))).toBe(true);
  });

  test('a rejected terminal write says the status is unknown, not "retry the resume"', async () => {
    const messages = await continueWithRejection(
      makePlatform(),
      new TerminalStatusWriteError(new Error('db is gone'))
    );

    expect(messages.some(m => m.includes('final status could not be saved'))).toBe(true);
    expect(messages.some(m => m.includes('retry with `/workflow resume'))).toBe(false);
  });

  describe('recovery commands use the surface spelling', () => {
    // Mirrors the Slack adapter: its registered slash command is `/archon-workflow`.
    function makeSlackPlatform(): ReturnType<typeof makePlatform> &
      Pick<IPlatformAdapter, 'formatWorkflowCommand'> {
      return {
        ...makePlatform(),
        formatWorkflowCommand: (command: string) => `/archon-workflow ${command}`,
      };
    }

    function expectSlackSpelling(messages: string[]): void {
      const text = messages.join('\n');
      expect(text).toContain('/archon-workflow ');
      expect(text.replaceAll('/archon-workflow ', '')).not.toContain('/workflow ');
    }

    test('an ordinary resume failure', async () => {
      const messages = await continueWithRejection(makeSlackPlatform(), new Error('resume boom'));
      expect(messages.some(m => m.includes('`/archon-workflow resume run-gated`'))).toBe(true);
      expectSlackSpelling(messages);
    });

    test('a rejected terminal write', async () => {
      const messages = await continueWithRejection(
        makeSlackPlatform(),
        new TerminalStatusWriteError(new Error('db is gone'))
      );
      expect(messages.some(m => m.includes('`/archon-workflow get run-gated`'))).toBe(true);
      expectSlackSpelling(messages);
    });

    test('no project attached', async () => {
      const platform = makeSlackPlatform();
      await continueResolvedGateRun(
        platform,
        'conv-1',
        makeConversation(),
        null,
        makeGateRun(),
        'approve',
        operator
      );
      const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
        c => (c as unknown[])[1] as string
      );
      expectSlackSpelling(messages);
    });
  });
});
