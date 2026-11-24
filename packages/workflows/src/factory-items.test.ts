import { describe, expect, test } from 'bun:test';
import {
  PACK,
  type RunFixture as Entry,
  runFixture,
  shippedView,
} from './factory-test.test-helpers';
import {
  factoryProgressSchema,
  FactoryRunFactsMemo,
  factoryItemDetailSchema,
  readFactoryItem,
  readFactoryProgress,
  type FactoryChangeState,
  type FactoryItemProgress,
  type FactoryRound,
} from './factory-items';
import { factoryRunStory } from './factory-item-story';
import type { ItemReadSource } from './item-read';
import type { FactoryView } from './schemas/factory-view';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { WorkflowRun } from './schemas/workflow-run';

// The declaration this repository ships for the pack the fixtures' runs come from.
const view = shippedView();
/** Runs copied from the live factory database (see each file's `note`), data trimmed. */
const fixture = (name: string): Entry => runFixture('factory-items', name);

const triage1 = fixture('item-1-triage-88640c6d');
const plan1 = fixture('item-1-plan-147ff872');
const deliver1 = fixture('item-1-deliver-c90ebf41');
const deliver2 = fixture('item-2-deliver-934682d0');
/**
 * The same run as it stood mid-round: only its events up to order 1800, and the run set back
 * to running with no outcome.
 */
const deliver2Cut: Entry = {
  run: { ...deliver2.run, status: 'running', completed_outcome: null, completed_at: null },
  events: deliver2.events.filter(row => (row.event_order ?? Infinity) <= 1800),
};

/** Each round's verdict and decision: what the board reads of a run's rounds. */
const decisions = (rounds: { max: number | null; rounds: FactoryRound[] } | null | undefined) =>
  rounds === null || rounds === undefined
    ? rounds
    : {
        max: rounds.max,
        rounds: rounds.rounds.map(({ iteration, verdict, outcome }) => ({
          iteration,
          verdict,
          outcome,
        })),
      };

const PR10 = 'https://github.com/coleam00/archon-factory-console/pull/10';
const PR11 = 'https://github.com/coleam00/archon-factory-console/pull/11';
const PR12 = 'https://github.com/coleam00/archon-factory-console/pull/12';

type ItemMerge = Awaited<ReturnType<ItemReadSource['store']['getItemMerge']>>;
type Counts = { queue: number; loaded: string[][] };

/**
 * The store the readers read, holding each key's runs (as item `item-<key>`) and their events.
 * `counts` records each read of the facts' events (by the run ids asked) and of the attention
 * queue; `broken` names a run whose events the node fold refuses, so its facts cannot be derived.
 */
function sourceFor(
  runsByKey: Record<string, Entry[]>,
  opts: {
    merge?: (itemId: string) => ItemMerge;
    branchOf?: ItemReadSource['branchOf'];
    broken?: string;
    counts?: Counts;
  } = {}
): ItemReadSource {
  const counts = opts.counts ?? { queue: 0, loaded: [] };
  const events = new Map(
    Object.values(runsByKey)
      .flat()
      .map(entry => [entry.run.id, entry.events])
  );
  return {
    branchOf: opts.branchOf ?? (async () => null),
    store: {
      getItemRuns: async (projectKey, key) => {
        const entries = runsByKey[key];
        if (entries === undefined) return null;
        const item = { id: `item-${key}`, projectKey, key };
        const runs = entries.map(entry => ({ ...entry.run, item_id: item.id }));
        return { item, runs, descendantIds: [] };
      },
      listEventsForRuns: async (ids, types) => {
        // The item read asks for answers too; count only the facts' reads.
        if (types.includes('loop_iteration_started')) counts.loaded.push([...ids]);
        return new Map(
          ids.map(id => {
            const rows = events.get(id) ?? [];
            const bad = { ...rows[0]!, step_name: 'x', data: { node: 'broken' } };
            return [id, id === opts.broken ? [bad as WorkflowEventRow] : rows];
          })
        );
      },
      listAttentionQueueRows: async () => {
        counts.queue++;
        return [];
      },
      getWorkflowRun: async () => null,
      getWorkflowRunForAttention: async () => null,
      getCodebase: async () => null,
      getItem: async () => null,
      getItemMerge: async itemId => opts.merge?.(itemId) ?? null,
      getItemLanding: async () => null,
      listOpenItemWaits: async () => [],
      listSkippedItemStarts: async itemIds => new Map(itemIds.map(id => [id, []])),
      listQueuedItemStarts: async itemIds => new Map(itemIds.map(id => [id, []])),
      getInstallHold: async () => null,
      getRunLimit: async () => null,
      listHeldItemStarts: async () => [],
      listItemAsks: async () => [],
      listItemRulings: async () => [],
      listItemLinks: async () => [],
      getResourceStartRequest: async () => null,
      listStartReceiptSources: async () => new Map(),
    },
  };
}

