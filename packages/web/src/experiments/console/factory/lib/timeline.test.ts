import { describe, expect, test } from 'bun:test';
import type { FactoryItemDetail } from '../../skills/factory';
import { itemDetail, shippedView } from '../item-detail.test-fixtures';
import { askItem, gateItem } from '../../lib/needs-you.test-fixtures';
import { buildTimeline, type TimelineRow } from './timeline';

/** An outcome the declaration words, and a pack token it does not, drawn in mono. */
const said = (text: string) => ({ text, mono: false });
const token = (text: string) => ({ text, mono: true });
const timeline = (detail: FactoryItemDetail): TimelineRow[] => buildTimeline(shippedView, detail);

describe('the timeline of an item that landed', () => {
  const detail = itemDetail('1');
  const rows = timeline(detail);

  test('one row per run, in start order, with its workflow and outcome', () => {
    expect(rows.map(row => [row.workflow, row.outcome])).toEqual([
      // Each outcome as the declaration's `placement` reads it: where it sent the item.
      ['triage', said('sent to Plan')],
      ['plan', said('sent to Build')],
      ['deliver', said('sent to Ready to merge')],
    ]);
    expect(rows.map(row => row.runId)).toEqual(detail.item.runs.map(run => run.id));
  });
});

describe('the timeline of an item asked twice', () => {
  const detail = itemDetail('3');
  const rows = timeline(detail);

  test('both deliver runs ending in an ask', () => {
    const delivers = rows.filter(row => row.workflow === 'deliver');
    expect(delivers.map(row => [row.outcome, row.kind])).toEqual([
      [said('asked you'), 'asked'],
      [said('asked you'), 'asked'],
    ]);
    // Each with the question it left, answered since, for the hover.
    const question = (runId: string | undefined) =>
      detail.item.answers.flatMap(a => (a.kind === 'ask' && a.runId === runId ? [a.question] : []));
    expect(delivers.map(row => row.asked)).toEqual(delivers.map(row => question(row.runId)));
    expect(delivers.map(row => row.asked.length)).toEqual([1, 1]);
  });
});

describe('a running run', () => {
  const detail = itemDetail('6');
  const rows = timeline(detail);
  const running = rows.at(-1);

  test('shows its live step by name', () => {
    expect(running?.status).toBe('running');
    expect(running?.outcome).toEqual(said('running'));
    expect(running?.kind).toBe('running');
    expect(running?.liveStep).toBe('build__build');
    expect(running?.liveStepName).toBe('Writes the change');
  });
});

describe('an outcome the declaration says nothing about', () => {
  test("stays the pack's token, drawn as an identifier", () => {
    const detail = itemDetail('1');
    const [triage, ...rest] = detail.item.runs;
    if (triage === undefined) throw new Error('item 1 has runs');
    // No `placement` and no `endings` entry for it.
    const unmapped = { ...shippedView, endings: {} };
    const rows = buildTimeline(unmapped, {
      ...detail,
      item: { ...detail.item, runs: [{ ...triage, outcome: 'skip' }, ...rest] },
    });
    expect(rows[0]?.outcome).toEqual(token('skip'));
  });

  test('an ending the declaration labels reads as that label', () => {
    const detail = itemDetail('1');
    const [triage, ...rest] = detail.item.runs;
    if (triage === undefined) throw new Error('item 1 has runs');
    const rows = timeline({
      ...detail,
      item: { ...detail.item, runs: [{ ...triage, outcome: 'fold' }, ...rest] },
    });
    expect(rows[0]?.outcome).toEqual(said('Folded into another item'));
    expect(rows[0]?.kind).toBe('stopped');
  });

  test('a parked outcome reads as its declared label, not the stage it sits in', () => {
    const detail = itemDetail('1');
    const [triage] = detail.item.runs;
    if (triage === undefined) throw new Error('item 1 has runs');
    const rows = timeline({
      ...detail,
      item: { ...detail.item, runs: [{ ...triage, outcome: 'park' }] },
    });
    expect(rows[0]?.outcome).toEqual(said('Parked by triage'));
    expect(rows[0]?.kind).toBe('other');
  });
});

