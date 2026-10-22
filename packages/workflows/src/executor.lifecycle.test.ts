// @archon-test-isolated
import {
  dagCall,
  makeDeps,
  makeRun,
  makeStore,
  makeWorkflow,
  mockCaptureWorkflowTerminal,
  mockEmitter,
  mockExecuteDagWorkflow,
  mockLogger,
  resetExecutorMocks,
  resumeOf,
  startWorkflow,
  WS,
} from './executor/test-utils';
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { getRunArtifactsDirForRoot, getRunScratchDir } from '@archon/paths/archon-paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { ParentStatusReadError } from './parent-status-read';
import { NodeEventWriteError } from './node-event-write';
import * as resume from './run-resume';
import * as source from './run-source';
import { liveSourceRoots } from './workflow-source';
import { hydrateResumableRun } from './run-resume';
import { noExecutorCanWrite } from './run-scratch';
import type { ContainerPauseReceipt } from './dag/pause';
import type { WorkflowRunNodeSession } from './schemas';
import type { DagResumeSnapshot, IWorkflowStore } from './store';
import {
  workflowRunStatusSchema,
  EXECUTION_OWNER_METADATA_KEY,
  TERMINAL_WORKFLOW_STATUSES,
} from './schemas/workflow-run';
import { WorkflowExecutionHandoffError } from './engine-port';
import { TerminalStatusWriteError } from './terminal-status-write';
import { keepAwake } from './utils/keep-awake';

/** How executeWorkflow drives the DAG and records how the run ended. */

beforeEach(resetExecutorMocks);

it.each([false, true])('persists loaded graph before DAG execution (resume=%s)', async resume => {
  const store = makeStore();
  const workflow = makeWorkflow({ returns: 'node1' });
  mockExecuteDagWorkflow.mockImplementationOnce(async () => {
    expect(store.updateWorkflowRun).toHaveBeenCalledWith(expect.any(String), {
      metadata: {
        terminal_graph: { node_ids: workflow.nodes.map(node => node.id), returns: 'node1' },
      },
    });
    return undefined;
  });
  await startWorkflow({ store, workflow, options: resume ? resumeOf(makeRun()) : {} });
  expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
});

