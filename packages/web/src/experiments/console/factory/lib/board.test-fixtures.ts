/**
 * The board's fixtures: the items `dev:console` served from a copy of the live factory
 * database, each read joined with its progress (`__fixtures__/items-page.json`, the one items
 * capture: the map's and the step pages' fixtures are made from it too), and the declaration
 * this repository ships. Edge cases the copy does not hold (a failed run, an open ask, a
 * triage ending) are made by editing a real item, never from nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryItem } from '../../skills/factory';
import type { FactoryDeclaration } from './board';

const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const CAPTURE = read(join(import.meta.dir, '__fixtures__', 'items-page.json')) as {
  items: FactoryItem[];
  item114: { item: FactoryItem };
};

export const PAGE = { items: CAPTURE.items };

export const VIEW = read(
  join(
    import.meta.dir,
    ...Array<string>(7).fill('..'),
    '.archon',
    'packs',
    'Wirasm.archon-software-factory.factory-view.json'
  )
) as FactoryDeclaration;

/**
 * Item 114 exactly as the board read it on 2026-11-23 from a copy of the live database, kept
 * in the capture beside its page (`item114`, not one of `items`): its deliver run ended `ask`
 * at 2026-11-20 21:38:49 UTC, the ask was answered take-as-is and started nothing, and it
 * never opened a pull request (its change reads `unknown`, no URL).
 */
export const ITEM_114 = CAPTURE.item114.item;

/**
 * The time a test reads the fixture board at: the day after the copy's last run ended, so the
 * set-aside idle rule (`SET_ASIDE_IDLE_MS`) takes none of its items unless a test ages one.
 */
export const FIXTURE_NOW = new Date(2026, 10, 18, 12, 0);

/** A real item by key, deep-copied so a test can edit it. */
export function realItem(key: string): FactoryItem {
  const found = PAGE.items.find(entry => entry.item.key === key);
  if (found === undefined) throw new Error(`the fixture page has no item ${key}`);
  return structuredClone(found);
}

/** The item's progress, which every real item has. */
export function progressOf(item: FactoryItem): NonNullable<FactoryItem['progress']> {
  if (item.progress === null) throw new Error(`item ${item.item.key} has no progress`);
  return item.progress;
}

/** Keep only the item's first `count` runs, in the read and in its progress. */
export function keepRuns(item: FactoryItem, count: number): FactoryItem {
  const progress = progressOf(item);
  return {
    ...item,
    runs: item.runs.slice(0, count),
    progress: { ...progress, runs: progress.runs.slice(0, count), running: null },
  };
}

/** Change the last run's status, outcome and failed step, in the read and in its progress. */
export function endLastRun(
  item: FactoryItem,
  status: FactoryItem['runs'][number]['status'],
  outcome: string | null,
  failedStep: string | null = null
): FactoryItem {
  const progress = progressOf(item);
  const runs = [...item.runs];
  const last = runs.at(-1);
  if (last === undefined) throw new Error('the item has no runs');
  runs[runs.length - 1] = { ...last, status, outcome };
  return {
    ...item,
    runs,
    progress: {
      ...progress,
      running: null,
      runs: progress.runs.map(run => (run.runId === last.id ? { ...run, failedStep } : run)),
    },
  };
}

/**
 * Real item 6 cut to its first run, a triage run, keyed `key`, as the server reads it once
 * triage parked it: completed with `park`, and its progress carrying the declared label and
 * the judge's reason.
 */
export function parkedByTriage(key = '6p'): FactoryItem {
  const item = endLastRun(keepRuns(realItem('6'), 1), 'completed', 'park');
  return {
    ...item,
    item: { ...item.item, key },
    progress: {
      ...progressOf(item),
      parked: { label: 'Parked by triage', why: 'Worth doing; measure it first.' },
    },
  };
}

/**
 * Real item 6 cut to its first run, keyed `key`, that run read as a completed run of
 * `workflow` with `outcome` (a triage that asked for shaping, a close carrying out your drop or
 * reshape), its progress carrying `awaits` as the server reads it for that outcome.
 */
