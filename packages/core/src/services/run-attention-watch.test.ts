import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { DbNotificationListener } from '../db/adapters/types';

// ---------------------------------------------------------------------------
// Mock DB modules before importing the module under test
// ---------------------------------------------------------------------------

/**
 * The rows the waiter can see, keyed by run id. Mutating this between reads is how a
 * test simulates another process committing a transition.
 */
const rows = new Map<string, WorkflowRun>();
const mockGetWorkflowRun = mock((id: string) => Promise.resolve(rows.get(id) ?? null));

// Deliberately the ONLY member of the store this module may reach. Any write the
// waiter attempted — updateWorkflowRun, cancelWorkflowRun, resolveApprovalGate —
// would throw "is not a function" here rather than silently mutating a run.
mock.module('../db/workflows', () => ({
  getWorkflowRun: mockGetWorkflowRun,
}));

// SQLite posture by default: no listener, so the interval is the only wake source.
const mockGetDbNotificationListener = mock((): DbNotificationListener | null => null);
mock.module('../db/connection', () => ({
  getDbNotificationListener: mockGetDbNotificationListener,
}));

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
const RUN_LIVE_OWNER_CONTROL_HANDOFF_GRACE_MS = 10_000;
const ownerEvents = new Map<
  string,
  (event: 'attention' | 'control_handoff' | 'disconnected') => void
>();
const ownerUnsubscribes: ReturnType<typeof mock>[] = [];
const mockWatchRunLiveOwner = mock(
  (runId: string, onEvent: (event: 'attention' | 'control_handoff' | 'disconnected') => void) => {
    if (reachableOwners !== null && !reachableOwners.has(runId)) return Promise.resolve(null);
    ownerEvents.set(runId, onEvent);
    const unsubscribe = mock(() => undefined);
    ownerUnsubscribes.push(unsubscribe);
    return Promise.resolve({ unsubscribe });
  }
);
mock.module('./run-live-owner', () => ({
  RUN_LIVE_OWNER_CONTROL_HANDOFF_GRACE_MS,
  watchRunLiveOwner: mockWatchRunLiveOwner,
}));

const { waitForRunAttention } = await import('./run-attention-watch');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function putRun(id: string, over: Partial<WorkflowRun> = {}): WorkflowRun {
  const run = {
    id,
    workflow_name: 'demo',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: 'go',
    metadata: {},
    started_at: new Date('2026-08-28T10:00:00.000Z'),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    ...over,
  } as WorkflowRun;
  rows.set(id, run);
  return run;
}

const gate = (over: Record<string, unknown> = {}) => ({
  approval: { nodeId: 'review', message: 'Approve the plan.', ...over },
});

/** A fast wait — the interval is the wake source in every test here. */
const wait = (runId: string, over: Record<string, unknown> = {}) =>
  waitForRunAttention(runId, { pollIntervalMs: 5, deadlineMs: 3000, ...over });

