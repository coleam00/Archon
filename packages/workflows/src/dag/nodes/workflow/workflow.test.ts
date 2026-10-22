// @archon-test-isolated
import { TerminalStatusWriteError } from '../../../terminal-status-write';
import { NodeEventWriteError } from '../../../node-event-write';
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mockLogFn,
  createMockStore,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  dagOptions,
  makeWorkflowRun,
  readTranscript,
  runUsageWrites,
  persistedEvents,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { fanOutOutcome } from '../../../schemas/fan-out-outcome';
import { type RunChildWorkflowFn } from '../../child-run';
import type { DagNode } from '../../../schemas';
import type { IWorkflowStore } from '../../../store';

describe('executeDagWorkflow -- workflow: node', () => {
  let testDir: string;

  /** Write the composed block the fan-out targets into the project discovery root. */
  const writeBlock = async (yaml: string, name = 'compose-blk'): Promise<void> => {
    await mkdir(join(testDir, '.archon', 'workflows'), { recursive: true });
    await writeFile(join(testDir, '.archon', 'workflows', `${name}.yaml`), yaml);
  };

  const eventsOf = (store: ReturnType<typeof createMockStore>) =>
    (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>).mock.calls.map(
      call => ({
        event_type: call[0].event_type,
        step_name: call[0].step_name ?? '',
        data: call[0].data ?? {},
      })
    );

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-workflow-node-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it.each(['node_completed', 'node_failed'])(
    'refuses ambiguous historical child recovery before dispatch (%s)',
    async eventType => {
      await writeBlock(
        'name: child\ndescription: child\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: echo done',
        'child'
      );
      const store = createMockStore();
      const historical = {
        step_name: 'sub',
        event_type: eventType,
        data: {
          type: 'workflow',
          node_output: '["old output"]',
          cost_usd: 0.02,
          tokens: { input: 14, output: 6 },
          fan_out_outcome: fanOutOutcome([
            { index: 0, outcome: 'completed', child_run_id: 'a' },
            { index: 1, outcome: 'failed', child_run_id: 'b' },
          ]),
        },
      };
      const snapshot = await foldDagResumeSnapshot([historical], 'parent');
      store.getDagResumeSnapshot.mockResolvedValue(snapshot);
      store.findChildRuns.mockResolvedValue([
        makeWorkflowRun('b', {
          status: 'failed',
          metadata: {
            parent_node_id: 'sub',
            total_cost_usd: 0.02,
            total_tokens_in: 14,
            total_tokens_out: 6,
          },
        }),
      ]);
      const runChildWorkflow = mock<RunChildWorkflowFn>(async () => ({
        status: 'completed',
        childRunId: 'b',
        costUsd: 0.03,
        tokens: { input: 21, output: 9 },
      }));
      const options = dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun: makeWorkflowRun('parent'),
        workflow: {
          name: 'parent',
          nodes: [
            {
              id: 'sub',
              kind: 'workflow',
              workflow: 'child',
              fan_out: { items: '[1,2]', max_parallel: 2, join: 'all_success' },
            },
          ],
        },
        runChildWorkflow,
        priorCompletedNodes: new Map(),
        priorUsage: snapshot,
      });
      await executeDagWorkflow(options);
      expect(runChildWorkflow).not.toHaveBeenCalled();
      expect(store.findChildRuns).not.toHaveBeenCalled();
      expect(eventsOf(store)).toContainEqual({
        event_type: 'node_failed',
        step_name: 'sub',
        data: expect.objectContaining({
          failure_kind: 'config',
          error: expect.stringContaining('historical child usage'),
        }),
      });
      expect(runUsageWrites(store).at(-1)).toMatchObject({
        total_cost_usd: 0.02,
        total_tokens_in: 14,
        total_tokens_out: 6,
      });
      const folded = await foldDagResumeSnapshot([historical, ...persistedEvents(store)], 'parent');
      expect(folded.costUsd).toBeCloseTo(0.02);
      expect(folded.tokens).toEqual({ input: 14, output: 6 });
      expect(folded.reportedChildUsage?.size).toBe(0);
      expect(folded.unattributedChildUsagePaths).toEqual(new Set(['sub']));
      if (eventType === 'node_completed') {
        const replayStore = createMockStore();
        replayStore.getDagResumeSnapshot.mockResolvedValue(snapshot);
        await executeDagWorkflow({
          ...options,
          deps: createMockDeps(replayStore),
          priorCompletedNodes: snapshot.completedNodeOutputs,
        });
        expect(runChildWorkflow).not.toHaveBeenCalled();
        expect(replayStore.completeWorkflowRun).toHaveBeenCalledTimes(1);
        expect(replayStore.failWorkflowRun).not.toHaveBeenCalled();
        expect(runUsageWrites(replayStore).at(-1)).toMatchObject({
          total_cost_usd: 0.02,
          total_tokens_in: 14,
          total_tokens_out: 6,
        });
      }

      expect(snapshot.completedNodeOutputs.get('sub')?.output).toBe(
        eventType === 'node_completed' ? historical.data.node_output : undefined
      );
    }
  );

  it.each([
    { label: 'valid', malformed: false, counters: { total_tokens_out: 10 } },
    { label: 'invalid axis', malformed: true, counters: { total_tokens_out: 'unreadable' } },
  ])(
    'counts persisted child usage once across parent replay ($label)',
    async ({ malformed, counters }) => {
      await writeBlock(
        'name: child-workflow\ndescription: child\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo done"',
        'child-workflow'
      );
      const store = createMockStore();
      store.findChildRuns.mockResolvedValue([
        makeWorkflowRun('settled-child', {
          status: 'completed',
          metadata: {
            parent_node_id: 'sub',
            summary: 'child output',
            total_tokens_in: 100,
            ...counters,
            total_cost_usd: 0.3,
          },
        }),
      ]);
      const runChildWorkflow = mock<RunChildWorkflowFn>(async () => {
        throw new Error('Settled child must not be run again');
      });
      const workflowRun = makeWorkflowRun('parent-reentry');
      const options = dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun,
        workflow: {
          name: 'parent',
          nodes: [{ id: 'sub', kind: 'workflow', workflow: 'child-workflow' }],
        },
        runChildWorkflow,
      });
      await executeDagWorkflow(options);
      const snapshot = await foldDagResumeSnapshot(persistedEvents(store), workflowRun.id);
      expect(snapshot.tokensUnknown).toBe(malformed);
      expect(snapshot.tokens).toEqual(malformed ? undefined : { input: 100, output: 10 });
      expect(snapshot.costUsd).toBe(0.3);
      await executeDagWorkflow({
        ...options,
        priorCompletedNodes: snapshot.completedNodeOutputs,
        priorUsage: snapshot,
      });
      expect(runChildWorkflow).not.toHaveBeenCalled();
      const writes = runUsageWrites(store);
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
      expect(writes[1]?.total_cost_usd).toBe(0.3);
      expect(writes[1]?.total_tokens_in).toBe(malformed ? null : 100);
      expect(writes[1]?.total_tokens_out).toBe(malformed ? null : 10);
      expect(writes[1]?.total_tokens_unknown).toBe(malformed ? true : undefined);
      expect(store.completeWorkflowRun).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['pending', 'running', 'paused'] as const)(
    'waits on supported live child status %s on re-entry',
    async status => {
      await writeBlock(
        'name: child-workflow\ndescription: child\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo done"',
        'child-workflow'
      );
      const store = createMockStore();
      store.getWorkflowRunStatus.mockImplementation(async () =>
        store.pauseWorkflowRun.mock.calls.length > 0 ? 'paused' : 'running'
      );
      store.findChildRuns.mockResolvedValue([
        makeWorkflowRun('live-child', { status, metadata: { parent_node_id: 'sub' } }),
      ]);
      const runChildWorkflow = mock<RunChildWorkflowFn>(async () => {
        throw new Error('Live child must not be dispatched');
      });

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflowRun: makeWorkflowRun('live-child-reentry'),
          workflow: {
            name: 'parent',
            nodes: [{ id: 'sub', kind: 'workflow', workflow: 'child-workflow' }],
          },
          runChildWorkflow,
        })
      );

      expect(runChildWorkflow).not.toHaveBeenCalled();
      expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(eventsOf(store).some(event => event.event_type === 'node_failed')).toBe(false);
    }
  );

  it.each(['unsupported', ''])(
    'rejects unsupported persisted child status %j on re-entry',
    async status => {
      await writeBlock(
        'name: child-workflow\ndescription: child\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo done"',
        'child-workflow'
      );
      const store = createMockStore();
      const child = makeWorkflowRun('invalid-child', {
        metadata: { parent_node_id: 'sub' },
      });
      Object.defineProperty(child, 'status', { value: status });
      store.findChildRuns.mockResolvedValue([child]);
      const runChildWorkflow = mock<RunChildWorkflowFn>(async () => {
        throw new Error('Invalid child must not be dispatched');
      });

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflowRun: makeWorkflowRun('invalid-child-reentry'),
          workflow: {
            name: 'parent',
            nodes: [{ id: 'sub', kind: 'workflow', workflow: 'child-workflow' }],
          },
          runChildWorkflow,
        })
      );

      expect(runChildWorkflow).not.toHaveBeenCalled();
      expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(eventsOf(store)).toContainEqual({
        event_type: 'node_failed',
        step_name: 'sub',
        data: expect.objectContaining({
          failure_kind: 'unknown',
          error: `Sub-run 'child-workflow' returned unexpected status '${status}'`,
        }),
      });
    }
  );

  it('retains cancelled child uncertainty alongside valid sibling usage on re-entry', async () => {
    await writeBlock(
      'name: child-workflow\ndescription: child\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo done"',
      'child-workflow'
    );
    const store = createMockStore();
    store.findChildRuns.mockResolvedValue([
      makeWorkflowRun('valid-child', {
        status: 'completed',
        metadata: {
          parent_node_id: 'sibling',
          summary: 'done',
          total_tokens_in: 20,
          total_tokens_out: 2,
          total_cost_usd: 0.2,
        },
      }),
      makeWorkflowRun('cancelled-child', {
        status: 'cancelled',
        metadata: {
          parent_node_id: 'sub',
          total_tokens_in: 100,
          total_tokens_out: 'unreadable',
          total_cost_usd: 0.3,
        },
      }),
    ]);
    const runChildWorkflow = mock<RunChildWorkflowFn>(async () => {
      throw new Error('Settled child must not be run again');
    });
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun: makeWorkflowRun('cancelled-child-reentry'),
        workflow: {
          name: 'parent',
          nodes: [
            { id: 'sibling', kind: 'workflow', workflow: 'child-workflow' },
            { id: 'sub', kind: 'workflow', workflow: 'child-workflow', depends_on: ['sibling'] },
          ],
        },
        runChildWorkflow,
      })
    );
    expect(runChildWorkflow).not.toHaveBeenCalled();
    expect(eventsOf(store)).toContainEqual({
      event_type: 'node_completed',
      step_name: 'sibling',
      data: expect.objectContaining({ tokens: { input: 20, output: 2 }, cost_usd: 0.2 }),
    });
    expect(eventsOf(store)).toContainEqual({
      event_type: 'node_failed',
      step_name: 'sub',
      data: expect.objectContaining({ failure_kind: 'cancelled', cost_usd: 0.3 }),
    });
    expect(runUsageWrites(store)).toEqual([
      expect.objectContaining({
        total_tokens_unknown: true,
        total_tokens_in: null,
        total_tokens_out: null,
        total_cost_usd: 0.5,
      }),
    ]);
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it.each(['node', 'terminal'] as const)(
    'mixed child fan-out rejections preserve the %s write failure',
    async kind => {
      await writeBlock(
        'name: child-workflow\ndescription: child\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo done"',
        'child-workflow'
      );
      const store = createMockStore();
      const ordinary = new Error('source read failed');
      const cause = new Error('write rejected');
      const primary =
        kind === 'terminal'
          ? new TerminalStatusWriteError(cause)
          : new NodeEventWriteError(
              {
                workflow_run_id: 'child',
                event_type: 'node_completed',
                step_name: 'work',
                data: {},
              },
              cause
            );
      let siblingSettled = false;
      mockLogFn.mockClear();
      const runChildWorkflow = mock<RunChildWorkflowFn>(async args => {
        if (args.childIndex === 0) throw ordinary;
        await new Promise(resolve => setTimeout(resolve, args.childIndex === 1 ? 5 : 10));
        if (args.childIndex === 1) throw primary;
        siblingSettled = true;
        return { childRunId: 'completed-sibling', status: 'completed', output: 'done' };
      });
      const pending = executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          runChildWorkflow,
          workflow: {
            name: 'mixed-child',
            nodes: [
              {
                id: 'fan',
                kind: 'workflow',
                workflow: 'child-workflow',
                fan_out: { items: '["a","b","c"]', max_parallel: 3, join: 'all_done' },
              },
            ],
          },
          workflowRun: makeWorkflowRun('mixed-child'),
        })
      );
      await expect(pending).rejects.toBe(primary);
      expect(runChildWorkflow).toHaveBeenCalledTimes(3);
      expect(siblingSettled).toBe(true);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(mockLogFn).toHaveBeenCalledWith(
        { err: ordinary, workflowRunId: 'mixed-child' },
        'dag.join_secondary_failure'
      );
    }
  );

  it('propagates child-result persistence rejection through workflow outcome handling', async () => {
    await writeBlock(
      'name: child-workflow\ndescription: child\nnodes:\n  - id: work\n    bash: "echo done"',
      'child-workflow'
    );
    const store = createMockStore();
    store.persistWorkflowEvent = mock(async event => {
      if (event.event_type === 'node_completed' && event.step_name === 'child') {
        throw new Error('child result storage rejected');
      }
      await store.createWorkflowEvent(event);
    });
    const runChildWorkflow = mock<RunChildWorkflowFn>(async () => ({
      childRunId: 'completed-child',
      status: 'completed',
      output: 'done',
    }));
    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          runChildWorkflow,
          workflow: {
            name: 'child-result-write',
            nodes: [{ id: 'child', kind: 'workflow', workflow: 'child-workflow' }],
          },
          workflowRun: makeWorkflowRun('child-result-write'),
        })
      )
    ).rejects.toThrow('Could not persist node_completed for child: child result storage rejected');
    expect(eventsOf(store).some(event => event.event_type === 'node_failed')).toBe(false);
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('executeWorkflowNode writes node_error to transcript on failure', async () => {
    const store = createMockStore();
    const logDir = join(testDir, 'sub-fail-logs');
    const workflowRun = makeWorkflowRun('sub-fail-run');

    const failingChildNode: DagNode = {
      id: 'failing-sub',
      kind: 'workflow',
      workflow: 'bad-child',
    };

    const runChildWorkflow = mock(async () => ({
      status: 'failed' as const,
      output: '',
      error: 'child failed deliberately',
      childRunId: 'subrun-fail',
    }));

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun,
        logDir,
        runChildWorkflow,
        workflow: {
          name: 'failing-sub-workflow',
          nodes: [failingChildNode],
        },
      })
    );

    const rows = await readTranscript(logDir, workflowRun.id);
    const errorRow = rows.find(r => r.type === 'node_error' && r.step === 'failing-sub');
    expect(errorRow).toBeDefined();
    expect(errorRow?.error).toBe('child failed deliberately');
  });
});