// Safe to spy on the real singleton: off-Windows its native fn is undefined, so
// acquire/release only touch the refcount.
describe('keep-awake pairing', () => {
  it.each([
    ['a successful run', undefined],
    ['a DAG that throws an unhandled error', new Error('DAG exploded')],
  ])('acquires and releases keep-awake exactly once for %s', async (_label, dagError) => {
    if (dagError) mockExecuteDagWorkflow.mockRejectedValueOnce(dagError);
    const acquireSpy = spyOn(keepAwake, 'acquire');
    const releaseSpy = spyOn(keepAwake, 'release');
    try {
      const result = await startWorkflow();
      expect(result.success).toBe(dagError === undefined);
      expect(result.workflowRunId).toBe('run-123');
      expect(acquireSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(keepAwake.activeCount()).toBe(0);
    } finally {
      acquireSpy.mockRestore();
      releaseSpy.mockRestore();
    }
  });
});

describe('resume', () => {
  it('does not look for a resumable run on its own', async () => {
    // Resume detection lives at the caller, so two back-to-back executions of the same
    // workflow at the same cwd cannot cross-leak.
    const findSpy = mock(async () => makeRun({ id: 'stale-prior', status: 'failed' }));
    const store = makeStore({ findResumableRun: findSpy });
    await startWorkflow({ store });
    expect(findSpy).not.toHaveBeenCalled();
    expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
    expect(store.createWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('runs the DAG with the prior completed nodes the caller supplies', async () => {
    const options = resumeOf(makeRun({ id: 'resumed-run' }), [
      ['node-a', { output: 'a-output' }],
      ['node-b', { output: 'b-output' }],
    ]);
    const store = makeStore();
    await startWorkflow({ store, options });
    expect(dagCall()?.priorCompletedNodes).toBe(options.priorCompletedNodes);
    expect(store.createWorkflowRun).not.toHaveBeenCalled();
  });

  it('rejects prior node sessions owned by a different workflow run at ingress', async () => {
    const foreignSession: WorkflowRunNodeSession = {
      workflow_run_id: 'run-b',
      node_id: 'source',
      provider: 'claude',
      provider_session_id: 'private-session',
      created_at: '2026-08-19T00:00:00Z',
      updated_at: '2026-08-19T00:00:00Z',
    };
    const store = makeStore();
    const deps = makeDeps(store);
    await expect(
      startWorkflow({
        deps,
        options: {
          ...resumeOf(makeRun({ id: 'run-a' }), [['source', { output: 'prior output' }]]),
          priorNodeSessions: [foreignSession],
        },
      })
    ).rejects.toThrow("Cannot resume workflow run 'run-a' with session state from run 'run-b'");
    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    expect(store.createWorkflowRun).not.toHaveBeenCalled();
  });

  it('forwards a hydrated resume snapshot into resumed DAG execution', async () => {
    const completedNodeOutputs = new Map([['node-a', { output: 'first output' }]]);
    const snapshot: DagResumeSnapshot = {
      completedNodeOutputs,
      fanOutSnapshots: new Map(),
      failedNodes: new Map(),
      unresolvedNodeStarts: new Set<string>(),
      budget: { workUnits: 0, spendUsd: 0 },
      tokens: { input: 40, output: 4 },
      costUsd: 0.25,
    };
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => snapshot),
      listWorkflowRunNodeSessions: mock(async () => [
        {
          workflow_run_id: 'failed-run',
          node_id: 'node-a',
          provider: 'claude',
          provider_session_id: 'source-session',
          created_at: '2026-08-19T00:00:00Z',
          updated_at: '2026-08-19T00:00:00Z',
        },
      ]),
      resumeWorkflowRun: mock(async () => makeRun({ id: 'failed-run' })),
    });
    const deps = makeDeps(store);
    const hydrated = await hydrateResumableRun(
      deps,
      makeRun({ id: 'failed-run', status: 'failed' })
    );
    if (!hydrated) throw new Error('Expected resumable workflow to hydrate');

    await startWorkflow({ deps, options: hydrated });

    expect(dagCall()?.priorCompletedNodes).toBe(completedNodeOutputs);
    expect(dagCall()?.priorUsage).toBe(snapshot);
    expect(dagCall()?.priorNodeSessions).toEqual(hydrated.priorNodeSessions);
    expect(store.createWorkflowRun).not.toHaveBeenCalled();
  });
});

it.each(['This is the workflow summary', undefined])(
  'returns the DAG summary %p as the run summary',
  async summary => {
    mockExecuteDagWorkflow.mockResolvedValueOnce(summary);
    const result = await startWorkflow();
    if (!result.success || 'paused' in result || 'handedOff' in result)
      throw new Error('Expected completed result');
    expect(result.summary).toBe(summary);
  }
);

describe('paused exit', () => {
  const pausedAt = (approval: Record<string, unknown>) =>
    makeRun({ status: 'paused', metadata: { approval } });
  const run = (store: IWorkflowStore) => startWorkflow({ store });

  const receipt: ContainerPauseReceipt = {
    kind: 'container_pause',
    pause: {
      kind: 'gate',
      context: { type: 'approval', nodeId: 'review', message: '', pauseId: 'old-pause' },
    },
  };

  it.each([...workflowRunStatusSchema.options, null])(
    'does not finalize a successor that is %s after a container pause',
    async status => {
      mockExecuteDagWorkflow.mockResolvedValueOnce(receipt);
      const releasePausedRunSlot = mock<IWorkflowStore['releasePausedRunSlot']>(async () => ({
        released: true,
      }));
      const store = makeStore({
        getWorkflowRun: mock(async () =>
          status === null
            ? null
            : makeRun({
                status,
                metadata: {
                  approval: {
                    type: 'approval',
                    nodeId: 'review',
                    message: '',
                    pauseId: 'successor-pause',
                  },
                },
              })
        ),
        getWorkflowRunStatus: mock(async () => status),
        releasePausedRunSlot,
      });
      const result = await run(store);
      expect(result).toMatchObject({
        success: status !== 'failed' && status !== 'cancelled',
        handedOff: true,
        observedStatus: status,
      });
      expect(result).not.toHaveProperty('paused');
      expect(result).not.toHaveProperty('waitCursor');
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(releasePausedRunSlot).not.toHaveBeenCalled();
      expect(store.getWorkflowRunStatus).not.toHaveBeenCalled();
    }
  );

  it('does not release the same wait occurrence under a successor claim', async () => {
    const context = {
      kind: 'time' as const,
      owner: 'node' as const,
      nodeId: 'delay',
      pauseId: 'same-wait',
      waitingSince: '2026-01-01T00:00:00.000Z',
      resumeAt: '2099-01-02T00:00:00.000Z',
    };
    mockExecuteDagWorkflow.mockResolvedValueOnce({
      kind: 'container_pause',
      pause: { kind: 'wait', context },
    });
    const store = makeStore({
      getWorkflowRun: mock(async () =>
        makeRun({ status: 'paused', metadata: { wait: context, execution_claim: 'successor' } })
      ),
    });
    const result = await run(store);
    expect(result).toMatchObject({ success: true, handedOff: true, observedStatus: 'paused' });
    expect(result).not.toHaveProperty('waitCursor');
    expect(store.releasePausedRunSlot).not.toHaveBeenCalled();
  });

  it('finalizes only the same container pause occurrence', async () => {
    mockExecuteDagWorkflow.mockResolvedValueOnce(receipt);
    const store = makeStore({ getWorkflowRun: mock(async () => pausedAt(receipt.pause.context)) });
    expect(await run(store)).toMatchObject({ success: true, paused: true });
    expect(store.releasePausedRunSlot).toHaveBeenCalledWith('run-123', {
      kind: 'pause',
      nodeId: 'review',
      pauseId: 'old-pause',
    });
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });

  it.each(['read', 'post-publication'] as const)(
    'surfaces a %s error after publication without failing the successor',
    async kind => {
      const error = new Error('required write/read failed');
      if (kind === 'post-publication') {
        mockExecuteDagWorkflow.mockRejectedValueOnce(
          new WorkflowExecutionHandoffError('run-123', error)
        );
      } else {
        mockExecuteDagWorkflow.mockResolvedValueOnce(receipt);
      }
      const store = makeStore({
        getWorkflowRun: mock(async () => {
          throw error;
        }),
        getWorkflowRunStatus: mock(async () => 'running' as const),
      });
      await expect(run(store)).rejects.toMatchObject({
        name: WorkflowExecutionHandoffError.name,
        workflowRunId: 'run-123',
        cause: error,
      });
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.getWorkflowRunStatus).not.toHaveBeenCalled();
    }
  );

  for (const kind of ['approval', 'deadline'] as const) {
    it(`gives back the resource slot of a pause the host continues (${kind})`, async () => {
      const paused =
        kind === 'approval'
          ? pausedAt({ type: 'approval', nodeId: 'review', message: '', pauseId: 'p1' })
          : makeRun({
              status: 'paused',
              metadata: {
                wait: {
                  owner: 'node',
                  nodeId: 'review',
                  kind: 'time',
                  pauseId: 'p1',
                  waitingSince: '2026-01-01T00:00:00.000Z',
                  resumeAt: '2026-01-02T00:00:00.000Z',
                },
              },
            });
      const releasePausedRunSlot = mock<IWorkflowStore['releasePausedRunSlot']>(async () => ({
        released: true,
      }));
      const result = await run(
        makeStore({ getWorkflowRun: mock(async () => paused), releasePausedRunSlot })
      );
      expect(result).toMatchObject({ success: true, paused: true });
      expect(releasePausedRunSlot.mock.calls).toEqual([
        [
          paused.id,
          {
            nodeId: 'review',
            pauseId: 'p1',
            ...(kind === 'deadline'
              ? { kind: 'wait', resumeAt: '2026-01-02T00:00:00.000Z' }
              : { kind: 'pause' }),
          },
        ],
      ]);
    });
  }

  for (const owner of ['node', 'loop_group'] as const) {
    for (const kind of ['time', 'event'] as const) {
      it(`returns the ${owner} ${kind} cursor captured before releasing the slot`, async () => {
        const wait = {
          owner,
          kind,
          nodeId: 'checks',
          ...(owner === 'loop_group'
            ? { bodyWaitId: 'body-wait', iteration: 2, sessionId: null, sessionProvider: null }
            : {}),
          ...(kind === 'event' ? { event: 'checks.complete' } : {}),
          pauseId: 'occurrence-a',
          waitingSince: '2026-01-01T00:00:00.000Z',
          resumeAt: '2026-01-02T00:00:00.000Z',
        };
        const paused = makeRun({ status: 'paused', metadata: { wait } });
        const result = await run(
          makeStore({
            getWorkflowRun: mock(async () => paused),
            releasePausedRunSlot: mock(async () => {
              paused.metadata = { ...paused.metadata, wait: { ...wait, pauseId: 'occurrence-b' } };
              return { released: true };
            }),
          })
        );
        expect(result).toMatchObject({
          success: true,
          paused: true,
          waitCursor: {
            kind: 'wait',
            nodeId: 'checks',
            pauseId: 'occurrence-a',
            resumeAt: '2026-01-02T00:00:00.000Z',
          },
        });
      });
    }
  }

  it('keeps the slot of a parent blocked on its child', async () => {
    const releasePausedRunSlot = mock<IWorkflowStore['releasePausedRunSlot']>(async () => ({
      released: true,
    }));
    const paused = pausedAt({
      type: 'child_workflow',
      nodeId: 'child',
      message: '',
      pauseId: 'p1',
      childRunId: 'child-run',
    });
    await run(makeStore({ getWorkflowRun: mock(async () => paused), releasePausedRunSlot }));
    expect(releasePausedRunSlot).not.toHaveBeenCalled();
  });

  it('still reports the pause when the release fails', async () => {
    const paused = pausedAt({ type: 'approval', nodeId: 'review', message: '', pauseId: 'p1' });
    const result = await run(
      makeStore({
        getWorkflowRun: mock(async () => paused),
        releasePausedRunSlot: mock(async () => {
          throw new Error('database unavailable');
        }),
      })
    );
    expect(result).toMatchObject({ success: true, paused: true });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workflowRunId: paused.id }),
      'workflow.paused_slot_release_failed'
    );
  });
});

