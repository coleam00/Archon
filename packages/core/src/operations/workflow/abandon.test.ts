// @archon-test-isolated
import { RunActionForbiddenError } from '../run-authorization';
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { hostname } from 'node:os';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowOperationsDeps } from '../workflow-operations';
import type { IIsolationStore } from '@archon/isolation';
import { DetachedRunOwnerUnavailableError } from '../../services/run-owner-stop';
import {
  operator,
  EMPTY_COUNTS,
  mockGetWorkflowRun,
  mockListWorkflowRuns,
  mockLogger,
  mockCancelWorkflowRun,
  mockCancelResumableRunsForConversation,
  mockFindChildRuns,
  mockReclaimContainerEnv,
  noOwnerAnswers,
  mockRequestDetachedRunStop,
  isolationStore,
  store,
  makePausedRun,
  createWorkflowOperations,
  AbandonOwnerNotStoppedError,
  isRunOwnedByThisProcess,
  isRunOwnerAnswering,
  abandonWorkflow,
  abandonResumableRunsForConversation,
} from './test-harness';

describe('abandonWorkflow', () => {
  beforeEach(() => {
    mockListWorkflowRuns.mockReset();
    mockLogger.warn.mockClear();
    mockGetWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockImplementation(() => Promise.resolve({ cancelled: true }));
    mockReclaimContainerEnv.mockClear();
    mockReclaimContainerEnv.mockImplementation(() => Promise.resolve());
    mockFindChildRuns.mockClear();
    mockFindChildRuns.mockImplementation(() => Promise.resolve([]));
    mockRequestDetachedRunStop.mockClear();
    mockRequestDetachedRunStop.mockImplementation(noOwnerAnswers);
  });

  test('cancels a non-terminal run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));

    const { run, cancelled, cascadeFailures, blockedParentRunId } = await abandonWorkflow(
      'run-1',
      operator
    );
    expect(run.id).toBe('run-1');
    expect(cancelled).toBe(true);
    expect(cascadeFailures).toBe(0);
    expect(mockListWorkflowRuns).not.toHaveBeenCalled();
    expect(blockedParentRunId).toBeNull();
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1', { cancel_reason: 'operator' });
  });

  // #2121 Phase 2 (D7): abandoning a parent cascade-cancels its non-terminal
  // sub-run descendants (children AND grandchildren), skipping already-terminal ones.
  test('cascade-cancels non-terminal sub-run descendants', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    // run-1 → [child-a (paused), child-done (completed)]; child-a → [grandchild (running)].
    mockFindChildRuns.mockImplementation(parentId => {
      if (parentId === 'run-1') {
        return Promise.resolve([
          makePausedRun({ id: 'child-a', status: 'paused' }),
          makePausedRun({ id: 'child-done', status: 'completed' }),
        ]);
      }
      if (parentId === 'child-a') {
        return Promise.resolve([makePausedRun({ id: 'grandchild', status: 'running' })]);
      }
      return Promise.resolve([]);
    });

    await abandonWorkflow('run-1', operator);

    const cancelled = mockCancelWorkflowRun.mock.calls.map(c => c[0]);
    expect(cancelled).toContain('run-1'); // the parent itself
    expect(cancelled).toContain('child-a'); // non-terminal child
    expect(cancelled).toContain('grandchild'); // non-terminal grandchild
    expect(cancelled).not.toContain('child-done'); // already terminal — skipped
  });

  // Best-effort resilience: one descendant's cancel throwing must not abort the
  // walk — siblings still get cancelled, and the failure count is surfaced.
  test('cascade continues past a failing descendant and reports the failure count', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    mockFindChildRuns.mockImplementation(parentId => {
      if (parentId === 'run-1') {
        return Promise.resolve([
          makePausedRun({ id: 'child-a', status: 'running' }),
          makePausedRun({ id: 'child-b', status: 'paused' }),
          makePausedRun({ id: 'child-c', status: 'running' }),
        ]);
      }
      return Promise.resolve([]);
    });
    const err = new Error('db blip');
    mockCancelWorkflowRun.mockImplementation(id =>
      id === 'child-b' ? Promise.reject(err) : Promise.resolve({ cancelled: true })
    );

    const { cascadeFailures } = await abandonWorkflow('run-1', operator);

    expect(cascadeFailures).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { err, childId: 'child-b' },
      'operations.workflow_abandon_cascade_cancel_failed'
    );
    const cancelled = mockCancelWorkflowRun.mock.calls.map(c => c[0]);
    expect(cancelled).toContain('child-a');
    expect(cancelled).toContain('child-c'); // sibling AFTER the failure still cancelled
  });

  for (const status of ['completed', 'cancelled'] as const) {
    test(`a child becoming ${status} during cancellation is not a failure and is still traversed`, async () => {
      mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
      mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ id: 'child', status }));
      mockFindChildRuns.mockImplementation(async parentId => {
        if (parentId === 'run-1') return [makePausedRun({ id: 'child', status: 'running' })];
        if (parentId === 'child') return [makePausedRun({ id: 'grandchild', status: 'paused' })];
        return [];
      });
      mockCancelWorkflowRun.mockImplementation(async id => ({ cancelled: id !== 'child' }));
      const result = await abandonWorkflow('run-1', operator);
      expect(result.cascadeFailures).toBe(0);
      expect(mockCancelWorkflowRun).toHaveBeenCalledWith('grandchild', {
        cancel_reason: 'operator',
      });
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'operations.workflow_abandon_cascade_cancel_failed'
      );
    });
  }

  for (const status of ['pending', 'running', 'failed', 'paused', null, 'lookup-error'] as const) {
    test(`a false child cancellation remains a failure when the re-read is ${status}`, async () => {
      mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
      const err = new Error('state unavailable');
      if (status === 'lookup-error') mockGetWorkflowRun.mockRejectedValueOnce(err);
      else
        mockGetWorkflowRun.mockResolvedValueOnce(
          status ? makePausedRun({ id: 'child', status }) : null
        );
      mockFindChildRuns.mockImplementation(async parentId =>
        parentId === 'run-1' ? [makePausedRun({ id: 'child', status: 'running' })] : []
      );
      mockCancelWorkflowRun.mockImplementation(async id => ({ cancelled: id !== 'child' }));
      const result = await abandonWorkflow('run-1', operator);
      expect(result.cancelled).toBe(true);
      expect(result.cascadeFailures).toBe(1);
      expect(mockFindChildRuns).toHaveBeenCalledWith('child');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        status === 'lookup-error' ? { err, childId: 'child' } : { childId: 'child' },
        'operations.workflow_abandon_cascade_cancel_failed'
      );
    });
  }

  test('wide leaf fan-out cancels every child without false truncation failures', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    const children = Array.from({ length: 1000 }, (_, i) =>
      makePausedRun({ id: `child-${i}`, status: 'running' })
    );
    mockFindChildRuns.mockImplementation(parentId =>
      Promise.resolve(parentId === 'run-1' ? children : [])
    );
    mockListWorkflowRuns.mockResolvedValueOnce({ runs: [], total: 0, counts: EMPTY_COUNTS });

    const { cascadeFailures } = await abandonWorkflow('run-1', operator);

    expect(cascadeFailures).toBe(0);
    expect(mockCancelWorkflowRun.mock.calls.map(call => call[0])).toEqual([
      'run-1',
      ...children.map(child => child.id),
    ]);
    expect(mockFindChildRuns).toHaveBeenCalledTimes(500);
    expect(mockListWorkflowRuns).toHaveBeenCalledTimes(1);
    expect(mockListWorkflowRuns).toHaveBeenCalledWith({
      excludeLeafStatuses: ['completed', 'cancelled'],
      parentRunIds: children.slice(499).map(child => child.id),
      limit: 0,
    });
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'operations.workflow_abandon_cascade_truncated'
    );
  });

  test('reports truncation when a deep chain hits the expansion cap', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    mockFindChildRuns.mockImplementation(parentId =>
      Promise.resolve([makePausedRun({ id: `${parentId}::c`, status: 'running' })])
    );
    mockListWorkflowRuns.mockResolvedValueOnce({ runs: [], total: 1, counts: EMPTY_COUNTS });

    const { cascadeFailures } = await abandonWorkflow('run-1', operator);

    expect(cascadeFailures).toBe(1);
    expect(mockFindChildRuns).toHaveBeenCalledTimes(500);
    expect(mockListWorkflowRuns).toHaveBeenCalledTimes(1);
    expect(mockListWorkflowRuns).toHaveBeenCalledWith({
      excludeLeafStatuses: ['completed', 'cancelled'],
      parentRunIds: [`run-1${'::c'.repeat(500)}`],
      limit: 0,
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { rootId: 'run-1', cap: 500, unreached: 1, pendingParents: 1 },
      'operations.workflow_abandon_cascade_truncated'
    );
  });

  for (const [status, frontierStatus, hasDeeper] of [
    ['running', 'running', false],
    ['completed', 'running', false],
    ['cancelled', 'running', false],
    ['running', 'completed', false],
    ['running', 'cancelled', false],
    ['running', 'completed', true],
    ['running', 'cancelled', true],
  ] as const) {
    test(`wide frontier: ${status} parent, ${frontierStatus} child, deeper=${hasDeeper}`, async () => {
      mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
      const children = Array.from({ length: 1000 }, (_, i) =>
        makePausedRun({
          id: `child-${i}`,
          status: i === 999 ? status : 'running',
          parent_run_id: 'run-1',
        })
      );
      const grandchild = makePausedRun({
        id: 'grandchild',
        status: frontierStatus,
        parent_run_id: 'child-999',
      });
      const tree = [...children, grandchild];
      if (hasDeeper)
        tree.push(
          makePausedRun({ id: 'great-grandchild', status: 'running', parent_run_id: grandchild.id })
        );
      const unresolved = frontierStatus === 'running' || hasDeeper;
      mockFindChildRuns.mockImplementation(parentId =>
        Promise.resolve(tree.filter(run => run.parent_run_id === parentId))
      );
      mockListWorkflowRuns.mockImplementation(async options => {
        expect(options?.limit).toBe(0);
        expect(options?.status).toBeUndefined();
        expect(options?.excludeLeafStatuses).toEqual(['completed', 'cancelled']);
        const total = tree.filter(
          run =>
            options?.parentRunIds?.includes(run.parent_run_id ?? '') &&
            (!options.excludeLeafStatuses?.includes(run.status) ||
              tree.some(child => child.parent_run_id === run.id))
        ).length;
        return { runs: [], total, counts: EMPTY_COUNTS };
      });

      const result = await abandonWorkflow('run-1', operator);

      expect(result.cancelled).toBe(true);
      expect(result.cascadeFailures).toBe(unresolved ? 1 : 0);
      expect(mockFindChildRuns).toHaveBeenCalledTimes(500);
      expect(mockListWorkflowRuns).toHaveBeenCalledTimes(1);
      expect(mockCancelWorkflowRun.mock.calls.map(call => call[0])).not.toContain(grandchild.id);
      if (unresolved) {
        expect(mockLogger.warn).toHaveBeenCalledWith(
          { rootId: 'run-1', cap: 500, unreached: 1, pendingParents: 501 },
          'operations.workflow_abandon_cascade_truncated'
        );
      } else {
        expect(mockLogger.warn).not.toHaveBeenCalledWith(
          expect.anything(),
          'operations.workflow_abandon_cascade_truncated'
        );
      }
    });
  }

  test('a failed frontier probe preserves parent success and logs the original error', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    mockFindChildRuns.mockImplementation(parentId =>
      Promise.resolve([makePausedRun({ id: `${parentId}::c`, status: 'running' })])
    );
    const err = new Error('aggregate unavailable');
    mockListWorkflowRuns.mockRejectedValueOnce(err);

    const result = await abandonWorkflow('run-1', operator);

    expect(result.cancelled).toBe(true);
    expect(result.cascadeFailures).toBe(1);
    expect(mockFindChildRuns).toHaveBeenCalledTimes(500);
    expect(mockListWorkflowRuns).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { err, rootId: 'run-1', pendingParents: 1 },
      'operations.workflow_abandon_cascade_lookup_failed'
    );
  });

  test('a successful frontier probe preserves earlier lookup and cancellation failures', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    const children = Array.from({ length: 1000 }, (_, i) =>
      makePausedRun({ id: `child-${i}`, status: 'running' })
    );
    const err = new Error('child lookup unavailable');
    mockFindChildRuns.mockImplementation(parentId => {
      if (parentId === 'child-0') return Promise.reject(err);
      return Promise.resolve(parentId === 'run-1' ? children : []);
    });
    mockCancelWorkflowRun.mockImplementation(id =>
      Promise.resolve({ cancelled: id !== 'child-1' })
    );
    mockListWorkflowRuns.mockResolvedValueOnce({ runs: [], total: 0, counts: EMPTY_COUNTS });

    const result = await abandonWorkflow('run-1', operator);

    expect(result.cancelled).toBe(true);
    expect(result.cascadeFailures).toBe(2);
    expect(mockCancelWorkflowRun.mock.calls.map(call => call[0])).toContain('child-999');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { err, parentId: 'child-0' },
      'operations.workflow_abandon_cascade_lookup_failed'
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { childId: 'child-1' },
      'operations.workflow_abandon_cascade_cancel_failed'
    );
    expect(mockListWorkflowRuns).toHaveBeenCalledTimes(1);
  });

  // Abandoning a CHILD directly strands a parent paused on it — the op surfaces
  // the blocked parent's id so callers can point the user at it.
  test('surfaces the parent run id when abandoning a child its parent is blocked on', async () => {
    const child = makePausedRun({
      id: 'child-1',
      status: 'running',
      parent_run_id: 'parent-1',
    });
    const parent = makePausedRun({
      id: 'parent-1',
      status: 'paused',
      metadata: {
        approval: {
          nodeId: 'sub',
          message: 'Blocked on sub-run',
          type: 'child_workflow',
          childRunId: 'child-1',
        },
      },
    });
    mockGetWorkflowRun.mockImplementation((id: unknown) =>
      Promise.resolve(id === 'child-1' ? child : id === 'parent-1' ? parent : null)
    );

    const { blockedParentRunId } = await abandonWorkflow('child-1', operator);
    expect(blockedParentRunId).toBe('parent-1');

    // Parent paused on a DIFFERENT child → not blocked on us → null.
    (parent.metadata as { approval: { childRunId: string } }).approval.childRunId = 'other-child';
    const second = await abandonWorkflow('child-1', operator);
    expect(second.blockedParentRunId).toBeNull();
    mockGetWorkflowRun.mockReset();
    mockGetWorkflowRun.mockImplementation(() => Promise.resolve(null));
  });

  test('surfaces the parent run id when abandoning one of the children a fan-out waits on', async () => {
    const child = makePausedRun({ id: 'child-2', status: 'paused', parent_run_id: 'parent-1' });
    const parent = makePausedRun({
      id: 'parent-1',
      status: 'paused',
      metadata: {
        approval: {
          nodeId: 'work',
          message: 'Waiting on sub-runs',
          type: 'fan_out',
          childRunIds: ['child-1', 'child-2'],
          unspawnedItems: 0,
        },
      },
    });
    mockGetWorkflowRun.mockImplementation((id: unknown) =>
      Promise.resolve(id === 'child-2' ? child : id === 'parent-1' ? parent : null)
    );

    const { blockedParentRunId } = await abandonWorkflow('child-2', operator);
    expect(blockedParentRunId).toBe('parent-1');
    mockGetWorkflowRun.mockReset();
    mockGetWorkflowRun.mockImplementation(() => Promise.resolve(null));
  });

  // The cascade only runs when OUR cancel won the CAS (`cancelled: true`).
  test('does not cascade when the parent cancel loses the race', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'paused' }));
    mockCancelWorkflowRun.mockImplementationOnce(() => Promise.resolve({ cancelled: false }));
    await expect(abandonWorkflow('run-1', operator)).rejects.toThrow('changed before abandonment');
    expect(mockCancelWorkflowRun).toHaveBeenCalledTimes(1);
  });

  // M2 — abandoning a CONTAINER run reclaims its container + volume in the SHARED op
  // (so web/chat/manage_run/Slack, not just the CLI, free the resources immediately).
  test('reclaims a container run’s env on abandon', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        status: 'paused',
        metadata: { isolation: 'container', isolation_env_id: 'env-9' },
      })
    );
    await abandonWorkflow('run-1', operator);
    expect(mockReclaimContainerEnv).toHaveBeenCalledWith('env-9', isolationStore);
  });

  test('does not reclaim for a non-container run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    await abandonWorkflow('run-1', operator);
    expect(mockReclaimContainerEnv).not.toHaveBeenCalled();
  });

  // Race: a concurrent transition already took the run terminal, so our cancel CAS
  // no-ops (`cancelled: false`). The winner OWNS the environment — we must NOT reclaim.
  test('does not reclaim a container run when the cancel loses the race', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        status: 'paused',
        metadata: { isolation: 'container', isolation_env_id: 'env-9' },
      })
    );
    mockCancelWorkflowRun.mockImplementationOnce(() => Promise.resolve({ cancelled: false }));
    await expect(abandonWorkflow('run-1', operator)).rejects.toThrow('changed before abandonment');
    expect(mockReclaimContainerEnv).not.toHaveBeenCalled();
  });

  test('reports a reclaim failure after committing abandonment', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        status: 'paused',
        metadata: { isolation: 'container', isolation_env_id: 'env-9' },
      })
    );
    mockReclaimContainerEnv.mockImplementationOnce(() => Promise.reject(new Error('docker down')));
    const { run, cleanupWarnings } = await abandonWorkflow('run-1', operator);
    expect(cleanupWarnings).toHaveLength(1);
    expect(cleanupWarnings?.[0]).toContain('env-9');
    expect(cleanupWarnings?.[0]).toContain('resources may remain allocated');
    expect(run.id).toBe('run-1');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1', { cancel_reason: 'operator' });
  });

  test('cancels a failed run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'failed' }));

    const { run, cascadeFailures, blockedParentRunId } = await abandonWorkflow('run-1', operator);
    expect(run.id).toBe('run-1');
    expect(cascadeFailures).toBe(0);
    expect(blockedParentRunId).toBeNull();
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1', { cancel_reason: 'operator' });
  });

  test('throws on completed run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(abandonWorkflow('run-1', operator)).rejects.toThrow(
      "Cannot abandon run with status 'completed'"
    );
  });

  test('throws on cancelled run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'cancelled' }));

    await expect(abandonWorkflow('run-1', operator)).rejects.toThrow(
      "Cannot abandon run with status 'cancelled'"
    );
  });

  // --- live owner (#2325) ---
  // The stop path itself (lease, commit, process-tree termination) is proven against
  // real processes in run-owner-stop.test.ts and the CLI integration specs. Here the
  // operation's own decision is under test: which answers stop, fall through, or refuse.

  test('preserves owner warnings alongside reclamation warnings and in the cancellation reason', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        status: 'running',
        metadata: { isolation: 'container', isolation_env_id: 'env-9' },
      })
    );
    mockRequestDetachedRunStop.mockResolvedValueOnce({
      pid: 42,
      stop: async () => ({ survivors: [], warnings: ['Owner cleanup warning'] }),
      release: () => undefined,
    });
    mockReclaimContainerEnv.mockRejectedValueOnce(new Error('fixture reclamation failure'));
    const result = await abandonWorkflow('run-1', operator);
    expect(result.cleanupWarnings).toHaveLength(2);
    expect(result.cleanupWarnings?.[0]).toBe('Owner cleanup warning');
    expect(result.cleanupWarnings?.[1]).toContain('env-9');
    expect(result.owner).toMatchObject({
      kind: 'stopped',
      cleanupWarnings: ['Owner cleanup warning'],
    });
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1', {
      cancel_reason: 'operator',
      reason: 'Owner cleanup warning',
    });
  });

  test('stops a live owner before recording cancelled', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    const order: string[] = [];
    mockRequestDetachedRunStop.mockImplementationOnce(() =>
      Promise.resolve({
        pid: 42,
        stop: async () => {
          order.push('stop');
          return { survivors: [], warnings: [] };
        },
        release: () => undefined,
      })
    );
    mockCancelWorkflowRun.mockImplementationOnce(() => {
      order.push('cancel');
      return Promise.resolve({ cancelled: true });
    });

    const { cancelled, owner } = await abandonWorkflow('run-1', operator);

    expect(order).toEqual(['stop', 'cancel']);
    expect(cancelled).toBe(true);
    expect(owner).toEqual({ kind: 'stopped', pid: 42 });
  });

  test('records cancelled with the recorded owner facts when no owner answers', async () => {
    const lastActivity = new Date('2026-09-20T10:00:00.000Z');
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        status: 'running',
        last_activity_at: lastActivity,
        metadata: { execution_owner: { host: hostname(), pid: 4242, uid: 501 } },
      })
    );

    const { cancelled, owner } = await abandonWorkflow('run-1', operator);

    expect(cancelled).toBe(true);
    expect(owner).toEqual({
      kind: 'no_owner_answered',
      detail: 'ENOENT',
      recordedOwner: { host: hostname(), pid: 4242, uid: 501 },
      lastActivityAt: lastActivity,
      thisHost: hostname(),
      thisUid: process.getuid?.(),
    });
  });

  for (const reason of ['not_detached', 'unproven', undefined] as const) {
    test(`an owner endpoint that answered (${String(reason)}) leaves the run unchanged`, async () => {
      mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
      mockRequestDetachedRunStop.mockImplementationOnce(() =>
        Promise.reject(new DetachedRunOwnerUnavailableError('run-1', 'detail', reason))
      );

      const error = await abandonWorkflow('run-1', operator).then(
        () => undefined,
        (rejection: unknown) => rejection
      );

      expect(error).toBeInstanceOf(AbandonOwnerNotStoppedError);
      expect((error as Error).message).toContain('The run was not changed.');
      expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
    });
  }

  test('an owner that answers but cannot be stopped fails with the reason', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    mockRequestDetachedRunStop.mockImplementationOnce(() =>
      Promise.resolve({
        pid: 42,
        stop: () =>
          Promise.reject(new Error('Detached workflow process group 42 is still running')),
        release: () => undefined,
      })
    );

    await expect(abandonWorkflow('run-1', operator)).rejects.toThrow(
      'Could not stop the live owner of run run-1 (pid 42): Detached workflow process group 42 is still running. The run was not changed.'
    );
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

    const { cancelled, owner } = await abandonWorkflow('run-1', operator);

    expect(cancelled).toBe(true);
    expect(owner.kind).toBe('no_owner_answered');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1', { cancel_reason: 'operator' });
  });
});

