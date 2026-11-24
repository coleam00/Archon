import { describe, expect, test } from 'bun:test';
import { itemDetail, shippedView } from '../item-detail.test-fixtures';
import type { FactoryItem } from '../../skills/factory';
import {
  delivering,
  endLastRun,
  keepRuns,
  landRunning,
  PAGE,
  progressOf,
  realItem,
  VIEW,
} from './board.test-fixtures';
import {
  itemColumn,
  pageRunFacts,
  placementInput,
  stageOfStep,
  stageOfWorkflow,
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
const input = (runs: PlacementRun[], extra: Partial<PlacementInput> = {}): PlacementInput => ({
  runs,
  merged: null,
  ...extra,
});
const where = (column: ItemColumn | null): string | null =>
  column === null ? null : 'stage' in column ? column.stage.id : `ended: ${column.ended}`;

describe('which stage a step is in', () => {
  test('a declared node, or a step inside it', () => {
    expect(stageOfStep(view, 'deliver', 'build__build')?.id).toBe('build');
    expect(stageOfStep(view, 'deliver', 'rounds.review__review')?.id).toBe('checks');
    expect(stageOfStep(view, 'deliver', 'rounds.fix')?.id).toBe('build');
    expect(stageOfStep(view, 'deliver', 'hostrounds.host__host')?.id).toBe('host');
  });

  test('a step no stage names, or one of another workflow, is in none', () => {
    expect(stageOfStep(view, 'deliver', 'rounds')).toBeUndefined();
    expect(stageOfStep(view, 'deliver', 'rounds.fixer')).toBeUndefined();
    expect(stageOfStep(view, 'plan', 'build__build')).toBeUndefined();
  });

  test("a run between steps, or in an unnamed one, is in its workflow's first stage", () => {
    expect(stageOfWorkflow(view, 'deliver', null)?.id).toBe('build');
    expect(stageOfWorkflow(view, 'deliver', 'rounds')?.id).toBe('build');
    expect(stageOfWorkflow(view, 'triage', 'anything')?.id).toBe('triage');
    expect(stageOfWorkflow(view, 'unknown', null)).toBeUndefined();
  });
});

describe('where an item sits', () => {
  test('1. a running run: the stage of its running step', () => {
    const runs = [
      run('plan', 'completed', 'planned'),
      run('deliver', 'running', null, 'rounds.tests__tests'),
    ];
    expect(where(itemColumn(view, input(runs, { merged: true })))).toBe('checks');
  });

  test('2. its change merged: the landed column', () => {
    expect(
      where(itemColumn(view, input([run('deliver', 'completed', 'ready')], { merged: true })))
    ).toBe('landed');
    // A merge state the host could not report is not a merge.
    expect(
      where(itemColumn(view, input([run('deliver', 'completed', 'ready')], { merged: 'unknown' })))
    ).toBe('ready');
  });

  test('2. a card in the landed column stays there while its merge state is not known', () => {
    const ended = [run('deliver', 'completed', 'ready')];
    for (const merged of ['pending', 'unknown'] as const) {
      expect(where(itemColumn(view, input(ended, { merged }), 'landed'))).toBe('landed');
      // One that was not in the landed column is placed by its runs, never moved forward.
      expect(where(itemColumn(view, input(ended, { merged }), 'ready'))).toBe('ready');
    }
    // A known answer places it: not merged is not landed.
    expect(where(itemColumn(view, input(ended, { merged: false }), 'landed'))).toBe('ready');
    // A run working it places it, as rule 1 says.
    const running = [...ended, run('deliver', 'running', null, 'rounds.tests__tests')];
    expect(where(itemColumn(view, input(running, { merged: 'pending' }), 'landed'))).toBe('checks');
  });

  test("3. the last completed run's workflow and outcome, through placement", () => {
    const runs = [run('triage', 'completed', 'build'), run('plan', 'completed', 'planned')];
    expect(where(itemColumn(view, input(runs)))).toBe('build');
    expect(where(itemColumn(view, input([...runs, run('deliver', 'completed', 'ask')])))).toBe(
      'build'
    );
  });

  test('a running discoveries drain, which no stage lists, never takes the item off its column', () => {
    // The shipped order: deliver ready starts the drain and the land gate; the gate ends first.
    const runs = [
      run('deliver', 'completed', 'ready'),
      run('discoveries', 'running'),
      run('landgate', 'completed'),
    ];
    expect(where(itemColumn(view, input(runs)))).toBe('ready');
  });

  test('4. an ending: off the board with its label, wildcard or exact', () => {
    const wildcard = { ...view, endings: { 'triage:*': 'Closed by triage' } };
    expect(where(itemColumn(wildcard, input([run('triage', 'completed', 'duplicate')])))).toBe(
      'ended: Closed by triage'
    );
    expect(where(itemColumn(view, input([run('plan', 'completed', 'stop')])))).toBe(
      'ended: Stopped at planning'
    );
  });

  test("each of triage's verbs: build and narrow go on, park stays open, the rest end", () => {
    const placed: Record<string, string> = {
      build: 'plan',
      narrow: 'plan',
      park: 'triage',
      close: 'ended: Closed by triage',
      decline: 'ended: Closed by triage',
      deprecate: 'ended: Closed by triage',
      fold: 'ended: Folded into another item',
      recipe: 'ended: Handled another way',
      native: 'ended: Handled another way',
    };
    for (const [verb, place] of Object.entries(placed))
      expect([verb, where(itemColumn(view, input([run('triage', 'completed', verb)])))]).toEqual([
        verb,
        place,
      ]);
  });

  test("3 before 5: a failed run after a placed completion keeps the completion's place", () => {
    const waiting = [run('deliver', 'completed', 'waiting'), run('deliver', 'failed')];
    expect(where(itemColumn(view, input(waiting)))).toBe('host');
    const planned = [run('plan', 'completed', 'planned'), run('triage', 'failed')];
    expect(where(itemColumn(view, input(planned)))).toBe('build');
  });

  test('5. the last run failed or was cancelled: the stage naming the failed step, else the first of its workflow', () => {
    const failedAt = (step: string | null) => [run('deliver', 'failed', null, null, step)];
    expect(where(itemColumn(view, input(failedAt('rounds.review__review'))))).toBe('checks');
    expect(where(itemColumn(view, input(failedAt('hostrounds.host__host'))))).toBe('host');
    // A step no stage names, or none: the workflow's first stage.
    expect(where(itemColumn(view, input(failedAt('rounds'))))).toBe('build');
    expect(where(itemColumn(view, input(failedAt(null))))).toBe('build');
    expect(where(itemColumn(view, input([run('triage', 'cancelled')])))).toBe('triage');
  });

  test('1. a running step no stage names stays in the previous column when it lists the workflow', () => {
    const between = input([run('deliver', 'running', null, 'rounds')]);
    expect(where(itemColumn(view, between, 'checks'))).toBe('checks');
    // Triage does not list deliver: the workflow's first stage.
    expect(where(itemColumn(view, between, 'triage'))).toBe('build');
    expect(where(itemColumn(view, between))).toBe('build');
    // A named step goes where it is named, whatever the previous column.
    const named = input([run('deliver', 'running', null, 'rounds.review__review')]);
    expect(where(itemColumn(view, named, 'build'))).toBe('checks');
  });

  test('4 and 5 read the last declared run whatever its status: every status after an ending', () => {
    const ended = run('triage', 'completed', 'close');
    const after = (status: PlacementRun['status'], outcome: string | null = null) =>
      where(itemColumn(view, input([ended, run('triage', status, outcome)])));
    // Taken up again: back on the board, where a running run works it, else the first stage.
    expect(after('paused')).toBe('order');
    expect(after('pending')).toBe('order');
    expect(after('running')).toBe('triage');
    // Stopped: rule 5, the stage of its workflow.
    expect(after('failed')).toBe('triage');
    expect(after('cancelled')).toBe('triage');
    // Ended again: off the board.
    expect(after('completed', 'close')).toBe('ended: Closed by triage');
    // An exact ending key with a newer pending run of the same workflow.
    const stopped = [run('plan', 'completed', 'stop'), run('plan', 'pending')];
    expect(where(itemColumn(view, input(stopped)))).toBe('order');
  });

  test('6. otherwise the first stage; runs of undeclared workflows do not count', () => {
    expect(where(itemColumn(view, input([])))).toBe('order');
    expect(where(itemColumn(view, input([run(null, 'running', null, 'build__build')])))).toBe(
      'order'
    );
  });

  test('the captured items: item 1 merged, item 3 asked from build, item 6 building', () => {
    const fromDetail = (key: '1' | '3' | '6'): PlacementInput => {
      const detail = itemDetail(key);
      return placementInput(detail.item, new Map(detail.runs.map(f => [f.runId, f])));
    };
    expect(where(itemColumn(view, fromDetail('1')))).toBe('landed');
    expect(where(itemColumn(view, fromDetail('6')))).toBe('build');
    // Item 3's merge state was unknown when it was captured: the placement of `deliver:ask`.
    expect(where(itemColumn(view, fromDetail('3')))).toBe('build');
  });
});

describe('the pack after its work-order upgrade', () => {
  const after = (...runs: PlacementRun[]): string | null => where(itemColumn(view, input(runs)));
  const ready = run('deliver', 'completed', 'ready');

  test('an order running is in Order; one that ended ready moves to Triage', () => {
    expect(after(run('order', 'running', null, 'order'))).toBe('order');
    expect(after(run('order', 'completed', 'ready'))).toBe('triage');
  });

  test('an order refused ends the item at intake', () => {
    expect(after(run('order', 'completed', 'refused'))).toBe('ended: Refused at intake');
  });

  test('a landgate run that completed with no outcome keeps a ready change in Ready to merge', () => {
    expect(after(ready, run('landgate', 'running', null, 'gate'))).toBe('ready');
    expect(after(ready, run('landgate', 'completed'))).toBe('ready');
    // Whatever outcome a later version of the gate returns, `landgate:*` places it.
    expect(after(ready, run('landgate', 'completed', 'held'))).toBe('ready');
  });

  test('a discoveries run after the gate is no stage: the item stays in Ready to merge', () => {
    // The view names no `discoveries` workflow, so its runs are not the view's.
    for (const status of ['running', 'completed', 'failed'] as const)
      expect(after(ready, run('landgate', 'completed'), run(null, status))).toBe('ready');
  });
});

describe('one placement input for every view of an item', () => {
  test('the items read places a captured item as its item page does', () => {
    for (const key of ['1', '2', '3', '6'] as const) {
      const { item, runs } = itemDetail(key);
      if (item.progress === null) throw new Error(`fixture ${key} has progress`);
      const page = placementInput(item, pageRunFacts(item.progress));
      const detail = placementInput(item, new Map(runs.map(f => [f.runId, f])));
      // The detail knows every running run's step; the page only the latest's, which is the
      // one placement reads.
      expect(itemColumn(view, page)).toEqual(itemColumn(view, detail));
      expect(page.runs.map(r => r.workflow)).toEqual(detail.runs.map(r => r.workflow));
    }
  });
});

/** Where the items read places `item`, as the board and the map build its input. */
function placeOf(item: FactoryItem, previous?: string): string | null {
  const facts = item.progress === null ? new Map() : pageRunFacts(item.progress);
  return where(itemColumn(VIEW, placementInput(item, facts), previous));
}

describe('placing items of the items read, first rule that matches', () => {
  test('every real item sits in the column its runs and change put it in', () => {
    expect(PAGE.items.map(item => [item.item.key, placeOf(item)])).toEqual([
      ['8', 'checks'],
      ['5', 'build'],
      ['4', 'build'],
      ['6', 'build'],
      ['3', 'build'],
      ['7', 'landed'],
      ['2', 'landed'],
      ['1', 'landed'],
    ]);
  });

  test('1: the review step of round 2 is in Checks', () => {
    expect(placeOf(delivering('rounds.review__review'))).toBe('checks');
  });

  test('1: a step no stage names keeps the previous column when it lists the workflow', () => {
    // A deliver run between rounds records only the bare loop group.
    expect(placeOf(delivering('rounds'), 'checks')).toBe('checks');
    expect(placeOf(delivering('rounds'), 'triage')).toBe('build');
    expect(placeOf(delivering(null))).toBe('build');
  });

  test('1 before 2: a land run still running after it merged keeps the item in Ready to merge', () => {
    expect(placeOf(landRunning())).toBe('ready');
  });

  test('2: a merged change is in Landed', () => {
    expect(placeOf(realItem('7'))).toBe('landed');
  });

  test('3: ended ready, its change unmerged or its merge state unknown or pending, is in Ready to merge', () => {
    for (const merged of [false, 'unknown', 'pending'] as const) {
      const item = realItem('1');
      const progress = progressOf(item);
      if (progress.change === null) throw new Error('item 1 has a change');
      item.progress = { ...progress, change: { ...progress.change, merged, mergedAt: null } };
      expect(placeOf(item)).toBe('ready');
    }
  });

  test('4: endings fold off the board, by workflow:* or an exact key on the last run', () => {
    expect(placeOf(endLastRun(keepRuns(realItem('6'), 1), 'completed', 'decline'))).toBe(
      'ended: Closed by triage'
    );
    // Plan stopped after triage said build: the last completed run is plan's, not triage's.
    expect(placeOf(endLastRun(realItem('6'), 'completed', 'stop'))).toBe(
      'ended: Stopped at planning'
    );
  });

  test('5: a failed run sits in the stage of the step it failed at, else its workflow first stage', () => {
    const item = endLastRun(keepRuns(realItem('5'), 3), 'failed', null, 'rounds.review__review');
    // Its plan completed `planned`, which rule 3 places; take that away to reach rule 5.
    const progress = progressOf(item);
    const only = {
      ...item,
      runs: item.runs.slice(2),
      progress: { ...progress, runs: progress.runs.slice(2) },
    };
    expect(placeOf(only)).toBe('checks');
    expect(placeOf(endLastRun(only, 'cancelled', null, null))).toBe('build');
  });

  test('3 before 5: a failed deliver after a completed plan sits where the plan placed it', () => {
    expect(placeOf(endLastRun(realItem('5'), 'failed', null, 'build__build'))).toBe('build');
  });

  test('6: no runs, or progress that could not be read: the first stage', () => {
    expect(placeOf(keepRuns(realItem('6'), 0))).toBe('order');
    expect(placeOf({ ...realItem('6'), progress: null })).toBe('order');
  });

  test('every outcome comes from the declaration: renamed there, placement follows', () => {
    const { 'deliver:ready': _ready, ...placement } = VIEW.placement;
    const { 'plan:stop': _stop, ...endings } = VIEW.endings;
    const renamed = {
      ...VIEW,
      placement: { ...placement, 'deliver:shipit': 'ready' },
      endings: { ...endings, 'plan:halt': 'Stopped at planning' },
    };
    const at = (item: FactoryItem): string | null =>
      where(itemColumn(renamed, placementInput(item, pageRunFacts(progressOf(item)))));
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
    expect(at(endLastRun(realItem('6'), 'completed', 'halt'))).toBe('ended: Stopped at planning');
    expect(at(endLastRun(realItem('6'), 'completed', 'stop'))).not.toMatch(/^ended/);
  });
});
