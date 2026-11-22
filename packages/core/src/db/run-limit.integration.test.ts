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

function launch(): PreparedWorkflowLaunch {
  const id = crypto.randomUUID();
  return {
    version: 2,
    run: { id, workflow_name: 'test', codebase_id: CODEBASE_ID, user_message: '', metadata: {} },
    execution: { cwd: `/tmp/test/${id}`, conversationId: id, isolation: { kind: 'in-place' } },
  };
}

const setRunLimit = (runs: number | string) =>
  writeFile(join(root, 'config.yaml'), `concurrency:\n  runs: ${String(runs)}\n`);

/** A bound start on `resource`, which has room for five. */
const bound = (resource = 'pool', overlap: 'queue' | 'skip' = 'queue') => {
  const prepared = launch();
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
    const second = await bound('pool', 'skip');
    // Only the limit holds it, so it queues under `skip` too, behind the counted tree.
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

  test('an older queued start on the resource skips a skip start, with or without the limit', async () => {
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
    expect(statuses).toEqual(['admitted', 'queued', 'skipped']);
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
    expect((await store.getRunLimit())?.waiting).toEqual([a1.id, a2.id, b1.id]);
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
