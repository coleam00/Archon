import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardModel } from './board';
import { delivering, FIXTURE_NOW, idleInPlan, parkedByTriage, VIEW } from './board.test-fixtures';
import { stageLive } from './map-live';
import { stageIdOf, stageOfWorkflow } from './placement';
import type { FactoryViewListed } from './views';

/**
 * `packages/workflows/src/__fixtures__/factory-view-step-stages.json`: the coverage check's
 * `stageOfWorkflowStep` (`check:factory-view`) places the same steps in the same stages.
 */
const fixture = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      '../../../../../../workflows/src/__fixtures__/factory-view-step-stages.json'
    ),
    'utf8'
  )
) as {
  view: FactoryViewListed['declaration'];
  cases: { workflow: string; step: string | null; stage: string }[];
};

test('places each step as the coverage check does', () => {
  const placed = fixture.cases.map(entry => ({
    ...entry,
    stage: stageOfWorkflow(fixture.view, entry.workflow, entry.step)?.id,
  }));
  expect(placed).toEqual(fixture.cases);
});

test('the map counts what the board counts: a set-aside item is in no stage', () => {
  const fourDaysBefore = new Date(FIXTURE_NOW.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const items = [parkedByTriage('parked'), idleInPlan('idle', fourDaysBefore), delivering(null)];
  const board = boardModel(VIEW, 'cb-1', items, new Map(), FIXTURE_NOW);
  const map = stageLive(VIEW, 'cb-1', items, [], new Map(), FIXTURE_NOW);
  expect(board.setAside.map(entry => [entry.placed.item.item.key, entry.kind])).toEqual([
    ['parked', 'parked'],
    ['idle', 'idle'],
  ]);
  // Every stage lists exactly the cards the board's columns hold for it.
  const onBoard = board.columns.flatMap(column =>
    column.cards.map(placed => [stageIdOf(placed.column), placed.item.item.key])
  );
  const onMap: (string | undefined)[][] = [...map.stages].flatMap(([stage, live]) =>
    live.items.map(item => [stage, item.item.key])
  );
  expect(onMap).toEqual(onBoard);
  expect(onMap.map(([, key]) => key)).toEqual(['8']);
  expect(map.notOnMap).toEqual([]);
  // Where a set-aside item sat is kept, as the board keeps it, so its return is not a move.
  expect(map.positions.get('parked')).toBe(board.positions.get('parked'));
});
