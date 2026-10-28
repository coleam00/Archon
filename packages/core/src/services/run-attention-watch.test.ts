// @archon-test-isolated
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { hostname } from 'node:os';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { RunLiveOwnerWatchEvent, RunLiveOwnerWatchResult } from './run-live-owner';
import type { RunDoorbell } from './run-attention-watch';
import { DEFAULT_TEST_TIMEOUT_MS } from '@archon/paths/test-utils';

/**
 * The rows the waiter can see, keyed by run id. Mutating this between reads is how a
 * test simulates another process committing a transition.
 */
const rows = new Map<string, WorkflowRun>();
const mockGetWorkflowRun = mock((id: string) => Promise.resolve(rows.get(id) ?? null));

const store = { getWorkflowRun: mockGetWorkflowRun };
let doorbell: RunDoorbell | undefined;

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

let reachableOwners: Set<string> | null = null;
const ownerEvents = new Map<string, (event: RunLiveOwnerWatchEvent) => void>();
const ownerUnsubscribes: ReturnType<typeof mock>[] = [];
const mockWatchRunLiveOwner = mock(
  (
    runId: string,
    onEvent: (event: RunLiveOwnerWatchEvent) => void
  ): Promise<RunLiveOwnerWatchResult> => {
    if (reachableOwners !== null && !reachableOwners.has(runId))
      return Promise.resolve({ kind: 'unreachable' });
    ownerEvents.set(runId, onEvent);
    const unsubscribe = mock(() => undefined);
    ownerUnsubscribes.push(unsubscribe);
    return Promise.resolve({ kind: 'attached', handle: { unsubscribe } });
  }
);
mock.module('./run-live-owner', () => ({
  watchRunLiveOwner: mockWatchRunLiveOwner,
}));

