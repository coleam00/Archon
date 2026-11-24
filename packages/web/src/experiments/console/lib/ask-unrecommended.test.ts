import { describe, expect, test } from 'bun:test';
import { askItem } from './needs-you.test-fixtures';
import { parseUnrecommended, unrecommendedOf } from './ask-unrecommended';

describe('parseUnrecommended', () => {
  test('a marker paragraph in the middle is taken out; the rest keeps its paragraphs', () => {
    expect(
      parseUnrecommended(
        'Round 3 of 3 allowed on this item.\n\nNo recommendation: the judgment did not run.\n\nIt was returned twice.'
      )
    ).toEqual({
      rest: 'Round 3 of 3 allowed on this item.\n\nIt was returned twice.',
      why: 'the judgment did not run.',
    });
  });

  test('a marker paragraph at the end, as the pack writes it; alone it leaves no rest', () => {
    expect(parseUnrecommended('What was left.\n\nNo recommendation: no basis to choose.')).toEqual({
      rest: 'What was left.',
      why: 'no basis to choose.',
    });
    expect(parseUnrecommended('No recommendation: no basis to choose.')).toEqual({
      rest: '',
      why: 'no basis to choose.',
    });
  });

  test('no marker, the marker inside a paragraph, or no reason after it: none', () => {
    expect(parseUnrecommended('The branch was cut from main.')).toBeNull();
    expect(parseUnrecommended('It said No recommendation: x, quoting the script.')).toBeNull();
    expect(parseUnrecommended('Context.\nNo recommendation: on the same paragraph.')).toBeNull();
    expect(parseUnrecommended('Context.\n\nNo recommendation:   ')).toBeNull();
  });
});

describe('unrecommendedOf', () => {
  const left = { askedIn: { runId: 'run-ask', workflow: 'stage-check' } };
  const without = (overrides: Parameters<typeof askItem>[0]) => {
    const { recommendation: _, ...ask } = askItem({ ...left, ...overrides });
    return ask;
  };

  test('an ask a stage left without a recommendation says why, from the marker', () => {
    expect(unrecommendedOf(without({ context: 'Left.\n\nNo recommendation: no basis.' }))).toEqual({
      line: 'The stage could not choose: no basis.',
      context: 'Left.',
    });
  });

  test('without the marker it reads a fixed line and keeps its context whole', () => {
    expect(unrecommendedOf(without({ context: 'Left.' }))).toEqual({
      line: 'The stage could not choose.',
      context: 'Left.',
    });
  });

  test('an ask with a recommendation, an answer in words, or a run wait: none', () => {
    expect(unrecommendedOf(askItem({ ...left, context: 'No recommendation: x' }))).toBeNull();
    expect(unrecommendedOf(without({ form: 'message' }))).toBeNull();
    const { recommendation: _, ...wait } = askItem();
    expect(unrecommendedOf(wait)).toBeNull();
  });
});
