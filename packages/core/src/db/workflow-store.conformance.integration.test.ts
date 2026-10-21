// @archon-test-isolated
import { expect, spyOn, test } from 'bun:test';
import { SQLiteError } from 'bun:sqlite';
import { executionClaim } from '@archon/workflows/store';
import type { IDatabase } from './adapters/types';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { describeWorkflowStoreConformance } from '@archon/workflows/store-conformance';
import {
  makeSqlConformanceHarness,
  describeSqlStatusReadConformance,
} from './workflow-store.conformance-harness';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const trackTempRoot = trackTempRoots();

const makeHarness = async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'workflow-store-conformance-')));
  const db = new SqliteAdapter(join(root, 'store.db'));
  const close = async () => {
    await db.close();
    await removeTempTree(root);
  };
  try {
    const harness = await makeSqlConformanceHarness(db, sqliteDialect, 'sqlite', close);
    return { ...harness, db, dbPath: join(root, 'store.db') };
  } catch (error) {
    await close();
    throw error;
  }
};
describeWorkflowStoreConformance('SQLite', makeHarness);

describeSqlStatusReadConformance(makeHarness);

test('explicit deletion retains SQL feed payloads from an earlier cursor', async () => {
  const harness = await makeHarness();
  try {
    const { store } = harness;
    const run = await store.createWorkflowRun({ workflow_name: 'delete-feed', user_message: '' });
    const head = await store.getWorkflowEventHead();
    await store.cancelWorkflowRun(run.id);
    const committed = await store.listWorkflowEvents(run.id);
    const { deleteWorkflowRun } = await import('./workflows');
    await deleteWorkflowRun(run.id);
    expect(await store.getWorkflowRun(run.id)).toBeNull();
    expect(await store.listWorkflowEvents(run.id)).toEqual([]);
    expect(
      (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event)
    ).toEqual(committed);
  } finally {
    await harness.close();
  }
});

test('paused suspension excludes resume through an independent SQLite connection', async () => {
  const harness = await makeHarness();
  const { store, db, dbPath } = harness;
  const peer = new SqliteAdapter(dbPath);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  let cleanup: Promise<unknown> | undefined;
  let resume: Promise<unknown> | undefined;
  const transaction = db.withTransaction.bind(db);
  let usePeer = false;
  const routedTransaction: IDatabase['withTransaction'] = (fn, options) =>
    usePeer
      ? peer.withTransaction(
          query =>
            fn(async <T>(sql: string, params?: unknown[]) => {
              try {
                return await query<T>(sql, params);
              } catch (error) {
                if (error instanceof SQLiteError && (error.errno & 0xff) === 5) blocked.resolve();
                throw error;
              }
            }),
          options
        )
      : transaction(fn, options);
  const route = spyOn(db, 'withTransaction').mockImplementation(routedTransaction);
  const query = db.query.bind(db);
  const reads = spyOn(db, 'query').mockImplementation((sql, params) =>
    usePeer ? peer.query(sql, params) : query(sql, params)
  );
  try {
    await peer.query('PRAGMA busy_timeout = 0');
    const run = await store.createWorkflowRun({ workflow_name: 'pause-lock', user_message: '' });
    const claimed = await store.claimPendingWorkflowRun(run.id);
    if (!claimed) throw new Error('Missing claim');
    await store.pauseWorkflowRun(run.id, { nodeId: 'gate', type: 'approval', message: 'Review' });
    const order: string[] = [];
    cleanup = store.withPausedExecution(run.id, executionClaim(claimed.metadata), async () => {
      entered.resolve();
      await finish.promise;
      order.push('stopped');
    });
    await entered.promise;
    usePeer = true;
    resume = store.resumeWorkflowRun(run.id).then(next => {
      order.push('resumed');
      return next;
    });
    expect(
      await Promise.race([blocked.promise.then(() => 'blocked'), resume.then(() => 'resumed')])
    ).toBe('blocked');
    expect(order).toEqual([]);
    finish.resolve();
    expect(await cleanup).toEqual({ executed: true });
    expect(await resume).toMatchObject({ status: 'running' });
    expect(order).toEqual(['stopped', 'resumed']);
    expect(executionClaim((await store.getWorkflowRun(run.id))?.metadata ?? {})).not.toBe(
      executionClaim(claimed.metadata)
    );
  } finally {
    finish.resolve();
    await Promise.allSettled([cleanup, resume]);
    route.mockRestore();
    reads.mockRestore();
    await peer.close();
    await harness.close();
  }
});
