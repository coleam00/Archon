import { afterAll, beforeEach, describe, expect, jest, test } from 'bun:test';
import { observeLostOwners, observeRunOwners } from './owner-observation';
import type { WorkflowRun } from './schemas/workflow-run';

const run = (id: string) =>
  ({ id, status: 'running', parent_run_id: null, metadata: {} }) as WorkflowRun;

describe('observeRunOwners', () => {
  beforeEach(() => jest.useFakeTimers());
  afterAll(() => jest.useRealTimers());

  test('carries each observation back to its run, whatever order they settle in', async () => {
    const seen: string[] = [];
    const owners = await observeRunOwners(
      {
        runs: async () => [],
        observe: async run => {
          seen.push(run.id);
          return run.id === 'b' ? 'unreachable' : run.id === 'c' ? 'reachable' : 'unknown';
        },
      },
      ['a', 'b', 'c'].map(run)
    );
    expect(owners).toEqual(['unknown', 'unreachable', 'reachable']);
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
  });

  test('an observation past its deadline reads unknown, not "needs no owner" and not gone', async () => {
    const never = { runs: async () => [], observe: () => new Promise<never>(() => {}) };
    const owners = observeRunOwners(never, [run('a')]);
    const lost = observeLostOwners(never, [run('a')]);
    jest.advanceTimersByTime(5_001);
    expect(await owners).toEqual(['unknown']);
    expect(await lost).toEqual([null]);
  });
});
