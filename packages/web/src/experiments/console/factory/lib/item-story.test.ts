import { describe, expect, test } from 'bun:test';
import type { FactoryItemDetail } from '../../skills/factory';
import { itemDetail, PROJECT, shippedView } from '../item-detail.test-fixtures';
import { itemPill } from './board';
import { itemStory, type StagePanel, type StoryPanel } from './item-story';
import { buildTimeline } from './timeline';

const NOW = Date.parse('2026-11-22T09:00:00Z');

const story = (detail: FactoryItemDetail): StoryPanel[] =>
  itemStory(shippedView, PROJECT, detail, buildTimeline(shippedView, detail), NOW);

const stagePanels = (detail: FactoryItemDetail): StagePanel[] =>
  story(detail).filter((panel): panel is StagePanel => panel.kind === 'stage');

type ItemRun = FactoryItemDetail['item']['runs'][number];

/** Item 86 with one run of `workflow` in place of its runs, ended so. */
function oneRun(workflow: string, run: Partial<ItemRun>): FactoryItemDetail {
  const base = structuredClone(itemDetail('86'));
  const [template] = base.item.runs;
  const [facts] = base.runs;
  if (template === undefined || facts === undefined || base.item.progress === null)
    throw new Error('item 86 has runs');
  base.item.runs = [
    {
      ...template,
      id: 'r1',
      workflow: `${shippedView.pack}:${workflow}`,
      status: 'completed',
      ...run,
    },
  ];
  base.runs = [{ ...facts, runId: 'r1', workflow, steps: [], shadows: [], said: null }];
  base.item.progress = { ...base.item.progress, parked: null, runs: [] };
  return base;
}

describe('an outcome worded by whether the item has a change', () => {
  const sentence = (workflow: string, outcome: string, change: boolean): string | undefined => {
    const detail = oneRun(workflow, { outcome });
    const progress = detail.item.progress;
    if (progress === null) throw new Error('item 86 has progress');
    if (change)
      progress.change = {
        url: 'https://github.com/o/r/pull/9',
        merged: false,
        mergedAt: null,
        number: 9,
      };
    const [panel] = story(detail);
    return panel?.kind === 'stage' ? panel.sentence.text : undefined;
  };

  test('a drop names the PR only when the item had one', () => {
    expect(sentence('close', 'dropped', false)).toBe('You dropped it before a change was proposed');
    expect(sentence('close', 'dropped', true)).toStartWith(
      'You dropped it; the factory closed the PR without merging'
    );
  });
});

describe('one plain sentence per outcome', () => {
  // An exact outcome, a `workflow:*` one, and a run with no outcome under either.
  const told: [string, string | null, string][] = [
    ['triage', 'park', 'Triage parked it for later'],
    ['landgate', 'whatever', 'The merge gate read the change'],
    ['plan', null, 'Plan finished'],
  ];
  for (const [workflow, outcome, sentence] of told)
    test(`${workflow}:${outcome ?? '(none)'} reads "${sentence}"`, () => {
      const [panel] = story(oneRun(workflow, { outcome }));
      expect(panel?.kind === 'stage' ? panel.sentence.text : null).toStartWith(sentence);
    });

  test('an outcome the view does not tell falls back to a neutral sentence', () => {
    const [panel] = story(oneRun('plan', { outcome: 'pondered' }));
    expect(panel?.kind === 'stage' ? panel.sentence : null).toEqual({
      text: 'Plan finished:',
      mono: 'pondered',
    });
    const { story: _story, ...untold } = shippedView;
    const detail = oneRun('plan', { outcome: 'planned' });
    const [plain] = itemStory(untold, PROJECT, detail, buildTimeline(untold, detail), NOW);
    expect(plain?.kind === 'stage' ? plain.sentence.text : null).toBe(
      'Plan finished: sent to Build'
    );
  });

  test('a run not finished says what it is doing, in its stage name', () => {
    const sentence = (run: Partial<ItemRun>) => {
      const [panel] = story(oneRun('plan', run));
      return panel?.kind === 'stage' ? panel.sentence.text : null;
    };
    expect(sentence({ status: 'running', outcome: null })).toBe('Plan is working on it now');
    expect(sentence({ status: 'failed', outcome: null })).toBe('Plan failed');
    const failedAt = oneRun('plan', { status: 'failed', outcome: null });
    failedAt.item.progress?.runs.push({ runId: 'r1', workflow: 'plan', failedStep: 'plan' });
    const [failed] = story(failedAt);
    expect(failed?.kind === 'stage' ? failed.sentence.text : null).toBe(
      'Plan failed at Writes the plan'
    );
  });
});

describe("the console's clauses", () => {
  test('the PR, once: on the panel of the run that named it first', () => {
    const named = stagePanels(itemDetail('125')).filter(panel => panel.pr !== null);
    expect(named.map(panel => [panel.stage.id, panel.pr?.label])).toEqual([['build', 'PR #128']]);
  });

  test('why the checks sent it back: the round summary, one sentence, the rest behind More', () => {
    const detail = structuredClone(itemDetail('125'));
    // Cut the story after the third round, which sent it back.
    const third = detail.item.runs.findIndex(run => run.id.startsWith('bb11ef33'));
    detail.item.runs = detail.item.runs.slice(0, third + 1);
    const checks = stagePanels(detail).find(panel => panel.stage.id === 'checks');
    expect(checks?.sentence.text).toBe('Checks sent it back twice');
    expect(checks?.reason?.full).toStartWith('Return:');
    expect((checks?.reason?.short.length ?? 0) < (checks?.reason?.full.length ?? 0)).toBe(true);
  });

  test('an answer that replanned: the panel says the delivery asked, and Plan started again', () => {
    const replanned = stagePanels(itemDetail('115')).find(panel => panel.stage.id === 'build');
    expect(replanned?.sentence.text).toBe('Delivery asked you');
    expect(replanned?.youSaid).toBe('Replan');
    expect(replanned?.answered[0]?.started).toBe('Plan started again');
  });
});

