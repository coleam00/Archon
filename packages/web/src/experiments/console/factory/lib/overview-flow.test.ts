import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Point } from './map-layout';
import { FLOW_DWELL, FLOW_TEMPO, type OverviewFlow, overviewFlow } from './overview-flow';
import { layoutOverview } from './overview-layout';
import type { OverviewCard, OverviewDeclaration, OverviewView } from './overview-nav';

/** The overview this repository ships, as the server lists it. */
const shipped = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      '../../../../../../../.archon/packs/Wirasm.archon-software-factory.factory-overview.json'
    ),
    'utf8'
  )
) as OverviewDeclaration;
const root = shipped.views[shipped.root] as OverviewView;

const flowOf = (view: OverviewView): OverviewFlow | undefined =>
  overviewFlow(view, layoutOverview(view));

/** Moves in the order they start, ties by source id: `from->to` each. */
const order = (flow: OverviewFlow): string[] =>
  [...flow.moves]
    .sort((a, b) => a.start - b.start || a.from.localeCompare(b.from))
    .map(move => `${move.from}->${move.to}`);

describe('the How it works flow on the shipped root view', () => {
  const layout = layoutOverview(root);
  const flow = overviewFlow(root, layout) as OverviewFlow;

  test('three inputs into Triage together, on through the stages, split at CI and reviews', () => {
    expect(order(flow)).toEqual([
      'found->triage',
      'issue->triage',
      'order->triage',
      'triage->plan',
      'plan->build',
      'build->checks',
      'checks->ci',
      'ci->found',
      'ci->ready',
      'ready->landed',
    ]);
    const inputs = flow.moves.filter(move => move.to === 'triage');
    expect(new Set(inputs.map(move => `${move.start.toString()}-${move.end.toString()}`))).toEqual(
      new Set(['0-' + (inputs[0]?.end ?? 0).toString()])
    );
    const split = flow.moves.filter(move => move.from === 'ci');
    expect(split.map(move => move.start)).toEqual([split[0]?.start ?? -1, split[0]?.start ?? -1]);
    expect(flow.moves.find(move => move.to === 'found')?.shadow).toBe(true);
    expect(flow.moves.find(move => move.to === 'ready')?.shadow).toBe(false);
  });

  test('each card glows for a beat between the dot arriving and the next leaving', () => {
    expect([...flow.glows].sort((a, b) => a.start - b.start).map(glow => glow.card)).toEqual([
      'triage',
      'plan',
      'build',
      'checks',
      'ci',
      'ready',
      'landed',
      'found',
    ]);
    for (const glow of flow.glows) {
      expect(glow.end - glow.start).toBeCloseTo(FLOW_DWELL, 6);
      const arrivals = flow.moves.filter(move => move.to === glow.card).map(move => move.end);
      expect(arrivals).toContain(glow.start);
      // An input's own dot leaves at the start of the next loop, not after its glow.
      for (const leaving of flow.moves.filter(move => move.from === glow.card && move.start > 0))
        expect(leaving.start).toBe(glow.end);
    }
    const ends = [...flow.moves.map(m => m.end), ...flow.glows.map(g => g.end)];
    expect(flow.period).toBeGreaterThan(Math.max(...ends));
  });

  test('the dots follow the lines the page draws', () => {
    for (const move of flow.moves.filter(m => m.to !== 'triage')) {
      const edge = layout.edges.find(e => e.from === move.from && e.to === move.to);
      expect(move.points).toEqual(edge?.points ?? []);
    }
    const into = layout.edges.find(e => e.from === 'inputs' && e.to === 'triage');
    const fan = layout.fans.find(f => f.group === 'inputs' && !f.into);
    for (const move of flow.moves.filter(m => m.to === 'triage')) {
      expect(move.points[0] as Point).toEqual(
        fan?.stubs.find(s => s.card === move.from)?.from as Point
      );
      expect(move.points.at(-1) as Point).toEqual(into?.points.at(-1) as Point);
      // A repeated point is a zero-length run, which `rounded` would draw as NaN.
      move.points.slice(1).forEach((p, i) => expect(p).not.toEqual(move.points[i] as Point));
    }
  });
});

describe('the loop runs at one tempo', () => {
  test('every duration is two thirds of the loop at tempo 1', () => {
    expect(FLOW_TEMPO).toBe(2 / 3);
    const layout = layoutOverview(root);
    const fast = overviewFlow(root, layout) as OverviewFlow;
    const slow = overviewFlow(root, layout, 1) as OverviewFlow;
    expect(fast.period).toBeCloseTo((slow.period * 2) / 3, 6);
    expect(fast.moves.length).toBe(slow.moves.length);
    fast.moves.forEach((move, i) => {
      expect(move.start).toBeCloseTo(((slow.moves[i]?.start ?? NaN) * 2) / 3, 6);
      expect(move.end).toBeCloseTo(((slow.moves[i]?.end ?? NaN) * 2) / 3, 6);
    });
    fast.glows.forEach((glow, i) => {
      expect(glow.start).toBeCloseTo(((slow.glows[i]?.start ?? NaN) * 2) / 3, 6);
      expect(glow.end).toBeCloseTo(((slow.glows[i]?.end ?? NaN) * 2) / 3, 6);
    });
  });
});

const card = (
  id: string,
  kind: OverviewCard['kind'],
  col: number,
  row = 1,
  extra: Partial<OverviewCard> = {}
): OverviewCard => ({ id, title: id, text: id, icon: 'hammer', kind, col, row, ...extra });

describe('the flow is read from kinds, not ids', () => {
  test('a view with made-up ids gets the same shape', () => {
    const view: OverviewView = {
      cards: [card('a', 'input', 1), card('b', 'stage', 2), card('c', 'check', 3)],
      edges: [
        { from: 'a', to: 'b', kind: 'feeds' },
        { from: 'b', to: 'c', kind: 'feeds' },
        { from: 'c', to: 'b', kind: 'loops-back', label: 'sent back' },
        { from: 'c', to: 'a', kind: 'loops-back', label: 'new work' },
      ],
    };
    const flow = flowOf(view) as OverviewFlow;
    expect(order(flow)).toEqual(['a->b', 'b->c', 'c->a']);
    expect(flow.glows.map(glow => glow.card)).toEqual(['b', 'c', 'a']);
  });

  test('no input, or two places work starts, gives no flow', () => {
    expect(
      flowOf({
        cards: [card('a', 'stage', 1), card('b', 'stage', 2)],
        edges: [{ from: 'a', to: 'b', kind: 'feeds' }],
      })
    ).toBeUndefined();
    expect(
      flowOf({
        cards: [card('a', 'input', 1), card('b', 'stage', 2), card('x', 'input', 3)],
        edges: [
          { from: 'a', to: 'b', kind: 'feeds' },
          { from: 'x', to: 'b', kind: 'feeds' },
        ],
      })
    ).toBeUndefined();
  });
});
