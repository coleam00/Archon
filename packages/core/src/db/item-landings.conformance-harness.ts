/**
 * An item's landing branch, on both SQL stores. Called from each backend's conformance test
 * with its harness factory, after `makeSqlConformanceHarness` has routed the store to that
 * backend's database.
 */
import { expect, test } from 'bun:test';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import type { WorkflowStoreHarness } from '@archon/workflows/store-conformance';

export function describeItemLandingConformance(
  makeHarness: () => Promise<WorkflowStoreHarness>
): void {
  test("an item's landing branch writes the item on first use, and recording again replaces it", async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const projectKey = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      const fromRun = { runId: 'run-1', nodePath: 'order' };
      const first = await store.recordItemLanding({
        projectKey,
        key: 'order',
        branch: 'feat/typo',
        fromRun,
      });
      expect(first).toMatchObject({ branch: 'feat/typo', fromRun });
      const item = (await store.getItemRuns(projectKey, 'order'))?.item;
      expect(item?.key).toBe('order');
      const replaced = await store.recordItemLanding({
        projectKey,
        key: 'order',
        branch: 'feat/order',
        fromRun: null,
      });
      expect(replaced).toMatchObject({ branch: 'feat/order', fromRun: null });
      expect(await store.getItemLanding(item?.id ?? '')).toEqual(replaced);
      const other = await store.recordItemLanding({
        projectKey,
        key: 'other',
        branch: 'x',
        fromRun: null,
      });
      expect(other.branch).toBe('x');
      expect(await store.getItemLanding(item?.id ?? '')).toEqual(replaced);
    } finally {
      await harness.close();
    }
  });
}
