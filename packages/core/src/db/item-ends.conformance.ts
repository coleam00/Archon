/**
 * Conformance for ending an item on the SQL stores, run by the SQLite and PostgreSQL
 * integration tests: an end takes a stopped item out of the attention queue and holds while
 * the item's last run is unchanged; a newer run, or a resume of the last one, opens the item
 * again. An end is refused while anything on the item is active, naming it.
 */
import { expect, test } from 'bun:test';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import { listAttentionQueue } from '@archon/workflows/attention-queue';
import { ItemEndRefusedError } from '@archon/workflows/schemas/item-end';
import { itemStoppedMetadata } from '@archon/workflows/schemas/run-metadata';
import { CONFORMANCE_CODEBASE_ID } from '@archon/workflows/store-conformance';
import { recordItemEnd } from '../operations/item-ends';
import { itemDeps, operator, type Harness } from './item-asks.conformance';

const projectKey = projectKeyForCodebase({ name: 'conformance', default_cwd: '/conformance' }, '');
const end = { projectKey, key: 'pr-7', reason: 'Done by hand in another repository.' };

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

async function stopOnItem(harness: Harness, workflow: string): Promise<string> {
  const id = await startOnItem(harness, workflow);
  await harness.store.completeWorkflowRun(id, { duration_ms: 1 }, itemStoppedMetadata('stop'), {
    outcome: { kind: 'enum', value: 'replan' },
  });
  return id;
}

async function stoppedRefs(harness: Harness): Promise<string[]> {
  return (await listAttentionQueue(itemDeps(harness).queue)).flatMap(item =>
    'kind' in item && item.kind === 'stopped' ? [item.ref] : []
  );
}

async function itemId(harness: Harness): Promise<string> {
  const found = await harness.store.getItemRuns(projectKey, 'pr-7');
  if (found === null) throw new Error('No item pr-7');
  return found.item.id;
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
  test('an ended stopped item leaves attention until a newer run starts on it', async () => {
    const harness = await makeHarness();
    try {
      const stopped = await stopOnItem(harness, 'deliver');
      expect(await stoppedRefs(harness)).toEqual([`stopped:${stopped}`]);

      const recorded = await recordItemEnd(harness.store, end, operator, 'cli');
      expect(recorded).toMatchObject({
        kind: 'ended',
        reason: end.reason,
        by: { declared: 'maintainer' },
        via: 'cli',
        runId: stopped,
      });
      expect(await stoppedRefs(harness)).toEqual([]);
      expect(await harness.store.getHoldingItemEnd(await itemId(harness))).toEqual(recorded);

      // Runs follow at once, so on SQLite the newer run can share the stopped run's second.
      const again = await stopOnItem(harness, 'deliver');
      expect(await harness.store.getHoldingItemEnd(await itemId(harness))).toBeNull();
      expect(await stoppedRefs(harness)).toEqual([`stopped:${again}`]);
    } finally {
      await harness.close();
    }
  });

  test('a failed run resumed in place opens the item it ended', async () => {
    const harness = await makeHarness();
    try {
      const failed = await startOnItem(harness, 'deliver');
      await harness.store.failWorkflowRun(failed, 'boom');
      await recordItemEnd(harness.store, end, operator, 'cli');
      const id = await itemId(harness);
      expect(await harness.store.getHoldingItemEnd(id)).toMatchObject({ runId: failed });
      // A resume clears completed_at and the next failure writes a new one on the same row.
      await harness.db.query(
        'UPDATE remote_agent_workflow_runs SET completed_at = $1 WHERE id = $2',
        [new Date(Date.now() + 60_000).toISOString(), failed]
      );
      expect(await harness.store.getHoldingItemEnd(id)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('an end is refused, naming what is active, while a run or a start is on the item', async () => {
    const harness = await makeHarness();
    try {
      const running = await startOnItem(harness, 'deliver');
      expect((await refusal(recordItemEnd(harness.store, end, operator, 'cli'))).blocker).toEqual({
        kind: 'run',
        runId: running,
        status: 'running',
      });
      await harness.store.completeWorkflowRun(running, { duration_ms: 1 });
      const queued = {
        ...harness.store,
        listQueuedItemStarts: async () => [
          {
            requestId: 'request-1',
            workflow: 'deliver',
            resource: 'build',
            hostId: 'host',
            queuedAt: new Date().toISOString(),
            ahead: 0,
          },
        ],
      };
      const refused = await refusal(recordItemEnd(queued, end, operator, 'cli'));
      expect(refused.blocker).toEqual({ kind: 'queued_start', requestId: 'request-1' });
      expect(refused.message).toContain('request-1');
      expect(await harness.store.getHoldingItemEnd(await itemId(harness))).toBeNull();
    } finally {
      await harness.close();
    }
  });
}