const notMerged: FactoryChangeState = async lookup => ({
  url: lookup.kind === 'url' ? lookup.url : null,
  merged: false,
  mergedAt: null,
  number: null,
});

const unexpected = (id: string, error: unknown) => {
  throw new Error(`unexpected failure for ${id}: ${String(error)}`);
};

interface ReadOptions {
  view?: FactoryView;
  changeState?: FactoryChangeState;
  memo?: FactoryRunFactsMemo;
  onProgressError?: (id: string, error: unknown) => void;
}

const inputFor = (opts: ReadOptions = {}) => ({
  view: opts.view ?? view,
  pack: PACK,
  projectKey: 'acme/web',
  changeState: opts.changeState ?? notMerged,
  memo: opts.memo ?? new FactoryRunFactsMemo(),
  onProgressError: opts.onProgressError ?? unexpected,
});

/** Item 1 holding `entries`, read whole: its progress, its run rows and the detail. */
async function readItem(
  entries: Entry[],
  opts: ReadOptions & Parameters<typeof sourceFor>[1] = {}
) {
  const detail = await readFactoryItem(sourceFor({ '1': entries }, opts), inputFor(opts), '1');
  if (detail === null) throw new Error('item 1 reads');
  const progress = detail.item.progress;
  if (progress === null) throw new Error("item 1's progress reads");
  return { progress, runs: detail.runs, detail };
}

const progressOf = async (entries: Entry[], opts: Parameters<typeof readItem>[1] = {}) =>
  (await readItem(entries, opts)).progress;

/** Each round as `verdict:outcome`, in iteration order. */
const verdicts = (rounds: { rounds: FactoryRound[] } | null | undefined) =>
  rounds?.rounds.map(round => `${round.verdict}:${round.outcome}`) ?? null;

const { approves: _approves, ...noApproves } = view;

describe("a run's rounds, returns, change and running step", () => {
  const two = ['returned:return', 'approved:approve'];
  const undecided = ['returned:return', 'undecided:approve'];
  test.each<[string, Entry, FactoryView, string[], number, string | null, string | null]>([
    ['two rounds: returned, then approved', deliver1, view, two, 2, PR10, null],
    [
      // `rounds` and the three checks run at once; the checks are deeper, review started last.
      // No terminal record yet, so no change at the declared pointer.
      'cut mid-round: the deepest, latest started step runs and no change is named yet',
      deliver2Cut,
      view,
      ['returned:return', 'running:null'],
      1,
      null,
      'rounds.review__review',
    ],
    [
      'without a declared approval, a completed round is undecided, never approved',
      deliver1,
      noApproves,
      undecided,
      2,
      PR10,
      null,
    ],
  ])('%s', async (_name, entry, declared, rounds, returned, change, step) => {
    const { progress, runs } = await readItem([entry], { view: declared });
    expect(runs.map(run => [verdicts(run.rounds), run.change, run.step])).toEqual([
      [rounds, change, step],
    ]);
    expect(progress.returned).toBe(returned);
  });

  test('a failed run names the step that failed', async () => {
    const started = [...deliver2Cut.events]
      .reverse()
      .find(row => row.event_type === 'node_started' && row.step_name === 'rounds.review__review');
    if (started === undefined) throw new Error('the cut fixture starts the review step');
    const failed: WorkflowEventRow = {
      ...started,
      id: 'failed-review',
      event_type: 'node_failed',
      data: { ...started.data, error: 'boom' },
      event_order: (started.event_order ?? 0) + 1000,
    };
    const progress = await progressOf([
      { run: { ...deliver2Cut.run, status: 'failed' }, events: [...deliver2Cut.events, failed] },
    ]);
    expect(progress.runs.map(run => run.failedStep)).toEqual(['rounds.review__review']);
  });

  test('an item with only triage and plan: no round, return, change or work order, and nothing asked', async () => {
    const { progress, runs } = await readItem([triage1, plan1], {
      changeState: async () => {
        throw new Error('nothing to look up');
      },
      branchOf: async () => {
        throw new Error('no branch is read before a deliver names a change');
      },
    });
    expect(progress).toMatchObject({
      title: 'The live-home guard and dev:console have tests',
      running: null,
      round: null,
      partOf: null,
      returned: 0,
      change: null,
      parked: null,
      awaits: null,
    });
    expect(runs.map(run => [run.rounds, run.change, run.step])).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
    // Triage's one declared shadow step decided (its old split step is no shadow the view
    // declares: split is a workflow of its own now); plan has none.
    expect(runs.map(run => run.shadows.map(decision => decision.node))).toEqual([['admit'], []]);
  });
});

