// @archon-test-isolated
import { WorkflowExecutionHandoffError } from '../engine-port';
import * as nodeEventWrite from '../node-event-write';
import { mkdir, writeFile } from 'node:fs/promises';
import { describe, it, expect, afterEach, mock, spyOn } from 'bun:test';
import { removeTempTree } from '@archon/paths/test-utils';
import { dagNodeSchema, isApprovalContext, isWorkflowWaitContext } from '../schemas';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  type MockWorkflowEventCollector,
  createMockStore,
  createMockDeps,
  createMockPlatform,
  persistedEvents,
  ready,
  mockLogger,
  mockSendQueryDag,
  stubMissingContainer,
  dagOptions,
  makeWorkflowRun,
  mockCodexCapabilities,
  mockProviderRegistry,
  withProviderCapabilities,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import type { IWorkflowStore } from '../store';
import { finishNodeExecution } from '../node-execution';
import { serializeNodeStateRecord } from '../node-record-serialization';
import { createFileWorkflowStore } from '../file-store/store';
import * as sourceLoader from '../workflow-source/load';
import {
  captureWorkflowSource,
  capturedSourceRoots,
  WorkflowSourceUnavailableError,
} from '../workflow-source';

// ---------------------------------------------------------------------------
// Container write-back gate + suspend-on-pause (Phase C)
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- container write-back gate', () => {
  const CONTAINER_EXEC = { kind: 'container' as const, containerId: 'cid-1' };
  const wbTestDir = join(tmpdir(), `dag-wb-test-${Date.now()}`);
  // The executor creates `logs/` under the run's cwd, so this path becomes a real tree.
  const eventWrites: Promise<unknown>[] = [];
  let containerProbe: ReturnType<typeof stubMissingContainer> | undefined;
  afterEach(async () => {
    containerProbe?.mockRestore();
    containerProbe = undefined;
    await Promise.all(eventWrites.splice(0));
    await removeTempTree(wbTestDir);
  });

  function trackEventWrites(store: IWorkflowStore): void {
    const create = store.createWorkflowEvent.bind(store);
    store.createWorkflowEvent = (...args) => {
      const write = create(...args);
      eventWrites.push(write);
      return write;
    };
  }

  function makeWritebackBackend(over?: Partial<Record<string, unknown>>) {
    return {
      suspend: mock(async () => undefined),
      prepareSuspend: mock(async () => mock(async () => undefined)),
      finalize: mock(async () => ({ requiresApproval: false as boolean })),
      applyChanges: mock(async () => ({
        filesApplied: 0,
        filesDeleted: 0,
        warnings: [] as string[],
      })),
      discardChanges: mock(async () => undefined),
      ...over,
    };
  }

  /** Run a single pre-completed bash node under a container context so the gate runs. */
  async function runGate(opts: {
    backend: ReturnType<typeof makeWritebackBackend>;
    writeBack?: 'approve' | 'auto';
    runMetadata?: Record<string, unknown>;
    claimed?: boolean;
    platform?: ReturnType<typeof createMockPlatform>;
  }): Promise<IWorkflowStore> {
    const store = createMockStore();
    store.getWorkflowRunStatus = mock(() => Promise.resolve('running' as const));
    store.getWorkflowRun = mock(() =>
      Promise.resolve(makeWorkflowRun('wb-run', { metadata: opts.runMetadata ?? {} }))
    );
    store.claimWriteback = mock(() => Promise.resolve({ claimed: opts.claimed ?? true }));
    const deps = createMockDeps(store);
    await executeDagWorkflow(
      dagOptions({
        deps,
        ...(opts.platform ? { platform: opts.platform } : {}),
        conversationId: 'conv-wb',
        cwd: wbTestDir,
        workflow: {
          name: 'wb',
          nodes: [{ id: 'a', kind: 'exec', runtime: 'sh', script: 'echo hi' }],
        },
        workflowRun: makeWorkflowRun('wb-run'),
        priorCompletedNodes: new Map([['a', { output: 'out' }]]),
        execContext: CONTAINER_EXEC,
        containerCtx: {
          envId: 'env-x',
          writeBack: opts.writeBack ?? 'approve',
          backend: opts.backend,
        },
      })
    );
    return store;
  }

  it.each(['approval', 'wait', 'writeback', 'unresolved'] as const)(
    '%s cannot be resumed until suspension has finished',
    async kind => {
      const store = await createFileWorkflowStore({ root: join(wbTestDir, 'store') });
      trackEventWrites(store);
      const created = await store.createWorkflowRun({
        workflow_name: 'ordering',
        user_message: '',
      });
      const run = await store.claimPendingWorkflowRun(created.id);
      if (!run) throw new Error('run was not claimed');
      const summary = {
        added: ['x'],
        modified: [],
        deleted: [],
        symlinks: [],
        skipped: [],
        totalCount: 1,
        truncated: false,
      };
      if (kind === 'unresolved') {
        await store.updateWorkflowRun(run.id, {
          metadata: {
            pending_writeback: { envId: 'env-x', summary },
            approval: { type: 'writeback', nodeId: '__writeback__', message: '' },
          },
        });
      }
      const order: string[] = [];
      const suspendStarted = Promise.withResolvers<void>();
      const releaseSuspend = Promise.withResolvers<void>();
      const backend = makeWritebackBackend({
        finalize: mock(async () => ({ requiresApproval: true, changeSummary: summary })),
        suspend: mock(async () => {
          order.push('stop');
          suspendStarted.resolve();
          await releaseSuspend.promise;
          order.push('stopped');
        }),
      });
      const resumePublishedPause = async (): Promise<void> => {
        order.push('published');
        expect(await store.getWorkflowRunStatus(run.id)).toBe('paused');
        expect((await store.resumeWorkflowRun(run.id)).status).toBe('running');
        order.push('successor');
      };
      const pause = store.pauseWorkflowRun.bind(store);
      store.pauseWorkflowRun = async (...args) => {
        await pause(...args);
        await resumePublishedPause();
      };
      const pauseForWait = store.pauseWorkflowRunForWait.bind(store);
      store.pauseWorkflowRunForWait = async (...args) => {
        await pauseForWait(...args);
        await resumePublishedPause();
      };
      const options = dagOptions({
        deps: createMockDeps(store),
        cwd: wbTestDir,
        workflowRun: run,
        workflow: {
          name: 'ordering',
          nodes:
            kind === 'approval'
              ? [
                  {
                    id: 'review',
                    kind: 'gate',
                    message: 'Review',
                    decisions: [{ id: 'approve' }, { id: 'reject' }],
                    decisionsAuthored: false,
                    captureResponse: false,
                  },
                ]
              : kind === 'wait'
                ? [dagNodeSchema.parse({ id: 'delay', wait: { duration_ms: 60_000 } })]
                : [{ id: 'a', kind: 'exec', runtime: 'sh', script: 'echo hi' }],
        },
        priorCompletedNodes:
          kind === 'approval' || kind === 'wait' ? undefined : new Map([['a', { output: 'out' }]]),
        execContext: CONTAINER_EXEC,
        containerCtx: { envId: 'env-x', writeBack: 'approve', backend },
      });
      const pending = executeDagWorkflow(options);
      try {
        await suspendStarted.promise;
        expect(await store.getWorkflowRunStatus(run.id)).toBe('running');
        await expect(store.resumeWorkflowRun(run.id)).rejects.toThrow();
        expect(order).toEqual(['stop']);
      } finally {
        releaseSuspend.resolve();
        await pending;
      }
      expect(order).toEqual(['stop', 'stopped', 'published', 'successor']);
      expect(await store.getWorkflowRunStatus(run.id)).toBe('running');
      expect(backend.applyChanges).not.toHaveBeenCalled();
      expect(backend.discardChanges).not.toHaveBeenCalled();
    }
  );

  async function realPauseFixture(nodes: Parameters<typeof dagOptions>[0]['workflow']['nodes']) {
    containerProbe = stubMissingContainer();
    const store = await createFileWorkflowStore({ root: join(wbTestDir, 'store') });
    trackEventWrites(store);
    const created = await store.createWorkflowRun({ workflow_name: 'pause', user_message: '' });
    const run = await store.claimPendingWorkflowRun(created.id);
    if (!run) throw new Error('run was not claimed');
    const backend = makeWritebackBackend();
    const options = dagOptions({
      deps: createMockDeps(store),
      cwd: wbTestDir,
      workflowRun: run,
      workflow: { name: 'pause', nodes },
      execContext: CONTAINER_EXEC,
      containerCtx: { envId: 'env-x', writeBack: 'approve', backend },
    });
    return { store, backend, options, run };
  }

  const reviewNode = (id = 'review') =>
    dagNodeSchema.parse({ id, approval: { message: 'Review' } });

  it('releases unreadable source instead of publishing a same-layer approval', async () => {
    const { options, backend, store, run } = await realPauseFixture([
      reviewNode(),
      dagNodeSchema.parse({ id: 'check', runtime: 'bun', script: 'check' }),
    ]);
    const metadata = { ...run.metadata, isolation: 'container', isolation_env_id: 'env-x' };
    await store.updateWorkflowRun(run.id, { metadata });
    options.workflowRun = { ...run, metadata };
    const scripts = join(wbTestDir, '.archon', 'scripts');
    await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, 'check.ts'), 'console.log("ok")');
    const capture = await captureWorkflowSource({
      sourceRoot: wbTestDir,
      captureRoot: join(wbTestDir, 'capture'),
    });
    options.workflowSourceRoots = capturedSourceRoots(capture.anchor);
    const fault = spyOn(sourceLoader, 'assertWorkflowSourceIntegrity').mockRejectedValue(
      new WorkflowSourceUnavailableError(join(wbTestDir, 'capture'), new Error('read denied'))
    );
    const head = await store.getWorkflowEventHead();
    try {
      expect(await executeDagWorkflow(options)).toEqual({ kind: 'source_release', released: true });
    } finally {
      fault.mockRestore();
    }
    const released = await store.getWorkflowRun(run.id);
    expect(released?.metadata.approval).toBeUndefined();
    expect(released?.metadata.source_release).toBeDefined();
    expect(backend.suspend).not.toHaveBeenCalled();
    expect(backend.prepareSuspend).toHaveBeenCalledTimes(1);
    const page = await store.readWorkflowEventsAfter(head, { limit: 100 });
    expect(page.events.some(({ event }) => event.event_type === 'approval_pending')).toBe(false);
  });

  it('joins an active peer before stopping or publishing, and does not admit the next layer', async () => {
    const peerStarted = Promise.withResolvers<void>();
    const releasePeer = Promise.withResolvers<void>();
    let peerSettled = false;
    mockSendQueryDag.mockImplementationOnce(async function* () {
      peerStarted.resolve();
      await releasePeer.promise;
      peerSettled = true;
      yield { type: 'agent_message_chunk', text: 'Peer finished' };
      yield { type: 'result', sessionId: 'peer-session' };
    });
    const { store, options, backend, run } = await realPauseFixture([
      dagNodeSchema.parse({ id: 'peer', prompt: 'Slow peer' }),
      reviewNode(),
      dagNodeSchema.parse({ id: 'later', depends_on: ['review'], bash: 'echo should-not-run' }),
    ]);
    const suspendStarted = Promise.withResolvers<void>();
    const releaseSuspend = Promise.withResolvers<void>();
    backend.suspend = mock(async () => {
      expect(peerSettled).toBe(true);
      suspendStarted.resolve();
      await releaseSuspend.promise;
    });
    const head = await store.getWorkflowEventHead();
    const pending = executeDagWorkflow(options);
    try {
      await peerStarted.promise;
      expect(backend.suspend).not.toHaveBeenCalled();
      expect(await store.getWorkflowRunStatus(run.id)).toBe('running');
      releasePeer.resolve();
      await suspendStarted.promise;
      expect(await store.getWorkflowRunStatus(run.id)).toBe('running');
      await expect(store.resumeWorkflowRun(run.id)).rejects.toThrow();
    } finally {
      releasePeer.resolve();
      releaseSuspend.resolve();
      await pending;
    }
    expect(await store.getWorkflowRunStatus(run.id)).toBe('paused');
    const page = await store.readWorkflowEventsAfter(head, { limit: 100 });
    expect(page.events.filter(({ event }) => event.step_name === 'later')).toHaveLength(0);
    expect(backend.suspend).toHaveBeenCalledTimes(1);
  });

  for (const container of [false, true]) {
    it.each([
      { duration_ms: 60_000 },
      { until: '2099-01-01T00:00:00.000Z' },
      { event: 'ready', deadline_ms: 60_000 },
    ])(
      `keeps an unresolved loop-group wait paused at the iteration cap (container=${container}, %j)`,
      async wait => {
        const group = dagNodeSchema.parse({
          id: 'group',
          loop_group: {
            nodes: [{ id: 'delay', wait }],
            until: 'DONE',
            max_iterations: 1,
          },
        });
        const { options, backend, store, run } = await realPauseFixture([group]);
        if (!container) {
          options.execContext = { kind: 'host' };
          options.containerCtx = undefined;
        }
        await executeDagWorkflow(options);
        const original = (await store.getWorkflowRun(run.id))?.metadata.wait;
        options.workflowRun = await store.resumeWorkflowRun(run.id);
        options.priorCompletedNodes = (
          await store.getDagResumeSnapshot(run.id)
        ).completedNodeOutputs;
        const head = await store.getWorkflowEventHead();
        await executeDagWorkflow(options);
        expect((await store.getWorkflowRun(run.id))?.metadata.wait).toEqual(original);
        expect(await store.getWorkflowRunStatus(run.id)).toBe('paused');
        expect((await store.getDagResumeSnapshot(run.id)).failedNodes.size).toBe(0);
        const page = await store.readWorkflowEventsAfter(head, { limit: 100 });
        expect(page.events.filter(({ event }) => event.event_type === 'node_failed')).toHaveLength(
          0
        );
        expect(backend.suspend).toHaveBeenCalledTimes(container ? 2 : 0);
      }
    );
  }

  it.each(['gate', 'interactive group', 'interactive loop', 'wait'] as const)(
    'nested %s pauses stop before completion checks or another iteration',
    async kind => {
      const leaf =
        kind === 'gate'
          ? { id: 'review', approval: { message: 'Review' } }
          : kind === 'wait'
            ? { id: 'delay', wait: { duration_ms: 60_000 } }
            : { id: 'work', prompt: 'Work' };
      const inner =
        kind === 'interactive loop'
          ? {
              id: 'inner',
              loop: {
                prompt: 'Work',
                until: 'DONE',
                max_iterations: 2,
                interactive: true,
                gate_message: 'Continue?',
              },
            }
          : {
              id: 'inner',
              loop_group: {
                nodes: [leaf],
                until: 'DONE',
                max_iterations: 2,
                ...(kind === 'interactive group'
                  ? { interactive: true, gate_message: 'Continue?' }
                  : {}),
              },
            };
      const outer = dagNodeSchema.parse({
        id: 'outer',
        loop_group: { nodes: [inner], until_bash: 'exit 0', max_iterations: 2 },
      });
      const { options, backend, store, run } = await realPauseFixture([outer]);
      let previousWait: unknown;
      if (kind === 'wait') {
        await executeDagWorkflow({
          ...options,
          execContext: { kind: 'host' },
          containerCtx: undefined,
        });
        previousWait = (await store.getWorkflowRun(run.id))?.metadata.wait;
        options.workflowRun = await store.resumeWorkflowRun(run.id);
        options.priorCompletedNodes = (
          await store.getDagResumeSnapshot(run.id)
        ).completedNodeOutputs;
      }
      const head = await store.getWorkflowEventHead();
      await executeDagWorkflow(options);
      expect(backend.suspend).toHaveBeenCalledTimes(1);
      const paused = await store.getWorkflowRun(run.id);
      expect(paused?.status).toBe('paused');
      const page = await store.readWorkflowEventsAfter(head, { limit: 100 });
      expect(page.events.filter(({ event }) => event.event_type === 'node_failed')).toHaveLength(0);
      expect(
        page.events.filter(
          ({ event }) =>
            event.event_type === 'loop_iteration_completed' && event.step_name === 'outer'
        )
      ).toHaveLength(0);
      expect(
        page.events.filter(
          ({ event }) =>
            event.event_type === 'node_completed' &&
            ['outer', 'outer.inner'].includes(event.step_name ?? '')
        )
      ).toHaveLength(0);
      if (kind === 'wait') {
        expect(paused?.metadata.wait).toEqual(previousWait);
        expect(paused?.metadata.wait).toMatchObject({
          kind: 'time',
          nodeId: 'inner',
          bodyWaitId: 'delay',
          iteration: 1,
        });
        expect(
          page.events.some(
            ({ event }) =>
              event.event_type === 'node_suspended' && event.step_name === 'outer.inner.delay'
          )
        ).toBe(true);
      } else {
        expect(paused?.metadata.approval).toMatchObject({ nodeId: 'inner', iteration: 1 });
      }
    }
  );

  it.each([false, true])('stages a held child pause (fan-out=%s)', async fanOut => {
    const child = dagNodeSchema.parse({
      id: 'child',
      workflow: 'child-workflow',
      ...(fanOut ? { fan_out: { items: '["a"]', max_parallel: 1, join: 'all_done' } } : {}),
    });
    const { options, backend, store, run } = await realPauseFixture([child]);
    await mkdir(join(wbTestDir, '.archon', 'workflows'), { recursive: true });
    await writeFile(
      join(wbTestDir, '.archon', 'workflows', 'child-workflow.yaml'),
      'name: child-workflow\ndescription: Child\nnodes:\n  - id: work\n    bash: echo done\n'
    );
    options.runChildWorkflow = async () => ({ childRunId: 'held-child', status: 'paused' });
    backend.suspend = mock(async () => {
      expect(await store.getWorkflowRunStatus(run.id)).toBe('running');
      await expect(store.resumeWorkflowRun(run.id)).rejects.toThrow();
    });
    const receipt = await executeDagWorkflow(options);
    expect(receipt).toMatchObject({
      kind: 'container_pause',
      pause: { kind: 'gate', context: { type: fanOut ? 'fan_out' : 'child_workflow' } },
    });
    expect(backend.suspend).toHaveBeenCalledTimes(1);
    expect((await store.getDagResumeSnapshot(run.id)).completedNodeOutputs.has('child')).toBe(
      false
    );
  });

  it.each([false, true])(
    'surfaces a post-publication error and reports suspension failure=%s after resume',
    async suspensionFails => {
      const { options, store, run, backend } = await realPauseFixture([reviewNode()]);
      if (suspensionFails) {
        backend.suspend = mock(async () => {
          throw new Error('stop failed');
        });
      }
      const head = await store.getWorkflowEventHead();
      const pause = store.pauseWorkflowRun.bind(store);
      store.pauseWorkflowRun = async (...args) => {
        await pause(...args);
        await store.resumeWorkflowRun(run.id);
      };
      const failure = new Error('transcript write failed');
      const original = nodeEventWrite.recordDerivedExecution;
      const derived = spyOn(nodeEventWrite, 'recordDerivedExecution').mockImplementation(
        async (...args) => {
          if ('lifecycle' in args[1] && args[1].lifecycle.status === 'suspended') throw failure;
          return original(...args);
        }
      );
      try {
        await expect(executeDagWorkflow(options)).rejects.toMatchObject({
          name: WorkflowExecutionHandoffError.name,
          workflowRunId: run.id,
          cause: failure,
        });
        expect(await store.getWorkflowRunStatus(run.id)).toBe('running');
        const page = await store.readWorkflowEventsAfter(head, { limit: 100 });
        expect(
          page.events.filter(({ event }) => event.event_type === 'workflow_cleanup_warning')
        ).toHaveLength(suspensionFails ? 1 : 0);
      } finally {
        derived.mockRestore();
      }
    }
  );

  it('does not expose a continued wait when its required suspended record cannot be written', async () => {
    const { options, store, run, backend } = await realPauseFixture([
      dagNodeSchema.parse({ id: 'delay', wait: { duration_ms: 60_000 } }),
    ]);
    await executeDagWorkflow({
      ...options,
      execContext: { kind: 'host' },
      containerCtx: undefined,
    });
    options.workflowRun = await store.resumeWorkflowRun(run.id);
    options.priorCompletedNodes = (await store.getDagResumeSnapshot(run.id)).completedNodeOutputs;
    const persist = store.persistWorkflowEvent.bind(store);
    store.persistWorkflowEvent = async event => {
      if (event.event_type === 'node_suspended') throw new Error('required record rejected');
      return persist(event);
    };
    const pause = mock(store.pauseWorkflowRunForWait.bind(store));
    store.pauseWorkflowRunForWait = pause;
    await expect(executeDagWorkflow(options)).rejects.toBeInstanceOf(
      nodeEventWrite.NodeEventWriteError
    );
    expect(backend.suspend).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
    expect(await store.getWorkflowRunStatus(run.id)).toBe('running');
  });

  it('only publishes one of two competing gates', async () => {
    const { options, backend, store, run } = await realPauseFixture([
      reviewNode('one'),
      reviewNode('two'),
    ]);
    const pause = mock(store.pauseWorkflowRun.bind(store));
    store.pauseWorkflowRun = pause;
    await executeDagWorkflow(options);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(backend.suspend).toHaveBeenCalledTimes(1);
    expect(await store.getWorkflowRunStatus(run.id)).toBe('paused');
  });

  it.each(['time', 'event', 'attention'] as const)(
    'records only the selected loop-group terminal %s wait as suspended',
    async kind => {
      const wait =
        kind === 'time'
          ? { duration_ms: 60_000 }
          : kind === 'event'
            ? { event: 'ready', deadline_ms: 60_000 }
            : { attention: 'Continue?', form: 'approval' };
      const { options, store, run } = await realPauseFixture(
        ['selected', 'deferred'].map(id =>
          dagNodeSchema.parse({
            id,
            loop_group: {
              until: 'DONE',
              max_iterations: 1,
              nodes: [{ id: 'hold', wait }],
            },
          })
        )
      );
      await executeDagWorkflow(options);
      const current = await store.getWorkflowRun(run.id);
      const cursor = current?.metadata.wait;
      if (!isWorkflowWaitContext(cursor)) throw new Error('Missing wait cursor');
      const selected = cursor.nodeId;
      expect(cursor).toMatchObject({
        owner: 'loop_group',
        nodeId: selected,
        bodyWaitId: 'hold',
        iteration: 1,
      });
      const events = await store.listWorkflowEvents(run.id);
      expect(
        events.filter(event => event.event_type === 'node_suspended').map(event => event.step_name)
      ).toEqual([selected, `${selected}.hold`]);
      expect(
        events.find(event => event.step_name === selected && event.event_type === 'node_suspended')
          ?.data
      ).toMatchObject({ suspend_point: 'wait' });
      expect(await store.getWorkflowRunStatus(run.id)).toBe('paused');

      options.workflow = ready({
        name: 'pause',
        nodes: options.workflow.nodes.filter(node => node.id === selected),
      });
      options.workflowRun = await store.resumeWorkflowRun(run.id);
      options.priorCompletedNodes = (await store.getDagResumeSnapshot(run.id)).completedNodeOutputs;
      await executeDagWorkflow(options);
      const continued = await store.listWorkflowEvents(run.id);
      expect(
        continued
          .slice(events.length)
          .filter(event => event.event_type === 'node_suspended')
          .map(event => event.step_name)
      ).toEqual([selected, `${selected}.hold`]);
      expect((await store.getWorkflowRun(run.id))?.metadata.wait).toEqual(current?.metadata.wait);

      options.workflowRun = await store.resumeWorkflowRun(run.id);
      options.priorCompletedNodes = (await store.getDagResumeSnapshot(run.id)).completedNodeOutputs;
      options.workflow = ready({
        name: 'pause',
        nodes: [reviewNode('winner'), ...options.workflow.nodes],
      });
      await executeDagWorkflow(options);
      const lost = await store.listWorkflowEvents(run.id);
      expect(
        lost
          .slice(continued.length)
          .filter(event => event.event_type === 'node_suspended')
          .map(event => event.step_name)
      ).toEqual(['winner']);
      expect((await store.getWorkflowRun(run.id))?.metadata.approval).toMatchObject({
        nodeId: 'winner',
      });
    }
  );

  it('records only the selected loop-group terminal gate as suspended', async () => {
    const { options, store, run } = await realPauseFixture(
      ['selected', 'deferred'].map(id =>
        dagNodeSchema.parse({
          id,
          loop_group: {
            until: 'DONE',
            max_iterations: 1,
            nodes: [{ id: 'review', approval: { message: 'Review' } }],
          },
        })
      )
    );
    await executeDagWorkflow(options);
    const approval = (await store.getWorkflowRun(run.id))?.metadata.approval;
    if (!isApprovalContext(approval)) throw new Error('Missing approval context');
    expect(approval).toMatchObject({ bodyGateId: 'review', iteration: 1 });
    const selected = approval.nodeId;
    const events = await store.listWorkflowEvents(run.id);
    expect(
      events
        .filter(event => event.event_type === 'node_suspended')
        .map(event => event.step_name)
        .sort()
    ).toEqual([selected, `${selected}.review`]);
    expect(
      events.find(event => event.step_name === selected && event.event_type === 'node_suspended')
        ?.data
    ).toMatchObject({ suspend_point: 'approval' });
  });

  it('keeps deferred loop spend durable and selected loop spend on its gate', async () => {
    const query = async function* () {
      yield { type: 'agent_message_chunk' as const, text: 'COMPLETE' };
      yield { type: 'result' as const, sessionId: 'loop-session', cost: 0.25 };
    };
    mockSendQueryDag.mockImplementationOnce(query).mockImplementationOnce(query);
    const { options, store, run } = await realPauseFixture(
      ['one', 'two'].map(id =>
        dagNodeSchema.parse({
          id,
          loop: {
            prompt: 'Work',
            until: 'COMPLETE',
            max_iterations: 2,
            interactive: true,
            gate_message: 'Continue?',
          },
        })
      )
    );
    await executeDagWorkflow(options);
    expect((await store.getDagResumeSnapshot(run.id)).costUsd).toBe(0.25);
    const metadata = (await store.getWorkflowRun(run.id))?.metadata;
    expect(metadata?.total_cost_usd).toBe(0.5);
    expect(metadata?.approval).toMatchObject({ signaledCostUsd: 0.25 });
  });

  it.each(['approval', 'approved writeback', 'rejected writeback'] as const)(
    'normal %s resumes and finishes with no second stop',
    async kind => {
      const { options, backend, store, run } = await realPauseFixture(
        kind === 'approval'
          ? [reviewNode()]
          : [dagNodeSchema.parse({ id: 'work', bash: 'echo work' })]
      );
      if (kind !== 'approval') {
        options.priorCompletedNodes = new Map([['work', { output: 'work' }]]);
        backend.finalize = mock(async () => ({
          requiresApproval: true,
          changeSummary: {
            added: ['x'],
            modified: [],
            deleted: [],
            symlinks: [],
            skipped: [],
            totalCount: 1,
            truncated: false,
          },
        }));
      }
      await executeDagWorkflow(options);
      const paused = await store.getWorkflowRun(run.id);
      const approval = paused?.metadata.approval;
      if (!isApprovalContext(approval) || approval.pauseId === undefined)
        throw new Error('missing approval');
      const resolved = kind === 'rejected writeback' ? 'rejected' : 'approved';
      const completion =
        kind === 'approval' && approval.execution !== undefined
          ? [
              serializeNodeStateRecord(
                finishNodeExecution(
                  approval.execution,
                  { status: 'completed' },
                  { output: { text: '' }, diagnostics: { approvalDecision: 'approve' } }
                )
              ),
            ]
          : [];
      expect(
        await store.resolveApprovalGate(
          run.id,
          { approval: { ...approval, resolved } },
          completion,
          { nodeId: approval.nodeId, pauseId: approval.pauseId }
        )
      ).toEqual({ resolved: true });
      const resumed = await store.resumeWorkflowRun(run.id);
      await executeDagWorkflow({
        ...options,
        workflowRun: resumed,
        priorCompletedNodes: (await store.getDagResumeSnapshot(run.id)).completedNodeOutputs,
      });
      expect(await store.getWorkflowRunStatus(run.id)).toBe('completed');
      expect(backend.suspend).toHaveBeenCalledTimes(1);
      expect(backend.applyChanges).toHaveBeenCalledTimes(kind === 'approved writeback' ? 1 : 0);
      expect(backend.discardChanges).toHaveBeenCalledTimes(kind === 'rejected writeback' ? 1 : 0);
    }
  );

  it.each([
    ['fuse', 'created', { containerId: 'cid-1' }],
    ['native', 'created', { containerId: 'cid-1', overlayMode: 'native', gateBypassable: true }],
    ['fuse', 'resumed', { containerId: 'cid-1' }],
    ['native', 'resumed', { containerId: 'cid-1', overlayMode: 'native', gateBypassable: true }],
  ] as const)(
    'a %s-overlay container_%s event retains its security facts',
    async (overlayMode, lifecycle, expectedData) => {
      const store = createMockStore();
      const platform = createMockPlatform();
      const execSpy = stubMissingContainer();
      try {
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            platform,
            conversationId: 'conv-created',
            cwd: wbTestDir,
            workflow: {
              name: 'created',
              nodes: [{ id: 'a', kind: 'exec', runtime: 'sh', script: 'echo hi' }],
            },
            workflowRun: makeWorkflowRun('created-run'),
            ...(lifecycle === 'resumed'
              ? { priorCompletedNodes: new Map([['a', { output: 'out' }]]) }
              : {}),
            execContext: CONTAINER_EXEC,
            containerCtx: {
              envId: 'env-x',
              writeBack: 'approve',
              backend: makeWritebackBackend(),
              overlayMode,
            },
          })
        );
      } finally {
        execSpy.mockRestore();
      }

      const created = persistedEvents(store).filter(
        event => event.event_type === `container_${lifecycle}`
      );
      expect(created.map(event => event.data)).toEqual([expectedData]);
      expect(
        platform.sendMessage.mock.calls.some(([, message]) =>
          message.includes('NATIVE overlay mode (CAP_SYS_ADMIN)')
        )
      ).toBe(overlayMode === 'native');
    }
  );

  it('empty diff → completes normally, no pause', async () => {
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({ requiresApproval: false })),
    });
    const store = await runGate({ backend });
    expect(backend.finalize).toHaveBeenCalledTimes(1);
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
    expect(backend.suspend).not.toHaveBeenCalled();
  });

  it('non-empty diff + approve policy → pauses (writeback) + suspends, does NOT complete', async () => {
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({
        requiresApproval: true,
        changeSummary: {
          added: ['x.md'],
          modified: [],
          deleted: [],
          symlinks: [],
          skipped: [],
          totalCount: 1,
          truncated: false,
        },
      })),
    });
    const store = await runGate({ backend });
    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
    const pauseCall = (store.pauseWorkflowRun as ReturnType<typeof mock>).mock.calls[0];
    const pauseArg = pauseCall[1] as { nodeId: string; type: string };
    expect(pauseArg.nodeId).toBe('__writeback__');
    expect(pauseArg.type).toBe('writeback');
    // pending_writeback is folded into the SAME pause write (M3), not a 2nd update.
    const extraMeta = pauseCall[2] as { pending_writeback?: { envId: string } };
    expect(extraMeta.pending_writeback?.envId).toBe('env-x');
    // The request row commits with the pause, and is not written a second time beside it.
    expect(pauseCall[3]).toEqual({
      workflow_run_id: expect.any(String),
      event_type: 'writeback_requested',
      step_name: 'container',
      data: { total_count: 1 },
    });
    const writes = (store.createWorkflowEvent as MockWorkflowEventCollector).mock.calls;
    expect(writes.filter(([event]) => event.event_type === 'writeback_requested')).toHaveLength(1);
    expect(backend.suspend).toHaveBeenCalledTimes(1);
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('records an undelivered pause notice when the write-back gate message cannot be sent', async () => {
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({
        requiresApproval: true,
        changeSummary: {
          added: ['x.md'],
          modified: [],
          deleted: [],
          symlinks: [],
          skipped: [],
          totalCount: 1,
          truncated: false,
        },
      })),
    });
    const platform = createMockPlatform();
    platform.sendMessage = mock(async (): Promise<void> => {
      throw new Error('401 unauthorized');
    });
    const store = await runGate({ backend, platform });
    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.createWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: 'wb-run',
      event_type: 'pause_notice_undelivered',
      step_name: 'container',
      data: { nodeId: '__writeback__', occurrence: expect.any(String), platform: 'test' },
    });
  });

  it('a lost write-back pause stays fail-closed after suspension (#2489)', async () => {
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({
        requiresApproval: true,
        changeSummary: {
          added: ['x.md'],
          modified: [],
          deleted: [],
          symlinks: [],
          skipped: [],
          totalCount: 1,
          truncated: false,
        },
      })),
    });
    const store = createMockStore();
    store.getWorkflowRunStatus = mock(() => Promise.resolve('running' as const));
    store.getWorkflowRun = mock(() => Promise.resolve(makeWorkflowRun('wb-run', { metadata: {} })));
    store.claimWriteback = mock(() => Promise.resolve({ claimed: true }));
    store.pauseWorkflowRun = mock(() =>
      Promise.reject(new Error('Workflow run not found or not in running state (id: wb-run)'))
    );

    await expect(runGateWithStore(store, backend, 'approve')).rejects.toThrow(
      /not found or not in running state/
    );
    expect(backend.suspend).toHaveBeenCalledTimes(1);
    expect(backend.applyChanges).not.toHaveBeenCalled();
    expect(backend.discardChanges).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('non-empty diff + auto policy → applies without pausing, then completes', async () => {
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({
        requiresApproval: true,
        changeSummary: {
          added: ['x.md'],
          modified: [],
          deleted: [],
          symlinks: [],
          skipped: [],
          totalCount: 1,
          truncated: false,
        },
      })),
      applyChanges: mock(async () => ({ filesApplied: 1, filesDeleted: 0, warnings: [] })),
    });
    const store = await runGate({ backend, writeBack: 'auto' });
    expect(backend.applyChanges).toHaveBeenCalledTimes(1);
    expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  // Helper: a writeback approval context resolved to a given decision.
  const wbApproval = (resolved: 'approved' | 'rejected' | null) => ({
    nodeId: '__writeback__',
    message: 'review',
    type: 'writeback' as const,
    resolved,
  });

  it('resume after approve → CLAIMS then applies overlay, marks resolved, completes', async () => {
    const backend = makeWritebackBackend({
      applyChanges: mock(async () => ({ filesApplied: 3, filesDeleted: 1, warnings: [] })),
    });
    const store = await runGate({
      backend,
      runMetadata: { pending_writeback: { envId: 'env-x' }, approval: wbApproval('approved') },
    });
    // R2-F4: the apply is claimed BEFORE the live root is mutated.
    expect(store.claimWriteback).toHaveBeenCalledTimes(1);
    expect(backend.applyChanges).toHaveBeenCalledTimes(1);
    expect(backend.finalize).not.toHaveBeenCalled(); // resume path skips re-inspection
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  // R2-F4 — a lost claim (concurrent/prior resume owns the apply, or a crash left it
  // claimed after a successful apply) must NOT re-apply; complete as applied.
  it('resume after approve with a LOST claim does NOT re-apply', async () => {
    const backend = makeWritebackBackend();
    const store = await runGate({
      backend,
      claimed: false,
      runMetadata: { pending_writeback: { envId: 'env-x' }, approval: wbApproval('approved') },
    });
    expect(store.claimWriteback).toHaveBeenCalledTimes(1);
    expect(backend.applyChanges).not.toHaveBeenCalled(); // no double-apply
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('warns when an already-claimed write-back resolution cannot be recorded', async () => {
    const backend = makeWritebackBackend();
    const { store } = statefulGateStore({
      pending_writeback: { envId: 'env-x' },
      approval: wbApproval('approved'),
    });
    store.claimWriteback = mock(async () => ({ claimed: false }));
    const persistError = new Error('resolution store unavailable');
    const update = store.updateWorkflowRun;
    store.updateWorkflowRun = mock(async (id, updates) => {
      if (updates.metadata?.writeback_resolved === true) throw persistError;
      await update(id, updates);
    });
    const originalWarn = mockLogger.warn;
    const warn = mock((_data: unknown, _message?: string): void => undefined);
    mockLogger.warn = warn;
    try {
      await runGateWithStore(store, backend, 'approve');
      expect(warn).toHaveBeenCalledWith(
        {
          runId: 'wb-run',
          operation: 'updateWorkflowRun',
          err: persistError,
          recovery: expect.stringContaining('inspect the run and live-folder changes'),
        },
        'dag.writeback_resolution_persist_failed'
      );
      const warning = warn.mock.calls.find(
        ([, event]) => event === 'dag.writeback_resolution_persist_failed'
      );
      expect(warning?.[0]).toHaveProperty('err', persistError);
      expect((warning?.[0] as { err: unknown }).err).toBe(persistError);
      expect(store.claimWriteback).toHaveBeenCalledTimes(1);
      expect(backend.applyChanges).not.toHaveBeenCalled();
      expect(store.releaseWritebackClaim).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
    } finally {
      mockLogger.warn = originalWarn;
    }
  });

  // R2-F4 — a failed apply RELEASES the claim (so `workflow resume` can retry) and
  // propagates the error (run fails → volume preserved by H2).
  it('resume after approve with a FAILED apply releases the claim and rethrows', async () => {
    const backend = makeWritebackBackend({
      applyChanges: mock(async () => {
        throw new Error('cp: No space left on device');
      }),
    });
    // executeDagWorkflow lets the apply error propagate; the outer executor marks the
    // run failed. Assert release was called and the error surfaced.
    let threw = false;
    const store = createMockStore();
    store.getWorkflowRunStatus = mock(() => Promise.resolve('running' as const));
    store.getWorkflowRun = mock(() =>
      Promise.resolve(
        makeWorkflowRun('wb-run', {
          metadata: { pending_writeback: { envId: 'env-x' }, approval: wbApproval('approved') },
        })
      )
    );
    store.claimWriteback = mock(() => Promise.resolve({ claimed: true }));
    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-wb',
          cwd: wbTestDir,
          workflow: {
            name: 'wb',
            nodes: [{ id: 'a', kind: 'exec', runtime: 'sh', script: 'echo hi' }],
          },
          workflowRun: makeWorkflowRun('wb-run'),
          priorCompletedNodes: new Map([['a', { output: 'out' }]]),
          execContext: CONTAINER_EXEC,
          containerCtx: { envId: 'env-x', writeBack: 'approve', backend },
        })
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(store.releaseWritebackClaim).toHaveBeenCalledTimes(1);
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  // A stateful store that accumulates metadata from updateWorkflowRun / pauseWorkflowRun,
  // so an apply-throw test can inspect the FINAL run metadata — the exact input the CLI
  // teardown's `hasUnresolvedWriteback` reads to decide preserve-vs-destroy.
  function statefulGateStore(initialMeta: Record<string, unknown>): {
    store: IWorkflowStore;
    metadata: Record<string, unknown>;
  } {
    const metadata: Record<string, unknown> = { ...initialMeta };
    const store = createMockStore();
    store.getWorkflowRunStatus = mock(() => Promise.resolve('running' as const));
    store.getWorkflowRun = mock(() => Promise.resolve(makeWorkflowRun('wb-run', { metadata })));
    store.claimWriteback = mock(() => Promise.resolve({ claimed: true }));
    store.updateWorkflowRun = mock(
      (_id: string, updates: { metadata?: Record<string, unknown> }) => {
        for (const [k, v] of Object.entries(updates.metadata ?? {})) {
          if (v === null) delete metadata[k];
          else metadata[k] = v;
        }
        return Promise.resolve();
      }
    );
    return { store, metadata };
  }

  /** The predicate the CLI teardown uses to PRESERVE the volume (mirror of hasUnresolvedWriteback). */
  const wouldPreserve = (m: Record<string, unknown>): boolean =>
    m.pending_writeback !== undefined && m.writeback_resolved !== true;

  async function runGateWithStore(
    store: IWorkflowStore,
    backend: ReturnType<typeof makeWritebackBackend>,
    writeBack: 'approve' | 'auto'
  ): Promise<void> {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-wb',
        cwd: wbTestDir,
        workflow: {
          name: 'wb',
          nodes: [{ id: 'a', kind: 'exec', runtime: 'sh', script: 'echo hi' }],
        },
        workflowRun: makeWorkflowRun('wb-run'),
        priorCompletedNodes: new Map([['a', { output: 'out' }]]),
        execContext: CONTAINER_EXEC,
        containerCtx: { envId: 'env-x', writeBack, backend },
      })
    );
  }

  // N1/item-2 — an apply-throw in APPROVE mode leaves the run with pending_writeback set
  // and unresolved, so the teardown PRESERVES the volume (never destroy the only copy).
  it('apply-throw in approve mode leaves an unresolved write-back (teardown preserves)', async () => {
    const { store, metadata } = statefulGateStore({
      pending_writeback: { envId: 'env-x' },
      approval: wbApproval('approved'),
    });
    const backend = makeWritebackBackend({
      applyChanges: mock(async () => {
        throw new Error('cp: read-only file system');
      }),
    });
    await expect(runGateWithStore(store, backend, 'approve')).rejects.toThrow(/read-only/);
    expect(wouldPreserve(metadata)).toBe(true);
  });

  // N1 — an apply-throw in AUTO mode must ALSO leave pending_writeback set (auto sets the
  // preserve marker BEFORE mutating the live root), so the teardown preserves the volume.
  it('apply-throw in auto mode sets the preserve marker (teardown preserves)', async () => {
    const { store, metadata } = statefulGateStore({}); // fresh: no pending_writeback yet
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({
        requiresApproval: true,
        changeSummary: {
          added: ['x.md'],
          modified: [],
          deleted: [],
          symlinks: [],
          skipped: [],
          totalCount: 1,
          truncated: false,
        },
      })),
      applyChanges: mock(async () => {
        throw new Error('cp: read-only file system');
      }),
    });
    await expect(runGateWithStore(store, backend, 'auto')).rejects.toThrow(/read-only/);
    expect(metadata.pending_writeback).toBeDefined(); // marker set before the throw
    expect(wouldPreserve(metadata)).toBe(true);
  });

  it('resume after reject → discards overlay (live root untouched), completes', async () => {
    const backend = makeWritebackBackend();
    const store = await runGate({
      backend,
      runMetadata: { pending_writeback: { envId: 'env-x' }, approval: wbApproval('rejected') },
    });
    expect(backend.discardChanges).toHaveBeenCalledTimes(1);
    expect(backend.applyChanges).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  // H1 — FAIL CLOSED. A bare `/workflow resume` (no decision) reaches the still-open
  // gate: it must RE-PAUSE, never apply.
  it('resume with an UNRESOLVED gate re-pauses (fail closed), does NOT apply', async () => {
    const backend = makeWritebackBackend();
    const store = await runGate({
      backend,
      runMetadata: {
        pending_writeback: {
          envId: 'env-x',
          summary: {
            added: ['x'],
            modified: [],
            deleted: [],
            symlinks: [],
            skipped: [],
            totalCount: 1,
            truncated: false,
          },
        },
        approval: wbApproval(null), // gate raised but not yet decided
      },
    });
    expect(backend.applyChanges).not.toHaveBeenCalled();
    expect(backend.discardChanges).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1); // re-raised
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  // H1 — a STALE run-wide approval_response from an earlier mid-DAG approval node must
  // NOT auto-apply the write-back gate; only the gate's own approval.resolved counts.
  it('stale top-level approval_response does NOT apply the write-back overlay', async () => {
    const backend = makeWritebackBackend();
    const store = await runGate({
      backend,
      runMetadata: {
        pending_writeback: {
          envId: 'env-x',
          summary: {
            added: ['x'],
            modified: [],
            deleted: [],
            symlinks: [],
            skipped: [],
            totalCount: 1,
            truncated: false,
          },
        },
        approval: wbApproval(null),
        approval_response: 'approved', // stale from a prior gate — must be ignored
      },
    });
    expect(backend.applyChanges).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1); // re-raised, not applied
  });

  it.each([false, true])('ordinary pause survives suspension failure=%s', async fails => {
    const backend = makeWritebackBackend({
      suspend: mock(async () => {
        if (fails) throw new Error('Cannot connect to the Docker daemon');
      }),
    });
    const store = createMockStore();
    const result = await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: wbTestDir,
        workflowRun: makeWorkflowRun('ordinary'),
        workflow: {
          name: 'ordinary',
          nodes: [dagNodeSchema.parse({ id: 'review', approval: { message: 'Review' } })],
        },
        execContext: CONTAINER_EXEC,
        containerCtx: { envId: 'env-x', writeBack: 'approve', backend },
      })
    );
    expect(result).toMatchObject({ kind: 'container_pause' });
    expect(backend.suspend).toHaveBeenCalledTimes(1);
    expect(backend.finalize).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    const events = persistedEvents(store);
    expect(events.filter(e => e.event_type === 'workflow_cleanup_warning')).toHaveLength(
      fails ? 1 : 0
    );
    expect(events.filter(e => e.event_type === 'container_stopped')).toHaveLength(fails ? 0 : 1);
  });

  it.each(['ordinary', 'writeback'] as const)(
    '%s still pauses when suspension, warning persistence and notification all fail',
    async kind => {
      const store = createMockStore();
      const persist = store.createWorkflowEvent;
      store.createWorkflowEvent = mock(async event => {
        if (event.event_type === 'workflow_cleanup_warning')
          throw new Error('warning write failed');
        return persist(event);
      });
      const platform = createMockPlatform();
      platform.sendMessage = mock(async () => {
        throw new Error('offline');
      });
      const backend = makeWritebackBackend({
        suspend: mock(async () => {
          throw new Error('stop failed');
        }),
        finalize: mock(async () => ({
          requiresApproval: true,
          changeSummary: {
            added: ['x'],
            modified: [],
            deleted: [],
            symlinks: [],
            skipped: [],
            totalCount: 1,
            truncated: false,
          },
        })),
      });
      const result = await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform,
          cwd: wbTestDir,
          workflowRun: makeWorkflowRun('warning-run'),
          workflow: {
            name: 'warning',
            nodes:
              kind === 'ordinary'
                ? [reviewNode()]
                : [dagNodeSchema.parse({ id: 'work', bash: 'echo done' })],
          },
          priorCompletedNodes:
            kind === 'ordinary' ? undefined : new Map([['work', { output: 'done' }]]),
          execContext: CONTAINER_EXEC,
          containerCtx: { envId: 'env-x', writeBack: 'approve', backend },
        })
      );
      expect(result).toMatchObject({ kind: 'container_pause' });
      expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.createWorkflowEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'workflow_cleanup_warning',
          data: { warnings: [expect.stringContaining('stop failed')] },
        })
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'warning-run' }),
        'dag.container_suspend_warning_persist_failed'
      );
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
    }
  );

  // A run refused at preflight must not announce a container it will never use.
  it.each([
    [
      'a strict-schema violation',
      withProviderCapabilities(mockProviderRegistry, 'codex', {
        ...mockCodexCapabilities(),
        containerExec: true,
      }),
      /output_format schema strict-mode violation/,
    ],
    ['a container-incompatible provider', mockProviderRegistry, /cannot run inside a container/],
  ])('%s refuses the run before the container is announced', async (_, providers, refusal) => {
    const store = createMockStore();
    const platform = createMockPlatform();
    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store, providers),
          platform,
          cwd: wbTestDir,
          workflow: {
            name: 'refused',
            nodes: [
              {
                id: 'work',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'Do the work' },
                output_format: {
                  type: 'object',
                  properties: { ready: { type: 'boolean' }, note: { type: 'string' } },
                  required: ['ready'],
                },
              },
            ],
          },
          workflowRun: makeWorkflowRun('refused-run'),
          workflowProvider: 'codex',
          execContext: CONTAINER_EXEC,
          containerCtx: {
            envId: 'env-x',
            writeBack: 'approve',
            backend: makeWritebackBackend(),
            overlayMode: 'native',
          },
        })
      )
    ).rejects.toThrow(refusal);

    expect(
      persistedEvents(store).filter(event => event.event_type.startsWith('container_'))
    ).toEqual([]);
    expect(platform.sendMessage).not.toHaveBeenCalled();
  });
});
