/**
 * Conformance for stopped items on the SQL stores, run by the SQLite and PostgreSQL
 * integration tests: a completed run that recorded a stop (`itemStoppedMetadata`) puts its
 * item in the attention queue as `stopped` while it is the item's last run, the item takes
 * no answer, and any later run on the item, whatever its status, takes it out, as does a
 * merge recorded on the item. The runs follow each other at once, as fast stages do, so on
 * SQLite they share one second.
 */
import { expect, test } from 'bun:test';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import { listAttentionQueue, readAttentionQueueItemByRef } from '@archon/workflows/attention-queue';
import { itemStoppedMetadata } from '@archon/workflows/schemas/run-metadata';
import { CONFORMANCE_CODEBASE_ID } from '@archon/workflows/store-conformance';
import { answerAttentionItem } from '../operations/attention-items';
import { itemDeps, operator, type Harness } from './item-asks.conformance';

/** Create a run of `workflow` on item `key`. */
async function createOnItem(harness: Harness, workflow: string, key = 'pr-7'): Promise<string> {
  const run = await harness.store.createWorkflowRun({
    workflow_name: workflow,
    user_message: '',
    codebase_id: CONFORMANCE_CODEBASE_ID,
    item_key: key,
  });
  return run.id;
}

/** Fail a new run of `workflow` on item `key`. */
async function failOnItem(harness: Harness, workflow: string, key = 'pr-7'): Promise<string> {
  const id = await createOnItem(harness, workflow, key);
  await harness.store.claimPendingWorkflowRun(id);
  await harness.store.failWorkflowRun(id, 'the queue run failed');
  return id;
}