describe("each round's steps", () => {
  const roundsOf = async (entry: Entry) => (await readItem([entry])).runs[0]?.rounds?.rounds ?? [];
  const stepsOf = (rounds: FactoryRound[], iteration: number) =>
    rounds
      .find(round => round.iteration === iteration)
      ?.steps.map(step => [step.node, step.outcome]);

  test('a round lists the loop steps that recorded an outcome, in recording order', async () => {
    const rounds = await roundsOf(deliver2);
    expect(stepsOf(rounds, 1)).toEqual([
      ['rounds.tests__tests', 'return'],
      ['rounds.product__product', 'approve'],
      ['rounds.review__review', 'approve'],
      ['rounds.verdict__verdict', 'return'],
    ]);
    // Round 1's fix was skipped and the base step records no outcome; neither is a step.
    expect(stepsOf(rounds, 2)).toEqual([
      ['rounds.fix', 'fixed'],
      ['rounds.tests__tests', 'return'],
      ['rounds.product__product', 'approve'],
      ['rounds.review__review', 'approve'],
      ['rounds.verdict__verdict', 'return'],
    ]);
    expect(stepsOf(rounds, 3)?.at(-1)).toEqual(['rounds.verdict__verdict', 'approve']);
  });
});

/**
 * `entry` as run `id` started at `at`, with `fields` over its row and its result's value
 * replaced by `value(recorded)`, as the live factory's runs record a result.
 */
function withResult(
  entry: Entry,
  id: string,
  at: string,
  value: (recorded: Record<string, unknown>) => Record<string, unknown>,
  fields: Partial<WorkflowRun> = {}
): Entry {
  const events = entry.events.map(row => {
    if (row.event_type !== 'workflow_completed') return row;
    const data = row.data as {
      terminal_record: { returns: { value?: Record<string, unknown> } };
    };
    const returns = data.terminal_record.returns;
    // As a store holds it: a key whose value is undefined is absent.
    const next = JSON.parse(JSON.stringify(value(returns.value ?? {}))) as unknown;
    const terminal_record = { ...data.terminal_record, returns: { ...returns, value: next } };
    return { ...row, workflow_run_id: id, data: { ...data, terminal_record } };
  });
  return { run: { ...entry.run, id, started_at: new Date(at), ...fields }, events };
}

/** An order run: the triage fixture under the pack's `order` workflow, naming `partOf`. */
function orderRun(
  id: string,
  partOf: unknown,
  at: string,
  status: WorkflowRun['status'] = 'completed',
  outcome = 'ready'
): Entry {
  return withResult(
    triage1,
    id,
    at,
    () => ({ outcome, item: id, land_on: '', part_of: partOf, why: '' }),
    {
      status,
      completed_outcome: status === 'completed' ? outcome : null,
      workflow_name: `${PACK}:order`,
    }
  );
}

/** A triage run completed with `recommend`, its result giving `why`. */
function triageRun(
  id: string,
  recommend: string,
  why: unknown,
  at: string,
  rest: Record<string, unknown> = {}
): Entry {
  return withResult(triage1, id, at, () => ({ recommend, why, ...rest }), {
    completed_outcome: recommend,
  });
}

/** `entry`, a deliver run, as run `id` at `at`, its result naming `change` at the pointer. */
function deliverNaming(entry: Entry, id: string, change: unknown, at: string): Entry {
  return withResult(entry, id, at, recorded => ({ ...recorded, change }));
}

describe("an item's work order, from its order runs' results", () => {
  const DAY1 = '2026-11-16T00:00:00Z';
  const DAY2 = '2026-11-17T00:00:00Z';
  const DAY3 = '2026-11-18T00:00:00Z';
  test.each<[string, Entry[], FactoryView, string | null]>([
    [
      'the newest completed order run names it, trimmed',
      [orderRun('o1', '40', DAY1), orderRun('o2', ' 48 ', DAY2)],
      view,
      '48',
    ],
    [
      'a failed or running order run is not read; the newest completed one is',
      [
        orderRun('o1', '48', DAY1),
        orderRun('o2', '50', DAY2, 'failed'),
        orderRun('o3', '51', DAY3, 'running'),
      ],
      view,
      '48',
    ],
    [
      'a refused order run is not read when it is newest',
      [orderRun('o1', '48', DAY1), orderRun('o2', '50', DAY2, 'completed', 'refused')],
      view,
      '48',
    ],
  ])('%s', async (_name, entries, declared, expected) => {
    expect((await progressOf(entries, { view: declared })).partOf).toBe(expected);
  });
});

