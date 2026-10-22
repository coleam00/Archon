// @archon-test-isolated
import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { WorkflowRunPauseConflictError } from '../../../store';
import {
  createMockStore,
  createMockDeps,
  dagOptions,
  makeWorkflowRun,
  persistedEvents,
  runUsageWrites,
} from '../../test-utils';
import type { RunChildWorkflowFn } from '../../child-run';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'child-usage-'));
  await mkdir(join(cwd, '.archon/workflows'), { recursive: true });
  await writeFile(
    join(cwd, '.archon/workflows/child.yaml'),
    'name: child\ndescription: child\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "true"'
  );
});
afterEach(async () => {
  await removeTempTree(cwd);
});

for (const fanOut of [false, true]) {
  for (const floor of [undefined, 0, 0.3]) {
    it.each([
      { label: 'unpriced', cost: undefined, incomplete: true },
      { label: 'invalid', cost: 'invalid', incomplete: true },
      { label: 'zero', cost: 0, incomplete: false },
      { label: 'priced', cost: 0.1, incomplete: false },
    ])(
      `legacy child re-entry (${fanOut ? 'fan-out' : 'single'}, floor ${String(floor)}, $label)`,
      async ({ cost, incomplete }) => {
        const store = createMockStore();
        store.findChildRuns.mockResolvedValue([
          makeWorkflowRun('old-child', {
            status: 'completed',
            metadata: {
              parent_node_id: 'sub',
              child_index: 0,
              summary: 'done',
              total_tokens_in: 10,
              total_tokens_out: 2,
              ...(floor !== undefined ? { total_cost_usd: floor } : {}),
            },
          }),
        ]);
        store.getDagResumeSnapshot.mockImplementation(async id =>
          foldDagResumeSnapshot(
            [
              {
                step_name: 'old',
                event_type: 'node_completed',
                data: { type: 'agent', cost_usd: cost, node_output: 'old' },
              },
              {
                step_name: 'priced',
                event_type: 'node_completed',
                data: { type: 'agent', cost_usd: 0.2, node_output: 'new' },
              },
            ],
            id
          )
        );
        const runChildWorkflow = mock<RunChildWorkflowFn>(async () => {
          throw new Error('Must re-enter');
        });
        await executeDagWorkflow(
          dagOptions({
            cwd,
            deps: createMockDeps(store),
            workflowRun: makeWorkflowRun(),
            runChildWorkflow,
            workflow: {
              name: 'parent',
              nodes: [
                {
                  id: 'sub',
                  kind: 'workflow',
                  workflow: 'child',
                  ...(fanOut
                    ? {
                        fan_out: {
                          items: '[1]',
                          as: 'item',
                          max_parallel: 1,
                          join: 'all_done',
                        } as const,
                      }
                    : {}),
                },
              ],
            },
          })
        );
        expect(runChildWorkflow).not.toHaveBeenCalled();
        const usage = runUsageWrites(store).at(-1);
        expect(usage?.total_cost_usd).toBe(floor);
        expect(usage?.total_cost_incomplete).toBe(incomplete ? true : undefined);
      }
    );
  }
}

