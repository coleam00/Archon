// @archon-test-isolated
import { createEscalationStore } from './pause-test-utils';
import { removeTempTree } from '@archon/paths/test-utils';
import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeDagWorkflow } from '../dag-executor';
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from '../event-emitter';
import type { DagNode } from '../schemas';
import { dagNodeSchema } from '../schemas';
import { isApprovalContext } from '../schemas/workflow-run';
import type { IWorkflowStore } from '../store';
import { WorkflowRunPauseConflictError } from '../store';
import {
  createMockDeps,
  createMockPlatform,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  mockSendQueryDag,
  persistedEvents,
  runUsageWrites,
  type MockWorkflowStore,
} from './test-utils';

describe('executeDagWorkflow -- gate pause vs external transition (#1123)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-pause-race-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('presents the admitted gate before a slow sibling settles and persists before sending', async () => {
    const runId = 'prompt-before-layer-settles';
    const store = createEscalationStore(runId);
    const pause = store.pauseWorkflowRun;
    let releaseSibling = () => {};
    const siblingBlocked = new Promise<void>(resolve => {
      releaseSibling = resolve;
    });
    let signalPrompt = () => {};
    const prompted = new Promise<void>(resolve => {
      signalPrompt = resolve;
    });
    store.pauseWorkflowRun = mock(async (id, context, extra, suspension) => {
      if (context.nodeId === 'second') await siblingBlocked;
      await pause(id, context, extra, suspension);
    });
    const platform = createMockPlatform();
    platform.sendMessage.mockImplementation(async (_id, message) => {
      if (message.includes('**Approval required**')) {
        expect(store.getState().status).toBe('paused');
        expect(store.getState().metadata.approval).toMatchObject({ nodeId: 'first' });
        signalPrompt();
      }
    });
    const execution = executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        cwd: testDir,
        workflowRun: makeWorkflowRun(runId),
        workflow: {
          name: 'slow-sibling',
          nodes: ['first', 'second'].map(id =>
            dagNodeSchema.parse({ id, approval: { message: 'Review' } })
          ),
        },
      })
    );
    try {
      await prompted;
      expect(
        persistedEvents(store).filter(event => event.event_type === 'node_started')
      ).toHaveLength(2);
    } finally {
      releaseSibling();
      await execution;
    }
    expect(
      platform.sendMessage.mock.calls.filter(([, message]) =>
        message.includes('**Approval required**')
      )
    ).toHaveLength(1);
  });

  it('keeps a sibling deferred when the active gate is resolved before the losing CAS is inspected', async () => {
    const runId = 'fast-decision';
    const store = createEscalationStore(runId);
    const readRun = store.getWorkflowRun;
    store.getWorkflowRun = mock(async id => {
      const run = await readRun(id);
      const approval = run?.metadata.approval;
      if (isApprovalContext(approval)) approval.resolved = 'approved';
      return run;
    });
    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        cwd: testDir,
        workflowRun: makeWorkflowRun(runId),
        workflow: {
          name: 'fast-decision',
          nodes: ['first', 'second'].map(id =>
            dagNodeSchema.parse({ id, approval: { message: 'Review' } })
          ),
        },
      })
    );
    expect(
      platform.sendMessage.mock.calls.filter(([, message]) =>
        message.includes('**Approval required**')
      )
    ).toHaveLength(1);
    expect(persistedEvents(store).filter(event => event.event_type === 'node_failed')).toHaveLength(
      0
    );
  });

  it('preserves a loop-group body failure when a sibling gate pauses before its terminal gate starts', async () => {
    const runId = 'paused-sibling-body-failure';
    const store = createEscalationStore(runId);
    let workStarted = () => {};
    const started = new Promise<void>(resolve => {
      workStarted = resolve;
    });
    let gatePaused = () => {};
    const paused = new Promise<void>(resolve => {
      gatePaused = resolve;
    });
    const pause = store.pauseWorkflowRun;
    store.pauseWorkflowRun = mock(async (id, context, extra, suspension) => {
      await started;
      await pause(id, context, extra, suspension);
      gatePaused();
    });
    mockSendQueryDag.mockImplementation(async function* () {
      workStarted();
      await paused;
      yield { type: 'agent_message_chunk', text: '' };
      throw new Error('Body provider unavailable');
    });
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflowRun: makeWorkflowRun(runId),
        workflow: {
          name: 'body-failure',
          nodes: [
            dagNodeSchema.parse({ id: 'review', approval: { message: 'Review' } }),
            dagNodeSchema.parse({
              id: 'group',
              loop_group: {
                until_bash: '[ $check.output.decision = "approve" ]',
                max_iterations: 2,
                nodes: [
                  { id: 'work', prompt: 'Work' },
                  { id: 'check', depends_on: ['work'], approval: { message: 'Review work' } },
                ],
              },
            }),
          ],
        },
      })
    );
    expect(
      persistedEvents(store).find(
        event => event.event_type === 'node_failed' && event.step_name === 'group'
      )?.data?.error
    ).toContain('Body provider unavailable');
  });

  for (const kind of ['loop', 'loop_group', 'body_gate'] as const) {
    it(`defers the second same-run ${kind} gate without prompting or terminalizing`, async () => {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'COMPLETE' };
        yield { type: 'result', sessionId: 'loop-session', cost: 0.25 };
      });
      const workflow = {
        name: 'concurrent-gates',
        nodes: ['first', 'second'].map(id =>
          dagNodeSchema.parse(
            kind === 'loop'
              ? {
                  id,
                  loop: {
                    prompt: 'Review',
                    until: 'COMPLETE',
                    interactive: true,
                    gate_message: 'Feedback?',
                    max_iterations: 2,
                  },
                }
              : kind === 'loop_group'
                ? {
                    id,
                    loop_group: {
                      until: 'COMPLETE',
                      interactive: true,
                      gate_message: 'Feedback?',
                      max_iterations: 2,
                      nodes: [{ id: 'work', prompt: 'Review' }],
                    },
                  }
                : {
                    id,
                    loop_group: {
                      until_bash: '[ $check.output.decision = "approve" ]',
                      max_iterations: 2,
                      nodes: [
                        { id: 'work', prompt: 'Review' },
                        {
                          id: 'check',
                          depends_on: ['work'],
                          approval: {
                            message: 'Review?',
                            decisions: [{ id: 'approve' }, { id: 'reject' }],
                          },
                        },
                      ],
                    },
                  }
          )
        ),
      };
      const runId = `concurrent-${kind}`;
      const store = createEscalationStore(runId);
      const platform = createMockPlatform();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform,
          cwd: testDir,
          workflow,
          workflowRun: makeWorkflowRun(runId),
        })
      );
      const approval = store.getState().metadata.approval;
      if (!isApprovalContext(approval)) throw new Error('Missing admitted gate');
      const deferredId = approval.nodeId === 'first' ? 'second' : 'first';
      const prompts = () =>
        platform.sendMessage.mock.calls.filter(
          ([, message]) =>
            message.includes('**Input required**') || message.includes('**Approval required**')
        );
      expect(prompts()).toHaveLength(1);
      const deferredEvents = persistedEvents(store).filter(
        event => event.step_name === deferredId || event.step_name === `${deferredId}.check`
      );
      expect(deferredEvents.some(event => event.event_type === 'node_started')).toBe(true);
      expect(
        deferredEvents.some(event => ['node_completed', 'node_failed'].includes(event.event_type))
      ).toBe(false);
      expect(deferredEvents.some(event => event.event_type === 'node_suspended')).toBe(
        kind === 'loop' ||
          deferredEvents.some(
            event =>
              event.step_name === `${deferredId}.check` && event.event_type === 'node_started'
          )
      );
      const usageEvents = deferredEvents.filter(
        event => event.event_type === 'node_deferred_usage'
      );
      expect(usageEvents).toHaveLength(kind === 'loop' ? 1 : 0);
      if (kind === 'loop') expect(usageEvents[0]?.data?.cost_usd).toBe(0.25);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      // The deferred node already paid for its iteration; the run total keeps it.
      expect(runUsageWrites(store).at(-1)?.total_cost_usd).toBe(0.5);
      const resumedStore = createEscalationStore(runId);
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(resumedStore),
          platform,
          cwd: testDir,
          workflow,
          workflowRun: makeWorkflowRun(runId, {
            metadata: { approval: { ...approval, resolved: 'approved' } },
          }),
          priorCompletedNodes: new Map([[approval.nodeId, { output: 'COMPLETE' }]]),
        })
      );
      expect(prompts()).toHaveLength(2);
      expect(resumedStore.getState().metadata.approval).toMatchObject({ nodeId: deferredId });
    });
  }

  it.each([false, true])(
    'durably records a qualified deferred loop (storage rejection=%s)',
    async rejectWrite => {
      const runId = 'nested-deferred-loop';
      const store = createEscalationStore(runId);
      let releaseGate = () => {};
      const gatePaused = new Promise<void>(resolve => {
        releaseGate = resolve;
      });
      const pause = store.pauseWorkflowRun;
      store.pauseWorkflowRun = mock(async (...args) => {
        if (args[1].nodeId === 'review') await gatePaused;
        const result = await pause(...args);
        if (args[1].nodeId === 'first') releaseGate();
        return result;
      });
      const persist = store.persistWorkflowEvent;
      store.persistWorkflowEvent = mock(async event => {
        if (rejectWrite && event.event_type === 'node_deferred_usage')
          throw new Error('usage storage offline');
        await persist(event);
      });
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'COMPLETE' };
        yield { type: 'result', sessionId: 'loop-session', cost: 0.25 };
      });
      const execute = executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform: createMockPlatform(),
          cwd: testDir,
          workflowRun: makeWorkflowRun(runId),
          workflow: {
            name: 'nested-gates',
            nodes: [
              dagNodeSchema.parse({ id: 'first', approval: { message: 'Review' } }),
              dagNodeSchema.parse({
                id: 'group',
                loop_group: {
                  until: 'COMPLETE',
                  max_iterations: 1,
                  nodes: [
                    {
                      id: 'review',
                      loop: {
                        prompt: 'Review',
                        until: 'COMPLETE',
                        interactive: true,
                        gate_message: 'Feedback?',
                        max_iterations: 2,
                      },
                    },
                  ],
                },
              }),
            ],
          },
        })
      );
      if (rejectWrite) {
        await expect(execute).resolves.toEqual({
          kind: 'pause',
          error: 'Could not persist node_deferred_usage for group.review: usage storage offline',
        });
      } else {
        await execute;
        const usage = persistedEvents(store).filter(
          event => event.event_type === 'node_deferred_usage'
        );
        expect(usage).toHaveLength(1);
        expect(
          persistedEvents(store).some(
            event => event.step_name === 'group.review' && event.event_type === 'node_suspended'
          )
        ).toBe(true);
        expect(usage[0]).toMatchObject({
          step_name: 'group.review',
          data: { accounting: 'node', cost_usd: 0.25 },
        });
        expect(
          persistedEvents(store).some(
            event =>
              event.step_name === 'group.review' &&
              ['node_completed', 'node_failed'].includes(event.event_type)
          )
        ).toBe(false);
      }
      expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    }
  );

  it('defers a loop-group terminal wait that loses the paused slot to a sibling gate', async () => {
    const runId = 'deferred-body-wait';
    const store = createEscalationStore(runId);
    let gatePaused = () => {};
    const paused = new Promise<void>(resolve => {
      gatePaused = resolve;
    });
    const pause = store.pauseWorkflowRun;
    store.pauseWorkflowRun = mock(async (id, context, extra, suspension) => {
      await pause(id, context, extra, suspension);
      gatePaused();
    });
    // The real store only pauses a running run for a wait.
    const pauseForWait = store.pauseWorkflowRunForWait;
    store.pauseWorkflowRunForWait = mock(async (id, context, event) => {
      if (store.getState().status !== 'running') {
        throw new WorkflowRunPauseConflictError(id);
      }
      await pauseForWait(id, context, event);
    });
    mockSendQueryDag.mockImplementation(async function* () {
      await paused;
      yield { type: 'agent_message_chunk', text: 'not yet' };
      yield { type: 'result', sessionId: 'body-session' };
    });
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflowRun: makeWorkflowRun(runId),
        workflow: {
          name: 'deferred-body-wait',
          nodes: [
            dagNodeSchema.parse({ id: 'review', approval: { message: 'Review' } }),
            dagNodeSchema.parse({
              id: 'group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                nodes: [
                  { id: 'work', prompt: 'Work' },
                  { id: 'hold', depends_on: ['work'], wait: { duration_ms: 60_000 } },
                ],
              },
            }),
          ],
        },
      })
    );
    // The group stops at its deferred wait instead of re-running the paid body.
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(store.getState().metadata.approval).toMatchObject({ nodeId: 'review' });
    expect(
      persistedEvents(store).some(
        event =>
          event.step_name === 'group' &&
          ['node_completed', 'node_failed', 'node_suspended'].includes(event.event_type)
      )
    ).toBe(false);
  });

  /** Store whose pauseWorkflowRun loses the CAS: the run was externally
   *  transitioned (e.g. a killed CLI's signal cleanup marked it failed) in the
   *  window between gate raise and pause commit. getWorkflowRunStatus reports
   *  'running' until the pause attempt, then the external 'failed'. */
  function createExternallyFailedStore(
    externalStatus: 'failed' | 'cancelled' = 'failed'
  ): MockWorkflowStore {
    const store = createMockStore();
    let pauseAttempted = false;
    store.pauseWorkflowRun = mock(() => {
      pauseAttempted = true;
      return Promise.reject(new WorkflowRunPauseConflictError('dag-test-run-id'));
    });
    store.getWorkflowRunStatus = mock(() =>
      Promise.resolve(pauseAttempted ? externalStatus : ('running' as const))
    );
    return store;
  }

  it.each(['failed', 'cancelled'] as const)(
    'approval gate that loses the pause CAS to external %s halts cleanly',
    async status => {
      const store = createExternallyFailedStore(status);
      const mockDeps = createMockDeps(store);
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      const emitted: string[] = [];
      const unsubscribe = getWorkflowEventEmitter().subscribe((event: WorkflowEmitterEvent) => {
        if ('runId' in event && event.runId === workflowRun.id) emitted.push(event.type);
      });

      try {
        await executeDagWorkflow(
          dagOptions({
            deps: mockDeps,
            platform,
            conversationId: 'conv-pause-race',
            cwd: testDir,
            workflow: {
              name: 'pause-race-approval',
              nodes: [
                {
                  id: 'review',
                  kind: 'gate',
                  message: 'Approve this plan?',
                  decisions: [{ id: 'approve' }, { id: 'reject' }],
                  captureResponse: false,
                  decisionsAuthored: false,
                },
              ],
            },
            workflowRun,
          })
        );
      } finally {
        unsubscribe();
      }

      expect(
        platform.sendMessage.mock.calls.some(([, message]) =>
          message.includes('**Approval required**')
        )
      ).toBe(false);
      // The gate never actually paused — no approval_pending signal to live UIs.
      expect(emitted).not.toContain('approval_pending');

      // The lost CAS must NOT cascade into a node failure or any terminal write —
      // the external transition owns the run's final state.
      const events = (
        store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
      ).mock.calls.map((c: unknown[]) => (c[0] as { event_type: string }).event_type);
      expect(events).not.toContain('node_failed');
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    }
  );

  it('interactive loop gate that loses the pause CAS halts cleanly', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Here is the plan. Please review.' };
      yield { type: 'result', sessionId: 'loop-session-race' };
    });

    const store = createExternallyFailedStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const emitted: string[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe((event: WorkflowEmitterEvent) => {
      if ('runId' in event && event.runId === workflowRun.id) emitted.push(event.type);
    });

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-pause-race-loop',
          cwd: testDir,
          workflow: {
            name: 'pause-race-loop',
            nodes: [
              {
                id: 'refine',
                kind: 'loop',
                loop: {
                  fresh_context: false,
                  prompt: 'User said: $LOOP_USER_INPUT. Refine the plan.',
                  until: 'APPROVED',
                  max_iterations: 10,
                  interactive: true,
                  gate_message: 'Review the plan and provide feedback.',
                },
              },
            ],
          },
          workflowRun,
        })
      );
    } finally {
      unsubscribe();
    }

    expect(emitted).not.toContain('approval_pending');
    const events = (
      store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
    ).mock.calls.map((c: unknown[]) => (c[0] as { event_type: string }).event_type);
    expect(events).not.toContain('node_failed');
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('interactive loop gate that loses the pause CAS keeps unknown-only usage', async () => {
    // An unknown resume baseline leaves both cost and tokens unreported for the query.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Here is the plan.' };
      yield { type: 'result', sessionId: 'loop-session-race', tokensUnknown: true };
    });
    const store = createExternallyFailedStore();
    const workflowRun = makeWorkflowRun();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'pause-race-unknown-loop',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Refine the plan.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review the plan.',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(
      persistedEvents(store).filter(event => event.event_type === 'node_deferred_usage')
    ).toHaveLength(1);
    const snapshot = await foldDagResumeSnapshot(persistedEvents(store), workflowRun.id);
    expect(snapshot.tokensUnknown).toBe(true);
    expect(snapshot.tokens).toBeUndefined();
  });

  it('interactive loop-group gate that loses the pause CAS keeps only its started record', async () => {
    const store = createExternallyFailedStore();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        conversationId: 'conv-pause-race-loop-group',
        cwd: testDir,
        workflow: {
          name: 'pause-race-loop-group',
          nodes: [
            dagNodeSchema.parse({
              id: 'refine',
              loop_group: {
                until: 'APPROVED',
                max_iterations: 2,
                interactive: true,
                gate_message: 'Review the result.',
                nodes: [{ id: 'work', bash: 'printf result' }],
              },
            }),
          ],
        },
        workflowRun,
      })
    );

    const groupEvents = (
      store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
    ).mock.calls
      .map(
        (call: unknown[]) =>
          call[0] as {
            event_type: string;
            step_name?: string | null;
          }
      )
      .filter(event => event.step_name === 'refine')
      .map(event => event.event_type);
    expect(groupEvents).toContain('node_started');
    expect(groupEvents).not.toContain('node_suspended');
    expect(groupEvents).not.toContain('node_failed');
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('workflow: child-pause gate that loses the pause CAS halts cleanly (#2489)', async () => {
    // Unlike the other three gate types, this one never calls ctx.runChildWorkflow —
    // findChildRuns already reports an existing PAUSED child, so executeWorkflowNode
    // re-pauses the parent directly via pauseParentOnChild. Before #2489 this call site
    // bypassed pauseGateRespectingExternalTransition, so a lost CAS here threw straight
    // into a node_failed instead of tolerating the external transition like the other
    // three sites. This proves the unification: the same tolerant outcome now holds.
    const store = createExternallyFailedStore();
    store.findChildRuns = mock(() =>
      Promise.resolve([
        makeWorkflowRun('child-run-id', {
          workflow_name: 'child-wf',
          status: 'paused',
          metadata: { parent_node_id: 'sub' },
        }),
      ])
    );
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const emitted: string[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe((event: WorkflowEmitterEvent) => {
      if ('runId' in event && event.runId === workflowRun.id) emitted.push(event.type);
    });

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-pause-race-child',
          cwd: testDir,
          workflow: {
            name: 'pause-race-child',
            nodes: [{ id: 'sub', kind: 'workflow', workflow: 'child-wf' } as DagNode],
          },
          workflowRun,
          runChildWorkflow: async () => {
            throw new Error(
              'runChildWorkflow should not be called — an existing paused child was found'
            );
          },
        })
      );
    } finally {
      unsubscribe();
    }

    // The re-pause never actually landed — no approval_pending signal to live UIs, and
    // no stale "Blocked on sub-run" chat notification (gated on the pause having
    // succeeded) — unlike the run-stopped notice below, which is unrelated to this
    // gate and fires generically whenever the between-layer status check observes the
    // run already left 'running'.
    expect(emitted).not.toContain('approval_pending');
    const sentMessages = platform.sendMessage.mock.calls.map(([, message]) => message);
    expect(sentMessages.some(message => message.includes('Blocked on sub-run'))).toBe(false);
    const events = (
      store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
    ).mock.calls.map((c: unknown[]) => (c[0] as { event_type: string }).event_type);
    expect(events).not.toContain('node_failed');
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('does not mistake a store failure for deferral when a sibling holds the paused slot', async () => {
    const store = createMockStore();
    let attempted = false;
    store.pauseWorkflowRun = mock(async () => {
      attempted = true;
      throw new Error('database unavailable');
    });
    store.getWorkflowRunStatus = mock(async () => (attempted ? 'paused' : 'running'));
    store.getWorkflowRun = mock(async () =>
      makeWorkflowRun('store-failure', {
        status: 'paused',
        metadata: { approval: { nodeId: 'other', message: 'Other review', type: 'approval' } },
      })
    );
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflowRun: makeWorkflowRun('store-failure'),
        workflow: {
          name: 'store-failure',
          nodes: [dagNodeSchema.parse({ id: 'review', approval: { message: 'Review' } })],
        },
      })
    );
    expect(
      persistedEvents(store).find(event => event.event_type === 'node_failed')?.data?.error
    ).toContain('database unavailable');
  });

  it('gate pause failure with the run still running stays a genuine node failure', async () => {
    const store = createMockStore();
    // Pause fails but the run is still 'running' (default mock) — a real store
    // failure, not an external transition. Legacy behavior must hold: the node
    // fails and the run is marked failed.
    store.pauseWorkflowRun = mock(() => Promise.reject(new Error('database connection lost')));
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-pause-genuine-failure',
        cwd: testDir,
        workflow: {
          name: 'pause-genuine-failure',
          nodes: [
            {
              id: 'review',
              kind: 'gate',
              message: 'Approve this plan?',
              decisions: [{ id: 'approve' }, { id: 'reject' }],
              captureResponse: false,
              decisionsAuthored: false,
            },
          ],
        },
        workflowRun,
      })
    );

    const events = (
      store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
    ).mock.calls.map((c: unknown[]) => (c[0] as { event_type: string }).event_type);
    expect(events).toContain('node_failed');
    expect(store.failWorkflowRun).toHaveBeenCalled();
  });
});