describe('what the last declared run leaves the item: parked, or waiting on a person', () => {
  const DAY1 = '2026-11-16T00:00:00Z';
  const DAY2 = '2026-11-17T00:00:00Z';
  const SHAPE_NEXT = view.awaits?.['triage:shape']?.next ?? null;
  const parkedBy = (why: string | null) => ({ label: 'Parked by triage', why });
  const shaping = (why: string, questions: string[]) => ({
    label: 'Needs shaping',
    why,
    questions,
    next: SHAPE_NEXT,
  });
  const build = triageRun('t2', 'build', 'Now.', DAY2);
  type Left = Pick<FactoryItemProgress, 'parked' | 'awaits'>;
  test.each<[string, Entry[], Left]>([
    [
      'a triage run that parked it: the declared label and its why, trimmed',
      [triageRun('t1', 'park', ' Measure it first. ', DAY1)],
      { parked: parkedBy('Measure it first.'), awaits: null },
    ],
    [
      'a run after the parking one takes the item up',
      [triageRun('t1', 'park', 'Later.', DAY1), build],
      { parked: null, awaits: null },
    ],
    [
      'a triage run that asked for shaping: the label, its why and its open questions',
      [
        triageRun('t1', 'shape', ' Worth doing. ', DAY1, {
          open_questions: [' Which surfaces? ', '', 7, 'Who owns it?'],
        }),
      ],
      { parked: null, awaits: shaping('Worth doing.', ['Which surfaces?', 'Who owns it?']) },
    ],
  ])('%s', async (_name, entries, expected) => {
    const progress = await progressOf(entries);
    expect({ parked: progress.parked, awaits: progress.awaits }).toEqual(expected);
  });
});

const MERGED_AT = '2026-11-17T01:00:00.000Z';
const MERGE: ItemMerge = {
  change: PR10,
  commit: null,
  at: MERGED_AT,
  recordedAt: '2026-11-17T01:01:00.000Z',
  via: 'cli',
  fromRun: null,
};

describe("an item's change", () => {
  test("the change lookup gets the declared runs' branches, newest first, once each", async () => {
    // The newest declared run has its own branch; two older declared runs share one, so it
    // is read once. A newer run of a workflow the view does not declare has no facts and
    // its branch is never offered.
    const later = {
      ...deliver1,
      run: { ...deliver1.run, id: 'later', started_at: new Date('2027-01-01') },
    };
    const undeclared = {
      ...deliver1,
      run: {
        ...deliver1.run,
        id: 'undeclared',
        workflow_name: 'someone/else:deliver',
        started_at: new Date('2027-02-01'),
      },
    };
    const recorded: Record<string, string | null> = {
      [triage1.run.id]: null,
      [plan1.run.id]: 'shared',
      [deliver1.run.id]: 'shared',
      later: 'later-branch',
      undeclared: 'other',
    };
    const read: string[][] = [];
    await readItem([triage1, plan1, deliver1, later, undeclared], {
      branchOf: async run => recorded[run.id] ?? null,
      changeState: async (_lookup, branches) => {
        read.push([...(await branches())]);
        return { url: PR10, merged: false, mergedAt: null, number: null };
      },
    });
    expect(read).toEqual([['later-branch', 'shared']]);
  });

  test('a recorded merge on an item no run names a change for is its change, merged, unasked', async () => {
    const asked: unknown[] = [];
    const { progress } = await readItem([triage1, plan1], {
      merge: () => MERGE,
      branchOf: async () => 'a-branch',
      changeState: async lookup => {
        asked.push(lookup);
        return { url: null, merged: false, mergedAt: null, number: null };
      },
    });
    expect(asked).toEqual([]);
    expect(progress.change).toEqual({ url: PR10, merged: true, mergedAt: MERGED_AT, number: null });
  });

  const PR59 = 'https://github.com/coleam00/archon-factory-console/pull/59';
  const empty = deliverNaming(deliver1, 'deliver-empty', '', '2026-12-01T00:00:00Z');
  test.each<
    [string, Entry[], ItemReadSource['branchOf'], unknown[], FactoryItemProgress['change']]
  >([
    [
      "an empty URL: the pull request on the item's branches",
      [triage1, plan1, empty],
      async run => `branch-${run.id}`,
      [
        {
          lookup: { kind: 'branch', run: 'deliver-empty' },
          branches: ['branch-deliver-empty', `branch-${plan1.run.id}`, `branch-${triage1.run.id}`],
        },
      ],
      { url: PR59, merged: true, mergedAt: '2026-11-18T20:00:00Z', number: 59 },
    ],
  ])('%s', async (_name, entries, branchOf, asked, change) => {
    const seen: unknown[] = [];
    const { progress, runs } = await readItem(entries, {
      branchOf,
      changeState: async (lookup, branches) => {
        seen.push(
          lookup.kind === 'url' ? lookup.url : { lookup, branches: [...(await branches())] }
        );
        return { url: PR59, merged: true, mergedAt: '2026-11-18T20:00:00Z', number: 59 };
      },
    });
    expect(seen).toEqual(asked);
    expect(progress.change).toEqual(change);
    // A blank URL names no change on its run's row.
    expect(runs.at(-1)?.change ?? null).toBeNull();
  });

  test('returned counts every run that sent the item back; round and change are the latest run', async () => {
    const later = { ...deliver2.run, started_at: new Date('2027-01-01T00:00:00Z') };
    const progress = await progressOf([deliver1, { ...deliver2, run: later }]);
    // Two returns on each deliver run.
    expect(progress.returned).toBe(4);
    expect(progress.round?.runId).toBe(deliver2.run.id);
    expect(progress.change?.url).toBe(PR11);
  });
});

