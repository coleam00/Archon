import { describe, expect, test } from 'bun:test';
import type { FactoryItemDetail } from '../../skills/factory';
import { itemDetail, shippedView } from '../item-detail.test-fixtures';
import { roundHeading, roundsGrid, type GridColumn, type RoundsGrid } from './item-rounds-grid';
import { storyVisits } from './item-visits';
import { buildTimeline } from './timeline';

/** The grid of the item's Checks panel. */
function checksGrid(detail: FactoryItemDetail): RoundsGrid | null {
  const visits = storyVisits(shippedView, detail);
  const at = visits.findIndex(visit => visit.stage.id === 'checks');
  const visit = visits[at];
  if (visit === undefined) throw new Error('no Checks panel');
  return roundsGrid(shippedView, detail, buildTimeline(shippedView, detail), visit, visits[at + 1]);
}

/** The columns of every Checks panel on the item, in order: a replan can split the panel. */
function checksColumns(detail: FactoryItemDetail): GridColumn[] {
  const visits = storyVisits(shippedView, detail);
  const timeline = buildTimeline(shippedView, detail);
  return visits.flatMap((visit, at) =>
    visit.stage.id === 'checks'
      ? (roundsGrid(shippedView, detail, timeline, visit, visits[at + 1])?.columns ?? [])
      : []
  );
}

/** `detail` with a copy of run `runId`, as `copyId`, placed in the item's runs right after `afterId`. */
function withRunCopy(
  detail: FactoryItemDetail,
  runId: string,
  copyId: string,
  afterId: string
): FactoryItemDetail {
  const fact = detail.runs.find(run => run.runId === runId);
  const entry = detail.item.runs.find(run => run.id === runId);
  const at = detail.item.runs.findIndex(run => run.id === afterId);
  if (fact === undefined || entry === undefined || at === -1) throw new Error('no such run');
  detail.runs.push({ ...structuredClone(fact), runId: copyId });
  detail.item.runs.splice(at + 1, 0, { ...structuredClone(entry), id: copyId });
  return detail;
}

/** Each row as its label and its cells' words, stacked cells joined by "+", none "-". */
const table = (grid: RoundsGrid | null): string[][] =>
  (grid?.rows ?? []).map(row => [
    row.label,
    ...row.cells.map(cells => cells.map(cell => cell.text).join('+') || '-'),
  ]);

describe('the rounds grid of a loop-form delivery (one deliver run)', () => {
  const grid = checksGrid(itemDetail('111'));

  test('its two rounds are the columns, with the allowance', () => {
    expect(grid?.columns.map(c => [c.iteration, c.max, c.verdict])).toEqual([
      [1, 3, 'returned'],
      [2, 3, 'approved'],
    ]);
    expect(grid?.columns[0]?.reason).toStartWith('Return. The approach');
    expect(grid?.columns[1]?.reason).toBeNull();
  });

  test('rows: the declared checks in the order the view names them, the fix, CI, the shadow', () => {
    expect(table(grid)).toEqual([
      ['Code review', 'Sent back', 'Approved'],
      ['Test check', 'Sent back', 'Approved'],
      ['Product check', 'Sent back', 'Approved'],
      ['Verdict', 'Sent back', 'Approved'],
      // The fix step ran at the start of round 2, answering round 1.
      ['Build', 'Fixed', '-'],
      ['CI and review', '-', 'Approved'],
      ['Project checks', '4 checks · all passed · 3 min', '4 checks · all passed · 4 min'],
    ]);
    // "Posts the review" only restates the verdict: no declared meaning, no row.
    expect(grid?.rows.map(row => row.label)).not.toContain('Posts the review');
    expect(grid?.rows.at(-1)?.shadow).toBe(true);
    expect(grid?.rows.at(-1)?.cells[0]?.[0]?.meaning).toBe('shadow');
  });
});

/**
 * `detail` as the server reads it under the shipped view: only the shadow steps the view
 * declares decide. Item 125 was captured while stage-check still ran the project checks as a
 * shadow; the pack dropped that step, and the view with it.
 */
function readUnderShippedView(detail: FactoryItemDetail): FactoryItemDetail {
  const declared = new Set(
    (shippedView.shadows ?? []).map(shadow => `${shadow.workflow}/${shadow.node}`)
  );
  for (const run of detail.runs)
    run.shadows = run.shadows.filter(entry => declared.has(`${run.workflow}/${entry.node}`));
  return detail;
}

describe('the rounds grid of a stage-form delivery (a stage-check run per round)', () => {
  const grid = checksGrid(readUnderShippedView(structuredClone(itemDetail('125'))));

  test('each run is one column, numbered and bounded by its own result', () => {
    expect(grid?.columns.map(c => [c.iteration, c.max, c.verdict])).toEqual([
      [1, 3, 'returned'],
      [2, 3, 'returned'],
      [3, 3, 'returned'],
      [4, 4, 'undecided'],
    ]);
  });

  test('the builds between the runs are the fix row; CI after the last round stacks its results', () => {
    expect(table(grid)).toEqual([
      ['Code review', 'Approved', 'Approved', 'Approved', 'Asked you'],
      ['Test check', 'Sent back', 'Approved', 'Approved', 'Approved'],
      ['Product check', 'Approved', 'Sent back', 'Sent back', 'Approved'],
      ['Verdict', 'Sent back', 'Sent back', 'Sent back', 'Asked you'],
      // After round 2 the builder asked first, then fixed once answered.
      ['Build', 'Fixed', 'Asked you+Fixed', 'Fixed', '-'],
      ['CI and review', '-', '-', '-', 'Sent back+Approved'],
      // No project checks row: stage-check no longer runs them, so no shadow is declared there.
    ]);
  });
});

