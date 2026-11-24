import { describe, expect, test } from 'bun:test';
import { formatDateTime } from '../../lib/format';
import { askItem } from '../../lib/needs-you.test-fixtures';
import { needsYouCount } from '../../lib/needs-you';
import {
  boardModel,
  cardFields,
  columnChips,
  filterBoard,
  hiddenColumnsHint,
  movedKeys,
  newRoundRunning,
} from './board';
import type { FactoryItem } from '../../skills/factory';
import {
  readyWithMerge,
  delivering,
  endLastRun,
  keepRuns,
  landRunning,
  PAGE,
  declaredAwaits,
  lastRunAs,
  needsShaping,
  parkedByTriage,
  progressOf,
  realItem,
  VIEW,
  FIXTURE_NOW,
  queuedStart,
} from './board.test-fixtures';
import { sortRows, tableRows } from './board-table';
import { pageItemColumn, stageOfWorkflow } from './placement';
import { coveringCard } from './step-facts';

const PROJECT = 'cb-1';
const card = (item: FactoryItem, previous?: string) =>
  cardFields(VIEW, PROJECT, item, pageItemColumn(VIEW, item, previous));

describe('cards of placed items', () => {
  test('a running item says its round; a land run still running keeps it out of Merged', () => {
    expect(card(delivering('rounds.review__review')).round?.text).toBe('round 2 of 3');
    const item = landRunning();
    expect(card(item)).toMatchObject({ pill: 'running', mergedAt: null });
  });

  test('a failed deliver after a completed plan is marked failed, with the step it failed at', () => {
    expect(card(endLastRun(realItem('5'), 'failed', null, 'build__build'))).toMatchObject({
      pill: 'failed',
      stopLine: 'Build failed at Writes the change',
    });
  });

  test('a failed run names its stage, never its workflow id, even one no stage declares', () => {
    const failed = endLastRun(realItem('5'), 'failed', null, 'build__build');
    const progress = failed.progress!;
    const full = {
      ...failed,
      progress: {
        ...progress,
        runs: progress.runs.map((run, index) =>
          index === progress.runs.length - 1
            ? { ...run, workflow: 'Wirasm/archon-software-factory:deliver' }
            : run
        ),
      },
    };
    // The stage it is placed in names it; no step label is declared for an unknown workflow.
    expect(card(full).stopLine).toBe('Build failed at build');
  });

  test('an item whose progress could not be read stays on the board and says so', () => {
    const item = { ...realItem('6'), progress: null };
    expect(pageItemColumn(VIEW, item)).toMatchObject({ stage: { id: 'order' } });
    expect(card(item)).toMatchObject({ title: '#6', stopLine: 'Its progress could not be read.' });
  });

  test('the board keeps a running item in its previous column on a step no stage names', () => {
    const item = delivering('rounds');
    const position = (previous: Map<string, string>) =>
      boardModel(VIEW, PROJECT, [item], previous, FIXTURE_NOW).positions.get('8');
    expect(position(new Map([['8', 'checks']]))).toBe('checks');
    expect(position(new Map())).toBe('build');
  });
});

