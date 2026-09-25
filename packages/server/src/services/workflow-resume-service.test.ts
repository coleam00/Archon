import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowPlatform, WorkflowDeps } from '@archon/workflows/deps';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { WorkflowResumeCursor } from '@archon/workflows/store';
import type { resumeWorkflow } from '@archon/core/operations';
import type { resolveRunWorkflow } from '@archon/core/workflows/resolve-run-workflow';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';

const mockListDueWorkflowContinuations = mock(async () => [] as WorkflowRun[]);
const mockDeferWorkflowContinuation = mock(async () => undefined);
const mockResumeWorkflow = mock<typeof resumeWorkflow>(async (_runId: string) => {
  throw new Error('unused');
});
const mockResolveRunWorkflow = mock<typeof resolveRunWorkflow>(async () => ({
  ok: false,
  message: 'unused',
}));
const mockHydrateResumableRun = mock<
  (typeof import('@archon/workflows/executor'))['hydrateResumableRun']
>(async () => null);
const mockExecuteWorkflow = mock<(typeof import('@archon/workflows/executor'))['executeWorkflow']>(
  async () => ({
    success: true,
    workflowRunId: 'run-1',
    summary: 'done',
  })
);
const runLiveOwnerCalls: string[] = [];
const mockCloseRunLiveOwner = mock(async () => {
  runLiveOwnerCalls.push('close');
});
const mockStartRunLiveOwner = mock<
  (typeof import('@archon/core/services/run-live-owner'))['startRunLiveOwner']
>(async runId => {
  runLiveOwnerCalls.push(`start:${runId}`);
  return { close: mockCloseRunLiveOwner, isStopRequested: () => false };
});
const mockStoreFailWorkflowRun = mock<IWorkflowStore['failWorkflowRun']>(async () => undefined);
const mockGetWorkflowRunStatus = mock<IWorkflowStore['getWorkflowRunStatus']>(
  async () => 'running'
);
const mockWorkflowDeps = {
  store: {
    failWorkflowRun: mockStoreFailWorkflowRun,
    getWorkflowRunStatus: mockGetWorkflowRunStatus,
  },
} as unknown as WorkflowDeps;
class MockWorkflowNotResumableError extends Error {
  constructor(
    readonly runId: string,
    readonly currentStatus: string
  ) {
    super('Workflow run is not resumable');
  }
}

mock.module('@archon/core', () => ({
  createChildWorktreeResolver: mock(() => undefined),
  createWorkflowDeps: mock(() => mockWorkflowDeps),
}));
mock.module('@archon/core/operations', () => ({
  resumeWorkflow: mockResumeWorkflow,
}));
mock.module('@archon/core/workflows/resolve-run-workflow', () => ({
  resolveRunWorkflow: mockResolveRunWorkflow,
}));
mock.module('@archon/core/services/run-live-owner', () => ({
  startRunLiveOwner: mockStartRunLiveOwner,
}));
mock.module('@archon/core/db/codebases', () => ({ getCodebase: mock(async () => null) }));
mock.module('@archon/core/db/workflows', () => ({
  listDueWorkflowContinuations: mockListDueWorkflowContinuations,
  deferWorkflowContinuation: mockDeferWorkflowContinuation,
  WorkflowNotResumableError: MockWorkflowNotResumableError,
}));
mock.module('@archon/paths', () => ({
  createLogger: () => ({
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  }),
  getArchonWorkspacesPath: () => '/tmp/workspaces',
}));
mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
  hydrateResumableRun: mockHydrateResumableRun,
  resolveContinuationWorkflow: mock(async () => undefined),
}));

import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';
import { HeadlessPlatform } from '../adapters/headless';

import {
  resumeWorkflowRunFromServer,
  scanDueWorkflowContinuations,
  workflowResumeConversationId,
  workflowResumeTargetForConversation,
} from './workflow-resume-service';