/** Run `workflow` on item `key` to completion with `outcome`, recording a stop when `stop`. */
async function completeOnItem(
  harness: Harness,
  workflow: string,
  outcome: string,
  stop?: string,
  key = 'pr-7'
): Promise<string> {
  const id = await createOnItem(harness, workflow, key);
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
    } finally {
      await harness.close();
    }
  });

  test('deleting the run that moved an item on keeps its earlier stop closed', async () => {
    const harness = await makeHarness();
    try {
      const deps = itemDeps(harness);
      const stopped = async () =>
        (await listAttentionQueue(deps.queue)).filter(
          item => 'kind' in item && item.kind === 'stopped'
        );
      const stop = await completeOnItem(harness, 'deliver', 'replan', 'The plan missed it.');
      const later = await completeOnItem(harness, 'plan', 'landed');
      expect(await stopped()).toEqual([]);
      const { deleteWorkflowRun } = await import('./workflow-run-writes');
      await deleteWorkflowRun(later);
      expect(await stopped()).toEqual([]);
      // Nothing about the stop was erased: its run still records it.
      expect((await harness.store.getWorkflowRun(stop))?.metadata).toHaveProperty('item_stopped');
    } finally {
      await harness.close();
    }
  });

  test('a failed run that is the newest on its item is listed as stopped with why it failed', async () => {
    const harness = await makeHarness();
    try {
      const deps = itemDeps(harness);
      const stopped = async () =>
        (await listAttentionQueue(deps.queue)).filter(
          item => 'kind' in item && item.kind === 'stopped'
        );
      const failed = await createOnItem(harness, 'check');
      await harness.store.claimPendingWorkflowRun(failed);
      await harness.store.failWorkflowRun(failed, 'no pr input given');
      expect(await stopped()).toMatchObject([
        {
          ref: `stopped:${failed}`,
          item: { key: 'pr-7' },
          stoppedIn: { runId: failed, workflow: 'check', outcome: null },
          failed: { error: 'no pr input given' },
          summary: null,
        },
      ]);

      // Any later run on the item closes it, as its restart does.
      await createOnItem(harness, 'check');
      expect(await stopped()).toEqual([]);

      // A cancelled run is an operator's decision, and a failed run with a scheduled resume
      // moves on by itself: neither is listed.
      const cancelled = await createOnItem(harness, 'check');
      await harness.store.cancelWorkflowRun(cancelled);
      expect(await stopped()).toEqual([]);
      const scheduled = await createOnItem(harness, 'check');
      await harness.store.claimPendingWorkflowRun(scheduled);
      await harness.store.failWorkflowRun(scheduled, 'usage limit');
      await harness.store.updateWorkflowRun(scheduled, {
        metadata: { scheduled_resume: { resumeAt: new Date(Date.now() + 60_000).toISOString() } },
      });
      expect(await stopped()).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test('a refused start is listed beside an open wait; a stop with nothing refused waits for it', async () => {
    const harness = await makeHarness();
    try {
      const deps = itemDeps(harness);
      const stopped = async () =>
        (await listAttentionQueue(deps.queue)).filter(
          item => 'kind' in item && item.kind === 'stopped'
        );
      const wait = { event: 'checks', about: 'a'.repeat(40), within_minutes: 60 };
      const leaving = async (stop: Record<string, unknown>) => {
        const id = await createOnItem(harness, 'host');
        await harness.store.claimPendingWorkflowRun(id);
        await harness.store.completeWorkflowRun(id, { duration_ms: 1 }, stop, { waits: [wait] });
        return id;
      };
      // A stop that names no refused start waits for its run's open wait to close.
      await leaving(itemStoppedMetadata('waiting'));
      expect(await stopped()).toEqual([]);
      // A refused start beside the wait would show nowhere else, so it is listed now.
      const refused = {
        receiptId: crypto.randomUUID(),
        bindingId: 'land',
        workflow: 'land',
        reason: 'no_default_provider' as const,
        refusedAt: new Date().toISOString(),
      };
      const run = await leaving(itemStoppedMetadata(null, { refused: [refused] }));
      expect(await stopped()).toEqual([
        expect.objectContaining({
          stoppedIn: expect.objectContaining({ runId: run }),
          refused: [refused],
        }),
      ]);
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

  test('a merged item is not listed as stopped, whether its newest run came before or after the merge', async () => {
    const harness = await makeHarness();
    try {
      const deps = itemDeps(harness);
      const stopped = async () =>
        (await listAttentionQueue(deps.queue)).filter(
          item => 'kind' in item && item.kind === 'stopped'
        );
      const projectKey = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      // pr-7 merges at 08:00Z; its first run failed before that, the later ones run now.
      const failed = await failOnItem(harness, 'build');
      await harness.db.query(
        'UPDATE remote_agent_workflow_runs SET started_at = $2, completed_at = $3 WHERE id = $1',
        [failed, '2026-11-17T06:00:00.000Z', '2026-11-17T07:00:00.000Z']
      );
      // pr-8 never merges and stops the same way, so it stays listed throughout.
      await failOnItem(harness, 'build', 'pr-8');
      const unmerged = await completeOnItem(harness, 'deliver', 'replan', 'Not yet.', 'pr-8');
      expect(await stopped()).toHaveLength(2);

      expect(
        await harness.store.recordItemMerge({
          projectKey,
          key: 'pr-7',
          change: 'https://example.test/pull/1',
          commit: null,
          at: '2026-11-17T10:00:00+02:00',
          via: 'cli',
          fromRun: null,
        })
      ).toMatchObject({ recorded: true });
      const onlyUnmerged = [{ item: { key: 'pr-8' }, stoppedIn: { runId: unmerged } }];
      expect(await stopped()).toMatchObject(onlyUnmerged);
      // Reading the queue wrote nothing: the item has no end and its run is as it was.
      const read = await harness.store.getItemRuns(projectKey, 'pr-7');
      expect(read?.runs).toMatchObject([{ id: failed, status: 'failed' }]);
      const itemId = read?.item.id ?? '';
      expect(await harness.store.getHoldingItemEnd(itemId)).toBeNull();

      // A run that fails after the merge, or completes and records a stop, leaves it done.
      await failOnItem(harness, 'build-queue');
      expect(await stopped()).toMatchObject(onlyUnmerged);
      const stop = await completeOnItem(harness, 'deliver', 'replan', 'The plan missed it.');
      expect(await stopped()).toMatchObject(onlyUnmerged);

      // A merge row that cannot be read does not hide the stop, and the item read reports it.
      await harness.db.query("UPDATE remote_agent_item_merges SET via = '' WHERE item_id = $1", [
        itemId,
      ]);
      expect(await harness.store.getItemMerge(itemId)).toEqual({
        type: 'degraded',
        reason: 'merge_unreadable',
        itemId,
      });
      const listed = await stopped();
      expect(listed).toHaveLength(2);
      expect(listed).toContainEqual(
        expect.objectContaining({ stoppedIn: expect.objectContaining({ runId: stop }) })
      );
    } finally {
      await harness.close();
    }
  });
}