/** A copy of a fixture run with its own id, workflow and inputs, started `laterMs` after it. */
function withInputs(
  entry: Entry,
  id: string,
  workflowName: string,
  laterMs: number,
  inputs: Record<string, string>
): Entry {
  return {
    run: {
      ...entry.run,
      id,
      workflow_name: workflowName,
      metadata: { inputs },
      started_at: new Date(entry.run.started_at.getTime() + laterMs),
    },
    events: [],
  };
}

/** The item text an order stage produced for a work order naming an issue, as the live copy holds it. */
const ORDERED_ITEM = [
  '---',
  'id: 36',
  'source: https://github.com/coleam00/archon-factory-console/issues/36',
  '---',
  '',
  '# Items started by a work order show their title',
  '',
  'Since items start with a work order...',
].join('\n');

describe("an item text's title", () => {
  const titled = (item: string): Entry[] => [
    withInputs(triage1, 'triage-run', triage1.run.workflow_name, 0, { item }),
  ];
  test.each<[string, Entry[], string | null]>([
    [
      // An older run carries another text; the triage run after it carries the item text the
      // order stage produced; the newest, an order run, carries the work order and no item.
      'an item an order started: the newest run that has an item text',
      [
        withInputs(triage1, 'older-run', triage1.run.workflow_name, 0, { item: 'An old title' }),
        withInputs(triage1, 'triage-run', triage1.run.workflow_name, 60_000, {
          item: ORDERED_ITEM,
        }),
        withInputs(triage1, 'order-run', `${PACK}:order`, 120_000, {
          key: '36',
          source: 'https://github.com/coleam00/archon-factory-console/issues/36',
        }),
      ],
      'Items started by a work order show their title',
    ],
    ['unterminated front matter: none', titled('---\nid: 1\n'), null],
  ])('%s', async (_name, entries, title) => {
    expect((await progressOf(entries)).title).toBe(title);
  });
});

describe('the facts memo, across reads', () => {
  test('ended runs are kept and only a running one is loaded again; a run that ended again is reloaded', async () => {
    const counts: Counts = { queue: 0, loaded: [] };
    const input = inputFor();
    const read = (one: Entry[]) =>
      readFactoryProgress(sourceFor({ '1': one, '2': [deliver2Cut] }, { counts }), input, [
        '1',
        '2',
      ]);
    await read([triage1, plan1, deliver1]);
    // Every declared run's events in one read.
    expect(counts.loaded).toEqual([
      [triage1.run.id, plan1.run.id, deliver1.run.id, deliver2Cut.run.id],
    ]);
    await read([triage1, plan1, deliver1]);
    expect(counts.loaded.at(-1)).toEqual([deliver2Cut.run.id]);
    const resumed = { ...deliver1.run, completed_at: new Date('2026-11-18T00:00:00Z') };
    await read([triage1, plan1, { ...deliver1, run: resumed }]);
    expect(counts.loaded.at(-1)).toEqual([deliver1.run.id, deliver2Cut.run.id]);
  });
});

