import { describe, expect, test } from 'bun:test';
import { offeredPlaceholder, parseOffered } from './ask-offered';
import { DRY_RUN_CONTEXT, DRY_RUN_WHY, MARKER } from './ask-offered.test-fixtures';

describe('parseOffered', () => {
  test('the dry-run context: the rest, both options with does and cost, and the recommended one', () => {
    expect(parseOffered(DRY_RUN_CONTEXT, DRY_RUN_WHY)).toEqual({
      rest: 'Review says the item asks for it; product says it was never mentioned. (Left by: verdict.)',
      options: [
        { id: 'build-it', does: 'Build the empty state now.', cost: 'One more round.' },
        {
          id: 'leave-it',
          does: 'Leave it for a follow-up item.',
          cost: 'The board shows a blank column until then.',
        },
      ],
      recommended: 'build-it',
    });
  });

  test('an option with no cost has none', () => {
    expect(parseOffered(`${MARKER}\n- leave-it: Leave it.`)?.options).toEqual([
      { id: 'leave-it', does: 'Leave it.' },
    ]);
  });

  test('an option with an empty does, with or without the trailing space', () => {
    expect(parseOffered(`${MARKER}\n- leave-it: \n- build-it:`)?.options).toEqual([
      { id: 'leave-it', does: '' },
      { id: 'build-it', does: '' },
    ]);
  });

  test('a cost holding parentheses, and a does mentioning a cost mid-sentence', () => {
    expect(
      parseOffered(
        `${MARKER}\n- a: Do it. (cost: One round (maybe two).)\n- b: Note (cost: x) is not the end.`
      )?.options
    ).toEqual([
      { id: 'a', does: 'Do it.', cost: 'One round (maybe two).' },
      { id: 'b', does: 'Note (cost: x) is not the end.' },
    ]);
  });

  test('a context without the marker is not parsed', () => {
    expect(parseOffered('Review says the item asks for it.\n- build-it: Build it.')).toBeNull();
  });

  test('a marker line with nothing under it, or only prose, is not parsed', () => {
    expect(parseOffered(`Some context.\n\n${MARKER}`)).toBeNull();
    expect(parseOffered(`Some context.\n\n${MARKER}\nNothing listed.`)).toBeNull();
  });

  test('a reworded marker is not parsed', () => {
    expect(
      parseOffered(DRY_RUN_CONTEXT.replace('in its own words', 'in its words'), DRY_RUN_WHY)
    ).toBeNull();
  });

  test('a context that is only the marker and its list has no rest', () => {
    expect(parseOffered(`${MARKER}\n- build-it: Build it.`)?.rest).toBe('');
  });

  test('anything after the marker that is not an option line falls back to null', () => {
    expect(parseOffered(`Before.\n\n${MARKER}\n- a: A.\n\nAfter.`)).toBeNull();
  });

  test('an option whose does or cost holds a line break, as the pack writes it, falls back to null', () => {
    const why = 'The stage recommends "b". Why.';
    expect(
      parseOffered(`${MARKER}\n- a: Line one.\nLine two. (cost: x)\n- b: B. (cost: y)`, why)
    ).toBeNull();
    expect(parseOffered(`${MARKER}\n- a: A. (cost: x\ny)\n- b: B.`)).toBeNull();
  });

  test('a why without the prefix, or naming an id not offered, marks nothing', () => {
    expect(parseOffered(DRY_RUN_CONTEXT, 'The item text names it.')?.recommended).toBeUndefined();
    expect(
      parseOffered(DRY_RUN_CONTEXT, 'The stage recommends "Build-It". Close.')?.recommended
    ).toBeUndefined();
    expect(parseOffered(DRY_RUN_CONTEXT)?.recommended).toBeUndefined();
  });
});

describe('offeredPlaceholder', () => {
  test('names each offered option in words', () => {
    expect(offeredPlaceholder({ rest: '', options: [{ id: 'a', does: '' }] })).toBe(
      'Say which the stage offered you mean: A'
    );
    expect(
      offeredPlaceholder({
        rest: '',
        options: ['a-one', 'b', 'c'].map(id => ({ id, does: '' })),
      })
    ).toBe('Say which the stage offered you mean: A one, B or C');
  });
});
