import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRunFixture } from './__fixtures__/read-run-fixture';
import {
  factoryItemProgress,
  factoryProgressSchema,
  factoryRunFacts,
  FactoryRunFactsMemo,
  factoryItemDetailSchema,
  readFactoryItem,
  readFactoryProgress,
  type FactoryChangeLookup,
  type FactoryChangeRecord,
  type FactoryChangeState,
  type FactoryRound,
  titleOfItemText,
} from './factory-items';
import { factoryRunStory } from './factory-item-story';
import type { ItemReadSource } from './item-read';
import { factoryViewSchema } from './schemas/factory-view';
import { RUN_ENDED_SOURCE_ACTOR } from './schemas/resource-start';
import type { WorkflowEventRow } from './schemas/workflow-event';
import { workflowRunSchema, type WorkflowItem, type WorkflowRun } from './schemas/workflow-run';

const PACK = 'Wirasm/archon-software-factory';
// The declaration this repository ships for the pack the fixtures' runs come from.
const view = factoryViewSchema.parse(
  JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        '../../../.archon/packs/Wirasm.archon-software-factory.factory-view.json'
      ),
      'utf8'
    )
  )
);

type RawRun = Record<string, unknown> & { started_at: string; completed_at: string | null };

/**
 * Runs copied from the live factory database (see each file's `note`): the run row's
 * recorded fields and its events of the types the facts read, with data trimmed.
 */
function rawFixture(name: string): { run: RawRun; events: WorkflowEventRow[] } {
  return readRunFixture(
    join(import.meta.dir, '__fixtures__', 'factory-items', `${name}.jsonl`)
  ) as ReturnType<typeof readRunFixture> & { run: RawRun };
}

function fixture(name: string): { run: WorkflowRun; events: WorkflowEventRow[] } {
  const raw = rawFixture(name);
  return { run: hydrate(raw.run), events: raw.events };
}

function hydrate(fields: RawRun): WorkflowRun {
  return workflowRunSchema.parse({
    origin: null,
    conversation_id: null,
    parent_conversation_id: null,
    codebase_id: null,
    outcome: null,
    completed_outcome: null,
    user_message: '',
    active_phase_started_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    item_id: null,
    metadata: {},
    ...fields,
    started_at: new Date(fields.started_at),
    completed_at: fields.completed_at === null ? null : new Date(fields.completed_at),
  });
}

const triage1 = fixture('item-1-triage-88640c6d');
const plan1 = fixture('item-1-plan-147ff872');
const deliver1 = fixture('item-1-deliver-c90ebf41');
const deliver2Raw = rawFixture('item-2-deliver-934682d0');
const deliver2 = { run: hydrate(deliver2Raw.run), events: deliver2Raw.events };
/**
 * The same run as it stood mid-round: only its events up to order 1800, and the run set back
 * to running with no outcome.
 */
const deliver2Cut = {
  run: hydrate({
    ...deliver2Raw.run,
    status: 'running',
    completed_outcome: null,
    completed_at: null,
  }),
  events: deliver2Raw.events.filter(row => (row.event_order ?? Infinity) <= 1800),
};

/** A discoveries drain of item #70, as the shadow reader's tests copy it. */
function drainFixture(): { run: WorkflowRun; events: WorkflowEventRow[] } {
  const raw = readRunFixture(
    join(import.meta.dir, '__fixtures__', 'factory-shadows', 'item-70-discoveries.jsonl')
  ) as ReturnType<typeof readRunFixture> & { run: RawRun };
  // The shadow reader's copy trimmed each event's time; the item read's step starts need one.
  const events = raw.events.map(row => ({
    ...row,
    created_at: row.created_at ?? raw.run.started_at,
  }));
  return { run: hydrate({ ...raw.run, last_activity_at: null }), events };
}

const factsOf = ({ run, events }: { run: WorkflowRun; events: WorkflowEventRow[] }) =>
  factoryRunFacts(view, PACK, run, events);

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

