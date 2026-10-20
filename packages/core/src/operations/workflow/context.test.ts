// @archon-test-isolated
import {
  RUN_ACTIONS,
  RunActionForbiddenError,
  type RunAction,
  type RunActor,
} from '../run-authorization';
import { describe, test, expect, mock } from 'bun:test';
import { workflowWaitContextSchema } from '@archon/workflows/schemas/workflow-run';
import {
  operator,
  mockReclaimContainerEnv,
  mockRequestDetachedRunStop,
  mockLogger,
  isolationStore,
  store,
  makePausedRun,
  createWorkflowOperations,
  isRunOwnedByThisProcess,
  isRunOwnerAnswering,
} from './test-harness';

describe('run action authorization precedes effects and state validation', () => {
  for (const action of RUN_ACTIONS) {
    for (const actor of [
      { kind: 'user', userId: 'other' },
      { kind: 'unidentified' },
    ] satisfies RunActor[]) {
      test(`${action} refuses ${actor.kind} before all effects`, async () => {
        const run = makePausedRun({
          user_id: 'starter',
          status: action === 'cancel' ? 'running' : action === 'delete' ? 'completed' : 'paused',
        });
        const write = mock(async () => ({ resolved: true, cancelled: true, signaled: true }));
        const stop = mockRequestDetachedRunStop;
        stop.mockClear();
        const operations = createWorkflowOperations({
          getUserRole: async () => 'member',
          store: {
            ...store,
            getWorkflowRun: async () => run,
            resolveApprovalGate: write,
            resolveAndCancelApprovalGate: write,
            cancelWorkflowRun: write,
            signalWorkflowWait: write,
            deleteWorkflowRun: async () => {
              await write();
            },
          },
          hostStore: { isolation: isolationStore },
          requestDetachedRunStop: stop,
          isRunOwnedByThisProcess,
          isRunOwnerAnswering,
          reclaimRunWorktree: async () => ({ warnings: [] }),
          reclaimContainerEnv: mockReclaimContainerEnv,
        });
        const calls = {
          approve: () =>
            operations.approveWorkflow(run.id, 'secret comment', actor, { via: 'cli' }),
          reject: () => operations.rejectWorkflow(run.id, 'secret comment', actor, { via: 'cli' }),
          respond: () =>
            operations.respondToWorkflow(run.id, 'custom', 'secret comment', actor, { via: 'cli' }),
          resume: () => operations.resumeWorkflow(run.id, actor),
          cancel: () => operations.cancelWorkflow(run.id, actor),
          abandon: () => operations.abandonWorkflow(run.id, actor),
          signal: () =>
            operations.signalWorkflowWait(
              run.id,
              { event: 'event', resumeAt: 'now', payload: 'secret payload' },
              actor
            ),
          delete: () => operations.deleteWorkflowRun(run.id, actor),
        } satisfies Record<RunAction, () => Promise<unknown>>;
        await expect(calls[action]()).rejects.toBeInstanceOf(RunActionForbiddenError);
        expect(write).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(JSON.stringify(mockLogger.warn.mock.calls.at(-1))).not.toContain('secret');
      });
    }
  }

  test('reset authorizes the locked snapshot before mutation or cleanup', async () => {
    const write = mock(async () => {});
    const cleanup = mock(async () => ({ warnings: [] }));
    const runs = [
      makePausedRun({ user_id: 'starter' }),
      makePausedRun({ id: 'other-run', user_id: 'other' }),
    ];
    const operations = createWorkflowOperations({
      getUserRole: async () => 'member',
      store: {
        ...store,
        cancelResumableRunsForConversation: async (_id, authorize) => {
          authorize?.(runs);
          await write();
          return runs;
        },
      },
      hostStore: { isolation: isolationStore },
      requestDetachedRunStop: mockRequestDetachedRunStop,
      isRunOwnedByThisProcess,
      isRunOwnerAnswering,
      reclaimRunWorktree: cleanup,
      reclaimContainerEnv: mockReclaimContainerEnv,
    });
    await expect(
      operations.abandonResumableRunsForConversation('conv-1', { kind: 'user', userId: 'starter' })
    ).rejects.toBeInstanceOf(RunActionForbiddenError);
    expect(write).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  test('role changes apply on the next action; null starters admit only admin or operator', async () => {
    let role: 'member' | 'admin' = 'member';
    const run = makePausedRun({ status: 'failed', user_id: null });
    const operations = createWorkflowOperations({
      getUserRole: async () => role,
      store: { ...store, getWorkflowRun: async () => run },
      hostStore: { isolation: isolationStore },
      requestDetachedRunStop: mockRequestDetachedRunStop,
      isRunOwnedByThisProcess,
      isRunOwnerAnswering,
      reclaimRunWorktree: async () => ({ warnings: [] }),
      reclaimContainerEnv: mockReclaimContainerEnv,
    });
    const actor: RunActor = { kind: 'user', userId: 'starter' };
    await expect(operations.resumeWorkflow(run.id, actor)).rejects.toBeInstanceOf(
      RunActionForbiddenError
    );
    role = 'admin';
    expect(await operations.resumeWorkflow(run.id, actor)).toBe(run);
    role = 'member';
    expect(await operations.resumeWorkflow(run.id, operator)).toBe(run);
    run.user_id = actor.userId;
    expect(await operations.resumeWorkflow(run.id, actor)).toBe(run);
  });
});

describe('starter, admin and operator can act through core', () => {
  for (const actor of [
    operator,
    { kind: 'user', userId: 'starter' },
    { kind: 'user', userId: 'admin' },
  ] satisfies RunActor[]) {
    for (const action of RUN_ACTIONS) {
      test(`${action} allows ${JSON.stringify(actor)}`, async () => {
        const run = makePausedRun({
          user_id: 'starter',
          status: action === 'cancel' ? 'running' : action === 'delete' ? 'completed' : 'paused',
          metadata: {
            approval: {
              nodeId: 'review',
              message: 'Choose',
              type: 'approval',
              decisionsAuthored: true,
              decisions: [{ id: 'approve' }, { id: 'reject' }, { id: 'custom' }],
            },
            wait: {
              owner: 'node',
              waitingSince: '2026-10-05T00:00:00.000Z',
              kind: 'event',
              nodeId: 'wait',
              event: 'ready',
              futureField: true,
              resumeAt: '2026-10-06T00:00:00.000Z',
            },
          },
        });
        const write = mock(async (..._args: unknown[]) => ({
          resolved: true,
          cancelled: true,
          signaled: true,
        }));
        const operations = createWorkflowOperations({
          getUserRole: async id => (id === 'admin' ? 'admin' : 'member'),
          store: {
            ...store,
            getWorkflowRun: async () => run,
            resolveApprovalGate: write,
            resolveAndCancelApprovalGate: write,
            cancelWorkflowRun: write,
            signalWorkflowWait: async (id, cursor, payload) => {
              expect(workflowWaitContextSchema.parse(cursor)).toEqual(cursor);
              expect(cursor).not.toHaveProperty('futureField');
              return write(id, cursor, payload);
            },
            deleteWorkflowRun: async () => {
              await write();
            },
          },
          hostStore: { isolation: isolationStore },
          requestDetachedRunStop: mockRequestDetachedRunStop,
          isRunOwnedByThisProcess: () => true,
          isRunOwnerAnswering: async () => false,
          reclaimRunWorktree: async () => ({ warnings: [] }),
          reclaimContainerEnv: mockReclaimContainerEnv,
        });
        const calls = {
          approve: () => operations.approveWorkflow(run.id, undefined, actor, { via: 'cli' }),
          reject: () => operations.rejectWorkflow(run.id, undefined, actor, { via: 'cli' }),
          respond: () =>
            operations.respondToWorkflow(run.id, 'custom', undefined, actor, { via: 'cli' }),
          cancel: () => operations.cancelWorkflow(run.id, actor),
          abandon: () => operations.abandonWorkflow(run.id, actor),
          resume: () => operations.resumeWorkflow(run.id, actor),
          signal: () =>
            operations.signalWorkflowWait(
              run.id,
              { event: 'ready', resumeAt: '2026-10-06T00:00:00.000Z' },
              actor
            ),
          delete: () => operations.deleteWorkflowRun(run.id, actor),
        } satisfies Record<RunAction, () => Promise<unknown>>;
        await calls[action]();
        if (action === 'resume') expect(write).not.toHaveBeenCalled();
        else expect(write).toHaveBeenCalledTimes(1);
      });
    }
  }
});