describe('the readers', () => {
  // The fixtures' metadata is trimmed; real runs record their cost under this key.
  const costed = {
    ...deliver1,
    run: { ...deliver1.run, metadata: { ...deliver1.run.metadata, total_cost_usd: 13.5 } },
  };
  const item1 = [triage1, plan1, costed];

  test('progress for each asked key, once; an unknown key left out; the attention queue unread', async () => {
    const counts: Counts = { queue: 0, loaded: [] };
    const source = sourceFor({ '1': item1, '2': [deliver2Cut] }, { counts });
    const read = factoryProgressSchema.parse(
      await readFactoryProgress(source, inputFor(), ['2', '1', '404', '2'])
    );
    expect(read.pack).toBe(PACK);
    expect(Object.keys(read.progress).sort()).toEqual(['1', '2']);
    expect(read.members).toEqual({ '1': [], '2': [] });
    expect(counts.queue).toBe(0);
    expect(await readFactoryItem(source, inputFor(), '404')).toBeNull();
  });

  test("one item's facts failing gives it null progress and leaves the others", async () => {
    const failed: string[] = [];
    const read = await readFactoryProgress(
      sourceFor({ '1': item1, '2': [deliver2Cut] }, { broken: deliver2Cut.run.id }),
      inputFor({ onProgressError: id => failed.push(id) }),
      ['1', '2']
    );
    expect(read.progress['2']).toBeNull();
    expect(read.progress['1']).not.toBeNull();
    expect(failed).toEqual(['item-2']);
  });

  test('item 1 whole: its progress, and each run with its rounds, change and story', async () => {
    const counts: Counts = { queue: 0, loaded: [] };
    const seen: [string, number][] = [];
    const audits = deliver1.events.filter(row => row.event_type === 'integration_operation');
    const raw = await readFactoryItem(
      sourceFor({ '1': item1 }, { counts }),
      inputFor({
        changeState: async lookup => {
          if (lookup.kind === 'url') seen.push([lookup.url, lookup.audits.length]);
          // The forge's URL is not shown on the URL path: the run's is.
          return { url: null, merged: true, mergedAt: '2026-11-17T01:00:00Z', number: 10 };
        },
      }),
      '1'
    );
    // Parsing strips keys the schema does not name, so the board rounds' shape is read on `raw`.
    const detail = factoryItemDetailSchema.parse(raw);
    expect(detail.pack).toBe(PACK);
    expect(counts.queue).toBe(1);
    // The run's forge audit rows reach the lookup with its URL.
    expect(audits.length).toBeGreaterThan(0);
    expect(seen).toEqual([[PR10, audits.length]]);
    expect(detail.item.progress).toEqual({
      title: 'The live-home guard and dev:console have tests',
      running: null,
      round: {
        runId: deliver1.run.id,
        iteration: 2,
        max: 3,
        rounds: [
          { iteration: 1, verdict: 'returned', outcome: 'return' },
          { iteration: 2, verdict: 'approved', outcome: 'approve' },
        ],
      },
      partOf: null,
      returned: 2,
      change: { url: PR10, merged: true, mergedAt: '2026-11-17T01:00:00Z', number: 10 },
      // As the view declares each workflow, not as the runs record `owner/name:workflow`.
      runs: [
        { runId: triage1.run.id, workflow: 'triage', failedStep: null },
        { runId: plan1.run.id, workflow: 'plan', failedStep: null },
        { runId: deliver1.run.id, workflow: 'deliver', failedStep: null },
      ],
      shadows: detail.runs[0]?.shadows,
      parked: null,
      awaits: null,
    });
    expect(detail.item.runs.map(run => run.id)).toEqual(detail.runs.map(run => run.runId));
    expect(detail.runs.map(run => [run.workflow, run.costUsd, run.step])).toEqual([
      ['triage', null, null],
      ['plan', null, null],
      ['deliver', 13.5, null],
    ]);
    expect(detail.runs.map(run => run.rounds?.rounds.length ?? null)).toEqual([null, null, 2]);
    // The board's rounds are the latest deliver run's, without steps or summaries.
    const deliver = detail.runs[2];
    expect(decisions(raw?.runs[2]?.rounds)?.rounds).toEqual(raw?.item.progress?.round?.rounds);
    expect(Object.keys(raw?.item.progress?.round?.rounds[0] ?? {}).sort()).toEqual([
      'iteration',
      'outcome',
      'verdict',
    ]);
    // Each run carries the change it named, what it said, its models and its step starts.
    expect(detail.runs.map(run => run.change)).toEqual([null, null, PR10]);
    for (const [index, entry] of item1.entries())
      expect(detail.runs[index]).toMatchObject(factoryRunStory(view, entry.run, entry.events));
    expect(deliver?.said).not.toBeNull();
    expect(deliver?.steps[0]?.node).toBe('build__build');
  });

  test('a running run: its row shows the running step and no cost; progress names it running', async () => {
    const { progress, runs } = await readItem([deliver2Cut]);
    expect(progress.running).toEqual({
      runId: deliver2Cut.run.id,
      workflow: 'deliver',
      step: 'rounds.review__review',
      startedAt: deliver2Cut.run.started_at.toISOString(),
    });
    expect(progress.round?.iteration).toBe(2);
    expect(runs).toEqual([
      {
        runId: deliver2Cut.run.id,
        workflow: 'deliver',
        costUsd: null,
        step: 'rounds.review__review',
        rounds: expect.objectContaining({ max: 3 }),
        shadows: [],
        // Still running: it has named no change and returned nothing to say yet.
        change: null,
        said: null,
        models: ['claude-opus-5-5', 'claude-haiku-5-5'],
        steps: factoryRunStory(view, deliver2Cut.run, deliver2Cut.events).steps,
      },
    ]);
  });
});

