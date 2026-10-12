// @archon-test-isolated
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  describeWorkflowStoreConformance,
  CONFORMANCE_CONVERSATION_ID,
  CONFORMANCE_CODEBASE_ID,
} from '@archon/workflows/store-conformance';
import { makeSqlConformanceHarness } from './workflow-store.conformance-harness';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';

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