// executeWorkflow records a run's terminal status from setup guards as well as from the DAG.
// These cover the distinct shapes: a setup guard that would otherwise RETURN an ordinary
// failure, one that would otherwise RETHROW its own error, and the two main-path writes whose
// interaction decides whether the finally backstop fires a second, masking write (#2910).
describe('terminal status writes in executor setup', () => {
  const pending = () => ({ preCreatedRun: makeRun({ id: 'pending-run', status: 'pending' }) });
  const metadataWriteFails = () =>
    mock(async () => {
      throw new Error('metadata write failed');
    });

  it('rejects instead of returning an ordinary failure when a setup guard cannot record it', async () => {
    // Without the marker this returned `{ success: false }` — a normal failed run, over a
    // row still saying pending/running.
    const store = makeStore({
      updateWorkflowRun: metadataWriteFails(),
      failWorkflowRun: mock(async () => {
        throw new Error('recovery write failed');
      }),
    });
    await expect(startWorkflow({ store, options: pending() })).rejects.toThrow(
      'Failed to persist terminal workflow status'
    );
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  it('still returns an ordinary failure when the setup guard CAN record it', async () => {
    const store = makeStore({ updateWorkflowRun: metadataWriteFails() });
    const result = await startWorkflow({ store, options: pending() });
    expect(result.success).toBe(false);
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('replaces a rethrown setup error with the marker when its record write fails', async () => {
    // The run-config guard rethrows its own error after recording it. A failed record has
    // to win: the caller must learn the status is unwritten, not just that config sealing
    // was unavailable. No `sealRunConfig` on the test deps, so the guard throws.
    const store = makeStore({
      failWorkflowRun: mock(async () => {
        throw new Error('recovery write failed');
      }),
    });
    await expect(
      startWorkflow({
        store,
        options: { ...pending(), runConfig: { layer: {}, source: { kind: 'cli', label: 'x' } } },
      })
    ).rejects.toThrow('Failed to persist terminal workflow status');
  });

  it('does not let the finally backstop mask a failed catch-path write, and still unregisters the run', async () => {
    // The catch's own failWorkflowRun fails. The backstop sees a row still at 'running'
    // and would fire a second write — masking the real error with "exited without
    // finalizing". The flag has to stop it.
    mockExecuteDagWorkflow.mockRejectedValueOnce(new Error('dag boom'));
    const failWorkflowRun = mock(async () => {
      throw new Error('terminal failure write failed');
    });
    const store = makeStore({
      failWorkflowRun,
      getWorkflowRunStatus: mock(async () => 'running' as const),
    });
    await expect(startWorkflow({ store })).rejects.toThrow('terminal failure write failed');
    expect(failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockEmitter.unregisterRun).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed backstop write instead of exiting cleanly', async () => {
    const store = makeStore({
      getWorkflowRunStatus: mock(async () => 'running' as const),
      failWorkflowRun: mock(async () => {
        throw new Error('backstop write failed');
      }),
    });
    await expect(startWorkflow({ store })).rejects.toThrow(
      'Failed to persist terminal workflow status'
    );
  });
});

describe('finally backstop', () => {
  it.each([false, true])(
    'preserves the execution result when the backstop status read fails (execution failed: %p)',
    async executionFailed => {
      const executionError = new Error('dag execution failed');
      if (executionFailed) mockExecuteDagWorkflow.mockRejectedValueOnce(executionError);
      else mockExecuteDagWorkflow.mockResolvedValueOnce(undefined);
      const readError = new Error('status store unavailable');
      const store = makeStore({
        getWorkflowRun: mock(async () => makeRun({ status: 'completed' })),
        getWorkflowRunStatus: mock(async () => {
          throw readError;
        }),
      });
      const originalWarn = mockLogger.warn;
      const warn = mock((_data?: { err: unknown }, _event?: string) => undefined);
      mockLogger.warn = warn;
      try {
        const result = await startWorkflow({ store });
        expect(result).toMatchObject({
          success: !executionFailed,
          workflowRunId: 'run-123',
          ...(executionFailed ? { error: executionError.message } : {}),
        });
        expect(warn).toHaveBeenCalledWith(
          {
            workflowRunId: 'run-123',
            operation: 'getWorkflowRunStatus',
            err: readError,
            recovery: expect.stringContaining('archon workflow get <run-id>'),
          },
          'executor.backstop_status_read_failed'
        );
        expect(warn.mock.calls[0]?.[0]?.err).toBe(readError);
        expect(store.failWorkflowRun).toHaveBeenCalledTimes(executionFailed ? 1 : 0);
        if (executionFailed) {
          expect(store.failWorkflowRun).toHaveBeenCalledWith('run-123', executionError.message, {
            exitReason: 'unhandled_error',
          });
        }
        expect(keepAwake.activeCount()).toBe(0);
      } finally {
        mockLogger.warn = originalWarn;
      }
    }
  );

  const backstopWrites = (failSpy: ReturnType<typeof mock>) =>
    (failSpy.mock.calls as unknown[][]).filter(
      c => typeof c[1] === 'string' && c[1].includes('exited without finalizing')
    );

  it('leaves finalization to the continued fan-out execution after its pause is resumed', async () => {
    const parent = makeRun({
      status: 'paused',
      working_path: '/project',
      metadata: {
        approval: {
          type: 'fan_out',
          nodeId: 'children',
          message: '',
          childRunIds: ['child'],
        },
      },
    });
    const resolve = spyOn(source, 'resolveContinuationWorkflow').mockResolvedValue({
      workflow: makeWorkflow(),
      roots: liveSourceRoots('/project'),
      workflows: [],
      errors: [],
    });
    const hydrate = spyOn(resume, 'hydrateResumableRun').mockResolvedValue({
      ...resumeOf(makeRun()),
      resumeCause: 'continue_after_wait',
      priorFailedNodes: new Map(),
      priorUsage: {},
      priorNodeSessions: [],
    });
    const store = makeStore({
      getWorkflowRun: mock(async () => parent),
      getWorkflowRunStatus: mock(async () => 'running' as const),
      findChildRuns: mock(async () => [makeRun({ id: 'child', status: 'completed' })]),
    });
    mockExecuteDagWorkflow.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      parent.metadata = {
        execution_claim: 'successor',
        approval: { type: 'approval', nodeId: 'review', message: '', pauseId: 'next' },
      };
      return {
        kind: 'container_pause',
        pause: {
          kind: 'gate',
          context: {
            type: 'approval',
            nodeId: 'review',
            message: '',
            pauseId: 'next',
          },
        },
      };
    });
    try {
      const result = await startWorkflow({ store });
      expect(result).toMatchObject({ success: true, handedOff: true });
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(2);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.getWorkflowRunStatus).not.toHaveBeenCalled();
    } finally {
      hydrate.mockRestore();
      resolve.mockRestore();
    }
  });

  it('source release exits without checking or failing a newly resumed owner', async () => {
    mockExecuteDagWorkflow.mockResolvedValueOnce({ kind: 'source_release', released: true });
    const store = makeStore({ getWorkflowRunStatus: mock(async () => 'running' as const) });
    const result = await startWorkflow({ store });
    expect(result).toMatchObject({ success: true, paused: true });
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.getWorkflowRunStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['running', 1],
    ['completed', 0],
  ] as const)('fails a run still %s when the executor exits %i time(s)', async (status, writes) => {
    const failSpy = mock(async () => ({ failed: true }));
    const store = makeStore({
      getWorkflowRunStatus: mock(async () => status),
      failWorkflowRun: failSpy,
    });
    await startWorkflow({ store });
    expect(backstopWrites(failSpy)).toHaveLength(writes);
  });
});

describe('scratch on exit', () => {
  const trackTempRoot = trackTempRoots();

  // A cooperative cancel commits while nodes still run; what they write after it is
  // removed once the executor has stopped them.
  it.each([
    ['completed', false, undefined, process.pid],
    ['failed', false, undefined, process.pid],
    ['cancelled', false, undefined, process.pid],
    ['paused', true, undefined, process.pid],
    // The layer's source release lost to that cancel, so the executor stopped executing.
    ['cancelled', false, false, process.pid],
    // Released, then resumed and cancelled by another executor whose nodes may still write.
    ['cancelled', true, true, process.ppid],
  ] as const)(
    'a run that exits %s keeps its scratch: %p (source released: %p)',
    async (status, kept, released, ownerPid) => {
      if (released !== undefined)
        mockExecuteDagWorkflow.mockResolvedValueOnce({ kind: 'source_release', released });
      // Under the test's mocked ARCHON_HOME, so the run's output_root is trusted.
      const root = trackTempRoot(join(WS, '_cwd', `exit-scratch-${crypto.randomUUID()}`));
      const run = makeRun({ status, output_root: root });
      // Admission stamps this process; a later executor restamps itself.
      run.metadata = {
        ...run.metadata,
        [EXECUTION_OWNER_METADATA_KEY]: { host: hostname(), pid: ownerPid },
      };
      const checkout = join(getRunScratchDir(getRunArtifactsDirForRoot(root, run.id)), 'repro');
      mkdirSync(join(checkout, '.git'), { recursive: true });
      const store = makeStore({
        getWorkflowRun: mock(async () => run),
        getWorkflowRunStatus: mock(async () => status),
      });

      await startWorkflow({ store });

      expect(existsSync(checkout)).toBe(kept);
    }
  );

  it('surfaces a status-read interruption without finalizing or deleting scratch', async () => {
    const root = trackTempRoot(join(WS, '_cwd', `unknown-parent-${crypto.randomUUID()}`));
    const run = makeRun({ output_root: root });
    run.metadata[EXECUTION_OWNER_METADATA_KEY] = { host: hostname(), pid: process.pid };
    const checkout = join(getRunScratchDir(getRunArtifactsDirForRoot(root, run.id)), 'repro');
    mkdirSync(join(checkout, '.git'), { recursive: true });
    const cause = new Error('Unsupported parent status');
    const interruption = new ParentStatusReadError(run.id, 'fan', cause);
    mockExecuteDagWorkflow.mockRejectedValueOnce(interruption);
    const store = makeStore({
      getWorkflowRun: mock(async () => run),
      getWorkflowRunStatus: mock<IWorkflowStore['getWorkflowRunStatus']>(async () => 'running'),
    });

    await expect(startWorkflow({ store })).rejects.toBe(interruption);
    expect(interruption.cause).toBe(cause);

    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    expect(store.getWorkflowRunStatus).not.toHaveBeenCalled();
    expect(existsSync(checkout)).toBe(true);
    expect(noExecutorCanWrite(run)).toBe(true);
    expect(keepAwake.activeCount()).toBe(0);
    expect(mockEmitter.unregisterRun).toHaveBeenCalledWith(run.id);
    expect(mockEmitter.emit.mock.calls.some(([event]) => event.type === 'workflow_failed')).toBe(
      false
    );
  });

  it.each([false, true])(
    'host can report before draining scratch cleanup (failed=%p)',
    async failed => {
      const root = trackTempRoot(join(WS, '_cwd', `deferred-scratch-${crypto.randomUUID()}`));
      const run = makeRun({
        status: failed ? 'failed' : 'completed',
        output_root: root,
        metadata: { [EXECUTION_OWNER_METADATA_KEY]: { host: hostname(), pid: process.pid } },
      });
      const scratch = getRunScratchDir(getRunArtifactsDirForRoot(root, run.id));
      mkdirSync(scratch, { recursive: true });
      if (failed) mockExecuteDagWorkflow.mockRejectedValueOnce(new Error('DAG failed'));
      const cleanups: (() => Promise<void>)[] = [];
      const result = await startWorkflow({
        store: makeStore({
          getWorkflowRun: mock(async () => run),
          getWorkflowRunStatus: mock(async () => run.status),
        }),
        options: { deferScratchCleanup: cleanup => cleanups.push(cleanup) },
      });
      expect(result.success).toBe(!failed);
      expect(cleanups).toHaveLength(1);
      expect(existsSync(scratch)).toBe(true);
      await Promise.all(cleanups.map(cleanup => cleanup()));
      expect(existsSync(scratch)).toBe(false);
    }
  );

  it.each([...TERMINAL_WORKFLOW_STATUSES])(
    "releases a %s run's scratch despite another run's lifecycle interruption",
    async status => {
      const root = trackTempRoot(join(WS, '_cwd', `terminal-child-${crypto.randomUUID()}`));
      const run = makeRun({
        status,
        output_root: root,
        metadata: { [EXECUTION_OWNER_METADATA_KEY]: { host: hostname(), pid: process.pid } },
      });
      const scratch = getRunScratchDir(getRunArtifactsDirForRoot(root, run.id));
      mkdirSync(scratch, { recursive: true });
      const interruption = new ParentStatusReadError('another-run', 'fan', new Error('unreadable'));
      mockExecuteDagWorkflow.mockRejectedValueOnce(interruption);
      const store = makeStore({ getWorkflowRun: mock(async () => run) });

      await expect(startWorkflow({ store })).rejects.toBe(interruption);

      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.getWorkflowRunStatus).not.toHaveBeenCalled();
      expect(existsSync(scratch)).toBe(false);
    }
  );

  // A parent resumed in its child's process publishes no owner endpoint; a release in
  // this process must still see it executing.
  it('holds its run as executing in this process until it exits', async () => {
    const run = makeRun({ status: 'cancelled' });
    run.metadata = {
      ...run.metadata,
      [EXECUTION_OWNER_METADATA_KEY]: { host: hostname(), pid: process.pid },
    };
    let duringExecution: boolean | undefined;
    mockExecuteDagWorkflow.mockImplementationOnce(async () => {
      duringExecution = noExecutorCanWrite(run);
      return undefined;
    });

    await startWorkflow({ store: makeStore({ getWorkflowRun: mock(async () => run) }) });

    expect(duringExecution).toBe(false);
    expect(noExecutorCanWrite(run)).toBe(true);
  });
});