describe('the facts of one run', () => {
  test('a deliver run with two rounds: returned, then approved; one verdict and one host return', () => {
    const facts = factsOf(deliver1);
    expect(facts.active).toBeNull();
    expect(decisions(facts.rounds)).toEqual({
      max: 3,
      rounds: [
        { iteration: 1, verdict: 'returned', outcome: 'return' },
        { iteration: 2, verdict: 'approved', outcome: 'approve' },
      ],
    });
    expect(facts.returnCount).toBe(2);
    expect(facts.failedStep).toBeNull();
    expect(facts.change?.url).toBe(PR10);
    expect(facts.change?.audits.length).toBeGreaterThan(0);
  });

  test('a deliver run with three rounds: returned twice, then approved; the host cleared it', () => {
    const facts = factsOf(deliver2);
    expect(facts.rounds?.rounds.map(round => [round.verdict, round.outcome])).toEqual([
      ['returned', 'return'],
      ['returned', 'return'],
      ['approved', 'approve'],
    ]);
    expect(facts.returnCount).toBe(2);
    expect(facts.change?.url).toBe(PR11);
  });

  test('cut mid-round: the deepest step is the latest started of the three parallel checks', () => {
    const facts = factsOf(deliver2Cut);
    // `rounds` and the three checks run at once; the checks are deeper, review started last.
    expect(facts.active).toBe('rounds.review__review');
    expect(decisions(facts.rounds)).toEqual({
      max: 3,
      rounds: [
        { iteration: 1, verdict: 'returned', outcome: 'return' },
        { iteration: 2, verdict: 'running', outcome: null },
      ],
    });
    expect(facts.returnCount).toBe(1);
    // No terminal record yet, so no change at the declared pointer.
    expect(facts.change).toBeNull();
  });

  test('a round that never completed on a run that ended is stopped', () => {
    const facts = factsOf({ ...deliver2Cut, run: { ...deliver2Cut.run, status: 'failed' } });
    expect(facts.rounds?.rounds.at(-1)).toMatchObject({
      iteration: 2,
      verdict: 'stopped',
      outcome: null,
      summary: null,
    });
  });

  test('a round whose checks asked instead of approving needs a decision, with that outcome', () => {
    // The same run, its verdict step answering `ask` where it approved.
    const events = deliver1.events.map(row =>
      JSON.stringify(row.data).includes('"outcome":"approve"')
        ? (JSON.parse(
            JSON.stringify(row).replaceAll('"outcome":"approve"', '"outcome":"ask"')
          ) as WorkflowEventRow)
        : row
    );
    expect(decisions(factsOf({ ...deliver1, events }).rounds)?.rounds).toEqual([
      { iteration: 1, verdict: 'returned', outcome: 'return' },
      { iteration: 2, verdict: 'undecided', outcome: 'ask' },
    ]);
  });

  test('without a declared approval, a completed round needs a decision, never approved', () => {
    const { approves: _approves, ...undeclared } = view;
    expect(
      decisions(factoryRunFacts(undeclared, PACK, deliver1.run, deliver1.events).rounds)?.rounds
    ).toEqual([
      { iteration: 1, verdict: 'returned', outcome: 'return' },
      { iteration: 2, verdict: 'undecided', outcome: 'approve' },
    ]);
  });

  test('an approval reads from the outcome the view declares, whatever the workflow calls it', () => {
    // Declared as `pass`, the verdict step's `approve` approves nothing.
    const renamed = {
      ...view,
      approves: (view.approves ?? []).map(point => ({ ...point, outcome: 'pass' })),
    };
    expect(
      factoryRunFacts(renamed, PACK, deliver1.run, deliver1.events).rounds?.rounds.at(-1)?.verdict
    ).toBe('undecided');
  });

  test("rounds read only the declared loop's events, not another loop's", () => {
    // deliver2 ran three review rounds and one host round; the view declares no host approval.
    const hostView = { ...view, rounds: { workflow: 'deliver', loop: 'hostrounds' } };
    const host = factoryRunFacts(hostView, PACK, deliver2.run, deliver2.events).rounds;
    expect(decisions(host)?.rounds).toEqual([
      { iteration: 1, verdict: 'undecided', outcome: 'clear' },
    ]);
    expect(host?.rounds[0]?.steps.map(step => step.node)).toEqual(['hostrounds.host__host']);
  });

  test('a failed run names the step that failed', () => {
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
    const facts = factsOf({
      run: { ...deliver2Cut.run, status: 'failed' },
      events: [...deliver2Cut.events, failed],
    });
    expect(facts.failedStep).toBe('rounds.review__review');
  });

  test('triage and plan runs have no rounds, returns, change or work order', () => {
    for (const run of [triage1, plan1])
      expect({ ...factsOf(run), shadows: [] }).toEqual({
        active: null,
        rounds: null,
        returnCount: 0,
        failedStep: null,
        change: null,
        partOf: null,
        parked: null,
        awaits: null,
        shadows: [],
      });
    // Triage's one declared shadow step decided (its old split step is no shadow the view
    // declares: split is a workflow of its own now); plan has none.
    expect(factsOf(triage1).shadows.map(decision => decision.node)).toEqual(['admit']);
    expect(factsOf(plan1).shadows).toEqual([]);
  });

  test('a run recorded under the bare name is not the installed pack’s workflow', () => {
    const bare = { ...deliver1, run: { ...deliver1.run, workflow_name: 'deliver' } };
    expect(factsOf(bare)).toMatchObject({ rounds: null, returnCount: 0, change: null });
  });
});

describe("each round's steps", () => {
  const rounds = factsOf(deliver2).rounds?.rounds ?? [];
  const stepsOf = (iteration: number) =>
    rounds
      .find(round => round.iteration === iteration)
      ?.steps.map(step => [step.node, step.outcome]);

  test('a round lists the loop steps that recorded an outcome, in recording order', () => {
    expect(stepsOf(1)).toEqual([
      ['rounds.tests__tests', 'return'],
      ['rounds.product__product', 'approve'],
      ['rounds.review__review', 'approve'],
      ['rounds.verdict__verdict', 'return'],
    ]);
    // Round 1's fix was skipped and the base step records no outcome; neither is a step.
    expect(stepsOf(2)).toEqual([
      ['rounds.fix', 'fixed'],
      ['rounds.tests__tests', 'return'],
      ['rounds.product__product', 'approve'],
      ['rounds.review__review', 'approve'],
      ['rounds.verdict__verdict', 'return'],
    ]);
    expect(stepsOf(3)?.at(-1)).toEqual(['rounds.verdict__verdict', 'approve']);
  });

  test("a round's summary is the summary of the return or approval step that decided it", () => {
    const verdictSummary = (iteration: number) =>
      rounds
        .find(round => round.iteration === iteration)
        ?.steps.find(step => step.node === 'rounds.verdict__verdict')?.summary;
    for (const round of rounds) {
      expect(round.summary).toBeString();
      expect(round.summary).toBe(verdictSummary(round.iteration) ?? null);
    }
    expect(rounds[0]?.summary).toStartWith('Return.');
    expect(rounds[2]?.summary).toStartWith('Approve');
  });

  test('a summary that is not a string reads as null, the step still listed', () => {
    const events = deliver2.events.map(row =>
      row.step_name === 'rounds.fix' && JSON.stringify(row.data).includes('"summary"')
        ? (JSON.parse(
            JSON.stringify(row).replace(/"summary":"[^"]*"/, '"summary":7')
          ) as WorkflowEventRow)
        : row
    );
    const fix = factsOf({ ...deliver2, events }).rounds?.rounds[1]?.steps[0];
    expect(fix).toEqual({ node: 'rounds.fix', outcome: 'fixed', summary: null });
  });
});

/**
 * An order run: the triage fixture under the pack's `order` workflow, its result naming
 * `partOf` at the pointer the view declares, as the live factory's order runs record it.
 */
function orderRun(
  id: string,
  partOf: unknown,
  at: string,
  status: WorkflowRun['status'] = 'completed',
  outcome = 'ready'
): { run: WorkflowRun; events: WorkflowEventRow[] } {
  const run = {
    ...triage1.run,
    id,
    status,
    completed_outcome: status === 'completed' ? outcome : null,
    workflow_name: `${PACK}:order`,
    started_at: new Date(at),
  };
  const events = triage1.events.map(row => {
    if (row.event_type !== 'workflow_completed') return row;
    const data = row.data as { terminal_record: { returns: Record<string, unknown> } };
    const value = { outcome, item: id, land_on: '', part_of: partOf, why: '' };
    return {
      ...row,
      workflow_run_id: id,
      data: {
        ...data,
        terminal_record: {
          ...data.terminal_record,
          returns: { ...data.terminal_record.returns, value },
        },
      },
    };
  });
  return { run, events };
}

