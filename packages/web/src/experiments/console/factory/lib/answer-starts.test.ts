import { describe, expect, test } from 'bun:test';
import { shippedView } from '../item-detail.test-fixtures';
import { answerStarts } from './answer-starts';

describe('answerStarts', () => {
  test("words an option of the asking run's workflow, named in full as runs record it", () => {
    expect(answerStarts(shippedView, 'Wirasm/archon-software-factory:stage-check', 'drop')).toBe(
      'Closes the PR without merging'
    );
    expect(answerStarts(shippedView, 'land', 'reshape')).toBe(
      'Leaves the PR as a draft until the item is shaped'
    );
  });

  test('another workflow with the same option id, or an option no key names, is not worded', () => {
    expect(
      answerStarts(shippedView, 'Wirasm/archon-software-factory:plan', 'drop')
    ).toBeUndefined();
    expect(answerStarts(shippedView, 'stage-check', 'send-back')).toBeUndefined();
  });

  test('without a view or a workflow nothing is worded', () => {
    expect(answerStarts(undefined, 'stage-check', 'drop')).toBeUndefined();
    expect(answerStarts(null, 'stage-check', 'drop')).toBeUndefined();
    expect(answerStarts(shippedView, undefined, 'drop')).toBeUndefined();
  });
});
