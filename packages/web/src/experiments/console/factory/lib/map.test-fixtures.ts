import type { FactoryItem } from '../../skills/factory';
import { PAGE } from './board.test-fixtures';
import type { ChangeMerged } from './merge-pending';

type ItemRun = FactoryItem['runs'][number];
type Progress = NonNullable<FactoryItem['progress']>;

/** The arrow that starts deliver once plan ends `planned`, as the copy's runs name it. */
export const DELIVER_AFTER_PLAN =
  'Wirasm.archon-software-factory-coleam00-archon-factory-console-deliver-after-plan-planned-a996def02838';

/** What changed on one item between the board's read and the map's. */
interface Later {
  /** The run that was running, ended. */
  ended?: { runId: string; completedAt: string; outcome: string };
  /** A deliver run started since, working `step`. */
  started?: { id: string; startedAt: string; cause: ItemRun['cause']; step: string };
  progress: Pick<Progress, 'round' | 'returned' | 'change'>;
}

/**
 * The map's items: the board's copy (`PAGE`) read again later on 2026-11-17, when #6 had
 * started deliver, #5 and #4 had each ended a deliver run on an ask and started another,
 * and #8's deliver had ended ready and merged. #3 and #7 had not moved; #1 and #2 are not on
 * the map's read. Its rounds read as the API reads them now: that read's retired `ended`
 * verdict is `approved` where the round approved and `undecided` where it asked.
 */
const LATER: Record<string, Later | null> = {
  '6': {
    started: {
      id: '585ed621-5f63-4148-bb95-92cfb4c7f52a',
      startedAt: '2026-11-17T05:51:11.000Z',
      cause: {
        kind: 'run_ended',
        runId: '2e291009-82e8-4582-8b36-8dd45ec8ee7e',
        sourceInstanceId: DELIVER_AFTER_PLAN,
      },
      step: 'hostrounds.host__host',
    },
    progress: {
      round: {
        runId: '585ed621-5f63-4148-bb95-92cfb4c7f52a',
        iteration: 2,
        max: 3,
        rounds: [
          { iteration: 1, verdict: 'returned', outcome: 'return' },
          { iteration: 2, verdict: 'approved', outcome: 'approve' },
        ],
      },
      returned: 1,
      change: null,
    },
  },
  '5': {
    ended: {
      runId: 'f4e603d9-bdeb-4614-a411-77e76eb77777',
      completedAt: '2026-11-17T06:44:47.000Z',
      outcome: 'ask',
    },
    started: {
      id: '51eabc58-ef89-48ce-8823-73b116722c23',
      startedAt: '2026-11-17T07:23:05.000Z',
      cause: {
        kind: 'receipt',
        receiptId: '1e03f388-4307-47ae-acf4-cccb2a169e9e',
        sourceInstanceId: 'fc-start-deliver',
      },
      step: 'build__build',
    },
    progress: {
      round: {
        runId: 'f4e603d9-bdeb-4614-a411-77e76eb77777',
        iteration: 2,
        max: 3,
        rounds: [
          { iteration: 1, verdict: 'returned', outcome: 'return' },
          { iteration: 2, verdict: 'undecided', outcome: 'ask' },
        ],
      },
      returned: 1,
      change: {
        url: 'https://github.com/coleam00/archon-factory-console/pull/17',
        number: null,
        merged: 'unknown',
        mergedAt: null,
      },
    },
  },
  '4': {
    ended: {
      runId: 'fdef09db-c751-43a0-9eb5-c6386b8f8b60',
      completedAt: '2026-11-17T06:41:56.000Z',
      outcome: 'ask',
    },
    started: {
      id: '624c763f-4f33-46ea-aa65-bb1ba78c1eec',
      startedAt: '2026-11-17T06:44:47.000Z',
      cause: {
        kind: 'receipt',
        receiptId: '0a1a1da2-4000-4731-a999-2af68e3875f5',
        sourceInstanceId: 'fc-start-deliver',
      },
      step: 'rounds.tests__tests',
    },
    progress: {
      round: {
        runId: '624c763f-4f33-46ea-aa65-bb1ba78c1eec',
        iteration: 1,
        max: 3,
        rounds: [{ iteration: 1, verdict: 'running', outcome: null }],
      },
      returned: 1,
      change: {
        url: 'https://github.com/coleam00/archon-factory-console/pull/16',
        number: null,
        merged: 'unknown',
        mergedAt: null,
      },
    },
  },
  '8': {
    ended: {
      runId: '3696a51b-3a35-4f62-8aa2-3f4bf1d726b4',
      completedAt: '2026-11-17T05:51:11.000Z',
      outcome: 'ready',
    },
    progress: {
      round: {
        runId: '3696a51b-3a35-4f62-8aa2-3f4bf1d726b4',
        iteration: 1,
        max: 3,
        rounds: [{ iteration: 1, verdict: 'approved', outcome: 'approve' }],
      },
      returned: 1,
      change: {
        url: 'https://github.com/coleam00/archon-factory-console/pull/15',
        number: null,
        merged: true,
        mergedAt: '2026-11-17T05:54:48Z',
      },
    },
  },
  '3': null,
  '7': null,
};

