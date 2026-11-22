import { setLogSink } from '@archon/paths';
import { expect, test } from 'bun:test';
import {
  heldCheckouts,
  resourceResumeBlocker,
  resourceStartBlocker,
  type ResourceSlotOccupancy,
} from './resource-start-store';
import { drainableStarts } from './host-start-decision';
import type { PreparedWorkflowLaunch } from './schemas/resource-start';
import { itemHoldKey } from './item-hold';

function launch(guard = true, branch?: string): PreparedWorkflowLaunch {
  return {
    version: 2,
    run: {
      id: crypto.randomUUID(),
      workflow_name: 'test',
      codebase_id: 'codebase',
      user_message: '',
      metadata: { admission_checkout_guard: guard },
    },
    execution: {
      cwd: '/shared',
      conversationId: 'conversation',
      isolation: branch ? { kind: 'worktree', branch } : { kind: 'in-place' },
    },
  };
}
const slot = (): ResourceSlotOccupancy => ({
  capacity: 3,
  reusableCheckouts: [],
  holders: [],
  waiters: [],
  queue: [],
  heldCheckouts: new Map(),
  foreignHeldCheckouts: new Map(),
  heldItems: new Map(),
});
test('local checkout occupancy takes precedence, including for read-only starts', () => {
  const guarded = launch(),
    readonly = launch(false);
  const local = heldCheckouts([{ id: 'local', launch: guarded }]);
  const foreign = heldCheckouts([{ id: 'foreign', working_path: '/shared' }], []);
  for (const incoming of [guarded, readonly])
    expect(
      resourceStartBlocker(
        { ...slot(), heldCheckouts: local, foreignHeldCheckouts: foreign },
        incoming,
        'host',
        null
      )
    ).toEqual({ kind: 'run', id: 'local' });
  expect(
    resourceStartBlocker({ ...slot(), foreignHeldCheckouts: foreign }, readonly, 'host', null)
  ).toBeNull();
});
test('foreign observations retain the first holder and match registration workflow identity at its path', () => {
  const foreign = heldCheckouts(
    [
      { id: 'oldest', working_path: '/shared' },
      { id: 'later', working_path: '/shared' },
    ],
    [
      { codebaseId: 'codebase', branch: 'reusable', workingPath: '/shared' },
      { codebaseId: 'codebase', branch: 'elsewhere', workingPath: '/different' },
    ]
  );
  for (const incoming of [launch(), launch(true, 'reusable')])
    expect(
      resourceStartBlocker({ ...slot(), foreignHeldCheckouts: foreign }, incoming, 'host', null)
    ).toEqual({
      kind: 'run',
      id: 'oldest',
    });
  expect(
    resourceStartBlocker(
      { ...slot(), foreignHeldCheckouts: foreign },
      launch(true, 'elsewhere'),
      'host',
      null
    )
  ).toBeNull();
});
test('drains reserve local checkouts even for read-only admissions and pass over other hosts', () => {
  const readonly = launch(false),
    guarded = launch();
  const start = (id: string, launch: PreparedWorkflowLaunch, hostId = 'host') => ({
    id,
    launch,
    hostId,
    itemId: null,
  });
  const occupied = {
    ...slot(),
    foreignHeldCheckouts: heldCheckouts([{ id: 'foreign', working_path: '/shared' }], []),
    queue: [start('guarded', guarded), start('readonly', readonly), start('second', readonly)],
  };
  expect(drainableStarts(occupied, 'host').map(start => start.id)).toEqual(['readonly']);
  // Another host's start waits only for its own drain and blocks this one.
  expect(
    drainableStarts(
      { ...slot(), queue: [start('other-host', guarded, 'other'), start('ours', readonly)] },
      'host'
    ).map(start => start.id)
  ).toEqual(['ours']);
});

