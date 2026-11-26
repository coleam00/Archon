import { expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import {
  ItemRulingNotFoundError,
  ItemRulingOutsideProjectError,
  ItemRulingWithdrawnError,
} from '@archon/workflows/schemas/item-ruling';
import { dashboardRunsResultSchema } from '@archon/workflows/schemas/workflow-run-listing';
import { WorkflowStatusReadError } from './workflows';
import type { IDatabase, SqlDialect, QueryResult } from './adapters/types';
import type { WorkflowTerminalProperties } from '@archon/paths';
import {
  CONFORMANCE_CODEBASE_ID,
  resourceStartFixtures,
  CONFORMANCE_CONVERSATION_ID,
  type WorkflowStoreHarness,
} from '@archon/workflows/store-conformance';

const paths = await import('@archon/paths');
const reports: string[] = [];
mock.module('@archon/paths', () => ({
  ...paths,
  isTelemetryDisabled: (): boolean => false,
  captureWorkflowTerminal: (properties: WorkflowTerminalProperties): void => {
    if (properties.runId === undefined) throw new Error('Missing terminal run ID');
    reports.push(properties.runId);
  },
}));

let activeDb: IDatabase;
let dialect: SqlDialect;
let databaseType: 'sqlite' | 'postgresql';
mock.module('./connection', () => ({
  pool: {
    query: <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> =>
      activeDb.query<T>(sql, params),
  },
  getDatabase: (): IDatabase => activeDb,
  getDialect: (): SqlDialect => dialect,
  getDatabaseType: (): 'sqlite' | 'postgresql' => databaseType,
}));
const { createWorkflowStore } = await import('../workflows/store-adapter');

export async function makeSqlConformanceHarness(
  db: IDatabase,
  sql: SqlDialect,
  type: 'sqlite' | 'postgresql',
  close: () => Promise<void>
): Promise<WorkflowStoreHarness> {
  activeDb = db;
  dialect = sql;
  databaseType = type;
  reports.length = 0;
  await db.query(
    "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, 'conformance', '/conformance')",
    [CONFORMANCE_CODEBASE_ID]
  );
  await db.query(
    "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, 'test', 'conformance')",
    [CONFORMANCE_CONVERSATION_ID]
  );
  // The SQL stores read install capacities from `$ARCHON_HOME/config.yaml`.
  const capacities: Record<string, number> = {};
  let home: { root: string; previous: string | undefined } | undefined;
  return {
    store: createWorkflowStore(),
    setResourceCapacity: async (resource, capacity): Promise<void> => {
      home ??= {
        root: await mkdtemp(join(tmpdir(), 'archon-conformance-home-')),
        previous: process.env.ARCHON_HOME,
      };
      process.env.ARCHON_HOME = home.root;
      capacities[resource] = capacity;
      await writeFile(
        join(home.root, 'config.yaml'),
        JSON.stringify({ concurrency: { resources: capacities } })
      );
    },
    backdate: async (id, dates): Promise<void> => {
      for (const field of ['started_at', 'active_phase_started_at', 'last_activity_at'] as const) {
        const date = dates[field];
        if (date === undefined) continue;
        const value =
          date === null
            ? null
            : type === 'sqlite'
              ? date.toISOString().replace('T', ' ').replace('Z', '')
              : date.toISOString();
        await db.query(`UPDATE remote_agent_workflow_runs SET ${field} = $2 WHERE id = $1`, [
          id,
          value,
        ]);
      }
    },
    seedPersistedWait: async (id, wait): Promise<void> => {
      const write =
        type === 'postgresql'
          ? "jsonb_set(metadata, '{wait}', $2::jsonb, true)"
          : "json_set(metadata, '$.wait', json($2))";
      await db.query(`UPDATE remote_agent_workflow_runs SET metadata = ${write} WHERE id = $1`, [
        id,
        JSON.stringify(wait),
      ]);
    },
    terminalReports: (): string[] => [...reports],
    close: async (): Promise<void> => {
      if (home) {
        if (home.previous === undefined) delete process.env.ARCHON_HOME;
        else process.env.ARCHON_HOME = home.previous;
        await removeTempTree(home.root);
      }
      await close();
    },
  };
}

export function describeSqlStatusReadConformance(
  makeHarness: () => Promise<WorkflowStoreHarness & { db: IDatabase }>
): void {
  test.each(['direct', 'parent'] as const)(
    'partial status reads validate %s runs',
    async association => {
      const harness = await makeHarness();
      try {
        const { db, store } = harness;
        const { listConversationDetachBlockers } = await import('./workflow-run-reads');
        const { lockedRunRow } = await import('./workflow-run-shared');
        const run = await store.createWorkflowRun({
          workflow_name: 'partial-status-read',
          user_message: '',
          origin:
            association === 'direct'
              ? { conversationId: CONFORMANCE_CONVERSATION_ID }
              : { parentConversationId: CONFORMANCE_CONVERSATION_ID },
          metadata: { keep: 'value' },
        });
        const locked = (id: string) => db.withTransaction(query => lockedRunRow(query, id));
        const blockers = (id: string) =>
          db.withTransaction(query => listConversationDetachBlockers(query, id));
        const writes = (id: string) => [
          { write: () => store.setToolCallAttention(id, 'stream', []), unchanged: false },
          {
            write: () =>
              store.answerAttentionWait(id, {
                pauseId: 'ask',
                answer: { decision: 'proceed', text: '' },
                answeredVia: 'cli',
                answeredAt: '2026-01-01T00:05:00.000Z',
              }),
            unchanged: { answered: false },
          },
          {
            write: () =>
              store.labelAttentionWait(id, {
                pauseId: 'ask',
                set: { priority: 'high' },
                unset: [],
                via: 'cli',
              }),
            unchanged: { labeled: false as const },
          },
        ];
        const missing = randomUUID();
        expect(await locked(missing)).toBeUndefined();
        expect(await blockers(missing)).toEqual([]);
        for (const { write, unchanged } of writes(missing)) {
          expect(await write()).toEqual(unchanged);
        }
        expect(await locked(run.id)).toMatchObject({ status: 'pending' });
        expect(await blockers(CONFORMANCE_CONVERSATION_ID)).toEqual([
          { id: run.id, status: 'pending' },
        ]);
        const status = 'unexpected';
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          status,
          run.id,
        ]);
        for (const read of [
          () => locked(run.id),
          () => blockers(CONFORMANCE_CONVERSATION_ID),
          ...writes(run.id).map(({ write }) => write),
        ]) {
          const result = read();
          await expect(result).rejects.toBeInstanceOf(WorkflowStatusReadError);
          await expect(result).rejects.toMatchObject({
            workflowRunId: run.id,
            storedStatus: status,
            message: `Unsupported workflow run status for run ${run.id}: ${JSON.stringify(status)}`,
          });
        }
      } finally {
        await harness.close();
      }
    }
  );
  test('full-row reads validate statuses without lifecycle writes or partial lists', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const { getWorkflowRun } = await import('./workflow-run-reads');
      const { listWorkflowRuns, listDashboardRuns } = await import('./workflow-run-lists');
      expect(await getWorkflowRun(randomUUID())).toBeNull();
      expect(await store.getWorkflowRun(randomUUID())).toBeNull();
      expect(await listWorkflowRuns()).toEqual([]);
      expect((await store.listWorkflowRuns()).runs).toEqual([]);
      await store.createWorkflowRun({ workflow_name: 'healthy', user_message: '' });
      const run = await store.createWorkflowRun({ workflow_name: 'status-read', user_message: '' });
      for (const status of workflowRunStatusSchema.options) {
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          status,
          run.id,
        ]);
        expect((await getWorkflowRun(run.id))?.status).toBe(status);
        expect((await store.getWorkflowRun(run.id))?.status).toBe(status);
        expect((await listWorkflowRuns()).find(row => row.id === run.id)?.status).toBe(status);
        const dashboard = await store.listWorkflowRuns();
        expect(dashboard.runs.find(row => row.id === run.id)?.status).toBe(status);
        expect(dashboardRunsResultSchema.shape.counts.parse(dashboard.counts)).toEqual(
          dashboard.counts
        );
        expect(dashboard.counts.all).toBe(2);
        for (const value of workflowRunStatusSchema.options) {
          expect(dashboard.counts[value]).toBe(
            Number(value === 'pending') + Number(value === status)
          );
        }
      }
      for (const status of ['unexpected', '']) {
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          status,
          run.id,
        ]);
        const snapshot = async () => ({
          rows: (await db.query('SELECT * FROM remote_agent_workflow_runs ORDER BY id')).rows,
          events: await store.listWorkflowEvents(run.id),
          head: await store.getWorkflowEventHead(),
          reports: harness.terminalReports(),
        });
        const before = await snapshot();
        for (const read of [
          () => getWorkflowRun(run.id),
          () => store.getWorkflowRun(run.id),
          () => listWorkflowRuns(),
          () => store.listWorkflowRuns(),
          () => listDashboardRuns({ limit: 0 }),
          () => listDashboardRuns({ status: 'pending' }),
        ]) {
          const result = read();
          await expect(result).rejects.toBeInstanceOf(WorkflowStatusReadError);
          await expect(result).rejects.toMatchObject({
            workflowRunId: run.id,
            storedStatus: status,
            message: `Unsupported workflow run status for run ${run.id}: ${JSON.stringify(status)}`,
          });
        }
        expect(await snapshot()).toEqual(before);
      }
    } finally {
      await harness.close();
    }
  });
  test.each(['runStatus', 'blockerRunStatus'] as const)(
    'resource-start inspection validates %s without lifecycle writes',
    async field => {
      const harness = await makeHarness();
      try {
        const { db, store } = harness;
        const { start } = resourceStartFixtures(
          CONFORMANCE_CODEBASE_ID,
          CONFORMANCE_CONVERSATION_ID
        );
        const owner = start();
        const waiting = start();
        await store.admitResourceStart(owner);
        await store.admitResourceStart(waiting);
        const requestId = waiting.launch.run.id;
        const runId = field === 'runStatus' ? requestId : owner.launch.run.id;
        const otherField = field === 'runStatus' ? 'blockerRunStatus' : 'runStatus';
        const otherStatus = field === 'runStatus' ? 'pending' : null;
        if (field === 'blockerRunStatus') {
          await db.query(
            'UPDATE remote_agent_resource_start_requests SET blocker_run_id = $1 WHERE id = $2',
            [randomUUID(), requestId]
          );
        }
        expect(await store.getResourceStartRequest(randomUUID())).toBeNull();
        expect(await store.getResourceStartRequest(requestId)).toMatchObject({
          [field]: null,
          [otherField]: otherStatus,
        });
        expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
          { id: requestId, [field]: null, [otherField]: otherStatus },
        ]);
        if (field === 'runStatus') await store.createWorkflowRun(waiting.launch.run);
        else
          await db.query(
            'UPDATE remote_agent_resource_start_requests SET blocker_run_id = $1 WHERE id = $2',
            [runId, requestId]
          );

        const snapshot = async () => ({
          runs: (await db.query('SELECT * FROM remote_agent_workflow_runs ORDER BY id')).rows,
          requests: (
            await db.query('SELECT * FROM remote_agent_resource_start_requests ORDER BY id')
          ).rows,
          holders: (
            await db.query(
              'SELECT * FROM remote_agent_resource_slot_holders ORDER BY resource_key, holder_id'
            )
          ).rows,
          events: await store.listWorkflowEvents(runId),
          head: await store.getWorkflowEventHead(),
          reports: harness.terminalReports(),
        });
        for (const status of [...workflowRunStatusSchema.options, 'unexpected', '']) {
          await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
            status,
            runId,
          ]);
          const before = await snapshot();
          if (workflowRunStatusSchema.safeParse(status).success) {
            expect(await store.getResourceStartRequest(requestId)).toMatchObject({
              [field]: status,
              [otherField]: otherStatus,
            });
            expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
              { id: requestId, [field]: status, [otherField]: otherStatus },
            ]);
          } else {
            const message = `Unsupported workflow run status for run ${runId}: ${JSON.stringify(status)}`;
            const read = store.getResourceStartRequest(requestId);
            await expect(read).rejects.toBeInstanceOf(WorkflowStatusReadError);
            await expect(read).rejects.toMatchObject({
              workflowRunId: runId,
              storedStatus: status,
              message,
            });
            const queued = await store.listQueuedResourceStartsForHost('host');
            expect(queued).toHaveLength(1);
            expect(queued[0]).toMatchObject({
              id: requestId,
              error: { workflowRunId: runId, storedStatus: status, message },
            });
            if (!queued[0] || !('error' in queued[0])) throw new Error('Expected inspection error');
            expect(queued[0].error).toBeInstanceOf(WorkflowStatusReadError);
          }
          expect(await snapshot()).toEqual(before);
        }
      } finally {
        await harness.close();
      }
    }
  );
  test('status reads validate persisted values without lifecycle writes', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const run = await store.createWorkflowRun({ workflow_name: 'status-read', user_message: '' });
      expect(await store.getWorkflowRunStatus(randomUUID())).toBeNull();
      for (const status of workflowRunStatusSchema.options) {
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          status,
          run.id,
        ]);
        expect(await store.getWorkflowRunStatus(run.id)).toBe(status);
      }
      for (const status of ['unexpected', '']) {
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          status,
          run.id,
        ]);
        const snapshot = async () => ({
          rows: (await db.query('SELECT * FROM remote_agent_workflow_runs WHERE id = $1', [run.id]))
            .rows,
          events: await store.listWorkflowEvents(run.id),
          head: await store.getWorkflowEventHead(),
          reports: harness.terminalReports(),
        });
        const before = await snapshot();
        const read = store.getWorkflowRunStatus(run.id);
        await expect(read).rejects.toBeInstanceOf(WorkflowStatusReadError);
        await expect(read).rejects.toMatchObject({
          name: 'WorkflowStatusReadError',
          workflowRunId: run.id,
          storedStatus: status,
          message: `Unsupported workflow run status for run ${run.id}: ${JSON.stringify(status)}`,
        });
        expect(await snapshot()).toEqual(before);
      }
    } finally {
      await harness.close();
    }
  });
  test('an item is one row per project and key, and lists exactly its own runs in start order', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const otherProject = randomUUID();
      await db.query(
        "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, 'other', '/other')",
        [otherProject]
      );
      const run = (codebase_id: string | undefined, item_key?: string) =>
        store.createWorkflowRun({ workflow_name: 'item', user_message: '', codebase_id, item_key });
      const second = await run(CONFORMANCE_CODEBASE_ID, 'a');
      // A start names its item on the receipt; preparation resolves it onto the request.
      const { launch } = resourceStartFixtures(
        CONFORMANCE_CODEBASE_ID,
        CONFORMANCE_CONVERSATION_ID
      );
      const start = async (itemKey: string) => {
        const identity = { receiptId: randomUUID(), bindingId: 'binding', ownerId: 'owner' };
        await store.acceptStartReceipt({
          receipt: {
            id: identity.receiptId,
            sourceInstanceId: 'source',
            deliveryId: null,
            contentDigest: 'digest',
            receivedAt: new Date().toISOString(),
            occurredAt: null,
            sourceActor: null,
            itemKey,
          },
          outcome: 'matched',
          bindings: [
            {
              bindingId: identity.bindingId,
              bindingRevision: null,
              hostId: 'host',
              runAsUserId: 'operator',
              resource: 'resource',
              overlap: 'queue',
              launch: {
                cwd: '/c',
                workflowName: 'item',
                inputs: {},
                isolation: { kind: 'in-place' },
              },
            },
          ],
        });
        await store.claimStartBindingPreparation(identity);
        expect((await store.getStartReceipt(identity.receiptId))?.itemKey).toBe(itemKey);
        return store.completeStartBindingPreparation({ ...identity, launch: launch() });
      };
      const started = await start('a');
      if (started?.status !== 'admitted') throw new Error('Expected the start to be admitted');
      await harness.backdate(started.runId, { started_at: new Date('2026-01-01T00:00:00Z') });
      // A start waiting behind it has its item already, with no run yet.
      expect((await start('c'))?.status).toBe('queued');
      await run(CONFORMANCE_CODEBASE_ID, 'b');
      await run(otherProject, 'a');
      // A `workflow:` child of an item run carries no item and is left to `workflow get`.
      const child = await store.createWorkflowRun({
        workflow_name: 'item-child',
        user_message: '',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        parent_run_id: started.runId,
      });
      expect((await run(CONFORMANCE_CODEBASE_ID)).item_id).toBeNull();

      const project = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      const listed = await store.getItemRuns(project, 'a');
      expect(listed?.item).toMatchObject({ projectKey: project, key: 'a' });
      expect(listed?.runs.map(row => ('id' in row ? row.id : row))).toEqual([
        started.runId,
        second.id,
      ]);
      expect(listed?.descendantIds).toEqual([child.id]);
      expect(await store.getItem(second.item_id ?? '')).toEqual(listed?.item ?? null);
      expect(listed?.runs.every(row => 'item_id' in row && row.item_id === listed.item.id)).toBe(
        true
      );
      // An item with no run yet and a key nothing named read apart.
      const waiting = await store.getItemRuns(project, 'c');
      expect(waiting?.item).toMatchObject({ projectKey: project, key: 'c' });
      expect(waiting?.runs).toEqual([]);
      expect(await store.getItemRuns(project, 'never-named')).toBeNull();
      const items = await db.query<{ item: string }>(
        "SELECT key || ' in ' || project_key AS item FROM remote_agent_items"
      );
      expect(items.rows.map(row => row.item).sort()).toEqual([
        `a in ${project}`,
        `a in ${projectKeyForCodebase({ name: 'other', default_cwd: '/other' }, '')}`,
        `b in ${project}`,
        `c in ${project}`,
      ]);
      await expect(run(undefined, 'a')).rejects.toThrow();
    } finally {
      await harness.close();
    }
  });

  test("a binding's own item key puts only that binding's start on the item", async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const { launch } = resourceStartFixtures(
        CONFORMANCE_CODEBASE_ID,
        CONFORMANCE_CONVERSATION_ID
      );
      const binding = (bindingId: string, itemKey?: string) => ({
        bindingId,
        bindingRevision: null,
        hostId: 'host',
        runAsUserId: 'operator',
        resource: bindingId,
        overlap: 'skip' as const,
        launch: {
          cwd: '/c',
          workflowName: 'item',
          inputs: {},
          isolation: { kind: 'in-place' as const },
        },
        ...(itemKey === undefined ? {} : { itemKey }),
      });
      // Two deliveries about one subject, each also matching a binding that maps no item.
      const deliver = async () => {
        const receiptId = randomUUID();
        await store.acceptStartReceipt({
          receipt: {
            id: receiptId,
            sourceInstanceId: 'source',
            deliveryId: null,
            contentDigest: receiptId,
            receivedAt: new Date().toISOString(),
            occurredAt: null,
            sourceActor: null,
          },
          outcome: 'matched',
          bindings: [binding(`mapped-${receiptId}`, 'issue-7'), binding(`plain-${receiptId}`)],
        });
        const itemOf = async (bindingId: string) => {
          const identity = { receiptId, bindingId, ownerId: 'owner' };
          await store.claimStartBindingPreparation(identity);
          const started = await store.completeStartBindingPreparation({
            ...identity,
            launch: launch(),
          });
          if (started?.status !== 'admitted') throw new Error('Expected the start to be admitted');
          return (await store.getWorkflowRun(started.runId))?.item_id ?? null;
        };
        const inspected = await store.getStartReceipt(receiptId);
        expect(inspected?.bindings.map(b => b.intent?.itemKey)).toEqual(['issue-7', undefined]);
        return [await itemOf(`mapped-${receiptId}`), await itemOf(`plain-${receiptId}`)];
      };
      const [first, unmapped] = await deliver();
      // The first run must end, or it holds the item and the second start is refused.
      await db.query(
        "UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE item_id = $1",
        [first]
      );
      const [second] = await deliver();
      expect(first).not.toBeNull();
      expect(second).toBe(first);
      expect(unmapped).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('a queued request whose launch does not read is named, blocks those behind it, and can be withdrawn', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const inserted = await db.query<{ id: string }>(
        "INSERT INTO remote_agent_items (project_key, key) VALUES ('acme/web', 'k2') RETURNING id"
      );
      const k2 = inserted.rows[0]?.id ?? '';
      const { start } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
      const [holder, head, behind] = [start(), start(), start()];
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      expect(await store.admitResourceStart(head)).toMatchObject({ status: 'queued' });
      expect(await store.admitResourceStart(behind)).toMatchObject({ status: 'queued' });
      await db.query('UPDATE remote_agent_resource_start_requests SET item_id = $1 WHERE id = $2', [
        k2,
        behind.launch.run.id,
      ]);
      await db.query("UPDATE remote_agent_resource_start_requests SET launch = '{' WHERE id = $1", [
        head.launch.run.id,
      ]);

      expect(await store.listUnreadableQueuedStarts()).toEqual([
        expect.objectContaining({ requestId: head.launch.run.id, resource: 'resource', behind: 1 }),
      ]);
      expect(await store.listQueuedItemStarts(k2)).toEqual([
        expect.objectContaining({ requestId: behind.launch.run.id, blockedBy: head.launch.run.id }),
      ]);
      // Withdrawn although its launch does not read, so it holds the queue no longer.
      expect(await store.withdrawQueuedResourceStart(head.launch.run.id)).toEqual({ launch: null });
      expect(await store.listUnreadableQueuedStarts()).toEqual([]);
      expect(await store.listQueuedItemStarts(k2)).toEqual([
        expect.objectContaining({ requestId: behind.launch.run.id, blockedBy: null }),
      ]);
    } finally {
      await harness.close();
    }
  });

  test("an item's queued starts count only the same resource and host starts queued ahead of them", async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const itemId = async (key: string): Promise<string> => {
        const inserted = await db.query<{ id: string }>(
          "INSERT INTO remote_agent_items (project_key, key) VALUES ('acme/web', $1) RETURNING id",
          [key]
        );
        return inserted.rows[0]?.id ?? '';
      };
      const [x, k1, idle] = [await itemId('x'), await itemId('k1'), await itemId('idle')];
      const { start } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
      const holder = start();
      const before = start();
      const elsewhere = start('queue', 'other-host');
      const otherHolder = { ...start(), resource: 'other' };
      const otherResource = { ...start(), resource: 'other' };
      const waiting = start();
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      expect(await store.admitResourceStart(before)).toMatchObject({ status: 'queued' });
      expect(await store.admitResourceStart(elsewhere)).toMatchObject({ status: 'queued' });
      expect(await store.admitResourceStart(otherHolder)).toMatchObject({ status: 'admitted' });
      expect(await store.admitResourceStart(otherResource)).toMatchObject({ status: 'queued' });
      expect(await store.admitResourceStart(waiting)).toMatchObject({ status: 'queued' });
      // Preparation writes a start's item onto its request; these starts have no receipt.
      for (const [intent, item] of [
        [before, x],
        [waiting, k1],
      ] as const)
        await db.query(
          'UPDATE remote_agent_resource_start_requests SET item_id = $1 WHERE id = $2',
          [item, intent.launch.run.id]
        );

      // `before` is ahead on the same resource and host. `elsewhere` (another host) and
      // `otherResource` (another resource) queued earlier and are not counted.
      expect(await store.listQueuedItemStarts(k1)).toEqual([
        {
          requestId: waiting.launch.run.id,
          workflow: 'conformance',
          resource: 'resource',
          hostId: 'host',
          queuedAt: expect.stringMatching(/Z$/),
          ahead: 1,
          blockedBy: null,
        },
      ]);
      expect(await store.listQueuedItemStarts(idle)).toEqual([]);

      // Once admitted, a start has a run and leaves the list.
      await store.claimPendingWorkflowRun(holder.launch.run.id);
      await store.completeWorkflowRun(holder.launch.run.id, { duration_ms: 1 });
      await store.drainResourceStarts({ resource: 'resource', hostId: 'host' });
      expect(await store.listQueuedItemStarts(x)).toEqual([]);
      expect(await store.listQueuedItemStarts(k1)).toMatchObject([
        { requestId: waiting.launch.run.id, ahead: 0 },
      ]);
    } finally {
      await harness.close();
    }
  });

  test('an item read finds every run below the item, and reports the ones it cannot read', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const create = (fields: { item_key?: string; parent_run_id?: string }) =>
        store.createWorkflowRun({
          workflow_name: 'item',
          user_message: '',
          codebase_id: CONFORMANCE_CODEBASE_ID,
          ...fields,
        });
      const root = await create({ item_key: 'tree' });
      const broken = await create({ item_key: 'tree' });
      await harness.backdate(root.id, { started_at: new Date('2026-01-01T00:00:00Z') });
      await harness.backdate(broken.id, { started_at: new Date('2026-01-02T00:00:00Z') });
      const child = await create({ parent_run_id: root.id });
      const sibling = await create({ parent_run_id: root.id });
      const grandchild = await create({ parent_run_id: child.id });
      // An origin that does not normalize, on one of the item's runs and on a child.
      for (const id of [broken.id, child.id])
        await db.query('UPDATE remote_agent_workflow_runs SET origin = $1 WHERE id = $2', [
          '[]',
          id,
        ]);
      const project = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      const read = await store.getItemRuns(project, 'tree');
      expect(read?.runs.map(row => ('type' in row ? row : row.id))).toEqual([
        root.id,
        { type: 'degraded', reason: 'run_unreadable', runId: broken.id },
      ]);
      expect([...(read?.descendantIds ?? [])].sort()).toEqual(
        [child.id, sibling.id, grandchild.id].sort()
      );
    } finally {
      await harness.close();
    }
  });

  test('a ruling is recorded on an item with no run, withdrawn once, and kept', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const projectKey = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      const byCli = { via: 'cli', by: { declared: 'triage-agent' }, fromRun: null };
      // Nothing has named the key: the ruling writes the item, which has no run.
      const before = Date.now();
      const first = await store.recordItemRuling({
        projectKey,
        key: 'fresh',
        text: 'leave the chat readers for a follow-up',
        ...byCli,
      });
      const recordedAt = Date.parse(first.at);
      expect(recordedAt).toBeGreaterThanOrEqual(before);
      expect(recordedAt).toBeLessThanOrEqual(Date.now());
      expect(first).toMatchObject({
        kind: 'ruling',
        text: 'leave the chat readers for a follow-up',
        via: 'cli',
        by: { declared: 'triage-agent' },
        fromRun: null,
        withdrawn: null,
      });
      const item = await store.getItemRuns(projectKey, 'fresh');
      expect(item?.runs).toEqual([]);
      const second = await store.recordItemRuling({
        projectKey,
        key: 'fresh',
        text: 'do not accept an empty outcome',
        via: 'api',
        by: { userId: 'user-1' },
        fromRun: { runId: 'run-1', nodePath: 'review' },
      });

      // A withdrawal scoped to another project is refused and changes nothing.
      await expect(
        store.withdrawItemRuling({ rulingId: first.id, projectKey: 'other/project', ...byCli })
      ).rejects.toBeInstanceOf(ItemRulingOutsideProjectError);
      const withdrawn = await store.withdrawItemRuling({
        rulingId: first.id,
        projectKey,
        via: 'api',
        by: null,
        fromRun: null,
      });
      expect(withdrawn.withdrawn).toMatchObject({ via: 'api', by: null, fromRun: null });
      await expect(
        store.withdrawItemRuling({ rulingId: first.id, ...byCli })
      ).rejects.toBeInstanceOf(ItemRulingWithdrawnError);
      await expect(
        store.withdrawItemRuling({ rulingId: 'no-such-ruling', ...byCli })
      ).rejects.toBeInstanceOf(ItemRulingNotFoundError);
      // A withdrawal's own row is not a ruling to withdraw.
      const rows = await db.query<{ id: string }>(
        'SELECT id FROM remote_agent_item_rulings WHERE withdraws IS NOT NULL'
      );
      await expect(
        store.withdrawItemRuling({ rulingId: rows.rows[0]?.id ?? '', ...byCli })
      ).rejects.toBeInstanceOf(ItemRulingNotFoundError);

      // Both rulings stay, oldest first, and the first says it was withdrawn.
      const listed = await store.listItemRulings(item?.item.id ?? '');
      expect(listed).toEqual([withdrawn, second]);
      expect(listed[0]).toMatchObject({ at: first.at });
      expect(second).toMatchObject({
        by: { userId: 'user-1' },
        fromRun: { runId: 'run-1', nodePath: 'review' },
      });

      // A row that does not read is reported in its place.
      await db.query('UPDATE remote_agent_item_rulings SET via = $1 WHERE id = $2', [
        'Not A Surface',
        second.id,
      ]);
      expect(await store.listItemRulings(item?.item.id ?? '')).toEqual([
        withdrawn,
        { type: 'degraded', reason: 'ruling_unreadable', rulingId: second.id },
      ]);
    } finally {
      await harness.close();
    }
  });

  test('rulings that tie on time keep their recording order', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const projectKey = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      const act = { via: 'cli', by: null, fromRun: null } as const;
      const first = await store.recordItemRuling({ projectKey, key: 'tie', text: 'one', ...act });
      const second = await store.recordItemRuling({ projectKey, key: 'tie', text: 'two', ...act });
      // Same time, and ids that sort against recording order: neither may decide it.
      await db.query(
        'UPDATE remote_agent_item_rulings SET created_at = $1, id = $2 WHERE id = $3',
        [first.at, 'zzz-first', first.id]
      );
      await db.query(
        'UPDATE remote_agent_item_rulings SET created_at = $1, id = $2 WHERE id = $3',
        [first.at, 'aaa-second', second.id]
      );
      const item = await store.getItemRuns(projectKey, 'tie');
      const listed = await store.listItemRulings(item?.item.id ?? '');
      expect(listed.map(read => ('text' in read ? read.text : read))).toEqual(['one', 'two']);
    } finally {
      await harness.close();
    }
  });

  test('a window lists the items with an own run started in it, by id, after a cursor once', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const projectKey = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      const at = async (key: string, workflow: string, started: string, parent?: string) => {
        const run = await store.createWorkflowRun({
          workflow_name: workflow,
          user_message: '',
          codebase_id: CONFORMANCE_CODEBASE_ID,
          ...(parent ? { parent_run_id: parent } : { item_key: key }),
        });
        await harness.backdate(run.id, { started_at: new Date(started) });
        return run;
      };
      const a = await at('a', 'build', '2026-10-20T00:00:00Z');
      await at('a', 'review', '2026-11-02T00:00:00Z');
      // Only a `workflow:` child of b's run started in the window: b has no own run in it.
      const b = await at('b', 'build', '2026-10-05T00:00:00Z');
      await at('', 'review', '2026-11-05T00:00:00Z', b.id);
      await at('c', 'build', '2026-11-30T23:59:59Z');
      await at('d', 'review', '2026-12-01T00:00:00Z');
      const window = {
        projectKey,
        since: new Date('2026-11-01T00:00:00Z'),
        until: new Date('2026-12-01T00:00:00Z'),
      };
      const all = await store.listItemsInWindow({ ...window, afterItemId: null, limit: 10 });
      expect(all.map(item => item.key).sort()).toEqual(['a', 'c']);
      expect(all.map(item => item.id)).toEqual(all.map(item => item.id).sort());
      expect(all.find(item => item.key === 'a')?.id).toBe(a.item_id ?? '');
      const first = await store.listItemsInWindow({ ...window, afterItemId: null, limit: 1 });
      const after = first[0]?.id ?? '';
      const rest = await store.listItemsInWindow({ ...window, afterItemId: after, limit: 10 });
      expect([...first, ...rest]).toEqual(all);
      expect(
        await store.listItemsInWindow({
          ...window,
          projectKey: 'other',
          afterItemId: null,
          limit: 10,
        })
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test("an item's merge is recorded once, never creates an item, and reads back", async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const projectKey = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      const report = {
        projectKey,
        key: 'merged',
        change: 'https://github.com/acme/web/pull/1',
        commit: 'a'.repeat(40),
        at: '2026-11-02T10:00:00+02:00',
        via: 'cli',
        fromRun: { runId: 'run-1', nodePath: 'record' },
      };
      expect(await store.recordItemMerge(report)).toBeNull();
      expect(await store.getItemRuns(projectKey, 'merged')).toBeNull();
      await store.createWorkflowRun({
        workflow_name: 'build',
        user_message: '',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        item_key: 'merged',
      });
      const first = await store.recordItemMerge(report);
      expect(first).toMatchObject({
        recorded: true,
        merge: {
          change: report.change,
          commit: report.commit,
          at: '2026-11-02T08:00:00.000Z',
          via: 'cli',
          fromRun: report.fromRun,
        },
      });
      const again = await store.recordItemMerge({ ...report, change: 'other', commit: null });
      expect(again).toEqual(first && { merge: first.merge, recorded: false });
      const item = await store.getItemRuns(projectKey, 'merged');
      expect(await store.getItemMerge(item?.item.id ?? '')).toEqual(first?.merge ?? null);
    } finally {
      await harness.close();
    }
  });

  test('a continuation belongs to the item of the run it continues unless it names its own', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const otherProject = randomUUID();
      await db.query(
        "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, 'other', '/other')",
        [otherProject]
      );
      const run = (
        input: { item_key?: string; adopted_from_run_id?: string },
        codebase_id = CONFORMANCE_CODEBASE_ID
      ) =>
        store.createWorkflowRun({ workflow_name: 'item', user_message: '', codebase_id, ...input });
      const first = await run({ item_key: 'a' });
      const round = await run({ adopted_from_run_id: first.id });
      expect(round.item_id).toBe(first.item_id);
      // A continuation of a continuation is still the same item.
      expect((await run({ adopted_from_run_id: round.id })).item_id).toBe(first.item_id);

      const renamed = await run({ adopted_from_run_id: first.id, item_key: 'b' });
      expect(await store.getItem(renamed.item_id ?? '')).toMatchObject({ key: 'b' });

      const bare = await run({});
      expect((await run({ adopted_from_run_id: bare.id })).item_id).toBeNull();

      // The item belongs to one project: another project's continuation must name its own.
      await expect(run({ adopted_from_run_id: first.id }, otherProject)).rejects.toThrow();
      const named = await run({ adopted_from_run_id: first.id, item_key: 'a' }, otherProject);
      expect(named.item_id).not.toBe(first.item_id);
      // With no project to compare, a continuation of a run on an item is refused; one of
      // a run with no item starts as it always did.
      const unregistered = (adopted_from_run_id: string) =>
        store.createWorkflowRun({ workflow_name: 'item', user_message: '', adopted_from_run_id });
      await expect(unregistered(first.id)).rejects.toThrow();
      expect((await unregistered(bare.id)).item_id).toBeNull();
      const runs = await db.query<{ id: string }>('SELECT id FROM remote_agent_workflow_runs');
      expect(runs.rows).toHaveLength(8);
    } finally {
      await harness.close();
    }
  });
}