export function lastRunAs(
  key: string,
  workflow: string,
  outcome: string,
  awaits: NonNullable<FactoryItem['progress']>['awaits'] = null
): FactoryItem {
  const item = endLastRun(keepRuns(realItem('6'), 1), 'completed', outcome);
  const progress = progressOf(item);
  return {
    ...item,
    item: { ...item.item, key },
    progress: {
      ...progress,
      runs: progress.runs.map(run => ({ ...run, workflow })),
      awaits,
    },
  };
}

/**
 * The progress `awaits` the server reads for `outcome` of `workflow` under the shipped view: its
 * declared label and `next`, with `why` and `questions` as the run's result gave them.
 */
export function declaredAwaits(
  key: string,
  why: string | null,
  questions: string[]
): NonNullable<NonNullable<FactoryItem['progress']>['awaits']> {
  const entry = VIEW.awaits?.[key];
  if (entry === undefined) throw new Error(`the shipped view declares no awaits ${key}`);
  return { label: entry.label, why, questions, next: entry.next ?? null };
}

/** Triage judged item `key` worth doing once a maintainer settles `questions`. */
export function needsShaping(key: string, questions: string[]): FactoryItem {
  return lastRunAs(
    key,
    'triage',
    'shape',
    declaredAwaits('triage:shape', 'Worth doing; the scope is open.', questions)
  );
}

/** Item 8 with its deliver run working `step` in round `iteration` of 3. */
export function delivering(step: string | null, iteration = 2): FactoryItem {
  const item = realItem('8');
  const progress = progressOf(item);
  const running = progress.running;
  if (running === null) throw new Error('item 8 is running in the fixture');
  item.progress = {
    ...progress,
    running: { ...running, step },
    round: {
      runId: running.runId,
      iteration,
      max: 3,
      rounds: (
        [
          { iteration: 1, verdict: 'returned', outcome: 'return' },
          { iteration: 2, verdict: 'running', outcome: null },
        ] as const
      ).slice(0, iteration),
    },
  };
  return item;
}

/** Item 7, merged, with a land run still running after it: the read's run and its progress. */
export function landRunning(): FactoryItem {
  const item = realItem('7');
  const last = item.runs.at(-1);
  if (last === undefined) throw new Error('item 7 has runs');
  item.runs = [...item.runs, { ...last, id: 'land-run', status: 'running', outcome: null }];
  const progress = progressOf(item);
  item.progress = {
    ...progress,
    runs: [...progress.runs, { runId: 'land-run', workflow: 'land', failedStep: null }],
    running: {
      runId: 'land-run',
      workflow: 'land',
      step: 'land',
      startedAt: '2026-11-17T04:29:00.000Z',
    },
  };
  return item;
}

/**
 * Real item 1 (ended ready, its change merged in the copy) keyed `key`, its change's merge
 * state set to `merged`: `pending` is what a cold server answers while it asks the host.
 */
export function readyWithMerge(
  key: string,
  merged: NonNullable<NonNullable<FactoryItem['progress']>['change']>['merged']
): FactoryItem {
  const item = realItem('1');
  const progress = progressOf(item);
  if (progress.change === null) throw new Error('item 1 has a change');
  item.item = { ...item.item, key };
  item.progress = { ...progress, change: { ...progress.change, merged, mergedAt: null } };
  return item;
}

/** A start queued for an item, as the items read carries one waiting for its turn. */
export function queuedStart(): FactoryItem['queued'][number] {
  return {
    requestId: 'request-1',
    workflow: 'plan',
    resource: 'item',
    hostId: 'host-1',
    queuedAt: '2026-11-18T11:00:00.000Z',
    ahead: 0,
    heldBehind: null,
    waitsForRunLimit: false,
  };
}

/** The item with every run ended at `completedAt`, as an item last worked then reads. */
export function endedAt(item: FactoryItem, completedAt: string): FactoryItem {
  return { ...item, runs: item.runs.map(run => ({ ...run, completedAt })) };
}

/**
 * Real item 6 cut to its triage run, keyed `key`, triage sending it to Plan and nothing run
 * since `completedAt`: a Waiting card in Plan that never proposed a change.
 */
export function idleInPlan(key: string, completedAt: string): FactoryItem {
  const item = endedAt(endLastRun(keepRuns(realItem('6'), 1), 'completed', 'build'), completedAt);
  return { ...item, item: { ...item.item, key }, progress: { ...progressOf(item), change: null } };
}
