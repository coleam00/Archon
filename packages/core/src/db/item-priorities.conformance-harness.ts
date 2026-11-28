/**
 * Item priority, on both SQL stores: how an item comes to have it, and the queue order it
 * gives. Called from each backend's conformance test with its harness factory, after
 * `makeSqlConformanceHarness` has routed the store to that backend's database.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import { removeTempTree } from '@archon/paths/test-utils';
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

async function itemId(store: IWorkflowStore, key: string, project = projectKey): Promise<string> {
  const found = await store.getItemRuns(project, key);
  if (!found) throw new Error(`no item ${key}`);
  return found.item.id;
}

const partOf = (store: IWorkflowStore, from: string, to: string) =>
  store.recordItemLink({ projectKey, fromKey: from, toKey: to, kind: 'part_of', ...byCli });

type Launch = ReturnType<typeof resourceStartFixtures>['launch'];

/**
 * A fire on `item`, prepared as a host's drain prepares it: the item comes from the receipt.
 * A keyed delivery already recorded replays and prepares nothing.
 */
async function fireOn(
  store: IWorkflowStore,
  launch: Launch,
  start: {
    resource: string;
    capacity: number;
    item: string;
    /** The start's checkout; acceptance resolves its project to give priority. */
    cwd?: string;
    deliveryId?: string;
    priority?: true;
    /** Accept only, as a fire under the install hold leaves its binding pending. */
    prepare?: false;
  }
): Promise<{ replay: boolean; id: string; status: string | undefined; receiptId: string }> {
  const receiptId = crypto.randomUUID();
  const accepted = await store.acceptStartReceipt({
    receipt: {
      id: receiptId,
      sourceInstanceId: 'priority',
      deliveryId: start.deliveryId ?? null,
      contentDigest: start.deliveryId ?? receiptId,
      receivedAt: new Date().toISOString(),
      occurredAt: null,
      sourceActor: null,
      itemKey: start.item,
      ...(start.priority ? { priority: start.priority } : {}),
    },
    outcome: 'matched',
    bindings: [
      {
        bindingId: 'stage',
        bindingRevision: null,
        hostId: 'host',
        runAsUserId: 'operator',
        resource: start.resource,
        capacity: start.capacity,
        overlap: 'queue',
        launch: {
          cwd: start.cwd ?? '/conformance',
          workflowName: 'conformance',
          inputs: {},
          isolation: { kind: 'in-place' },
        },
      },
    ],
  });
  const prepared = launch();
  if (accepted.replay || start.prepare === false)
    return { replay: accepted.replay, id: prepared.run.id, status: undefined, receiptId };
  return { replay: false, ...(await prepare(store, receiptId, prepared)), receiptId };
}

/** Prepare a receipt's binding as a host's drain does. */
async function prepare(
  store: IWorkflowStore,
  receiptId: string,
  prepared: ReturnType<Launch>
): Promise<{ id: string; status: string | undefined }> {
  const identity = { receiptId, bindingId: 'stage', ownerId: 'owner' };
  expect(await store.claimStartBindingPreparation(identity)).toBe(true);
  const result = await store.completeStartBindingPreparation({ ...identity, launch: prepared });
  return { id: prepared.run.id, status: result?.status };
}

/**
 * A project registered at a real directory, which acceptance resolves a fire's checkout to,
 * and the launch fixtures of starts prepared in it.
 */
async function checkoutProject(db: IDatabase) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'archon-priority-')));
  const codebaseId = crypto.randomUUID();
  await db.query(
    "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, 'priority', $2)",
    [codebaseId, cwd]
  );
  return {
    cwd,
    projectKey: projectKeyForCodebase({ name: 'priority', default_cwd: cwd }, cwd),
    launch: resourceStartFixtures(codebaseId, CONFORMANCE_CONVERSATION_ID).launch,
    remove: () => removeTempTree(cwd),
  };
}

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
      const wo = { id: await itemId(store, 'wo'), projectKey, key: 'wo', title: null };
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
      const fire = (resource: string, capacity: number, item: string) =>
        fireOn(store, launch, { resource, capacity, item });
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

  test('a fire that asks for priority gives its item priority once, at acceptance, and a replay never again', async () => {
    const harness = await makeHarness();
    const site = await checkoutProject(harness.db);
    try {
      const { store, db } = harness;
      const at = { resource: 'ship', capacity: 1, cwd: site.cwd };
      const holder = await fireOn(store, site.launch, { ...at, item: 'h' });
      const ordinary = await fireOn(store, site.launch, { ...at, item: 'o' });
      const urgent = await fireOn(store, site.launch, {
        ...at,
        item: 'urgent',
        deliveryId: 'urgent-1',
        priority: true,
      });
      expect([holder.status, ordinary.status, urgent.status]).toEqual([
        'admitted',
        'queued',
        'queued',
      ]);
      const urgentId = await itemId(store, 'urgent', site.projectKey);
      expect(await store.getItemPriority(urgentId)).toEqual({ own: true, inheritedFrom: [] });
      expect((await store.listQueuedItemStarts(urgentId))[0]?.ahead).toBe(0);

      // A retry of the same delivery, even naming another item, leaves priority as it is.
      await store.clearItemPriority({ projectKey: site.projectKey, key: 'urgent' });
      const retried = await fireOn(store, site.launch, {
        ...at,
        item: 'other',
        deliveryId: 'urgent-1',
        priority: true,
      });
      expect(retried.replay).toBe(true);
      expect(await store.getItemPriority(urgentId)).toBeNull();
      expect(await store.getItemRuns(site.projectKey, 'other')).toBeNull();
      await db.query("UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1", [
        holder.id,
      ]);
      expect(
        (await store.drainResourceStarts({ resource: 'ship', hostId: 'host' })).map(
          row => row.requestId
        )
      ).toEqual([ordinary.id]);
    } finally {
      await harness.close();
      await site.remove();
    }
  });

  test('a priority cleared after a fire was accepted stays cleared when the fire is prepared', async () => {
    const harness = await makeHarness();
    const site = await checkoutProject(harness.db);
    try {
      const { store } = harness;
      await store.setInstallHold({ setBy: 'operator' });
      const held = await fireOn(store, site.launch, {
        resource: 'held',
        capacity: 1,
        cwd: site.cwd,
        item: 'held-item',
        priority: true,
        prepare: false,
      });
      const heldId = await itemId(store, 'held-item', site.projectKey);
      expect(await store.getItemPriority(heldId)).toEqual({ own: true, inheritedFrom: [] });
      expect(
        await store.clearItemPriority({ projectKey: site.projectKey, key: 'held-item' })
      ).toEqual({
        priority: null,
      });
      await store.liftInstallHold();
      expect((await prepare(store, held.receiptId, site.launch())).status).toBe('admitted');
      expect(await store.getItemPriority(heldId)).toBeNull();
    } finally {
      await harness.close();
      await site.remove();
    }
  });
}
