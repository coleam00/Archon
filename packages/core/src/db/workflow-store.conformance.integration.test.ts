// @archon-test-isolated
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import {
  describeWorkflowStoreConformance,
  resourceStartFixtures,
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
} from '@archon/workflows/store-conformance';
import type { QueryResult } from './adapters/types';
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
    return { ...harness, db };
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

test.each(['nested-workflow', null])(
  'parent deletion preserves child provenance after metadata erasure attempts (node: %s)',
  async marker => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const parent = await store.createWorkflowRun({ workflow_name: 'parent', user_message: '' });
      const child = await store.createWorkflowRun({
        workflow_name: 'child',
        user_message: '',
        parent_run_id: parent.id,
        metadata: marker === null ? {} : { parent_node_id: marker },
      });
      await store.claimPendingWorkflowRun(child.id);
      await store.updateWorkflowRun(child.id, { metadata: { parent_node_id: null } });
      expect(
        await store.updateWorkflowRunMetadataIfRunning(child.id, { parent_node_id: 'replacement' })
      ).toBe(true);
      await store.cancelWorkflowRun(parent.id);
      const { deleteWorkflowRun } = await import('./workflows');
      await deleteWorkflowRun(parent.id);
      const surviving = await store.getWorkflowRun(child.id);
      expect(surviving?.parent_run_id).toBeNull();
      expect(surviving?.metadata).toHaveProperty('parent_node_id', marker);
    } finally {
      await harness.close();
    }
  }
);

test('admission pages do not advance beyond the head captured before a concurrent commit', async () => {
  const harness = await makeHarness();
  const { db, store } = harness;
  try {
    const { start } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
    await store.admitResourceStart(start());
    const dropped = start('skip');
    const receiptId = crypto.randomUUID();
    await store.acceptStartReceipt({
      receipt: {
        id: receiptId,
        sourceInstanceId: 'source',
        deliveryId: 'delivery',
        contentDigest: 'digest',
        receivedAt: new Date().toISOString(),
        occurredAt: null,
        sourceActor: null,
      },
      outcome: 'matched',
      bindings: [
        {
          resource: dropped.resource,
          capacity: 1,
          hostId: 'host',
          overlap: 'skip',
          bindingId: 'binding',
          bindingRevision: null,
          runAsUserId: 'operator',
          launch: {
            cwd: '/conformance',
            workflowName: 'test',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
      ],
    });
    let inserted = false;
    const query = db.query.bind(db);
    const reads = spyOn(db, 'query').mockImplementation(
      async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
        const result = await query<T>(sql, params);
        if (!inserted && sql.includes('MAX(queue_position)')) {
          inserted = true;
          await store.admitResourceStart({
            ...dropped,
            receipt: { receiptId, bindingId: 'binding' },
          });
        }
        return result;
      }
    );
    try {
      const first = await store.readAdmissionNoticesAfter(null, { limit: 1 });
      expect(inserted).toBe(true);
      expect(first.notices).toEqual([]);
      expect(first.caughtUp).toBe(true);
      const second = await store.readAdmissionNoticesAfter(first.next, { limit: 1 });
      expect(second.notices.map(row => row.facts.requestId)).toEqual([dropped.launch.run.id]);
    } finally {
      reads.mockRestore();
    }
  } finally {
    await harness.close();
  }
});