const { observeRunOwner, runOwnerLossWatch, waitForRunAttention } = await import(
  './run-attention-watch'
);
const { DETACHED_RUN_STOP_HANDOFF_GRACE_MS, DETACHED_RUN_TERMINATION_MAX_MS } = await import(
  './run-stop-bounds'
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const localUid = process.getuid?.();
const localOwner = {
  execution_owner: {
    host: hostname(),
    pid: 4242,
    ...(localUid === undefined ? {} : { uid: localUid }),
  },
};
const foreignOwner = { execution_owner: { host: 'other-host.invalid', pid: 4242 } };

/** Rows carry this host's execution-owner stamp unless a test says otherwise. */
function putRun(id: string, over: Partial<WorkflowRun> = {}): WorkflowRun {
  const run = {
    origin: { conversationId: 'conv-1' },
    id,
    workflow_name: 'demo',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: 'go',
    metadata: localOwner,
    started_at: new Date('2026-08-28T10:00:00.000Z'),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    ...over,
  } as WorkflowRun;
  rows.set(id, run);
  return run;
}

const gate = (over: Record<string, unknown> = {}) => ({
  approval: { nodeId: 'review', message: 'Approve the plan.', ...over },
});

const wait = (runId: string, over: Record<string, unknown> = {}) =>
  waitForRunAttention(store, runId, { doorbell, pollIntervalMs: 5, deadlineMs: 3000, ...over });

async function waitForOwner(runId: string): Promise<void> {
  const deadline = Date.now() + DEFAULT_TEST_TIMEOUT_MS;
  while (!ownerEvents.has(runId)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for owner ${runId}`);
    await Bun.sleep(5);
  }
}

beforeEach(() => {
  rows.clear();
  mockGetWorkflowRun.mockImplementation((id: string) => Promise.resolve(rows.get(id) ?? null));
  mockGetWorkflowRun.mockClear();
  doorbell = undefined;
  reachableOwners = null;
  ownerEvents.clear();
  ownerUnsubscribes.length = 0;
  mockWatchRunLiveOwner.mockClear();
});

// ---------------------------------------------------------------------------

describe('waitForRunAttention', () => {
  test.each([false, true])(
    'running advisory returns the affected child identity: %s',
    async child => {
      const calls = [
        {
          streamId: 'stream',
          nodeId: 'implement',
          provider: 'codex',
          toolCallId: 'tool',
          name: 'bash',
          startedAt: '2026-10-01T00:00:00.000Z',
          lastProgressAt: '2026-10-01T00:00:00.000Z',
          raisedAt: '2026-10-01T00:30:00.000Z',
          thresholdMs: 1800000,
        },
      ];
      const affected = putRun('affected', { metadata: { tool_call_attention: calls } });
      if (child)
        putRun('parent', {
          status: 'paused',
          metadata: gate({ type: 'child_workflow', childRunId: 'affected' }),
        });
      const result = await wait(child ? 'parent' : 'affected');
      expect(result).toMatchObject({
        kind: 'attention',
        attention: {
          kind: 'stalled_tool_calls',
          runId: 'affected',
          status: 'running',
          calls: [{ nodeId: 'implement', toolCallId: 'tool' }],
        },
      });
      expect(affected.status).toBe('running');
      expect(mockWatchRunLiveOwner).not.toHaveBeenCalled();
      affected.metadata = {};
      expect(await wait('affected', { deadlineMs: 10 })).toMatchObject({
        kind: 'deadline',
        observedStatus: 'running',
      });
    }
  );
  test('returns not_found for an id that names no run', async () => {
    // Distinct from every other outcome: waiting on an id that does not exist must
    // not look like waiting on a live run.
    expect(await wait('nope')).toEqual({ kind: 'not_found', runId: 'nope' });
  });

  test('an already-terminal run answers on the first read, with no waiting', async () => {
    // AC4: durable, not live-only. A host that attaches after the transition gets
    // the same value one that attached before it would have.
    const at = new Date('2026-08-28T11:00:00.000Z');
    putRun('r1', { status: 'completed', completed_at: at });

    const result = await wait('r1');

    expect(result).toEqual({
      kind: 'attention',
      attention: { kind: 'terminal', runId: 'r1', status: 'completed', at },
    });
    expect(mockGetWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockWatchRunLiveOwner).not.toHaveBeenCalled();
  });

  test('reports owner_lost after a second active read without mutating the row', async () => {
    const before = putRun('r1', { status: 'running' });
    reachableOwners = new Set();

    expect(await wait('r1')).toEqual({
      kind: 'owner_lost',
      runId: 'r1',
      observedStatus: 'running',
    });
    expect(mockGetWorkflowRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(rows.get('r1')).toEqual(before);
  });

  test('an owner on another host is unknown, not lost, and the wait keeps watching', async () => {
    const before = putRun('r1', { status: 'running', metadata: foreignOwner });
    reachableOwners = new Set();
    const announced: unknown[] = [];

    const result = await wait('r1', {
      deadlineMs: 50,
      onAttached: (...args: unknown[]) => {
        announced.push(args);
      },
    });

    expect(result).toEqual({ kind: 'deadline', runId: 'r1', observedStatus: 'running' });
    expect(announced).toEqual([
      ['running', { kind: 'unknown', recordedOwner: foreignOwner.execution_owner }],
    ]);
    expect(rows.get('r1')).toEqual(before);
  });

  test.skipIf(localUid === undefined)(
    'an owner on this host under another user is unknown, not lost',
    async () => {
      putRun('r1', {
        status: 'running',
        metadata: { execution_owner: { host: hostname(), pid: 4242, uid: (localUid ?? 0) + 1 } },
      });
      reachableOwners = new Set();

      expect(await wait('r1', { deadlineMs: 50 })).toMatchObject({ kind: 'deadline' });
    }
  );

  test('a run that records no owner is unknown, not lost', async () => {
    putRun('r1', { status: 'running', metadata: {} });
    reachableOwners = new Set();
    const announced: unknown[] = [];

    expect(
      await wait('r1', {
        deadlineMs: 50,
        onAttached: (...args: unknown[]) => {
          announced.push(args);
        },
      })
    ).toMatchObject({ kind: 'deadline' });
    expect(announced).toEqual([['running', { kind: 'unknown', recordedOwner: undefined }]]);
  });

  test('a wait on an owner on another host still answers from the durable row', async () => {
    putRun('r1', { status: 'running', metadata: foreignOwner });
    reachableOwners = new Set();

    expect(
      await wait('r1', {
        onAttached: () => {
          putRun('r1', {
            status: 'completed',
            metadata: foreignOwner,
            completed_at: new Date(),
          });
        },
      })
    ).toMatchObject({ kind: 'attention', attention: { kind: 'terminal', status: 'completed' } });
  });

  test('keeps an unproven ancestor waiting even when the child endpoint is absent', async () => {
    putRun('parent', { status: 'running' });
    putRun('child', { status: 'running', parent_run_id: 'parent' });
    mockWatchRunLiveOwner.mockImplementationOnce(async () => ({ kind: 'unreachable' }));
    mockWatchRunLiveOwner.mockImplementationOnce(async () => ({ kind: 'unproven' }));
    mockWatchRunLiveOwner.mockImplementationOnce(async () => ({ kind: 'unreachable' }));
    mockWatchRunLiveOwner.mockImplementationOnce(async () => ({ kind: 'unproven' }));

    expect(await wait('child', { deadlineMs: 0 })).toEqual({
      kind: 'deadline',
      runId: 'child',
      observedStatus: 'running',
    });
    expect(mockWatchRunLiveOwner.mock.calls.map(call => call[0])).toEqual([
      'child',
      'parent',
      'child',
      'parent',
    ]);
  });

  test('a terminal row racing a missing owner wins', async () => {
    const running = putRun('r1', { status: 'running' });
    const completed = { ...running, status: 'completed', completed_at: new Date() } as WorkflowRun;
    reachableOwners = new Set();
    let reads = 0;
    mockGetWorkflowRun.mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? running : completed;
    });

    expect(await wait('r1')).toMatchObject({
      kind: 'attention',
      attention: { kind: 'terminal', status: 'completed' },
    });
  });

  test('owner attention wakes a durable re-read without waiting for the interval', async () => {
    putRun('r1', { status: 'running' });
    const pending = waitForRunAttention(store, 'r1', { pollIntervalMs: 60_000, deadlineMs: 3000 });
    await waitForOwner('r1');
    putRun('r1', { status: 'completed', completed_at: new Date() });
    ownerEvents.get('r1')?.('attention');

    expect(await pending).toMatchObject({
      kind: 'attention',
      attention: { kind: 'terminal', status: 'completed' },
    });
  });

  test('an unexpected owner disconnect wakes immediately as owner_lost', async () => {
    putRun('r1', { status: 'running' });
    const pending = waitForRunAttention(store, 'r1', { pollIntervalMs: 60_000, deadlineMs: 3000 });
    await waitForOwner('r1');
    reachableOwners = new Set();
    ownerEvents.get('r1')?.('disconnected');

    expect(await pending).toEqual({
      kind: 'owner_lost',
      runId: 'r1',
      observedStatus: 'running',
    });
  });

  test('does not lose a disconnect delivered with the owner handshake', async () => {
    putRun('r1', { status: 'running' });
    reachableOwners = new Set(['r1']);
    mockWatchRunLiveOwner.mockImplementationOnce((runId, onEvent) => {
      ownerEvents.set(runId, onEvent);
      const unsubscribe = mock(() => undefined);
      ownerUnsubscribes.push(unsubscribe);
      reachableOwners = new Set();
      onEvent('disconnected');
      return Promise.resolve({ kind: 'attached', handle: { unsubscribe } });
    });

    expect(await wait('r1')).toEqual({
      kind: 'owner_lost',
      runId: 'r1',
      observedStatus: 'running',
    });
    expect(ownerUnsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  test('a stop handoff gives the controller bounded time to persist cancellation', async () => {
    putRun('r1', { status: 'running' });
    const pending = waitForRunAttention(store, 'r1', { pollIntervalMs: 20, deadlineMs: 3000 });
    await waitForOwner('r1');
    ownerEvents.get('r1')?.('control_handoff');
    reachableOwners = new Set();
    ownerEvents.get('r1')?.('disconnected');
    await Bun.sleep(5);
    putRun('r1', { status: 'cancelled', completed_at: new Date() });

    expect(await pending).toMatchObject({
      kind: 'attention',
      attention: { kind: 'terminal', status: 'cancelled' },
    });
  });

  test('a stop handoff outlasts the slowest stop the controller can still finish', async () => {
    // A Windows stop can list the process table several times after the owner is gone,
    // each listing bounded only by its command timeout. A waiter that gave up before the
    // controller's own bound would report owner_lost for a run that ends cancelled.
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      putRun('r1', { status: 'running' });
      let settled = false;
      const pending = waitForRunAttention(store, 'r1', { pollIntervalMs: 5 }).finally(() => {
        settled = true;
      });
      await waitForOwner('r1');
      ownerEvents.get('r1')?.('control_handoff');
      reachableOwners = new Set();
      ownerEvents.get('r1')?.('disconnected');

      now += DETACHED_RUN_TERMINATION_MAX_MS;
      await Bun.sleep(20);
      expect(settled).toBe(false);
      putRun('r1', { status: 'cancelled', completed_at: new Date() });

      expect(await pending).toMatchObject({
        kind: 'attention',
        attention: { kind: 'terminal', status: 'cancelled' },
      });
    } finally {
      Date.now = realNow;
    }
  });

  test('a stop handoff expires when the controller never persists a transition', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      putRun('r1', { status: 'running' });
      let settled = false;
      const pending = waitForRunAttention(store, 'r1', { pollIntervalMs: 5 }).finally(() => {
        settled = true;
      });
      await waitForOwner('r1');
      ownerEvents.get('r1')?.('control_handoff');
      reachableOwners = new Set();
      ownerEvents.get('r1')?.('disconnected');

      await Bun.sleep(20);
      expect(settled).toBe(false);
      now += DETACHED_RUN_STOP_HANDOFF_GRACE_MS + 1;

      expect(await pending).toEqual({
        kind: 'owner_lost',
        runId: 'r1',
        observedStatus: 'running',
      });
    } finally {
      Date.now = realNow;
    }
  });

  test('announces the attachment once, with the status the opening read saw', async () => {
    // The one moment a caller cannot infer for itself. A transition after it reached
    // the caller as a wake; the same transition before it would have been an ordinary
    // read of a row that had already settled. Several re-reads happen inside this
    // deadline, and none of them is a second attachment.
    putRun('r1', { status: 'running' });
    const attached: string[] = [];

    const result = await waitForRunAttention(store, 'r1', {
      pollIntervalMs: 5,
      deadlineMs: 40,
      onAttached: status => {
        attached.push(status);
      },
    });

    expect(result).toMatchObject({ kind: 'deadline', observedStatus: 'running' });
    expect(attached).toEqual(['running']);
    expect(ownerUnsubscribes).toHaveLength(1);
    expect(ownerUnsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  test('says nothing about attaching when the first read already has an answer', async () => {
    // Nothing was ever waited for, so there is no watch to announce.
    const attached: string[] = [];
    putRun('r1', { status: 'completed', completed_at: new Date('2026-08-28T11:00:00.000Z') });

    await wait('r1', {
      onAttached: (status: string) => {
        attached.push(status);
      },
    });

    expect(attached).toEqual([]);
  });

  test.each(['completed', 'failed', 'cancelled'] as const)(
    'wakes on a %s written after the wait began',
    async status => {
      putRun('r1', { status: 'running' });
      const pending = wait('r1');
      await Bun.sleep(20);
      putRun('r1', { status, completed_at: new Date('2026-08-28T11:00:00.000Z') });

      const result = await pending;

      expect(result).toMatchObject({ kind: 'attention', attention: { kind: 'terminal', status } });
    }
  );

  test('wakes with awaiting_response when the run parks on a gate', async () => {
    putRun('r1', { status: 'running' });
    const pending = wait('r1');
    await Bun.sleep(20);
    putRun('r1', { status: 'paused', metadata: gate() });

    expect(await pending).toEqual({
      kind: 'attention',
      attention: {
        kind: 'awaiting_response',
        runId: 'r1',
        respondTo: { runId: 'r1', nodeId: 'review' },
        occurrence: 'legacy:review',
        message: 'Approve the plan.',
      },
    });
  });

  test('a `wait:` pause does not wake the waiter', async () => {
    // AC3. The clock owns the resumption, not a person.
    putRun('r1', {
      status: 'paused',
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'hold',
          kind: 'time',
          waitingSince: '2026-08-28T10:00:00.000Z',
          resumeAt: '2026-08-28T11:00:00.000Z',
        },
      },
    });

    expect(await wait('r1', { deadlineMs: 60 })).toEqual({
      kind: 'deadline',
      runId: 'r1',
      observedStatus: 'paused',
    });
    expect(mockWatchRunLiveOwner).not.toHaveBeenCalled();
  });

  test('a root pending row is intentionally ownerless', async () => {
    putRun('r1', { status: 'pending' });

    expect(await wait('r1', { deadlineMs: 30 })).toMatchObject({ kind: 'deadline' });
    expect(mockWatchRunLiveOwner).not.toHaveBeenCalled();
  });

  test('an attention wait wakes with its authored message', async () => {
    putRun('r1', {
      status: 'paused',
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'rerun-ci',
          kind: 'attention',
          waitingSince: '2026-08-28T10:00:00.000Z',
          message: 'Rerun the failed check.',
        },
      },
    });

    expect(await wait('r1')).toEqual({
      kind: 'attention',
      attention: {
        kind: 'attention',
        runId: 'r1',
        nodeId: 'rerun-ci',
        occurrence: 'legacy:rerun-ci',
        message: 'Rerun the failed check.',
        form: 'message',
        options: [],
      },
    });
  });

  test('a resolved gate awaiting auto-resume does not wake the waiter', async () => {
    putRun('r1', { status: 'paused', metadata: gate({ resolved: 'approved' }) });

    expect(await wait('r1', { deadlineMs: 60 })).toMatchObject({ kind: 'deadline' });
  });

  describe('the sub-run chain', () => {
    const blockedOn = (childRunId: string) =>
      gate({ type: 'child_workflow', nodeId: 'sub', childRunId });

    test('a parent blocked on a merely running child wakes nobody', async () => {
      // The dangerous direction the parent row alone gets wrong: this is normal
      // progress, and asserting attention here would wake a host constantly.
      putRun('parent', { status: 'paused', metadata: blockedOn('child') });
      putRun('child', { status: 'running' });

      expect(await wait('parent', { deadlineMs: 60 })).toMatchObject({ kind: 'deadline' });
    });

    test('the same parent wakes once the child hits its own gate', async () => {
      putRun('parent', { status: 'paused', metadata: blockedOn('child') });
      putRun('child', { status: 'running' });
      const pending = wait('parent');
      await Bun.sleep(20);
      putRun('child', { status: 'paused', metadata: gate({ nodeId: 'child-gate' }) });

      expect(await pending).toEqual({
        kind: 'attention',
        attention: {
          kind: 'awaiting_response',
          runId: 'child',
          respondTo: { runId: 'child', nodeId: 'child-gate' },
          occurrence: 'legacy:child-gate',
          message: 'Approve the plan.',
        },
      });
    });

    test('a chain resolves to the deepest run that needs a human', async () => {
      putRun('grandparent', { status: 'paused', metadata: blockedOn('parent') });
      putRun('parent', { status: 'paused', metadata: blockedOn('child') });
      putRun('child', { status: 'paused', metadata: gate({ nodeId: 'deep-gate' }) });

      expect(await wait('grandparent')).toMatchObject({
        kind: 'attention',
        attention: {
          kind: 'awaiting_response',
          respondTo: { runId: 'child', nodeId: 'deep-gate' },
        },
      });
    });

    test('a terminal child keeps the waiter waiting for the parent to re-enter', async () => {
      // `maybeResumeParentRun` is opportunistic, so a waiter cannot tell "resume in
      // flight" from "resume dropped" — and must not guess.
      putRun('parent', { status: 'paused', metadata: blockedOn('child') });
      putRun('child', { status: 'completed', completed_at: new Date() });

      expect(await wait('parent', { deadlineMs: 60 })).toMatchObject({ kind: 'deadline' });
    });

    test('a blocked parent watches its process-entry ancestor and reports its own status', async () => {
      putRun('parent', { status: 'paused', metadata: blockedOn('child') });
      putRun('child', { status: 'running', parent_run_id: 'parent' });
      reachableOwners = new Set(['parent']);
      const pending = waitForRunAttention(store, 'parent', {
        pollIntervalMs: 60_000,
        deadlineMs: 3000,
      });
      await waitForOwner('parent');
      expect(mockWatchRunLiveOwner.mock.calls.map(call => call[0]).slice(0, 2)).toEqual([
        'child',
        'parent',
      ]);

      reachableOwners = new Set();
      ownerEvents.get('parent')?.('disconnected');
      expect(await pending).toEqual({
        kind: 'owner_lost',
        runId: 'parent',
        observedStatus: 'paused',
      });
    });

    test.each([
      ['another host', foreignOwner, 'deadline'],
      ['this host', localOwner, 'owner_lost'],
    ] as const)(
      'an unclaimed child reads its owner from the parent on %s',
      async (_where, parentOwner, expected) => {
        putRun('parent', {
          status: 'paused',
          metadata: { ...blockedOn('child'), ...parentOwner },
        });
        putRun('child', { status: 'pending', parent_run_id: 'parent', metadata: {} });
        reachableOwners = new Set();

        expect(await wait('parent', { deadlineMs: 50 })).toMatchObject({ kind: expected });
      }
    );

    test.each([
      ['another host', foreignOwner, 'deadline'],
      ['this host', localOwner, 'owner_lost'],
    ] as const)(
      'a direct wait on an unstamped running child reads its owner from the parent on %s',
      async (_where, parentOwner, expected) => {
        // A claimed child is `running` before its own stamp lands; its process is the parent's.
        putRun('parent', {
          status: 'paused',
          metadata: { ...blockedOn('child'), ...parentOwner },
        });
        putRun('child', { status: 'running', parent_run_id: 'parent', metadata: {} });
        reachableOwners = new Set();

        expect(await wait('child', { deadlineMs: 50 })).toMatchObject({ kind: expected });
      }
    );

    test('a direct child wait can attach to the same ancestor owner', async () => {
      putRun('parent', { status: 'paused', metadata: blockedOn('child') });
      putRun('child', { status: 'running', parent_run_id: 'parent' });
      reachableOwners = new Set(['parent']);

      expect(await wait('child', { deadlineMs: 30 })).toMatchObject({ kind: 'deadline' });
      expect(mockWatchRunLiveOwner.mock.calls.map(call => call[0]).slice(0, 2)).toEqual([
        'child',
        'parent',
      ]);
    });

    test('a separately resumed child prefers its own owner endpoint', async () => {
      putRun('parent', { status: 'paused', metadata: blockedOn('child') });
      putRun('child', { status: 'running', parent_run_id: 'parent' });
      reachableOwners = new Set(['child', 'parent']);

      expect(await wait('child', { deadlineMs: 30 })).toMatchObject({ kind: 'deadline' });
      expect(mockWatchRunLiveOwner.mock.calls[0]?.[0]).toBe('child');
      expect(mockWatchRunLiveOwner.mock.calls.some(call => call[0] === 'parent')).toBe(false);
    });

    test('a dangling child pointer is unreadable, not an assumed state', async () => {
      putRun('parent', { status: 'paused', metadata: blockedOn('ghost') });

      expect(await wait('parent')).toMatchObject({
        kind: 'attention',
        attention: { kind: 'unreadable', runId: 'parent', reason: 'child_run_missing' },
      });
    });

    describe('a fan-out parent blocked on several children', () => {
      const blockedOnAll = (...childRunIds: string[]) =>
        gate({ type: 'fan_out', nodeId: 'work', childRunIds });

      test('wakes with the first child that needs an answer, never the parent', async () => {
        putRun('parent', { status: 'paused', metadata: blockedOnAll('c1', 'c2') });
        putRun('c1', { status: 'completed', completed_at: new Date(), parent_run_id: 'parent' });
        putRun('c2', {
          status: 'paused',
          parent_run_id: 'parent',
          metadata: gate({ nodeId: 'c2-gate' }),
        });

        expect(await wait('parent')).toMatchObject({
          kind: 'attention',
          attention: {
            kind: 'awaiting_response',
            runId: 'c2',
            respondTo: { runId: 'c2', nodeId: 'c2-gate' },
          },
        });
      });

      test('with no child needing an answer, watches the running child', async () => {
        putRun('parent', { status: 'paused', metadata: blockedOnAll('c1', 'c2') });
        putRun('c1', { status: 'running', parent_run_id: 'parent' });
        putRun('c2', {
          status: 'paused',
          parent_run_id: 'parent',
          metadata: {
            wait: {
              owner: 'node',
              nodeId: 'hold',
              kind: 'time',
              waitingSince: '2026-08-28T10:00:00.000Z',
              resumeAt: '2026-08-28T11:00:00.000Z',
            },
          },
        });
        reachableOwners = new Set(['c1']);

        expect(await wait('parent', { deadlineMs: 30 })).toMatchObject({ kind: 'deadline' });
        expect(mockWatchRunLiveOwner.mock.calls[0]?.[0]).toBe('c1');
      });

      // A finished child's hook stands down while the gate still waits on a sibling,
      // so nothing owns that child: it must not be the run the waiter watches.
      test('a finished child does not need an owner while a sibling is unfinished', async () => {
        putRun('parent', { status: 'paused', metadata: blockedOnAll('c1', 'c2') });
        putRun('c1', { status: 'completed', completed_at: new Date(), parent_run_id: 'parent' });
        putRun('c2', { status: 'running', parent_run_id: 'parent' });
        reachableOwners = new Set(['c2']);

        expect(await wait('parent', { deadlineMs: 30 })).toMatchObject({ kind: 'deadline' });
        expect(mockWatchRunLiveOwner.mock.calls.map(call => call[0])).not.toContain('c1');
      });

      test('the finished child needs an owner once it released the gate', async () => {
        putRun('parent', { status: 'paused', metadata: blockedOnAll('c1', 'c2') });
        putRun('c1', { status: 'completed', completed_at: new Date(), parent_run_id: 'parent' });
        putRun('c2', { status: 'failed', completed_at: new Date(), parent_run_id: 'parent' });
        reachableOwners = new Set();

        expect(await wait('parent', { deadlineMs: 50 })).toMatchObject({ kind: 'owner_lost' });
      });

      // Only the child that finished last continues the parent, and the rows do not say
      // which one that was.
      test('once released, any finished child can be the live owner', async () => {
        putRun('parent', { status: 'paused', metadata: blockedOnAll('c1', 'c2') });
        putRun('c1', { status: 'completed', completed_at: new Date(), parent_run_id: 'parent' });
        putRun('c2', { status: 'completed', completed_at: new Date(), parent_run_id: 'parent' });
        reachableOwners = new Set(['c2']);

        expect(await wait('parent', { deadlineMs: 30 })).toMatchObject({ kind: 'deadline' });
      });

      test('once released, an unreachable child on another host keeps the parent unknown', async () => {
        putRun('parent', { status: 'paused', metadata: blockedOnAll('c1', 'c2') });
        putRun('c1', { status: 'completed', completed_at: new Date(), parent_run_id: 'parent' });
        putRun('c2', {
          status: 'completed',
          completed_at: new Date(),
          parent_run_id: 'parent',
          metadata: foreignOwner,
        });
        reachableOwners = new Set();

        expect(await wait('parent', { deadlineMs: 50 })).toMatchObject({ kind: 'deadline' });
      });
    });

    test('a chain longer than the bound is unreadable, not an assumed state', async () => {
      for (let i = 0; i < 520; i += 1) {
        putRun(`r${String(i)}`, { status: 'paused', metadata: blockedOn(`r${String(i + 1)}`) });
      }
      putRun('r520', { status: 'paused', metadata: gate({ nodeId: 'deep' }) });

      expect(await wait('r0')).toMatchObject({
        kind: 'attention',
        attention: { kind: 'unreadable', runId: 'r0', reason: 'child_chain_too_deep' },
      });
    });
  });

  test('a deadline reports the observed status and never a synthesized terminal one', async () => {
    // AC5: the caller must destructure `kind` before it can reach a status, so a
    // deadline cannot be read as "the run finished".
    putRun('r1', { status: 'running' });

    const result = await wait('r1', { deadlineMs: 40 });

    expect(result).toEqual({ kind: 'deadline', runId: 'r1', observedStatus: 'running' });
  });

  test('an abort returns its own variant and leaves the run row untouched', async () => {
    const before = putRun('r1', { status: 'running' });
    const controller = new AbortController();
    const pending = wait('r1', { signal: controller.signal, deadlineMs: 5000 });
    await Bun.sleep(20);
    controller.abort();

    expect(await pending).toEqual({ kind: 'aborted', runId: 'r1' });
    expect(rows.get('r1')).toEqual(before);
    expect(ownerUnsubscribes).toHaveLength(1);
    expect(ownerUnsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  test('an already-aborted signal returns before any read', async () => {
    putRun('r1', { status: 'running' });

    expect(await wait('r1', { signal: AbortSignal.abort() })).toEqual({
      kind: 'aborted',
      runId: 'r1',
    });
    expect(mockGetWorkflowRun).not.toHaveBeenCalled();
  });

  test('two concurrent waiters on one run both receive the attention', async () => {
    putRun('r1', { status: 'running' });
    const first = wait('r1');
    const second = wait('r1');
    await Bun.sleep(20);
    putRun('r1', { status: 'failed', completed_at: new Date() });

    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(a).toMatchObject({ attention: { kind: 'terminal', status: 'failed' } });
  });

  describe('the notification doorbell', () => {
    test('polls a durable terminal row when the supplied doorbell rejects', async () => {
      const error = new Error('notification transport unavailable');
      doorbell = async () => {
        throw error;
      };
      putRun('r1', { status: 'pending' });
      const pending = wait('r1', {
        onAttached: () => {
          putRun('r1', { status: 'completed', completed_at: new Date() });
        },
      });
      expect(await pending).toMatchObject({ attention: { kind: 'terminal', status: 'completed' } });
      expect(mockGetWorkflowRun.mock.calls.length).toBeGreaterThan(1);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { err: error, runId: 'r1' },
        'run_attention.doorbell_unavailable'
      );
    });

    test('polls correctly when no notification implementation is supplied', async () => {
      putRun('r1', { status: 'pending' });
      const pending = wait('r1');
      await Bun.sleep(20);
      putRun('r1', { status: 'completed', completed_at: new Date() });
      expect(await pending).toMatchObject({ attention: { kind: 'terminal' } });
    });

    test('wakes a re-read, leaves the row authoritative and unsubscribes', async () => {
      let ring: (() => void) | undefined;
      const unsubscribe = mock(() => undefined);
      doorbell = async (runId, onDoorbell) => {
        expect(runId).toBe('r1');
        ring = onDoorbell;
        return unsubscribe;
      };
      putRun('r1', { status: 'running' });
      const pending = waitForRunAttention(store, 'r1', {
        doorbell,
        pollIntervalMs: 60_000,
        deadlineMs: 3000,
      });
      await waitForOwner('r1');
      const reads = mockGetWorkflowRun.mock.calls.length;
      ring?.();
      await Bun.sleep(20);
      expect(mockGetWorkflowRun.mock.calls.length).toBeGreaterThan(reads);
      putRun('r1', { status: 'completed', completed_at: new Date() });
      ring?.();
      expect(await pending).toMatchObject({ attention: { kind: 'terminal' } });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    test('unsubscribes the doorbell on abort', async () => {
      const unsubscribe = mock(() => undefined);
      const controller = new AbortController();
      putRun('r1', { status: 'pending' });
      const pending = waitForRunAttention(store, 'r1', {
        doorbell: async () => unsubscribe,
        signal: controller.signal,
        onAttached: () => controller.abort(),
      });
      expect(await pending).toEqual({ kind: 'aborted', runId: 'r1' });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});

describe('runOwnerLossWatch', () => {
  test.each([null, 'old-claim'])('checks only the requested execution claim %s', async claim => {
    putRun('orphan', {
      metadata: { ...localOwner, execution_claim: 'new-claim' },
    });
    reachableOwners = new Set();
    const watchOwner = runOwnerLossWatch(store);
    const signal = new AbortController().signal;

    expect(await watchOwner('orphan', signal, claim)).toBeNull();
    expect(mockWatchRunLiveOwner).not.toHaveBeenCalled();
    expect(await watchOwner('orphan', signal, 'new-claim')).toEqual({
      observedStatus: 'running',
    });
  });

  test('related runs retain their own claims during an owner check', async () => {
    putRun('parent', { metadata: { ...localOwner, execution_claim: 'parent-claim' } });
    putRun('child', {
      parent_run_id: 'parent',
      metadata: { ...localOwner, execution_claim: 'child-claim' },
    });
    reachableOwners = new Set(['parent']);
    const controller = new AbortController();
    const pending = runOwnerLossWatch(store)('child', controller.signal, 'child-claim');
    try {
      await waitForOwner('parent');
    } finally {
      controller.abort();
      await pending;
    }
    expect(mockWatchRunLiveOwner.mock.calls.map(([id]) => id)).toEqual(['child', 'parent']);
  });

  test('reports a lost owner with its observed status, and any other end as null', async () => {
    putRun('orphan', { status: 'running' });
    putRun('asking', { status: 'paused', metadata: { ...localOwner, ...gate() } });
    reachableOwners = new Set();
    const watchOwner = runOwnerLossWatch(store);
    const signal = new AbortController().signal;

    expect(await watchOwner('orphan', signal, null)).toEqual({ observedStatus: 'running' });
    expect(await watchOwner('asking', signal, null)).toBeNull();
    expect(rows.get('orphan')?.status).toBe('running');
  });

  test('keeps watching a running run through its tool-call attention, and reports its lost owner', async () => {
    const stalled = {
      streamId: 'stream',
      nodeId: 'implement',
      provider: 'codex',
      toolCallId: 'tool',
      name: 'bash',
      startedAt: '2026-10-01T00:00:00.000Z',
      lastProgressAt: '2026-10-01T00:00:00.000Z',
      raisedAt: '2026-10-01T00:30:00.000Z',
      thresholdMs: 1800000,
    };
    putRun('stalled', { metadata: { ...localOwner, tool_call_attention: [stalled] } });
    putRun('malformed', { metadata: { ...localOwner, tool_call_attention: 'garbage' } });
    reachableOwners = new Set();
    const watchOwner = runOwnerLossWatch(store);
    const signal = new AbortController().signal;

    expect(await watchOwner('stalled', signal, null)).toEqual({ observedStatus: 'running' });
    expect(await watchOwner('malformed', signal, null)).toEqual({ observedStatus: 'running' });
    expect(rows.get('stalled')?.metadata).toMatchObject({ tool_call_attention: [stalled] });
  });
});

describe('observeRunOwner', () => {
  const stalledCall = {
    streamId: 'stream',
    nodeId: 'implement',
    provider: 'codex',
    toolCallId: 'tool',
    name: 'bash',
    startedAt: '2026-10-01T00:00:00.000Z',
    lastProgressAt: '2026-10-01T00:00:00.000Z',
    raisedAt: '2026-10-01T00:30:00.000Z',
    thresholdMs: 1800000,
  };

  test('an answering owner is reachable, and the probe lets go of it', async () => {
    const run = putRun('live');

    expect(await observeRunOwner(store, run)).toBe('reachable');
    expect(ownerUnsubscribes).toHaveLength(1);
    expect(ownerUnsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  test('a local owner absent on two reads is unreachable, and the row is untouched', async () => {
    const run = putRun('orphan', { last_activity_at: new Date() });
    reachableOwners = new Set();

    expect(await observeRunOwner(store, run)).toBe('unreachable');
    expect(mockGetWorkflowRun).toHaveBeenCalledWith('orphan');
    expect(rows.get('orphan')?.status).toBe('running');
  });

  test('a run that died mid tool call is still asked for its owner', async () => {
    const run = putRun('stalled', {
      metadata: { ...localOwner, tool_call_attention: [stalledCall] },
    });
    reachableOwners = new Set();

    expect(await observeRunOwner(store, run)).toBe('unreachable');
  });

  test('an owner this host cannot observe is unknown, never unreachable', async () => {
    reachableOwners = new Set();

    expect(await observeRunOwner(store, putRun('foreign', { metadata: foreignOwner }))).toBe(
      'unknown'
    );
    expect(await observeRunOwner(store, putRun('unrecorded', { metadata: {} }))).toBe('unknown');
  });

  test('an endpoint that does not answer in time is unknown', async () => {
    mockWatchRunLiveOwner.mockImplementationOnce(async () => ({ kind: 'unproven' }));

    expect(await observeRunOwner(store, putRun('slow'))).toBe('unknown');
  });

  test('a run that finished between reads makes no ownership claim', async () => {
    const running = putRun('racing');
    rows.set('racing', { ...running, status: 'completed', completed_at: new Date() });
    reachableOwners = new Set();

    expect(await observeRunOwner(store, running)).toBeNull();
  });

  test.each(['paused', 'completed'] as const)('a %s row is not probed', async status => {
    expect(await observeRunOwner(store, putRun('settled', { status }))).toBeNull();
    expect(mockWatchRunLiveOwner).not.toHaveBeenCalled();
  });
});
