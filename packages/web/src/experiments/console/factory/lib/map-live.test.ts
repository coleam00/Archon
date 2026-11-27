import { describe, expect, test } from 'bun:test';
import { columnsOf } from '../../routes/BoardPage';
import { testGraph, testView } from '../curated.test-fixtures';
import { flowCounts } from '../DerivedFlow';
import type { ItemRead } from '../../skills/items';
import { asksOn, itemOn, MOVING_ITEMS } from '../items.test-fixtures';
import { stageLive } from './map-live';

/** The items the board's Merged column lists. */
const MERGED = [itemOn('m1', 'landed', 'done'), itemOn('m2', null, 'done')];

/** A run from an older build recorded no workflow name: the graph stage's name places it. */
const older: ItemRead = (() => {
  const read = itemOn('o1', null, 'running');
  const [run] = read.runs;
  return {
    ...read,
    runs:
      run === undefined ? [] : [{ ...run, workflow: 'Wirasm/archon-software-factory:stage-check' }],
  };
})();
/** An item standing at a stage out of flow, which the map draws no row for. */
const ITEMS = [...MOVING_ITEMS, older, itemOn('r1', 'review', 'running')];

const byKey = (key: string): ItemRead => {
  const read = ITEMS.find(entry => entry.item.key === key);
  if (read === undefined) throw new Error(`No item ${key}`);
  return read;
};
/**
 * Open asks on a running item (b1) and a waiting one (g1). b2 waits with a question in its read
 * and no ask, which is not an ask.
 */
const ASKS = asksOn([byKey('b1'), byKey('g1')]);

describe("the map's live chips", () => {
  const live = stageLive(testView, ITEMS, MERGED, testGraph.stages, ASKS);
  const at = (stage: string) => live.stages.get(stage);

  test('an item sits on the row of the graph stage its standing run is of', () => {
    expect(at('stage-build')?.items.map(read => read.item.key)).toEqual(['b1', 'b2']);
    expect(at('triage')?.items.map(read => read.item.key)).toEqual(['t1']);
    expect(at('landgate')?.items.map(read => read.item.key)).toEqual(['g1']);
  });

  test("a running item is worked, and an item with open asks needs you, as its card's button says", () => {
    expect(at('stage-build')?.items).toHaveLength(2);
    expect(at('stage-build')?.working).toBe(1);
    expect(at('split')?.items).toHaveLength(1);
    expect(at('split')?.working).toBe(0);
    // b1 runs and has an ask; b2 has a question in its read but no ask, so it is not counted.
    expect(at('stage-build')?.needYou.map(read => read.item.key)).toEqual(['b1']);
    expect(at('landgate')?.needYou.map(read => read.item.key)).toEqual(['g1']);
  });

  test('no stage needs you while the asks are read, rather than a guess', () => {
    const reading = stageLive(testView, ITEMS, MERGED, testGraph.stages, 'reading');
    expect([...reading.stages.values()].flatMap(stage => stage.needYou)).toEqual([]);
  });

  test('a run that recorded no workflow name sits where the board puts it, by the graph stage name', () => {
    expect(at('stage-check')?.items.map(read => read.item.key)).toEqual(['c1', 'o1']);
  });

  test("the board's Merged column's items are listed, and so counted, on the landed card", () => {
    expect(at('landed')?.items.map(read => read.item.key)).toEqual(['m1', 'm2']);
  });

  test('an item on a stage the map has no row for is listed, not dropped', () => {
    expect(live.notOnMap.map(entry => [entry.item.item.key, entry.workflow])).toEqual([
      ['r1', 'review'],
    ]);
  });

  test("each board column's count is the sum of its map stages' counts", () => {
    const counted = (workflows: readonly string[]): number =>
      testView.stages
        .filter(stage => stage.workflows.some(workflow => workflows.includes(workflow)))
        .reduce(
          (sum, stage) =>
            // The board's stage columns hold its moving items; its merged ones are its Merged column.
            sum + (at(stage.id)?.items.filter(read => read.standing.state !== 'done').length ?? 0),
          0
        );
    const offMap = (workflows: readonly string[]): number =>
      live.notOnMap.filter(entry => workflows.includes(entry.workflow ?? '')).length;
    for (const column of flowCounts(columnsOf(testGraph), ITEMS, testGraph.stages, ASKS))
      expect([column.name, counted(column.stages) + offMap(column.stages)]).toEqual([
        column.name,
        column.count,
      ]);
  });
});
