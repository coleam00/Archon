/**
 * Conformance for stopped items on the SQL stores, run by the SQLite and PostgreSQL
 * integration tests: a completed run that recorded a stop (`itemStoppedMetadata`) puts its
 * item in the attention queue as `stopped` while it is the item's last run, the item takes
 * no answer, and any later run on the item, whatever its status, takes it out.
 */
import { expect, test } from 'bun:test';
import { listAttentionQueue, readAttentionQueueItemByRef } from '@archon/workflows/attention-queue';
import { itemStoppedMetadata } from '@archon/workflows/schemas/run-metadata';
import { CONFORMANCE_CODEBASE_ID } from '@archon/workflows/store-conformance';
import { answerAttentionItem } from '../operations/attention-items';
import { itemDeps, operator, type Harness } from './item-asks.conformance';

/** Start a run of `workflow` on item `pr-7`, claimed so it is running. */
async function startOnItem(harness: Harness, workflow: string): Promise<string> {
  const run = await harness.store.createWorkflowRun({
    workflow_name: workflow,
    user_message: '',
    codebase_id: CONFORMANCE_CODEBASE_ID,
    item_key: 'pr-7',
  });
  await harness.store.claimPendingWorkflowRun(run.id);
  return run.id;
}

/**
 * Move a run's end into the past, as time passing would: SQLite keeps end times to the
 * second, so two ends in one test would otherwise tie and fall to the id.
 */
async function endedAt(harness: Harness, runId: string, at: string): Promise<void> {
  await harness.db.query('UPDATE remote_agent_workflow_runs SET completed_at = $2 WHERE id = $1', [
    runId,
    at,
  ]);
}

export function describeSqlItemStopConformance(makeHarness: () => Promise<Harness>): void {
  test('a run that stopped its item lists it as stopped until another run starts on it', async () => {
    const harness = await makeHarness();
    try {
      const deps = itemDeps(harness);
      const stopped = async () =>
        (await listAttentionQueue(deps.queue)).filter(
          item => 'kind' in item && item.kind === 'stopped'
        );

      // A completion that recorded no stop lists nothing.
      const landed = await startOnItem(harness, 'deliver');
      await harness.store.completeWorkflowRun(landed, { duration_ms: 1 }, undefined, {
        outcome: { kind: 'enum', value: 'landed' },
      });
      expect(await stopped()).toEqual([]);
      await endedAt(harness, landed, '2020-01-01 00:00:00');

      const ended = await startOnItem(harness, 'deliver');
      await harness.store.completeWorkflowRun(
        ended,
        { duration_ms: 1 },
        itemStoppedMetadata('The plan missed the schema change.'),
        { outcome: { kind: 'enum', value: 'replan' } }
      );
      const [item] = await stopped();
      expect(item).toMatchObject({
        kind: 'stopped',
        ref: `stopped:${ended}`,
        item: { key: 'pr-7' },
        stoppedIn: { runId: ended, workflow: 'deliver', outcome: 'replan' },
        summary: 'The plan missed the schema change.',
        pausedAt: expect.any(String),
      });
      if (item === undefined || !('ref' in item)) throw new Error('No stopped item');
      expect(
        await answerAttentionItem(deps, item.ref, { choose: ['replan'] }, operator, 'cli')
      ).toMatchObject({ kind: 'takes_no_answer' });

      // A later run on the item, still pending, takes it out; so does its end.
      const next = await harness.store.createWorkflowRun({
        workflow_name: 'plan',
        user_message: '',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        item_key: 'pr-7',
      });
      expect(await stopped()).toEqual([]);
      expect(await readAttentionQueueItemByRef(deps.queue, item.ref)).toEqual({ kind: 'none' });
      await endedAt(harness, ended, '2020-01-02 00:00:00');
      await harness.store.claimPendingWorkflowRun(next.id);
      await harness.store.failWorkflowRun(next.id, 'boom');
      expect(await stopped()).toEqual([]);
    } finally {
      await harness.close();
    }
  });
}
