import { describe, expect, test } from 'bun:test';
import { ConversationLockManager } from './conversation-lock';

/**
 * Nothing in this file sleeps. `acquireLock` resolves with the acquisition
 * status, not with handler completion, so the handlers report their own starts
 * into a log and the test decides when each one finishes. Waiting is always
 * "drain microtasks until the manager reached this state", and ordering is
 * asserted against the log rather than assumed from a wall-clock margin.
 */

interface GatedHandler {
  /** Lets the handler finish. */
  release: () => void;
  handler: () => Promise<void>;
}

/**
 * A handler the test drives explicitly: it appends its label to `log` when it
 * starts and stays in flight until released. `fail` makes it reject on release,
 * which exercises the manager's error path without a timing assumption.
 */
function gate(log: string[], label: string, { fail = false } = {}): GatedHandler {
  let release!: () => void;
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  return {
    release,
    handler: async () => {
      log.push(label);
      await released;
      if (fail) throw new Error(`handler ${label} failed`);
    },
  };
}

/**
 * The manager releases a lock and hands off to the next queued message entirely
 * on the microtask queue, so draining microtasks converges without touching the
 * clock. The bound turns a broken handoff into an immediate failure rather than
 * a hang.
 */
async function drainUntil(predicate: () => boolean, expectation: string): Promise<void> {
  for (let tick = 0; tick < 100; tick++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`manager never reached expected state: ${expectation}`);
}

/**
 * Waits for one more handler to start, whichever one the manager picked. The
 * caller then asserts the log, so picking the wrong one fails on the ordering
 * assertion instead of blocking on a handler that never runs.
 */
function drainUntilStarted(log: string[], count: number): Promise<void> {
  return drainUntil(() => log.length >= count, `${count} handler(s) started, saw [${log}]`);
}

/** Waits for the manager to have no active conversations and nothing queued. */
function drainUntilIdle(manager: ConversationLockManager): Promise<void> {
  return drainUntil(() => {
    const stats = manager.getStats();
    return stats.active === 0 && stats.queuedTotal === 0;
  }, 'idle (no active conversations, empty queues)');
}

