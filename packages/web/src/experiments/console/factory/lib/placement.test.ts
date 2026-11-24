import { describe, expect, test } from 'bun:test';
import { itemDetail, shippedView } from '../item-detail.test-fixtures';
import type { FactoryItem } from '../../skills/factory';
import { endLastRun, landRunning, PAGE, progressOf, realItem, VIEW } from './board.test-fixtures';
import {
  itemColumn,
  pageItemColumn,
  placementInput,
  type ItemColumn,
  type PlacementInput,
  type PlacementRun,
} from './placement';

const view = shippedView;
const run = (
  workflow: string | null,
  status: PlacementRun['status'],
  outcome: string | null = null,
  step: string | null = null,
  failedStep: string | null = null
): PlacementRun => ({ workflow, status, outcome, step, failedStep });
const where = (column: ItemColumn | null): string | null =>
  column === null ? null : 'stage' in column ? column.stage.id : `ended: ${column.ended}`;

// Short constructors keep each row of the rules table on one line.
const done = (wf: string, outcome: string | null = null) => run(wf, 'completed', outcome);
const going = (wf: string | null, step: string | null = null) => run(wf, 'running', null, step);
const failed = (wf: string, step: string | null = null) => run(wf, 'failed', null, null, step);
const ready = done('deliver', 'ready');
const closed = done('triage', 'close');
const testing = going('deliver', 'rounds.tests__tests');
const between = going('deliver', 'rounds');
type At = { merged?: PlacementInput['merged']; previous?: string };
type Row = [rule: string, runs: PlacementRun[], expected: string, at?: At];
const TRIAGE_VERBS = [
  ['build', 'plan'],
  ['narrow', 'plan'],
  ['park', 'triage'],
  ['close', 'ended: Closed by triage'],
  ['decline', 'ended: Closed by triage'],
  ['deprecate', 'ended: Closed by triage'],
  ['fold', 'ended: Folded into another item'],
  ['recipe', 'ended: Handled another way'],
  ['native', 'ended: Handled another way'],
] as const;
// Rules 1-6 of DESIGN.md's placement, first that matches, over the shipped view.
const RULES: Row[] = [
  [
    '1 the stage of the running step',
    [done('plan', 'planned'), testing],
    'checks',
    { merged: true },
  ],
  ['1 an unnamed step keeps a column listing it', [between], 'checks', { previous: 'checks' }],
  ['1 an unnamed step, column not listing it', [between], 'build', { previous: 'triage' }],
  [
    '1 a running run beats a pending merge',
    [ready, testing],
    'checks',
    { merged: 'pending', previous: 'landed' },
  ],
  ['2 merged', [ready], 'landed', { merged: true }],
  ['2 unknown is not merged', [ready], 'ready', { merged: 'unknown' }],
  ['2 pending keeps a landed card', [ready], 'landed', { merged: 'pending', previous: 'landed' }],
  ['2 unknown keeps a landed card', [ready], 'landed', { merged: 'unknown', previous: 'landed' }],
  ['2 pending never moves a card on', [ready], 'ready', { merged: 'pending', previous: 'ready' }],
  ['2 known unmerged leaves landed', [ready], 'ready', { merged: false, previous: 'landed' }],
  ['3 the last completed run', [done('triage', 'build'), done('plan', 'planned')], 'build'],
  ['3 deliver:ask stays in build', [done('plan', 'planned'), done('deliver', 'ask')], 'build'],
  ['3 a running drain stays ready', [ready, going('discoveries'), done('landgate')], 'ready'],
  ['3 an order running', [going('order', 'order')], 'order'],
  ['3 an order ready', [done('order', 'ready')], 'triage'],
  ['4 an order refused', [done('order', 'refused')], 'ended: Refused at intake'],
  ['4 an exact ending key', [done('plan', 'stop')], 'ended: Stopped at planning'],
  ...TRIAGE_VERBS.map(([verb, place]): Row => [`4 triage ${verb}`, [done('triage', verb)], place]),
  ['4 then paused', [closed, run('triage', 'paused')], 'order'],
  ['4 then running', [closed, going('triage')], 'triage'],
  ['4 then failed', [closed, failed('triage')], 'triage'],
  ['4 exact ending, newer pending run', [done('plan', 'stop'), run('plan', 'pending')], 'order'],
  ['3 before 5: deliver waiting', [done('deliver', 'waiting'), failed('deliver')], 'host'],
  ['3 before 5: plan planned', [done('plan', 'planned'), failed('triage')], 'build'],
  ['5 the stage naming the failed step', [failed('deliver', 'rounds.review__review')], 'checks'],
  ['5 an unnamed failed step', [failed('deliver', 'rounds')], 'build'],
  ['5 cancelled', [run('triage', 'cancelled')], 'triage'],
  ['6 no runs', [], 'order'],
  ['6 undeclared runs do not count', [going(null, 'build__build')], 'order'],
];

describe('where an item sits', () => {
  test.each(RULES)('%s', (_rule, runs, expected, at = {}) => {
    expect(where(itemColumn(view, { runs, merged: at.merged ?? null }, at.previous))).toBe(
      expected
    );
  });

  test('a wildcard ending folds every outcome of its workflow', () => {
    const wildcard = { ...view, endings: { 'triage:*': 'Closed by triage' } };
    const runs = [done('triage', 'duplicate')];
    expect(where(itemColumn(wildcard, { runs, merged: null }))).toBe('ended: Closed by triage');
  });
});

const detailInput = (key: '1' | '2' | '3' | '6'): PlacementInput => {
  const detail = itemDetail(key);
  return placementInput(detail.item, new Map(detail.runs.map(f => [f.runId, f])));
};

describe('placing real items', () => {
  test('the items read places a captured item as its item page does', () => {
    for (const key of ['1', '2', '3', '6'] as const)
      expect(pageItemColumn(view, itemDetail(key).item)).toEqual(
        itemColumn(view, detailInput(key))
      );
  });

  test('every item of the items read sits in its column', () => {
    expect(PAGE.items.map(item => [item.item.key, where(pageItemColumn(VIEW, item))])).toEqual([
      ['8', 'checks'],
      ['5', 'build'],
      ['4', 'build'],
      ['6', 'build'],
      ['3', 'build'],
      ['7', 'landed'],
      ['2', 'landed'],
      ['1', 'landed'],
    ]);
    // 1 before 2: a land run still running after it merged keeps it in Ready to merge.
    expect(where(pageItemColumn(VIEW, landRunning()))).toBe('ready');
    expect(where(pageItemColumn(VIEW, { ...realItem('6'), progress: null }))).toBe('order');
  });

  test('every outcome comes from the declaration: renamed there, placement follows', () => {
    const { 'deliver:ready': _ready, ...placement } = VIEW.placement;
    const renamed = {
      ...VIEW,
      placement: { ...placement, 'deliver:shipit': 'ready' },
    };
    const at = (item: FactoryItem): string | null => where(pageItemColumn(renamed, item));
    const unmerged = (outcome: string): FactoryItem => {
      const item = endLastRun(realItem('1'), 'completed', outcome);
      const progress = progressOf(item);
      if (progress.change === null) throw new Error('item 1 has a change');
      item.progress = { ...progress, change: { ...progress.change, merged: false } };
      return item;
    };
    expect(at(unmerged('shipit'))).toBe('ready');
    // The old name places nothing now: the first stage.
    expect(at(unmerged('ready'))).toBe('order');
  });
});
