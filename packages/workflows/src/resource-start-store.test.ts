import { expect, test } from 'bun:test';
import {
  foreignHeldCheckouts,
  heldCheckouts,
  resourceResumeBlocker,
  drainableStarts,
  resourceStartBlocker,
  type ResourceSlotOccupancy,
} from './resource-start-store';
import type { PreparedWorkflowLaunch } from './schemas/resource-start';

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
  holders: [],
  waiters: [],
  queue: [],
  heldCheckouts: new Map(),
  foreignHeldCheckouts: new Map(),
});
test('local checkout occupancy takes precedence, including for read-only starts', () => {
  const guarded = launch(),
    readonly = launch(false);
  const local = heldCheckouts([{ id: 'local', launch: guarded }]);
  const foreign = foreignHeldCheckouts([{ id: 'foreign', working_path: '/shared' }], []);
  for (const incoming of [guarded, readonly])
    expect(
      resourceStartBlocker(
        { ...slot(), heldCheckouts: local, foreignHeldCheckouts: foreign },
        incoming
      )
    ).toEqual({ kind: 'run', id: 'local' });
  expect(resourceStartBlocker({ ...slot(), foreignHeldCheckouts: foreign }, readonly)).toBeNull();
});
test('foreign observations retain the first holder and match registration workflow identity at its path', () => {
  const foreign = foreignHeldCheckouts(
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
    expect(resourceStartBlocker({ ...slot(), foreignHeldCheckouts: foreign }, incoming)).toEqual({
      kind: 'run',
      id: 'oldest',
    });
  expect(
    resourceStartBlocker({ ...slot(), foreignHeldCheckouts: foreign }, launch(true, 'elsewhere'))
  ).toBeNull();
});
test('drains reserve local checkouts even for read-only admissions and respect the foreign-host FIFO fence', () => {
  const readonly = launch(false),
    guarded = launch();
  const start = (id: string, launch: PreparedWorkflowLaunch, hostId = 'host') => ({
    id,
    launch,
    hostId,
  });
  const occupied = {
    ...slot(),
    foreignHeldCheckouts: foreignHeldCheckouts([{ id: 'foreign', working_path: '/shared' }], []),
    queue: [start('guarded', guarded), start('readonly', readonly), start('second', readonly)],
  };
  expect(drainableStarts(occupied, 'host').map(start => start.id)).toEqual(['readonly']);
  expect(
    drainableStarts(
      { ...slot(), queue: [start('other-host', guarded, 'other'), start('ours', readonly)] },
      'host'
    )
  ).toEqual([]);
});

test('failed resume ignores foreign-blocked promises but yields to runnable read-only ones', () => {
  const foreign = foreignHeldCheckouts([{ id: 'foreign', working_path: '/shared' }], []);
  const queue = [{ id: 'queued', hostId: 'host', launch: launch() }];
  const failed = { id: 'failed', metadata: {}, status: 'failed' as const };
  expect(
    resourceResumeBlocker({ ...slot(), foreignHeldCheckouts: foreign, queue }, failed)
  ).toBeNull();
  queue[0]!.launch = launch(false);
  expect(
    resourceResumeBlocker({ ...slot(), foreignHeldCheckouts: foreign, queue }, failed)
  ).toEqual({ kind: 'request', id: 'queued' });
});

test('malformed guard declarations fail at start, drain and failed-resume decisions', () => {
  const malformed = launch();
  malformed.run.metadata.admission_checkout_guard = 'false';
  const queue = [{ id: 'malformed', hostId: 'host', launch: malformed }];
  expect(() => resourceStartBlocker(slot(), malformed)).toThrow('expected a boolean');
  expect(() => drainableStarts({ ...slot(), queue }, 'host')).toThrow('expected a boolean');
  expect(() =>
    resourceResumeBlocker({ ...slot(), queue }, { id: 'failed', metadata: {}, status: 'failed' })
  ).toThrow('expected a boolean');
});
