import {
  mockRunLiveOwnerClose,
  mockClaimDetachedRunProcessOwner,
  mockStartRunLiveOwner,
  createTestWorkflowHost,
  setMockDetachedStopRequested,
} from '../test-support/workflow-command-harness';

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';

import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';

describe('workflowRunCommand — signal cleanup guard (#1123)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  function setupWorkflowMocks(): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });

    const conversationDb = require('@archon/core/db/conversations');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-1',
      platform: 'cli',
      platform_conversation_id: 'cli-123',
      title: null,
      is_active: true,
      codebase_id: null,
    });

    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/test/path',
    });
  }

  /** Flush the cleanup handler's fire-and-forget promise chain. */
  async function settleCleanup(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  /** The SIGTERM listeners added since `baseline` (i.e. by the command under test). */
  function addedSigtermListeners(baseline: readonly unknown[]): Array<() => void> {
    return process.listeners('SIGTERM').filter(listener => !baseline.includes(listener)) as Array<
      () => void
    >;
  }

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    // The cleanup chain ends in process.exit(1) — neuter it so invoking the
    // handler in-process doesn't kill the test runner.
    exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    setMockDetachedStopRequested(false);
    mockClaimDetachedRunProcessOwner.mockReset();
    mockClaimDetachedRunProcessOwner.mockImplementation(() => Promise.resolve(undefined));
    mockStartRunLiveOwner.mockClear();
    mockRunLiveOwnerClose.mockClear();

    const workflowsDb = require('@archon/core/db/workflows');
    (workflowsDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowsDb.getActiveWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowsDb.getWorkflowRun as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    delete process.env.ARCHON_DETACHED_RUN_OWNER;
  });

  it('removes SIGTERM/SIGINT handlers once executeWorkflow settles (no leak, no stacking)', async () => {
    const sigtermBaseline = process.listenerCount('SIGTERM');
    const sigintBaseline = process.listenerCount('SIGINT');

    let duringRunSigterm = 0;
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementation(async () => {
      duringRunSigterm = process.listenerCount('SIGTERM');
      return { success: true, workflowRunId: 'run-1' };
    });

    setupWorkflowMocks();
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});
    expect(duringRunSigterm).toBe(sigtermBaseline + 1);
    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('test-run-id', {});
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBaseline);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);

    // A second invocation in the same process must not stack handlers either.
    setupWorkflowMocks();
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});
    expect(duringRunSigterm).toBe(sigtermBaseline + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBaseline);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);

    (executeWorkflow as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve({ success: true, workflowRunId: 'test-run-id' })
    );
  });

  it('passes its claim to the failure writer when a gate wins before the signal', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(
      async (...args: Parameters<typeof import('@archon/workflows/executor').executeWorkflow>) => {
        args[7]?.onExecutionClaimed?.(null);
        // The signal lands while the handler is still registered.
        const [handler] = addedSigtermListeners(sigtermBefore);
        expect(handler).toBeDefined();
        (workflowsDb.failWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
          failed: false,
        });
        handler();
        await settleCleanup();
        return { success: true, workflowRunId: 'run-1', paused: true };
      }
    );

    setupWorkflowMocks();
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});

    expect(workflowsDb.failWorkflowRun).toHaveBeenCalledWith(
      'test-run-id',
      'Process terminated (SIGTERM)',
      { exitReason: 'process_terminated', signal: 'SIGTERM', expectedExecutionClaim: null }
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('still fails the run on a genuine mid-run interrupt (legacy behavior)', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    const shutdownOrder: string[] = [];
    mockRunLiveOwnerClose.mockImplementationOnce(async () => {
      shutdownOrder.push('owner-close');
    });
    exitSpy.mockImplementationOnce((() => {
      shutdownOrder.push('exit');
    }) as never);

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(
      async (...args: Parameters<typeof import('@archon/workflows/executor').executeWorkflow>) => {
        args[7]?.onExecutionClaimed?.(null);
        const [handler] = addedSigtermListeners(sigtermBefore);
        expect(handler).toBeDefined();
        handler();
        await settleCleanup();
        return { success: false, workflowRunId: 'run-1', error: 'interrupted' };
      }
    );

    setupWorkflowMocks();
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {})
    ).rejects.toThrow('Workflow failed');

    expect(workflowsDb.failWorkflowRun).toHaveBeenCalledWith(
      'test-run-id',
      'Process terminated (SIGTERM)',
      { exitReason: 'process_terminated', signal: 'SIGTERM', expectedExecutionClaim: null }
    );
    expect(shutdownOrder).toEqual(['owner-close', 'exit']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('lets an exact-run cancel controller own the lifecycle transition', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    process.env.ARCHON_DETACHED_RUN_OWNER = '1';
    process.env.ARCHON_DETACHED_LAUNCH_TOKEN = 'launch-token';
    // A detached child learns its run from the row its launcher handed over (#2872) —
    // the only shape the CLI produces for a fresh detached run.
    (workflowsDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'test-run-id',
      workflow_name: 'plan',
      status: 'pending',
      working_path: null,
      metadata: { cli_detached_launch_token: 'launch-token' },
    });

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    let runReadsAtSignalTime = -1;
    let failureWritesAtSignalTime = -1;
    (workflowsDb.failWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      failed: false,
    });
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(
      async (...args: Parameters<typeof import('@archon/workflows/executor').executeWorkflow>) => {
        args[7]?.onExecutionClaimed?.(null);
        setMockDetachedStopRequested(true);
        const readsBefore = (workflowsDb.getWorkflowRun as ReturnType<typeof mock>).mock.calls
          .length;
        const [handler] = addedSigtermListeners(sigtermBefore);
        expect(handler).toBeDefined();
        handler();
        await settleCleanup();
        runReadsAtSignalTime =
          (workflowsDb.getWorkflowRun as ReturnType<typeof mock>).mock.calls.length - readsBefore;
        failureWritesAtSignalTime = (workflowsDb.failWorkflowRun as ReturnType<typeof mock>).mock
          .calls.length;
        return { success: false, workflowRunId: 'test-run-id', error: 'interrupted' };
      }
    );

    setupWorkflowMocks();
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'test-run-id',
      })
    ).rejects.toThrow('Workflow failed');

    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('test-run-id', {
      detachedProcessPid: process.pid,
    });
    expect(runReadsAtSignalTime).toBe(0);
    expect(failureWritesAtSignalTime).toBe(0);
    expect(workflowsDb.failWorkflowRun).toHaveBeenCalledWith(
      'test-run-id',
      expect.stringContaining('Detached run failed to start'),
      { exitReason: 'launch_failed', pendingLaunchToken: 'launch-token' }
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockRunLiveOwnerClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    'does not own process group',
    'Windows run job broker did not become ready within 10000 ms',
  ])(
    'records a verified launch failure after a refused detached owner claim: %s',
    async message => {
      process.env.ARCHON_DETACHED_RUN_OWNER = '1';
      process.env.ARCHON_DETACHED_LAUNCH_TOKEN = 'launch-token';
      const workflowsDb = require('@archon/core/db/workflows');
      mockClaimDetachedRunProcessOwner.mockRejectedValueOnce(new Error(message));

      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
          detachedRunId: 'pending-child',
        })
      ).rejects.toThrow(message);

      expect(workflowsDb.failWorkflowRun).toHaveBeenCalledWith(
        'pending-child',
        expect.stringContaining(message),
        { exitReason: 'launch_failed', pendingLaunchToken: 'launch-token' }
      );
      expect(mockStartRunLiveOwner).not.toHaveBeenCalled();
      expect(process.env.ARCHON_DETACHED_RUN_OWNER).toBeUndefined();
    }
  );

  it('uses the source-reserved run id before workflow_started is emitted', async () => {
    const workflowsDb = require('@archon/core/db/workflows');

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(
      async (...args: Parameters<typeof import('@archon/workflows/executor').executeWorkflow>) => {
        args[7]?.onExecutionClaimed?.(null);
        // No workflow_started event is needed: source capture reserved the exact id
        // before execution or its live-owner endpoint became visible.
        const [handler] = addedSigtermListeners(sigtermBefore);
        expect(handler).toBeDefined();
        handler();
        await settleCleanup();
        return { success: true, workflowRunId: 'run-1' };
      }
    );

    setupWorkflowMocks();
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});

    expect(workflowsDb.failWorkflowRun).toHaveBeenCalledWith(
      'test-run-id',
      'Process terminated (SIGTERM)',
      { exitReason: 'process_terminated', signal: 'SIGTERM', expectedExecutionClaim: null }
    );
    expect(workflowsDb.getActiveWorkflowRun).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
