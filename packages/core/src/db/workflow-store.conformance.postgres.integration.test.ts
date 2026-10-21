// @archon-test-isolated
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { executionClaim } from '@archon/workflows/store';
import {
  describeWorkflowStoreConformance,
  CONFORMANCE_CONVERSATION_ID,
  CONFORMANCE_CODEBASE_ID,
} from '@archon/workflows/store-conformance';
import {
  makeSqlConformanceHarness,
  describeSqlStatusReadConformance,
} from './workflow-store.conformance-harness';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';
import { getSchemaSQL } from './bundled-schema';

const baseUrl = process.env.ARCHON_TEST_PG_URL;
describe.skipIf(!baseUrl)('scratch PostgreSQL', () => {
  let admin: Pool;
  beforeAll(() => {
    admin = new Pool({ connectionString: baseUrl });
  });
  afterAll(async () => {
    await admin?.end();
  });
  const makeHarness = async () => {
    const name = `archon_conformance_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(baseUrl!);
    url.pathname = `/${name}`;
    const db = new PostgresAdapter(url.toString());
    const close = async () => {
      try {
        await db.close();
      } finally {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
    };
    try {
      const harness = await makeSqlConformanceHarness(db, postgresDialect, 'postgresql', close);
      return { ...harness, db };
    } catch (error) {
      await close();
      throw error;
    }
  };
  describeWorkflowStoreConformance('PostgreSQL', makeHarness);

  describeSqlStatusReadConformance(makeHarness);
  test.each([false, true])(
    'source suspension excludes a resume on another connection (resumed=%s)',
    async resumed => {
      const harness = await makeHarness();
      const { store, db } = harness;
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let releasing: Promise<unknown> | undefined;
      let resuming: Promise<unknown> | undefined;
      try {
        let run = await store.createWorkflowRun({ workflow_name: 'source-lock', user_message: '' });
        await store.claimPendingWorkflowRun(run.id);
        if (resumed) {
          await store.pauseWorkflowRun(run.id, {
            nodeId: 'gate',
            type: 'approval',
            message: 'Review',
          });
          run = await store.resumeWorkflowRun(run.id);
        }
        const order: string[] = [];
        releasing = store.releaseRunForUnreadableSource(
          run.id,
          {
            claimId: executionClaim(run.metadata),
            nodeId: 'source',
            error: 'EACCES',
            retryAt: new Date().toISOString(),
          },
          async () => {
            entered.resolve();
            await finish.promise;
            order.push('stopped');
          }
        );
        await entered.promise;
        resuming = store.resumeWorkflowRun(run.id).then(next => {
          order.push('resumed');
          return next;
        });
        // Observe the real row-lock waiter before allowing Docker to finish.
        let blocked = false;
        for (let attempt = 0; attempt < 1000 && !blocked; attempt++) {
          const result = await db.query<{ blocked: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock') AS blocked`
          );
          blocked = result.rows[0]?.blocked ?? false;
        }
        expect(blocked).toBe(true);
        expect(order).toEqual([]);
        finish.resolve();
        expect(await releasing).toEqual({ released: true });
        expect(await resuming).toMatchObject({ status: 'running' });
        expect(order).toEqual(['stopped', 'resumed']);
      } finally {
        finish.resolve();
        await Promise.allSettled([releasing, resuming]);
        await harness.close();
      }
    }
  );
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
  test('an event removed before commit retains final commit order in the archive', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const run = await store.createWorkflowRun({
        workflow_name: 'removed-before-commit',
        user_message: '',
      });
      const id = randomUUID();
      let head = await store.getWorkflowEventHead();
      await db.withTransaction(async query => {
        await query(
          "INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type) VALUES ($1, $2, 'workflow_started')",
          [id, run.id]
        );
        await query('DELETE FROM remote_agent_workflow_events WHERE id = $1', [id]);
        await store.persistWorkflowEvent({
          workflow_run_id: run.id,
          event_type: 'workflow_started',
        });
        head = await store.getWorkflowEventHead();
      });
      expect(
        (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event.id)
      ).toEqual([id]);
    } finally {
      await harness.close();
    }
  });
  test('archives deleted events after the events table gains a column', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      await db.query('ALTER TABLE remote_agent_workflow_events ADD COLUMN later_column TEXT');
      await db.query(getSchemaSQL());
      const run = await store.createWorkflowRun({
        workflow_name: 'later-column',
        user_message: '',
      });
      const id = randomUUID();
      await db.query(
        "INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, later_column) VALUES ($1, $2, 'workflow_started', 'kept')",
        [id, run.id]
      );
      await db.query('DELETE FROM remote_agent_workflow_events WHERE id = $1', [id]);
      expect(
        (
          await db.query(
            'SELECT later_column FROM remote_agent_workflow_event_archive WHERE id = $1',
            [id]
          )
        ).rows
      ).toEqual([{ later_column: 'kept' }]);
    } finally {
      await harness.close();
    }
  });
  test("the head includes events ordered by the previous binary's trigger", async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      await db.query(`CREATE OR REPLACE FUNCTION archon_assign_workflow_event_order() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(3334);
          UPDATE remote_agent_workflow_events
            SET event_order = nextval('remote_agent_workflow_events_event_order_seq') WHERE id = NEW.id;
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql`);
      const run = await store.createWorkflowRun({ workflow_name: 'old-writer', user_message: '' });
      await store.persistWorkflowEvent({ workflow_run_id: run.id, event_type: 'workflow_started' });
      const head = await store.getWorkflowEventHead();
      expect((await store.readWorkflowEventsAfter(head, { limit: 1 })).events).toEqual([]);
      await store.persistWorkflowEvent({ workflow_run_id: run.id, event_type: 'workflow_started' });
      expect((await store.readWorkflowEventsAfter(head, { limit: 1 })).events).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
  test('trigger admission preserves atomic run/request/holder writes and origin-free claims', async () => {
    const harness = await makeHarness();
    const { store, db } = harness;
    try {
      const launch = (id: string) => ({
        version: 2 as const,
        run: {
          id,
          workflow_name: 'trigger',
          codebase_id: CONFORMANCE_CODEBASE_ID,
          user_message: '',
          metadata: {},
        },
        execution: {
          cwd: '/conformance',
          conversationId: id,
          isolation: { kind: 'in-place' as const },
        },
      });
      const first = randomUUID(),
        second = randomUUID(),
        rejected = randomUUID();
      const intent = (id: string) => ({
        resource: 'trigger',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue' as const,
        launch: launch(id),
      });
      const decisions = await Promise.all([
        store.admitResourceStart(intent(first)),
        store.admitResourceStart(intent(second)),
      ]);
      expect(decisions.map(item => item.status).sort()).toEqual(['admitted', 'queued']);
      const admitted = decisions.find(item => item.status === 'admitted');
      if (!admitted) throw new Error('Expected one admitted request');
      const winner = admitted.requestId;
      const queued = winner === first ? second : first;
      expect(await store.getWorkflowRun(winner)).toMatchObject({
        status: 'pending',
        origin: null,
        conversation_id: null,
      });
      expect(await store.getWorkflowRun(queued)).toBeNull();
      expect(
        (
          await db.query(
            'SELECT holder_id FROM remote_agent_resource_slot_holders WHERE resource_key = $1',
            ['trigger']
          )
        ).rows
      ).toEqual([{ holder_id: winner }]);
      const claims = await Promise.all([
        store.claimPendingWorkflowRun(winner),
        store.claimPendingWorkflowRun(winner),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      await store.completeWorkflowRun(winner, { duration_ms: 1 });
      expect(await store.drainResourceStarts({ resource: 'trigger', hostId: 'host' })).toEqual([
        { status: 'admitted', requestId: queued, runId: queued },
      ]);
      await db.query(
        `ALTER TABLE remote_agent_workflow_runs ADD CONSTRAINT reject_trigger_run CHECK (id <> '${rejected}') NOT VALID`
      );
      await expect(
        store.admitResourceStart({ ...intent(rejected), resource: 'rollback' })
      ).rejects.toThrow();
      expect(await store.getResourceStartRequest(rejected)).toBeNull();
      expect(await store.getWorkflowRun(rejected)).toBeNull();
      expect(
        (
          await db.query('SELECT * FROM remote_agent_resource_slots WHERE resource_key = $1', [
            'rollback',
          ])
        ).rows
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  });
  test('conversation reset rolls back all rows and events when a terminal insert fails', async () => {
    const harness = await makeHarness();
    const { store, db } = harness;
    try {
      const paused = await store.createWorkflowRun({
        workflow_name: 'reset',
        user_message: 'test',
        origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
      });
      await store.claimPendingWorkflowRun(paused.id);
      await store.pauseWorkflowRun(paused.id, {
        nodeId: 'review',
        message: 'Choose',
        type: 'approval',
        pauseId: 'first',
      });
      const failed = await store.createWorkflowRun({
        workflow_name: 'reset',
        user_message: 'test',
        origin: { parentConversationId: CONFORMANCE_CONVERSATION_ID },
      });
      await store.failWorkflowRun(failed.id, 'failed');
      const ids = [paused.id, failed.id];
      const before = await Promise.all(ids.map(id => store.getWorkflowRun(id)));
      const events = await Promise.all(ids.map(id => store.listWorkflowEvents(id)));
      const reports = harness.terminalReports();
      // Only the terminal INSERT fails; its preceding row update and projection reads succeed.
      await db.query(`ALTER TABLE remote_agent_workflow_events
        ADD CONSTRAINT reject_cancellation CHECK (event_type <> 'workflow_cancelled') NOT VALID`);
      await expect(
        store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID)
      ).rejects.toThrow('Failed to cancel resumable runs for conversation');
      expect(await Promise.all(ids.map(id => store.getWorkflowRun(id)))).toEqual(before);
      expect(await Promise.all(ids.map(id => store.listWorkflowEvents(id)))).toEqual(events);
      expect(harness.terminalReports()).toEqual(reports);
    } finally {
      await harness.close();
    }
  });
});