test('a free slot goes to a new start before an older start of another host, never of its own', () => {
  const queue = [{ id: 'older', hostId: 'other', launch: launch(false), itemId: null }];
  const free = { ...slot(), capacity: 1, queue };
  // A hand start shares a host with no queued request, so it takes the free slot.
  expect(resourceStartBlocker(free, launch(false), 'direct-start', null)).toBeNull();
  expect(resourceStartBlocker(free, launch(false), 'other', null)).toEqual({
    kind: 'request',
    id: 'older',
  });
  // Waiting for a slot, order holds: a full slot blocks the new start whatever the host.
  const full = { ...free, holders: [{ id: 'holder' }] };
  expect(resourceStartBlocker(full, launch(false), 'direct-start', null)).toEqual({
    kind: 'run',
    id: 'holder',
  });
});

test('failed resume ignores foreign-blocked promises but yields to runnable read-only ones', () => {
  const foreign = heldCheckouts([{ id: 'foreign', working_path: '/shared' }], []);
  const queue = [{ id: 'queued', hostId: 'host', launch: launch(), itemId: null }];
  const failed = { id: 'failed', metadata: {}, status: 'failed' as const };
  expect(
    resourceResumeBlocker({ ...slot(), foreignHeldCheckouts: foreign, queue }, failed)
  ).toBeNull();
  queue[0]!.launch = launch(false);
  expect(
    resourceResumeBlocker({ ...slot(), foreignHeldCheckouts: foreign, queue }, failed)
  ).toEqual({ kind: 'request', id: 'queued' });
});

for (const guard of ['false', null]) {
  test(`malformed guard ${String(guard)} is rejected before all new start decisions and passed over in stored queues`, () => {
    const malformed = launch();
    malformed.run.metadata.admission_checkout_guard = guard;
    const valid = launch();
    const queue = [malformed, valid].map(launch => ({
      id: launch.run.id,
      hostId: 'host',
      launch,
      itemId: null,
    }));
    const logs: string[] = [];
    setLogSink(line => logs.push(line));
    try {
      for (const occupied of [
        slot(),
        { ...slot(), heldCheckouts: heldCheckouts([{ id: 'local', launch: malformed }]) },
      ])
        expect(() => resourceStartBlocker(occupied, malformed, 'host', null)).toThrow(
          'expected a boolean'
        );
      expect(drainableStarts({ ...slot(), queue }, 'host')).toEqual([queue[1]!]);
      expect(resourceStartBlocker({ ...slot(), queue }, launch(), 'host', null)).toEqual({
        kind: 'request',
        id: valid.run.id,
      });
      expect(
        resourceResumeBlocker(
          { ...slot(), queue },
          { id: 'failed', metadata: {}, status: 'failed' }
        )
      ).toEqual({ kind: 'request', id: valid.run.id });
      expect(logs).toHaveLength(3);
      for (const line of logs) {
        const entry = JSON.parse(line);
        expect(entry).toMatchObject({
          level: 50,
          requestId: malformed.run.id,
          msg: 'resource_start.invalid_queued_guard',
        });
        expect(entry.err.message).toContain('expected a boolean');
      }
    } finally {
      setLogSink(undefined);
    }
  });
}

test('local holders project registered path and branch aliases before and after claiming', () => {
  for (const working_path of [undefined, '/shared']) {
    for (const heldLaunch of [launch(), launch(true, 'reusable')]) {
      const local = heldCheckouts(
        [{ id: 'local', working_path, launch: heldLaunch }],
        [{ codebaseId: 'codebase', branch: 'reusable', workingPath: '/shared' }]
      );
      for (const guard of [true, false]) {
        for (const incoming of [launch(guard), launch(guard, 'reusable')])
          expect(
            resourceStartBlocker({ ...slot(), heldCheckouts: local }, incoming, 'host', null)
          ).toEqual({
            kind: 'run',
            id: 'local',
          });
      }
    }
  }
});

test('drains reserve registered aliases in both orders, including read-only and independent lanes', () => {
  for (const guard of [true, false]) {
    for (const branchFirst of [false, true]) {
      const path = launch(guard);
      const branch = launch(guard, 'reusable');
      const ordered = branchFirst ? [branch, path] : [path, branch];
      const independent = launch(guard);
      independent.execution.isolation = { kind: 'worktree' };
      const different = launch(guard, 'different');
      const queue = [...ordered, independent, different].map(launch => ({
        id: launch.run.id,
        hostId: 'host',
        itemId: null,
        launch,
      }));
      expect(
        drainableStarts(
          {
            ...slot(),
            reusableCheckouts: [
              { codebaseId: 'codebase', branch: 'reusable', workingPath: '/shared' },
            ],
            queue,
          },
          'host'
        ).map(start => start.id)
      ).toEqual([ordered[0]!.run.id, independent.run.id, different.run.id]);
    }
  }
});