describe('abandonResumableRunsForConversation', () => {
  beforeEach(() => {
    mockCancelResumableRunsForConversation.mockClear();
    mockCancelResumableRunsForConversation.mockImplementation(() => Promise.resolve([]));
    mockGetWorkflowRun.mockClear();
    mockGetWorkflowRun.mockImplementation(() => Promise.resolve(makePausedRun()));
    mockFindChildRuns.mockClear();
    mockFindChildRuns.mockImplementation(() => Promise.resolve([]));
    mockReclaimContainerEnv.mockClear();
    mockReclaimContainerEnv.mockImplementation(() => Promise.resolve());
  });

  test('reports zero when the conversation has nothing resumable', async () => {
    const result = await abandonResumableRunsForConversation('conv-1', operator);

    expect(result).toEqual({
      abandoned: 0,
      blockedParentRunId: null,
    });
    expect(mockCancelResumableRunsForConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.any(Function)
    );
  });

  test('authorizes only the runs it would abandon, so an unidentified reset of no runs proceeds', async () => {
    const resetLocked = (locked: WorkflowRun[]) => {
      mockCancelResumableRunsForConversation.mockImplementationOnce(async (_id, authorize) => {
        authorize?.(locked);
        return locked;
      });
      return abandonResumableRunsForConversation('conv-1', { kind: 'unidentified' });
    };

    expect((await resetLocked([])).abandoned).toBe(0);
    await expect(resetLocked([makePausedRun({ user_id: 'starter' })])).rejects.toBeInstanceOf(
      RunActionForbiddenError
    );
  });

  test('counts the rows cancelled by the conversation-scoped mutation', async () => {
    mockCancelResumableRunsForConversation.mockResolvedValueOnce([
      makePausedRun({ id: 'run-a' }),
      makePausedRun({ id: 'run-b' }),
    ]);

    const result = await abandonResumableRunsForConversation('conv-1', operator);

    expect(result).toEqual({
      abandoned: 2,
      blockedParentRunId: null,
    });
    expect(mockFindChildRuns).not.toHaveBeenCalled();
  });

  test('reclaims every cancelled container run', async () => {
    mockCancelResumableRunsForConversation.mockResolvedValueOnce([
      makePausedRun({
        id: 'container-a',
        metadata: { isolation: 'container', isolation_env_id: 'env-a' },
      }),
      makePausedRun({
        id: 'container-b',
        metadata: { isolation: 'container', isolation_env_id: 'env-b' },
      }),
    ]);

    await abandonResumableRunsForConversation('conv-1', operator);

    expect(mockReclaimContainerEnv.mock.calls.map(call => call[0])).toEqual(['env-a', 'env-b']);
  });

  test('reset uses its supplied isolation store and reports each failed reclaim while continuing', async () => {
    const sentinel: IIsolationStore = { ...isolationStore };
    const reclaim = mock<WorkflowOperationsDeps['reclaimContainerEnv']>(async () => {});
    reclaim.mockRejectedValueOnce(new Error('docker down'));
    const operations = createWorkflowOperations({
      getUserRole: async () => undefined,
      store,
      hostStore: { isolation: sentinel },
      requestDetachedRunStop: mockRequestDetachedRunStop,
      isRunOwnedByThisProcess,
      isRunOwnerAnswering,
      reclaimRunWorktree: async () => ({ warnings: [] }),
      reclaimContainerEnv: reclaim,
    });
    mockCancelResumableRunsForConversation.mockResolvedValueOnce([
      makePausedRun({
        id: 'container-a',
        metadata: { isolation: 'container', isolation_env_id: 'env-a' },
      }),
      makePausedRun({
        id: 'container-b',
        metadata: { isolation: 'container', isolation_env_id: 'env-b' },
      }),
    ]);
    const result = await operations.abandonResumableRunsForConversation('conv-1', operator);
    expect(reclaim).toHaveBeenNthCalledWith(1, 'env-a', sentinel);
    expect(reclaim).toHaveBeenNthCalledWith(2, 'env-b', sentinel);
    expect(reclaim.mock.calls[0]?.[1]).toBe(sentinel);
    expect(reclaim.mock.calls[1]?.[1]).toBe(sentinel);
    expect(result.abandoned).toBe(2);
    expect(result.cleanupWarnings).toHaveLength(1);
    expect(result.cleanupWarnings?.[0]).toContain('env-a');
  });

  test('reports the clean final state when selected roots overlap through a running parent (#2731 R4)', async () => {
    mockCancelResumableRunsForConversation.mockResolvedValueOnce([
      makePausedRun({ id: 'run-a', parent_run_id: null }),
      makePausedRun({ id: 'run-c', parent_run_id: 'run-b' }),
    ]);
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({ id: 'run-b', parent_run_id: 'run-a', status: 'running' })
    );

    const result = await abandonResumableRunsForConversation('conv-1', operator);

    expect(result).toEqual({
      abandoned: 2,
      blockedParentRunId: null,
    });
    expect(mockGetWorkflowRun).toHaveBeenCalledWith('run-b');
    expect(mockFindChildRuns).not.toHaveBeenCalled();
  });

  test('surfaces a blocked parent outside the selected run tree', async () => {
    mockCancelResumableRunsForConversation.mockResolvedValueOnce([
      makePausedRun({ id: 'child', parent_run_id: 'parent-paused' }),
    ]);
    mockGetWorkflowRun.mockImplementation((id: unknown) => {
      if (id === 'parent-paused') {
        // The parent is paused blocked-on-child: a child_workflow approval
        // pointing at the child run. isRunBlockedOnChild is the shared predicate
        // findParentBlockedOn uses.
        return Promise.resolve(
          makePausedRun({
            id: 'parent-paused',
            metadata: {
              approval: {
                nodeId: 'workflow',
                message: 'waiting on sub-run',
                type: 'child_workflow',
                childRunId: 'child',
              },
            },
          })
        );
      }
      return Promise.resolve(null);
    });

    const result = await abandonResumableRunsForConversation('conv-1', operator);

    expect(result.abandoned).toBe(1);
    expect(result.blockedParentRunId).toBe('parent-paused');
  });

  test('propagates an atomic cancellation failure rather than reporting a false all-clear', async () => {
    mockCancelResumableRunsForConversation.mockRejectedValueOnce(new Error('Connection refused'));

    await expect(abandonResumableRunsForConversation('conv-1', operator)).rejects.toThrow(
      'Connection refused'
    );
  });
});

