import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type OverviewFlow, overviewFlow } from './overview-flow';
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
  const flow = flowOf(root) as OverviewFlow;

  test('three inputs into Triage, on through the stages, split at CI, the found line a shadow', () => {
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
    expect(flow.moves.find(move => move.to === 'found')?.shadow).toBe(true);
    expect(flow.moves.find(move => move.to === 'ready')?.shadow).toBe(false);
  });
});

const card = (id: string, kind: OverviewCard['kind'], col: number): OverviewCard => ({
  id,
  title: id,
  text: id,
  icon: 'hammer',
  kind,
  col,
  row: 1,
});

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
});
