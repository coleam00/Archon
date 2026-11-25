import { expect, test } from 'bun:test';
import { displayItemKey } from './item-key';

test('an issue key reads #N, in either spelling, and any other key reads as it is', () => {
  expect(
    ['issue-171', '64', 'issue-171-console-back-to-dev', 'order-9'].map(displayItemKey)
  ).toEqual(['#171', '#64', 'issue-171-console-back-to-dev', 'order-9']);
});
