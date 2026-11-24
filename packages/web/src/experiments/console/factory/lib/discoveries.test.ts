import { describe, expect, test } from 'bun:test';
import { foundChips, kindLabel, openFindings } from './discoveries';
import { DISCOVERIES } from './discoveries.test-fixtures';

describe('the words of what the factory found', () => {
  test('open findings are those no item carries', () => {
    expect(openFindings(DISCOVERIES).map(f => f.from.key)).toEqual(['58', '31']);
  });

  test('chips count every decision; a shadow drain would file', () => {
    expect(foundChips(DISCOVERIES)).toEqual([
      { label: 'would file', count: 3 },
      { label: 'held', count: 10 },
      { label: 'dropped', count: 16 },
    ]);
    expect(foundChips({ ...DISCOVERIES, shadow: false })[0]?.label).toBe('filed');
  });

  test('a kind reads in sentence case, and no kind reads nothing', () => {
    expect(kindLabel('defect')).toBe('Defect');
    expect(kindLabel('follow-up')).toBe('Follow up');
    expect(kindLabel(null)).toBeNull();
  });
});
