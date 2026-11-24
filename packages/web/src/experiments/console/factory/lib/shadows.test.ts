import { describe, expect, test } from 'bun:test';
import type { FactoryItem } from '../../skills/factory';
import { PAGE, VIEW, realItem } from './board.test-fixtures';
import {
  boardShadowLine,
  cardShadows,
  recentTally,
  shadowOf,
  shadowWords,
  stageShadowLines,
  stageShadows,
  type FactoryShadow,
  type ShadowDecision,
} from './shadows';

type Read = ShadowDecision['read'];

/** A decision as the server reads one, of a shadow the shipped view declares. */
function decision(
  workflow: string,
  node: string,
  read: Read,
  decidedAt = '2026-11-18T12:00:00.000Z',
  round: number | null = null
): ShadowDecision {
  return { workflow, node, round, runId: `run-${workflow}`, decidedAt, read };
}

const verdict = (value: string, why: string | null = null): Read => ({
  reads: 'verdict',
  value,
  why,
});

function shadow(workflow: string, node: string): FactoryShadow {
  const found = shadowOf(VIEW, workflow, node);
  if (found === undefined) throw new Error(`the shipped view declares no ${workflow}/${node}`);
  return found;
}

const passing = (name: string, seconds: number) => ({ name, passed: true, seconds, tail: null });

describe('shadowWords', () => {
  const failing = (name: string, seconds: number, tail: string | null = null) => ({
    name,
    passed: false,
    seconds,
    tail,
  });
  const lists = (counts: number[]): Read => ({ reads: 'lists', counts, why: 'Six reports.' });
  const cases: [string, [string, string], Read, Partial<ReturnType<typeof shadowWords>>][] = [
    [
      "a verdict reads through the declaration's words, its why the detail",
      ['triage', 'admit'],
      verdict('ask', 'Nothing shows the operator looked at it.'),
      {
        line: 'would ask you first',
        mono: false,
        detail: 'Nothing shows the operator looked at it.',
        tally: 'would ask you first',
      },
    ],
    [
      'a verdict the words do not name stays the pack token, in mono',
      ['triage', 'admit'],
      verdict('maybe'),
      { line: 'maybe', mono: true },
    ],
    [
      'checks: how many, all passed, how long together',
      ['deliver', 'rounds.checks'],
      {
        reads: 'checks',
        results: [passing('type-check', 135), passing('lint', 56), passing('format', 1)],
      },
      { line: '3 checks · all passed · 3 min', detail: null, tally: 'all passed' },
    ],
    [
      'checks that failed are named, their output the detail',
      ['deliver', 'rounds.checks'],
      {
        reads: 'checks',
        results: [
          failing('type-check', 167, 'exited with code 1'),
          failing('lint', 1),
          passing('format', 2),
        ],
      },
      {
        line: '3 checks · 2 failed: type-check, lint · 2 min',
        detail: 'type-check\nexited with code 1',
        tally: '2 failed',
      },
    ],
    [
      'lists: each list with something in it, after its words',
      ['discoveries', 'result'],
      lists([1, 3, 0, 2]),
      {
        line: 'would file 1 · would fold into open items 3 · would drop 2',
        detail: 'Six reports.',
      },
    ],
    [
      'empty lists read as nothing',
      ['discoveries', 'result'],
      lists([0, 0, 0, 0]),
      {
        line: 'would do nothing',
      },
    ],
    [
      'an unreadable value says so',
      ['triage', 'admit'],
      { reads: 'unreadable' },
      { line: 'recorded nothing readable' },
    ],
  ];
  test.each(cases)('%s', (_name, [workflow, node], read, expected) => {
    expect(shadowWords(shadow(workflow, node), decision(workflow, node, read))).toMatchObject(
      expected
    );
  });
});