describe("an item's work order, from its order runs' results", () => {
  test('the newest completed order run names it, trimmed', async () => {
    const old = orderRun('o1', '40', '2026-11-16T00:00:00Z');
    const newer = orderRun('o2', ' 48 ', '2026-11-17T00:00:00Z');
    expect(factsOf(newer).partOf).toBe('48');
    expect((await progressOf([old, newer])).partOf).toBe('48');
  });

  test('an empty value on the newest completed run is no order, even when an older run named one', async () => {
    const old = orderRun('o1', '48', '2026-11-16T00:00:00Z');
    const newer = orderRun('o2', '', '2026-11-17T00:00:00Z');
    expect((await progressOf([old, newer])).partOf).toBeNull();
  });

  test('a failed or running order run is not read; the newest completed one is', async () => {
    const done = orderRun('o1', '48', '2026-11-16T00:00:00Z');
    const failed = orderRun('o2', '50', '2026-11-17T00:00:00Z', 'failed');
    const running = orderRun('o3', '51', '2026-11-18T00:00:00Z', 'running');
    expect(factsOf(failed).partOf).toBeNull();
    expect((await progressOf([done, failed, running])).partOf).toBe('48');
  });

  test('a refused order run never makes the item a member, newest or alone', async () => {
    const ready = orderRun('o1', '48', '2026-11-16T00:00:00Z');
    const refused = orderRun('o2', '50', '2026-11-17T00:00:00Z', 'completed', 'refused');
    expect((await progressOf([ready, refused])).partOf).toBe('48');
    expect((await progressOf([refused])).partOf).toBeNull();
  });

  test('a value that is not a string is none', async () => {
    expect(factsOf(orderRun('o1', 48, '2026-11-16T00:00:00Z')).partOf).toBeNull();
  });

  test('a view that declares no partOf reads none', () => {
    const { partOf: _partOf, ...undeclared } = view;
    const run = orderRun('o1', '48', '2026-11-16T00:00:00Z');
    expect(factoryRunFacts(undeclared, PACK, run.run, run.events).partOf).toBeNull();
  });
});

/**
 * A triage run: the triage fixture as run `id` at `at`, completed with `recommend` and its
 * result giving `why`, as the live factory's triage runs record them.
 */
function triageRun(
  id: string,
  recommend: string,
  why: unknown,
  at: string,
  rest: Record<string, unknown> = {}
): { run: WorkflowRun; events: WorkflowEventRow[] } {
  const run = {
    ...triage1.run,
    id,
    completed_outcome: recommend,
    started_at: new Date(at),
  };
  const events = triage1.events.map(row => {
    if (row.event_type !== 'workflow_completed') return row;
    const data = row.data as { terminal_record: { returns: Record<string, unknown> } };
    return {
      ...row,
      workflow_run_id: id,
      data: {
        ...data,
        terminal_record: {
          ...data.terminal_record,
          returns: { ...data.terminal_record.returns, value: { recommend, why, ...rest } },
        },
      },
    };
  });
  return { run, events };
}

describe('a parked item, from its last declared run', () => {
  test('a triage run that parked it gives the declared label and its why, trimmed', async () => {
    const park = triageRun('t1', 'park', ' Measure it first. ', '2026-11-16T00:00:00Z');
    expect(factsOf(park).parked?.why).toBe('Measure it first.');
    expect((await progressOf([park])).parked).toEqual({
      label: 'Parked by triage',
      why: 'Measure it first.',
    });
  });

  test('a run after the parking one takes the item up: it is parked no more', async () => {
    const park = triageRun('t1', 'park', 'Later.', '2026-11-16T00:00:00Z');
    const again = triageRun('t2', 'build', 'Now.', '2026-11-17T00:00:00Z');
    expect((await progressOf([park, again])).parked).toBeNull();
    const running = { ...again, run: { ...again.run, status: 'running' as const } };
    expect((await progressOf([park, running])).parked).toBeNull();
  });

  test('a why that is not a non-empty string is null; the item is still parked', async () => {
    for (const why of [42, '  ', undefined]) {
      const park = triageRun('t1', 'park', why, '2026-11-16T00:00:00Z');
      expect((await progressOf([park])).parked).toEqual({ label: 'Parked by triage', why: null });
    }
  });

  test('an outcome the view ends or places on is not parked', async () => {
    for (const verb of ['close', 'fold', 'build'])
      expect(
        (await progressOf([triageRun('t1', verb, 'Why.', '2026-11-16T00:00:00Z')])).parked
      ).toBeNull();
  });
});

describe('an item waiting on a person, from its last declared run', () => {
  test('a triage run that asked for shaping gives the label, its why and its open questions', async () => {
    const shape = triageRun('t1', 'shape', ' Worth doing. ', '2026-11-16T00:00:00Z', {
      open_questions: [' Which surfaces? ', '', 7, 'Who owns it?'],
    });
    expect((await progressOf([shape])).awaits).toEqual({
      label: 'Needs shaping',
      why: 'Worth doing.',
      questions: ['Which surfaces?', 'Who owns it?'],
      next: view.awaits?.['triage:shape']?.next ?? null,
    });
    expect((await progressOf([shape])).awaits?.next).toStartWith('Settle these questions');
    expect((await progressOf([shape])).parked).toBeNull();
  });

  test('questions that are not a list read as none; the item still waits', async () => {
    for (const open_questions of ['Which surfaces?', null, undefined]) {
      const shape = triageRun('t1', 'shape', 'Why.', '2026-11-16T00:00:00Z', { open_questions });
      expect((await progressOf([shape])).awaits).toEqual({
        label: 'Needs shaping',
        why: 'Why.',
        questions: [],
        next: view.awaits?.['triage:shape']?.next ?? null,
      });
    }
  });

  test('a run after it takes the item up: it waits no more', async () => {
    const shape = triageRun('t1', 'shape', 'Later.', '2026-11-16T00:00:00Z', {
      open_questions: ['Which?'],
    });
    const again = triageRun('t2', 'build', 'Now.', '2026-11-17T00:00:00Z');
    expect((await progressOf([shape, again])).awaits).toBeNull();
    expect(
      (await progressOf([triageRun('t1', 'park', 'Later.', '2026-11-16T00:00:00Z')])).awaits
    ).toBeNull();
  });
});

const notMerged: FactoryChangeState = async lookup => ({
  url: lookup.kind === 'url' ? lookup.url : null,
  merged: false,
  mergedAt: null,
  number: null,
});

/** `entry`, a deliver run, as run `id` at `at`, its result naming `change` at the pointer. */
function deliverNaming(
  entry: { run: WorkflowRun; events: WorkflowEventRow[] },
  id: string,
  change: unknown,
  at: string
): { run: WorkflowRun; events: WorkflowEventRow[] } {
  const events = entry.events.map(row => {
    if (row.event_type !== 'workflow_completed') return row;
    const data = row.data as {
      terminal_record: { returns: { value: Record<string, unknown> } & Record<string, unknown> };
    };
    const returns = data.terminal_record.returns;
    return {
      ...row,
      workflow_run_id: id,
      data: {
        ...data,
        terminal_record: {
          ...data.terminal_record,
          returns: { ...returns, value: { ...returns.value, change } },
        },
      },
    };
  });
  return { run: { ...entry.run, id, started_at: new Date(at) }, events };
}

