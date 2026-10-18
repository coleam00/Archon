// @archon-test-isolated
import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from './file-store';
import type { WorkflowRunDelivery } from './engine-port';
import {
  followWorkflowEventFeed,
  subscribeToRunTree,
  type RunSubscriptionStore,
} from './run-subscription';
import type { IWorkflowStore, WorkflowEventCursor } from './store';

const roots = trackTempRoots();
const PARKED = { pollIntervalMs: 60_000 };

async function makeStore(): Promise<IWorkflowStore> {
  return createFileWorkflowStore({
    root: roots(await mkdtemp(join(tmpdir(), 'archon-run-subscription-'))),
  });
}

async function createRun(store: IWorkflowStore, parent?: string): Promise<string> {
  const run = await store.createWorkflowRun({
    workflow_name: 'wf',
    user_message: '',
    ...(parent ? { parent_run_id: parent } : {}),
  });
  return run.id;
}

async function write(store: IWorkflowStore, runId: string, tag: string): Promise<void> {
  await store.persistWorkflowEvent({
    workflow_run_id: runId,
    event_type: 'workflow_started',
    step_name: tag,
  });
}

function recorder(): {
  deliveries: WorkflowRunDelivery[];
  listener: (delivery: WorkflowRunDelivery) => void;
  tags: () => (string | null)[];
} {
  const deliveries: WorkflowRunDelivery[] = [];
  return {
    deliveries,
    listener: delivery => deliveries.push(delivery),
    tags: () => deliveries.map(d => d.event.step_name),
  };
}

