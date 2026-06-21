import { describe, test } from 'bun:test';

describe('retry DAG state projection', () => {
  test.todo('computes target plus current-DAG descendants for retry invalidation', () => {});
  test.todo('preserves upstream and sibling completed outputs from earlier retry epochs', () => {});
  test.todo('treats skipped downstream nodes as ineligible retry targets', () => {});
  test.todo('uses latest effective node state when older epochs contain stale failures', () => {});
});
