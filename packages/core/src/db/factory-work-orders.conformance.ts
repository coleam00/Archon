/**
 * What the factory board reads of work orders, on both SQL stores: the items window and the
 * factory progress read, through the real store. Called from each backend's conformance test
 * with its harness factory, after `makeSqlConformanceHarness` has routed the store to that
 * backend's database.
 */
import { expect, test } from 'bun:test';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import {
  FactoryRunFactsMemo,
  factoryProgressSchema,
  readFactoryProgress,
} from '@archon/workflows/factory-items';
import { readItemWindow } from '@archon/workflows/item-window';
import { factoryViewSchema } from '@archon/workflows/schemas/factory-view';
import { RUN_GRAPH_METADATA_KEY } from '@archon/workflows/schemas/terminal-record';
import {
  CONFORMANCE_CODEBASE_ID,
  type WorkflowStoreHarness,
} from '@archon/workflows/store-conformance';
import type { IDatabase } from './adapters/types';
import { attentionQueueSource } from '../operations/attention-queue';

const PACK = 'acme/factory';

/** A view whose `intake` workflow's result names an item's work order at `/part_of`. */
const view = factoryViewSchema.parse({
  version: 1,
  pack: PACK,
  title: 'Factory',
  summary: 'Items in, changes out.',
  stages: [
    { id: 'intake', label: 'Intake', blurb: 'Takes.', group: 'intake', workflows: ['intake'] },
    { id: 'build', label: 'Build', blurb: 'Builds.', group: 'build', workflows: ['build'] },
    { id: 'landed', label: 'Landed', blurb: 'Merged.', group: 'land', workflows: [] },
  ],
  placement: { 'intake:*': 'build' },
  endings: {},
  landed: { stage: 'landed' },
  partOf: { workflow: 'intake', pointer: '/part_of', outcome: 'ready' },
  map: { cards: [{ stage: 'intake' }, { stage: 'build' }], arrows: [] },
});

export function describeFactoryWorkOrderReadConformance(
  makeHarness: () => Promise<WorkflowStoreHarness & { db: IDatabase }>
): void {
  test("work orders: members from active part_of links, an item's order from its intake result", async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const projectKey = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      const byCli = { via: 'cli', by: null, fromRun: null } as const;
      const link = (fromKey: string, toKey: string) =>
        store.recordItemLink({ projectKey, fromKey, toKey, kind: 'part_of', ...byCli });
      const started = async (key: string, workflow: string) => {
        const run = await store.createWorkflowRun({
          workflow_name: `${PACK}:${workflow}`,
          user_message: '',
          codebase_id: CONFORMANCE_CODEBASE_ID,
          item_key: key,
          metadata: { [RUN_GRAPH_METADATA_KEY]: { node_ids: ['take'], returns: 'take' } },
        });
        await store.claimPendingWorkflowRun(run.id);
        return run;
      };

      // A and D are linked to O, which has no run of its own; D has no run either.
      await started('A', 'build');
      await link('A', 'O');
      await link('D', 'O');
      // B was linked to O, and the link ended.
      await started('B', 'build');
      const ended = await link('B', 'O');
      await store.endItemLink({ projectKey, linkId: ended.link.id, ...byCli });
      // C has no link; its completed intake run names O2.
      const intake = await started('C', 'intake');
      await store.persistWorkflowEvent({
        workflow_run_id: intake.id,
        event_type: 'node_started',
        step_name: 'take',
      });
      await store.persistWorkflowEvent({
        workflow_run_id: intake.id,
        event_type: 'node_completed',
        step_name: 'take',
        data: { structured_output: { outcome: 'ready', part_of: 'O2' } },
      });
      await store.completeWorkflowRun(intake.id, { duration_ms: 1 }, undefined, {
        outcome: { kind: 'enum', value: 'ready' },
      });

      const source = attentionQueueSource(store, {
        findLatestByCodebaseAndWorkingPath: async () => null,
      });
      const window = await readItemWindow(source, projectKey, {
        since: '1970-01-01T00:00:00Z',
        limit: 100,
      });
      // O and D have no run, so the window does not list them.
      expect(window.items.map(read => read.item.key).sort()).toEqual(['A', 'B', 'C']);
      const a = window.items.find(read => read.item.key === 'A');
      expect(
        a?.links.map(entry => [entry.kind, entry.direction, entry.other.key, entry.ended])
      ).toEqual([['part_of', 'outgoing', 'O', null]]);

      const progress = factoryProgressSchema.parse(
        await readFactoryProgress(
          source,
          {
            view,
            pack: PACK,
            projectKey,
            changeState: async () => ({ url: null, merged: false, mergedAt: null, number: null }),
            memo: new FactoryRunFactsMemo(),
            onProgressError: (itemId, error) => {
              throw new Error(`progress failed for ${itemId}: ${String(error)}`);
            },
          },
          ['O', 'C', 'A', 'nowhere']
        )
      );
      // O has a row and no runs: it reads, with its members in recording order, B's ended
      // link left out. A key with no item is left out.
      expect(progress.members).toEqual({ O: ['A', 'D'], C: [], A: [] });
      expect(progress.progress.O).toMatchObject({ partOf: null, runs: [] });
      expect(progress.progress.C?.partOf).toBe('O2');
      expect(progress.progress.A?.partOf).toBeNull();
    } finally {
      await harness.close();
    }
  });
}
