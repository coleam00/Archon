/**
 * The item each listed run is on: one read per run, and the two shapes a listing asks for.
 *
 * It lives beside the run listings rather than inside them because a run stores only
 * `item_id`. Naming the item costs a read, and `--open` and the recent list must name it the
 * same way, so both ask the same object rather than each deriving its own column.
 */
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { getLog } from './workflow-shared';

/** An item a run is on: the key it reads as, and the project that key belongs to. */
export interface RunItemRef {
  project: string;
  key: string;
}

/** One listing's items, read once: the JSON names them and the table prints them. */
export interface RunItems {
  /**
   * The row's item cell: the key, padded to the widest in the listing so the columns after
   * it line up, and empty for a run on none. Empty when no run in the listing is on an item,
   * which leaves the row as it printed before items were shown.
   */
  cell(runId: string): string;
  /** The runs with the item each is on; `item` is absent for a run on none. */
  named<T extends WorkflowRun>(runs: readonly T[]): (T | (T & { item: RunItemRef }))[];
}

/**
 * The item each of `runs` is on, by run id. A run stores only `item_id`, so the key is one
 * read per run that has one — the list is already bounded by `--limit`. A run on no item is
 * absent from the map: `workflow:` sub-runs carry no `item_id` of their own, and read as
 * runs on none here as they do in the dashboard's joined `item_key`.
 */
export async function runItemsOf(
  host: WorkflowHost,
  runs: readonly Pick<WorkflowRun, 'id' | 'item_id'>[]
): Promise<RunItems> {
  const refs = new Map<string, RunItemRef>();
  const reads = await Promise.all(
    runs.map(async run => {
      if (!run.item_id) return null;
      try {
        const item = await host.deps.store.getItem(run.item_id);
        return item === null
          ? null
          : ([run.id, { project: item.projectKey, key: item.key }] as const);
      } catch (error) {
        // One unreadable item must not cost the operator the whole list.
        getLog().warn({ err: error as Error, runId: run.id }, 'cli.workflow_runs_item_read_failed');
        return null;
      }
    })
  );
  for (const read of reads) if (read !== null) refs.set(read[0], read[1]);
  const width = Math.max(0, ...[...refs.values()].map(item => item.key.length));
  return {
    cell: runId => (width === 0 ? '' : `${(refs.get(runId)?.key ?? '').padEnd(width)}  `),
    named: listed =>
      listed.map(run => {
        const item = refs.get(run.id);
        return item === undefined ? run : { ...run, item };
      }),
  };
}
