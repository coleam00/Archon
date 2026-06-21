import { describe, test } from 'bun:test';

describe('workflow retry helpers', () => {
  test.todo('identifies failed DAG nodes that can show the retry action', () => {});
  test.todo(
    'rejects retry eligibility for non-failed, skipped, or stale-epoch node states',
    () => {}
  );
  test.todo('builds the retry-node API request for a run id and node id', () => {});
  test.todo('normalizes retry API errors into user-facing Web helper results', () => {});
});
