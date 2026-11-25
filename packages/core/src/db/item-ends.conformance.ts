/**
 * Conformance for ending an item on the SQL stores, run by the SQLite and PostgreSQL
 * integration tests: an end takes a stopped item out of the attention queue and holds until
 * a run on the item starts or resumes, or a start is queued on it; deleting old runs does
 * not undo it. An end is refused, naming it, while anything on the item is live. The runs
 * follow each other at once, as fast stages do, so on SQLite they share one second.
 */
import { expect, test } from 'bun:test';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import { listAttentionQueue } from '@archon/workflows/attention-queue';
import { readHoldingItemEnd } from '@archon/workflows/item-end';
import { ItemEndRefusedError } from '@archon/workflows/schemas/item-end';
import { itemStoppedMetadata, observesItemMetadata } from '@archon/workflows/schemas/run-metadata';
import {
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
  resourceStartFixtures,
} from '@archon/workflows/store-conformance';
import { recordItemEnd } from '../operations/item-ends';
import {
  ask,
  completeWithAsks,
  itemDeps,
  openRefs,
  operator,
  settledEvents,
  type Harness,
} from './item-asks.conformance';
import { starts } from './start-limits.conformance';

const projectKey = projectKeyForCodebase({ name: 'conformance', default_cwd: '/conformance' }, '');
const end = { projectKey, key: 'pr-7', reason: 'Done by hand in another repository.' };
const { launch } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);

async function createOnItem(harness: Harness, parent?: string, observes = false): Promise<string> {
  const run = await harness.store.createWorkflowRun({
    workflow_name: 'deliver',
    user_message: '',
    codebase_id: CONFORMANCE_CODEBASE_ID,
    metadata: observesItemMetadata({ observes }),
    ...(parent === undefined ? { item_key: 'pr-7' } : { parent_run_id: parent }),
  });
  return run.id;
}

async function startOnItem(harness: Harness, parent?: string): Promise<string> {
  const id = await createOnItem(harness, parent);
  await harness.store.claimPendingWorkflowRun(id);
  return id;
}

/** A running step of another workflow on item `pr-7`, which the first one's hold allows. */
async function startOtherStep(harness: Harness): Promise<string> {
  const run = await harness.store.createWorkflowRun({
    workflow_name: 'review',
    user_message: '',
    codebase_id: CONFORMANCE_CODEBASE_ID,
    item_key: 'pr-7',
  });
  await harness.store.claimPendingWorkflowRun(run.id);
  return run.id;
}

async function stopOnItem(harness: Harness): Promise<string> {
  const id = await startOnItem(harness);
  await harness.store.completeWorkflowRun(id, { duration_ms: 1 }, itemStoppedMetadata('stop'), {
    outcome: { kind: 'enum', value: 'replan' },
  });
  return id;
}

/** Move a run's times `days` into the past, as an old run's are. */
async function backdate(harness: Harness, runId: string, days: number): Promise<void> {
  const at = new Date(Date.now() - days * 86_400_000).toISOString();
  await harness.db.query(
    `UPDATE remote_agent_workflow_runs
     SET started_at = $1, active_phase_started_at = $1, completed_at = $1 WHERE id = $2`,
    [at, runId]
  );
}

async function stoppedRefs(harness: Harness): Promise<string[]> {
  return (await listAttentionQueue(itemDeps(harness).queue)).flatMap(item =>
    'kind' in item && item.kind === 'stopped' ? [item.ref] : []
  );
}

/** The end that holds on `pr-7`, read as every surface reads it: runs and starts together. */
async function holding(harness: Harness) {
  const found = await harness.store.getItemRuns(projectKey, 'pr-7');
  if (found === null) throw new Error('No item pr-7');
  return readHoldingItemEnd(harness.store, found.item.id);
}

async function refusal(promise: Promise<unknown>): Promise<ItemEndRefusedError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  if (!(error instanceof ItemEndRefusedError)) throw new Error(`Expected a refusal: ${error}`);
  return error;
}

