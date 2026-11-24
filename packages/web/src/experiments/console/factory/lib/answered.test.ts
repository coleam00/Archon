import { describe, expect, test } from 'bun:test';
import type { FactoryItem } from '../../skills/factory';
import { shippedView } from '../item-detail.test-fixtures';
import { answeredRows, answeredToday, recentlySettled, type SettledAsks } from './answered';
import { run, settledItem } from './map.test-fixtures';

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
      listed.map(entry => [entry.itemKey, entry.runId, entry.answered, entry.withdrawn, entry.at])
    ).toEqual([
      ['d', 'run-d-0', 2, 1, '2026-11-17T11:00:00.000Z'],
      ['p', 'run-p-0', 2, 1, '2026-11-17T10:00:00.000Z'],
      ['w', 'run-w-0', 2, 1, '2026-11-17T09:00:00.000Z'],
    ]);
    // deliver begins on Build; nothing started after w's answer.
    expect(listed.map(entry => entry.restart)).toEqual([
      { runId: 'run-d-1', status: 'completed', label: 'Build' },
      { runId: 'run-p-1', status: 'running', label: 'Plan' },
      null,
    ]);
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

  test('a drop on a stage-check ask says it closes the PR; a set that started two runs counts both', () => {
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
