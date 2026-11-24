import { describe, expect, test } from 'bun:test';
import { shippedView } from '../item-detail.test-fixtures';
import { stageHandOffs } from './stage-hand-offs';

describe('where items go from a stage', () => {
  test('every arrow out of the stage into another, in declared order and words', () => {
    expect(stageHandOffs(shippedView, 'build')).toEqual([
      { label: 'built', to: 'checks', toLabel: 'Checks' },
      { label: 'fixed for CI', to: 'host', toLabel: 'CI and review' },
      { label: 'replan', to: 'plan', toLabel: 'Plan' },
      { label: 'drop or reshape', to: 'ready', toLabel: 'Ready to merge' },
    ]);
  });
});
