// @archon-test-isolated
/**
 * A run continued after a pause replays the failures of its prior pass: the run had
 * already moved past them. A failed run resumed by an operator retries them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMockStore, createMockDeps, dagOptions, makeWorkflowRun } from './test-utils';
import { executeDagWorkflow } from '../dag-executor';

describe('executeDagWorkflow -- failures before a pause', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-replay-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  // The three-node shape from #4676: a node that fails, a node that runs anyway, then
  // a node after the point where the run paused.
  function workflow(marker: string) {
    return {
      name: 'replay-test',
      nodes: [
        {
          id: 'flaky',
          kind: 'exec' as const,
          runtime: 'sh' as const,
          script: `touch '${marker}'; exit 1`,
        },
        {
          id: 'report',
          kind: 'exec' as const,
          runtime: 'sh' as const,
          script: 'printf saw',
          depends_on: ['flaky'],
          trigger_rule: 'all_done' as const,
        },
        {
          id: 'after',
          kind: 'exec' as const,
          runtime: 'sh' as const,
          script: 'printf "%s" "$report.output"',
          depends_on: ['report'],
        },
      ],
    };
  }

  it('replays a failure from before the pause instead of re-running the node', async () => {
    const store = createMockStore();
    const marker = join(testDir, 'flaky-ran');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: workflow(marker),
        workflowRun: makeWorkflowRun('replay-continue'),
        priorCompletedNodes: new Map([['report', { output: 'saw' }]]),
        replayedFailures: new Map([['flaky', { error: 'exit 1' }]]),
      })
    );

    expect(existsSync(marker)).toBe(false);
    const events = store.persistWorkflowEvent.mock.calls.map(([event]) => event);
    expect(
      events.some(e => e.step_name === 'report' && e.event_type === 'node_skipped_prior_success')
    ).toBe(true);
    expect(events.some(e => e.step_name === 'after' && e.event_type === 'node_completed')).toBe(
      true
    );
  });

  it('re-runs a failed node when the resume retries a failed run', async () => {
    const store = createMockStore();
    const marker = join(testDir, 'flaky-ran');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: workflow(marker),
        workflowRun: makeWorkflowRun('replay-retry'),
        priorCompletedNodes: new Map([['report', { output: 'saw' }]]),
      })
    );

    expect(existsSync(marker)).toBe(true);
  });
});
