import { describe, expect, test } from 'bun:test';
import { columnsOf } from '../../routes/BoardPage';
import { shippedGraph, shippedView } from '../curated.test-fixtures';
import { flowCounts } from '../DerivedFlow';
import type { ItemRead } from '../../skills/items';
import { itemOn, MOVING_ITEMS } from '../items.test-fixtures';
import { stageLive } from './map-live';

/** The board's Merged column: 92 in the last week, the newest two listed. */
const MERGED = { total: 92, items: [itemOn('m1', 'landed', 'done'), itemOn('m2', null, 'done')] };

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
const ITEMS = [...MOVING_ITEMS, older];

describe("the map's live chips", () => {
  const live = stageLive(shippedView, ITEMS, MERGED, shippedGraph.stages);
  const at = (stage: string) => live.stages.get(stage);

  test('an item sits on the card listing the graph stage its standing run is of', () => {
    expect(at('build')?.items.map(read => read.item.key)).toEqual(['b1', 'b2']);
    expect(at('triage')?.items.map(read => read.item.key)).toEqual(['t1', 's1']);
    expect(at('ready')?.items.map(read => read.item.key)).toEqual(['g1']);
  });

  test("a running item is worked, and one waiting on an ask needs you, as the board's chip says", () => {
    expect(at('build')).toMatchObject({ total: 2, working: 1 });
    expect(at('triage')).toMatchObject({ total: 2, working: 0 });
    expect(at('build')?.needYou.map(read => read.item.key)).toEqual(['b2']);
    expect(at('ready')?.needYou.map(read => read.item.key)).toEqual(['g1']);
  });

  test('a run that recorded no workflow name sits where the board puts it, by the graph stage name', () => {
    expect(at('checks')?.items.map(read => read.item.key)).toEqual(['c1', 'o1']);
  });

  test("the board's Merged column is counted on the landed card, its newest items listed there", () => {
    expect(at('landed')?.total).toBe(92);
    expect(at('landed')?.items.map(read => read.item.key)).toEqual(['m1', 'm2']);
  });

  test('an item on a stage no card shows is listed, not dropped', () => {
    expect(live.notOnMap.map(entry => [entry.item.item.key, entry.workflow])).toEqual([
      ['d1', 'discoveries'],
    ]);
  });

  test("each board column's count is the sum of its map stages' counts", () => {
    const counted = (workflows: readonly string[]): number =>
      shippedView.stages
        .filter(stage => stage.workflows.some(workflow => workflows.includes(workflow)))
        .reduce(
          (sum, stage) =>
            // The board's stage columns hold its moving items; its merged ones are its Merged column.
            sum + (at(stage.id)?.items.filter(read => read.standing.state !== 'done').length ?? 0),
          0
        );
    const offMap = (workflows: readonly string[]): number =>
      live.notOnMap.filter(entry => workflows.includes(entry.workflow ?? '')).length;
    for (const column of flowCounts(columnsOf(shippedGraph), ITEMS, shippedGraph.stages))
      expect([column.name, counted(column.stages) + offMap(column.stages)]).toEqual([
        column.name,
        column.count,
      ]);
  });
});