describe('where the shipped view holds shadows', () => {
  test('the drill-down card covering a shadow step names it; triage alone holds one', () => {
    const covering = VIEW.stages
      .flatMap(stage => (stage.drilldown?.phases ?? []).flatMap(phase => phase.cards))
      .flatMap(card => cardShadows(card, VIEW).map(found => [card.title, found.node]));
    expect(covering).toEqual([['Would it start on its own', 'admit']]);
    // The merge gate acts, so it is no shadow.
    expect(
      VIEW.stages.filter(stage => stageShadows(stage, VIEW).length > 0).map(stage => stage.id)
    ).toEqual(['triage']);
  });

  test("the map's lines for a stage: each shadow step's label and what it decided lately", () => {
    const stage = (id: string) => {
      const found = VIEW.stages.find(entry => entry.id === id);
      if (found === undefined) throw new Error(`the shipped view has a ${id} stage`);
      return found;
    };
    expect(stageShadowLines(stage('triage'), VIEW, [idleWithEveryDecision()])).toEqual([
      'Would it start on its own · last 1: would ask you first ×1',
    ]);
    expect(stageShadowLines(stage('triage'), VIEW, [])).toEqual([
      'Would it start on its own · nothing decided yet',
    ]);
    expect(stageShadowLines(stage('plan'), VIEW, [idleWithEveryDecision()])).toEqual([]);
  });
});

/**
 * An idle real item carrying every shipped shadow's decision, and one of the merge gate, which
 * recorded decisions while it was a shadow and is not one now.
 */
function idleWithEveryDecision(): FactoryItem {
  const item = structuredClone(
    PAGE.items.find(entry => entry.progress !== null && entry.progress.running === null)
  );
  if (item?.progress == null) throw new Error('the fixture page has no idle item');
  item.progress.shadows = [
    decision('triage', 'admit', verdict('ask'), '2026-11-18T10:00:00.000Z'),
    decision('triage', 'split', verdict('whole'), '2026-11-18T10:00:00.000Z'),
    decision(
      'deliver',
      'rounds.checks',
      { reads: 'checks', results: [passing('lint', 5)] },
      '2026-11-18T11:00:00.000Z',
      2
    ),
    decision('landgate', 'gate', verdict('ask'), '2026-11-18T12:00:00.000Z'),
    decision(
      'discoveries',
      'result',
      { reads: 'lists', counts: [1, 0, 0, 0], why: null },
      '2026-11-18T12:05:00.000Z'
    ),
  ];
  return item;
}

describe('boardShadowLine', () => {
  test("each stage shows its own workflows' newest verdict decision; others none", () => {
    const item = idleWithEveryDecision();
    const lines = VIEW.stages.map(stage => [
      stage.id,
      boardShadowLine(item, stage, VIEW)?.line ?? null,
    ]);
    expect(lines).toEqual([
      ['order', null],
      ['triage', 'would ask you first'],
      ['plan', null],
      ['build', null],
      ['checks', null],
      ['host', null],
      ['ready', null],
      ['landed', null],
    ]);
  });

  test('the newest of the stage’s verdict decisions wins', () => {
    const item = idleWithEveryDecision();
    item.progress?.shadows.push(
      decision('triage', 'admit', verdict('auto'), '2026-11-18T09:00:00.000Z')
    );
    const triage = VIEW.stages.find(stage => stage.id === 'triage') ?? null;
    expect(boardShadowLine(item, triage, VIEW)?.line).toBe('would ask you first');
    item.progress?.shadows.push(
      decision('triage', 'admit', verdict('auto'), '2026-11-18T11:00:00.000Z')
    );
    expect(boardShadowLine(item, triage, VIEW)?.line).toBe('would start on its own');
  });
});

describe('recentTally', () => {
  const withDecision = (key: string, read: Read, at: string): FactoryItem => {
    const item = realItem(key);
    if (item.progress === null) throw new Error(`fixture item ${key} has no progress`);
    item.progress.shadows = [decision('triage', 'admit', read, at)];
    return item;
  };
  const keys = PAGE.items.filter(item => item.progress !== null).map(item => item.item.key);

  test("counts the newest n items' decisions by what they say", () => {
    const items = keys
      .slice(0, 6)
      .map((key, index) =>
        withDecision(
          key,
          verdict(index === 0 ? 'auto' : 'ask'),
          `2026-11-18T1${index.toString()}:00:00.000Z`
        )
      );
    // The oldest (the one `auto`) falls outside the newest five.
    expect(recentTally(items, [shadow('triage', 'admit')])).toBe('last 5: would ask you first ×5');
    expect(recentTally(items, [shadow('triage', 'admit')], 6)).toBe(
      'last 6: would ask you first ×5 · would start on its own ×1'
    );
  });
});
