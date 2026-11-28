import { describe, expect, test } from 'bun:test';
import { observeRunOwners } from './owner-observation';
import type { WorkflowRun } from './schemas/workflow-run';

const run = (id: string) =>
  ({ id, status: 'running', parent_run_id: null, metadata: {} }) as WorkflowRun;

describe('observeRunOwners', () => {
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
});
