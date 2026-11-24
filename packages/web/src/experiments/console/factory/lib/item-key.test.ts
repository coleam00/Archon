import { describe, expect, test } from 'bun:test';
import { displayItemKey, issueNumber } from './item-key';

describe('displayItemKey', () => {
  test('an issue key in either form reads #<number>', () => {
    expect(displayItemKey('issue-7', null)).toBe('#7');
    expect(displayItemKey('7', null)).toBe('#7');
    expect(issueNumber('issue-7')).toBe('7');
    expect(issueNumber('7')).toBe('7');
  });

  test('digits are kept as written', () => {
    expect(displayItemKey('007', null)).toBe('#007');
    expect(displayItemKey('issue-007', null)).toBe('#007');
  });

  test('any other key reads as it is', () => {
    for (const key of [
      'issue-7a',
      'issue-',
      'issue-x',
      '7a',
      'ISSUE-7',
      '#7',
      'pr-12',
      'abc',
      '',
    ]) {
      expect(displayItemKey(key, null)).toBe(key);
      expect(issueNumber(key)).toBeNull();
    }
  });

  test("a split member reads as its parent's number and its piece in words", () => {
    expect(displayItemKey('issue-136-item-keys', 'issue-136')).toBe('#136 · item keys');
    expect(displayItemKey('48-foo', '48')).toBe('#48 · foo');
    expect(displayItemKey('release-x-cut', 'release-x')).toBe('release-x · cut');
  });

  test('membership comes from the parent passed in, never from the key', () => {
    // Without a parent, a key shaped like a member reads as it is.
    expect(displayItemKey('issue-136-item-keys', null)).toBe('issue-136-item-keys');
    // A member keyed by its own issue still reads #N.
    expect(displayItemKey('71', '64')).toBe('#71');
    expect(displayItemKey('issue-71', 'issue-64')).toBe('#71');
    // A key that lacks its parent's prefix, or has nothing after it, reads as today.
    expect(displayItemKey('other-thing', 'issue-136')).toBe('other-thing');
    expect(displayItemKey('issue-136-', 'issue-136')).toBe('issue-136-');
    expect(displayItemKey('issue-1360', 'issue-136')).toBe('#1360');
  });
});