test('unknown foreign checkout identity only blocks guarded shared checkouts', () => {
  const readOnly = launch(false);
  const branchless = launch();
  branchless.execution.isolation = { kind: 'worktree' };
  const occupied = { ...slot(), unknownForeignCheckoutHolder: 'unknown' };
  expect(
    resourceStartBlocker(
      {
        ...occupied,
        foreignHeldCheckouts: heldCheckouts([{ id: 'known', working_path: '/shared' }]),
      },
      launch(),
      'host',
      null
    )
  ).toEqual({ kind: 'run', id: 'known' });
  for (const incoming of [launch(), launch(true, 'explicit')])
    expect(resourceStartBlocker(occupied, incoming, 'host', null)).toEqual({
      kind: 'run',
      id: 'unknown',
    });
  for (const incoming of [readOnly, branchless])
    expect(resourceStartBlocker(occupied, incoming, 'host', null)).toBeNull();
  const guarded = launch();
  const queue = [guarded, readOnly, branchless].map(launch => ({
    id: launch.run.id,
    hostId: 'host',
    itemId: null,
    launch,
  }));
  expect(drainableStarts({ ...occupied, queue }, 'host')).toEqual(queue.slice(1));
  const failed = { id: 'failed', metadata: {}, status: 'failed' as const };
  expect(resourceResumeBlocker({ ...occupied, queue: queue.slice(0, 1) }, failed)).toBeNull();
  expect(resourceResumeBlocker({ ...occupied, queue }, failed)).toEqual({
    kind: 'request',
    id: readOnly.run.id,
  });
  expect(resourceStartBlocker({ ...occupied, queue }, branchless, 'host', null)).toEqual({
    kind: 'request',
    id: readOnly.run.id,
  });
});

test('an item held for a workflow blocks its starts whatever the capacity, and a drain admits one per item', () => {
  const onItem = (id: string, itemId: string | null, workflow = 'test') => {
    const start = launch(false);
    start.run.workflow_name = workflow;
    // A worktree lane without a branch has a checkout of its own, so only the item rule applies.
    start.execution.isolation = { kind: 'worktree' };
    return { id, hostId: 'host', launch: { ...start, run: { ...start.run, id } }, itemId };
  };
  const held = new Map([[itemHoldKey('test', 'k1'), 'holder']]);
  // A new start on a held item is blocked by the holding run even with free slots.
  expect(
    resourceStartBlocker({ ...slot(), heldItems: held }, onItem('new', 'k1').launch, 'host', 'k1')
  ).toEqual({ kind: 'run', id: 'holder' });
  expect(
    resourceStartBlocker({ ...slot(), heldItems: held }, onItem('new', 'k2').launch, 'host', 'k2')
  ).toBeNull();
  // The held start keeps its place and does not stall the queue behind it; two queued
  // starts on one free item admit only the first.
  const queue = [
    onItem('held', 'k1'),
    onItem('first-k3', 'k3'),
    onItem('second-k3', 'k3'),
    onItem('other-workflow', 'k1', 'review'),
    onItem('no-item', null),
  ];
  expect(
    drainableStarts({ ...slot(), capacity: 10, heldItems: held, queue }, 'host').map(
      start => start.id
    )
  ).toEqual(['first-k3', 'other-workflow', 'no-item']);
});

test('two read-only copies of one handed-off commit hold no checkout of each other', () => {
  const copy = (): PreparedWorkflowLaunch => {
    const base = launch(false);
    return {
      ...base,
      execution: { ...base.execution, isolation: { kind: 'worktree', fromBranch: 'c'.repeat(40) } },
    };
  };
  const held = heldCheckouts([{ id: 'first-check', launch: copy() }]);
  expect(resourceStartBlocker({ ...slot(), heldCheckouts: held }, copy(), 'host', null)).toBeNull();
});
