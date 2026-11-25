/**
 * Conformance for stopped items on the SQL stores, run by the SQLite and PostgreSQL
 * integration tests: a completed run that recorded a stop (`itemStoppedMetadata`) puts its
 * item in the attention queue as `stopped` while it is the item's last run, the item takes
 * no answer, and any later run on the item, whatever its status, takes it out. The runs
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

      // A run that stopped with an unknown outcome names the node to check, and only its
      // resume or abandon closes it: a later run on the item does not, and a child run with
      // no item is listed too.
      const unknown = await createOnItem(harness, 'check');
      await harness.store.claimPendingWorkflowRun(unknown);
      // A node completed before it, so resume admits the run.
      await harness.store.persistWorkflowEvent({
        workflow_run_id: unknown,
        event_type: 'node_completed',
        step_name: 'prepare',
        data: { node_output: 'ok' },
      });
      await harness.store.persistWorkflowEvent({
        workflow_run_id: unknown,
        event_type: 'node_failed',
        step_name: 'fan__b__write',
        data: { error: 'timed out', failure_kind: 'outcome_unknown' },
      });
      await harness.store.failWorkflowRun(unknown, 'write timed out', {
        exitReason: 'outcome_unknown',
      });
      await createOnItem(harness, 'check');
      const child = await harness.store.createWorkflowRun({
        workflow_name: 'writer',
        user_message: '',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        parent_run_id: unknown,
      });
      await harness.store.claimPendingWorkflowRun(child.id);
      await harness.store.failWorkflowRun(child.id, 'write timed out', {
        exitReason: 'outcome_unknown',
      });
      const listed = await stopped();
      expect(listed).toMatchObject([
        {
          stoppedIn: { runId: unknown },
          item: { key: 'pr-7' },
          failed: { outcomeUnknown: { node: 'fan__b__write', resumable: true } },
        },
        // Nothing completed in the child, so resume would refuse it: attention says so.
        {
          stoppedIn: { runId: child.id },
          failed: { outcomeUnknown: { node: null, resumable: false } },
        },
      ]);
      expect(listed[1]).not.toHaveProperty('item');
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
}