describe('ConversationLockManager', () => {
  test('initializes with correct maxConcurrent', () => {
    const manager = new ConversationLockManager(5);
    const stats = manager.getStats();
    expect(stats.maxConcurrent).toBe(5);
    expect(stats.active).toBe(0);
    expect(stats.queuedTotal).toBe(0);
  });

  test('getStats returns empty state initially', () => {
    const manager = new ConversationLockManager(10);
    const stats = manager.getStats();
    expect(stats).toEqual({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    });
  });

  test('processes handler immediately when under capacity', async () => {
    const manager = new ConversationLockManager(10);
    const log: string[] = [];
    const only = gate(log, 'only');

    const result = await manager.acquireLock('test-1', only.handler);
    await drainUntilStarted(log, 1);

    expect(result.status).toBe('started');
    expect(log).toEqual(['only']);
    expect(manager.getStats().active).toBe(1);

    only.release();
    await drainUntilIdle(manager);
  });

  test('queues message when same conversation already active', async () => {
    const manager = new ConversationLockManager(10);
    const log: string[] = [];
    const first = gate(log, 'first');
    const second = gate(log, 'second');

    await manager.acquireLock('same-conv', first.handler);
    await drainUntilStarted(log, 1);

    const queued = await manager.acquireLock('same-conv', second.handler);
    expect(queued.status).toBe('queued-conversation');

    const stats = manager.getStats();
    expect(stats.active).toBe(1);
    expect(stats.queuedTotal).toBe(1);
    expect(stats.queuedByConversation).toEqual([
      { conversationId: 'same-conv', queuedMessages: 1 },
    ]);
    expect(log).toEqual(['first']);

    first.release();
    await drainUntilStarted(log, 2);
    expect(log).toEqual(['first', 'second']);

    second.release();
    await drainUntilIdle(manager);
  });

  test('queues message when at max capacity', async () => {
    const manager = new ConversationLockManager(2);
    const log: string[] = [];
    const one = gate(log, 'conv-1');
    const two = gate(log, 'conv-2');
    const three = gate(log, 'conv-3');

    await manager.acquireLock('conv-1', one.handler);
    await manager.acquireLock('conv-2', two.handler);
    await drainUntilStarted(log, 2);

    // A third distinct conversation has nowhere to run until capacity frees up.
    const queued = await manager.acquireLock('conv-3', three.handler);
    expect(queued.status).toBe('queued-capacity');
    expect(manager.getStats().active).toBe(2);
    expect(manager.getStats().queuedTotal).toBe(1);
    expect(log).toEqual(['conv-1', 'conv-2']);

    // Finishing one occupant is what admits the queued conversation.
    one.release();
    await drainUntilStarted(log, 3);
    expect(log).toEqual(['conv-1', 'conv-2', 'conv-3']);

    two.release();
    three.release();
    await drainUntilIdle(manager);
  });

  test('multiple conversations process concurrently', async () => {
    const manager = new ConversationLockManager(10);
    const log: string[] = [];
    const conversations = ['conv-1', 'conv-2', 'conv-3'].map(id => ({ id, gated: gate(log, id) }));

    for (const { id, gated } of conversations) {
      const result = await manager.acquireLock(id, gated.handler);
      expect(result.status).toBe('started');
    }
    await drainUntilStarted(log, 3);

    // None has been released, so all three are genuinely in flight at once.
    const stats = manager.getStats();
    expect(stats.active).toBe(3);
    expect(stats.queuedTotal).toBe(0);
    expect(stats.activeConversationIds.sort()).toEqual(['conv-1', 'conv-2', 'conv-3']);

    for (const { gated } of conversations) gated.release();
    await drainUntilIdle(manager);
  });

  test('queued messages process in order after completion', async () => {
    const manager = new ConversationLockManager(10);
    const log: string[] = [];
    const first = gate(log, 'first');
    const second = gate(log, 'second');
    const third = gate(log, 'third');

    await manager.acquireLock('test-conv', first.handler);
    await drainUntilStarted(log, 1);

    await manager.acquireLock('test-conv', second.handler);
    await manager.acquireLock('test-conv', third.handler);
    expect(manager.getStats().queuedTotal).toBe(2);
    expect(log).toEqual(['first']);

    // Each release admits exactly the next message in arrival order.
    first.release();
    await drainUntilStarted(log, 2);
    expect(log).toEqual(['first', 'second']);

    second.release();
    await drainUntilStarted(log, 3);
    expect(log).toEqual(['first', 'second', 'third']);

    third.release();
    await drainUntilIdle(manager);
  });

  test('error in handler does not prevent queue processing', async () => {
    const manager = new ConversationLockManager(10);
    const log: string[] = [];
    const failing = gate(log, 'failing', { fail: true });
    const next = gate(log, 'next');

    await manager.acquireLock('test-conv', failing.handler);
    await drainUntilStarted(log, 1);

    await manager.acquireLock('test-conv', next.handler);
    expect(manager.getStats().queuedTotal).toBe(1);

    failing.release();
    await drainUntilStarted(log, 2);
    expect(log).toEqual(['failing', 'next']);

    next.release();
    await drainUntilIdle(manager);
  });

  test('stats stop reporting a conversation once it finishes', async () => {
    const manager = new ConversationLockManager(10);
    const log: string[] = [];
    const a = gate(log, 'conv-a');
    const b = gate(log, 'conv-b');

    await manager.acquireLock('conv-a', a.handler);
    await manager.acquireLock('conv-b', b.handler);
    await drainUntilStarted(log, 2);

    expect(manager.getStats().activeConversationIds.sort()).toEqual(['conv-a', 'conv-b']);

    a.release();
    await drainUntil(
      () => manager.getStats().active === 1,
      'only conv-b active after conv-a finished'
    );
    expect(manager.getStats().activeConversationIds).toEqual(['conv-b']);

    b.release();
    await drainUntilIdle(manager);
    expect(manager.getStats().activeConversationIds).toEqual([]);
  });
});
