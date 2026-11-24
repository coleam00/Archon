import { describe, expect, test } from 'bun:test';
import type { FactoryItem } from '../../skills/factory';
import { itemDetail } from '../item-detail.test-fixtures';
import { describeAnswer, linkWords } from './item-answers';

type Answer = FactoryItem['answers'][number];
const at = '2026-11-17T04:00:00.000Z';
const where = { runId: 'run-1', node: 'decide', occurrence: null, at, via: 'cli' as const };
const act = { at, via: 'cli' as const, by: { declared: 'cole-owner' }, fromRun: null };

describe('answers in words', () => {
  test('an answered ask from item 3: the question, the option chosen, the note, who', () => {
    const ask = itemDetail('3').item.answers.find(entry => entry.kind === 'ask');
    const line = ask === undefined ? undefined : describeAnswer(ask);
    expect(line?.label).toBe('Ask answered');
    expect(line?.text).toStartWith('Merge with the Postgres path');
    expect(line?.details.at(-1)).toBe('by cole-owner');
    expect(line?.details.length).toBe(3);
  });

  test('a withdrawn ruling, a gate, a free-text answer and a withdrawn ask', () => {
    const entries: Answer[] = [
      { kind: 'ruling', id: 'r1', text: 'Ship on dev.', ...act, withdrawn: act },
      { kind: 'gate', ...where, decision: 'approve', text: 'Looks right.' },
      { kind: 'attention', ...where, answer: { text: 'Use main.' }, by: null, fromRun: null },
      {
        kind: 'ask',
        ...where,
        ref: 'ask:1',
        question: 'Which base?',
        answer: null,
        chosen: null,
        withdrawn: true,
        by: null,
        fromRun: null,
      },
    ];
    expect(
      entries.map(describeAnswer).map(line => [line.label, line.text, line.details, line.withdrawn])
    ).toEqual([
      ['Ruling, withdrawn', 'Ship on dev.', ['by cole-owner'], true],
      ['Gate', 'approve', ['Looks right.'], false],
      ['Answer', 'Use main.', [], false],
      ['Ask withdrawn', 'Which base?', [], true],
    ]);
  });

  test('links from either side', () => {
    expect(linkWords({ kind: 'duplicate_of', direction: 'outgoing' })).toBe('Duplicate of');
    expect(linkWords({ kind: 'depends_on', direction: 'incoming' })).toBe('Needed by');
  });
});