describe('abandon owned worktrees', () => {
  const reclaim = mock<WorkflowOperationsDeps['reclaimRunWorktree']>(async () => ({
    warnings: [],
  }));
  const operations = createWorkflowOperations({
    getUserRole: async () => undefined,
    store,
    hostStore: { isolation: isolationStore },
    requestDetachedRunStop: mockRequestDetachedRunStop,
    isRunOwnedByThisProcess,
    isRunOwnerAnswering,
    reclaimContainerEnv: mockReclaimContainerEnv,
    reclaimRunWorktree: reclaim,
  });
  const owned = (id = 'run-1', overrides: Partial<WorkflowRun> = {}): WorkflowRun =>
    makePausedRun({
      id,
      metadata: {
        owned_worktree: { envId: `env-${id}`, creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8' },
        execution_owner: { host: hostname(), pid: 4242, uid: process.getuid?.() },
      },
      ...overrides,
    });
  beforeEach(() => {
    reclaim.mockReset();
    reclaim.mockResolvedValue({ warnings: [] });
    mockGetWorkflowRun.mockReset();
    mockGetWorkflowRun.mockResolvedValue(owned());
    mockFindChildRuns.mockReset();
    mockFindChildRuns.mockResolvedValue([]);
    mockCancelWorkflowRun.mockReset();
    mockCancelWorkflowRun.mockResolvedValue({ cancelled: true });
    mockRequestDetachedRunStop.mockReset();
    mockRequestDetachedRunStop.mockRejectedValue(
      new DetachedRunOwnerUnavailableError('run-1', 'ENOENT', 'unreachable')
    );
  });

  test('cancels before release, releases children before root, and reports each removal', async () => {
    const child = owned('child');
    mockFindChildRuns.mockImplementation(async id => (id === 'run-1' ? [child] : []));
    const order: string[] = [];
    mockCancelWorkflowRun.mockImplementation(async id => {
      order.push(`cancel ${id}`);
      return { cancelled: true };
    });
    reclaim.mockImplementation(async (run, store) => {
      expect(store).toBe(isolationStore);
      order.push(`release ${run.id}`);
      return { released: { path: `/wt/${run.id}`, branch: `b-${run.id}` }, warnings: [] };
    });
    const result = await operations.abandonWorkflow('run-1', operator);
    expect(order).toEqual(['cancel run-1', 'cancel child', 'release child', 'release run-1']);
    expect(result.releasedWorktrees).toEqual([
      { path: '/wt/child', branch: 'b-child' },
      { path: '/wt/run-1', branch: 'b-run-1' },
    ]);
  });

  test('a release failure never blocks cancellation; it is a cancelled-run warning', async () => {
    reclaim.mockRejectedValueOnce(new Error('git removal failed; retry abandon run-1'));
    const result = await operations.abandonWorkflow('run-1', operator);
    expect(result.cancelled).toBe(true);
    expect(mockCancelWorkflowRun).toHaveBeenCalledTimes(1);
    expect(result.cleanupWarnings).toEqual([
      expect.stringContaining('git removal failed; retry abandon run-1 The run remains cancelled.'),
    ]);
  });

  test('CAS loss never releases', async () => {
    mockCancelWorkflowRun.mockResolvedValueOnce({ cancelled: false });
    await expect(operations.abandonWorkflow('run-1', operator)).rejects.toThrow(
      'changed before abandonment'
    );
    expect(reclaim).not.toHaveBeenCalled();
  });

  test('cancelled cleanup retry does not repeat cancellation and leaves active descendants untouched', async () => {
    mockGetWorkflowRun.mockResolvedValue(owned('run-1', { status: 'cancelled' }));
    mockFindChildRuns.mockImplementation(async id =>
      id === 'run-1' ? [owned('child', { status: 'running' })] : []
    );
    const result = await operations.abandonWorkflow('run-1', operator);
    expect(result.cancelled).toBe(false);
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
    expect(reclaim.mock.calls.map(call => call[0].id)).toEqual(['run-1']);
  });

  test.each(['foreign-host', 'missing'])('retains %s owner estate', async kind => {
    const run = owned();
    if (kind === 'missing') delete run.metadata.execution_owner;
    else run.metadata.execution_owner = { host: 'another-host', pid: 4242 };
    mockGetWorkflowRun.mockResolvedValue(run);
    const result = await operations.abandonWorkflow('run-1', operator);
    expect(result.cancelled).toBe(true);
    expect(result.cleanupWarnings?.[0]).toContain('execution owner');
    expect(reclaim).not.toHaveBeenCalled();
  });

  // POSIX owner endpoints live under a per-uid directory, so abandon cannot reach
  // another user's owner and keeps its checkout. Windows records no uid (process.getuid
  // is absent) and its owner pipe is machine-wide, so the endpoint decides there.
  test('a same-host owner under another uid is retained on POSIX; on Windows uid is not an ownership signal', async () => {
    const run = owned();
    run.metadata.execution_owner = {
      host: hostname(),
      pid: 4242,
      uid: (process.getuid?.() ?? 0) + 1,
    };
    mockGetWorkflowRun.mockResolvedValue(run);
    const result = await operations.abandonWorkflow('run-1', operator);
    expect(result.cancelled).toBe(true);
    if (process.getuid) {
      expect(result.cleanupWarnings?.[0]).toContain('execution owner belongs to uid');
      expect(reclaim).not.toHaveBeenCalled();
    } else {
      expect(result.cleanupWarnings).toBeUndefined();
      expect(reclaim).toHaveBeenCalledTimes(1);
    }
  });

  test('an unaccounted inherited child prevents removing its root checkout', async () => {
    mockFindChildRuns.mockImplementation(async id =>
      id === 'run-1' ? [makePausedRun({ id: 'child', metadata: {} })] : []
    );
    const result = await operations.abandonWorkflow('run-1', operator);
    expect(result.cleanupWarnings?.join(' ')).toContain(
      'descendants could not all be accounted for'
    );
    expect(reclaim).not.toHaveBeenCalled();
  });

  test('unexpected descendant owner errors are warnings after cancellation, and protect the root', async () => {
    mockFindChildRuns.mockImplementation(async id => (id === 'run-1' ? [owned('child')] : []));
    mockRequestDetachedRunStop.mockRejectedValueOnce(
      new DetachedRunOwnerUnavailableError('run-1', 'ENOENT', 'unreachable')
    );
    mockRequestDetachedRunStop.mockRejectedValueOnce(new Error('endpoint inspection failed'));
    const result = await operations.abandonWorkflow('run-1', operator);
    expect(result.cancelled).toBe(true);
    expect(result.cleanupWarnings?.join(' ')).toContain('endpoint inspection failed');
    expect(reclaim).not.toHaveBeenCalled();
  });

  test('reset releases an owned worktree through its supplied store and reports a failure', async () => {
    const sentinel: IIsolationStore = { ...isolationStore };
    const resetReclaim = mock<WorkflowOperationsDeps['reclaimRunWorktree']>(async () => ({
      released: { path: '/wt/run-a', branch: 'b-a' },
      warnings: [],
    }));
    resetReclaim.mockRejectedValueOnce(new Error('removal failed for run-b'));
    const resetOperations = createWorkflowOperations({
      getUserRole: async () => undefined,
      store,
      hostStore: { isolation: sentinel },
      requestDetachedRunStop: mockRequestDetachedRunStop,
      isRunOwnedByThisProcess,
      isRunOwnerAnswering,
      reclaimContainerEnv: mockReclaimContainerEnv,
      reclaimRunWorktree: resetReclaim,
    });
    const runB = owned('run-b');
    const runA = owned('run-a');
    mockCancelResumableRunsForConversation.mockResolvedValueOnce([runB, runA]);
    const result = await resetOperations.abandonResumableRunsForConversation('conv-1', operator);
    expect(resetReclaim.mock.calls).toEqual([
      [runB, sentinel],
      [runA, sentinel],
    ]);
    expect(result.cleanupWarnings).toEqual([
      expect.stringContaining('removal failed for run-b The run remains cancelled.'),
    ]);
    expect(result.releasedWorktrees).toEqual([{ path: '/wt/run-a', branch: 'b-a' }]);
  });

  test('ordinary cancel retains worktrees', async () => {
    mockGetWorkflowRun.mockResolvedValue(owned('run-1', { status: 'running' }));
    mockRequestDetachedRunStop.mockResolvedValueOnce({
      pid: 4242,
      stop: async () => ({ survivors: [], warnings: [] }),
      release: () => {},
    });
    await operations.cancelWorkflow('run-1', operator);
    expect(reclaim).not.toHaveBeenCalled();
  });
});