describe('a cell', () => {
  test('a check that recorded no outcome in a round reads Not run (an empty cell)', () => {
    const detail = structuredClone(itemDetail('111'));
    const deliver = detail.runs.find(run => run.workflow === 'deliver');
    const round = deliver?.rounds?.rounds[1];
    if (round === undefined) throw new Error('item 111 has two rounds');
    round.steps = round.steps.filter(step => step.node !== 'rounds.product__product');
    expect(table(checksGrid(detail)).find(row => row[0] === 'Product check')).toEqual([
      'Product check',
      'Sent back',
      '-',
    ]);
  });

  test("an outcome the view does not word stays the pack's token", () => {
    const detail = structuredClone(itemDetail('111'));
    const step = detail.runs
      .find(run => run.workflow === 'deliver')
      ?.rounds?.rounds[0]?.steps.find(entry => entry.node === 'rounds.review__review');
    if (step === undefined) throw new Error('item 111 reviewed');
    step.outcome = 'replan';
    const cell = checksGrid(detail)?.rows[0]?.cells[0]?.[0];
    expect([cell?.meaning, cell?.text]).toEqual(['token', 'replan']);
  });
});

describe('round numbers on the item, not as each run recorded them', () => {
  /** Item 125 with its second stage-check run recording round 1 again, as 119's runs did. */
  function repeated(): FactoryItemDetail {
    const detail = structuredClone(itemDetail('125'));
    const second = detail.runs.find(run => run.runId.startsWith('bb11ef33'));
    const round = second?.rounds?.rounds[0];
    if (round === undefined) throw new Error('125 has a second round');
    round.iteration = 1;
    return detail;
  }

  test('two runs that both record round 1: the columns read 1, 2, 3, 4; each allowance its own', () => {
    const grid = checksGrid(repeated());
    expect(grid?.columns.map(column => [column.number, column.max])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
      [4, 4],
    ]);
    // The round as the run recorded it stays, for matching what was decided in it.
    expect(grid?.columns.map(column => column.iteration)).toEqual([1, 1, 3, 4]);
  });

  test('a loop-form delivery counts its iterations in order, with no delivery prefix', () => {
    const columns = checksGrid(itemDetail('111'))?.columns ?? [];
    expect(columns.map(column => [column.number, column.delivery])).toEqual([
      [1, null],
      [2, null],
    ]);
    expect(columns.map(roundHeading)).toEqual(['Round 1 of 3', 'Round 2 of 3']);
  });

  test('a replan between stage-form rounds starts the count over', () => {
    const base = structuredClone(itemDetail('125'));
    const plan = base.runs.filter(run => run.workflow === 'plan').at(-1)?.runId;
    const second = base.item.runs.find(run => run.id.startsWith('bb11ef33'))?.id;
    if (plan === undefined || second === undefined) throw new Error('125 planned, then checked');
    const columns = checksColumns(withRunCopy(base, plan, 'replan-run', second));
    expect(columns.map(column => [column.number, column.max])).toEqual([
      [1, 3],
      [2, 3],
      [1, 3],
      [2, 4],
    ]);
    expect(columns.map(column => column.iteration)).toEqual([1, 2, 3, 4]);
  });

  test('two loop-form delivery runs with no replan: each counts its own rounds, named by its run', () => {
    // Item 3's capture is such an item: each deliver run ended in an ask, and the answer
    // launched the next. Item 111 is used for its recorded rounds.
    const base = structuredClone(itemDetail('111'));
    const deliver = base.runs.find(run => run.workflow === 'deliver')?.runId;
    if (deliver === undefined) throw new Error('111 delivered');
    const columns = checksColumns(withRunCopy(base, deliver, 'second-deliver', deliver));
    expect(columns.map(column => [column.number, column.max, column.delivery])).toEqual([
      [1, 3, 1],
      [2, 3, 1],
      [1, 3, 2],
      [2, 3, 2],
    ]);
    expect(columns.map(roundHeading)).toEqual([
      'Delivery 1 · round 1 of 3',
      'Delivery 1 · round 2 of 3',
      'Delivery 2 · round 1 of 3',
      'Delivery 2 · round 2 of 3',
    ]);
  });

  test('a delivery run that recorded no round takes no place: one with rounds reads as plain rounds', () => {
    const base = structuredClone(itemDetail('111'));
    const deliver = base.runs.find(run => run.workflow === 'deliver')?.runId;
    if (deliver === undefined) throw new Error('111 delivered');
    const detail = withRunCopy(base, deliver, 'asked-first', deliver);
    const asked = detail.runs.find(run => run.runId === 'asked-first');
    if (asked?.rounds == null) throw new Error('the copy has rounds');
    asked.rounds.rounds = [];
    expect(checksColumns(detail).map(roundHeading)).toEqual(['Round 1 of 3', 'Round 2 of 3']);
  });
});