async function progressOf(
  runs: { run: WorkflowRun; events: WorkflowEventRow[] }[],
  changeState: FactoryChangeState = notMerged,
  branchOf: (run: WorkflowRun) => Promise<string | null> = async () => null,
  recorded: FactoryChangeRecord | null = null
) {
  const facts = new Map(runs.map(entry => [entry.run.id, factsOf(entry)]));
  return factoryItemProgress(
    view,
    PACK,
    runs.map(entry => entry.run),
    facts,
    changeState,
    branchOf,
    recorded
  );
}

const RECORDED: FactoryChangeRecord = { change: PR10, at: '2026-11-17T01:00:00.000Z' };

describe("an item's progress", () => {
  test("the change lookup gets the declared runs' branches, newest first, once each", async () => {
    // The newest declared run has its own branch; two older declared runs share one, so it
    // is read once. A newer run of a workflow the view does not declare has no facts and
    // its branch is never offered.
    const later = {
      ...deliver1,
      run: { ...deliver1.run, id: 'later', started_at: new Date('2027-01-01') },
    };
    const undeclared = {
      ...deliver1.run,
      id: 'undeclared',
      workflow_name: 'someone/else:deliver',
      started_at: new Date('2027-02-01'),
    };
    const recorded: Record<string, string | null> = {
      [triage1.run.id]: null,
      [plan1.run.id]: 'shared',
      [deliver1.run.id]: 'shared',
      later: 'later-branch',
      undeclared: 'other',
    };
    const declared = [triage1, plan1, deliver1, later];
    const read: string[][] = [];
    await factoryItemProgress(
      view,
      PACK,
      [...declared.map(entry => entry.run), undeclared],
      new Map(declared.map(entry => [entry.run.id, factsOf(entry)])),
      async (_lookup, branches) => {
        read.push([...(await branches())]);
        return { url: PR10, merged: false, mergedAt: null, number: null };
      },
      async run => recorded[run.id] ?? null,
      null
    );
    expect(read).toEqual([['later-branch', 'shared']]);
  });

  test("the item's recorded merge is handed to the change lookup with its change", async () => {
    const handed: (FactoryChangeRecord | null)[] = [];
    const progress = await progressOf(
      [triage1, plan1, deliver1],
      async (_lookup, _branches, recorded) => {
        handed.push(recorded);
        return { url: null, merged: true, mergedAt: recorded?.at ?? null, number: 10 };
      },
      async () => null,
      RECORDED
    );
    expect(handed).toEqual([RECORDED]);
    expect(progress.change).toEqual({
      url: PR10,
      merged: true,
      mergedAt: RECORDED.at,
      number: 10,
    });
  });

  test('a recorded merge on an item no run names a change for is its change, merged, unasked', async () => {
    const asked: FactoryChangeLookup[] = [];
    const progress = await progressOf(
      [triage1, plan1],
      async lookup => {
        asked.push(lookup);
        return { url: null, merged: false, mergedAt: null, number: null };
      },
      async () => 'a-branch',
      RECORDED
    );
    expect(asked).toEqual([]);
    expect(progress.change).toEqual({
      url: PR10,
      merged: true,
      mergedAt: RECORDED.at,
      number: null,
    });
    // With no record, such an item has no change.
    expect((await progressOf([triage1, plan1])).change).toBeNull();
  });

  test('item 1 after its deliver run: title, round 2 of 3, returned twice, its change', async () => {
    const seen: [string, number][] = [];
    const progress = await progressOf([triage1, plan1, deliver1], async lookup => {
      if (lookup.kind === 'url') seen.push([lookup.url, lookup.audits.length]);
      // The forge's URL is not shown on the URL path: the run's is.
      return { url: null, merged: true, mergedAt: '2026-11-17T01:00:00Z', number: 10 };
    });
    expect(progress).toEqual({
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
      shadows: factsOf(triage1).shadows,
      parked: null,
      awaits: null,
    });
    expect(seen).toEqual([[PR10, factsOf(deliver1).change?.audits.length ?? -1]]);
  });

  test("a discoveries run adds its shadow decision, and nothing else, to the item's progress", async () => {
    const drain = drainFixture();
    const without = await progressOf([triage1, plan1, deliver1]);
    const withDrain = await progressOf([triage1, plan1, deliver1, drain]);
    // The drain's run is on no stage: it places nothing and lists in no run.
    expect({ ...withDrain, shadows: without.shadows }).toEqual(without);
    expect(withDrain.shadows.map(decision => [decision.workflow, decision.node])).toEqual([
      ['triage', 'admit'],
      ['discoveries', 'result'],
    ]);
  });

  test('returned counts every run that sent the item back; round and change are the latest run', async () => {
    const later = { ...deliver2.run, started_at: new Date('2027-01-01T00:00:00Z') };
    const progress = await progressOf([deliver1, { ...deliver2, run: later }]);
    // Two returns on each deliver run.
    expect(progress.returned).toBe(4);
    expect(progress.round?.runId).toBe(deliver2.run.id);
    expect(progress.change?.url).toBe(PR11);
  });

  test('a running deliver run: its declared workflow name and running step', async () => {
    const progress = await progressOf([deliver2Cut]);
    expect(progress.running).toEqual({
      runId: deliver2Cut.run.id,
      workflow: 'deliver',
      step: 'rounds.review__review',
      startedAt: deliver2Cut.run.started_at.toISOString(),
    });
    expect(progress.round?.iteration).toBe(2);
    expect(progress.change).toBeNull();
  });

  test('a deliver that named an empty URL: the change is the pull request on its branches', async () => {
    const PR59 = 'https://github.com/coleam00/archon-factory-console/pull/59';
    const empty = deliverNaming(deliver1, 'deliver-empty', '', '2026-12-01T00:00:00Z');
    const asked: unknown[] = [];
    const progress = await progressOf(
      [triage1, plan1, empty],
      async (lookup, branches) => {
        asked.push({ lookup, branches: await branches() });
        return { url: PR59, merged: true, mergedAt: '2026-11-18T20:00:00Z', number: 59 };
      },
      async run => `branch-${run.id}`
    );
    expect(factsOf(empty).change?.url).toBeNull();
    expect(asked).toEqual([
      {
        lookup: { kind: 'branch', run: 'deliver-empty' },
        branches: ['branch-deliver-empty', `branch-${plan1.run.id}`, `branch-${triage1.run.id}`],
      },
    ]);
    expect(progress.change).toEqual({
      url: PR59,
      merged: true,
      mergedAt: '2026-11-18T20:00:00Z',
      number: 59,
    });
  });

  test("a whitespace URL after an earlier deliver's real one: the earlier one, branches unread", async () => {
    const blank = deliverNaming(deliver1, 'deliver-blank', '  ', '2027-01-01T00:00:00Z');
    const asked: unknown[] = [];
    const progress = await progressOf(
      [deliver1, blank],
      async (lookup, branches) => {
        asked.push(lookup.kind === 'url' ? lookup.url : lookup);
        expect(branches).toBeFunction();
        return { url: null, merged: true, mergedAt: null, number: 10 };
      },
      async () => {
        throw new Error('branches are read only when the audit rows name no pull request');
      }
    );
    expect(asked).toEqual([PR10]);
    expect(progress.change).toEqual({ url: PR10, merged: true, mergedAt: null, number: 10 });
  });

  test('an empty URL and no run branch: no change, and nothing is asked', async () => {
    const empty = deliverNaming(deliver1, 'deliver-empty', '', '2026-12-01T00:00:00Z');
    const progress = await progressOf([triage1, empty], async () => {
      throw new Error('nothing to look up');
    });
    expect(progress.change).toBeNull();
  });

  test('an item not yet delivered reads no branch and asks nothing', async () => {
    const progress = await progressOf(
      [triage1, plan1],
      async () => {
        throw new Error('nothing to look up');
      },
      async () => {
        throw new Error('no branch is read before a deliver names a change');
      }
    );
    expect(progress.change).toBeNull();
  });

  test('an item with only triage and plan: nothing returned, no round, no change', async () => {
    const progress = await progressOf([triage1, plan1]);
    expect(progress).toMatchObject({ running: null, round: null, returned: 0, change: null });
    expect(progress.title).toBe('The live-home guard and dev:console have tests');
  });

  test('an item an order started: the title of the item text the order produced', async () => {
    // The order run carries the work order (a source URL, no item); the triage run after it
    // carries the item text the order stage produced, front matter first.
    const order = withInputs(triage1, 'order-run', 'Wirasm/archon-software-factory:order', 0, {
      key: '36',
      source: 'https://github.com/coleam00/archon-factory-console/issues/36',
    });
    const triage = withInputs(triage1, 'triage-run', triage1.run.workflow_name, 60_000, {
      item: ORDERED_ITEM,
    });
    const progress = await progressOf([order, triage]);
    expect(progress.title).toBe('Items started by a work order show their title');
  });
});

