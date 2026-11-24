import { expect, test } from 'bun:test';
import { decideHostStarts } from './host-start-decision';
import type { QueuedStart, ResourceSlotOccupancy } from './resource-start-store';
import type { PreparedWorkflowLaunch } from './schemas/resource-start';

function start(
  id: string,
  execution: Partial<PreparedWorkflowLaunch['execution']> = {},
  itemId: string | null = null
): QueuedStart {
  return {
    id,
    hostId: 'host',
    itemId,
    launch: {
      version: 2,
      run: { id, workflow_name: 'test', codebase_id: 'codebase', user_message: '', metadata: {} },
      execution: {
        cwd: `/own/${id}`,
        conversationId: id,
        isolation: { kind: 'in-place' },
        ...execution,
      },
    },
  };
}

const slot = (
  queue: QueuedStart[],
  reusableCheckouts: ResourceSlotOccupancy['reusableCheckouts'] = []
): ResourceSlotOccupancy => ({
  capacity: 5,
  reusableCheckouts,
  holders: [],
  waiters: [],
  queue,
  heldCheckouts: new Map(),
  foreignHeldCheckouts: new Map(),
  heldItems: new Map(),
});

const reusable = [{ codebaseId: 'codebase', branch: 'feature', workingPath: '/shared' }];

/** Decide b1, a1, a2 queued in that order, b1 on `b` and the a-starts on `a`. */
const decide = (b1: QueuedStart, a1: QueuedStart, a2: QueuedStart, room: number) =>
  decideHostStarts({
    hostId: 'host',
    slots: new Map([
      ['b', slot([b1], reusable)],
      ['a', slot([a1, a2], reusable)],
    ]),
    order: ['b1', 'a1', 'a2'],
    room,
  }).map(v => [v.start.id, v.verdict === 'admit' ? 'admit' : v.by]);

test("an admit holds its checkout on the host's other resources, so the room passes the start it blocks", () => {
  const shared = { cwd: '/shared' };
  expect(decide(start('b1', shared), start('a1', shared), start('a2'), 2)).toEqual([
    ['b1', 'admit'],
    ['a1', 'resource'],
    ['a2', 'admit'],
  ]);
  expect(decide(start('b1', shared), start('a1', shared), start('a2'), 1)).toEqual([
    ['b1', 'admit'],
    ['a1', 'resource'],
    ['a2', 'run-limit'],
  ]);
});

test('a checkout an admit holds through a reusable branch alias holds the other resource too', () => {
  const branch = { isolation: { kind: 'worktree' as const, branch: 'feature' } };
  expect(decide(start('b1', { cwd: '/shared' }), start('a1', branch), start('a2'), 2)).toEqual([
    ['b1', 'admit'],
    ['a1', 'resource'],
    ['a2', 'admit'],
  ]);
});

test("an admit holds its item on the host's other resources", () => {
  expect(decide(start('b1', {}, 'item'), start('a1', {}, 'item'), start('a2'), 2)).toEqual([
    ['b1', 'admit'],
    ['a1', 'resource'],
    ['a2', 'admit'],
  ]);
});
