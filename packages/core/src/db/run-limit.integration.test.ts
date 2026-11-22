// @archon-test-isolated
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { RunLimitError } from '@archon/workflows/store';
import type { PreparedWorkflowLaunch } from '@archon/workflows/schemas/resource-start';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import { createWorkflowStore } from '../workflows/store-adapter';
import { createSqlWorkflowHost } from '../workflows/sql-host';
import { drainResourceStartHost } from '../workflows/resource-start-host';
import { ConcurrencyConfigError } from '../config/concurrency-config';

const CODEBASE_ID = '33333333-3333-4333-8333-333333333333';
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
let root = '';
const store = createWorkflowStore();

function launch(cwd?: string): PreparedWorkflowLaunch {
  const id = crypto.randomUUID();
  return {
    version: 2,
    run: { id, workflow_name: 'test', codebase_id: CODEBASE_ID, user_message: '', metadata: {} },
    execution: {
      cwd: cwd ?? `/tmp/test/${id}`,
      conversationId: id,
      isolation: { kind: 'in-place' },
    },
  };
}

const setRunLimit = (runs: number | string) =>
  writeFile(join(root, 'config.yaml'), `concurrency:\n  runs: ${String(runs)}\n`);

/** A bound start on `resource`, which has room for five, in its own checkout unless `cwd` names one. */
const bound = (resource = 'pool', overlap: 'queue' | 'skip' = 'queue', cwd?: string) => {
  const prepared = launch(cwd);
  return store
    .admitResourceStart({ resource, capacity: 5, hostId: 'host', overlap, launch: prepared })
    .then(disposition => ({ id: prepared.run.id, disposition }));
};

const hand = (parentRunId?: string) =>
  store.createWorkflowRun({
    id: crypto.randomUUID(),
    workflow_name: 'test',
    user_message: '',
    ...(parentRunId === undefined ? {} : { parent_run_id: parentRunId }),
  });

const end = (id: string) =>
  getDatabase().query("UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1", [
    id,
  ]);

const setStatus = (id: string, to: 'paused' | 'failed' | 'cancelled') =>
  getDatabase().query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [to, id]);

const status = async (id: string) => (await store.getWorkflowRun(id))?.status;

/** A hand start of a workflow that declares no resource, claimed: a running root. */
const running = async (parentRunId?: string) => {
  const run = await hand(parentRunId);
  expect(await store.claimPendingWorkflowRun(run.id)).toMatchObject({ status: 'running' });
  return run;
};

/** One host drain pass, returning the requests it handed to an executor. */
const drainHost = async () => {
  const started: string[] = [];
  await drainResourceStartHost({
    ...createSqlWorkflowHost(),
    hostId: 'host',
    startAdmitted: async id => {
      started.push(id);
      return null;
    },
  });
  return started;
};

const refusal = (pending: Promise<unknown>) => pending.catch((error: unknown) => error);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-run-limit-'));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
  await getDatabase().query(
    `INSERT INTO remote_agent_codebases (id, name, default_cwd, ai_assistant_type) VALUES ($1, 'test', '/tmp/test', 'claude')`,
    [CODEBASE_ID]
  );
});