/**
 * A run of a three-stage delivery workflow (`stage-build`, `stage-check`, `stage-host`,
 * `landgate`), built from the plan fixture's events: each of `nodes` completes with its
 * structured `outcome`, and a completed run returns `value` from its `end` step, as the
 * installed pack's stage workflows do. A running run has no terminal record.
 */
function stageRun(
  workflow: string,
  id: string,
  at: string,
  value: Record<string, unknown>,
  nodes: readonly (readonly [string, string])[] = [],
  status: WorkflowRun['status'] = 'completed'
): Entry {
  const [started, completed, finished] = plan1.events as [
    WorkflowEventRow,
    WorkflowEventRow,
    WorkflowEventRow,
  ];
  type NodeData = { node: Record<string, unknown>; invocation: Record<string, unknown> };
  const nodeRow = (
    row: WorkflowEventRow,
    node: string,
    order: number,
    output?: unknown
  ): WorkflowEventRow => {
    const data = row.data as NodeData;
    return {
      ...row,
      id: `${id}-${node}-${row.event_type}`,
      workflow_run_id: id,
      step_name: node,
      event_order: order,
      data: {
        ...data,
        node: { ...data.node, id: node },
        invocation: { ...data.invocation, id: `${id}-${node}` },
        ...(output === undefined ? {} : { structured_output: output }),
      },
    };
  };
  const done = status === 'completed';
  const ran = [...nodes, ...(done ? [['end', String(value.outcome)] as const] : [])];
  const events: WorkflowEventRow[] = ran.flatMap(([node, outcome], index) => [
    nodeRow(started, node, 2 * index),
    nodeRow(completed, node, 2 * index + 1, { outcome, summary: `${node} said ${outcome}` }),
  ]);
  if (done) {
    const data = finished.data as { terminal_record: Record<string, unknown> };
    events.push({
      ...finished,
      id: `${id}-completed`,
      workflow_run_id: id,
      event_order: 2 * ran.length,
      data: {
        ...data,
        terminal_record: {
          ...data.terminal_record,
          run_id: id,
          completed_outcome: value.outcome,
          nodes: ran.map(([node]) => ({ node_id: node, state: 'completed' })),
          returns: { availability: 'available', node_id: 'end', value },
        },
      },
    });
  }
  const run = {
    ...plan1.run,
    id,
    workflow_name: `${PACK}:${workflow}`,
    status,
    completed_outcome: done ? String(value.outcome) : null,
    started_at: new Date(at),
    completed_at: done ? new Date(at) : null,
  };
  return { run, events };
}

const CHECKS = [
  ['review__review', 'approve'],
  ['tests__tests', 'sound'],
  ['product__product', 'approve'],
] as const;

/** A completed stage-check run: round `round` of `allowance`, its verdict `outcome`. */
const checkRun = (id: string, at: string, round: number, allowance: number, outcome: string) =>
  stageRun('stage-check', id, at, { outcome, change: PR12, round, allowance }, [
    ...CHECKS,
    ['verdict__verdict', outcome],
    ['rounds', outcome],
  ]);
const buildRun = (id: string, at: string) =>
  stageRun('stage-build', id, at, { outcome: 'built', change: PR12 }, [['build__build', 'built']]);

