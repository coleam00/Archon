import { expect, test } from 'bun:test';
import { FILTER_ORDER, filterCount } from './FilterChips';
import type { RunCounts } from '../skills/runs';

test('the status tabs add up to All, with pending runs counted as running', () => {
  const counts: RunCounts = {
    all: 21,
    pending: 1,
    running: 2,
    paused: 3,
    failed: 4,
    completed: 5,
    cancelled: 6,
  };
  const tabs = FILTER_ORDER.filter(filter => filter !== 'all');
  expect(tabs.reduce((sum, filter) => sum + filterCount(counts, filter), 0)).toBe(counts.all);
  expect(filterCount(counts, 'running')).toBe(3);
});