describe('a gate that records no outcome', () => {
  test('reads as where `workflow:*` sent the item, as the board places it', () => {
    const detail = itemDetail('1');
    const [triage, ...rest] = detail.item.runs;
    if (triage === undefined) throw new Error('item 1 has runs');
    const gate = { ...triage, id: 'gate', workflow: 'Wirasm/archon-software-factory:landgate' };
    const rows = buildTimeline(shippedView, {
      ...detail,
      item: { ...detail.item, runs: [...rest, { ...gate, outcome: null }] },
      runs: [...detail.runs.slice(1), { ...detail.runs[0]!, runId: 'gate', workflow: 'landgate' }],
    });
    expect(rows.at(-1)?.outcome).toEqual(said('sent to Ready to merge'));
  });
});

describe('a run that asked', () => {
  const detail = itemDetail('3');
  const deliver = detail.item.runs.find(run => run.outcome === 'ask');
  if (deliver === undefined) throw new Error('item 3 has a deliver run that asked');
  const rowOf = (changed: FactoryItemDetail, view = shippedView) =>
    buildTimeline(view, changed).find(row => row.runId === deliver.id);
  const withItem = (item: Partial<FactoryItemDetail['item']>): FactoryItemDetail => ({
    ...detail,
    item: { ...detail.item, ...item },
  });
  const noAsks = withItem({ answers: [], questions: [] });

  test('reads "asked you" from a declared `asked` outcome, with no asks recorded', () => {
    expect([rowOf(noAsks)?.outcome, rowOf(noAsks)?.asked]).toEqual([said('asked you'), []]);
    // Without the declaration it reads where `placement` sends it.
    const { asked: _asked, ...undeclared } = shippedView;
    expect(rowOf(noAsks, undeclared)?.outcome).toEqual(said('sent to Build'));
    // `deliver:*` takes every outcome, but not a run that recorded none.
    const anyOutcome = { ...shippedView, asked: ['deliver:*'] };
    expect(rowOf(noAsks, anyOutcome)?.outcome).toEqual(said('asked you'));
    const noOutcome = {
      ...noAsks,
      item: {
        ...noAsks.item,
        runs: noAsks.item.runs.map(run =>
          run.id === deliver.id ? { ...run, outcome: null } : run
        ),
      },
    };
    expect(rowOf(noOutcome, anyOutcome)?.outcome).not.toEqual(said('asked you'));
  });

  test('reads "asked you" over its placement when it left asks on the item', () => {
    const returned = withItem({
      runs: detail.item.runs.map(run =>
        run.id === deliver.id ? { ...run, outcome: 'returned' } : run
      ),
    });
    const row = rowOf(returned);
    expect(row?.outcome).toEqual(said('asked you'));
    expect(row?.asked).toHaveLength(1);
  });

  test("an open ask counts by the run it was asked in, not a gate's own question", () => {
    const placed = noAsks.item.runs.map(run =>
      run.id === deliver.id ? { ...run, outcome: 'returned' } : run
    );
    const message = 'Merge it now?';
    const asked = askItem({ message, askedIn: { runId: deliver.id, workflow: 'deliver' } });
    const gate = askItem({ message, run: { ...gateItem().run, id: deliver.id } });
    const withQuestion = (question: typeof asked) =>
      rowOf({ ...noAsks, item: { ...noAsks.item, runs: placed, questions: [question] } });
    expect([withQuestion(asked)?.outcome, withQuestion(asked)?.asked]).toEqual([
      said('asked you'),
      [message],
    ]);
    expect([withQuestion(gate)?.outcome, withQuestion(gate)?.asked]).toEqual([
      said('sent to Build'),
      [],
    ]);
  });

  test('a run still running reads as running, whatever it later ends with', () => {
    const running = withItem({
      runs: detail.item.runs.map(run =>
        run.id === deliver.id ? { ...run, status: 'running' as const, completedAt: null } : run
      ),
    });
    expect(rowOf(running)?.outcome).toEqual(said('running'));
  });
});