it.each([
  { mode: 'single', refused: false },
  { mode: 'single', refused: true },
  { mode: 'fan-out', refused: false },
  { mode: 'fan-out', refused: true },
  { mode: 'lookup-failure', refused: false },
])(
  'retains child usage through $mode (pause refused: $refused) and cold re-entry',
  async ({ mode, refused }) => {
    const fanOut = mode !== 'single';
    const store = createMockStore();
    const run = makeWorkflowRun('parent');
    store.getDagResumeSnapshot.mockImplementation(async id =>
      foldDagResumeSnapshot(persistedEvents(store), id)
    );
    let ran = false;
    if (refused) {
      store.pauseWorkflowRun.mockImplementation(async () => {
        throw new WorkflowRunPauseConflictError(run.id);
      });
      store.getWorkflowRunStatus.mockImplementation(async () => (ran ? 'failed' : 'running'));
    }
    if (mode === 'lookup-failure') {
      store.findChildRuns
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('lookup unavailable'));
    }
    const runChildWorkflow = mock<RunChildWorkflowFn>(async args => {
      ran = true;
      return {
        childRunId: `child-${String(args.childIndex ?? 0)}`,
        status: args.childIndex === 1 ? 'completed' : 'paused',
        costUsd: 0.2,
        costIncomplete: true,
        tokens: { input: 10, output: 2 },
        output: 'done',
      };
    });
    const options = dagOptions({
      cwd,
      deps: createMockDeps(store),
      workflowRun: run,
      runChildWorkflow,
      workflow: {
        name: 'parent',
        nodes: [
          {
            id: 'sub',
            kind: 'workflow',
            workflow: 'child',
            ...(fanOut
              ? {
                  fan_out: {
                    items: '[1,2]',
                    as: 'item',
                    max_parallel: 2,
                    join: 'all_done',
                  } as const,
                }
              : {}),
          },
        ],
      },
    });
    await executeDagWorkflow(options);
    const floor = fanOut ? 0.4 : 0.2;
    expect(runUsageWrites(store).at(-1)).toMatchObject({
      total_cost_usd: floor,
      total_cost_incomplete: true,
    });
    let snapshot = await foldDagResumeSnapshot(persistedEvents(store), run.id);
    expect(snapshot.costUsd).toBe(floor);
    expect(snapshot.costIncomplete).toBe(true);
    expect(snapshot.tokens).toEqual({ input: fanOut ? 20 : 10, output: fanOut ? 4 : 2 });
    expect(snapshot.completedNodeOutputs.size).toBe(0);
    if (mode === 'lookup-failure') expect(store.failWorkflowRun).toHaveBeenCalled();
    else expect(store.pauseWorkflowRun).toHaveBeenCalled();

    store.getWorkflowRunStatus.mockResolvedValue('running');
    store.findChildRuns.mockResolvedValue(
      Array.from({ length: fanOut ? 2 : 1 }, (_, index) =>
        makeWorkflowRun(`child-${String(index)}`, {
          status: index === 0 ? 'paused' : 'completed',
          metadata: {
            parent_node_id: 'sub',
            child_index: index,
            summary: 'done',
            total_cost_usd: 0.2,
            total_cost_incomplete: true,
            total_tokens_in: 10,
            total_tokens_out: 2,
          },
        })
      )
    );
    await executeDagWorkflow({
      ...options,
      priorCompletedNodes: snapshot.completedNodeOutputs,
      priorUsage: snapshot,
    });
    expect(runUsageWrites(store).at(-1)?.total_cost_usd).toBe(floor);
    snapshot = await foldDagResumeSnapshot(persistedEvents(store), run.id);
    expect(snapshot.costUsd).toBe(floor);
    // The child has made more progress by the next parent pass. Its amount remains cumulative.
    store.findChildRuns.mockResolvedValue(
      Array.from({ length: fanOut ? 2 : 1 }, (_, index) =>
        makeWorkflowRun(`child-${String(index)}`, {
          status: 'completed',
          metadata: {
            parent_node_id: 'sub',
            child_index: index,
            summary: 'done',
            total_cost_usd: index === 0 ? 0.5 : 0.2,
            total_cost_incomplete: true,
            total_tokens_in: index === 0 ? 30 : 10,
            total_tokens_out: index === 0 ? 6 : 2,
          },
        })
      )
    );
    await executeDagWorkflow({
      ...options,
      priorCompletedNodes: snapshot.completedNodeOutputs,
      priorUsage: snapshot,
    });
    const finalFloor = fanOut ? 0.7 : 0.5;
    expect(runUsageWrites(store).at(-1)?.total_cost_usd).toBeCloseTo(finalFloor);
    expect(runUsageWrites(store).at(-1)?.total_tokens_in).toBe(fanOut ? 40 : 30);
    snapshot = await foldDagResumeSnapshot(persistedEvents(store), run.id);
    expect(snapshot.costUsd).toBeCloseTo(finalFloor);
    expect(snapshot.costIncomplete).toBe(true);
    expect(snapshot.tokens?.input).toBe(fanOut ? 40 : 30);
    expect(runChildWorkflow).toHaveBeenCalledTimes(fanOut ? 2 : 1);
  }
);

it.each(['paused', 'running', 'pending'] as const)(
  'retains existing %s child usage when pausing its parent',
  async status => {
    const store = createMockStore();
    store.findChildRuns.mockResolvedValue([
      makeWorkflowRun('held', {
        status,
        metadata: {
          parent_node_id: 'sub',
          total_cost_usd: 0.2,
          total_cost_incomplete: true,
        },
      }),
    ]);
    await executeDagWorkflow(
      dagOptions({
        cwd,
        deps: createMockDeps(store),
        workflowRun: makeWorkflowRun(),
        runChildWorkflow: async () => {
          throw new Error('Existing child must remain held');
        },
        workflow: { name: 'parent', nodes: [{ id: 'sub', kind: 'workflow', workflow: 'child' }] },
      })
    );
    expect(runUsageWrites(store).at(-1)).toMatchObject({
      total_cost_usd: 0.2,
      total_cost_incomplete: true,
    });
  }
);