export function describeSqlItemEndConformance(makeHarness: () => Promise<Harness>): void {
  test('an end takes an old stop out of attention and outlasts deleting runs', async () => {
    const harness = await makeHarness();
    try {
      const older = await stopOnItem(harness);
      const latest = await stopOnItem(harness);
      await backdate(harness, older, 61);
      await backdate(harness, latest, 60);
      // Nothing ends an item by age: the old stop is listed until the operator ends it.
      expect(await stoppedRefs(harness)).toEqual([`stopped:${latest}`]);

      const before = Date.now();
      const recorded = await recordItemEnd(harness.store, end, operator, 'cli');
      expect(recorded).toMatchObject({
        kind: 'ended',
        reason: end.reason,
        by: { declared: 'maintainer' },
        via: 'cli',
      });
      expect(Date.parse(recorded.at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(recorded.at)).toBeLessThanOrEqual(Date.now());
      expect(await stoppedRefs(harness)).toEqual([]);
      // Ending changes no run, and the stop stays recorded, so a binary that predates ends
      // still lists it.
      expect(await harness.store.getWorkflowRunStatus(latest)).toBe('completed');
      expect((await harness.store.listStoppedItemRuns()).map(run => 'id' in run && run.id)).toEqual(
        [latest]
      );

      // Run cleanup deletes the latest run: the older stop is now the item's last, and stays
      // out of attention, and the end still reads.
      const { deleteWorkflowRun } = await import('./workflow-run-writes');
      await deleteWorkflowRun(latest);
      expect(await stoppedRefs(harness)).toEqual([]);
      expect(await holding(harness)).toEqual(recorded);
    } finally {
      await harness.close();
    }
  });

  test('a finishing outcome ends its item in the completing write, and observing runs leave it ended', async () => {
    const harness = await makeHarness();
    try {
      await stopOnItem(harness);
      const ending = await startOnItem(harness);
      const reason = "Workflow 'deliver' ended the item with outcome 'close': Closed upstream.";
      await harness.store.completeWorkflowRun(ending, { duration_ms: 1 }, undefined, {
        outcome: { kind: 'enum', value: 'close' },
        end: { reason, node: 'decide' },
      });
      const ended = await holding(harness);
      expect(ended).toMatchObject({
        kind: 'ended',
        reason,
        via: 'engine',
        by: null,
        fromRun: { runId: ending, nodePath: 'decide' },
      });
      expect(await stoppedRefs(harness)).toEqual([]);

      // An observing run, live, below it, done or failed, neither opens the end nor is a stop.
      const shadow = await createOnItem(harness, undefined, true);
      expect(await holding(harness)).toEqual(ended);
      await harness.store.claimPendingWorkflowRun(shadow);
      const below = await startOnItem(harness, shadow);
      expect(await holding(harness)).toEqual(ended);
      await harness.store.completeWorkflowRun(below, { duration_ms: 1 });
      await harness.store.completeWorkflowRun(shadow, { duration_ms: 1 });
      const failed = await createOnItem(harness, undefined, true);
      await harness.store.claimPendingWorkflowRun(failed);
      await harness.store.failWorkflowRun(failed, 'boom');
      expect(await holding(harness)).toEqual(ended);
      expect(await stoppedRefs(harness)).toEqual([]);

      // A step opens it, as it opens an operator's end.
      await createOnItem(harness);
      expect(await holding(harness)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('asks and waits on an item whose end holds stay open and out of attention', async () => {
    const harness = await makeHarness();
    try {
      const planned = await completeWithAsks(harness, [ask('Keep the flag?')], { item: 'pr-7' });
      const waiting = await startOnItem(harness);
      const wait = { event: 'checks', about: 'a'.repeat(40), within_minutes: 60 };
      await harness.store.completeWorkflowRun(waiting, { duration_ms: 1 }, undefined, {
        waits: [wait],
      });
      // Move the deadline into the past, as the passing of the hour would.
      await harness.db.query('UPDATE remote_agent_item_waits SET deadline_at = $1', [
        new Date(Date.now() - 60_000).toISOString(),
      ]);
      const overdue = async () =>
        (await listAttentionQueue(itemDeps(harness).queue)).filter(
          item => 'kind' in item && item.kind === 'overdue_wait'
        );
      expect(await openRefs(harness)).toHaveLength(1);
      expect(await overdue()).toHaveLength(1);

      const ending = await startOnItem(harness);
      await harness.store.completeWorkflowRun(ending, { duration_ms: 1 }, undefined, {
        outcome: { kind: 'enum', value: 'close' },
        asks: [ask('Its own, left beside the finishing outcome.')],
        end: { reason: "Workflow 'deliver' ended the item with outcome 'close'", node: 'decide' },
      });
      expect(await holding(harness)).not.toBeNull();
      expect(await openRefs(harness)).toEqual([]);
      expect(await overdue()).toEqual([]);
      // Nothing was closed, so nothing settled; a newer step shows them again.
      expect(await settledEvents(harness, planned)).toEqual([]);
      await createOnItem(harness);
      expect(await openRefs(harness)).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  test('a step started before a finishing run completes opens its end, and its stop shows', async () => {
    const harness = await makeHarness();
    try {
      const finishing = await startOnItem(harness);
      const newer = await startOtherStep(harness);
      const finish = () =>
        harness.store.completeWorkflowRun(finishing, { duration_ms: 1 }, undefined, {
          outcome: { kind: 'enum', value: 'close' },
          end: { reason: "Workflow 'deliver' ended the item with outcome 'close'", node: 'decide' },
        });
      await finish();
      expect(await holding(harness)).toBeNull();
      await harness.store.completeWorkflowRun(newer, { duration_ms: 1 }, itemStoppedMetadata('x'), {
        outcome: { kind: 'enum', value: 'replan' },
      });
      expect(await holding(harness)).toBeNull();
      expect(await stoppedRefs(harness)).toEqual([`stopped:${newer}`]);
    } finally {
      await harness.close();
    }
  });

  test('a finishing run that completes after a newer step stopped leaves that stop listed', async () => {
    const harness = await makeHarness();
    try {
      const finishing = await startOnItem(harness);
      const newer = await startOtherStep(harness);
      await harness.store.completeWorkflowRun(newer, { duration_ms: 1 }, itemStoppedMetadata('x'), {
        outcome: { kind: 'enum', value: 'replan' },
      });
      await harness.store.completeWorkflowRun(finishing, { duration_ms: 1 }, undefined, {
        outcome: { kind: 'enum', value: 'close' },
        end: { reason: "Workflow 'deliver' ended the item with outcome 'close'", node: 'decide' },
      });
      expect(await holding(harness)).toBeNull();
      expect(await stoppedRefs(harness)).toEqual([`stopped:${newer}`]);
    } finally {
      await harness.close();
    }
  });

  test('an observing run that leaves asks on an ended item leaves them out of attention', async () => {
    const harness = await makeHarness();
    try {
      await stopOnItem(harness);
      await recordItemEnd(harness.store, end, operator, 'cli');
      const shadow = await createOnItem(harness, undefined, true);
      await harness.store.claimPendingWorkflowRun(shadow);
      await harness.store.completeWorkflowRun(shadow, { duration_ms: 1 }, undefined, {
        asks: [ask('Advice nobody needs now?')],
      });
      expect(await holding(harness)).not.toBeNull();
      expect(await openRefs(harness)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test('a stop recorded on a finishing run stays out of attention while its end holds', async () => {
    const harness = await makeHarness();
    try {
      // A start its end caused was refused at the hand-off, which records a stop on the run.
      const refused = {
        receiptId: crypto.randomUUID(),
        bindingId: 'landed',
        workflow: 'landed',
        reason: 'no_default_provider' as const,
        refusedAt: new Date().toISOString(),
      };
      const ending = await startOnItem(harness);
      await harness.store.completeWorkflowRun(
        ending,
        { duration_ms: 1 },
        itemStoppedMetadata(null, { refused: [refused] }),
        {
          outcome: { kind: 'enum', value: 'close' },
          end: { reason: "Workflow 'deliver' ended the item with outcome 'close'", node: 'decide' },
        }
      );
      expect((await harness.store.listStoppedItemRuns()).map(run => 'id' in run && run.id)).toEqual(
        [ending]
      );
      expect(await stoppedRefs(harness)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test('a queued start of an observing workflow leaves an end holding; a queued step opens it', async () => {
    const harness = await makeHarness();
    try {
      await stopOnItem(harness);
      const recorded = await recordItemEnd(harness.store, end, operator, 'cli');
      // A start on another item holds the resource, so the starts on this item queue.
      const { start, claimed } = starts(harness);
      const holder = (await start('other', {})).result;
      if (holder?.status !== 'admitted') throw new Error('Expected the holder admitted');
      const base = launch();
      const observing = await harness.store.completeStartBindingPreparation({
        ...(await claimed('pr-7', {}, null)),
        launch: {
          ...base,
          run: { ...base.run, metadata: observesItemMetadata({ observes: true }) },
        },
      });
      expect(observing?.status).toBe('queued');
      expect(await holding(harness)).toEqual(recorded);
      // Nor does it keep the item from being ended again.
      await recordItemEnd(harness.store, end, operator, 'cli');

      const step = (await start('pr-7', {})).result;
      expect(step?.status).toBe('queued');
      expect(await holding(harness)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('a run that starts on an ended item opens it, while it runs and after', async () => {
    const harness = await makeHarness();
    try {
      await stopOnItem(harness);
      await recordItemEnd(harness.store, end, operator, 'cli');
      const next = await createOnItem(harness);
      expect(await holding(harness)).toBeNull();
      await harness.store.claimPendingWorkflowRun(next);
      expect(await holding(harness)).toBeNull();
      await harness.store.completeWorkflowRun(
        next,
        { duration_ms: 1 },
        itemStoppedMetadata('again'),
        {
          outcome: { kind: 'enum', value: 'replan' },
        }
      );
      expect(await holding(harness)).toBeNull();
      expect(await stoppedRefs(harness)).toEqual([`stopped:${next}`]);
    } finally {
      await harness.close();
    }
  });

  test('a start queued on an ended item opens it before its run exists', async () => {
    const harness = await makeHarness();
    try {
      await stopOnItem(harness);
      await recordItemEnd(harness.store, end, operator, 'cli');
      // A start on another item holds the resource, so the start on this item queues.
      const { start } = starts(harness);
      const holder = (await start('other', {})).result;
      const queued = (await start('pr-7', {})).result;
      if (holder?.status !== 'admitted' || queued?.status !== 'queued')
        throw new Error('Expected one admitted start and one queued');
      expect(await holding(harness)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('resuming the failed run an item was ended on opens it, though it fails again at once', async () => {
    const harness = await makeHarness();
    try {
      const failed = await startOnItem(harness);
      await harness.store.failWorkflowRun(failed, 'boom');
      await recordItemEnd(harness.store, end, operator, 'cli');
      expect(await holding(harness)).not.toBeNull();
      expect(await harness.store.getWorkflowRunStatus(failed)).toBe('failed');
      await harness.store.resumeWorkflowRun(failed);
      expect(await holding(harness)).toBeNull();
      await harness.store.failWorkflowRun(failed, 'boom again');
      expect(await holding(harness)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('a second resume of an ended run opens the item', async () => {
    const harness = await makeHarness();
    try {
      // The run was resumed once before the end, so only its fresh claim tells the next
      // resume from that one; times may share a second.
      const failed = await startOnItem(harness);
      await harness.store.failWorkflowRun(failed, 'boom');
      await harness.store.resumeWorkflowRun(failed);
      await harness.store.failWorkflowRun(failed, 'boom again');
      await recordItemEnd(harness.store, end, operator, 'cli');
      expect(await holding(harness)).not.toBeNull();
      await harness.store.resumeWorkflowRun(failed);
      await harness.store.failWorkflowRun(failed, 'and again');
      expect(await holding(harness)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('a run started right after the newest run in the store is deleted opens the item', async () => {
    const harness = await makeHarness();
    try {
      // On SQLite the next run can reuse the deleted run's row id, within the same second.
      const failed = await startOnItem(harness);
      await harness.store.failWorkflowRun(failed, 'boom');
      await recordItemEnd(harness.store, end, operator, 'cli');
      const { deleteWorkflowRun } = await import('./workflow-run-writes');
      await deleteWorkflowRun(failed);
      expect(await holding(harness)).not.toBeNull();
      const next = await startOnItem(harness);
      await harness.store.failWorkflowRun(next, 'boom again');
      expect(await holding(harness)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('a run the end did not see opens the item, however old its start time', async () => {
    const harness = await makeHarness();
    try {
      await stopOnItem(harness);
      await recordItemEnd(harness.store, end, operator, 'cli');
      // The state a run leaves when its transaction began before the end and committed after.
      const late = await startOnItem(harness);
      await harness.store.failWorkflowRun(late, 'boom');
      await backdate(harness, late, 1);
      expect(await holding(harness)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test("resuming a failed run below the item's runs opens the item", async () => {
    const harness = await makeHarness();
    try {
      const parent = await startOnItem(harness);
      const child = await startOnItem(harness, parent);
      await harness.store.failWorkflowRun(child, 'child failed');
      await harness.store.failWorkflowRun(parent, 'parent failed');
      await recordItemEnd(harness.store, end, operator, 'cli');
      expect(await holding(harness)).not.toBeNull();
      await harness.store.resumeWorkflowRun(child);
      expect(await holding(harness)).toBeNull();
      await harness.store.failWorkflowRun(child, 'child failed again');
      expect(await holding(harness)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('deleting the run that opened an item lets its end hold again', async () => {
    const harness = await makeHarness();
    try {
      // The rule reads the runs that exist: with the opening run gone, the item is as the
      // operator left it.
      const { deleteWorkflowRun } = await import('./workflow-run-writes');
      const first = await startOnItem(harness);
      await harness.store.failWorkflowRun(first, 'boom');
      const recorded = await recordItemEnd(harness.store, end, operator, 'cli');
      const reopening = await startOnItem(harness);
      await harness.store.failWorkflowRun(reopening, 'boom again');
      expect(await holding(harness)).toBeNull();
      await deleteWorkflowRun(reopening);
      expect(await holding(harness)).toEqual(recorded);
    } finally {
      await harness.close();
    }
  });

  test('an end is refused, naming it, while a run, a child run or a queued start is live', async () => {
    const harness = await makeHarness();
    try {
      const refusedBy = async (store = harness.store) =>
        (await refusal(recordItemEnd(store, end, operator, 'cli'))).blocker;

      const pending = await createOnItem(harness);
      expect(await refusedBy()).toEqual({ kind: 'run', runId: pending, status: 'pending' });
      // The store refuses by itself too, so a run that slips in after any earlier check is
      // seen in the same transaction that writes the end, and nothing is written.
      const item = await harness.store.getItemRuns(projectKey, 'pr-7');
      await expect(
        harness.store.recordItemEnd({
          itemId: item?.item.id ?? '',
          key: 'pr-7',
          reason: 'x',
          via: 'cli',
          by: { declared: 'maintainer' },
          fromRun: null,
        })
      ).rejects.toBeInstanceOf(ItemEndRefusedError);
      await harness.store.claimPendingWorkflowRun(pending);
      const child = await startOnItem(harness, pending);
      await harness.store.failWorkflowRun(pending, 'parent failed');
      expect(await refusedBy()).toEqual({ kind: 'run', runId: child, status: 'running' });
      await harness.store.completeWorkflowRun(child, { duration_ms: 1 });

      // A start on another item holds the resource, so the start on this item queues.
      const { start } = starts(harness);
      const holder = (await start('other', {})).result;
      const queued = (await start('pr-7', {})).result;
      if (holder?.status !== 'admitted' || queued?.status !== 'queued')
        throw new Error('Expected one admitted start and one queued');
      expect(await refusedBy()).toEqual({ kind: 'queued_start', requestId: queued.requestId });
      expect(await holding(harness)).toBeNull();
      // No refused attempt left an end behind.
      const ends = await harness.db.query<{ n: number | string }>(
        'SELECT COUNT(*) AS n FROM remote_agent_item_ends'
      );
      expect(Number(ends.rows[0]?.n)).toBe(0);
    } finally {
      await harness.close();
    }
  });
}

/**
 * PostgreSQL only, where two transactions overlap: a run created in a transaction still open
 * while the end is recorded opens the item once it commits, and stays open after it fails.
 */
export function describePostgresItemEndOverlap(makeHarness: () => Promise<Harness>): void {
  test('a run committed after an overlapping end opens the item for good', async () => {
    const harness = await makeHarness();
    try {
      await stopOnItem(harness);
      const found = await harness.store.getItemRuns(projectKey, 'pr-7');
      const itemId = found?.item.id ?? '';
      let late = '';
      await harness.db.withTransaction(async query => {
        const inserted = await query<{ id: string }>(
          `INSERT INTO remote_agent_workflow_runs (workflow_name, user_message, item_id, codebase_id)
           VALUES ('deliver', '', $1, $2) RETURNING id`,
          [itemId, CONFORMANCE_CODEBASE_ID]
        );
        late = inserted.rows[0]?.id ?? '';
        // The end's own transaction cannot see this run yet, so nothing refuses it.
        await recordItemEnd(harness.store, end, operator, 'cli');
      });
      await harness.store.claimPendingWorkflowRun(late);
      await harness.store.failWorkflowRun(late, 'boom');
      expect(await holding(harness)).toBeNull();
    } finally {
      await harness.close();
    }
  });
}
