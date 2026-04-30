import { describe, test, expect } from 'bun:test';
import { groupCards, repositoryLabel } from './group';
import type { SymphonyCard } from './types';

const card = (overrides: Partial<SymphonyCard>): SymphonyCard => ({
  dispatch_key: 'linear:APP-1',
  tracker: 'linear',
  issue_id: 'i-1',
  identifier: 'APP-1',
  lifecycle: 'running',
  status: 'In Progress',
  workflow_name: 'wf',
  workflow_run_id: null,
  attempt: null,
  due_at: null,
  last_error: null,
  started_at: null,
  dispatched_at: null,
  ...overrides,
});

describe('groupCards by lifecycle', () => {
  test('orders columns running, retrying, failed, completed, cancelled', () => {
    const cards = [
      card({ dispatch_key: 'a', lifecycle: 'completed' }),
      card({ dispatch_key: 'b', lifecycle: 'running' }),
      card({ dispatch_key: 'c', lifecycle: 'cancelled' }),
      card({ dispatch_key: 'd', lifecycle: 'retrying' }),
      card({ dispatch_key: 'e', lifecycle: 'failed' }),
    ];
    const groups = groupCards(cards, 'lifecycle');
    expect(groups.map(g => g.key)).toEqual([
      'running',
      'retrying',
      'failed',
      'completed',
      'cancelled',
    ]);
  });

  test('uses friendly labels for lifecycle keys', () => {
    const groups = groupCards([card({ lifecycle: 'failed' })], 'lifecycle');
    expect(groups[0]?.label).toBe('Failed');
  });
});

describe('groupCards by status', () => {
  test('biases known states to the front', () => {
    const cards = [
      card({ dispatch_key: 'a', status: 'Done' }),
      card({ dispatch_key: 'b', status: 'In Progress' }),
      card({ dispatch_key: 'c', status: 'Backlog' }),
      card({ dispatch_key: 'd', status: 'Todo' }),
    ];
    const groups = groupCards(cards, 'status');
    expect(groups.map(g => g.key)).toEqual(['Todo', 'In Progress', 'Done', 'Backlog']);
  });

  test('falls back to Unknown when status is null', () => {
    const groups = groupCards([card({ status: null })], 'status');
    expect(groups[0]?.key).toBe('Unknown');
  });
});

describe('groupCards by repository', () => {
  test('extracts owner/repo for github tracker keys', () => {
    const c = card({
      dispatch_key: 'github:Ddell12/archon-symphony#42',
      tracker: 'github',
    });
    expect(repositoryLabel(c)).toBe('Ddell12/archon-symphony');
    const groups = groupCards([c], 'repository');
    expect(groups[0]?.key).toBe('Ddell12/archon-symphony');
  });

  test('falls back to workflow_name for linear tracker', () => {
    const c = card({
      dispatch_key: 'linear:APP-1',
      tracker: 'linear',
      workflow_name: 'archon-feature-development',
    });
    expect(repositoryLabel(c)).toBe('archon-feature-development');
  });

  test('falls back to (linear) when workflow_name missing', () => {
    const c = card({
      dispatch_key: 'linear:APP-1',
      tracker: 'linear',
      workflow_name: null,
    });
    expect(repositoryLabel(c)).toBe('(linear)');
  });

  test('falls back to (github) when github key cannot be parsed', () => {
    const c = card({
      dispatch_key: 'github:malformed',
      tracker: 'github',
    });
    expect(repositoryLabel(c)).toBe('(github)');
  });
});