describe('card fields, in order', () => {
  test('1: key and title, the title falling back to the key', () => {
    expect(card(realItem('7'))).toMatchObject({
      key: '7',
      title:
        'Needs you: open asks and paused runs listed with the recommendation first, answered in place',
    });
    const untitled = realItem('7');
    untitled.progress = { ...progressOf(untitled), title: null };
    expect(card(untitled).title).toBe('#7');
  });

  test('2: the state pill', () => {
    expect(card(realItem('8')).pill).toBe('running');
    expect(card(realItem('6')).pill).toBe('waiting');
    expect(card(realItem('7')).pill).toBe('landed');
    expect(card({ ...realItem('6'), questions: [askItem()] }).pill).toBe('needs-you');
    expect(card(endLastRun(realItem('5'), 'failed', null)).pill).toBe('failed');
  });

  test('2: an item in Merged through a placement, its merge state not known, is landed', () => {
    const item = endLastRun(realItem('6'), 'completed', 'landed');
    item.runs[item.runs.length - 1] = { ...item.runs.at(-1)!, workflow: 'land' };
    const progress = progressOf(item);
    item.progress = {
      ...progress,
      runs: progress.runs.map((run, index, all) =>
        index === all.length - 1 ? { ...run, workflow: 'land' } : run
      ),
    };
    expect(card(item)).toMatchObject({ pill: 'landed', mergedAt: null });
  });

  test('3: the round, with a dot per round in plain words', () => {
    expect(card(realItem('3')).round).toEqual({
      text: 'round 2 of 3',
      dots: [
        { iteration: 1, verdict: 'returned', label: 'round 1: returned' },
        { iteration: 2, verdict: 'undecided', label: 'round 2: needs a decision' },
      ],
    });
    expect(card(realItem('2')).round?.dots.map(dot => dot.label)).toEqual([
      'round 1: returned',
      'round 2: returned',
      'round 3: approved',
    ]);
    const unbounded = realItem('3');
    const progress = progressOf(unbounded);
    unbounded.progress = { ...progress, round: { ...progress.round!, max: null } };
    expect(card(unbounded).round?.text).toBe('round 2');
    expect(card(realItem('6')).round).toBeNull();
  });

  test('3: a three-stage item reads its stage-check rounds, its bound the newest allowance', () => {
    const item = realItem('3');
    const progress = progressOf(item);
    item.progress = {
      ...progress,
      running: null,
      round: {
        runId: 'check-3',
        iteration: 3,
        max: 4,
        rounds: [
          { iteration: 1, verdict: 'returned', outcome: 'return' },
          { iteration: 2, verdict: 'returned', outcome: 'return' },
          { iteration: 3, verdict: 'approved', outcome: 'approve' },
        ],
      },
    };
    expect(card(item).round?.text).toBe('round 3 of 4');
    expect(card(item).round?.dots.map(dot => dot.verdict)).toEqual([
      'returned',
      'returned',
      'approved',
    ]);
  });

  test('3: a stage-check run going now is a round with no number yet: a running dot', () => {
    const item = realItem('3');
    const progress = progressOf(item);
    const running = {
      runId: 'check-next',
      workflow: 'stage-check',
      step: 'review__review',
      startedAt: '2026-11-21T12:00:00.000Z',
    };
    item.progress = { ...progress, running };
    expect(newRoundRunning(VIEW, item.progress)).toBe(true);
    expect(card(item).round).toEqual({
      text: 'round 2 of 3, next one running',
      dots: [
        { iteration: 1, verdict: 'returned', label: 'round 1: returned' },
        { iteration: 2, verdict: 'undecided', label: 'round 2: needs a decision' },
        { iteration: 3, verdict: 'running', label: 'next round: running' },
      ],
    });
    // No stage-check round recorded yet: the first is running.
    item.progress = { ...progress, running, round: null };
    expect(card(item).round).toEqual({
      text: 'first round running',
      dots: [{ iteration: 1, verdict: 'running', label: 'first round: running' }],
    });
    // A deliver run going now, not yet in its loop, adds none: deliver's loop is a loop-form
    // source, which numbers its own rounds, so its card reads as it always has.
    item.progress = { ...progress, running: { ...running, workflow: 'deliver' } };
    expect(newRoundRunning(VIEW, item.progress)).toBe(false);
    expect(card(item).round?.text).toBe('round 2 of 3');
  });

  test('4: the running stage, step name and round, linking to the run', () => {
    const item = realItem('8');
    expect(card(item).run).toEqual({
      parts: ['Checks', 'Product check', 'round 1'],
      text: 'Checks · Product check · round 1',
      step: 'rounds.product__product',
      href: `/console/p/${PROJECT}/r/${progressOf(item).running!.runId}`,
    });
    expect(card(delivering('build__build')).run?.text).toBe('Build · Writes the change');
    expect(card(delivering(null)).run?.text).toBe('Build · between steps');
    expect(card(realItem('6')).run).toBeNull();
  });

  test('4: on a step no stage names, the run line names the column the card holds', () => {
    const item = delivering('rounds.shown');
    const model = boardModel(
      VIEW,
      PROJECT,
      [item],
      new Map([[item.item.key, 'checks']]),
      FIXTURE_NOW
    );
    const checks = model.columns.find(column => column.id === 'checks-review');
    expect(checks?.cards.map(placed => placed.card.run?.text)).toEqual([
      'Checks · Posts the review · round 2',
    ]);
  });

  test("4: a round from another run is not this run's round", () => {
    const item = delivering('rounds.fix');
    const progress = progressOf(item);
    item.progress = { ...progress, round: { ...progress.round!, runId: 'an-earlier-run' } };
    expect(card(item).run?.text).toBe('Build · Fixes what came back');
  });

  test('5: returned ×N, linking to the item page', () => {
    expect(card(realItem('3')).returned).toEqual({
      count: 2,
      href: `/console/p/${PROJECT}/factory/items/3`,
    });
    expect(card(realItem('6')).returned).toBeNull();
  });

  test('6: the change, by its pull request number when known', () => {
    expect(card(realItem('7')).change).toEqual({
      href: 'https://github.com/coleam00/archon-factory-console/pull/13',
      label: 'PR #13',
      mergeState: null,
    });
    // The fixture's lookup for item 3 could not reach its pull request: the card says so.
    expect(card(realItem('3')).change).toMatchObject({
      label: 'the change',
      mergeState: 'unknown',
    });
    expect(card(realItem('6')).change).toBeNull();
  });

  test('6: a change the host has not named yet is "the change", with no link', () => {
    const item = readyWithMerge('p', 'pending');
    const progress = progressOf(item);
    if (progress.change === null) throw new Error('readyWithMerge has a change');
    item.progress = { ...progress, change: { ...progress.change, url: null, number: null } };
    expect(card(item).change).toEqual({ href: null, label: 'the change', mergeState: 'pending' });
  });

  test('7: in Merged, when it merged in local time', () => {
    const item = realItem('7');
    expect(card(item).mergedAt).toBe(formatDateTime('2026-11-17T04:30:22Z'));
    expect(card(realItem('3')).mergedAt).toBeNull();
  });

  test('a card names the stage it waits in; a running one its stage and step; a merged one none', () => {
    expect(card(keepRuns(realItem('6'), 2)).stage).toBe('Build');
    const running = card(delivering('rounds.review__review'));
    expect(running.stage).toBe('Checks');
    expect(running.run?.text).toBe('Checks · Code review · round 2');
    expect(card(realItem('7'))).toMatchObject({ pill: 'landed', stage: null });
  });

  test('8: what an item that needs you asks, what stopped a failed one', () => {
    const asking = { ...realItem('6'), questions: [askItem()] };
    expect(card(asking).stopLine).toBe('Which base should the change target?');
    const cancelled = endLastRun(realItem('5'), 'cancelled', null);
    expect(card(cancelled).stopLine).toBe('Build was stopped');
    expect(card(realItem('8')).stopLine).toBeNull();
  });
});