describe('shadow decisions on the timeline', () => {
  const at = '2026-11-17T01:00:00.000Z';

  test('each run lists what its shadow steps decided, worded, under that run only', () => {
    const detail = itemDetail('1');
    const [triage, , deliver] = detail.runs;
    if (triage === undefined || deliver === undefined) throw new Error('item 1 has three runs');
    triage.shadows = [
      {
        workflow: 'triage',
        node: 'admit',
        round: null,
        runId: triage.runId,
        decidedAt: at,
        read: { reads: 'verdict', value: 'ask', why: 'No policy says it may start.' },
      },
    ];
    deliver.shadows = [
      {
        workflow: 'deliver',
        node: 'rounds.checks',
        round: 2,
        runId: deliver.runId,
        decidedAt: at,
        read: {
          reads: 'checks',
          results: [{ name: 'lint', passed: true, seconds: 56, tail: null }],
        },
      },
    ];
    const rows = timeline(detail);
    expect(
      rows.map(row => row.shadows.map(entry => [entry.label, entry.round, entry.words.line]))
    ).toEqual([
      [['Would it start on its own', null, 'would ask you first']],
      [],
      [['Project checks', 2, '1 check · all passed · 56 s']],
    ]);
    expect(rows[0]?.shadows[0]?.words.detail).toBe('No policy says it may start.');
  });

  test('a run of a workflow no stage lists keeps its decisions', () => {
    const detail = itemDetail('1');
    const [first] = detail.runs;
    if (first === undefined) throw new Error('item 1 has runs');
    first.workflow = null;
    first.shadows = [
      {
        workflow: 'discoveries',
        node: 'result',
        round: null,
        runId: first.runId,
        decidedAt: at,
        read: { reads: 'lists', counts: [1, 3, 0, 2], why: null },
      },
    ];
    expect(timeline(detail)[0]?.shadows.map(entry => entry.words.line)).toEqual([
      'would file 1 · would fold into open items 3 · would drop 2',
    ]);
  });
});

describe('what each run did to the item, for its icon', () => {
  /** Item 1 with its deliver run's outcome replaced. */
  const deliverEnding = (patch: Partial<FactoryItemDetail['item']['runs'][number]>) => {
    const detail = itemDetail('1');
    const runs = detail.item.runs.map((run, i) => (i === 2 ? { ...run, ...patch } : run));
    return timeline({ ...detail, item: { ...detail.item, runs } })[2];
  };

  test('a placement into a later stage sends it on', () => {
    expect(timeline(itemDetail('1')).map(row => row.kind)).toEqual([
      'sent-on',
      'sent-on',
      'sent-on',
    ]);
  });

  test("a placement into a stage before the run's furthest one, by the board order, returns it", () => {
    // deliver works Build to Host: "returned" lands in Build, "replan" in Plan before it.
    expect(deliverEnding({ outcome: 'returned' })?.kind).toBe('returned');
    expect(deliverEnding({ outcome: 'replan' })?.kind).toBe('returned');
    expect(deliverEnding({ outcome: 'replan' })?.outcome).toEqual(said('sent to Plan'));
  });

  test('a placement into the furthest stage the run works sends it on: the land gate', () => {
    // `landgate:*` places the item in Ready to merge, the stage the gate itself works.
    const detail = itemDetail('1');
    const runs = detail.item.runs.map((run, i) =>
      i === 2 ? { ...run, workflow_name: 'landgate', outcome: null } : run
    );
    const facts = detail.runs.map((run, i) => (i === 2 ? { ...run, workflow: 'landgate' } : run));
    const row = timeline({ ...detail, item: { ...detail.item, runs }, runs: facts })[2];
    expect([row?.outcome, row?.kind]).toEqual([said('sent to Ready to merge'), 'sent-on']);
    expect(deliverEnding({ outcome: 'waiting' })?.kind).toBe('sent-on');
  });

  test('a run that stopped to ask, one that failed, one running, one ended', () => {
    const asked = timeline(itemDetail('3')).filter(row => row.workflow === 'deliver');
    expect(asked.map(row => row.kind)).toEqual(['asked', 'asked']);
    expect(deliverEnding({ status: 'failed' })?.kind).toBe('failed');
    expect(deliverEnding({ status: 'cancelled' })?.kind).toBe('failed');
    expect(timeline(itemDetail('6')).at(-1)?.kind).toBe('running');
    const detail = itemDetail('1');
    const [triage, ...rest] = detail.item.runs;
    if (triage === undefined) throw new Error('item 1 has runs');
    const ended = timeline({
      ...detail,
      item: { ...detail.item, runs: [{ ...triage, outcome: 'decline' }, ...rest] },
    });
    expect(ended[0]?.kind).toBe('stopped');
  });
});
