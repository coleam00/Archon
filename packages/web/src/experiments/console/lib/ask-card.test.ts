import { describe, expect, test } from 'bun:test';
import {
  groupBySubject,
  humaniseId,
  optionLabel,
  pickOption,
  recommendationWhy,
  recommendedLabel,
  shortWorkflow,
  takesText,
  tileOrder,
  type AttentionWait,
} from './ask-card';
import { askItem, gateItem } from './needs-you.test-fixtures';

const withOther: AttentionWait = {
  form: 'select',
  options: [
    { id: 'send-back-once-more' },
    { id: 'lower-concurrency', label: 'Lower the concurrency' },
    { id: 'other', label: 'Other' },
  ],
  other: true,
};

describe('option labels: never a raw id', () => {
  test('an id alone reads in sentence case, hyphens as spaces', () => {
    expect(optionLabel(withOther, { id: 'send-back-once-more' })).toBe('Send back once more');
    expect(humaniseId('land_it')).toBe('Land it');
  });

  test('a label wins over the id', () => {
    expect(
      optionLabel(withOther, { id: 'lower-concurrency', label: 'Lower the concurrency' })
    ).toBe('Lower the concurrency');
  });

  test("the reserved 'other' option reads Something else, found by its place, not its id", () => {
    expect(optionLabel(withOther, { id: 'other', label: 'Other' })).toBe('Something else');
    // A wait not declared `other: true` has no reserved option: an option named other is just one.
    expect(optionLabel({ ...withOther, other: undefined }, { id: 'other', label: 'Other' })).toBe(
      'Other'
    );
  });

  test('a recommendation whose id matches no option still reads humanised', () => {
    const wait: AttentionWait = {
      ...withOther,
      recommendation: { option: 'split-the-item', why: 'Too big.' },
    };
    expect(recommendedLabel(wait)).toBe('Split the item');
    expect(recommendedLabel(withOther)).toBeUndefined();
  });

  test('the why reads after its confidence', () => {
    expect(recommendationWhy({ option: 'a', why: 'Review is ready.', confidence: 'high' })).toBe(
      'High confidence. Review is ready.'
    );
    expect(recommendationWhy({ option: 'a', why: 'Review is ready.' })).toBe('Review is ready.');
  });

  test('a pack workflow reads by its own name', () => {
    expect(shortWorkflow('Wirasm/archon-software-factory:deliver')).toBe('deliver');
    expect(shortWorkflow('deliver')).toBe('deliver');
  });
});

describe('tile order', () => {
  const ids = (wait: AttentionWait): string[] => tileOrder(wait).map(option => option.id);

  test('the recommended option first, the rest declared, other last', () => {
    expect(
      ids({ ...withOther, recommendation: { option: 'lower-concurrency', why: 'Cheaper.' } })
    ).toEqual(['lower-concurrency', 'send-back-once-more', 'other']);
  });

  test('no recommendation, or one matching no option: the declared order', () => {
    expect(ids(withOther)).toEqual(['send-back-once-more', 'lower-concurrency', 'other']);
    expect(ids({ ...withOther, recommendation: { option: 'nope', why: '-' } })).toEqual([
      'send-back-once-more',
      'lower-concurrency',
      'other',
    ]);
  });
});

describe('choosing', () => {
  test('one pick for select, choosing it again clears it; multi_select toggles each', () => {
    expect(pickOption(withOther, [], 'a')).toEqual(['a']);
    expect(pickOption(withOther, ['a'], 'b')).toEqual(['b']);
    expect(pickOption(withOther, ['a'], 'a')).toEqual([]);
    const multi = { form: 'multi_select' as const };
    expect(pickOption(multi, ['a'], 'b')).toEqual(['a', 'b']);
    expect(pickOption(multi, ['a', 'b'], 'a')).toEqual(['b']);
  });

  test('the textarea is required for Something else and a message', () => {
    expect(takesText(withOther, ['other'])).toBe(true);
    expect(takesText(withOther, ['send-back-once-more'])).toBe(false);
    expect(takesText({ form: 'message', options: [] }, [])).toBe(true);
  });
});

describe('grouping under the item', () => {
  test("an item's asks sit together where its newest one would, waits with no item by run", () => {
    const seven = { id: 'item-7', projectKey: 'acme', key: '#7' };
    const nine = { id: 'item-9', projectKey: 'acme', key: '#9' };
    const groups = groupBySubject([
      askItem({ ref: 'a', item: seven }),
      askItem({ ref: 'b', item: nine }),
      gateItem({ ref: 'g' }),
      askItem({ ref: 'c', item: seven }),
    ]);
    expect(groups.map(group => [group.key, group.first.ref, group.asks.map(a => a.ref)])).toEqual([
      ['item:item-7', 'a', ['a', 'c']],
      ['item:item-9', 'b', ['b']],
      ['run:run-gate', 'g', ['g']],
    ]);
  });
});
