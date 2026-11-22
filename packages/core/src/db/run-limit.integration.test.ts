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

const status = async (id: string) => (await store.getWorkflowRun(id))?.status;

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
  test('the start past the limit queues behind the oldest run and is admitted once a run ends', async () => {
    await setRunLimit(2);
    const live = [await bound(), await bound()];
    const third = await bound('pool', 'skip');
    // Queued, not skipped: `skip` refuses an overlap on the resource, and it has room. The
    // blocker is the oldest counted run; two started in the same instant tie on id.
    expect(third.disposition).toMatchObject({ status: 'queued', blocker: { kind: 'run' } });
    const blocker = third.disposition.status === 'queued' ? third.disposition.blocker.id : '';
    expect(live.map(run => run.id)).toContain(blocker);
    expect(await store.getRunLimit()).toEqual({ limit: 2, live: 2 });
    expect(await store.drainResourceStarts({ resource: 'pool', hostId: 'host' })).toEqual([]);

    await end(live[0]!.id);
    expect(await store.drainResourceStarts({ resource: 'pool', hostId: 'host' })).toMatchObject([
      { status: 'admitted', requestId: third.id },
    ]);
  });

  test('a full resource reports the resource, and a free one the limit', async () => {
    await setRunLimit(1);
    const holder = await bound('narrow');
    const full = launch();
    expect(
      await store.admitResourceStart({
        resource: 'narrow',
        capacity: 1,
        hostId: 'host',
        overlap: 'skip',
        launch: full,
      })
    ).toMatchObject({ status: 'skipped', blocker: { kind: 'run', id: holder.id } });

    const run = await hand();
    const pending = launch();
    pending.run.id = run.id;
    expect(
      await store.admitPendingRun({ resource: 'narrow', capacity: 1, launch: pending })
    ).toEqual({ kind: 'run', id: holder.id });
    const refused = await store
      .admitPendingRun({ resource: 'wide', capacity: 5, launch: pending })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RunLimitError);
    expect((refused as RunLimitError).runLimit).toEqual({ limit: 1, live: 1 });
    expect(await store.getResourceStartRequest(run.id)).toBeNull();
  });

  test('a hand start with no resource waits at its claim; children and paused runs do not count', async () => {
    await setRunLimit(1);
    const parent = await hand();
    expect(await store.claimPendingWorkflowRun(parent.id)).toMatchObject({ status: 'running' });
    const child = await hand(parent.id);
    expect(await store.claimPendingWorkflowRun(child.id)).toMatchObject({ status: 'running' });

    const waiting = await hand();
    expect(
      await store.claimPendingWorkflowRun(waiting.id).catch((error: unknown) => error)
    ).toBeInstanceOf(RunLimitError);
    expect(await status(waiting.id)).toBe('pending');

    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'paused' WHERE id = $1",
      [parent.id]
    );
    await end(child.id);
    expect(await store.claimPendingWorkflowRun(waiting.id)).toMatchObject({ status: 'running' });
  });

  test('a failed run resumes only while the limit has room', async () => {
    await setRunLimit(1);
    const failed = await hand();
    await store.claimPendingWorkflowRun(failed.id);
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'failed' WHERE id = $1",
      [failed.id]
    );
    const running = await hand();
    await store.claimPendingWorkflowRun(running.id);

    await expect(store.resumeWorkflowRun(failed.id)).rejects.toBeInstanceOf(RunLimitError);
    expect(await status(failed.id)).toBe('failed');
    await end(running.id);
    expect((await store.resumeWorkflowRun(failed.id)).status).toBe('running');
  });

  test('lowering the limit stops no run, and raising it admits at the next drain', async () => {
    await setRunLimit(3);
    const live = [await bound(), await bound()];
    await setRunLimit(1);
    const queued = await bound();
    expect(queued.disposition.status).toBe('queued');
    for (const { id } of live) expect(await status(id)).toBe('pending');
    expect(await store.getRunLimit()).toEqual({ limit: 1, live: 2 });

    await setRunLimit(3);
    expect(await store.drainResourceStarts({ resource: 'pool', hostId: 'host' })).toMatchObject([
      { status: 'admitted', requestId: queued.id },
    ]);
  });

  test('a host drain gives a freed run slot to the oldest queued start across resources', async () => {
    await setRunLimit(1);
    const live = await bound('a');
    // Older start on the resource whose name sorts last.
    const older = await bound('z');
    const newer = await bound('a');
    expect([older.disposition.status, newer.disposition.status]).toEqual(['queued', 'queued']);

    await end(live.id);
    const started: string[] = [];
    const host = createSqlWorkflowHost();
    await drainResourceStartHost({
      ...host,
      hostId: 'host',
      startAdmitted: async id => {
        started.push(id);
        return null;
      },
    });
    expect(started).toEqual([older.id]);
    expect((await store.getResourceStartRequest(newer.id))?.status).toBe('queued');
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
