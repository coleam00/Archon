/**
 * Item priority, on both SQL stores: how an item comes to have it, and the queue order it
 * gives. Called from each backend's conformance test with its harness factory, after
 * `makeSqlConformanceHarness` has routed the store to that backend's database.
 */
import { expect, test } from 'bun:test';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import type { IWorkflowStore } from '@archon/workflows/store';
import {
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
  resourceStartFixtures,
  type WorkflowStoreHarness,
} from '@archon/workflows/store-conformance';
import type { IDatabase } from './adapters/types';

const projectKey = projectKeyForCodebase({ name: 'conformance', default_cwd: '/conformance' }, '');
const byCli = { via: 'cli', by: null, fromRun: null } as const;

type Harness = WorkflowStoreHarness & { db: IDatabase };

async function itemId(store: IWorkflowStore, key: string): Promise<string> {
  const found = await store.getItemRuns(projectKey, key);
  if (!found) throw new Error(`no item ${key}`);
  return found.item.id;
}

const partOf = (store: IWorkflowStore, from: string, to: string) =>
  store.recordItemLink({ projectKey, fromKey: from, toKey: to, kind: 'part_of', ...byCli });

export function describeItemPriorityConformance(makeHarness: () => Promise<Harness>): void {
  test('priority is the item’s own or comes through active part_of links, at any depth', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      // A work order is given priority before anything else names it.
      expect(await store.setItemPriority({ projectKey, key: 'wo' })).toEqual({
        own: true,
        inheritedFrom: [],
      });
      await partOf(store, 'epic', 'wo');
      const nested = await partOf(store, 'task', 'epic');
      // A cycle ends the walk instead of looping.
      await partOf(store, 'wo', 'task');
      const wo = { id: await itemId(store, 'wo'), projectKey, key: 'wo' };
      expect(await store.getItemPriority(await itemId(store, 'task'))).toEqual({
        own: false,
        inheritedFrom: [wo],
      });
      expect(await store.getItemPriority(await itemId(store, 'wo'))).toEqual({
        own: true,
        inheritedFrom: [],
      });

      await store.setItemPriority({ projectKey, key: 'task' });
      // Clearing a member's own priority leaves what its work order gives it.
      expect(await store.clearItemPriority({ projectKey, key: 'task' })).toEqual({
        priority: { own: false, inheritedFrom: [wo] },
      });
      await store.endItemLink({ linkId: nested.link.id, ...byCli });
      expect(await store.getItemPriority(await itemId(store, 'task'))).toBeNull();
      expect(await store.clearItemPriority({ projectKey, key: 'wo' })).toEqual({ priority: null });
      expect(await store.getItemPriority(await itemId(store, 'epic'))).toBeNull();
      // Clearing never creates an item.
      expect(await store.clearItemPriority({ projectKey, key: 'nobody' })).toBeNull();
      expect(await store.getItemRuns(projectKey, 'nobody')).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('queued starts of a priority work order’s members go first at each stage, FIFO, never taking a held slot', async () => {
    const harness = await makeHarness();
    try {
      const { store, db } = harness;
      const { launch } = resourceStartFixtures(
        CONFORMANCE_CODEBASE_ID,
        CONFORMANCE_CONVERSATION_ID
      );
      // A fire on `item`, prepared as a host's drain prepares it: the item comes from the receipt.
      const fire = async (resource: string, capacity: number, item: string) => {
        const receiptId = crypto.randomUUID();
        await store.acceptStartReceipt({
          receipt: {
            id: receiptId,
            sourceInstanceId: 'priority',
            deliveryId: null,
            contentDigest: receiptId,
            receivedAt: new Date().toISOString(),
            occurredAt: null,
            sourceActor: null,
            itemKey: item,
          },
          outcome: 'matched',
          bindings: [
            {
              bindingId: 'stage',
              bindingRevision: null,
              hostId: 'host',
              runAsUserId: 'operator',
              resource,
              capacity,
              overlap: 'queue',
              launch: {
                cwd: '/conformance',
                workflowName: 'conformance',
                inputs: {},
                isolation: { kind: 'in-place' },
              },
            },
          ],
        });
        const identity = { receiptId, bindingId: 'stage', ownerId: 'owner' };
        expect(await store.claimStartBindingPreparation(identity)).toBe(true);
        const prepared = launch();
        const result = await store.completeStartBindingPreparation({
          ...identity,
          launch: prepared,
        });
        return { id: prepared.run.id, status: result?.status };
      };
      const setStatus = (id: string, status: string) =>
        db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [status, id]);
      const drain = async (resource: string) =>
        (await store.drainResourceStarts({ resource, hostId: 'host' })).map(row => row.requestId);
      const arrivalOrder = async (resource: string) =>
        (
          await db.query<{ id: string }>(
            `SELECT id FROM remote_agent_resource_start_requests
              WHERE resource_key = $1 AND status = 'queued' ORDER BY queue_position`,
            [resource]
          )
        ).rows.map(row => String(row.id));

      await partOf(store, 'm1', 'wo');
      await partOf(store, 'm2', 'wo');
      // Two slots, one held by a running run and one by a paused run that keeps it.
      const running = await fire('build', 2, 'h1');
      const paused = await fire('build', 2, 'h2');
      expect([running.status, paused.status]).toEqual(['admitted', 'admitted']);
      await setStatus(running.id, 'running');
      await setStatus(paused.id, 'paused');
      const a = await fire('build', 2, 'a');
      const p1 = await fire('build', 2, 'm1');
      const p2 = await fire('build', 2, 'm2');
      expect([a.status, p1.status, p2.status]).toEqual(['queued', 'queued', 'queued']);
      // Priority given after the starts queued still reorders them.
      await store.setItemPriority({ projectKey, key: 'wo' });
      // The stored order an older binary reads is untouched.
      expect(await arrivalOrder('build')).toEqual([a.id, p1.id, p2.id]);
      expect((await store.listQueuedItemStarts(await itemId(store, 'm1')))[0]?.ahead).toBe(0);
      expect((await store.listQueuedItemStarts(await itemId(store, 'a')))[0]?.ahead).toBe(2);

      expect(await drain('build')).toEqual([]);
      expect((await store.getWorkflowRun(running.id))?.status).toBe('running');
      expect((await store.getWorkflowRun(paused.id))?.status).toBe('paused');
      // Both slots free: both priority starts take them, oldest first, and ordinary work waits.
      await setStatus(running.id, 'completed');
      await setStatus(paused.id, 'completed');
      expect(await drain('build')).toEqual([p1.id, p2.id]);
      expect((await store.getResourceStartRequest(a.id))?.status).toBe('queued');
      await setStatus(p1.id, 'completed');
      await setStatus(p2.id, 'completed');

      // The member's next stage goes first too, with no one passing it priority.
      const reviewer = await fire('review', 1, 'r');
      const d = await fire('review', 1, 'd');
      const next = await fire('review', 1, 'm1');
      expect([reviewer.status, d.status, next.status]).toEqual(['admitted', 'queued', 'queued']);
      await setStatus(reviewer.id, 'completed');
      expect(await drain('review')).toEqual([next.id]);
      expect((await store.getResourceStartRequest(d.id))?.status).toBe('queued');
    } finally {
      await harness.close();
    }
  });
}