afterEach(async () => {
  await closeDatabase();
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

describe('run limit', () => {
  test('the start past the limit queues and the next host drain starts it once a tree ends', async () => {
    await setRunLimit(1);
    const first = await bound();
    const second = await bound();
    expect(second.disposition).toEqual({
      status: 'queued',
      requestId: second.id,
      blocker: { kind: 'run', id: first.id },
    });
    expect(await store.getRunLimit()).toEqual({ limit: 1, live: 1, waiting: [second.id] });
    expect(await drainHost()).toEqual([]);
    await end(first.id);
    expect(await drainHost()).toEqual([second.id]);
  });

  test('a start the resource refuses keeps its resource blocker and is not waiting for the limit', async () => {
    await setRunLimit(1);
    const holder = launch();
    await store.admitResourceStart({
      resource: 'narrow',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: holder,
    });
    const refused = launch();
    expect(
      await store.admitResourceStart({
        resource: 'narrow',
        capacity: 1,
        hostId: 'host',
        overlap: 'skip',
        launch: refused,
      })
    ).toMatchObject({ status: 'skipped', blocker: { kind: 'run', id: holder.run.id } });
    const queued = launch();
    await store.admitResourceStart({
      resource: 'narrow',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: queued,
    });
    expect((await store.getRunLimit())?.waiting).toEqual([]);
  });

  test('a skip start is skipped for its resource or for the limit alike', async () => {
    // Without a limit: the resource is full and a start is already queued on it. It is another
    // host's queue, so it does not take the room the second half of the test uses.
    const holder = launch();
    const narrow = (prepared: PreparedWorkflowLaunch, overlap: 'queue' | 'skip') =>
      store.admitResourceStart({
        resource: 'narrow',
        capacity: 1,
        hostId: 'elsewhere',
        overlap,
        launch: prepared,
      });
    await narrow(holder, 'queue');
    await narrow(launch(), 'queue');
    expect((await narrow(launch(), 'skip')).status).toBe('skipped');
    // With a limit, an older start that waits only for the limit still skips the next one.
    await setRunLimit(1);
    await end(holder.run.id);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await bound('wide', 'skip')).disposition.status);
    // `skip` acts on the limit's blocker as on the resource's: the limit never makes it queue.
    expect(statuses).toEqual(['admitted', 'skipped', 'skipped']);
  });

  test('a tree counts once until every run in it ends, whatever its runs do', async () => {
    await setRunLimit(1);
    const parent = await running();
    const child = await hand(parent.id);
    const pending = launch();
    pending.run.id = child.id;
    // The child takes a slot on another resource inside its tree's place.
    expect(await store.admitPendingRun({ resource: 'other', capacity: 1, launch: pending })).toBe(
      null
    );
    await setStatus(parent.id, 'paused');
    expect(await store.getRunLimit()).toMatchObject({ live: 1 });
    expect(await store.claimPendingWorkflowRun(child.id)).toMatchObject({ status: 'running' });
    // Child and parent both pause: the tree keeps its place, so an unrelated start waits.
    await setStatus(child.id, 'paused');
    const unrelated = await hand();
    expect(await refusal(store.claimPendingWorkflowRun(unrelated.id))).toBeInstanceOf(
      RunLimitError
    );
    expect(await store.getRunLimit()).toMatchObject({ live: 1 });
    // The sub-run continues across its parent's pause, and so does the paused root.
    expect((await store.resumeWorkflowRun(child.id)).status).toBe('running');
    expect((await store.resumeWorkflowRun(parent.id)).status).toBe('running');
    expect(await store.getRunLimit()).toMatchObject({ live: 1 });
    // Once every run in it ends, the tree frees its place.
    await end(child.id);
    await setStatus(parent.id, 'cancelled');
    expect(await store.claimPendingWorkflowRun(unrelated.id)).toMatchObject({ status: 'running' });
  });

  test('a failed tree resumes only with room, and keeps its state when refused', async () => {
    await setRunLimit(1);
    const failed = await running();
    await setStatus(failed.id, 'failed');
    const other = await running();
    expect(await refusal(store.resumeWorkflowRun(failed.id))).toBeInstanceOf(RunLimitError);
    expect(await status(failed.id)).toBe('failed');
    await end(other.id);
    expect((await store.resumeWorkflowRun(failed.id)).status).toBe('running');
  });

  test('hand starts count, with or without a resource, and wait until room frees', async () => {
    await setRunLimit(1);
    const first = await running();
    const plain = await hand();
    expect(await refusal(store.claimPendingWorkflowRun(plain.id))).toBeInstanceOf(RunLimitError);
    const withResource = await hand();
    const pending = launch();
    pending.run.id = withResource.id;
    const full = await refusal(
      store.admitPendingRun({ resource: 'wide', capacity: 5, launch: pending })
    );
    expect(full).toBeInstanceOf(RunLimitError);
    expect((full as RunLimitError).runLimit).toEqual({ limit: 1, live: 1 });
    expect(await store.getResourceStartRequest(withResource.id)).toBeNull();
    await end(first.id);
    expect(await store.admitPendingRun({ resource: 'wide', capacity: 5, launch: pending })).toBe(
      null
    );
    // The admitted start holds the room; the plain hand start waits for it.
    expect(await refusal(store.claimPendingWorkflowRun(plain.id))).toBeInstanceOf(RunLimitError);
  });

  test('a start cancelled while it waits is not refused, so its own claim tells it', async () => {
    await setRunLimit(1);
    await running();
    const waiting = await hand();
    await setStatus(waiting.id, 'cancelled');
    expect(await store.claimPendingWorkflowRun(waiting.id)).toBeNull();
  });

  test('a host keeps its queue order across resources, and a hand start can pass it', async () => {
    await setRunLimit(2);
    const live = [await bound('c'), await bound('c')];
    const a1 = await bound('a');
    const b1 = await bound('b');
    const a2 = await bound('a');
    expect((await store.getRunLimit())?.waiting).toEqual([a1.id, b1.id, a2.id]);
    await end(live[0]!.id);
    // A hand start takes the free room ahead of the host's queue (the ruling).
    const handStart = await running();
    expect(await drainHost()).toEqual([]);
    await end(handStart.id);
    await end(live[1]!.id);
    expect(await drainHost()).toEqual([a1.id, b1.id]);
    expect((await store.getResourceStartRequest(a2.id))?.status).toBe('queued');
    expect((await store.getRunLimit())?.waiting).toEqual([a2.id]);
  });

  test('a drain admits starts of a host in queue order, even when room is taken mid-pass', async () => {
    await setRunLimit(3);
    const live = [await bound('c'), await bound('c'), await bound('c')];
    const a1 = await bound('a');
    const b1 = await bound('b');
    const a2 = await bound('a');
    for (const { id } of live) await end(id);
    const started: string[] = [];
    await drainResourceStartHost({
      ...createSqlWorkflowHost(),
      hostId: 'host',
      startAdmitted: async id => {
        started.push(id);
        // A hand start takes a freed slot while the first admitted start is handed off.
        if (started.length === 1) await running();
        return null;
      },
    });
    expect(started).toEqual([a1.id, b1.id]);
    expect((await store.getResourceStartRequest(a2.id))?.status).toBe('queued');
  });

  // b1 and a1 share a checkout on different resources, queued behind a full limit that then
  // frees `room`. The drain admits b1 first, so a1 is held by b1's checkout, not by the limit.
  const sharedCheckoutQueue = async (runs: number, room: number) => {
    await setRunLimit(runs);
    const live = [];
    for (let i = 0; i < runs; i++) live.push(await bound('c'));
    const b1 = await bound('b', 'queue', '/tmp/test/shared');
    const a1 = await bound('a', 'queue', '/tmp/test/shared');
    const a2 = await bound('a', 'queue', '/tmp/test/other');
    for (const { id } of live.slice(0, room)) await end(id);
    return { b1, a1, a2 };
  };

  test('a start held by a checkout an earlier admit takes is not waiting for the limit', async () => {
    const { b1, a1, a2 } = await sharedCheckoutQueue(3, 2);
    expect((await store.getRunLimit())?.waiting).toEqual([]);
    expect(await drainHost()).toEqual([b1.id, a2.id]);
    expect((await store.getResourceStartRequest(a1.id))?.status).toBe('queued');
  });

  test('a start the limit holds behind a shared checkout is reported before and after the drain', async () => {
    const { b1, a1, a2 } = await sharedCheckoutQueue(2, 1);
    expect((await store.getRunLimit())?.waiting).toEqual([a2.id]);
    expect(await drainHost()).toEqual([b1.id]);
    expect((await store.getResourceStartRequest(a1.id))?.status).toBe('queued');
    expect((await store.getRunLimit())?.waiting).toEqual([a2.id]);
  });

  test('freed room reaches every queued start of a host in queue order in one drain', async () => {
    await setRunLimit(3);
    const live = [await bound('c'), await bound('c'), await bound('c')];
    const queued = [await bound('a'), await bound('b'), await bound('a')];
    for (const { id } of live) await end(id);
    // The whole queue fits, so none of it waits for the limit, though a pass reaches b first.
    expect((await store.getRunLimit())?.waiting).toEqual([]);
    expect(await drainHost()).toEqual(queued.map(start => start.id));
  });

  test('a new start of a host waits behind its older start elsewhere even with room for both', async () => {
    await setRunLimit(2);
    const live = [await bound('c'), await bound('c')];
    const older = await bound('b');
    for (const { id } of live) await end(id);
    const newer = await bound('a');
    expect(newer.disposition).toMatchObject({
      status: 'queued',
      blocker: { kind: 'request', id: older.id },
    });
    expect((await store.getRunLimit())?.waiting).toEqual([]);
    expect(await drainHost()).toEqual([older.id, newer.id]);
  });

  test('a pending sub-run keeps its tree counted after its parent is cancelled', async () => {
    await setRunLimit(1);
    const parent = await running();
    const plain = await hand(parent.id);
    await setStatus(parent.id, 'cancelled');
    // Only the pending child is left, and it holds the tree's place.
    expect(await store.getRunLimit()).toMatchObject({ live: 1 });
    const unrelated = await hand();
    expect(await refusal(store.claimPendingWorkflowRun(unrelated.id))).toBeInstanceOf(
      RunLimitError
    );
    // A sibling created now is inside the counted tree, and so is its resource admission.
    const admitted = await hand(parent.id);
    const onResource = launch();
    onResource.run.id = admitted.id;
    expect(
      await store.admitPendingRun({ resource: 'other', capacity: 1, launch: onResource })
    ).toBe(null);
    expect(await store.claimPendingWorkflowRun(admitted.id)).toMatchObject({ status: 'running' });
    expect(await store.claimPendingWorkflowRun(plain.id)).toMatchObject({ status: 'running' });
    expect(await store.getRunLimit()).toMatchObject({ live: 1 });
  });

  test('a sub-run created or recovered after its whole tree ended needs room', async () => {
    await setRunLimit(1);
    const parent = await running();
    const cancelledChild = await running(parent.id);
    await getDatabase().query(
      `UPDATE remote_agent_workflow_runs SET status = 'cancelled', metadata = $2 WHERE id = $1`,
      [cancelledChild.id, JSON.stringify({ cancelled_reason: 'fan_out_sibling' })]
    );
    await setStatus(parent.id, 'cancelled');
    const other = await running();
    // A child created late, after its parent was cancelled, is refused at its creation.
    expect(await refusal(hand(parent.id))).toBeInstanceOf(RunLimitError);
    // An engine-cancelled child is not recovered into the room another tree holds.
    expect(await refusal(store.recoverCancelledFanOutRun(cancelledChild.id))).toBeInstanceOf(
      RunLimitError
    );
    expect(await status(cancelledChild.id)).toBe('cancelled');
    expect(await store.getRunLimit()).toMatchObject({ live: 1 });
    await end(other.id);
    // With room, its creation takes the tree's place again, and its claim runs inside it.
    const late = await hand(parent.id);
    expect(await store.getRunLimit()).toMatchObject({ live: 1 });
    expect(await store.claimPendingWorkflowRun(late.id)).toMatchObject({ status: 'running' });
  });

  test('a new start of a host waits behind its older start on another resource', async () => {
    await setRunLimit(1);
    const live = await bound('a');
    const older = await bound('b');
    await end(live.id);
    const newer = await bound('a');
    expect(newer.disposition).toMatchObject({
      status: 'queued',
      blocker: { kind: 'request', id: older.id },
    });
    expect(await store.getRunLimit()).toEqual({ limit: 1, live: 0, waiting: [newer.id] });
    expect(await drainHost()).toEqual([older.id]);
  });

  test('lowering the limit stops no run, and raising it admits at the next drain', async () => {
    await setRunLimit(3);
    const live = [await running(), await running()];
    await setRunLimit(1);
    const queued = await bound();
    expect(queued.disposition.status).toBe('queued');
    for (const { id } of live) expect(await status(id)).toBe('running');
    await setRunLimit(3);
    expect(await drainHost()).toEqual([queued.id]);
  });

  test('a value that is not a positive integer refuses admissions', async () => {
    await setRunLimit(0);
    await expect(bound()).rejects.toBeInstanceOf(ConcurrencyConfigError);
    const run = await hand();
    await expect(store.claimPendingWorkflowRun(run.id)).rejects.toBeInstanceOf(
      ConcurrencyConfigError
    );
  });

  test('with no limit set nothing is held back and none is reported', async () => {
    for (let i = 0; i < 3; i++) expect((await bound()).disposition.status).toBe('admitted');
    expect(await store.getRunLimit()).toBeNull();
  });
});