describe('the board', () => {
  test('columns are the declared columns in order, Merged among them; an ending is set aside', () => {
    const ended = endLastRun(keepRuns(realItem('6'), 1), 'completed', 'close');
    const model = boardModel(
      VIEW,
      PROJECT,
      [...PAGE.items.filter(i => i.item.key !== '6'), ended],
      new Map(),
      FIXTURE_NOW
    );
    expect(model.columns.map(column => [column.label, column.cards.length])).toEqual([
      ['Intake', 0],
      ['Plan & build', 3],
      ['Checks & review', 1],
      ['Ready to merge', 0],
      ['Merged', 3],
    ]);
    expect(model.landedColumn).toBe('merged');
    expect(model.setAside.map(entry => [entry.placed.card.key, entry.kind, entry.why])).toEqual([
      ['6', 'ended', 'Closed by triage'],
    ]);
    expect(model.positions.get('6')).toBe('ended:Closed by triage');
  });

  test('the filter narrows the columns by key or title; positions keep every item', () => {
    const board = boardModel(VIEW, PROJECT, PAGE.items, new Map(), FIXTURE_NOW);
    const keys = (query: string): string[] =>
      filterBoard(board, query, undefined, FIXTURE_NOW).columns.flatMap(column =>
        column.cards.map(p => p.card.key)
      );
    expect(keys('NEEDS YOU')).toEqual(['7']);
    expect(keys('3')).toEqual(['3']);
    expect(keys('  ')).toHaveLength(PAGE.items.length);
    expect(filterBoard(board, 'NEEDS YOU', undefined, FIXTURE_NOW).positions.size).toBe(
      PAGE.items.length
    );
  });

  test('the filter finds the members of a work order by its key; the table sorts by it', () => {
    // 5 is part of 48 by its order run's result; 3 by its order run's result too, of 60.
    const items = PAGE.items.map(item =>
      item.item.key === '5' || item.item.key === '3'
        ? {
            ...item,
            progress: { ...progressOf(item), partOf: item.item.key === '5' ? '48' : '60' },
          }
        : item
    );
    const board = boardModel(VIEW, PROJECT, items, new Map(), FIXTURE_NOW);
    const keys = (model: typeof board): string[] =>
      model.columns.flatMap(column => column.cards.map(p => p.card.key));
    expect(keys(filterBoard(board, '48', undefined, FIXTURE_NOW))).toEqual(['5']);
    const sorted = sortRows(tableRows(board), { by: 'order', descending: true });
    expect(sorted.slice(0, 2).map(row => [row.placed.card.key, row.placed.card.order])).toEqual([
      ['3', '60'],
      ['5', '48'],
    ]);
  });

  test('a card that changed position moved; one new to the board did not', () => {
    const before = new Map([
      ['1', 'ready'],
      ['8', 'build'],
    ]);
    const after = new Map([
      ['1', 'landed'],
      ['8', 'build'],
      ['9', 'triage'],
    ]);
    expect(movedKeys(before, after)).toEqual(['1']);
  });

  test('the hint names the columns scrolled out of view', () => {
    const columns = boardModel(VIEW, PROJECT, [], new Map(), FIXTURE_NOW).columns;
    expect(hiddenColumnsHint(columns, new Set(columns.map(c => c.id)))).toBeNull();
    expect(hiddenColumnsHint(columns, new Set(['intake', 'plan-build', 'checks-review']))).toBe(
      'Scroll for: Ready to merge, Merged'
    );
  });
});

