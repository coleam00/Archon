import { describe, expect, test } from 'bun:test';
import { testArrows, testView } from '../curated.test-fixtures';
import { branchFlow, mapFlow } from './map-flow';
import { layoutMap } from './map-layout';

const layout = layoutMap(testView, testArrows);
const legs = layout.arrows.map(arrow => ({
  from: arrow.from,
  to: arrow.to,
  points: [arrow.start, arrow.end],
}));

describe('the map flow', () => {
  test('one dot along every forward hand-off, in order, back to back, on one period', () => {
    const flow = mapFlow(legs);
    expect(flow?.moves.map(move => [move.from, move.to])).toEqual(
      layout.arrows.map(arrow => [arrow.from, arrow.to])
    );
    const moves = flow?.moves ?? [];
    moves.forEach((move, i) => {
      expect(move.end).toBeGreaterThan(move.start);
      const next = moves[i + 1];
      // A beat on the card between one hand-off and the next: never two dots at once.
      if (next !== undefined) expect(next.start).toBeGreaterThan(move.end);
    });
    expect(moves[0]?.start).toBe(0);
    expect(flow?.period ?? 0).toBeGreaterThan(moves.at(-1)?.end ?? Number.POSITIVE_INFINITY);
  });

  test('no hand-off, no flow', () => {
    expect(mapFlow([])).toBeUndefined();
    expect(branchFlow([])).toBeUndefined();
  });

  test("a card's branches all leave at once, one per route", () => {
    const routes = layout.sendBacks.get('checks')?.routes ?? [];
    const flow = branchFlow(routes);
    expect(flow?.moves).toHaveLength(routes.length);
    for (const move of flow?.moves ?? []) expect(move.start).toBe(0);
  });
});
