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
        expect(usage?.total_cost_usd).toBe(floor ?? (typeof cost === 'number' ? cost : 0) + 0.2);
        expect(usage?.total_cost_incomplete).toBe(incomplete ? true : undefined);
      }
    );
  }
}

for (const fanOut of [false, true]) {
  it.each(['node_completed', 'node_failed', 'node_suspended'])(
    `retains unreadable historical child cost (${fanOut ? 'fan-out' : 'single'}, %s)`,
    async eventType => {
      const store = createMockStore();
      store.findChildRuns.mockResolvedValue([
        makeWorkflowRun('old-child', {
          status: 'completed',
          metadata: { parent_node_id: 'sub', child_index: 0, summary: 'done' },
        }),
      ]);
      store.getDagResumeSnapshot.mockImplementation(async id =>
        foldDagResumeSnapshot(
          [
            { step_name: 'unreadable', event_type: eventType, data: '{' },
            {
              step_name: 'priced',
              event_type: 'node_completed',
              data: { type: 'agent', cost_usd: 0.2 },
            },
          ],
          id
        )
      );
      await executeDagWorkflow(
        dagOptions({
          cwd,
          deps: createMockDeps(store),
          workflowRun: makeWorkflowRun(),
          runChildWorkflow: async () => {
            throw new Error('Must re-enter');
          },
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
      expect(runUsageWrites(store).at(-1)).toMatchObject({
        total_cost_usd: 0.2,
        total_cost_incomplete: true,
      });
    }
  );
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
      foldDagResumeSnapshot(
        persistedEvents(store).filter(event => event.workflow_run_id === id),
        id
      )
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
    store.getDagResumeSnapshot.mockImplementation(async id => foldDagResumeSnapshot([], id));
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

for (const fanOut of [false, true]) {
  it.each(['completed', 'failed', 'cancelled', 'paused'] as const)(
    `replaces legacy flat child usage on ${fanOut ? 'fan-out' : 'single'} recovery to %s`,
    async status => {
      const store = createMockStore();
      const run = makeWorkflowRun('parent');
      const history = [
        {
          step_name: 'sub',
          event_type: 'node_failed',
          data: {
            type: 'workflow',
            cost_usd: 0.2,
            tokens: { input: 10, output: 2 },
            error: 'held',
          },
        },
      ];
      const prior = await foldDagResumeSnapshot(history, run.id);
      store.getDagResumeSnapshot.mockImplementation(async id =>
        foldDagResumeSnapshot(id === run.id ? [...history, ...persistedEvents(store)] : [], id)
      );
      store.findChildRuns.mockResolvedValue([
        makeWorkflowRun('child', {
          status: 'failed',
          metadata: {
            parent_node_id: 'sub',
            child_index: 0,
            summary: 'done',
            total_cost_usd: 0.5,
            total_cost_incomplete: true,
            total_tokens_in: 30,
            total_tokens_out: 6,
          },
        }),
      ]);
      await executeDagWorkflow(
        dagOptions({
          cwd,
          deps: createMockDeps(store),
          workflowRun: run,
          priorCompletedNodes: prior.completedNodeOutputs,
          priorUsage: prior,
          runChildWorkflow: async () => ({
            childRunId: 'child',
            status,
            costUsd: 0.5,
            costIncomplete: true,
            tokens: { input: 30, output: 6 },
            output: 'done',
          }),
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
      expect(runUsageWrites(store).at(-1)).toMatchObject({
        total_cost_usd: 0.5,
        total_tokens_in: 30,
        total_tokens_out: 6,
        total_cost_incomplete: true,
      });
      const recovered = await store.getDagResumeSnapshot(run.id);
      expect(recovered.costUsd).toBe(0.5);
      expect(recovered.tokens).toEqual({ input: 30, output: 6 });
    }
  );
}

for (const fanOut of [false, true]) {
  for (const marker of [undefined, true]) {
    it.each([
      { laterCost: 0.3, unknownTokens: false },
      { laterCost: 0, unknownTokens: true },
      { laterCost: -0.2, unknownTokens: false },
      { laterCost: -0.3, unknownTokens: false },
    ])(
      `reads newer held child events (${fanOut ? 'fan-out' : 'single'}, marker ${String(marker)}, %j)`,
      async ({ laterCost, unknownTokens }) => {
        const store = createMockStore();
        store.findChildRuns.mockResolvedValue([
          makeWorkflowRun('held', {
            status: 'paused',
            metadata: {
              parent_node_id: 'sub',
              child_index: 0,
              total_cost_usd: 0.2,
              total_tokens_in: 10,
              total_tokens_out: 2,
              ...(marker ? { total_cost_incomplete: marker } : {}),
            },
          }),
        ]);
        store.getDagResumeSnapshot.mockImplementation(async id =>
          foldDagResumeSnapshot(
            [
              {
                step_name: 'old',
                event_type: 'node_completed',
                data: { type: 'agent', cost_usd: 0.2, tokens: { input: 10, output: 2 } },
              },
              {
                step_name: 'new',
                event_type: 'node_completed',
                data: {
                  type: 'agent',
                  cost_usd: laterCost,
                  tokens: { input: unknownTokens ? 'unreadable' : 20, output: 4 },
                },
              },
            ],
            id
          )
        );
        const runChildWorkflow = mock<RunChildWorkflowFn>(async () => {
          throw new Error('Existing child must remain held');
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
        expect(store.pauseWorkflowRun).toHaveBeenCalled();
        const usage = runUsageWrites(store).at(-1);
        expect(usage?.total_cost_usd).toBeCloseTo(0.2 + laterCost);
        expect(usage?.total_cost_incomplete).toBe(marker);
        expect(usage?.total_tokens_in).toBe(unknownTokens ? null : 30);
        expect(usage?.total_tokens_out).toBe(unknownTokens ? null : 6);
        expect(usage?.total_tokens_unknown).toBe(unknownTokens ? true : undefined);
      }
    );
  }
}

for (const fanOut of [false, true]) {
  it.each(['completed', 'paused'] as const)(
    `retains child spend after a supplemental read failure (${fanOut ? 'fan-out' : 'single'}, %s)`,
    async status => {
      const store = createMockStore();
      store.findChildRuns.mockResolvedValue([
        makeWorkflowRun('existing', {
          status,
          metadata: {
            parent_node_id: 'sub',
            child_index: 0,
            total_cost_usd: 0.2,
            total_tokens_in: 10,
            total_tokens_out: 2,
            summary: 'done',
          },
        }),
      ]);
      store.getDagResumeSnapshot.mockImplementation(async id => {
        if (id === 'existing') throw new Error('history unavailable');
        return foldDagResumeSnapshot(
          persistedEvents(store).filter(e => e.workflow_run_id === id),
          id
        );
      });
      const runChildWorkflow = mock<RunChildWorkflowFn>(async () => ({
        childRunId: 'independent',
        status: 'completed',
        output: 'done',
        costUsd: 0.1,
      }));
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
        })
      );
      expect(runUsageWrites(store).at(-1)?.total_cost_usd).toBeCloseTo(fanOut ? 0.3 : 0.2);
      expect(runUsageWrites(store).at(-1)?.total_cost_incomplete).toBe(true);
      expect(runChildWorkflow).toHaveBeenCalledTimes(fanOut ? 1 : 0);
      expect(store.cancelWorkflowRun).not.toHaveBeenCalled();
      if (status === 'paused') expect(store.pauseWorkflowRun).toHaveBeenCalled();
    }
  );
}