describe('the three-stage delivery: the change from any stage, rounds from stage-check runs', () => {
  /** The one round a `checkRun` is, its steps every one that recorded an outcome but `end`. */
  const checkRound = (
    iteration: number,
    max: number,
    verdict: FactoryRound['verdict'],
    outcome: string
  ) => ({
    max,
    rounds: [
      {
        iteration,
        verdict,
        outcome,
        summary: `verdict__verdict said ${outcome}`,
        steps: [...CHECKS, ['verdict__verdict', outcome], ['rounds', outcome]].map(
          ([node, said]) => ({ node, outcome: said, summary: `${node} said ${said}` })
        ),
      },
    ],
  });

  test.each<[string, Entry, ReturnType<typeof checkRound> | null, number, string | null]>([
    [
      'a stage-check run is one round: numbered and bounded by its result, decided by its verdict',
      checkRun('c1', '2026-11-21T01:00:00Z', 2, 3, 'return'),
      checkRound(2, 3, 'returned', 'return'),
      1,
      PR12,
    ],
  ])('%s', async (_name, entry, rounds, returned, change) => {
    const { progress, runs } = await readItem([entry]);
    expect(runs[0]?.rounds ?? null).toEqual(rounds);
    expect(progress.returned).toBe(returned);
    expect(runs[0]?.change ?? null).toBe(change);
  });

  const check1 = checkRun('c1', '2026-11-21T02:00:00Z', 1, 3, 'return');
  const stageBuild = stageRun('stage-build', 'b1', '2026-11-21T01:00:00Z', {
    outcome: 'built',
    change: PR11,
  });
  const stageHost = stageRun('stage-host', 'h1', '2026-11-21T03:00:00Z', {
    outcome: 'ready',
    change: PR12,
  });
  test.each<[string, Entry[], Partial<Record<keyof FactoryItemProgress, unknown>>]>([
    [
      "the item's rounds are its stage-check runs, the newest allowance its bound: round 3 of 4",
      [
        buildRun('b1', '2026-11-21T01:00:00Z'),
        check1,
        buildRun('b2', '2026-11-21T03:00:00Z'),
        checkRun('c2', '2026-11-21T04:00:00Z', 2, 3, 'return'),
        buildRun('b3', '2026-11-21T05:00:00Z'),
        // After a one-more-round answer, the pack allows four.
        checkRun('c3', '2026-11-21T06:00:00Z', 3, 4, 'approve'),
        stageRun('stage-host', 'h1', '2026-11-21T07:00:00Z', {}, [], 'running'),
      ],
      {
        round: {
          runId: 'c3',
          iteration: 3,
          max: 4,
          rounds: [
            { iteration: 1, verdict: 'returned', outcome: 'return' },
            { iteration: 2, verdict: 'returned', outcome: 'return' },
            { iteration: 3, verdict: 'approved', outcome: 'approve' },
          ],
        },
      },
    ],
    [
      'a stage-check run going now adds no round: the newest recorded one stands',
      [check1, stageRun('stage-check', 'c2', '2026-11-21T04:00:00Z', {}, CHECKS, 'running')],
      {
        round: { runId: 'c1', iteration: 1, max: 3 },
        running: { runId: 'c2', workflow: 'stage-check' },
      },
    ],
    [
      'after a replan the rounds start again: only the new cycle is read',
      [
        check1,
        checkRun('c2', '2026-11-21T04:00:00Z', 2, 3, 'replan'),
        buildRun('b2', '2026-11-21T05:00:00Z'),
        checkRun('c3', '2026-11-21T06:00:00Z', 1, 3, 'return'),
      ],
      {
        round: {
          runId: 'c3',
          iteration: 1,
          max: 3,
          rounds: [{ iteration: 1, verdict: 'returned', outcome: 'return' }],
        },
      },
    ],
    [
      // An older stage-build URL is not taken over a newer stage-host one, and a newer run
      // still going (no result yet) or naming an empty one does not displace it.
      'the change is the newest stage run that names one, of any listed workflow',
      [
        stageBuild,
        stageHost,
        stageRun('stage-check', 'c2', '2026-11-21T04:00:00Z', {}, [], 'running'),
        stageRun('landgate', 'g1', '2026-11-21T05:00:00Z', { outcome: 'land', change: '' }),
      ],
      { change: { url: PR12 } },
    ],
    [
      // Item 111's shape: deliver named the change; the land gate of that era returned none.
      "a land gate run whose result has no change does not displace a deliver run's",
      [
        deliverNaming(deliver1, 'd1', PR10, '2026-11-20T01:00:00Z'),
        stageRun('landgate', 'g1', '2026-11-20T02:00:00Z', { outcome: 'land' }),
      ],
      { change: { url: PR10 } },
    ],
  ])('%s', async (_name, entries, expected) => {
    expect(await progressOf(entries)).toMatchObject(expected);
  });
});
