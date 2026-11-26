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
      const fromRun = { runId: 'run-1', nodePath: 'order' };
      // A work order is given priority before anything else names it.
      expect(await store.setItemPriority({ projectKey, key: 'wo', fromRun })).toEqual({
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

      await store.setItemPriority({ projectKey, key: 'task', fromRun: null });
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

  test('a queued start of an item with priority is admitted before older ordinary ones, at each resource', async () => {
    const harness = await makeHarness();
    try {
      const { store, db } = harness;
      const { launch } = resourceStartFixtures(
        CONFORMANCE_CODEBASE_ID,
        CONFORMANCE_CONVERSATION_ID
      );
      // Preparation writes a start's item onto its request; this stands in for it.
      const queue = async (resource: string, item: string) => {
        const intent = {
          resource,
          capacity: 1,
          hostId: 'host',
          overlap: 'queue',
          launch: launch(),
        } as const;
        const disposition = await store.admitResourceStart(intent);
        await db.query(
          'INSERT INTO remote_agent_items (project_key, key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [projectKey, item]
        );
        await db.query(
          'UPDATE remote_agent_resource_start_requests SET item_id = $1 WHERE id = $2',
          [await itemId(store, item), intent.launch.run.id]
        );
        return { id: intent.launch.run.id, disposition };
      };
      const finish = (id: string) =>
        db.query("UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1", [id]);
      const drain = async (resource: string) =>
        (await store.drainResourceStarts({ resource, hostId: 'host' })).map(row => row.requestId);

      await partOf(store, 'member', 'wo');
      const holder = await queue('build', 'holder');
      expect(holder.disposition.status).toBe('admitted');
      const a = await queue('build', 'a');
      const b = await queue('build', 'b');
      const c = await queue('build', 'member');
      // Priority given after the start queued still reorders it.
      await store.setItemPriority({ projectKey, key: 'wo', fromRun: null });
      const member = await itemId(store, 'member');
      expect((await store.listQueuedItemStarts(member)).map(start => start.ahead)).toEqual([0]);
      expect((await store.listQueuedItemStarts(await itemId(store, 'a')))[0]?.ahead).toBe(1);

      // Nothing holding a slot is interrupted: the running holder keeps it.
      expect(await drain('build')).toEqual([]);
      expect((await store.getWorkflowRun(holder.id))?.status).toBe('pending');
      await finish(holder.id);
      expect(await drain('build')).toEqual([c.id]);
      await finish(c.id);
      expect(await drain('build')).toEqual([a.id]);
      await finish(a.id);

      // The member's next stage goes first too, with no one passing it priority.
      const reviewer = await queue('review', 'holder');
      const d = await queue('review', 'b');
      const c2 = await queue('review', 'member');
      await finish(reviewer.id);
      expect(await drain('review')).toEqual([c2.id]);
      expect((await store.getResourceStartRequest(d.id))?.status).toBe('queued');
      expect((await store.getResourceStartRequest(b.id))?.status).toBe('queued');
    } finally {
      await harness.close();
    }
  });
}