/** A copy of a fixture run with its own id, workflow and inputs, started `laterMs` after it. */
function withInputs(
  entry: { run: WorkflowRun; events: WorkflowEventRow[] },
  id: string,
  workflowName: string,
  laterMs: number,
  inputs: Record<string, string>
): { run: WorkflowRun; events: WorkflowEventRow[] } {
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
  test('an item an order made: the heading after its front matter', () => {
    expect(titleOfItemText(ORDERED_ITEM)).toBe('Items started by a work order show their title');
    expect(titleOfItemText(ORDERED_ITEM.replaceAll('\n', '\r\n'))).toBe(
      'Items started by a work order show their title'
    );
  });

  test("a text-only order: the operator's first line", () => {
    expect(titleOfItemText('Fix the board\n\nmore')).toBe('Fix the board');
  });

  test('an item started the old way: the first line without its `#<n> `', () => {
    expect(
      titleOfItemText('#12 Stage and step pages show which items are on a step now\n\nbody')
    ).toBe('Stage and step pages show which items are on a step now');
  });

  test('no title line: unterminated front matter, empty or blank text, a bare heading marker', () => {
    expect(titleOfItemText('---\nid: 1\n')).toBeNull();
    expect(titleOfItemText('')).toBeNull();
    expect(titleOfItemText(' \n\t\n')).toBeNull();
    expect(titleOfItemText('# \nbody')).toBeNull();
    expect(titleOfItemText('---\nid: 1\n---\n\n')).toBeNull();
  });
});

describe('the facts memo', () => {
  test('keeps an ended run, never a running one, and forgets a run that ended again', () => {
    const memo = new FactoryRunFactsMemo();
    const facts = factsOf(deliver1);
    memo.set(view, PACK, deliver1.run, facts);
    expect(memo.get(view, PACK, deliver1.run)).toBe(facts);
    memo.set(view, PACK, deliver2Cut.run, factsOf(deliver2Cut));
    expect(memo.get(view, PACK, deliver2Cut.run)).toBeUndefined();
    const resumed = { ...deliver1.run, completed_at: new Date('2026-11-18T00:00:00Z') };
    expect(memo.get(view, PACK, resumed)).toBeUndefined();
  });

  test('forgets facts read under a declaration that has since changed', () => {
    const memo = new FactoryRunFactsMemo();
    memo.set(view, PACK, deliver1.run, factsOf(deliver1));
    const edited = { ...view, returns: [] };
    expect(memo.get(edited, PACK, deliver1.run)).toBeUndefined();
    expect(factoryRunFacts(edited, PACK, deliver1.run, deliver1.events).returnCount).toBe(0);
    // An approval declared or withdrawn changes the rounds' verdicts too.
    expect(memo.get({ ...view, approves: [] }, PACK, deliver1.run)).toBeUndefined();
    // So does where a result names the item's work order.
    expect(
      memo.get(
        { ...view, partOf: { workflow: 'order', pointer: '/order', outcome: 'ready' } },
        PACK,
        deliver1.run
      )
    ).toBeUndefined();
    // And which steps are shadows, and how each reads.
    expect(
      memo.get({ ...view, shadows: view.shadows?.slice(1) }, PACK, deliver1.run)
    ).toBeUndefined();
    // And which outcomes park an item, and where their reason is.
    expect(memo.get({ ...view, parked: {} }, PACK, deliver1.run)).toBeUndefined();
    // And which outcomes leave it waiting on a person, and where their words are.
    expect(memo.get({ ...view, awaits: {} }, PACK, deliver1.run)).toBeUndefined();
  });

  test('is bounded, oldest out', () => {
    const memo = new FactoryRunFactsMemo(1);
    memo.set(view, PACK, deliver1.run, factsOf(deliver1));
    memo.set(view, PACK, deliver2.run, factsOf(deliver2));
    expect(memo.get(view, PACK, deliver1.run)).toBeUndefined();
    expect(memo.get(view, PACK, deliver2.run)).toBeDefined();
  });
});

