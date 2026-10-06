import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  describeWorkflowStoreConformance,
  CONFORMANCE_CONVERSATION_ID,
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
