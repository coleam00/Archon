import { describe, test, expect } from 'bun:test';
import { buildCards } from './transform';
import type { SymphonyDispatchRow, SymphonyStateResponse } from './types';

const baseState: SymphonyStateResponse = {
  generated_at: '2026-04-30T00:00:00.000Z',
  counts: { running: 0, retrying: 0, completed: 0 },
  running: [],
  retrying: [],
};

const runningRow = (
  overrides?: Partial<SymphonyStateResponse['running'][number]>
): SymphonyStateResponse['running'][number] => ({
  dispatch_key: 'linear:APP-1',
  tracker: 'linear',
  issue_id: 'i-1',
  issue_identifier: 'APP-1',
  state: 'In Progress',
  started_at: '2026-04-30T00:01:00.000Z',
  workflow_run_id: 'run-current',
  ...overrides,
});

const retryRow = (
  overrides?: Partial<SymphonyStateResponse['retrying'][number]>
): SymphonyStateResponse['retrying'][number] => ({
  dispatch_key: 'linear:APP-2',
  tracker: 'linear',
  issue_id: 'i-2',
  issue_identifier: 'APP-2',
  attempt: 1,
  due_at: '2026-04-30T00:05:00.000Z',
  error: 'transient failure',
  ...overrides,
});

const dispatchRow = (overrides?: Partial<SymphonyDispatchRow>): SymphonyDispatchRow => ({
  id: 'd-uuid',
  issue_id: 'i-1',
  identifier: 'APP-1',
  tracker: 'linear',
  dispatch_key: 'linear:APP-1',
  codebase_id: null,
  workflow_name: 'archon-feature-development',
  workflow_run_id: 'run-historical',
  attempt: 1,
  dispatched_at: '2026-04-30T00:00:30.000Z',
  status: 'completed',
  last_error: null,
  ...overrides,
});

describe('buildCards', () => {
  test('returns empty list when both sources are empty', () => {
    expect(buildCards(baseState, [])).toEqual([]);
  });

  test('builds a card for a running row', () => {
    const cards = buildCards({ ...baseState, running: [runningRow()] }, []);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.lifecycle).toBe('running');
    expect(cards[0]?.workflow_run_id).toBe('run-current');
    expect(cards[0]?.status).toBe('In Progress');
  });

  test('builds a card for a retrying row', () => {
    const cards = buildCards({ ...baseState, retrying: [retryRow()] }, []);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.lifecycle).toBe('retrying');
    expect(cards[0]?.attempt).toBe(1);
    expect(cards[0]?.last_error).toBe('transient failure');
  });

  test('builds cards for terminal dispatch rows (completed/failed/cancelled)', () => {
    const cards = buildCards(baseState, [
      dispatchRow({
        dispatch_key: 'linear:APP-A',
        identifier: 'APP-A',
        issue_id: 'a',
        status: 'completed',
      }),
      dispatchRow({
        dispatch_key: 'linear:APP-B',
        identifier: 'APP-B',
        issue_id: 'b',
        status: 'failed',
        last_error: 'boom',
      }),
      dispatchRow({
        dispatch_key: 'linear:APP-C',
        identifier: 'APP-C',
        issue_id: 'c',
        status: 'cancelled',
      }),
    ]);
    const byKey = Object.fromEntries(cards.map(c => [c.dispatch_key, c]));
    expect(byKey['linear:APP-A']?.lifecycle).toBe('completed');
    expect(byKey['linear:APP-B']?.lifecycle).toBe('failed');
    expect(byKey['linear:APP-B']?.last_error).toBe('boom');
    expect(byKey['linear:APP-C']?.lifecycle).toBe('cancelled');
  });

  test('skips pending and running statuses in the dispatches feed', () => {
    const cards = buildCards(baseState, [
      dispatchRow({ dispatch_key: 'linear:APP-X', identifier: 'APP-X', status: 'pending' }),
      dispatchRow({ dispatch_key: 'linear:APP-Y', identifier: 'APP-Y', status: 'running' }),
    ]);
    expect(cards).toEqual([]);
  });

  test('live running row wins over a stale terminal dispatch with the same key', () => {
    // APP-1 is running attempt #3 right now, but a `failed` row from attempt #2 still exists.
    const cards = buildCards({ ...baseState, running: [runningRow()] }, [
      dispatchRow({
        status: 'failed',
        attempt: 2,
        workflow_run_id: 'run-historical',
        last_error: 'previous failure',
      }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.lifecycle).toBe('running');
    // Live state wins for workflow_run_id (current attempt).
    expect(cards[0]?.workflow_run_id).toBe('run-current');
    // Historical context surfaces from the dispatch row.
    expect(cards[0]?.last_error).toBe('previous failure');
    expect(cards[0]?.attempt).toBe(2);
  });

  test('retry row enriched by latest matching dispatch row', () => {
    const cards = buildCards({ ...baseState, retrying: [retryRow()] }, [
      dispatchRow({
        dispatch_key: 'linear:APP-2',
        identifier: 'APP-2',
        issue_id: 'i-2',
        status: 'failed',
        workflow_run_id: 'run-attempt-1',
        attempt: 1,
      }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.lifecycle).toBe('retrying');
    expect(cards[0]?.workflow_run_id).toBe('run-attempt-1');
    expect(cards[0]?.workflow_name).toBe('archon-feature-development');
  });

  test('handles undefined inputs', () => {
    expect(buildCards(undefined, undefined)).toEqual([]);
    expect(buildCards(undefined, [dispatchRow({ status: 'completed' })])).toHaveLength(1);
  });

  test('selects the latest dispatch row by dispatched_at when multiple share a key', () => {
    const cards = buildCards({ ...baseState, running: [runningRow()] }, [
      dispatchRow({
        dispatched_at: '2026-04-29T00:00:00.000Z',
        attempt: 1,
        last_error: 'old',
      }),
      dispatchRow({
        dispatched_at: '2026-04-30T00:00:30.000Z',
        attempt: 2,
        last_error: 'newer',
      }),
    ]);
    expect(cards[0]?.attempt).toBe(2);
    expect(cards[0]?.last_error).toBe('newer');
  });
});
