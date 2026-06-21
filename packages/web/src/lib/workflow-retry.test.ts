import { describe, test } from 'bun:test';

describe('workflow retry helpers', () => {
  test.todo('identifies failed DAG nodes that can show the retry action', () => {});
  test.todo('marks only Web-created workflow runs as eligible for the retry action', () => {});
  test.todo(
    'rejects retry eligibility for non-failed, skipped, or stale-epoch node states',
    () => {}
  );
  test.todo('rejects retry eligibility when the run must be retried from the CLI', () => {});
  test.todo('builds the retry-node API request for a run id and node id', () => {});
  test.todo('returns retry scope and safety-ref details from a successful API response', () => {});
  test.todo('normalizes retry API errors into user-facing Web helper results', () => {});
});
