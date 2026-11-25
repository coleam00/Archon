/**
 * Conformance for stopped items on the SQL stores, run by the SQLite and PostgreSQL
 * integration tests: a completed run that recorded a stop (`itemStoppedMetadata`) puts its
 * item in the attention queue as `stopped` while it is the item's last run, the item takes
 * no answer, and any later run on the item, whatever its status, takes it out, even once
 * that run is deleted. The runs
 * follow each other at once, as fast stages do, so on SQLite they share one second.
 */
import { expect, test } from 'bun:test';
import { listAttentionQueue, readAttentionQueueItemByRef } from '@archon/workflows/attention-queue';
import { itemStoppedMetadata } from '@archon/workflows/schemas/run-metadata';
import { CONFORMANCE_CODEBASE_ID } from '@archon/workflows/store-conformance';
import { answerAttentionItem } from '../operations/attention-items';
import { itemDeps, operator, type Harness } from './item-asks.conformance';

/** Create a run of `workflow` on item `pr-7`. */
async function createOnItem(harness: Harness, workflow: string): Promise<string> {
  const run = await harness.store.createWorkflowRun({
    workflow_name: workflow,
    user_message: '',
    codebase_id: CONFORMANCE_CODEBASE_ID,
    item_key: 'pr-7',
  });
  return run.id;
}

/** Run `workflow` on item `pr-7` to completion with `outcome`, recording a stop when `stop`. */
async function completeOnItem(
  harness: Harness,
  workflow: string,
  outcome: string,
  stop?: string
): Promise<string> {
  const id = await createOnItem(harness, workflow);
  await harness.store.claimPendingWorkflowRun(id);
  await harness.store.completeWorkflowRun(
    id,
    { duration_ms: 1 },
    stop === undefined ? undefined : itemStoppedMetadata(stop),
    { outcome: { kind: 'enum', value: outcome } }
  );
  return id;
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

      // A completion that recorded no stop lists nothing, and an older run does not hide a stop.
      await completeOnItem(harness, 'deliver', 'landed');
      expect(await stopped()).toEqual([]);
      const ended = await completeOnItem(
        harness,
        'deliver',
        'replan',
        'The plan missed the schema change.'
      );
      const [item] = await stopped();
      expect(item).toMatchObject({
        kind: 'stopped',
        ref: `stopped:${ended}`,
        item: { key: 'pr-7' },
        stoppedIn: { runId: ended, workflow: 'deliver', outcome: 'replan' },
        summary: 'The plan missed the schema change.',
        checkout: '/conformance',
        pausedAt: expect.any(String),
      });
      if (item === undefined || !('ref' in item)) throw new Error('No stopped item');
      expect(
        await answerAttentionItem(deps, item.ref, { choose: ['replan'] }, operator, 'cli')
      ).toMatchObject({ kind: 'takes_no_answer' });

      // A later run on the item, still pending, takes it out; so does its end.
      const next = await createOnItem(harness, 'plan');
      expect(await stopped()).toEqual([]);
      expect(await readAttentionQueueItemByRef(deps.queue, item.ref)).toEqual({ kind: 'none' });
      await harness.store.claimPendingWorkflowRun(next);
      await harness.store.completeWorkflowRun(next, { duration_ms: 1 }, undefined, {
        outcome: { kind: 'enum', value: 'landed' },
      });
      expect(await stopped()).toEqual([]);

      // Deleting the run that moved the item on does not bring the stop back.
      const { deleteWorkflowRun } = await import('./workflow-run-writes');
      await deleteWorkflowRun(next);
      expect(await stopped()).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test('of two stops on an item only the later run is listed', async () => {
    const harness = await makeHarness();
    try {
      const deps = itemDeps(harness);
      // Repeated so a tie broken by random ids would show; insertion order breaks it truly.
      for (let round = 0; round < 5; round++) {
        await completeOnItem(harness, 'deliver', 'replan', 'first');
        const later = await completeOnItem(harness, 'review', 'blocked', 'second');
        const listed = (await listAttentionQueue(deps.queue)).filter(
          item => 'kind' in item && item.kind === 'stopped'
        );
        expect(listed).toMatchObject([{ stoppedIn: { runId: later }, summary: 'second' }]);
      }
    } finally {
      await harness.close();
    }
  });
}