describe('a column waiting on a merge answer', () => {
  const pendingColumns = (items: FactoryItem[], show?: Parameters<typeof filterBoard>[2]) =>
    filterBoard(boardModel(VIEW, 'cb-1', items, new Map(), FIXTURE_NOW), '', show, FIXTURE_NOW)
      .columns.filter(column => column.pending)
      .map(column => column.id);

  test('the column holding a pending item and the landed column, no other', () => {
    const items = [...PAGE.items, readyWithMerge('p', 'pending')];
    expect(pendingColumns(items)).toEqual(['ready', 'merged']);
    const card = boardModel(VIEW, 'cb-1', items, new Map(), FIXTURE_NOW)
      .columns.flatMap(column => column.cards)
      .find(placed => placed.card.key === 'p')?.card;
    expect(card?.change?.mergeState).toBe('pending');
  });

  test('a board opened from a landed number keeps the landed column loading', () => {
    const items = [...PAGE.items, readyWithMerge('p', 'pending')];
    expect(pendingColumns(items, 'landed')).toContain('merged');
    expect(pendingColumns(items, 'landed-today')).toContain('merged');
  });

  test('a settled unknown is counted where it sits', () => {
    expect(pendingColumns([...PAGE.items, readyWithMerge('u', 'unknown')])).toEqual([]);
  });
});

