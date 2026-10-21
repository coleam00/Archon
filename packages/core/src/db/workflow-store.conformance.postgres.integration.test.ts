// @archon-test-isolated
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { resourceStartFixtures } from '@archon/workflows/store-conformance';
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
  test('foreign slot membership blocks guarded starts after its request is lost', async () => {
    const harness = await makeHarness();
    try {
      const { store, db } = harness;
      const { start } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
      const holder = { ...start('queue', 'host', 1), resource: 'foreign' };
      expect((await store.admitResourceStart(holder)).status).toBe('admitted');
      await db.query('DELETE FROM remote_agent_resource_start_requests WHERE id = $1', [
        holder.launch.run.id,
      ]);
      const guarded = start('queue', 'host', 1);
      expect(await store.admitResourceStart(guarded)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: holder.launch.run.id },
      });
      expect(
        await store.admitResourceStart({ ...start('skip', 'host', 1), resource: 'skip' })
      ).toMatchObject({
        status: 'skipped',
        blocker: { kind: 'run', id: holder.launch.run.id },
      });
      const reader = { ...start('queue', 'host', 1), resource: 'reader' };
      reader.launch.run.metadata.admission_checkout_guard = false;
      expect((await store.admitResourceStart(reader)).status).toBe('admitted');
      const privateStart = { ...start('queue', 'host', 1), resource: 'private' };
      privateStart.launch.execution.isolation = { kind: 'worktree' };
      expect((await store.admitResourceStart(privateStart)).status).toBe('admitted');
      expect(
        await store.drainResourceStarts({ resource: guarded.resource, hostId: 'host' })
      ).toEqual([]);
      expect((await store.getWorkflowRun(holder.launch.run.id))?.status).toBe('pending');
      await db.query("UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1", [
        holder.launch.run.id,
      ]);
      expect(
        await store.drainResourceStarts({ resource: guarded.resource, hostId: 'host' })
      ).toMatchObject([{ runId: guarded.launch.run.id }]);
    } finally {
      await harness.close();
    }
  });
  test.each(['missing', 'withdrawn'] as const)(
    'local slot membership refuses a %s request until terminal release',
    async damage => {
      const harness = await makeHarness();
      try {
        const { store, db } = harness;
        const { start } = resourceStartFixtures(
          CONFORMANCE_CODEBASE_ID,
          CONFORMANCE_CONVERSATION_ID
        );
        const holder = start('queue', 'host', 2);
        await store.admitResourceStart(holder);
        const waiting = start('queue', 'host', 2, { cwd: holder.launch.execution.cwd });
        expect(await store.admitResourceStart(waiting)).toMatchObject({ status: 'queued' });
        if (damage === 'missing')
          await db.query('DELETE FROM remote_agent_resource_start_requests WHERE id = $1', [
            holder.launch.run.id,
          ]);
        else
          await db.query(
            "UPDATE remote_agent_resource_start_requests SET status = 'withdrawn' WHERE id = $1",
            [holder.launch.run.id]
          );
        for (const guard of [false, true]) {
          const incoming = start('queue', 'host', 2);
          incoming.launch.run.metadata.admission_checkout_guard = guard;
          await expect(store.admitResourceStart(incoming)).rejects.toThrow(
            'no matching admitted request'
          );
        }
        await expect(
          store.drainResourceStarts({ resource: holder.resource, hostId: 'host' })
        ).rejects.toThrow('no matching admitted request');
        expect((await store.getWorkflowRun(holder.launch.run.id))?.status).toBe('pending');
        await db.query("UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1", [
          holder.launch.run.id,
        ]);
        expect(
          await store.drainResourceStarts({ resource: holder.resource, hostId: 'host' })
        ).toMatchObject([{ runId: waiting.launch.run.id }]);
      } finally {
        await harness.close();
      }
    }
  );
  for (const firstMode of ['admit', 'drain'] as const) {
    for (const secondMode of ['admit', 'drain'] as const) {
      test(`checkout reservations serialize across resources: ${firstMode}/${secondMode}`, async () => {
        const harness = await makeHarness();
        const { store, db } = harness;
        const { start } = resourceStartFixtures(
          CONFORMANCE_CODEBASE_ID,
          CONFORMANCE_CONVERSATION_ID
        );
        const first = start('queue', 'first', 2, { cwd: '/shared' });
        const second = { ...start('queue', 'second', 2, { cwd: '/shared' }), resource: 'other' };
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let firstOperation: Promise<unknown> | undefined;
        let secondOperation: Promise<unknown> | undefined;
        let interception: ReturnType<typeof spyOn> | undefined;
        try {
          const holder = await store.createWorkflowRun({
            ...first.launch.run,
            id: randomUUID(),
            working_path: '/shared',
          });
          for (const [mode, intent] of [
            [firstMode, first],
            [secondMode, second],
          ] as const)
            if (mode === 'drain')
              expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'queued' });
          await store.cancelWorkflowRun(holder.id);
          const transaction = db.withTransaction.bind(db);
          let intercepted = false;
          interception = spyOn(db, 'withTransaction').mockImplementation(callback =>
            transaction(query =>
              callback(async <T>(sql: string, params?: unknown[]) => {
                const result = await query<T>(sql, params);
                if (!intercepted && sql.includes('SELECT w.id, w.status, w.metadata')) {
                  intercepted = true;
                  entered.resolve();
                  await release.promise;
                }
                return result;
              })
            )
          );
          const perform = (mode: 'admit' | 'drain', intent: typeof first) =>
            mode === 'admit'
              ? store.admitResourceStart(intent)
              : store.drainResourceStarts({ resource: intent.resource, hostId: intent.hostId });
          firstOperation = perform(firstMode, first);
          await entered.promise;
          secondOperation = perform(secondMode, second);
          let blocked = false;
          for (let attempt = 0; attempt < 1000 && !blocked; attempt++) {
            const result = await db.query<{ blocked: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock') AS blocked`
            );
            blocked = result.rows[0]?.blocked ?? false;
          }
          expect(blocked).toBe(true);
          release.resolve();
          await Promise.all([firstOperation, secondOperation]);
          expect(await store.getResourceStartRequest(first.launch.run.id)).toMatchObject({
            status: 'admitted',
          });
          expect(await store.getResourceStartRequest(second.launch.run.id)).toMatchObject({
            status: 'queued',
          });
          expect(await store.getWorkflowRun(second.launch.run.id)).toBeNull();
          await store.cancelWorkflowRun(first.launch.run.id);
          expect(
            await store.drainResourceStarts({ resource: second.resource, hostId: second.hostId })
          ).toMatchObject([{ runId: second.launch.run.id }]);
        } finally {
          release.resolve();
          await Promise.allSettled([firstOperation, secondOperation]);
          interception?.mockRestore();
          await harness.close();
        }
      });
    }
  }

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
  test.each([false, true])(
    'paused suspension excludes a resume on another connection (resumed=%s)',
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
        await store.pauseWorkflowRun(run.id, {
          nodeId: 'gate',
          type: 'approval',
          message: 'Review',
        });
        releasing = store.withPausedExecution(run.id, executionClaim(run.metadata), async () => {
          entered.resolve();
          await finish.promise;
          order.push('stopped');
        });
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
        expect(await releasing).toEqual({ executed: true });
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
          cwd: `/conformance/${id}`,
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