function run(
  id: string,
  status: 'paused' | 'failed',
  metadata: Record<string, unknown>
): WorkflowRun {
  return {
    id,
    workflow_name: 'deliver',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status,
    outcome: null,
    user_message: 'deliver',
    metadata,
    started_at: new Date('2026-08-24T10:00:00.000Z'),
    completed_at: status === 'failed' ? new Date('2026-08-24T10:01:00.000Z') : null,
    last_activity_at: null,
    working_path: '/tmp/worktree',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
  };
}

describe('workflow continuation scanner', () => {
  beforeEach(() => {
    mockListDueWorkflowContinuations.mockReset();
    mockDeferWorkflowContinuation.mockReset();
    mockDeferWorkflowContinuation.mockResolvedValue(undefined);
    mockResumeWorkflow.mockReset();
    mockResumeWorkflow.mockImplementation(async () => {
      throw new Error('unused');
    });
    mockResolveRunWorkflow.mockReset();
    mockResolveRunWorkflow.mockResolvedValue({ ok: false, message: 'unused' });
    mockHydrateResumableRun.mockReset();
    mockHydrateResumableRun.mockResolvedValue(null);
    mockExecuteWorkflow.mockReset();
    mockExecuteWorkflow.mockResolvedValue({
      success: true,
      workflowRunId: 'run-1',
      summary: 'done',
    });
    mockStoreFailWorkflowRun.mockReset();
    mockStoreFailWorkflowRun.mockResolvedValue(undefined);
    mockGetWorkflowRunStatus.mockReset();
    mockGetWorkflowRunStatus.mockResolvedValue('running');
    runLiveOwnerCalls.length = 0;
    mockStartRunLiveOwner.mockClear();
    mockCloseRunLiveOwner.mockClear();
  });

  // #2910: the headless scanner is the unattended path — nothing revisits a row it
  // leaves at 'running' (listDueWorkflowContinuations selects paused/failed only).
  // Both sides of the branch are asserted through the real engine wrapper: an
  // ordinary rejection gets the engine's compensating write, while a rejected
  // terminal write must not get a second one.
  describe('rejected execution', () => {
    const startHeadlessResume = async (rejection: unknown): Promise<void> => {
      const paused = run('wait-headless', 'paused', {});
      mockResumeWorkflow.mockResolvedValueOnce(paused);
      mockResolveRunWorkflow.mockResolvedValueOnce({
        ok: true,
        workflow: makeTestResolvedWorkflow({ name: 'deliver' }),
      });
      mockHydrateResumableRun.mockResolvedValueOnce({
        preCreatedRun: { ...paused, status: 'running' },
        priorCompletedNodes: new Map(),
        priorUsage: { costUsd: 0 },
        priorNodeSessions: [],
      });
      mockExecuteWorkflow.mockRejectedValueOnce(rejection);

      await expect(resumeWorkflowRunFromServer(paused)).resolves.toBe(true);
      // The rejection handler runs off the voided promise.
      await Promise.resolve();
      await Promise.resolve();
    };

    test('marks the run failed when execution rejects with an ordinary error', async () => {
      mockStoreFailWorkflowRun.mockImplementationOnce(async () => {
        runLiveOwnerCalls.push('fail');
      });
      await startHeadlessResume(new Error('resume boom'));

      expect(mockStoreFailWorkflowRun).toHaveBeenCalledTimes(1);
      expect(mockStoreFailWorkflowRun.mock.calls[0]?.[0]).toBe('wait-headless');
      expect(runLiveOwnerCalls).toEqual(['start:wait-headless', 'fail', 'close']);
    });

    test('does not compensate a rejected terminal write with a second failure write', async () => {
      await startHeadlessResume(new TerminalStatusWriteError(new Error('db is gone')));

      expect(mockStoreFailWorkflowRun).not.toHaveBeenCalled();
    });

    test('tells a watching conversation the status could not be saved', async () => {
      const paused = run('wait-headless-web', 'paused', {});
      mockResumeWorkflow.mockResolvedValueOnce(paused);
      mockResolveRunWorkflow.mockResolvedValueOnce({
        ok: true,
        workflow: makeTestResolvedWorkflow({ name: 'deliver' }),
      });
      mockHydrateResumableRun.mockResolvedValueOnce({
        preCreatedRun: { ...paused, status: 'running' },
        priorCompletedNodes: new Map(),
        priorUsage: { costUsd: 0 },
        priorNodeSessions: [],
      });
      mockExecuteWorkflow.mockRejectedValueOnce(
        new TerminalStatusWriteError(new Error('db is gone'))
      );
      const platform = {
        sendMessage: mock(async () => undefined),
        getStreamingMode: () => 'batch' as const,
        getPlatformType: () => 'web',
      } satisfies IWorkflowPlatform;

      await expect(
        resumeWorkflowRunFromServer(paused, undefined, {
          kind: 'platform',
          destination: {
            platform,
            conversationId: 'web-worker-conv',
            resultConversationId: 'visible-web-conv',
          },
        })
      ).resolves.toBe(true);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockStoreFailWorkflowRun).not.toHaveBeenCalled();
      const message = (platform.sendMessage.mock.calls[0] as unknown[] | undefined)?.[1] as
        | string
        | undefined;
      expect(message).toContain('final status could not be saved');
    });
  });

  test('resumes due waits and quota continuations through the shared resume CAS', async () => {
    const scheduled = {
      reason: 'quota' as const,
      resumeAt: '2026-08-24T11:00:00.000Z',
      deadlineAt: '2026-08-25T11:00:00.000Z',
      attempt: 1,
      maxAttempts: 2,
      error: 'usage limit reached',
    };
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('wait-1', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
      }),
      run('quota-1', 'failed', { scheduled_resume: scheduled }),
    ]);
    const resume = mock(async (_run: WorkflowRun, _cursor: WorkflowResumeCursor) => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(2);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls[0]).toEqual([
      expect.objectContaining({ id: 'wait-1' }),
      { kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T11:00:00.000Z' },
    ]);
    expect(resume.mock.calls[1]).toEqual([
      expect.objectContaining({ id: 'quota-1' }),
      { kind: 'quota', attempt: 1, resumeAt: '2026-08-24T11:00:00.000Z' },
    ]);
  });

  test('does not schedule an action-required wait even if a malformed due query returns it', async () => {
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('attention-1', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'rerun-ci',
          kind: 'attention',
          waitingSince: '2026-08-24T10:00:00.000Z',
          message: 'Re-run CI, then resume.',
        },
      }),
    ]);
    const resume = mock(async () => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(0);
    expect(resume).not.toHaveBeenCalled();
    expect(mockDeferWorkflowContinuation).not.toHaveBeenCalled();
  });

  test('routes background web execution through its worker and results through the parent', () => {
    const background = {
      ...run('wait-web', 'paused', {}),
      conversation_id: 'worker-conv',
      parent_conversation_id: 'visible-conv',
    };
    expect(workflowResumeConversationId(background)).toBe('worker-conv');

    const webPlatform = {
      sendMessage: mock(async () => undefined),
      getStreamingMode: () => 'batch' as const,
      getPlatformType: () => 'web',
    } satisfies IWorkflowPlatform;
    expect(
      workflowResumeTargetForConversation(
        { platform_type: 'web', platform_conversation_id: 'web-worker-123' },
        new Map([['web', webPlatform]]),
        'web-worker-123',
        'visible-web-conv'
      )
    ).toEqual({
      kind: 'platform',
      destination: {
        platform: webPlatform,
        conversationId: 'web-worker-123',
        resultConversationId: 'visible-web-conv',
      },
    });

    const slackPlatform = {
      sendMessage: mock(async () => undefined),
      getStreamingMode: () => 'batch' as const,
      getPlatformType: () => 'slack',
    } satisfies IWorkflowPlatform;
    expect(
      workflowResumeTargetForConversation(
        { platform_type: 'slack', platform_conversation_id: 'slack-thread' },
        new Map([['slack', slackPlatform]]),
        'hidden-worker-id',
        'slack-thread'
      )
    ).toEqual({
      kind: 'platform',
      destination: {
        platform: slackPlatform,
        conversationId: 'hidden-worker-id',
        resultConversationId: 'slack-thread',
      },
    });

    const unavailable = workflowResumeTargetForConversation(
      { platform_type: 'telegram', platform_conversation_id: 'chat-1' },
      new Map()
    );
    expect(unavailable).toEqual({
      kind: 'unavailable',
      reason: "origin adapter 'telegram' is unavailable",
    });
    expect(
      workflowResumeTargetForConversation(
        { platform_type: 'cli', platform_conversation_id: 'cli-1' },
        new Map()
      )
    ).toEqual({ kind: 'headless' });
  });

  test('resumes a paused wait even when the run retains historical quota metadata', async () => {
    const scheduled = {
      reason: 'quota' as const,
      resumeAt: '2026-08-24T10:30:00.000Z',
      deadlineAt: '2026-08-25T10:30:00.000Z',
      attempt: 1,
      maxAttempts: 2,
      error: 'usage limit reached',
      triggeredAt: '2026-08-24T10:30:01.000Z',
    };
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('wait-after-quota', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:31:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
        scheduled_resume: scheduled,
      }),
    ]);
    const resume = mock(async (_run: WorkflowRun, _cursor: WorkflowResumeCursor) => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  test('uses the originating platform destination when one is available', async () => {
    const paused = run('wait-platform', 'paused', {});
    const cursor = {
      kind: 'wait' as const,
      nodeId: 'delay',
      resumeAt: '2026-08-24T11:00:00.000Z',
    };
    mockResumeWorkflow.mockResolvedValueOnce(paused);
    mockResolveRunWorkflow.mockResolvedValueOnce({
      ok: true,
      workflow: makeTestResolvedWorkflow({ name: 'deliver' }),
    });
    mockHydrateResumableRun.mockResolvedValueOnce({
      preCreatedRun: { ...paused, status: 'running' },
      priorCompletedNodes: new Map(),
      priorUsage: { costUsd: 0 },
      priorNodeSessions: [],
    });
    const platform = {
      sendMessage: mock(async () => undefined),
      getStreamingMode: () => 'batch' as const,
      getPlatformType: () => 'slack',
    } satisfies IWorkflowPlatform;

    await expect(
      resumeWorkflowRunFromServer(
        paused,
        undefined,
        {
          kind: 'platform',
          destination: { platform, conversationId: 'slack-thread-123' },
        },
        cursor
      )
    ).resolves.toBe(true);

    expect(mockHydrateResumableRun).toHaveBeenCalledWith(expect.anything(), paused, cursor);
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow.mock.calls[0]?.[1]).toBe(platform);
    expect(mockExecuteWorkflow.mock.calls[0]?.[2]).toBe('slack-thread-123');
  });

  test('prepares and resumes from the freshly validated run row', async () => {
    const selected = run('wait-refreshed', 'paused', {});
    const refreshed = {
      ...selected,
      conversation_id: 'refreshed-conversation',
      user_message: 'refreshed request',
      working_path: '/tmp/refreshed-worktree',
      user_id: 'refreshed-user',
    };
    mockResumeWorkflow.mockResolvedValueOnce(refreshed);
    mockResolveRunWorkflow.mockResolvedValueOnce({
      ok: true,
      workflow: makeTestResolvedWorkflow({ name: 'deliver' }),
    });
    mockHydrateResumableRun.mockResolvedValueOnce({
      preCreatedRun: { ...refreshed, status: 'running' },
      priorCompletedNodes: new Map(),
      priorUsage: { costUsd: 0 },
      priorNodeSessions: [],
    });

    await expect(resumeWorkflowRunFromServer(selected)).resolves.toBe(true);

    expect(mockResumeWorkflow).toHaveBeenCalledWith(selected.id);
    expect(mockResolveRunWorkflow).toHaveBeenCalledWith(
      refreshed,
      '/tmp/workspaces',
      expect.any(HeadlessPlatform)
    );
    expect(mockHydrateResumableRun).toHaveBeenCalledWith(expect.anything(), refreshed, undefined);
    expect(mockExecuteWorkflow.mock.calls[0]?.[2]).toBe('refreshed-conversation');
    expect(mockExecuteWorkflow.mock.calls[0]?.[3]).toBe('/tmp/refreshed-worktree');
    expect(mockExecuteWorkflow.mock.calls[0]?.[5]).toBe('refreshed request');
    expect(mockExecuteWorkflow.mock.calls[0]?.[7]).toEqual(
      expect.objectContaining({ userId: 'refreshed-user' })
    );
  });

  test('refuses an unresolved source before acquiring the live owner or claiming the run', async () => {
    const paused = run('wait-source-missing', 'paused', {});
    mockResumeWorkflow.mockResolvedValueOnce(paused);
    mockResolveRunWorkflow.mockResolvedValueOnce({
      ok: false,
      message: 'recorded workflow source is unavailable',
    });

    await expect(resumeWorkflowRunFromServer(paused)).resolves.toBe(false);

    expect(mockResolveRunWorkflow).toHaveBeenCalledWith(
      paused,
      '/tmp/workspaces',
      expect.any(HeadlessPlatform)
    );
    expect(mockStartRunLiveOwner).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('returns after admission while execution stays detached under the live owner', async () => {
    const paused = run('wait-owned', 'paused', {});
    let resolveExecution!: (result: {
      success: true;
      workflowRunId: string;
      summary: string;
    }) => void;
    const execution = new Promise<{
      success: true;
      workflowRunId: string;
      summary: string;
    }>(resolve => {
      resolveExecution = resolve;
    });
    mockResumeWorkflow.mockResolvedValueOnce(paused);
    mockResolveRunWorkflow.mockResolvedValueOnce({
      ok: true,
      workflow: makeTestResolvedWorkflow({ name: 'deliver' }),
    });
    mockHydrateResumableRun.mockImplementationOnce(async () => {
      runLiveOwnerCalls.push('hydrate');
      return {
        preCreatedRun: { ...paused, status: 'running' },
        priorCompletedNodes: new Map(),
        priorUsage: { costUsd: 0 },
        priorNodeSessions: [],
      };
    });
    mockExecuteWorkflow.mockImplementationOnce(() => {
      runLiveOwnerCalls.push('execute');
      return execution;
    });

    await expect(resumeWorkflowRunFromServer(paused)).resolves.toBe(true);
    expect(runLiveOwnerCalls).toEqual(['start:wait-owned', 'hydrate', 'execute']);

    resolveExecution({ success: true, workflowRunId: paused.id, summary: 'done' });
    await Promise.resolve();
    await Promise.resolve();
    expect(runLiveOwnerCalls).toEqual(['start:wait-owned', 'hydrate', 'execute', 'close']);
  });

  test('closes the owner when hydration declines the execution claim', async () => {
    const paused = run('wait-empty', 'paused', {});
    mockResumeWorkflow.mockResolvedValueOnce(paused);
    mockResolveRunWorkflow.mockResolvedValueOnce({
      ok: true,
      workflow: makeTestResolvedWorkflow({ name: 'deliver' }),
    });

    await expect(resumeWorkflowRunFromServer(paused)).resolves.toBe(false);

    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('wait-empty');
    expect(mockCloseRunLiveOwner).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('closes the owner when another caller wins the resume claim', async () => {
    const paused = run('wait-lost-race', 'paused', {});
    mockResumeWorkflow.mockResolvedValueOnce(paused);
    mockResolveRunWorkflow.mockResolvedValueOnce({
      ok: true,
      workflow: makeTestResolvedWorkflow({ name: 'deliver' }),
    });
    mockHydrateResumableRun.mockRejectedValueOnce(
      new MockWorkflowNotResumableError(paused.id, 'running')
    );

    await expect(resumeWorkflowRunFromServer(paused)).resolves.toBe(false);

    expect(mockStartRunLiveOwner).toHaveBeenCalledWith(paused.id);
    expect(mockCloseRunLiveOwner).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('surfaces a resumed background-web result when owner cleanup fails', async () => {
    const paused = run('wait-web', 'paused', {});
    const cleanupError = new Error('owner cleanup failed');
    mockResumeWorkflow.mockResolvedValueOnce(paused);
    mockResolveRunWorkflow.mockResolvedValueOnce({
      ok: true,
      workflow: makeTestResolvedWorkflow({ name: 'deliver' }),
    });
    mockHydrateResumableRun.mockResolvedValueOnce({
      preCreatedRun: { ...paused, status: 'running' },
      priorCompletedNodes: new Map(),
      priorUsage: { costUsd: 0 },
      priorNodeSessions: [],
    });
    const platform = {
      sendMessage: mock(async () => undefined),
      getStreamingMode: () => 'batch' as const,
      getPlatformType: () => 'web',
    } satisfies IWorkflowPlatform;
    mockCloseRunLiveOwner.mockImplementationOnce(async () => {
      runLiveOwnerCalls.push('close');
      throw cleanupError;
    });

    await expect(
      resumeWorkflowRunFromServer(paused, undefined, {
        kind: 'platform',
        destination: {
          platform,
          conversationId: 'web-worker-conv',
          resultConversationId: 'visible-web-conv',
        },
      })
    ).resolves.toBe(true);
    await Promise.resolve();

    expect(mockExecuteWorkflow.mock.calls[0]?.[2]).toBe('web-worker-conv');

    expect(platform.sendMessage).toHaveBeenCalledWith('visible-web-conv', 'done', {
      category: 'workflow_result',
      segment: 'new',
      workflowResult: { workflowName: 'deliver', runId: 'run-1' },
    });
  });

  test('does not claim a continuation when its recorded destination is unavailable', async () => {
    const paused = run('wait-unavailable', 'paused', {});

    await expect(
      resumeWorkflowRunFromServer(paused, undefined, {
        kind: 'unavailable',
        reason: "origin adapter 'telegram' is unavailable",
      })
    ).resolves.toBe(false);

    expect(mockResumeWorkflow).not.toHaveBeenCalled();
    expect(mockResolveRunWorkflow).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
  });

  test('does not claim a container continuation that only the CLI can rewire', async () => {
    const paused = run('wait-container', 'paused', { isolation: 'container' });

    await expect(resumeWorkflowRunFromServer(paused)).resolves.toBe(false);

    expect(mockResumeWorkflow).not.toHaveBeenCalled();
    expect(mockResolveRunWorkflow).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
  });

  test('backs off a due row when execution prerequisites are unavailable', async () => {
    mockListDueWorkflowContinuations.mockResolvedValueOnce([
      run('wait-poison', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
      }),
    ]);
    const resume = mock(async () => false);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:00.000Z'), resume)
    ).resolves.toBe(0);

    expect(mockDeferWorkflowContinuation).toHaveBeenCalledWith(
      'wait-poison',
      '2026-08-24T11:01:00.000Z',
      { kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T11:00:00.000Z' }
    );
  });

  test('logs and backs off a row when destination resolution rejects', async () => {
    mockListDueWorkflowContinuations.mockResolvedValueOnce([
      run('wait-reject', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
      }),
    ]);
    const resume = mock(async () => {
      throw new Error('conversation lookup failed');
    });

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:00.000Z'), resume)
    ).resolves.toBe(0);

    expect(mockDeferWorkflowContinuation).toHaveBeenCalledWith(
      'wait-reject',
      '2026-08-24T11:01:00.000Z',
      { kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T11:00:00.000Z' }
    );
  });
});