// Terminal telemetry is reported by the run store when a terminal write commits; the
// executor records the exit reason on that write and reports only a run that never got a row.
describe('terminal failure writes', () => {
  it('records unhandled_error on the terminal write when executeDagWorkflow throws', async () => {
    mockExecuteDagWorkflow.mockRejectedValueOnce(new Error('dag boom'));
    const store = makeStore();
    await startWorkflow({ store });
    expect(mockCaptureWorkflowTerminal).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.failWorkflowRun).toHaveBeenCalledWith(expect.any(String), 'dag boom', {
      exitReason: 'unhandled_error',
    });
    expect(store.createWorkflowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'workflow_failed' })
    );
  });

  it.each([true, false])(
    'publishes the unhandled failure live only when this write committed it (%p)',
    async failed => {
      mockExecuteDagWorkflow.mockRejectedValueOnce(new Error('dag boom'));
      const store = makeStore({ failWorkflowRun: mock(async () => ({ failed })) });
      await startWorkflow({ store });
      const liveFailures = mockEmitter.emit.mock.calls.filter(
        ([event]) => event.type === 'workflow_failed'
      );
      expect(liveFailures).toHaveLength(failed ? 1 : 0);
      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    }
  );

  it('records a run failure when durable node evidence cannot be stored', async () => {
    mockExecuteDagWorkflow.mockRejectedValueOnce(
      new NodeEventWriteError(
        {
          workflow_run_id: 'run-1',
          event_type: 'node_failed',
          step_name: 'build',
          data: { error: 'build exited 3' },
        },
        new Error('storage unavailable')
      )
    );
    const store = makeStore();
    await startWorkflow({ store });
    expect(store.failWorkflowRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('storage unavailable; original node failure: build exited 3'),
      { exitReason: 'unhandled_error' }
    );
  });

  it('does not recover a rejected DAG terminal write with a second failure write', async () => {
    mockExecuteDagWorkflow.mockRejectedValueOnce(
      new TerminalStatusWriteError(new Error('terminal completion write failed'))
    );
    const failWorkflowRun = mock(async () => ({ failed: true }));
    await expect(startWorkflow({ store: makeStore({ failWorkflowRun }) })).rejects.toThrow(
      'terminal completion write failed'
    );
    expect(failWorkflowRun).not.toHaveBeenCalled();
  });

  it('reports a run whose row could not be created as run_not_created, with no run_ref', async () => {
    const store = makeStore({
      createWorkflowRun: mock(async () => {
        throw new Error('db down');
      }),
    });
    await startWorkflow({ store, options: { source: 'bundled' } });
    expect(mockCaptureWorkflowTerminal).toHaveBeenCalledTimes(1);
    const props = mockCaptureWorkflowTerminal.mock.calls[0][0];
    expect(props).toMatchObject({
      outcome: 'failed',
      exitReason: 'run_not_created',
      workflowSource: 'bundled',
    });
    expect(props.runId).toBeUndefined();
  });
});
