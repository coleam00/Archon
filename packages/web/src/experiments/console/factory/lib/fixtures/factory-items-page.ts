import type { FactoryItem } from '../../../skills/factory';
import { DELIVER_AFTER_PLAN, realItem } from '../map.test-fixtures';

type Progress = NonNullable<FactoryItem['progress']>;

/** Real item `key` cut to its run `runId`, in the read and in its progress, with `progress`. */
function onlyRun(key: string, runId: string, progress: Partial<Progress>): FactoryItem {
  const item = realItem(key);
  const run = item.runs.find(entry => entry.id === runId);
  if (run === undefined) throw new Error(`item ${key} has no run ${runId}`);
  return {
    ...item,
    runs: [run],
    progress: {
      ...(item.progress as Progress),
      runs: [{ runId, workflow: 'deliver', failedStep: null }],
      ...progress,
    },
  };
}

/** A deliver run on `build__build`, started at `startedAt`. */
const onBuild = (runId: string, startedAt: string): Progress['running'] => ({
  runId,
  workflow: 'deliver',
  step: 'build__build',
  startedAt,
});

const item6 = onlyRun('6', '585ed621-5f63-4148-bb95-92cfb4c7f52a', {
  running: onBuild('585ed621-5f63-4148-bb95-92cfb4c7f52a', '2026-11-17T05:51:11.000Z'),
  round: null,
  returned: 0,
});

/**
 * #12 is not in the copy: it is #6 renamed, its one deliver run started by another run's end,
 * as item 12 was on 2026-11-17. That run (5da88866) is in no capture, so the arrow id is
 * assumed to be plan's, as every other deliver run's here.
 */
const item12: FactoryItem = {
  ...item6,
  item: { ...item6.item, id: 'b67699236409b5c74dff09dd0cf85507', key: '12' },
  runs: item6.runs.map(run => ({
    ...run,
    id: 'c9773ff3-36bf-413e-a3b3-45ce93a77087',
    startedAt: '2026-11-17T06:41:56.000Z',
    cause: {
      kind: 'run_ended',
      runId: '5da88866-18d3-4045-9019-2a11d45899aa',
      sourceInstanceId: DELIVER_AFTER_PLAN,
    },
  })),
  progress: {
    ...(item6.progress as Progress),
    title: 'Stage and step pages show which items are on a step now',
    running: onBuild('c9773ff3-36bf-413e-a3b3-45ce93a77087', '2026-11-17T06:41:56.000Z'),
    runs: [
      { runId: 'c9773ff3-36bf-413e-a3b3-45ce93a77087', workflow: 'deliver', failedStep: null },
    ],
  },
};

/**
 * Items as the console reads them (each read joined with its progress), from the map's copy
 * (`map.test-fixtures.ts`): three deliver runs on `build__build` and one idle item, each cut
 * to one run. #4 carries the round its previous run ended in (returned, then an ask); #5 is
 * cut to its run that ended on an ask, before its next one started.
 */
export const capturedItemsPage: { items: FactoryItem[] } = {
  items: [
    item12,
    onlyRun('4', '624c763f-4f33-46ea-aa65-bb1ba78c1eec', {
      running: onBuild('624c763f-4f33-46ea-aa65-bb1ba78c1eec', '2026-11-17T06:44:47.000Z'),
      round: {
        runId: 'fdef09db-c751-43a0-9eb5-c6386b8f8b60',
        iteration: 2,
        max: 3,
        rounds: [
          { iteration: 1, verdict: 'returned', outcome: 'return' },
          { iteration: 2, verdict: 'undecided', outcome: 'ask' },
        ],
      },
    }),
    item6,
    onlyRun('5', 'f4e603d9-bdeb-4614-a411-77e76eb77777', { running: null }),
  ],
};

/**
 * A captured item renamed `key` with its progress replaced, for the states the capture does
 * not hold: a run between a loop's bodies, a run between steps, another workflow, no progress.
 */
export function capturedItemAs(
  key: string,
  progress: { running: Progress['running'] } | null,
  base: FactoryItem = capturedItemsPage.items[0] as FactoryItem
): FactoryItem {
  return {
    ...base,
    item: { ...base.item, id: `${base.item.id}-${key}`, key },
    progress: progress === null ? null : { ...(base.progress as Progress), ...progress },
  };
}

/**
 * What a stubbed server answers to the items read for `items`: a window page of their reads
 * at `/api/items/window`, and their progress at `/api/factory/progress`.
 */
export function itemsReadAnswer(items: readonly FactoryItem[]): (url: string) => Response {
  return url =>
    url.includes('/api/factory/progress')
      ? Response.json({
          pack: 'Wirasm/archon-software-factory',
          progress: Object.fromEntries(items.map(item => [item.item.key, item.progress])),
        })
      : Response.json({
          window: { since: '1970-01-01T00:00:00.000Z', until: '2026-11-17T12:00:00.000Z' },
          items: items.map(({ progress: _progress, ...read }) => read),
          next: null,
        });
}

/** Whether a stubbed server's `url` is one of the items read's two requests. */
export const isItemsRead = (url: string): boolean =>
  url.includes('/api/items/window') || url.includes('/api/factory/progress');