describe('grouped columns', () => {
  /** One item on each stage of the shipped declaration, by the stage it should sit in. */
  const onEachStage = (): [string, FactoryItem][] => {
    const triaged = keepRuns(realItem('6'), 1);
    const at = (key: string, item: FactoryItem): FactoryItem => ({
      ...item,
      item: { ...item.item, key },
    });
    return [
      ['order', at('o', keepRuns(realItem('6'), 0))],
      ['triage', at('t', endLastRun(triaged, 'failed', null))],
      ['plan', at('p', endLastRun(triaged, 'completed', 'build'))],
      ['build', at('b', delivering('build__build'))],
      ['checks', at('c', delivering('rounds.review__review'))],
      ['host', at('h', delivering('hostrounds.host__host'))],
      ['ready', at('r', endLastRun(realItem('3'), 'completed', 'ready'))],
      ['landed', at('m', realItem('7'))],
    ];
  };
  const columnOf = (model: ReturnType<typeof boardModel>, key: string): string | undefined =>
    model.columns.find(column => column.cards.some(placed => placed.card.key === key))?.id;

  test('an item on each stage sits in the column holding that stage', () => {
    const cases = onEachStage();
    const model = boardModel(
      VIEW,
      PROJECT,
      cases.map(([, item]) => item),
      new Map(),
      FIXTURE_NOW
    );
    const expected: Record<string, string> = {
      order: 'intake',
      triage: 'intake',
      plan: 'plan-build',
      build: 'plan-build',
      checks: 'checks-review',
      host: 'checks-review',
      ready: 'ready',
      landed: 'merged',
    };
    // Positions stay stage ids: placement holds a run between named steps by its stage.
    expect(cases.map(([stage, item]) => [stage, model.positions.get(item.item.key)])).toEqual(
      cases.map(([stage]) => [stage, stage])
    );
    expect(cases.map(([stage, item]) => [stage, columnOf(model, item.item.key)])).toEqual(
      cases.map(([stage]) => [stage, expected[stage]])
    );
  });

  test('a stage no column holds puts its card under Position unknown, never drops it', () => {
    const view = structuredClone(VIEW);
    view.columns = view.columns?.filter(column => column.id !== 'checks-review');
    const model = boardModel(
      view,
      PROJECT,
      [delivering('rounds.review__review')],
      new Map(),
      FIXTURE_NOW
    );
    expect(model.unplaced.map(placed => placed.card.key)).toEqual(['8']);
    expect(model.setAside).toEqual([]);
  });

  test('a parked item set aside keeps its position; one a start waits for is a card in Intake', () => {
    const parked = parkedByTriage();
    const model = boardModel(VIEW, PROJECT, [parked], new Map(), FIXTURE_NOW);
    // Placement still reads Triage, so a card coming back does not read as moved.
    expect(model.positions.get('6p')).toBe('triage');
    const queued = { ...parked, queued: [queuedStart()] };
    const intake = boardModel(VIEW, PROJECT, [queued], new Map(), FIXTURE_NOW).columns.find(
      column => column.id === 'intake'
    );
    expect(
      intake?.cards.map(placed => [placed.card.key, placed.card.pill, placed.card.stage])
    ).toEqual([['6p', 'parked', 'Triage']]);
    expect(columnChips(intake?.cards ?? [])).toEqual([{ pill: 'parked', count: 1 }]);
  });

  test('an item triage sent to shaping sits in Intake, waiting on you in its words, its questions on its line', () => {
    const questions = ['Which surfaces?', 'Who owns it?', 'Is it one change?', 'By when?'];
    const model = boardModel(
      VIEW,
      PROJECT,
      [needsShaping('9s', questions)],
      new Map(),
      FIXTURE_NOW
    );
    const intake = model.columns.find(column => column.id === 'intake');
    expect(
      intake?.cards.map(placed => [
        placed.card.key,
        placed.card.pill,
        placed.card.pillLabel,
        placed.card.stage,
        placed.card.stopLine,
        placed.card.stopCount,
      ])
    ).toEqual([['9s', 'awaits', 'Needs shaping', 'Triage', 'Which surfaces?', '4 questions']]);
    // It waits on a person: the column counts it in the needs-you chip, and Needs you shows it.
    expect(columnChips(intake?.cards ?? [])).toEqual([{ pill: 'needs-you', count: 1 }]);
    expect(
      filterBoard(model, '', 'needs-you', FIXTURE_NOW).columns.flatMap(c => c.cards)
    ).toHaveLength(1);
    // With no questions recorded, the line is its reason.
    expect(card(needsShaping('9t', []))).toMatchObject({
      stopLine: 'Worth doing; the scope is open.',
      stopCount: null,
    });
    expect(card(needsShaping('9u', ['Which?'])).stopCount).toBeNull();
  });

  test('an item with an open ask too reads Needs you: the ask is what needs you', () => {
    const asking = { ...needsShaping('9s', ['Which?']), questions: [askItem()] };
    expect(card(asking).pill).toBe('needs-you');
  });

  test('close: dropped ends the item, reshape waits in Intake, not closed is parked aside and none waits in Ready to merge', () => {
    const shaped = declaredAwaits('close:reshape', null, []);
    // The server reads a declared `parked` outcome so: its label, and the run's why.
    const notClosed = lastRunAs('c3', 'close', 'not_closed');
    const parked = VIEW.parked?.['close:not_closed'];
    if (parked === undefined || notClosed.progress === null)
      throw new Error('the shipped view parks close:not_closed');
    notClosed.progress = {
      ...notClosed.progress,
      parked: { label: parked.label, why: 'The forge refused.' },
    };
    const model = boardModel(
      VIEW,
      PROJECT,
      [
        lastRunAs('c1', 'close', 'dropped'),
        lastRunAs('c2', 'close', 'reshape', shaped),
        notClosed,
        lastRunAs('c4', 'close', 'none'),
      ],
      new Map(),
      FIXTURE_NOW
    );
    expect(model.setAside.map(entry => [entry.placed.card.key, entry.kind, entry.why])).toEqual([
      ['c1', 'ended', 'Dropped by you'],
      ['c3', 'parked', 'The forge would not close the PR: close or draft it by hand'],
    ]);
    const where = (key: string) =>
      model.columns.flatMap(column =>
        column.cards
          .filter(placed => placed.card.key === key)
          .map(placed => [column.id, placed.card.stage, placed.card.pill, placed.card.pillLabel])
      );
    expect(where('c2')).toEqual([['intake', 'Triage', 'awaits', 'Needs shaping']]);
    // Nothing the console reads sees a PR closed by hand, so not_closed is parked, not waiting
    // on you: it is set aside with its words saying what to do, and Needs you does not count it.
    expect(where('c3')).toEqual([]);
    expect(model.positions.get('c3')).toBe('ready');
    expect(parked.label).toBe('The forge would not close the PR: close or draft it by hand');
    expect(needsYouCount({ items: [] }, [notClosed])).toBe(0);
    expect(where('c4')).toEqual([['ready', 'Ready to merge', 'waiting', 'Waiting']]);
  });

  test('report: a run writing the report is in Checks or in CI and review, on the Report card', () => {
    for (const [workflow, stage, column] of [
      ['stage-check', 'checks', 'checks-review'],
      ['stage-host', 'host', 'checks-review'],
    ] as const) {
      expect(stageOfWorkflow(VIEW, workflow, 'report__report')?.id).toBe(stage);
      expect(coveringCard(VIEW, workflow, 'report__report')?.title).toBe('Report');
      const running = lastRunAs(`r-${workflow}`, workflow, 'approve');
      const progress = progressOf(running);
      const [run] = progress.runs;
      if (run === undefined) throw new Error('the fixture has a run');
      running.progress = {
        ...progress,
        running: {
          runId: run.runId,
          workflow,
          step: 'report__report',
          startedAt: '2026-11-23T00:00:00Z',
        },
      };
      running.runs = running.runs.map(entry => ({ ...entry, status: 'running', outcome: null }));
      const model = boardModel(VIEW, PROJECT, [running], new Map(), FIXTURE_NOW);
      expect(model.positions.get(`r-${workflow}`)).toBe(stage);
      expect(
        model.columns.find(entry => entry.id === column)?.cards.map(placed => placed.card.run?.step)
      ).toEqual(['report__report']);
    }
  });

  test("a column's chips count its cards by state, only states above 0", () => {
    const asking = { ...realItem('6'), questions: [askItem()] };
    const model = boardModel(
      VIEW,
      PROJECT,
      [delivering('build__build'), realItem('5'), asking, keepRuns(realItem('3'), 2)],
      new Map(),
      FIXTURE_NOW
    );
    const work = model.columns.find(column => column.id === 'plan-build');
    expect(columnChips(work?.cards ?? [])).toEqual([
      { pill: 'running', count: 2 },
      { pill: 'needs-you', count: 1 },
      { pill: 'waiting', count: 1 },
    ]);
  });

  test('the table names the stage beside the column, and sorts by stage within a column', () => {
    const model = boardModel(
      VIEW,
      PROJECT,
      // Out of stage order, so the sort has to put them right.
      onEachStage()
        .reverse()
        .map(([, item]) => item),
      new Map(),
      FIXTURE_NOW
    );
    const rows = sortRows(tableRows(model), { by: 'stage', descending: false });
    expect(rows.map(row => [row.column, row.stage])).toEqual([
      ['Intake', 'Order'],
      ['Intake', 'Triage'],
      ['Plan & build', 'Plan'],
      ['Plan & build', 'Build'],
      ['Checks & review', 'Checks'],
      ['Checks & review', 'CI and review'],
      ['Ready to merge', 'Ready to merge'],
      // A merged row's Stage is empty, as its board card's is: Column and State already say
      // so. It still sorts after every live stage.
      ['Merged', null],
    ]);
  });
});
