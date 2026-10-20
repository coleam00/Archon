// @archon-test-isolated
import { ChildWorkflowStatusReadError } from '../../child-run';
import { WorkflowRunPauseConflictError } from '../../../store';
import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { WorkflowStatusReadError } from '../../../workflow-status-read';
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
  createMockPlatform,
  persistedEvents,
  runUsageWrites,
  readTranscript,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
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

  it.each(['node', 'terminal', 'status'] as const)(
    'mixed child fan-out rejections preserve the %s failure',
    async kind => {
      await writeBlock(
        'name: child-workflow\ndescription: child\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo done"',
        'child-workflow'
      );
      const store = createMockStore();
      const ordinary = new Error('source read failed');
      const cause = new Error('write rejected');
      const primary =
        kind === 'status'
          ? new WorkflowStatusReadError('child', cause)
          : kind === 'terminal'
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

  it.each(
    (['initial', 'refresh', 'join', 'replay'] as const).flatMap(phase =>
      [false, true].map(tokensUnknown => [phase, tokensUnknown] as const)
    )
  )(
    'propagates unreadable fan-out child rows at %s without a failure notice or event (tokens unknown: %s)',
    async (phase, tokensUnknown) => {
      await writeBlock(
        'name: child-workflow\ndescription: child\nnodes:\n  - id: work\n    prompt: Work',
        'child-workflow'
      );
      const store = createMockStore();
      const cause = new Error('Unsupported child status');
      store.getDagResumeSnapshot.mockImplementation(async id =>
        foldDagResumeSnapshot(persistedEvents(store), id)
      );
      let reads = 0;
      store.findChildRuns.mockImplementation(async () => {
        if (++reads === (phase === 'refresh' || phase === 'join' ? 2 : 1))
          throw new WorkflowStatusReadError('corrupt', cause);
        return [];
      });
      const platform = createMockPlatform();
      const runChildWorkflow = mock<RunChildWorkflowFn>(async () =>
        phase === 'refresh'
          ? {
              childRunId: 'held',
              status: 'paused',
              costUsd: 0.37,
              ...(tokensUnknown ? { tokensUnknown: true } : { tokens: { input: 100, output: 50 } }),
            }
          : {
              childRunId: 'settled',
              status: 'completed',
              output: 'done',
              costUsd: 0.37,
              ...(tokensUnknown ? { tokensUnknown: true } : { tokens: { input: 100, output: 50 } }),
            }
      );
      await expect(
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            platform,
            cwd: testDir,
            workflowRun: makeWorkflowRun('fan-read'),
            runChildWorkflow,
            workflow: {
              name: 'fan-read',
              nodes: [
                {
                  id: 'fan',
                  kind: 'workflow',
                  workflow: 'child-workflow',
                  fan_out: { items: '[1,2]', max_parallel: 1, join: 'all_done' },
                },
              ],
            },
            ...(phase === 'replay'
              ? {
                  priorCompletedNodes: new Map([
                    ['fan', { output: '[1,2]', structuredOutput: [1, 2] }],
                  ]),
                }
              : {}),
          })
        )
      ).rejects.toMatchObject({ name: 'WorkflowStatusReadError', cause });
      expect(reads).toBe(phase === 'refresh' || phase === 'join' ? 2 : 1);
      expect(persistedEvents(store).some(e => e.event_type === 'node_failed')).toBe(false);
      expect(platform.sendMessage.mock.calls.some(([, message]) => /failed/i.test(message))).toBe(
        false
      );
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.cancelWorkflowRun).not.toHaveBeenCalled();
      expect(store.cancelFanOutRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      if (phase === 'refresh' || phase === 'join') {
        const children = phase === 'join' ? 2 : 1;
        expect(runUsageWrites(store).at(-1)).toMatchObject({
          total_cost_usd: 0.37 * children,
          total_tokens_in: tokensUnknown ? null : 100 * children,
          total_tokens_out: tokensUnknown ? null : 50 * children,
          ...(tokensUnknown ? { total_tokens_unknown: true } : {}),
        });
      }
    }
  );

  it.each([false, true])('settles recovered child usage once (fan-out: %s)', async fanOut => {
    await writeBlock(
      'name: child-workflow\ndescription: child\nmutates_checkout: false\nnodes:\n  - id: work\n    prompt: Work',
      'child-workflow'
    );
    const store = createMockStore();
    store.getDagResumeSnapshot.mockImplementation(async id =>
      foldDagResumeSnapshot(persistedEvents(store), id)
    );
    const usage = { costUsd: 0.37, tokens: { input: 100, output: 50 } };
    const failure = new ChildWorkflowStatusReadError(
      new WorkflowStatusReadError('paid', new Error('Unsupported status')),
      usage
    );
    let recovering = false;
    const runChildWorkflow = mock<RunChildWorkflowFn>(async () => {
      if (!recovering) throw failure;
      return { childRunId: 'paid', status: 'completed', output: 'done', ...usage };
    });
    const workflow = {
      name: 'recovery',
      nodes: [
        {
          id: 'child',
          kind: 'workflow' as const,
          workflow: 'child-workflow',
          ...(fanOut
            ? { fan_out: { items: '[1]', max_parallel: 1, join: 'all_done' as const } }
            : {}),
        },
      ],
    };
    const options = dagOptions({
      deps: createMockDeps(store),
      cwd: testDir,
      workflow,
      workflowRun: makeWorkflowRun('recovery'),
      runChildWorkflow,
    });
    await expect(executeDagWorkflow(options)).rejects.toBe(failure);
    const prior = await store.getDagResumeSnapshot('recovery');
    expect(prior.costUsd).toBeCloseTo(0.37);
    recovering = true;
    await executeDagWorkflow({
      ...options,
      priorCompletedNodes: prior.completedNodeOutputs,
      priorUsage: prior,
    });
    const settled = await store.getDagResumeSnapshot('recovery');
    expect(settled.costUsd).toBeCloseTo(0.37);
    expect(settled.tokens).toEqual(usage.tokens);
    expect(runUsageWrites(store).at(-1)).toMatchObject({
      total_cost_usd: 0.37,
      total_tokens_in: 100,
      total_tokens_out: 50,
    });
  });

  it.each([false, true])(
    "retains a paused child's usage when parent reconciliation fails (tokens unavailable: %s)",
    async tokensUnknown => {
      const store = createMockStore();
      const cause = new Error('Unsupported parent status');
      const failure = new WorkflowStatusReadError('paused-parent', cause);
      store.getDagResumeSnapshot.mockImplementation(async id =>
        foldDagResumeSnapshot(persistedEvents(store), id)
      );
      let reconciling = false;
      store.pauseWorkflowRun.mockImplementation(async () => {
        reconciling = true;
        throw new WorkflowRunPauseConflictError('paused-parent');
      });
      store.getWorkflowRun.mockImplementation(async () => {
        throw failure;
      });
      store.getWorkflowRunStatus.mockResolvedValue('paused');
      const usage = {
        costUsd: 0.37,
        ...(tokensUnknown ? { tokensUnknown: true } : { tokens: { input: 100, output: 50 } }),
      };
      const workflow = {
        name: 'paused-parent',
        nodes: [{ id: 'child', kind: 'workflow' as const, workflow: 'child-workflow' }],
      };
      store.getWorkflowRunStatus.mockImplementation(async () =>
        reconciling ? 'paused' : 'running'
      );
      await expect(
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: testDir,
            workflow,
            workflowRun: makeWorkflowRun('paused-parent'),
            runChildWorkflow: mock(async () => ({
              childRunId: 'paid',
              status: 'paused' as const,
              ...usage,
            })),
          })
        )
      ).rejects.toBe(failure);
      expect(runUsageWrites(store).at(-1)).toMatchObject({
        total_cost_usd: 0.37,
        total_tokens_in: tokensUnknown ? null : 100,
        total_tokens_out: tokensUnknown ? null : 50,
      });
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      const snapshot = await store.getDagResumeSnapshot('paused-parent');
      store.getWorkflowRunStatus.mockResolvedValue('running');
      store.getWorkflowRun.mockResolvedValue(makeWorkflowRun('paused-parent'));
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow,
          workflowRun: makeWorkflowRun('paused-parent'),
          priorCompletedNodes: snapshot.completedNodeOutputs,
          runChildWorkflow: mock(async () => ({
            childRunId: 'paid',
            status: 'completed' as const,
            output: 'done',
            ...usage,
          })),
        })
      );
      const settled = await store.getDagResumeSnapshot('paused-parent');
      expect(settled.costUsd).toBeCloseTo(0.37);
      expect(settled.tokensUnknown).toBe(tokensUnknown);
      expect(settled.tokens).toEqual(tokensUnknown ? undefined : { input: 100, output: 50 });
      expect(runUsageWrites(store).at(-1)).toMatchObject({
        total_cost_usd: 0.37,
        total_tokens_in: tokensUnknown ? null : 100,
        total_tokens_out: tokensUnknown ? null : 50,
      });
    }
  );

  it('propagates unreadable child rows without failing the workflow node', async () => {
    const store = createMockStore();
    const cause = new Error('Unsupported child status');
    store.findChildRuns.mockRejectedValue(new WorkflowStatusReadError('corrupt', cause));
    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: {
            name: 'child-lookup',
            nodes: [{ id: 'child', kind: 'workflow', workflow: 'child-workflow' }],
          },
          workflowRun: makeWorkflowRun('child-lookup'),
          runChildWorkflow: mock(async () => {
            throw new Error('must not launch');
          }),
        })
      )
    ).rejects.toMatchObject({ name: 'WorkflowStatusReadError', cause });
    expect(eventsOf(store).some(event => event.event_type === 'node_failed')).toBe(false);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

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
