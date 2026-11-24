import { describe, expect, test } from 'bun:test';
import type { FactoryItem } from '../../skills/factory';
import { shippedView } from '../item-detail.test-fixtures';
import {
  answeredRows,
  answeredToday,
  asksSettledRunId,
  recentlySettled,
  type SettledAsks,
} from './answered';
import { itemWith, run, settledItem } from './map.test-fixtures';

const plan = settledItem(
  'p',
  run('plan', 'completed', 'ask'),
  '2026-11-17T10:00:00.000Z',
  run('plan', 'running', null, 'plan')
);
const deliver = settledItem(
  'd',
  run('deliver', 'completed', 'ask'),
  '2026-11-17T11:00:00.000Z',
  run('deliver', 'completed', 'ready')
);
/** An ask of the set `deliver`'s first run left, closed with `chosen`. */
function askAnswer(
  question: string,
  chosen: { id: string; does: string } | null
): Extract<FactoryItem['answers'][number], { kind: 'ask' }> {
  return {
    kind: 'ask',
    runId: deliver.runs[0]?.id ?? '',
    node: null,
    occurrence: null,
    at: '2026-11-17T11:00:00.000Z',
    via: null,
    ref: `ask:${question}`,
    question,
    answer: null,
    chosen,
    withdrawn: false,
    by: null,
    fromRun: null,
  };
}
const waiting = settledItem('w', run('plan', 'completed', 'ask'), '2026-11-17T09:00:00.000Z');

describe('asks settled lately, and the stage each started again', () => {
  test('newest first; each joined to the run whose cause names the asking run', () => {
    const listed = recentlySettled(shippedView, [waiting, plan, deliver]);
    expect(
      listed.map(({ itemKey, runId, answered, withdrawn, at, restart }) => ({
        itemKey,
        runId,
        answered,
        withdrawn,
        at,
        restart,
      }))
    ).toEqual([
      {
        itemKey: 'd',
        runId: 'run-d-0',
        answered: 2,
        withdrawn: 1,
        at: '2026-11-17T11:00:00.000Z',
        // deliver begins on Build.
        restart: { runId: 'run-d-1', status: 'completed', label: 'Build' },
      },
      {
        itemKey: 'p',
        runId: 'run-p-0',
        answered: 2,
        withdrawn: 1,
        at: '2026-11-17T10:00:00.000Z',
        restart: { runId: 'run-p-1', status: 'running', label: 'Plan' },
      },
      {
        itemKey: 'w',
        runId: 'run-w-0',
        answered: 2,
        withdrawn: 1,
        at: '2026-11-17T09:00:00.000Z',
        restart: null,
      },
    ]);
  });

  test('without a view a restart is named by its workflow in words, and each ask by its answer in words', () => {
    const asks: FactoryItem['answers'] = [
      askAnswer('Send it back?', { id: 'send-back-once-more', does: 'Restarts the stage.' }),
      askAnswer('Which base?', { id: 'other', does: 'None of these.' }),
      { ...askAnswer('Split it?', null), withdrawn: true },
      { ...askAnswer('From another run?', null), runId: 'run-elsewhere' },
    ];
    const settledOnly = deliver.answers.filter(answer => answer.kind !== 'ask');
    const item = { ...deliver, answers: [...settledOnly, ...asks], progress: null };
    const [entry] = recentlySettled(null, [item]);
    expect(entry?.restart).toEqual({
      runId: 'run-d-1',
      status: 'completed',
      label: 'Deliver',
    });
    const at = '2026-11-17T11:00:00.000Z';
    expect(entry?.asks).toEqual([
      {
        question: 'Send it back?',
        answer: 'Send back once more',
        withdrawn: false,
        at,
        by: null,
        starts: null,
      },
      {
        question: 'Which base?',
        answer: 'Something else',
        withdrawn: false,
        at,
        by: null,
        starts: null,
      },
      { question: 'Split it?', answer: 'withdrawn', withdrawn: true, at, by: null, starts: null },
    ]);
    expect(entry?.askedAt).toBe(deliver.runs[0]?.completedAt ?? null);
  });

  test('only the newest few; an item with no settled set adds nothing', () => {
    const quiet = itemWith('q', [run('plan', 'completed', 'planned')]);
    const listed = recentlySettled(shippedView, [quiet, waiting, plan, deliver], 2);
    expect(listed.map(entry => entry.itemKey)).toEqual(['d', 'p']);
  });

  test('a run started by another cause is not a restart', () => {
    expect(asksSettledRunId({ kind: 'run_ended', runId: 'r', sourceInstanceId: 's' })).toBeNull();
    expect(asksSettledRunId(null)).toBeNull();
    expect(asksSettledRunId({ kind: 'asks_settled', runId: 'r' })).toBe('r');
  });
});