async function waitForOwner(runId: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!ownerEvents.has(runId)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for owner ${runId}`);
    await Bun.sleep(5);
  }
}

beforeEach(() => {
  rows.clear();
  mockGetWorkflowRun.mockImplementation((id: string) => Promise.resolve(rows.get(id) ?? null));
  mockGetWorkflowRun.mockClear();
  mockGetDbNotificationListener.mockClear();
  reachableOwners = null;
  ownerEvents.clear();
  ownerUnsubscribes.length = 0;
  mockWatchRunLiveOwner.mockClear();
});

// ---------------------------------------------------------------------------

describe('waitForRunAttention', () => {
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
    const pending = waitForRunAttention('r1', { pollIntervalMs: 60_000, deadlineMs: 3000 });
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
    const pending = waitForRunAttention('r1', { pollIntervalMs: 60_000, deadlineMs: 3000 });
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
      return Promise.resolve({ unsubscribe });
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
    const pending = waitForRunAttention('r1', { pollIntervalMs: 20, deadlineMs: 3000 });
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

  test('a stop handoff expires when the controller never persists a transition', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      putRun('r1', { status: 'running' });
      let settled = false;
      const pending = waitForRunAttention('r1', { pollIntervalMs: 5 }).finally(() => {
        settled = true;
      });
      await waitForOwner('r1');
      ownerEvents.get('r1')?.('control_handoff');
      reachableOwners = new Set();
      ownerEvents.get('r1')?.('disconnected');

      await Bun.sleep(20);
      expect(settled).toBe(false);
      now += RUN_LIVE_OWNER_CONTROL_HANDOFF_GRACE_MS + 1;

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

    const result = await waitForRunAttention('r1', {
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

  test('an action-required wait wakes with its authored message', async () => {
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
        kind: 'action_required',
        runId: 'r1',
        nodeId: 'rerun-ci',
        message: 'Rerun the failed check.',
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
      const pending = waitForRunAttention('parent', {
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

    test('a chain longer than the bound is unreadable, not an assumed state', async () => {
      for (let i = 0; i < 520; i += 1) {
        putRun(`r${String(i)}`, { status: 'paused', metadata: blockedOn(`r${String(i + 1)}`) });
      }
      putRun('r520', { status: 'paused', metadata: gate({ nodeId: 'deep' }) });

      expect(await wait('r0')).toMatchObject({
        kind: 'attention',
        attention: { kind: 'unreadable', reason: 'child_chain_too_deep' },
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
    test('is skipped entirely when the dialect has none (SQLite)', async () => {
      putRun('r1', { status: 'completed', completed_at: new Date() });

      await wait('r1');

      expect(mockGetDbNotificationListener).toHaveBeenCalled();
    });

    test('wakes a re-read, but the row is still the answer', async () => {
      // A notification carrying this run id must never BE the answer: the doorbell
      // rings here while the run is still running, and the wait continues.
      let ring: ((payload: string) => void) | undefined;
      const unsubscribe = mock(() => undefined);
      mockGetDbNotificationListener.mockReturnValueOnce({
        listen: (_channel: string, onNotify: (payload: string) => void) => {
          ring = onNotify;
          return Promise.resolve(unsubscribe);
        },
      });
      putRun('r1', { status: 'running' });

      // A long interval: only the doorbell can move this forward in time.
      const pending = waitForRunAttention('r1', { pollIntervalMs: 60_000, deadlineMs: 3000 });
      await Bun.sleep(20);
      ring?.('r1');
      await Bun.sleep(20);
      expect(mockGetWorkflowRun.mock.calls.length).toBeGreaterThan(1);

      putRun('r1', { status: 'completed', completed_at: new Date() });
      ring?.('r1');

      expect(await pending).toMatchObject({ attention: { kind: 'terminal' } });
      expect(unsubscribe).toHaveBeenCalled();
    });

    test('ignores a notification for a different run', async () => {
      let ring: ((payload: string) => void) | undefined;
      mockGetDbNotificationListener.mockReturnValueOnce({
        listen: (_channel: string, onNotify: (payload: string) => void) => {
          ring = onNotify;
          return Promise.resolve(() => undefined);
        },
      });
      putRun('r1', { status: 'running' });

      // A 60s interval and NO deadline: between the opening read and the abort,
      // the doorbell is the only thing that can cause another read. So the count
      // measures the doorbell directly instead of racing a deadline timer against
      // the clock — pinning an exact total across a deadline made this assertion a
      // function of timer alignment, and CI duly read 3 where a laptop read 2.
      const controller = new AbortController();
      const pending = waitForRunAttention('r1', {
        pollIntervalMs: 60_000,
        signal: controller.signal,
      });
      await Bun.sleep(20);
      const readsBeforeRing = mockGetWorkflowRun.mock.calls.length;

      ring?.('some-other-run');
      await Bun.sleep(50);

      // The whole point: a payload naming a different run woke nothing.
      expect(mockGetWorkflowRun.mock.calls.length).toBe(readsBeforeRing);

      controller.abort();
      expect(await pending).toMatchObject({ kind: 'aborted' });
    });
  });
});
