import { expect, test } from 'bun:test';
import { offeredPlaceholder, parseOffered } from './ask-offered';
import { DRY_RUN_CONTEXT, DRY_RUN_WHY, MARKER } from './ask-offered.test-fixtures';

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

test.each([
  ['no cost', `${MARKER}\n- leave-it: Leave it.`, [{ id: 'leave-it', does: 'Leave it.' }]],
  [
    'an empty does, with or without the trailing space',
    `${MARKER}\n- leave-it: \n- build-it:`,
    [
      { id: 'leave-it', does: '' },
      { id: 'build-it', does: '' },
    ],
  ],
  [
    'a cost holding parentheses, and a does mentioning a cost mid-sentence',
    `${MARKER}\n- a: Do it. (cost: One round (maybe two).)\n- b: Note (cost: x) is not the end.`,
    [
      { id: 'a', does: 'Do it.', cost: 'One round (maybe two).' },
      { id: 'b', does: 'Note (cost: x) is not the end.' },
    ],
  ],
])('an option with %s; only the list leaves no rest', (_name, context, options) => {
  expect(parseOffered(context)).toEqual({ rest: '', options });
});

test.each([
  ['no marker', 'Review says the item asks for it.\n- build-it: Build it.'],
  ['a marker with nothing under it', `Some context.\n\n${MARKER}`],
  ['a marker with only prose under it', `Some context.\n\n${MARKER}\nNothing listed.`],
  ['a reworded marker', DRY_RUN_CONTEXT.replace('in its own words', 'in its words')],
  ['a line after the list that is not an option', `Before.\n\n${MARKER}\n- a: A.\n\nAfter.`],
  ['a does holding a line break', `${MARKER}\n- a: Line one.\nLine two. (cost: x)\n- b: B.`],
  ['a cost holding a line break', `${MARKER}\n- a: A. (cost: x\ny)\n- b: B.`],
])('%s is not parsed', (_name, context) => {
  expect(parseOffered(context, DRY_RUN_WHY)).toBeNull();
});

test.each([
  ['without the prefix', 'The item text names it.'],
  ['naming an id not offered', 'The stage recommends "Build-It". Close.'],
  ['absent', undefined],
])('a why %s marks nothing', (_name, why) => {
  expect(parseOffered(DRY_RUN_CONTEXT, why)?.recommended).toBeUndefined();
});

test('the placeholder names each offered option in words', () => {
  expect(offeredPlaceholder({ rest: '', options: [{ id: 'a', does: '' }] })).toBe(
    'Say which the stage offered you mean: A'
  );
  expect(
    offeredPlaceholder({ rest: '', options: ['a-one', 'b', 'c'].map(id => ({ id, does: '' })) })
  ).toBe('Say which the stage offered you mean: A one, B or C');
});
