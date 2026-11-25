import { describe, expect, test } from 'bun:test';
import { shippedFile } from '../curated.test-fixtures';
import { type OverviewFlow, overviewFlow } from './overview-flow';
import { layoutOverview } from './overview-layout';
import type { OverviewCard, OverviewDeclaration, OverviewView } from './overview-nav';

/** The How it works picture the Wirasm pack's curated view file carries. */
const shipped: OverviewDeclaration = shippedFile.howItWorks;
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

  test('three inputs into Triage, on through Link and the stages, split at CI', () => {
    expect(order(flow)).toEqual([
      'found->triage',
      'issue->triage',
      'order->triage',
      'triage->link',
      'link->plan',
      'plan->build',
      'build->checks',
      'checks->ci',
      'ci->found',
      'ci->ready',
      'ready->landed',
    ]);
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
