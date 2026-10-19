// @archon-test-isolated
import { RunSourceReleaseError } from '../../../run-source';
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

  it.each([1, 4])(
    'uncertain children hold their fan-out slots and survive sibling errors (parallel: %s)',
    async parallel => {
      await writeBlock(
        'name: child-workflow\ndescription: child\nnodes:\n  - id: work\n    bash: "echo done"',
        'child-workflow'
      );
      const store = createMockStore();
      const pause = store.pauseWorkflowRun.getMockImplementation();
      store.pauseWorkflowRun.mockImplementation(async (...args) => {
        await pause?.(...args);
        store.getWorkflowRunStatus.mockResolvedValue('paused');
      });
      const first = new RunSourceReleaseError(new Error('release unavailable'), 'child-1');
      const second = new RunSourceReleaseError(new Error('lookup unavailable'), 'child-2');
      const ordinary = new Error('sibling launch failed');
      const runChildWorkflow = mock<RunChildWorkflowFn>(async args => {
        if (parallel === 1) throw first;
        if (args.childIndex === 0) throw ordinary;
        if (args.childIndex === 1) throw first;
        if (args.childIndex === 2) throw second;
        return { childRunId: 'child-3', status: 'paused' };
      });
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          runChildWorkflow,
          workflowRun: makeWorkflowRun('uncertain-parent'),
          workflow: {
            name: 'uncertain-parent',
            nodes: [
              {
                id: 'fan',
                kind: 'workflow',
                workflow: 'child-workflow',
                fan_out: { items: '["a","b","c","d"]', max_parallel: parallel, join: 'all_done' },
              },
            ],
          },
        })
      );
      expect(runChildWorkflow).toHaveBeenCalledTimes(parallel);
      expect(store.pauseWorkflowRun).toHaveBeenCalledWith(
        'uncertain-parent',
        expect.objectContaining({
          type: 'fan_out',
          childRunIds: parallel === 1 ? ['child-1'] : ['child-1', 'child-2', 'child-3'],
          unspawnedItems: parallel === 1 ? 3 : 1,
        }),
        undefined,
        expect.anything()
      );
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(eventsOf(store).some(event => event.event_type === 'node_failed')).toBe(false);
      expect(mockLogFn).toHaveBeenCalledWith(
        expect.objectContaining({ err: first }),
        'workflow.child_source_release_uncertain'
      );
    }
  );

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