describe('Answered lately, one row per answer', () => {
  const set = (itemKey: string, restart: SettledAsks['restart'], times: string[]): SettledAsks => ({
    itemKey,
    runId: `run-${itemKey}`,
    title: null,
    partOf: null,
    answered: times.length,
    withdrawn: 0,
    at: times[times.length - 1] ?? '',
    askedAt: null,
    asks: times.map((at, index) => ({
      question: `${itemKey} question ${index.toString()}`,
      answer: 'Approve',
      withdrawn: false,
      at,
      by: 'cole-owner',
      starts: null,
    })),
    restart,
    restarts: restart === null ? 0 : 1,
  });
  const started = { runId: 'run-a-1', status: 'running' as const, label: 'Plan' };

  test('newest answer first across sets, cut to the limit, each with the restart of its set', () => {
    const rows = answeredRows(
      [
        set('a', started, ['2026-11-17T10:00:00.000Z', '2026-11-17T12:00:00.000Z']),
        set('b', null, ['2026-11-17T11:00:00.000Z']),
      ],
      2
    );
    expect(rows.map(row => [row.question, row.restart?.label ?? null, row.by])).toEqual([
      ['a question 1', 'Plan', 'cole-owner'],
      ['b question 0', null, 'cole-owner'],
    ]);
  });

  test('the answer an item read records names who gave it', () => {
    const item = {
      ...deliver,
      answers: [
        ...deliver.answers.filter(answer => answer.kind !== 'ask'),
        { ...askAnswer('Ship it?', null), by: { declared: 'someone-else' } },
      ],
    };
    expect(recentlySettled(null, [item])[0]?.asks[0]?.by).toBe('someone-else');
  });
});

describe("an option the view words reads the view's sentence", () => {
  /** `deliver`'s set, asked by a run of `workflow`, answered with `ids` (one ask each). */
  const answeredWith = (workflow: string, ids: string[], restarts = 1) => {
    const asking = { ...deliver.runs[0], workflow: `Wirasm/archon-software-factory:${workflow}` };
    const again = deliver.runs[1];
    if (asking.id === undefined || again === undefined) throw new Error('fixture lacks its runs');
    const extra = Array.from({ length: restarts - 1 }, (_, index) => ({
      ...again,
      id: `run-d-again-${index.toString()}`,
    }));
    return {
      ...deliver,
      runs: [asking, again, ...extra] as typeof deliver.runs,
      answers: [
        ...deliver.answers.filter(answer => answer.kind !== 'ask'),
        ...ids.map(id => askAnswer(`Answered ${id}?`, { id, does: `Does ${id}.` })),
      ],
    };
  };

  test('a drop on a stage-check ask says it closes the PR, a send-back what it started again', () => {
    const [entry] = recentlySettled(shippedView, [
      answeredWith('stage-check', ['drop', 'send-back']),
    ]);
    expect(entry?.asks.map(ask => [ask.answer, ask.starts])).toEqual([
      ['Drop', 'Closes the PR without merging'],
      ['Send back', null],
    ]);
    expect(entry?.restarts).toBe(1);
  });

  test('a set that started two runs counts both, and its rows carry the count', () => {
    const settled = recentlySettled(shippedView, [
      answeredWith('stage-check', ['drop', 'send-back'], 2),
    ]);
    expect(settled[0]?.restarts).toBe(2);
    expect(answeredRows(settled).map(row => [row.answer, row.starts, row.restarts])).toEqual([
      ['Drop', 'Closes the PR without merging', 2],
      ['Send back', null, 2],
    ]);
  });
});

describe('answered today', () => {
  // Built in local time, so the day boundary holds in any timezone the tests run in.
  const now = new Date(2026, 10, 22, 15, 0);
  const local = (day: number, hour: number): string => new Date(2026, 10, day, hour).toISOString();
  const answers = (...entries: FactoryItem['answers']): Pick<FactoryItem, 'answers'> => ({
    answers: entries,
  });
  const base = { runId: 'r', node: null, occurrence: null, via: null };

  test('counts waits answered, gates resolved and asks answered on today, nothing else', () => {
    const items = [
      answers(
        { ...askAnswer('Today?', null), at: local(22, 0) },
        { ...askAnswer('Withdrawn today', null), at: local(22, 9), withdrawn: true },
        { ...askAnswer('Yesterday?', null), at: local(21, 23) },
        { ...base, kind: 'gate', at: local(22, 10), decision: 'approve', text: null },
        {
          ...base,
          kind: 'asks_settled',
          at: local(22, 11),
          answered: 1,
          withdrawn: 0,
        }
      ),
      answers({
        ...base,
        kind: 'attention',
        at: local(22, 14),
        answer: null,
        by: null,
        fromRun: null,
      }),
    ];
    expect(answeredToday(items, now)).toBe(3);
    expect(answeredToday([], now)).toBe(0);
  });
});