describe('reading progress, and one item whole', () => {
  const item1: WorkflowItem = { id: 'item-1', projectKey: 'acme/web', key: '1' };
  const item2: WorkflowItem = { id: 'item-2', projectKey: 'acme/web', key: '2' };
  const own = (item: WorkflowItem, ...runs: { run: WorkflowRun }[]): WorkflowRun[] =>
    runs.map(entry => ({ ...entry.run, item_id: item.id }));
  const runsOf: Record<string, WorkflowRun[]> = {
    // The fixtures' metadata is trimmed; real runs record their cost under this key.
    '1': own(item1, triage1, plan1, {
      run: { ...deliver1.run, metadata: { ...deliver1.run.metadata, total_cost_usd: 13.5 } },
    }),
    '2': own(item2, deliver2Cut),
  };
  const all = [triage1, plan1, deliver1, deliver2Cut];

  function pageSource(counts: { queue: number; loaded: string[][] }, broken?: string) {
    const source: ItemReadSource = {
      branchOf: async () => null,
      store: {
        getItemRuns: async (_projectKey, key) => {
          const item = key === '1' ? item1 : key === '2' ? item2 : null;
          return item === null ? null : { item, runs: runsOf[key] ?? [], descendantIds: [] };
        },
        listEventsForRuns: async (ids, types) => {
          // The item read asks for answers too; count only the facts' reads.
          if (types.includes('loop_iteration_started')) counts.loaded.push([...ids]);
          return new Map(
            ids.map(id => {
              const events = all.find(entry => entry.run.id === id)?.events ?? [];
              // A row the node fold refuses, so this run's facts cannot be derived.
              const bad = { ...events[0]!, step_name: 'x', data: { node: 'broken' } };
              return [id, id === broken ? [bad as WorkflowEventRow] : events];
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
        getItemMerge: async () => null,
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
    return source;
  }

  const progressInput = (
    memo: FactoryRunFactsMemo,
    onProgressError: (id: string, error: unknown) => void
  ) => ({
    view,
    pack: PACK,
    projectKey: 'acme/web',
    changeState: notMerged,
    memo,
    onProgressError,
  });

  test('progress for each asked key, an unknown key left out; ended runs are memoised', async () => {
    const counts = { queue: 0, loaded: [] as string[][] };
    const input = progressInput(new FactoryRunFactsMemo(), (id, error) => {
      throw new Error(`unexpected failure for ${id}: ${String(error)}`);
    });
    const read = factoryProgressSchema.parse(
      await readFactoryProgress(pageSource(counts), input, ['2', '1', '404', '2'])
    );
    expect(read.pack).toBe(PACK);
    expect(Object.keys(read.progress).sort()).toEqual(['1', '2']);
    expect(read.progress['2']?.running?.step).toBe('rounds.review__review');
    expect(read.progress['1']?.change?.url).toBe(PR10);
    // Progress reads no item read, so not the attention queue either.
    expect(counts.queue).toBe(0);
    // Every declared run's events in one read.
    expect(counts.loaded).toHaveLength(1);
    await readFactoryProgress(pageSource(counts), input, ['1', '2']);
    // The second read loads only the running run; the ended ones were memoised.
    expect(counts.loaded.at(-1)).toEqual([deliver2Cut.run.id]);
  });

  test("items' merge states are looked up together, not one after another", async () => {
    // Item 3 is a second item whose deliver run recorded the same kind of change as item 1's.
    const source = pageSource({ queue: 0, loaded: [] });
    const reads = source.store.getItemRuns;
    source.store.getItemRuns = async (projectKey, key) =>
      key === '3'
        ? {
            item: { id: 'item-3', projectKey, key: '3' },
            runs: [{ ...deliver1.run, id: 'run-3', item_id: 'item-3' }],
            descendantIds: [],
          }
        : reads(projectKey, key);
    const listEvents = source.store.listEventsForRuns;
    source.store.listEventsForRuns = async (ids, types) => {
      const read = await listEvents(ids, types);
      if (ids.includes('run-3')) read.set('run-3', deliver1.events);
      return read;
    };
    // Each lookup answers only once both are in flight: a read that waited on one first would hang.
    let started = 0;
    let release: () => void = () => {};
    const both = new Promise<void>(resolve => {
      release = resolve;
    });
    const changeState: FactoryChangeState = async () => {
      started++;
      if (started === 2) release();
      await both;
      return { url: null, merged: false, mergedAt: null, number: null };
    };
    const read = await readFactoryProgress(
      source,
      { ...progressInput(new FactoryRunFactsMemo(), () => {}), changeState },
      ['1', '3']
    );
    expect(started).toBe(2);
    expect(Object.keys(read.progress).sort()).toEqual(['1', '3']);
  });

  test("each item's recorded merge reaches its change lookup; an unreadable row reads as none", async () => {
    const source = pageSource({ queue: 0, loaded: [] });
    const merge = {
      change: PR10,
      commit: null,
      at: '2026-11-17T01:00:00.000Z',
      recordedAt: '2026-11-17T01:01:00.000Z',
      via: 'cli' as const,
      fromRun: null,
    };
    const handed: (FactoryChangeRecord | null)[] = [];
    const changeState: FactoryChangeState = async (_lookup, _branches, recorded) => {
      handed.push(recorded);
      return { url: null, merged: recorded !== null, mergedAt: null, number: null };
    };
    const input = { ...progressInput(new FactoryRunFactsMemo(), () => {}), changeState };
    source.store.getItemMerge = async id => (id === item1.id ? merge : null);
    const read = await readFactoryProgress(source, input, ['1']);
    expect(handed).toEqual([{ change: PR10, at: merge.at }]);
    expect(read.progress['1']?.change?.merged).toBe(true);
    source.store.getItemMerge = async itemId => ({
      type: 'degraded',
      reason: 'merge_unreadable',
      itemId,
    });
    await readFactoryProgress(source, input, ['1']);
    expect(handed.at(-1)).toBeNull();
  });

  test("one item's facts failing gives it null progress and leaves the others", async () => {
    const failed: string[] = [];
    const read = await readFactoryProgress(
      pageSource({ queue: 0, loaded: [] }, deliver2Cut.run.id),
      progressInput(new FactoryRunFactsMemo(), id => failed.push(id)),
      ['1', '2']
    );
    expect(read.progress['2']).toBeNull();
    expect(read.progress['1']).not.toBeNull();
    expect(failed).toEqual([item2.id]);
  });

  const itemInput = (onProgressError: (id: string, error: unknown) => void) => ({
    view,
    pack: PACK,
    projectKey: 'acme/web',
    changeState: notMerged,
    memo: new FactoryRunFactsMemo(),
    onProgressError,
  });
  const unexpected = (id: string, error: unknown) => {
    throw new Error(`unexpected failure for ${id}: ${String(error)}`);
  };

  test("one item: its read and progress, plus each run's story facts", async () => {
    const counts = { queue: 0, loaded: [] as string[][] };
    const detail = factoryItemDetailSchema.parse(
      await readFactoryItem(pageSource(counts), itemInput(unexpected), '1')
    );
    expect(detail.pack).toBe(PACK);
    expect(detail.item.runs.map(run => run.id)).toEqual(detail.runs.map(run => run.runId));
    expect(detail.runs.map(run => [run.workflow, run.costUsd, run.step])).toEqual([
      ['triage', null, null],
      ['plan', null, null],
      ['deliver', 13.5, null],
    ]);
    expect(detail.runs.map(run => run.rounds?.rounds.length ?? null)).toEqual([null, null, 2]);
    expect(detail.item.progress?.change?.url).toBe(PR10);
    expect(counts.queue).toBe(1);
  });

  test("the latest deliver run's rounds are the board's rounds, steps aside", async () => {
    const detail = await readFactoryItem(
      pageSource({ queue: 0, loaded: [] }),
      itemInput(unexpected),
      '1'
    );
    const deliver = detail?.runs.find(run => run.runId === detail.item.progress?.round?.runId);
    expect(decisions(deliver?.rounds)?.rounds).toEqual(detail?.item.progress?.round?.rounds);
    // The board's contract carries no steps or summaries.
    expect(Object.keys(detail?.item.progress?.round?.rounds[0] ?? {}).sort()).toEqual([
      'iteration',
      'outcome',
      'verdict',
    ]);
  });

  test('a running run shows its running step; one with no recorded cost reads null', async () => {
    const detail = await readFactoryItem(
      pageSource({ queue: 0, loaded: [] }),
      itemInput(unexpected),
      '2'
    );
    expect(detail?.runs).toEqual([
      {
        runId: deliver2Cut.run.id,
        workflow: 'deliver',
        costUsd: null,
        step: 'rounds.review__review',
        rounds: factsOf(deliver2Cut).rounds,
        shadows: [],
        // Still running: it has named no change and returned nothing to say yet.
        change: null,
        said: null,
        models: ['claude-opus-5-5', 'claude-haiku-5-5'],
        steps: factoryRunStory(view, deliver2Cut.run, deliver2Cut.events).steps,
      },
    ]);
  });

  test('each run carries the change it named, what it said, its models and its step starts', async () => {
    const detail = await readFactoryItem(
      pageSource({ queue: 0, loaded: [] }),
      itemInput(unexpected),
      '1'
    );
    const deliver = detail?.runs.find(run => run.runId === deliver1.run.id);
    expect(deliver?.change).toBe(factsOf(deliver1).change?.url ?? null);
    expect(deliver?.change).toStartWith('https://');
    expect(deliver).toMatchObject(factoryRunStory(view, deliver1.run, deliver1.events));
    expect(deliver?.said).not.toBeNull();
    expect(deliver?.steps[0]?.node).toBe('build__build');
  });

  test('a run whose facts fail keeps its row without rounds; the item has no progress', async () => {
    const failed: string[] = [];
    const detail = await readFactoryItem(
      pageSource({ queue: 0, loaded: [] }, deliver2Cut.run.id),
      itemInput(id => failed.push(id)),
      '2'
    );
    expect(detail?.runs.map(run => [run.runId, run.step, run.rounds])).toEqual([
      [deliver2Cut.run.id, null, null],
    ]);
    expect(detail?.item.progress).toBeNull();
    expect(failed).toEqual([item2.id]);
  });

  test("each run carries the item read's cause, typed; a start by hand has none", async () => {
    const receiptId = '3b184b44-b90a-4d4c-b205-15755501533d';
    const source = pageSource({ queue: 0, loaded: [] });
    const [triage, plan, deliver] = runsOf['1'] ?? [];
    if (triage === undefined || plan === undefined || deliver === undefined)
      throw new Error('item 1 has three runs');
    const planAfterTriage = {
      ...plan,
      metadata: { ...plan.metadata, resource_start: { receiptId, bindingId: 'b' } },
    };
    source.store.getItemRuns = async () => ({
      item: item1,
      runs: [triage, planAfterTriage, deliver],
      descendantIds: [],
    });
    source.store.listStartReceiptSources = async ids =>
      new Map(
        ids
          .filter(id => id === receiptId)
          .map(id => [
            id,
            {
              id,
              sourceInstanceId: 'fc-start-plan',
              sourceActor: { source: RUN_ENDED_SOURCE_ACTOR, id: triage.id },
            },
          ])
      );
    const detail = await readFactoryItem(source, itemInput(unexpected), '1');
    expect(detail?.runs.map(run => run.cause ?? null)).toEqual([
      null,
      { kind: 'run_ended', runId: triage.id, sourceInstanceId: 'fc-start-plan' },
      null,
    ]);
    expect(detail?.runs.map(run => run.cause ?? null)).toEqual(
      detail?.item.runs.map(run => run.cause)
    );
    expect(Object.hasOwn(detail?.runs[0] ?? {}, 'cause')).toBe(false);
  });

  test("a discoveries run, which no stage lists, gets facts and the view's name: its shadow decision on its row", async () => {
    const drain = drainFixture();
    const source = pageSource({ queue: 0, loaded: [] });
    const own = { ...drain.run, item_id: item1.id };
    source.store.getItemRuns = async () => ({
      item: item1,
      runs: [...(runsOf['1'] ?? []), own],
      descendantIds: [],
    });
    const listed = source.store.listEventsForRuns;
    source.store.listEventsForRuns = async (ids, types) => {
      const read = await listed(ids, types);
      if (ids.includes(own.id)) read.set(own.id, drain.events);
      return read;
    };
    const detail = await readFactoryItem(source, itemInput(unexpected), '1');
    const row = detail?.runs.find(run => run.runId === own.id);
    // Named as the view names it, so the item page reads it as the drain, not a raw id.
    expect(row?.workflow).toBe('discoveries');
    expect(row?.shadows.map(decision => [decision.workflow, decision.node])).toEqual([
      ['discoveries', 'result'],
    ]);
    expect(detail?.item.progress?.runs.map(run => run.workflow)).toEqual([
      'triage',
      'plan',
      'deliver',
    ]);
  });

  test('an unknown key reads null', async () => {
    const source = pageSource({ queue: 0, loaded: [] });
    expect(await readFactoryItem(source, itemInput(unexpected), '404')).toBeNull();
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
): { run: WorkflowRun; events: WorkflowEventRow[] } {
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

const PR12 = 'https://github.com/coleam00/archon-factory-console/pull/12';
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
const later = (
  entry: { run: WorkflowRun; events: WorkflowEventRow[] },
  at: string
): { run: WorkflowRun; events: WorkflowEventRow[] } => ({
  ...entry,
  run: { ...entry.run, started_at: new Date(at) },
});

describe('the three-stage delivery: the change from any stage, rounds from stage-check runs', () => {
  test('a stage-check run is one round: numbered and bounded by its result, decided by its verdict', () => {
    const facts = factsOf(checkRun('c1', '2026-11-21T01:00:00Z', 2, 3, 'return'));
    const steps = [...CHECKS, ['verdict__verdict', 'return'], ['rounds', 'return']] as const;
    expect(facts.rounds).toEqual({
      max: 3,
      rounds: [
        {
          iteration: 2,
          verdict: 'returned',
          outcome: 'return',
          summary: 'verdict__verdict said return',
          // Every step that recorded an outcome but `end`, which returns the result.
          steps: steps.map(([node, outcome]) => ({
            node,
            outcome,
            summary: `${node} said ${outcome}`,
          })),
        },
      ],
    });
    expect(facts.returnCount).toBe(1);
    expect(facts.change?.url).toBe(PR12);
  });

  test('a stage-check run still going, or one whose result names no round, is no round', () => {
    const running = stageRun('stage-check', 'c1', '2026-11-21T01:00:00Z', {}, CHECKS, 'running');
    expect(factsOf(running).rounds).toBeNull();
    const noRound = stageRun('stage-check', 'c2', '2026-11-21T01:00:00Z', {
      outcome: 'ask',
      round: 0,
      allowance: 3,
    });
    expect(factsOf(noRound).rounds).toBeNull();
  });

  test('an ask decides nothing: the round is undecided, the verdict step its outcome', () => {
    const asked = factsOf(checkRun('c1', '2026-11-21T01:00:00Z', 3, 3, 'ask'));
    expect(decisions(asked.rounds)).toEqual({
      max: 3,
      rounds: [{ iteration: 3, verdict: 'undecided', outcome: 'ask' }],
    });
  });

  test("the item's rounds are its stage-check runs, the newest allowance its bound: round 3 of 4", async () => {
    const runs = [
      buildRun('b1', '2026-11-21T01:00:00Z'),
      checkRun('c1', '2026-11-21T02:00:00Z', 1, 3, 'return'),
      buildRun('b2', '2026-11-21T03:00:00Z'),
      checkRun('c2', '2026-11-21T04:00:00Z', 2, 3, 'return'),
      buildRun('b3', '2026-11-21T05:00:00Z'),
      // After a one-more-round answer, the pack allows four.
      checkRun('c3', '2026-11-21T06:00:00Z', 3, 4, 'approve'),
      stageRun('stage-host', 'h1', '2026-11-21T07:00:00Z', {}, [], 'running'),
    ];
    expect((await progressOf(runs)).round).toEqual({
      runId: 'c3',
      iteration: 3,
      max: 4,
      rounds: [
        { iteration: 1, verdict: 'returned', outcome: 'return' },
        { iteration: 2, verdict: 'returned', outcome: 'return' },
        { iteration: 3, verdict: 'approved', outcome: 'approve' },
      ],
    });
  });

  test('a stage-check run going now adds no round: the newest recorded one stands', async () => {
    const runs = [
      checkRun('c1', '2026-11-21T02:00:00Z', 1, 3, 'return'),
      stageRun('stage-check', 'c2', '2026-11-21T04:00:00Z', {}, CHECKS, 'running'),
    ];
    const progress = await progressOf(runs);
    expect(progress.round).toMatchObject({ runId: 'c1', iteration: 1, max: 3 });
    expect(progress.running).toMatchObject({ runId: 'c2', workflow: 'stage-check' });
  });

  test('after a replan the rounds start again: only the new cycle is read', async () => {
    const runs = [
      checkRun('c1', '2026-11-21T02:00:00Z', 1, 3, 'return'),
      checkRun('c2', '2026-11-21T04:00:00Z', 2, 3, 'replan'),
      buildRun('b2', '2026-11-21T05:00:00Z'),
      checkRun('c3', '2026-11-21T06:00:00Z', 1, 3, 'return'),
    ];
    expect((await progressOf(runs)).round).toEqual({
      runId: 'c3',
      iteration: 1,
      max: 3,
      rounds: [{ iteration: 1, verdict: 'returned', outcome: 'return' }],
    });
  });

  test('the newest run with a round picks the form: the deliver loop, or the stage-check runs', async () => {
    const check = checkRun('c1', '2026-11-21T02:00:00Z', 1, 3, 'return');
    const deliver = later(deliver1, '2026-11-22T00:00:00Z');
    expect((await progressOf([check, deliver])).round?.runId).toBe(deliver1.run.id);
    const next = checkRun('c2', '2026-11-23T02:00:00Z', 2, 3, 'approve');
    expect((await progressOf([check, deliver, next])).round).toMatchObject({
      runId: 'c2',
      iteration: 2,
      rounds: [{ iteration: 1 }, { iteration: 2 }],
    });
  });

  test('the change is the newest stage run that names one, of any listed workflow', async () => {
    const stageBuild = stageRun('stage-build', 'b1', '2026-11-21T01:00:00Z', {
      outcome: 'built',
      change: PR11,
    });
    const stageHost = stageRun('stage-host', 'h1', '2026-11-21T03:00:00Z', {
      outcome: 'ready',
      change: PR12,
    });
    // An older stage-build URL is not taken over a newer stage-host one, and a newer run
    // still going (no result yet) or naming an empty one does not displace it.
    const going = stageRun('stage-check', 'c2', '2026-11-21T04:00:00Z', {}, [], 'running');
    const empty = stageRun('landgate', 'g1', '2026-11-21T05:00:00Z', {
      outcome: 'land',
      change: '',
    });
    expect((await progressOf([stageBuild, stageHost, going, empty])).change?.url).toBe(PR12);
    const rebuilt = later(stageBuild, '2026-11-22T00:00:00Z');
    expect((await progressOf([stageHost, rebuilt])).change?.url).toBe(PR11);
  });

  test("a land gate run whose result has no change does not displace a deliver run's", async () => {
    // Item 111's shape: deliver named the change; the land gate of that era returned none.
    const delivered = deliverNaming(deliver1, 'd1', PR10, '2026-11-20T01:00:00Z');
    const gate = stageRun('landgate', 'g1', '2026-11-20T02:00:00Z', { outcome: 'land' });
    expect(factsOf(gate).change).toBeNull();
    expect((await progressOf([delivered, gate])).change?.url).toBe(PR10);
  });
});
