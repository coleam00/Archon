// @archon-test-isolated
import { describe, test, expect, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { getArchonWorkspacesPath } from '@archon/paths/archon-paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { createServer } from 'node:net';
import { runLiveOwnerPath, startRunLiveOwner } from '../../services/run-live-owner';
import { DetachedRunOwnerUnavailableError } from '../../services/run-owner-stop';
import {
  operator,
  mockGetWorkflowRun,
  mockListWorkflowEvents,
  mockCancelWorkflowRun,
  mockFindChildRuns,
  mockGetRunAncestry,
  noOwnerAnswers,
  mockRequestDetachedRunStop,
  makePausedRun,
  makeRunWithScratch,
  CancelRefusedError,
  cancelWorkflow,
} from './test-harness';

const trackTempRoot = trackTempRoots();

describe('cancelWorkflow', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockClear();
    mockListWorkflowEvents.mockReset();
    mockListWorkflowEvents.mockResolvedValue([]);
    mockCancelWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockImplementation(() => Promise.resolve({ cancelled: true }));
    mockFindChildRuns.mockClear();
    mockFindChildRuns.mockImplementation(() => Promise.resolve([]));
    mockRequestDetachedRunStop.mockClear();
    mockRequestDetachedRunStop.mockImplementation(noOwnerAnswers);
    mockGetRunAncestry.mockReset();
    mockGetRunAncestry.mockImplementation(() => Promise.resolve([]));
  });

  async function refusal(runId = 'run-1'): Promise<InstanceType<typeof CancelRefusedError>> {
    const error = await cancelWorkflow(runId, operator).then(
      () => undefined,
      (rejection: unknown) => rejection
    );
    expect(error).toBeInstanceOf(CancelRefusedError);
    return error as InstanceType<typeof CancelRefusedError>;
  }

  test('cancels cooperatively a run this process executes, without a stop request', async () => {
    // A real endpoint published by this process: the server's own runs look like this.
    const runId = `cancel-in-process-${crypto.randomUUID()}`;
    const owner = await startRunLiveOwner(runId);
    try {
      mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ id: runId, status: 'running' }));

      const result = await cancelWorkflow(runId, operator);

      expect(result).toMatchObject({ kind: 'cooperative', cancelled: true });
      expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
      expect(mockCancelWorkflowRun).toHaveBeenCalledWith(runId, { cancel_reason: 'operator' });
    } finally {
      await owner.close();
    }
  });

  // A nested sub-run publishes no endpoint of its own, but the executor still stamps it
  // with an execution owner (its root's process), so the sub-run's own record cannot tell
  // "runs inside a live root" from "its owner is gone". Only the root's owner can.
  function nestedSubRun(rootRunId: string): WorkflowRun {
    mockGetRunAncestry.mockResolvedValueOnce([
      makePausedRun({ id: 'parent-run', status: 'running', parent_run_id: rootRunId }),
      makePausedRun({ id: rootRunId, status: 'running' }),
    ]);
    return makePausedRun({
      status: 'running',
      parent_run_id: 'parent-run',
      metadata: { execution_owner: { host: 'build-box', pid: 4242 } },
    });
  }

  test('cancels a sub-run cooperatively when its root is executed by this process', async () => {
    const rootRunId = `cancel-root-${crypto.randomUUID()}`;
    const rootOwner = await startRunLiveOwner(rootRunId);
    try {
      mockGetWorkflowRun.mockResolvedValueOnce(nestedSubRun(rootRunId));

      const result = await cancelWorkflow('run-1', operator);

      expect(result).toMatchObject({ kind: 'cooperative', cancelled: true });
      expect(mockRequestDetachedRunStop).toHaveBeenCalledWith('run-1');
      expect(mockGetRunAncestry).toHaveBeenCalledWith('run-1');
      expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1', { cancel_reason: 'operator' });
    } finally {
      await rootOwner.close();
    }
  });

  test("cancels a sub-run cooperatively when its root's owner in another process answers", async () => {
    const rootRunId = `cancel-root-${crypto.randomUUID()}`;
    // Something listening at the root's endpoint that this process did not publish.
    const listener = createServer(socket => socket.destroy());
    await new Promise<void>(resolve => listener.listen(runLiveOwnerPath(rootRunId), resolve));
    try {
      mockGetWorkflowRun.mockResolvedValueOnce(nestedSubRun(rootRunId));

      const result = await cancelWorkflow('run-1', operator);

      expect(result).toMatchObject({ kind: 'cooperative', cancelled: true });
      expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1', { cancel_reason: 'operator' });
    } finally {
      await new Promise(resolve => listener.close(resolve));
    }
  });

  for (const type of ['bash', 'script'] as const) {
    for (const ownerKind of ['local', 'root', 'remote-root'] as const) {
      for (const eventType of ['node_started', 'node_completed']) {
        test(`reports ${eventType} ${type} work for a ${ownerKind} cooperative owner`, async () => {
          const rootId = `cancel-warning-${crypto.randomUUID()}`;
          const listener =
            ownerKind === 'remote-root' ? createServer(socket => socket.destroy()) : undefined;
          if (listener)
            await new Promise<void>(resolve => listener.listen(runLiveOwnerPath(rootId), resolve));
          const owner = listener
            ? { close: () => new Promise<void>(resolve => listener.close(() => resolve())) }
            : await startRunLiveOwner(rootId);
          const run =
            ownerKind === 'local'
              ? makePausedRun({ id: rootId, status: 'running' })
              : nestedSubRun(rootId);
          mockGetWorkflowRun.mockResolvedValueOnce(run);
          mockListWorkflowEvents.mockImplementation(async id =>
            id === run.id
              ? [
                  {
                    id: 'completed-command',
                    workflow_run_id: run.id,
                    event_type: eventType,
                    step_name: 'completed',
                    step_index: null,
                    created_at: new Date().toISOString(),
                    data: { type },
                  },
                ]
              : []
          );
          try {
            const result = await cancelWorkflow(run.id, operator);
            expect(result.cleanupWarnings?.join(' ')).toContain('untracked background work');
            expect(result.cleanupWarnings?.join(' ')).toContain('verify ownership');
            expect(mockCancelWorkflowRun).toHaveBeenCalledWith(run.id, {
              cancel_reason: 'operator',
              warnings: result.cleanupWarnings,
              reason: result.cleanupWarnings?.join('\n'),
            });
            if (ownerKind !== 'remote-root') {
              mockGetWorkflowRun.mockResolvedValueOnce(
                makePausedRun({ id: rootId, status: 'running' })
              );
              mockListWorkflowEvents.mockResolvedValueOnce([]);
              const clean = await cancelWorkflow(rootId, operator);
              expect(clean.cleanupWarnings).toBeUndefined();
            }
          } finally {
            await owner.close();
          }
        });
      }
    }
  }

  test('includes completed child commands and omits result warnings when cancellation loses the race', async () => {
    const id = `cancel-child-${crypto.randomUUID()}`;
    const owner = await startRunLiveOwner(id);
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ id, status: 'running' }));
    mockFindChildRuns.mockResolvedValueOnce([
      makePausedRun({ id: 'child', parent_run_id: id, status: 'completed' }),
    ]);
    mockListWorkflowEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'child-completed',
        workflow_run_id: 'child',
        event_type: 'node_completed',
        step_name: 'command',
        step_index: null,
        created_at: new Date().toISOString(),
        data: { type: 'bash' },
      },
    ]);
    mockCancelWorkflowRun.mockResolvedValueOnce({ cancelled: false });
    try {
      const result = await cancelWorkflow(id, operator);
      expect(result).toMatchObject({ kind: 'cooperative', cancelled: false });
      expect(result.cleanupWarnings).toBeUndefined();
      expect(mockCancelWorkflowRun.mock.calls[0]?.[1]?.warnings?.join(' ')).toContain(
        'untracked background work'
      );
    } finally {
      await owner.close();
    }
  });

  for (const type of ['bash', 'script']) {
    for (const eventType of ['node_started', 'node_completed']) {
      test(`reports every affected child and grandchild checkout for ${eventType} ${type}`, async () => {
        const id = `cancel-checkouts-${crypto.randomUUID()}`;
        const owner = await startRunLiveOwner(id);
        const parent = makePausedRun({ id, status: 'running', working_path: '/parent' });
        const child = makePausedRun({ id: 'child', parent_run_id: id, working_path: '/child' });
        const grandchild = makePausedRun({
          id: 'grandchild',
          parent_run_id: child.id,
          working_path: '/grandchild',
        });
        mockGetWorkflowRun.mockResolvedValueOnce(parent);
        mockFindChildRuns.mockImplementation(async runId =>
          runId === id ? [child] : runId === child.id ? [grandchild] : []
        );
        mockListWorkflowEvents.mockImplementation(async runId => [
          {
            id: `${runId}-command`,
            workflow_run_id: runId,
            event_type: eventType,
            step_name: 'command',
            step_index: null,
            created_at: new Date().toISOString(),
            data: { type },
          },
        ]);
        try {
          const result = await cancelWorkflow(id, operator);
          for (const run of [parent, child, grandchild]) {
            expect(result.cleanupWarnings).toContainEqual(
              expect.stringContaining(`Run ${run.id} checkout ${JSON.stringify(run.working_path)}`)
            );
          }
          expect(mockCancelWorkflowRun.mock.calls[0]?.[1]?.warnings).toEqual(
            result.cleanupWarnings
          );
        } finally {
          await owner.close();
        }
      });
    }
  }

  test('a completed container command produces no host cleanup warning', async () => {
    const id = `cancel-container-${crypto.randomUUID()}`;
    const owner = await startRunLiveOwner(id);
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({ id, status: 'running', metadata: { isolation: 'container' } })
    );
    try {
      expect((await cancelWorkflow(id, operator)).cleanupWarnings).toBeUndefined();
      expect(mockListWorkflowEvents).not.toHaveBeenCalled();
    } finally {
      await owner.close();
    }
  });

  // #2325: cancel refuses when no owner answers. A sub-run resumed on its own whose
  // process died, or one inside a root whose process died, has nobody to see the flip.
  test('refuses a sub-run when no owner answers for it or its root, showing the recorded owner', async () => {
    const rootRunId = `cancel-root-${crypto.randomUUID()}`;
    mockGetWorkflowRun.mockResolvedValueOnce(nestedSubRun(rootRunId));

    const error = await refusal();

    expect(error.reason).toBe('no_owner_answered');
    expect(error.message).toContain('Recorded owner: host build-box, pid 4242.');
    expect(error.message).toContain(
      `No live owner answered for its root run ${rootRunId} on this host either.`
    );
    expect(error.message).toContain('abandon the run to release it');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('refuses a sub-run whose ancestor rows are gone: no root is left to answer', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({ status: 'running', parent_run_id: 'deleted-parent' })
    );

    const error = await refusal();

    expect(error.reason).toBe('no_owner_answered');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  // A sub-run resumed on its own (a durable wait or a scheduled quota resume) has a live
  // owner of its own, in whatever process resumed it. Its parent id says nothing about that.
  test('refuses a sub-run whose own live owner answered and cannot be stopped from here', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({ status: 'running', parent_run_id: 'root-run' })
    );
    mockRequestDetachedRunStop.mockImplementationOnce(() =>
      Promise.reject(new DetachedRunOwnerUnavailableError('run-1', 'detail', 'not_detached'))
    );

    const error = await refusal();

    expect(error.reason).toBe('not_stopped');
    expect(error.message).toContain('The run was not changed.');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('stops a sub-run whose own detached owner answered before recording cancelled', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({ status: 'running', parent_run_id: 'root-run' })
    );
    const order: string[] = [];
    mockRequestDetachedRunStop.mockImplementationOnce(() =>
      Promise.resolve({
        pid: 42,
        stop: async () => {
          order.push('stop');
          return { warnings: [] };
        },
        release: () => undefined,
      })
    );
    mockCancelWorkflowRun.mockImplementationOnce(() => {
      order.push('cancel');
      return Promise.resolve({ cancelled: true });
    });

    const result = await cancelWorkflow('run-1', operator);

    expect(order).toEqual(['stop', 'cancel']);
    expect(result).toMatchObject({ kind: 'stopped', pid: 42 });
  });

  test('stops an owner in another process before recording cancelled', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    const order: string[] = [];
    mockRequestDetachedRunStop.mockImplementationOnce(() =>
      Promise.resolve({
        pid: 42,
        stop: async () => {
          order.push('stop');
          return { warnings: [] };
        },
        release: () => undefined,
      })
    );
    mockCancelWorkflowRun.mockImplementationOnce(() => {
      order.push('cancel');
      return Promise.resolve({ cancelled: true });
    });

    const result = await cancelWorkflow('run-1', operator);

    expect(order).toEqual(['stop', 'cancel']);
    expect(result).toMatchObject({ kind: 'stopped', pid: 42 });
  });

  // The stopped owner's nodes can no longer write, so its scratch goes; an output holder
  // that outlived the stop still could.
  test.each([
    [[], false],
    [['An output holder is still running.'], true],
  ] as const)('a stop with warnings %p keeps the run’s scratch: %p', async (warnings, kept) => {
    const root = trackTempRoot(join(getArchonWorkspacesPath(), '_cwd', `cancel-${randomUUID()}`));
    const { run, checkout } = makeRunWithScratch(root, { status: 'running' });
    mockGetWorkflowRun.mockResolvedValueOnce(run);
    mockRequestDetachedRunStop.mockImplementationOnce(() =>
      Promise.resolve({
        pid: 42,
        stop: async () => ({ warnings: [...warnings] }),
        release: () => undefined,
      })
    );

    await cancelWorkflow(run.id, operator);

    expect(existsSync(checkout)).toBe(kept);
  });

  test('refuses when no owner answers, showing the recorded owner facts', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        status: 'running',
        last_activity_at: new Date('2026-09-20T10:00:00.000Z'),
        metadata: { execution_owner: { host: 'build-box', pid: 4242 } },
      })
    );

    const error = await refusal();

    expect(error.reason).toBe('no_owner_answered');
    expect(error.message).toContain('Recorded owner: host build-box, pid 4242.');
    expect(error.message).toContain('Last activity: 2026-09-20T10:00:00.000Z.');
    expect(error.message).toContain('run run-1 was not changed');
    expect(error.message).toContain('abandon the run');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  for (const reason of ['not_detached', 'unproven', undefined] as const) {
    test(`an owner endpoint that answered (${String(reason)}) is refused unchanged`, async () => {
      mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
      mockRequestDetachedRunStop.mockImplementationOnce(() =>
        Promise.reject(new DetachedRunOwnerUnavailableError('run-1', 'detail', reason))
      );

      const error = await refusal();

      expect(error.reason).toBe('not_stopped');
      expect(error.message).toContain('The run was not changed.');
      expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
    });
  }

  test('an owner that cannot be stopped is refused unchanged', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    mockRequestDetachedRunStop.mockImplementationOnce(() =>
      Promise.resolve({
        pid: 42,
        stop: () => Promise.reject(new Error('process group 42 is still running')),
        release: () => undefined,
      })
    );

    const error = await refusal();

    expect(error.reason).toBe('not_stopped');
    expect(error.message).toContain('(pid 42): process group 42 is still running');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  // Invariant (#2325): no timer, age or PID decides liveness. An owner recorded as this
  // very process, active a moment ago, is still not an owner that answered.
  test('a recent, live-looking recorded owner does not stand in for an owner that answered', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        status: 'running',
        last_activity_at: new Date(),
        metadata: {
          execution_owner: { host: hostname(), pid: process.pid, uid: process.getuid?.() },
        },
      })
    );

    const error = await refusal();

    expect(error.reason).toBe('no_owner_answered');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('refuses a run that is not running without asking for an owner', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'paused' }));

    const error = await refusal();

    expect(error.reason).toBe('not_running');
    expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });
});
