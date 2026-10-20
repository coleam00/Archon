// @archon-test-isolated
import {
  containerBackend,
  makeCliPlatform,
  makePlatform,
  makeRun,
  makeStore,
  makeWorkflow,
  mocked,
  mockExecuteDagWorkflow,
  mockLogFn,
  resetExecutorMocks,
  resumeOf,
  sentMessages,
  startWorkflow,
} from './executor/test-utils';
import * as checkout from './checkout-observation';
import { removeTempTree } from '@archon/paths/test-utils';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'path';
import type { IWorkflowPlatform } from './deps';
import type { ExecuteWorkflowOptions } from './executor';
import type { WorkflowRun } from './schemas';
import type { CheckoutObservation } from './schemas/checkout-observation';
import type { IWorkflowStore } from './store';
import { TerminalStatusWriteError } from './terminal-status-write';
import { keepAwake } from './utils/keep-awake';

/** How a run claims its row and its checkout: the path lock, row stamps and the checkout baseline. */

beforeEach(resetExecutorMocks);

/** Starts a run whose checkout `blocker` holds and returns the message the user was sent. */
async function blockedBy(
  blocker: WorkflowRun,
  platform: IWorkflowPlatform = makePlatform()
): Promise<string> {
  const result = await startWorkflow({
    platform,
    store: makeStore({ getActiveWorkflowRunByPath: mock(async () => blocker) }),
  });
  expect(result.success).toBe(false);
  expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  return sentMessages(platform)[0] ?? '';
}

