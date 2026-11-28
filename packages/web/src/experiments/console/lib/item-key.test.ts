import { expect, test } from 'bun:test';
import { displayItemKey, issueNumber, openAsksOf } from './item-key';

test('an issue key reads #N, in either spelling, and any other key reads as it is', () => {
  expect(
    ['issue-171', '64', 'issue-171-console-back-to-dev', 'order-9'].map(key => displayItemKey(key))
  ).toEqual(['#171', '#64', 'issue-171-console-back-to-dev', 'order-9']);
});

// [key, parent, as it reads]; owns the key display rule every surface shows.
test.each([
  ['issue-7', null, '#7'],
  ['7', null, '#7'],
  ['007', null, '#007'],
  ['issue-007', null, '#007'],
  ...['issue-7a', 'issue-', 'issue-x', '7a', 'ISSUE-7', '#7', 'pr-12', 'abc', ''].map(
    key => [key, null, key] as const
  ),
  // A split member reads as its parent's number and its piece in words.
  ['issue-136-item-keys', 'issue-136', '#136 · item keys'],
  ['48-foo', '48', '#48 · foo'],
  ['release-x-cut', 'release-x', 'release-x · cut'],
  // Membership comes from the parent passed in, never from the key.
  ['issue-136-item-keys', null, 'issue-136-item-keys'],
  ['71', '64', '#71'],
  ['issue-71', 'issue-64', '#71'],
  ['other-thing', 'issue-136', 'other-thing'],
  ['issue-136-', 'issue-136', 'issue-136-'],
  ['issue-1360', 'issue-136', '#1360'],
] as const)('%p under %p reads %p', (key, parent, reads) => {
  expect(displayItemKey(key, parent)).toBe(reads);
});

test('the issue number of a key in either form, none for any other', () => {
  expect([issueNumber('issue-7'), issueNumber('7'), issueNumber('7a'), issueNumber('#7')]).toEqual([
    '7',
    '7',
    null,
    null,
  ]);
});

test('openAsksOf counts the asks the tab lists for an item: either key spelling, none answered', () => {
  const on = (ref: string, key: string) => ({ ref, item: { key } });
  const asks = [on('a1', '198'), on('a2', 'issue-198'), on('a3', 'issue-198-split'), on('a4', '7')];
  const refs = (wanted: string[], answered: string[] = []): string[] =>
    openAsksOf(
      asks,
      answered.map(ref => ({ ask: { ref } })),
      wanted
    ).map(ask => ask.ref);
  // Twins under the two spellings are one item; a split member is not its parent.
  expect(refs(['198'])).toEqual(['a1', 'a2']);
  expect(refs(['issue-198'])).toEqual(['a1', 'a2']);
  expect(refs(['7'])).toEqual(['a4']);
  // An ask answered here this session drops out of the count everywhere at once.
  expect(refs(['198'], ['a2'])).toEqual(['a1']);
  // No filter: every open ask.
  expect(refs([], ['a4'])).toEqual(['a1', 'a2', 'a3']);
});