function readLater(item: FactoryItem, later: Later | null): FactoryItem {
  if (later === null) return item;
  const { ended, started } = later;
  const runs = item.runs.map(entry =>
    entry.id === ended?.runId
      ? {
          ...entry,
          status: 'completed' as const,
          outcome: ended.outcome,
          completedAt: ended.completedAt,
        }
      : entry
  );
  if (started !== undefined) {
    const { step: _step, ...fields } = started;
    runs.push({
      ...(item.runs.at(-1) as ItemRun),
      workflow: 'Wirasm/archon-software-factory:deliver',
      status: 'running',
      outcome: null,
      completedAt: null,
      ...fields,
    });
  }
  const progress = item.progress as Progress;
  return {
    ...item,
    runs,
    progress: {
      ...progress,
      ...later.progress,
      running:
        started === undefined
          ? null
          : {
              runId: started.id,
              workflow: 'deliver',
              step: started.step,
              startedAt: started.startedAt,
            },
      runs:
        started === undefined
          ? progress.runs
          : [...progress.runs, { runId: started.id, workflow: 'deliver', failedStep: null }],
    },
  };
}

const seeded = Object.entries(LATER).map(([key, later]) => {
  const item = PAGE.items.find(entry => entry.item.key === key);
  if (item === undefined) throw new Error(`the board's copy has no item ${key}`);
  return readLater(structuredClone(item), later);
});

/** A real item from the seeded console home, by its key. */
export function realItem(key: string): FactoryItem {
  const item = seeded.find(entry => entry.item.key === key);
  if (item === undefined) throw new Error(`No fixture item ${key}`);
  return structuredClone(item);
}

/** One run of a declared workflow, as a test describes it. */
export interface TestRun {
  workflow: string;
  status: ItemRun['status'];
  outcome?: string | null;
  /** The running step, for a running run. */
  step?: string | null;
}

export const run = (
  workflow: string,
  status: ItemRun['status'],
  outcome: string | null = null,
  step: string | null = null
): TestRun => ({ workflow, status, outcome, step });

/**
 * Item `key` with `runs` in start order, read as the items read returns it: the runs on the
 * item read with their recorded names, and `progress.runs` and `running` with the declared ones.
 */
export function itemWith(
  key: string,
  runs: readonly TestRun[],
  merged: ChangeMerged | null = null
): FactoryItem {
  const base = realItem('6');
  const template = base.runs[0] as ItemRun;
  const ids = runs.map((_, index) => `run-${key}-${index.toString()}`);
  const runningIndex = runs.map(entry => entry.status).lastIndexOf('running');
  const running = runs[runningIndex];
  const progress: Progress = {
    ...(base.progress as Progress),
    runs: runs.map((entry, index) => ({
      runId: ids[index] ?? '',
      workflow: entry.workflow,
      failedStep: null,
    })),
    running:
      running === undefined
        ? null
        : {
            runId: ids[runningIndex] ?? '',
            workflow: running.workflow,
            step: running.step ?? null,
            startedAt: '2026-11-17T05:00:00.000Z',
          },
    change:
      merged === null
        ? null
        : { url: 'https://example.test/pull/1', merged, mergedAt: null, number: 1 },
  };
  return {
    ...base,
    item: { ...base.item, id: `item-${key}`, key },
    runs: runs.map((entry, index) => ({
      ...template,
      id: ids[index] ?? '',
      workflow: `Wirasm/archon-software-factory:${entry.workflow}`,
      status: entry.status,
      outcome: entry.outcome ?? null,
    })),
    progress,
  };
}

/** Item `key` whose progress the server could not derive. */
export function itemWithoutProgress(key: string): FactoryItem {
  const base = realItem('6');
  return { ...base, item: { ...base.item, id: `item-${key}`, key }, progress: null };
}

/*
 * Synthetic: the live factory has not yet restarted a stage on settled asks. Each item's first
 * run left three asks, answered and withdrawn at `settledAt`, which closes the set; `restarted`
 * adds the run the settling started.
 */
export function settledItem(
  key: string,
  asking: TestRun,
  settledAt: string,
  restarted?: TestRun
): FactoryItem {
  const item = itemWith(key, restarted === undefined ? [asking] : [asking, restarted]);
  const askingId = item.runs[0]?.id ?? '';
  return {
    ...item,
    runs: item.runs.map((entry, index) =>
      index === 1 ? { ...entry, cause: { kind: 'asks_settled', runId: askingId } } : entry
    ),
    answers: [
      // The set's asks: two answered and one withdrawn, as its settled entry counts them.
      ...(['approve', 'split', null] as const).map((chosen, index) => ({
        kind: 'ask' as const,
        runId: askingId,
        node: null,
        occurrence: null,
        at: settledAt,
        via: 'cli',
        ref: `ask:${key}-${index.toString()}`,
        question: `Question ${(index + 1).toString()} on ${key}?`,
        answer: null,
        chosen: chosen === null ? null : { id: chosen, does: `Does ${chosen}.` },
        withdrawn: chosen === null,
        by: { declared: 'cole-owner' },
        fromRun: null,
      })),
      {
        kind: 'asks_settled',
        runId: askingId,
        node: null,
        occurrence: null,
        at: settledAt,
        via: null,
        answered: 2,
        withdrawn: 1,
      },
    ],
  };
}