describe('subscribeToRunTree', () => {
  it('delivers the run and its descendants in commit order, and no unrelated run', async () => {
    const store = await makeStore();
    const root = await createRun(store);
    const child = await createRun(store, root);
    const grandchild = await createRun(store, child);
    const unrelated = await createRun(store);
    await write(store, root, 'before-subscribe');
    const seen = recorder();
    const subscription = await subscribeToRunTree(store, root, seen.listener, PARKED);

    await write(store, root, 'root');
    await write(store, unrelated, 'unrelated');
    await write(store, grandchild, 'grandchild');
    await write(store, child, 'child');
    await subscription.close();

    expect(seen.tags()).toEqual(['root', 'grandchild', 'child']);
  });

  it('includes a child created after the subscription started', async () => {
    const store = await makeStore();
    const root = await createRun(store);
    const seen = recorder();
    const subscription = await subscribeToRunTree(store, root, seen.listener, PARKED);

    const lateChild = await createRun(store, root);
    await write(store, lateChild, 'late-child');
    await subscription.close();

    expect(seen.tags()).toEqual(['late-child']);
  });

  it('continues from a delivered cursor with no gap and no duplicate', async () => {
    const store = await makeStore();
    const root = await createRun(store);
    const first = recorder();
    const subscription = await subscribeToRunTree(store, root, first.listener, PARKED);
    await write(store, root, 'one');
    await write(store, root, 'two');
    await subscription.close();
    const resumeFrom = first.deliveries[0]?.cursor;
    if (resumeFrom === undefined) throw new Error('expected a delivery');

    await write(store, root, 'three');
    const second = recorder();
    const resumed = await subscribeToRunTree(store, root, second.listener, {
      ...PARKED,
      after: resumeFrom,
    });
    await resumed.close();

    expect(first.tags()).toEqual(['one', 'two']);
    expect(second.tags()).toEqual(['two', 'three']);
  });

  it('delivers on its poll and drains events committed just before close', async () => {
    const store = await makeStore();
    const root = await createRun(store);
    let polled!: () => void;
    const firstDelivery = new Promise<void>(resolve => (polled = resolve));
    const seen = recorder();
    const subscription = await subscribeToRunTree(
      store,
      root,
      delivery => {
        seen.listener(delivery);
        polled();
      },
      { pollIntervalMs: 5 }
    );
    await write(store, root, 'polled');
    await firstDelivery;
    await write(store, root, 'tail');
    await subscription.close();
    await write(store, root, 'after-close');
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(seen.tags()).toEqual(['polled', 'tail']);
  });

  it('keeps delivering after a listener throws', async () => {
    const store = await makeStore();
    const root = await createRun(store);
    const tags: (string | null)[] = [];
    const subscription = await subscribeToRunTree(
      store,
      root,
      ({ event }) => {
        tags.push(event.step_name);
        if (event.step_name === 'bad') throw new Error('listener broke');
      },
      PARKED
    );
    await write(store, root, 'bad');
    await write(store, root, 'good');
    await subscription.close();

    expect(tags).toEqual(['bad', 'good']);
  });

  it('retries a failed read with escalating logs, and close rejects when its drain fails', async () => {
    const store = await makeStore();
    const root = await createRun(store);
    const logged: { level: string; event: string }[] = [];
    const logger = {
      warn: (_fields: unknown, event: string) => logged.push({ level: 'warn', event }),
      error: (_fields: unknown, event: string) => logged.push({ level: 'error', event }),
    } as unknown as ReturnType<typeof paths.createLogger>;
    const createLogger = spyOn(paths, 'createLogger').mockReturnValue(logger);
    let failuresLeft = 6;
    let failNextRead = false;
    const flaky: RunSubscriptionStore = {
      getWorkflowEventHead: () => store.getWorkflowEventHead(),
      getRunAncestry: id => store.getRunAncestry(id),
      readWorkflowEventsAfter: async (after, options) => {
        if (failNextRead || failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('store unavailable');
        }
        return store.readWorkflowEventsAfter(after, options);
      },
    };
    let delivered!: () => void;
    const firstDelivery = new Promise<void>(resolve => (delivered = resolve));
    const seen = recorder();
    try {
      const subscription = await subscribeToRunTree(
        flaky,
        root,
        delivery => {
          seen.listener(delivery);
          delivered();
        },
        { pollIntervalMs: 1 }
      );
      await write(store, root, 'after-outage');
      await firstDelivery;
      failNextRead = true;

      await expect(subscription.close()).rejects.toThrow('store unavailable');
      await expect(subscription.close()).rejects.toThrow('store unavailable');
    } finally {
      createLogger.mockRestore();
    }

    expect(seen.tags()).toEqual(['after-outage']);
    const reads = logged.filter(entry => entry.event === 'workflow.subscription_read_failed');
    expect(reads.slice(0, 6).map(entry => entry.level)).toEqual([
      'warn',
      'warn',
      'warn',
      'warn',
      'error',
      'error',
    ]);
  });

  it('retries a failed ancestry read instead of treating the run as unrelated', async () => {
    const store = await makeStore();
    const root = await createRun(store);
    const child = await createRun(store, root);
    let ancestryFailures = 1;
    const ancestry = spyOn(store, 'getRunAncestry');
    ancestry.mockImplementation(async id => {
      if (ancestryFailures-- > 0) throw new Error('ancestry unavailable');
      ancestry.mockRestore();
      return store.getRunAncestry(id);
    });
    const seen = recorder();
    let delivered!: () => void;
    const firstDelivery = new Promise<void>(resolve => (delivered = resolve));
    const subscription = await subscribeToRunTree(
      store,
      root,
      delivery => {
        seen.listener(delivery);
        delivered();
      },
      { pollIntervalMs: 1 }
    );
    await write(store, child, 'child');
    await firstDelivery;
    await subscription.close();

    expect(seen.tags()).toEqual(['child']);
  });

  it('drains a backlog longer than one page exactly once, in order', async () => {
    const store = await makeStore();
    const root = await createRun(store);
    const beforeTemplate = await store.getWorkflowEventHead();
    await write(store, root, 'template');
    const template = (await store.readWorkflowEventsAfter(beforeTemplate, { limit: 1 })).events[0]
      ?.event;
    if (template === undefined) throw new Error('expected a template row');
    // 1001 rows span three 500-row pages; the file store takes seconds to write that many.
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      ...template,
      id: `event-${String(i)}`,
      step_name: String(i),
    }));
    const cursorAt = (position: number): WorkflowEventCursor =>
      `fake:${String(position)}` as WorkflowEventCursor;
    const paged: RunSubscriptionStore = {
      getWorkflowEventHead: async () => cursorAt(0),
      getRunAncestry: async () => [],
      readWorkflowEventsAfter: async (after, { limit }) => {
        const start = Number(after.slice('fake:'.length));
        const page = rows.slice(start, start + limit);
        return {
          events: page.map((event, i) => ({ cursor: cursorAt(start + i + 1), event })),
          next: cursorAt(start + page.length),
        };
      },
    };
    const seen = recorder();
    const subscription = await subscribeToRunTree(paged, root, seen.listener, PARKED);
    await subscription.close();

    expect(seen.tags()).toEqual(rows.map(row => row.step_name));
  });

  it('looks up membership once per run id', async () => {
    const store = await makeStore();
    const root = await createRun(store);
    const child = await createRun(store, root);
    const unrelated = await createRun(store);
    const ancestry = spyOn(store, 'getRunAncestry');
    const seen = recorder();
    const subscription = await subscribeToRunTree(store, root, seen.listener, PARKED);
    for (const tag of ['a', 'b', 'c']) {
      await write(store, root, tag);
      await write(store, child, tag);
      await write(store, unrelated, tag);
    }
    await subscription.close();

    expect(seen.deliveries).toHaveLength(6);
    expect(ancestry.mock.calls.map(([id]) => id).sort()).toEqual([child, unrelated].sort());
  });
});

describe('followWorkflowEventFeed', () => {
  it('a doorbell ring reads before the next poll, and close detaches it', async () => {
    const store = await makeStore();
    const root = await createRun(store);
    let ring: (() => void) | undefined;
    let detached = false;
    const seen = recorder();
    const follower = await followWorkflowEventFeed(
      store,
      await store.getWorkflowEventHead(),
      async delivery => seen.listener(delivery),
      {
        ...PARKED,
        doorbell: async onEvent => {
          ring = onEvent;
          return () => {
            detached = true;
          };
        },
        logFields: {},
      }
    );
    await write(store, root, 'rung');
    ring?.();
    for (let waited = 0; seen.deliveries.length === 0 && waited < 2000; waited += 5)
      await new Promise(resolve => setTimeout(resolve, 5));
    expect(seen.tags()).toEqual(['rung']);
    await follower.close();
    expect(detached).toBe(true);
  });
});
