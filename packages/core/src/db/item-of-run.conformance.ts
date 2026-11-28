/**
 * Conformance for the item a run reads under (`readItemOfRun`), run by the SQLite and
 * PostgreSQL integration tests: a child run that records an item of its own, through each of
 * the three creation paths that can store one, reads under that item, so an inbox that
 * hides ended work hides it on that item's end, and its root's end does not reach it. A
 * `workflow:` child records none and reads its root's item, whose end does hide it.
 */
import { expect, test } from 'bun:test';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import { readItemOfRun } from '@archon/workflows/item-read';
import { readHoldingItemEnd } from '@archon/workflows/item-end';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { CONFORMANCE_CODEBASE_ID } from '@archon/workflows/store-conformance';
import { attentionQueueSource } from '../operations/attention-queue';
import { recordItemEnd } from '../operations/item-ends';
import { operator, type Harness } from './item-asks.conformance';

const projectKey = projectKeyForCodebase({ name: 'conformance', default_cwd: '/conformance' }, '');
const ended = (key: string) => ({ projectKey, key, reason: 'Done by hand.' });

/** The source every reader but the attention queue builds for `readItemOfRun`. */
const source = (harness: Harness) =>
  attentionQueueSource(harness.store, { findLatestByCodebaseAndWorkingPath: async () => null });

async function createRun(
  harness: Harness,
  fields: { item_key?: string; parent_run_id?: string; adopted_from_run_id?: string }
): Promise<WorkflowRun> {
  return harness.store.createWorkflowRun({
    workflow_name: 'review',
    user_message: '',
    codebase_id: CONFORMANCE_CODEBASE_ID,
    ...fields,
  });
}

/** Finish a pending run; only a failed one is a candidate for the open-work inbox. */
async function finishRun(harness: Harness, runId: string, outcome: 'failed' | 'completed') {
  await harness.store.claimPendingWorkflowRun(runId);
  if (outcome === 'failed') await harness.store.failWorkflowRun(runId, outcome);
  else await harness.store.completeWorkflowRun(runId, { duration_ms: 1 });
}

/**
 * The end an inbox that hides ended work applies to `runId`: the end holding on the item
 * the run reads under, composed from `readItemOfRun` and `readHoldingItemEnd`.
 */
async function endHiding(harness: Harness, runId: string) {
  const read = await readItemOfRun(source(harness), runId);
  return read === null ? null : readHoldingItemEnd(harness.store, read.item.id);
}

/** A child with an item of its own under `root`, by one of the paths that can record one. */
type ChildPath = (harness: Harness, root: WorkflowRun) => Promise<WorkflowRun>;

const childPaths: [string, ChildPath][] = [
  // `createWorkflowRun` with `item_key` beside a `parent_run_id` names the child's item.
  [
    'explicit',
    (harness, root) => createRun(harness, { parent_run_id: root.id, item_key: 'child-item' }),
  ],
  // A sub-run that continues a run on another item takes that run's item.
  [
    'continued',
    async (harness, root) => {
      const continued = await createRun(harness, { item_key: 'child-item' });
      await finishRun(harness, continued.id, 'completed');
      return createRun(harness, {
        parent_run_id: root.id,
        adopted_from_run_id: continued.id,
      });
    },
  ],
  // A prepared start writes the item its request resolved, whatever its parent's is.
  [
    'prepared',
    async (harness, root) => {
      const { ensureItem } = await import('./items');
      const { insertWorkflowRun } = await import('./workflows');
      return harness.db.withTransaction(async query =>
        insertWorkflowRun(
          query,
          {
            workflow_name: 'review',
            user_message: '',
            codebase_id: CONFORMANCE_CODEBASE_ID,
            parent_run_id: root.id,
          },
          { itemId: await ensureItem(query, CONFORMANCE_CODEBASE_ID, 'child-item') }
        )
      );
    },
  ],
];

export function describeSqlItemOfRunConformance(makeHarness: () => Promise<Harness>): void {
  test.each(childPaths)(
    "%s: a child with an item of its own is hidden by that item's end, not by its root's",
    async (_path, createChild) => {
      const harness = await makeHarness();
      try {
        const root = await createRun(harness, { item_key: 'parent-item' });
        const child = await createChild(harness, root);
        const workflowChild = await createRun(harness, { parent_run_id: root.id });
        await finishRun(harness, child.id, 'failed');
        await finishRun(harness, workflowChild.id, 'failed');
        await finishRun(harness, root.id, 'completed');
        expect(child.parent_run_id).toBe(root.id);
        expect(child.item_id).not.toBe(root.item_id);
        expect(workflowChild.item_id).toBeNull();

        // The child reads under its own item and is listed there; the `workflow:` child, which
        // recorded none, reads under its root's.
        const read = await readItemOfRun(source(harness), child.id);
        expect(read?.item).toEqual(
          expect.objectContaining({ key: 'child-item', id: child.item_id })
        );
        expect(read?.runs.map(run => run.id)).toContain(child.id);
        expect((await readItemOfRun(source(harness), workflowChild.id))?.item).toEqual(
          expect.objectContaining({ key: 'parent-item', id: root.item_id })
        );
        expect(await endHiding(harness, child.id)).toBeNull();

        // The root's item ends. It hides the `workflow:` child, and not the child with an item
        // of its own.
        const rootEnd = await recordItemEnd(harness.store, ended('parent-item'), operator, 'cli');
        expect(await endHiding(harness, child.id)).toBeNull();
        expect(await endHiding(harness, workflowChild.id)).toEqual(rootEnd);

        // The child's own item ends: now its end hides it.
        const childEnd = await recordItemEnd(harness.store, ended('child-item'), operator, 'cli');
        expect(await endHiding(harness, child.id)).toEqual(childEnd);
        // The end changes no run: the child still reads under its own item.
        expect((await readItemOfRun(source(harness), child.id))?.item.id).toBe(read?.item.id);
      } finally {
        await harness.close();
      }
    }
  );
}