describe('concurrent-run guard', () => {
  it('blocks and cancels its own row when the active-workflow check fails', async () => {
    const cancelSpy = mock(async () => ({ cancelled: true }));
    const store = makeStore({
      getActiveWorkflowRunByPath: mock(async () => {
        throw new Error('DB connection lost');
      }),
      cancelWorkflowRun: cancelSpy,
    });
    const result = await startWorkflow({ store });
    if (result.success) throw new Error('Expected workflow guard failure');
    expect(result.error).toContain('Database error');
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    // Blocked before the execution window — keep-awake must never have fired.
    expect(keepAwake.activeCount()).toBe(0);
  });

  it.each([undefined, true])(
    'blocks a run while another holds the checkout (mutates_checkout=%p)',
    async mutatesCheckout => {
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => makeRun({ id: 'other-run-456' })),
      });
      const result = await startWorkflow({
        store,
        workflow: makeWorkflow(
          mutatesCheckout === undefined ? {} : { mutates_checkout: mutatesCheckout }
        ),
      });
      if (result.success) throw new Error('Expected checkout-lock rejection');
      expect(result.error).toContain('already active');
    }
  );

  it('skips the path lock when mutates_checkout is false', async () => {
    const getActiveSpy = mock(async () => makeRun({ id: 'other-run' }));
    const result = await startWorkflow({
      store: makeStore({ getActiveWorkflowRunByPath: getActiveSpy }),
      workflow: makeWorkflow({ mutates_checkout: false }),
    });
    expect(getActiveSpy).not.toHaveBeenCalled();
    expect(result.workflowRunId).toBe('run-123');
  });

  it('passes self-id and started_at to the lock query so self is excluded', async () => {
    // The guard runs after the run row exists; without these args the dispatch's own row
    // would match and falsely trigger the guard.
    const getActiveSpy = mock(async () => null);
    await startWorkflow({
      store: makeStore({
        createWorkflowRun: mock(async () =>
          makeRun({ id: 'self-run-789', started_at: new Date('2026-04-14T10:00:00.000Z') })
        ),
        getActiveWorkflowRunByPath: getActiveSpy,
      }),
    });
    expect(getActiveSpy).toHaveBeenCalledWith(
      '/tmp',
      expect.objectContaining({ id: 'self-run-789', startedAt: expect.any(Date) })
    );
  });

  it('marks self as cancelled when the guard fires (no zombie pending row)', async () => {
    const cancelSpy = mock(async () => ({ cancelled: true }));
    await startWorkflow({
      store: makeStore({
        createWorkflowRun: mock(async () => makeRun({ id: 'self-run-789' })),
        getActiveWorkflowRunByPath: mock(async () => makeRun({ id: 'other-run-456' })),
        cancelWorkflowRun: cancelSpy,
      }),
    });
    // A leaked `pending` row would briefly block future dispatches via the lock query.
    expect(cancelSpy).toHaveBeenCalledWith('self-run-789', {
      cancel_reason: 'precondition_failed',
    });
  });

  it('runs the guard on a pre-created row without creating another', async () => {
    const store = makeStore();
    const result = await startWorkflow({
      store,
      options: { preCreatedRun: makeRun({ id: 'pre-run-1' }) },
    });
    expect(store.getActiveWorkflowRunByPath).toHaveBeenCalled();
    expect(store.createWorkflowRun).not.toHaveBeenCalled();
    expect(result.workflowRunId).toBe('pre-run-1');
  });

  const lockQuery = (queryFails: boolean) =>
    mock(async () => {
      if (queryFails) throw new Error('lock lookup failed');
      return makeRun({ id: 'other-run' });
    });

  it.each([false, true])(
    'propagates self-cancellation rollback (lock query fails=%s)',
    async queryFails => {
      const cause = new Error('self cancellation rolled back');
      const order: string[] = [];
      const platform = makePlatform();
      platform.sendMessage = mock(async () => {
        order.push('notify');
      });
      const store = makeStore({
        createWorkflowRun: mock(async () => makeRun({ id: 'self-run', status: 'pending' })),
        getActiveWorkflowRunByPath: lockQuery(queryFails),
        cancelWorkflowRun: mock(async () => {
          order.push('cancel');
          throw cause;
        }),
      });
      const error: unknown = await startWorkflow({ store, platform }).then(
        () => undefined,
        (error: unknown) => error
      );
      if (!(error instanceof TerminalStatusWriteError))
        throw new Error('Expected terminal write rejection');
      expect(error.cause).toBe(cause);
      expect(order).toEqual(['notify', 'cancel']);
      expect(sentMessages(platform)[0]).toContain(
        queryFails ? 'Unable to verify if another workflow is running' : 'This worktree is in use'
      );
      expect(store.cancelWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'still cancels after notification fails (lock query fails=%s)',
    async queryFails => {
      const order: string[] = [];
      const store = makeStore({
        getActiveWorkflowRunByPath: lockQuery(queryFails),
        cancelWorkflowRun: mock(async () => {
          order.push('cancel');
          return { cancelled: true };
        }),
      });
      const platform = makePlatform();
      const messages: string[] = [];
      platform.sendMessage = mock(async (_conversationId, message) => {
        messages.push(message);
        order.push('notify');
        throw new Error('unauthorized');
      });
      // A critical send retries every failure with a 1s, 2s backoff; clamp the sleep.
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
      let result: Awaited<ReturnType<typeof startWorkflow>>;
      try {
        result = await startWorkflow({ store, platform });
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
      expect(result.success).toBe(false);
      const deliveryLogs = (mockLogFn.mock.calls as unknown[][]).filter(
        call => call[1] === 'critical_message_delivery_failed'
      );
      expect(deliveryLogs).toHaveLength(1);
      expect(deliveryLogs[0]?.[0]).toMatchObject({
        conversationId: 'conv-1',
        messageLength: messages[0]?.length,
      });
      expect(deliveryLogs[0]?.[0]).not.toHaveProperty('messagePreview');
      for (const message of messages) {
        expect(JSON.stringify(deliveryLogs)).not.toContain(message.slice(0, 100));
      }
      expect(order).toEqual(['notify', 'notify', 'notify', 'cancel']);
      expect(store.cancelWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
    }
  );
});

// The lock query returns running, paused and fresh-pending rows, and each needs its own
// next action: telling a user to "wait" on a run paused for their own approval strands them.
describe('checkout-in-use message', () => {
  const blocker = (overrides: Partial<WorkflowRun>) =>
    makeRun({ id: 'abc12345-rest-of-uuid', workflow_name: 'archon-implement', ...overrides });

  it('names the running blocker, its duration and short id, and what to do next', async () => {
    const message = await blockedBy(
      blocker({ started_at: new Date(Date.now() - 125000) }) // 2m 5s ago
    );
    expect(message).toContain('archon-implement');
    expect(message).toContain('abc12345');
    expect(message).toContain('2m5s');
    expect(message).toContain('Wait for it to finish');
    expect(message).toContain('/workflow status');
    expect(message).toContain('/workflow cancel abc12345');
    expect(message).toContain('/workflow abandon abc12345');
    expect(message).toContain('--branch');
  });

  it.each([
    [500, '500ms'],
    [1500, '1.5s'],
    [90000, '1m30s'],
    [119500, '2m0s'],
  ])('shows the shared duration policy for a blocker at %s ms', async (elapsed, expected) => {
    const now = Date.UTC(2026, 9, 15, 12);
    const clock = spyOn(Date, 'now').mockReturnValue(now);
    try {
      const message = await blockedBy(blocker({ started_at: new Date(now - elapsed) }));
      expect(message).toContain(`running ${expected},`);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['event', 'time'] as const)(
    'describes a durable %s wait without offering human approval actions',
    async kind => {
      const resumeAt = '2026-10-06T12:00:00.000Z';
      const message = await blockedBy(
        blocker({
          status: 'paused',
          metadata: {
            wait: {
              owner: 'node',
              nodeId: 'wait-for-checks',
              kind,
              waitingSince: '2026-10-05T12:00:00.000Z',
              resumeAt,
              ...(kind === 'event' ? { event: 'checks.complete' } : {}),
            },
          },
        })
      );
      expect(message).toContain('This worktree is in use');
      expect(message).toContain(resumeAt);
      expect(message).toContain('Wait until');
      expect(message).toContain('/workflow status');
      expect(message).toContain('/workflow abandon abc12345');
      expect(message).toContain('--branch <other>');
      for (const absent of [
        'user input',
        'Approve',
        'Reject',
        '/workflow approve',
        '/workflow reject',
      ])
        expect(message).not.toContain(absent);
      if (kind === 'event') {
        expect(message).toContain('waiting for event `checks.complete`');
        expect(message).toContain('Signal');
        expect(message).toContain('abc12345-rest-of-uuid');
      } else {
        expect(message).toContain('waiting until');
        expect(message).not.toContain('Signal');
      }
    }
  );

  it.each(['node', 'loop_group'] as const)(
    'describes a legacy %s attention wait with answer and resume guidance',
    async owner => {
      const message = await blockedBy(
        blocker({
          status: 'paused',
          metadata: {
            wait: {
              owner,
              nodeId: 'wait-for-access',
              kind: 'attention',
              waitingSince: '2026-10-05T12:00:00.000Z',
              message: 'Restore repository access',
              ...(owner === 'loop_group'
                ? { bodyWaitId: 'access', iteration: 1, sessionId: null, sessionProvider: null }
                : {}),
            },
          },
        })
      );
      expect(message).toContain('needs attention');
      expect(message).toContain('Restore repository access');
      expect(message).toContain('/workflow resume abc12345');
      expect(message).toContain('/workflow abandon abc12345');
      expect(message).toContain('--branch <other>');
      for (const absent of ['user input', '/workflow approve', '/workflow reject'])
        expect(message).not.toContain(absent);
    }
  );

  it('preserves human-pause wording and actions for an approval gate', async () => {
    const message = await blockedBy(
      blocker({
        status: 'paused',
        metadata: { approval: { type: 'approval', nodeId: 'review', message: 'Approve?' } },
      })
    );
    expect(message).toContain('paused waiting for user input');
    expect(message).toContain('/workflow approve abc12345');
    expect(message).toContain('/workflow reject abc12345');
    expect(message).toContain('/workflow abandon abc12345');
    expect(message).toContain('--branch <other>');
    expect(message).not.toContain('Wait for it to finish');
  });

  it.each([
    [
      'child_workflow',
      { type: 'child_workflow', nodeId: 'sub', childRunId: 'child-1' },
      ['child-1'],
    ],
    [
      'fan_out',
      { type: 'fan_out', nodeId: 'work', childRunIds: ['child-1', 'child-2'] },
      ['child-1', 'child-2'],
    ],
  ] as const)(
    'names the sub-runs of a %s gate instead of offering approve or reject',
    async (_type, approval, childRunIds) => {
      const message = await blockedBy(
        blocker({
          status: 'paused',
          metadata: { approval: { ...approval, message: 'Waiting on sub-runs' } },
        })
      );
      expect(message).toContain('paused waiting on sub-runs');
      for (const id of childRunIds) expect(message).toContain(`\`${id}\``);
      expect(message).toContain('/workflow status`');
      expect(message).toContain('/workflow abandon abc12345');
      for (const absent of ['user input', '/workflow approve', '/workflow reject'])
        expect(message).not.toContain(absent);
    }
  );

  it('spells commands the way the platform says (the CLI adapter)', async () => {
    const message = await blockedBy(
      blocker({ started_at: new Date(Date.now() - 125000) }),
      makeCliPlatform()
    );
    expect(message).toContain('archon workflow cancel abc12345');
    expect(message).toContain('archon workflow abandon abc12345');
    expect(message).not.toContain('/workflow cancel');
    expect(message).not.toContain('/workflow status');
  });

  it('offers no cancel for a pending blocker, which has nothing executing yet', async () => {
    const message = await blockedBy(
      blocker({ status: 'pending', started_at: new Date(Date.now() - 5000) }),
      makeCliPlatform()
    );
    expect(message).toContain('starting');
    expect(message).toContain('archon workflow abandon abc12345');
    expect(message).not.toContain('workflow cancel');
  });

  it('offers approve, reject and abandon but no cancel for a paused blocker', async () => {
    const message = await blockedBy(blocker({ status: 'paused' }), makeCliPlatform());
    expect(message).toContain('archon workflow approve abc12345');
    expect(message).toContain('archon workflow reject abc12345');
    // A paused run has no live work for cancel to stop; abandon discards it.
    expect(message).toContain('archon workflow abandon abc12345');
    expect(message).not.toContain('workflow cancel');
  });
});

describe('run row stamps', () => {
  it.each(['fresh', 'precreated', 'resume'] as const)(
    'persists creation proof only on %s invocation',
    async mode => {
      const store = makeStore();
      const original = {
        envId: 'env-original',
        creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
      };
      const incoming = { envId: 'env-new', creationId: 'c226ac7a-33cb-4ae0-aa9f-f07df1141dde' };
      const prior = makeRun({
        status: mode === 'precreated' ? 'pending' : 'running',
        metadata: { owned_worktree: original },
      });
      const options: ExecuteWorkflowOptions =
        mode === 'fresh'
          ? { ownedWorktree: incoming }
          : {
              ownedWorktree: incoming,
              ...(mode === 'resume' ? resumeOf(prior) : { preCreatedRun: prior }),
            };
      await startWorkflow({ store, cwd: '/repo', options });
      if (mode === 'fresh') {
        expect(store.createWorkflowRun).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({ owned_worktree: incoming }),
          })
        );
        return;
      }
      const proofWrites = mocked(store.updateWorkflowRun).mock.calls.flatMap(([, update]) =>
        update.metadata?.owned_worktree === undefined ? [] : [update.metadata.owned_worktree]
      );
      expect(proofWrites).toEqual(mode === 'precreated' ? [incoming] : []);
      expect(prior.metadata.owned_worktree).toEqual(original);
    }
  );

  describe('execution owner record (#2325)', () => {
    const uid = process.getuid?.();
    const owner = {
      execution_owner: {
        host: hostname(),
        pid: process.pid,
        ...(uid === undefined ? {} : { uid }),
      },
    };

    it('stamps this process on a run it creates', async () => {
      const store = makeStore();
      await startWorkflow({ store });
      expect(store.createWorkflowRun).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining(owner) })
      );
    });

    it.each([
      ['a row a launcher pre-created', { preCreatedRun: makeRun({ status: 'pending' }) }],
      ['a resumed run', resumeOf(makeRun())],
    ])('restamps this process on %s', async (_label, options) => {
      const store = makeStore({ claimPendingWorkflowRun: mock(async () => makeRun()) });
      await startWorkflow({ store, options });
      expect(store.updateWorkflowRun).toHaveBeenCalledWith(
        'run-123',
        expect.objectContaining({ metadata: expect.objectContaining(owner) })
      );
    });
  });

  // #2872 — `run --detach` writes the row before it forks, so `Started` names a queryable
  // run. Only the child knows the checkout, so it fills the path in.
  it('fills in the working path of a row created before its checkout existed', async () => {
    const store = makeStore();
    await startWorkflow({
      store,
      cwd: '/tmp/worktree',
      options: { preCreatedRun: makeRun({ id: 'pending-run', status: 'pending' }) },
    });
    expect(store.updateWorkflowRun).toHaveBeenCalledWith(
      'pending-run',
      expect.objectContaining({ working_path: '/tmp/worktree' })
    );
  });

  it('never rewrites the working path of a row that already has one', async () => {
    const updateRun = mock<IWorkflowStore['updateWorkflowRun']>(async () => {});
    await startWorkflow({
      store: makeStore({ updateWorkflowRun: updateRun }),
      cwd: '/tmp/somewhere-else',
      options: {
        preCreatedRun: makeRun({
          id: 'pending-run',
          status: 'pending',
          working_path: '/tmp/original',
        }),
      },
    });
    expect(updateRun).toHaveBeenCalled();
    for (const [, update] of updateRun.mock.calls) {
      expect(update).not.toHaveProperty('working_path');
    }
  });

  // Without this stamp a resume of a detached container run (#2872) would silently restart
  // in place on the live root instead of rediscovering its container.
  it('stamps container isolation onto a fresh pre-created row', async () => {
    const store = makeStore();
    await startWorkflow({
      store,
      cwd: '/tmp/ops',
      options: {
        preCreatedRun: makeRun({ id: 'pending-run', status: 'pending' }),
        execContext: { kind: 'container', containerId: 'cid' },
        container: { envId: 'env-x', writeBack: 'approve', backend: containerBackend() },
      },
    });
    expect(store.updateWorkflowRun).toHaveBeenCalledWith(
      'pending-run',
      expect.objectContaining({
        metadata: expect.objectContaining({ isolation: 'container', isolation_env_id: 'env-x' }),
      })
    );
  });
});