describe('a run that works several stages tells its own facts once, on its last panel', () => {
  /** Item 111 cut after its deliver run, which ends so. */
  function delivered(run: Partial<ItemRun>, answered = false): FactoryItemDetail {
    const detail = structuredClone(itemDetail('111'));
    const at = detail.item.runs.findIndex(entry => entry.id.startsWith('aba8f7aa'));
    const deliver = detail.item.runs[at];
    if (deliver === undefined || detail.item.progress === null) throw new Error('111 delivered');
    Object.assign(deliver, run);
    detail.item.runs = detail.item.runs.slice(0, at + 1);
    detail.item.progress = { ...detail.item.progress, change: null, running: null };
    const ask = itemDetail('113').item.answers.find(entry => entry.kind === 'ask');
    detail.item.answers =
      answered && ask !== undefined ? [{ ...ask, runId: deliver.id } as typeof ask] : [];
    return detail;
  }
  const deliverPanels = (detail: FactoryItemDetail) =>
    stagePanels(detail).filter(panel => ['build', 'checks', 'host'].includes(panel.stage.id));

  test('an answered ask: on the last panel only, with its "you said"', () => {
    const panels = deliverPanels(delivered({ outcome: 'ask' }, true));
    expect(panels.map(panel => [panel.stage.id, panel.answered.length, panel.youSaid])).toEqual([
      ['build', 0, null],
      ['checks', 0, null],
      ['host', 1, 'Send back'],
    ]);
    // Open asks of the run show in that panel alone.
    expect(panels.map(panel => panel.runIds.length)).toEqual([0, 0, 1]);
  });

  test("a stopped run reads on its last panel as its board card's stop line reads", () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const detail = delivered({ status, outcome: null });
      const { stopLine } = itemPill(shippedView, detail.item, false);
      expect(deliverPanels(detail).at(-1)?.sentence.text).toBe(stopLine ?? undefined);
    }
  });
});

describe('a loop-form delivery in its fix step', () => {
  /** Item 111's deliver cut after its first round, now in `rounds.fix` (Build (2)), ended so. */
  function inFix(run: Partial<ItemRun>): FactoryItemDetail {
    const detail = structuredClone(itemDetail('111'));
    const at = detail.item.runs.findIndex(entry => entry.id.startsWith('aba8f7aa'));
    const deliver = detail.item.runs[at];
    const facts = detail.runs.find(entry => entry.runId === deliver?.id);
    if (deliver === undefined || facts === undefined || facts.rounds === null)
      throw new Error('111 delivered');
    if (detail.item.progress === null) throw new Error('111 has progress');
    const cut = facts.steps.findIndex(step => step.node === 'rounds.fix');
    facts.steps = facts.steps.slice(0, cut + 1);
    facts.rounds = { ...facts.rounds, rounds: facts.rounds.rounds.slice(0, 1) };
    facts.shadows = [];
    Object.assign(deliver, { completedAt: null, outcome: null }, run);
    detail.item.runs = detail.item.runs.slice(0, at + 1);
    detail.item.progress = { ...detail.item.progress, change: null, running: null };
    detail.item.answers = [];
    return detail;
  }
  test("running its fix: the first Build says what it did; Checks keeps its round's reason", () => {
    const panels = stagePanels(inFix({ status: 'running' }));
    expect(panels.map(panel => panel.key).slice(-3)).toEqual(['build:1', 'checks:1', 'build:2']);
    expect(panels.find(panel => panel.key === 'build:1')?.sentence.text).toBe(
      'Build wrote the change'
    );
    const checks = panels.find(panel => panel.key === 'checks:1');
    expect(checks?.sentence.text).toBe('Checks sent it back');
    expect(checks?.reason?.full).toStartWith('Return.');
  });
});

describe('after the merge', () => {
  test('a failed run of the Merged stage does not read as a failed merge', () => {
    const detail = structuredClone(itemDetail('125'));
    const landed = detail.item.runs.at(-1);
    if (landed === undefined || detail.item.progress === null) throw new Error('125 landed');
    Object.assign(landed, { status: 'failed', outcome: null });
    detail.item.progress.runs = detail.item.progress.runs.map(entry =>
      entry.runId === landed.id ? { ...entry, failedStep: 'landed' } : entry
    );
    const merged = stagePanels(detail).at(-1);
    expect(merged?.stage.id).toBe('landed');
    expect(merged?.sentence.text).toBe(
      'The change merged; then the factory failed at Checks the branch after the merge'
    );
  });
});

describe('the last panels', () => {
  test('a change the factory merged: its land run says so; the Merged stage panel has the time', () => {
    const panels = stagePanels(itemDetail('125'));
    expect(panels.find(panel => panel.stage.id === 'ready')?.sentence.text).toBe(
      'The factory merged it'
    );
    expect(panels.at(-1)?.merged).toBe(itemDetail('125').item.progress?.change?.mergedAt ?? null);
    // The Merged stage's own run tells it: no second, console-made Merged panel.
    expect(story(itemDetail('125')).some(panel => panel.kind === 'merged')).toBe(false);
    expect(story(itemDetail('125')).at(-1)?.kind).toBe('stage');
  });
});
