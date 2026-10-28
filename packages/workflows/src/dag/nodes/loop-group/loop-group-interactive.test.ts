// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  type MockWorkflowStore,
  createMockStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  persistedEvents,
  failedLoopIterations,
  dagOptions,
  makeWorkflowRun,
  expectLoopGateEvidence,
} from '../../test-utils';
import { ParentStatusReadError } from '../../../parent-status-read';
import { executeDagWorkflow } from '../../../dag-executor';
import type { DagNode } from '../../../schemas';
import type { IWorkflowStore } from '../../../store';

describe('interactive loop_group gate and resume', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-loopgroup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it.each([0, 2])(
    'retains %i prior iterations when the pre-start status read throws',
    async prior => {
      const store = createMockStore();
      const error = new Error('Status read failed');
      let rejected = false;
      store.getWorkflowRunStatus.mockImplementation(async () => {
        const groupStarted = persistedEvents(store).some(
          event => event.event_type === 'node_started' && event.step_name === 'grp'
        );
        if (groupStarted && !rejected) {
          rejected = true;
          throw error;
        }
        return 'running';
      });
      const options = dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflowRun: makeWorkflowRun('group-pre-start-throw', {
          ...(prior > 0
            ? {
                metadata: {
                  approval: {
                    type: 'interactive_loop',
                    nodeId: 'grp',
                    iteration: prior,
                    message: 'Review.',
                    completionSignaled: false,
                    signaledOutput: null,
                  },
                  loop_feedback_given: true,
                  loop_user_input: 'Continue.',
                },
              }
            : {}),
        }),
        workflow: {
          name: 'group-pre-start-throw',
          nodes: [
            {
              id: 'grp',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                fresh_context: true,
                nodes: [{ id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'Work.' } }],
              },
            },
          ],
        },
      });
      const interruption = await executeDagWorkflow(options).catch((cause: unknown) => cause);
      expect(interruption).toBeInstanceOf(ParentStatusReadError);
      expect(interruption).toMatchObject({
        workflowRunId: options.workflowRun.id,
        nodeId: 'grp',
        cause: error,
      });
      expect(mockSendQueryDag).not.toHaveBeenCalled();
      expect(
        persistedEvents(store).filter(event => event.event_type === 'loop_iteration_started')
      ).toEqual([]);
      expect(persistedEvents(store).filter(event => event.event_type === 'node_failed')).toEqual(
        []
      );
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
      if (prior > 0) {
        expect(options.workflowRun.metadata.approval).toMatchObject({ iteration: prior });
        expect(options.workflowRun.metadata.loop_user_input).toBe('Continue.');
      }

      mockSendQueryDag.mockImplementationOnce(async function* () {
        yield { type: 'agent_message_chunk', text: 'DONE' };
        yield { type: 'result', sessionId: 'group-recovered' };
      });
      await executeDagWorkflow(options);
      expect(
        persistedEvents(store)
          .filter(event => event.event_type === 'loop_iteration_started')
          .map(event => event.data?.iteration)
      ).toEqual([prior + 1]);
    }
  );

  describe('legacy interactive group at max_iterations (#4290)', () => {
    const runGroupAtCap = async (
      loopUserInput: string,
      feedbackGiven: boolean,
      { iteration = 1, reply = 'Retried. <promise>APPROVED</promise>' } = {}
    ) => {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: reply };
        yield { type: 'result', sessionId: 'grp-session-2' };
      });
      const mockDeps = createMockDeps();
      const nodes: DagNode[] = [
        {
          id: 'grp',
          kind: 'loop_group',
          loop_group: {
            until: 'APPROVED',
            max_iterations: 1,
            fresh_context: true,
            interactive: true,
            gate_message: 'Review.',
            nodes: [
              {
                id: 'work',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'Feedback: $LOOP_USER_INPUT' },
                depends_on: [],
              },
            ],
          },
          depends_on: [],
        },
      ];
      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform: createMockPlatform(),
          conversationId: 'conv-lg-feedback-at-cap',
          cwd: testDir,
          workflow: { name: 'lg-feedback-at-cap', nodes },
          workflowRun: makeWorkflowRun('lg-feedback-at-cap', {
            metadata: {
              approval: {
                type: 'interactive_loop',
                nodeId: 'grp',
                iteration,
                message: 'Review.',
                completionSignaled: false,
                signaledOutput: null,
              },
              loop_user_input: loopUserInput,
              loop_feedback_given: feedbackGiven,
            },
          }),
        })
      );
      return mockDeps.store;
    };

    it('runs one iteration past max_iterations when the final gate is answered with feedback', async () => {
      const store = await runGroupAtCap('retry with X', true);

      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      expect(mockSendQueryDag.mock.calls[0][0] as string).toContain('retry with X');
      expect(
        persistedEvents(store).some(e => e.event_type === 'node_completed' && e.step_name === 'grp')
      ).toBe(true);
      expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
    });

    it('fails at max_iterations when the final non-completing gate is approved without feedback', async () => {
      const store = await runGroupAtCap('Approved', false);

      expect(mockSendQueryDag.mock.calls.length).toBe(0);
      expect(store.persistWorkflowEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'node_failed',
          step_name: 'grp',
          data: expect.objectContaining({ failure_kind: 'max_iterations' }),
        })
      );
    });

    it('runs exactly one iteration past max_iterations per feedback answer when it does not complete', async () => {
      const extra = await runGroupAtCap('retry with X', true, { reply: 'Still working on it.' });
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      expect(extra.completeWorkflowRun).not.toHaveBeenCalled();
      expect(extra.pauseWorkflowRun.mock.calls[0]?.[1]).toMatchObject({
        type: 'interactive_loop',
        nodeId: 'grp',
        iteration: 2,
      });
      expect(
        extra.createWorkflowEvent.mock.calls
          .map(([e]) => e)
          .find(e => e.event_type === 'loop_iteration_started')?.data
      ).toMatchObject({ iteration: 2, maxIterations: 2 });

      mockSendQueryDag.mockClear();
      let approved: MockWorkflowStore | undefined;
      const loopIterations = await failedLoopIterations('grp', async () => {
        approved = await runGroupAtCap('Approved', false, { iteration: 2 });
      });
      expect(mockSendQueryDag.mock.calls.length).toBe(0);
      expect(approved?.persistWorkflowEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'node_failed',
          step_name: 'grp',
          data: expect.objectContaining({ failure_kind: 'max_iterations' }),
        })
      );
      expect(loopIterations).toBe(2);
    });
  });

  // --- Dimension 4: interactive gate + resume ---

  it('INTERACTIVE: interactive loop_group pauses at the gate after iteration 1', async () => {
    // Fresh interactive loop_group: iteration 1 emits no signal → pauses at the gate.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'iteration 1 draft, awaiting review' };
      yield { type: 'result', sessionId: 'lg-gate-sess-1' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-interactive');

    const nodes: DagNode[] = [
      {
        id: 'refine',
        kind: 'loop_group',
        loop_group: {
          until: 'APPROVED',
          max_iterations: 5,
          fresh_context: false,
          interactive: true,
          gate_message: 'Review the result.',
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'produce a draft' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-interactive', nodes },
        workflowRun,
      })
    );

    // One AI call (iteration 1), then paused.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const pauseCalls = (mockDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>)
      .mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'interactive_loop',
      nodeId: 'refine',
      iteration: 1,
      completionSignaled: false,
      signaledOutput: null,
    });
    const pausedGroupMessage = (pauseCalls[0][1] as { message: string }).message;
    expect(pausedGroupMessage).toContain('No completion condition met');
    expect(pausedGroupMessage).toContain('Review the result.');
  });

  it('INTERACTIVE: loop_group gate attributes completion to until_bash instead of an absent signal', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Checks pass, but no prose sentinel.' };
      yield { type: 'result', sessionId: 'lg-bash-gate' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: {
          name: 'lg-bash-gate',
          nodes: [
            {
              id: 'refine',
              kind: 'loop_group',
              loop_group: {
                until: 'UNTIL_DONE',
                until_bash: 'exit 0',
                max_iterations: 3,
                fresh_context: false,
                interactive: true,
                gate_message: 'Review the checks.',
                nodes: [
                  {
                    id: 'work',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'validate' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('lg-bash-gate'),
      })
    );

    expectLoopGateEvidence(
      mockDeps.store,
      platform,
      '✅ Completion condition met via `until_bash`.',
      true
    );
    const pausedMessage = mockDeps.store.pauseWorkflowRun.mock.calls[0][1].message;
    expect(pausedMessage).not.toContain('`until` signal (`UNTIL_DONE`)');
  });

  it('INTERACTIVE: loop_group gate persists signal state when iteration 1 signals (#2074)', async () => {
    // Signal on iteration 1 of a fresh interactive loop_group (no signal_completes):
    // still gates, but the pause carries completionSignaled + signaledOutput so a
    // bare approve can finalize at resume.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'validation PASS\nAPPROVED' };
      yield { type: 'result', sessionId: 'lg-sig-sess-1' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-signal-gate');

    const nodes: DagNode[] = [
      {
        id: 'refine',
        kind: 'loop_group',
        loop_group: {
          until: 'APPROVED',
          max_iterations: 5,
          fresh_context: false,
          interactive: true,
          gate_message: 'Review the result.',
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'validate' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-signal-gate', nodes },
        workflowRun,
      })
    );

    const pauseCalls = (mockDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>)
      .mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'interactive_loop',
      nodeId: 'refine',
      iteration: 1,
      completionSignaled: true,
    });
    expect(String(pauseCalls[0][1].signaledOutput)).toContain('validation PASS');
    expect(String(pauseCalls[0][1].message)).toContain(
      'Completion condition met via `until` signal (`APPROVED`)'
    );
    // No `signaledTokens` (unlike the plain-loop gate): the group's finalize path has
    // no consumer for it, because the body's own rows already persisted this
    // iteration's usage before the pause (#2333).
    expect(pauseCalls[0][1]).not.toHaveProperty('signaledTokens');
  });

  it('INTERACTIVE: loop_group signal_completes completes on a first-iteration signal without gating (#2074 B)', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'validation PASS\nAPPROVED' };
      yield { type: 'result', sessionId: 'lg-sc-sess-1' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-signal-completes');

    const nodes: DagNode[] = [
      {
        id: 'refine',
        kind: 'loop_group',
        loop_group: {
          until: 'APPROVED',
          max_iterations: 5,
          fresh_context: false,
          interactive: true,
          gate_message: 'Review the result.',
          signal_completes: true,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'validate' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-signal-completes', nodes },
        workflowRun,
      })
    );

    const pauseCalls = (mockDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>)
      .mock.calls;
    expect(pauseCalls.length).toBe(0);
    const eventCalls = (
      mockDeps.store.createWorkflowEvent as Mock<
        (e: {
          event_type: string;
          step_name: string;
          data: Record<string, unknown>;
        }) => Promise<void>
      >
    ).mock.calls;
    const completed = eventCalls.filter(
      c => c[0].event_type === 'node_completed' && c[0].step_name === 'refine'
    );
    expect(completed.length).toBe(1);
  });

  it('INTERACTIVE: loop_group finalizes at resume from persisted signaledOutput on a bare approve (#2074 C)', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should never run' };
      yield { type: 'result', sessionId: 'never' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-finalize', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'lg-sig-sess-1',
          sessionProvider: 'claude',
          message: 'gate',
          completionSignaled: true,
          signaledOutput: 'GROUP REPORT',
        },
        loop_user_input: 'Approved',
        loop_feedback_given: false,
      },
    });

    const nodes: DagNode[] = [
      {
        id: 'refine',
        kind: 'loop_group',
        loop_group: {
          until: 'APPROVED',
          max_iterations: 5,
          fresh_context: false,
          interactive: true,
          gate_message: 'Review the result.',
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'validate' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-finalize', nodes },
        workflowRun,
      })
    );

    // No body iteration ran — the group finalized from the persisted output.
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    const eventCalls = (
      mockDeps.store.createWorkflowEvent as Mock<
        (e: {
          event_type: string;
          step_name: string;
          data: Record<string, unknown>;
        }) => Promise<void>
      >
    ).mock.calls;
    const completed = eventCalls.filter(
      c => c[0].event_type === 'node_completed' && c[0].step_name === 'refine'
    );
    expect(completed.length).toBe(1);
    expect(completed[0][0].data.node_output).toBe('GROUP REPORT');
  });

  it('INTERACTIVE: gate-finalize keeps the terminal sink payload, so both completion routes share one field-access tier (#2637)', async () => {
    // Round trip. A naturally-completed group attaches its sink's structuredOutput
    // (tier-2 lenient field access — an absent key resolves to ''); before this fix
    // the bare-approve finalize returned text only, landing the SAME iteration output
    // in the strict text-parse tier, where the same absent key throws and fails the
    // downstream node. One node type, two completion routes, one contract.
    const payload = { verdict: 'ship <promise>APPROVED</promise>' };
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'prose' };
      yield { type: 'result', sessionId: 'lg-struct-1', structuredOutput: payload };
    });
    const workflow = {
      name: 'lg-finalize-struct',
      nodes: [
        {
          id: 'refine',
          kind: 'loop_group',
          loop_group: {
            until: 'APPROVED',
            max_iterations: 5,
            fresh_context: false,
            interactive: true,
            gate_message: 'Review.',
            nodes: [
              {
                id: 'work',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'produce verdict' },
                depends_on: [],
                output_format: { type: 'object', properties: { verdict: { type: 'string' } } },
              },
            ],
          },
          depends_on: [],
        },
        // Reads a key the payload does NOT carry: lenient tier → '', strict tier → throw.
        {
          id: 'after',
          kind: 'exec',
          runtime: 'sh',
          script: 'echo "[$refine.output.confidence]"',
          depends_on: ['refine'],
        },
      ] as DagNode[],
    };

    const pausingDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: pausingDeps,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('lg-struct-pause'),
      })
    );
    const pauseCalls = (
      pausingDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    const approval = pauseCalls[0][1] as { signaledStructuredOutput?: unknown };
    expect(approval.signaledStructuredOutput).toEqual(payload);

    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should never run' };
      yield { type: 'result', sessionId: 'never' };
    });
    const resumingDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: resumingDeps,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('lg-struct-resume', {
          metadata: {
            approval: { ...approval },
            loop_user_input: 'Approved',
            loop_feedback_given: false,
          },
        }),
      })
    );
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    const eventCalls2 = (
      resumingDeps.store.createWorkflowEvent as Mock<
        (e: {
          event_type: string;
          step_name: string;
          data: Record<string, unknown>;
        }) => Promise<void>
      >
    ).mock.calls;
    const groupCompleted = eventCalls2.filter(
      c => c[0].event_type === 'node_completed' && c[0].step_name === 'refine'
    );
    expect(groupCompleted.length).toBe(1);
    expect(groupCompleted[0][0].data.structured_output).toEqual(payload);
    // The downstream consumer ran on the lenient tier — the absent optional key
    // resolved to empty (shell-quoted into the bash body as '') instead of throwing
    // missing-key and failing the node, which is what the strict text-parse tier does.
    const afterCompleted = eventCalls2.filter(
      c => c[0].event_type === 'node_completed' && c[0].step_name === 'after'
    );
    expect(afterCompleted.length).toBe(1);
    expect(afterCompleted[0][0].data.node_output).toBe("['']");
  });

  it('INTERACTIVE: resumed loop_group continues from the next iteration and completes', async () => {
    // Two-call pattern (mirrors the loop: resume test): call 1 pauses at the gate after
    // iteration 1 (no signal). Call 2 resumes with metadata.approval populated; iteration 2
    // emits APPROVED → completes.
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'iter1 draft, not approved' };
      yield { type: 'result', sessionId: 'lg-resume-sess-1' };
    });

    const mockDeps1 = createMockDeps();
    const platform1 = createMockPlatform();
    const freshRun = makeWorkflowRun('lg-resume-fresh');

    const workflow = {
      name: 'lg-resume',
      nodes: [
        {
          id: 'refine',
          kind: 'loop_group',
          loop_group: {
            until: 'APPROVED',
            max_iterations: 5,
            fresh_context: false,
            interactive: true,
            gate_message: 'Review.',
            nodes: [
              {
                id: 'work',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'User: $LOOP_USER_INPUT. Draft or APPROVED.' },
                depends_on: [],
              },
            ],
          },
          depends_on: [],
        },
      ] as DagNode[],
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps1,
        platform: platform1,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow,
        workflowRun: freshRun,
      })
    );
    // Call 1 paused at iteration 1, persisting the body's session cursor so a
    // fresh_context: false resume can continue the same conversation.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const pauseCalls1 = (
      mockDeps1.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>
    ).mock.calls;
    expect(pauseCalls1.length).toBe(1);
    expect(pauseCalls1[0]?.[1]?.sessionId).toBe('lg-resume-sess-1');
    // The pause payload tags the session with its provider (#1992) so the resume
    // never threads it into a node that resolves to a different provider.
    expect(pauseCalls1[0]?.[1]?.sessionProvider).toBe('claude');

    // ---- Call 2: resume with metadata.approval carrying iter 1 + user input.
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'all good, shipping\nAPPROVED' };
      yield { type: 'result', sessionId: 'lg-resume-sess-2' };
    });
    const mockDeps2 = createMockDeps();
    const platform2 = createMockPlatform();
    const resumedRun = makeWorkflowRun('lg-resume-resume', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'lg-resume-sess-1',
          sessionProvider: 'claude',
          message: 'Review.',
        },
        loop_user_input: 'looks great',
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps2,
        platform: platform2,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow,
        workflowRun: resumedRun,
      })
    );

    // Resumed iteration (iteration 2) ran once more and completed via APPROVED.
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // The resumed iteration's prompt carried the user input via $LOOP_USER_INPUT.
    const resumePrompt = mockSendQueryDag.mock.calls[1][0] as string;
    expect(resumePrompt).toContain('looks great');
    // fresh_context: false — the resumed iteration continues the PRE-PAUSE session
    // (restored from ApprovalContext.sessionId), not a fresh one.
    expect(mockSendQueryDag.mock.calls[1][2]).toBe('lg-resume-sess-1');
    // Resume completed (no second pause at the gate).
    const pauseCalls2 = (
      mockDeps2.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>
    ).mock.calls;
    expect(pauseCalls2.length).toBe(0);
  });

  it('INTERACTIVE resume: $LOOP_PREV resolves to the prior iteration real body output (#2748)', async () => {
    // On interactive resume, executeLoopGroupNode is a fresh call whose local
    // loopPrevOutputs starts undefined — but the paused run's iteration-1 body output
    // was already persisted as a `refine.work` node_completed row. The resumed
    // executeDagWorkflow call re-derives loopPrevOutputs from that persisted row (via
    // outerNodeOutputs, pre-populated from the priorCompletedNodes snapshot passed in
    // below), so $LOOP_PREV.<bodyNode>.output resolves to the real prior output, not ''.
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'iter1 body output XYZ' };
      yield { type: 'result', sessionId: 'lg-prev-sess-1' };
    });

    const mockDeps1 = createMockDeps();
    const workflow = {
      name: 'lg-resume-prev',
      nodes: [
        {
          id: 'refine',
          kind: 'loop_group',
          loop_group: {
            until: 'APPROVED',
            max_iterations: 5,
            fresh_context: false,
            interactive: true,
            gate_message: 'Review.',
            nodes: [
              {
                id: 'work',
                kind: 'agent',
                source: {
                  kind: 'inline',
                  prompt:
                    'PREV=<<$LOOP_PREV.work.output>> USER=$LOOP_USER_INPUT. Draft or APPROVED.',
                },
                depends_on: [],
              },
            ],
          },
          depends_on: [],
        },
      ] as DagNode[],
    };
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps1,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('lg-prev-fresh'),
      })
    );

    // Iteration 1 prompt: $LOOP_PREV resolved to '' (no prior iteration in this process).
    const iter1Prompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(iter1Prompt).toContain('PREV=<<>>');

    // ---- Resume: iteration 2. priorCompletedNodes carries the persisted iteration-1
    // body row (the `refine.work` node_completed row a real DB would return from
    // getDagResumeSnapshot) — this is what a real resume threads in via
    // hydrateResumableRun before calling executeDagWorkflow.
    const priorCompletedNodes = new Map([['refine.work', { output: 'iter1 body output XYZ' }]]);
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'final\nAPPROVED' };
      yield { type: 'result', sessionId: 'lg-prev-sess-2' };
    });
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('lg-prev-resume', {
          metadata: {
            approval: {
              type: 'interactive_loop',
              nodeId: 'refine',
              iteration: 1,
              sessionId: 'lg-prev-sess-1',
              message: 'Review.',
            },
            loop_user_input: 'ok',
          },
        }),
        priorCompletedNodes,
      })
    );

    // Resumed iteration 2: $LOOP_PREV resolves to the real persisted iteration-1 output.
    const resumePrompt = mockSendQueryDag.mock.calls[1][0] as string;
    expect(resumePrompt).toContain('PREV=<<iter1 body output XYZ>>');
    expect(resumePrompt).toContain('USER=ok');
  });

  it.each(['extra', 'details.extra'])(
    'INTERACTIVE resume: re-derives the body contract for undeclared $LOOP_PREV path %s',
    async field => {
      const store = createMockStore();
      const mockDeps = createMockDeps(store);
      // `work` satisfies its current schema, so `consumer` runs and resolves the reference.
      mockSendQueryDag.mockImplementation(async function* () {
        yield {
          type: 'result',
          sessionId: 'lg-declared-fields',
          structuredOutput: { type: 'BUG' },
        };
      });

      // The row's own contract authorizes `extra`, as one written under an older schema
      // would; the body node's current definition still decides on resume.
      const priorCompletedNodes = new Map([
        [
          'refine.work',
          {
            output: '{"type":"BUG","extra":"x","details":{"extra":"x"}}',
            declaredOutputPaths: [['type'], ['extra'], ['details'], ['details', 'extra']],
          },
        ],
      ]);

      const workflow: { name: string; nodes: DagNode[] } = {
        name: 'lg-resume-declared-fields',
        nodes: [
          {
            id: 'refine',
            kind: 'loop_group',
            loop_group: {
              until: 'DONE',
              max_iterations: 5,
              fresh_context: false,
              interactive: true,
              gate_message: 'Review.',
              nodes: [
                {
                  id: 'work',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'produce json' },
                  output_format: {
                    type: 'object',
                    properties: {
                      type: { type: 'string' },
                      details: { type: 'object', properties: { type: { type: 'string' } } },
                    },
                    required: ['type'],
                  },
                  depends_on: [],
                },
                {
                  id: 'consumer',
                  kind: 'agent',
                  source: {
                    kind: 'inline',
                    prompt: `extra=[$LOOP_PREV.work.output.${field}]`,
                  },
                  depends_on: ['work'],
                },
              ],
            },
            depends_on: [],
          },
        ],
      };

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          conversationId: 'conv-lg-declared-fields',
          cwd: testDir,
          workflow,
          workflowRun: makeWorkflowRun('lg-resume-declared-fields', {
            metadata: {
              approval: {
                type: 'interactive_loop',
                nodeId: 'refine',
                iteration: 1,
                message: 'Review.',
              },
              loop_user_input: '',
            },
          }),
          priorCompletedNodes,
        })
      );

      expect(
        persistedEvents(store).some(
          event =>
            event.event_type === 'node_failed' &&
            String(event.data?.error).includes(`$LOOP_PREV.work.output.${field}`)
        )
      ).toBe(true);
    }
  );

  it('INTERACTIVE resume: $LOOP_PREV resolves an oversized (>32KB) prior body output via the spill path (#2748)', async () => {
    // Mirrors 'reads oversized $LOOP_PREV output from the run-owned spill directory'
    // (same file, in-process case) but crosses a real pause/resume boundary: a bash
    // body node spills a real oversized output on iteration 1, the group pauses, then
    // a SEPARATE resumed executeDagWorkflow call — seeded with priorCompletedNodes the
    // way a real resume threads it in via hydrateResumableRun — reads
    // $LOOP_PREV.work.output back and proves the full byte length survived the pause.
    const artifactsDir = join(testDir, 'lg-prev-large-artifacts');
    const logDir = join(testDir, 'lg-prev-large-logs');
    const paddingBytes = 40_000;
    const freshStore = createMockStore();

    const freshWorkflow = {
      name: 'lg-resume-prev-large',
      nodes: [
        {
          id: 'refine',
          kind: 'loop_group',
          loop_group: {
            until: 'DONE',
            max_iterations: 5,
            fresh_context: false,
            interactive: true,
            gate_message: 'Review.',
            nodes: [
              {
                id: 'work',
                kind: 'exec',
                runtime: 'sh',
                script: `head -c ${String(paddingBytes)} /dev/zero | tr "\\0" x`,
                depends_on: [],
              },
            ],
          },
          depends_on: [],
        },
      ] as DagNode[],
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(freshStore),
        conversationId: 'conv-lg-large',
        cwd: testDir,
        workflow: freshWorkflow,
        workflowRun: makeWorkflowRun('lg-prev-large-fresh'),
        artifactsDir,
        logDir,
      })
    );

    const freshEventCalls = (freshStore.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const bodyEvent = freshEventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'refine.work'
    );
    expect(bodyEvent).toBeDefined();
    if (!bodyEvent) throw new Error('Expected refine.work to complete on the fresh pass');
    const bodyData = bodyEvent[0].data as {
      node_output_truncated: boolean;
      node_output_spill_path: string;
    };
    expect(bodyData.node_output_truncated).toBe(true);
    const spilledFullOutput = await readFile(bodyData.node_output_spill_path, 'utf8');
    expect(spilledFullOutput.length).toBe(paddingBytes);

    // The group paused after iteration 1 (interactive: true, no 'DONE' signal yet).
    const pauseCalls = (freshStore.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>)
      .mock.calls;
    expect(pauseCalls.length).toBe(1);

    // ---- Resume: seed priorCompletedNodes with the REAL spilled bytes (not a
    // hand-authored string) and prove the resumed body script sees the full value.
    const priorCompletedNodes = new Map([['refine.work', { output: spilledFullOutput }]]);
    const resumedWorkflow = {
      name: 'lg-resume-prev-large',
      nodes: [
        {
          id: 'refine',
          kind: 'loop_group',
          loop_group: {
            until: 'DONE',
            max_iterations: 5,
            fresh_context: false,
            interactive: true,
            gate_message: 'Review.',
            nodes: [
              {
                id: 'work',
                kind: 'exec',
                runtime: 'sh',
                script: 'previous=$LOOP_PREV.work.output; printf "%s\\nDONE\\n" "${#previous}"',
                depends_on: [],
              },
            ],
          },
          depends_on: [],
        },
      ] as DagNode[],
    };
    const result = await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(createMockStore()),
        conversationId: 'conv-lg-large-resume',
        cwd: testDir,
        workflow: resumedWorkflow,
        workflowRun: makeWorkflowRun('lg-prev-large-resume', {
          metadata: {
            approval: {
              type: 'interactive_loop',
              nodeId: 'refine',
              iteration: 1,
              message: 'Review.',
            },
            loop_user_input: '',
          },
        }),
        artifactsDir,
        logDir,
        priorCompletedNodes,
      })
    );

    // The resumed body script measured $LOOP_PREV.work.output's length as the FULL
    // padding size — proving the real spilled bytes (not a truncated preview) survived
    // the pause/resume boundary.
    expect(result).toContain(String(paddingBytes));
  });
});