describe('run checkout baseline (#3305)', () => {
  const commit = 'a'.repeat(40);
  let repo: string;
  let sampler: ReturnType<typeof spyOn<typeof checkout, 'sampleCheckout'>>;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'archon-run-baseline-'));
    sampler = spyOn(checkout, 'sampleCheckout').mockResolvedValue({
      observation: {
        kind: 'git',
        sampledAt: new Date().toISOString(),
        commit,
        tree: 'b'.repeat(40),
      },
      worktree: { status: 'clean' },
    });
  });

  afterEach(async () => {
    sampler.mockRestore();
    await removeTempTree(repo);
  });

  it('records one baseline after the execution claim and before the first node', async () => {
    const order: string[] = [];
    const store = makeStore({
      claimPendingWorkflowRun: mock(async () => {
        order.push('claim');
        return makeRun();
      }),
      recordWorkflowRunCheckoutBaseline: mock(
        async (_id: string, baseline: CheckoutObservation) => {
          order.push('baseline');
          return baseline;
        }
      ),
    });
    mockExecuteDagWorkflow.mockImplementationOnce(async () => {
      order.push('first node');
      return undefined;
    });

    await startWorkflow({ store, cwd: repo, options: { cutFromCommit: commit } });

    expect(order).toEqual(['claim', 'baseline', 'first node']);
    expect(sampler).toHaveBeenCalledTimes(1);
    expect(sampler).toHaveBeenCalledWith(repo, { kind: 'host' });
    // The claim carries the checkout so a pre-created row without a path is fenced by it.
    expect(store.claimPendingWorkflowRun).toHaveBeenCalledWith('run-123', repo);
    expect(store.recordWorkflowRunCheckoutBaseline).toHaveBeenCalledTimes(1);
    expect(store.recordWorkflowRunCheckoutBaseline).toHaveBeenCalledWith(
      'run-123',
      expect.objectContaining({
        kind: 'git',
        commit,
        cutFromCommit: commit,
        worktree: { status: 'clean' },
      })
    );
  });

  it('a resume never records a baseline of its own', async () => {
    const store = makeStore();
    await startWorkflow({ store, cwd: repo, options: resumeOf(makeRun()) });
    expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
    expect(store.recordWorkflowRunCheckoutBaseline).not.toHaveBeenCalled();
  });

  it('fails the run before any node when the baseline cannot be persisted', async () => {
    const store = makeStore({
      recordWorkflowRunCheckoutBaseline: mock(async () => {
        throw new Error('disk full');
      }),
    });
    const result = await startWorkflow({ store, cwd: repo });
    expect(result.success).toBe(false);
    expect(store.failWorkflowRun).toHaveBeenCalledWith(
      'run-123',
      'Checkout baseline could not be recorded: disk full'
    );
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });
});
