// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, type Mock } from 'bun:test';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mockLogFn,
  runUsageWrites,
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
import { executeDagWorkflow } from '../../../dag-executor';
import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import {
  executionMetadata,
  finishNodeExecution,
  newNodeInvocation,
  startNodeExecution,
} from '../../../node-execution';
import type { DagNode } from '../../../schemas';
import type { IWorkflowStore } from '../../../store';

describe('interactive loop node', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-resume-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'step1.md'), 'Step 1 prompt');
    await writeFile(join(commandsDir, 'step2.md'), 'Step 2 prompt using $step1.output');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'AI response' };
      yield { type: 'result', sessionId: 'session-id' };
    });
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    await removeTempTree(testDir);
  });

  const untilFieldSchema = {
    type: 'object',
    properties: { done: { type: 'boolean' }, note: { type: 'string' } },
    required: ['done'],
  };

  // ─── Interactive Loop Tests ────────────────────────────────────────────

  it('interactive loop with gate_message pauses after first iteration', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Here is the plan. Please review.' };
      yield {
        type: 'result',
        sessionId: 'loop-session-1',
        cost: 0.02,
        tokens: { input: 40, output: 4, cacheRead: 20, cacheWrite: 0 },
      };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'interactive-loop-test',
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

    // Should have called sendQuery exactly once (paused after iteration 1)
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // Should have called pauseWorkflowRun with interactive_loop type
    const pauseCalls = (mockDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>)
      .mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'interactive_loop',
      nodeId: 'refine',
      iteration: 1,
      // No signal this iteration — the engine-generated status line says so (#2074)
      // and the author's gate text is preserved at the end.
      completionSignaled: false,
      signaledOutput: null,
      signaledCostUsd: 0.02,
      signaledTokens: { input: 40, output: 4, cacheRead: 20, cacheWrite: 0 },
    });
    const pausedMessage = (pauseCalls[0][1] as { message: string }).message;
    expect(pausedMessage).toContain('No completion condition met');
    expect(pausedMessage).toContain('Review the plan and provide feedback.');
  });

  it('interactive loop gate attributes completion to until_bash instead of an absent signal', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Checks pass, but no prose sentinel.' };
      yield { type: 'result', sessionId: 'loop-bash-gate' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'interactive-loop-bash-gate',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Validate.',
                until: 'UNTIL_DONE',
                until_bash: 'exit 0',
                max_iterations: 3,
                interactive: true,
                gate_message: 'Review the checks.',
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('loop-bash-gate'),
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

  it('interactive loop gate attributes completion to until_field instead of an absent signal', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        sessionId: 'loop-field-gate',
        structuredOutput: { done: true, note: 'validated' },
      };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'interactive-loop-field-gate',
          nodes: [
            {
              id: 'refine',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Judge completion.',
                until: 'UNTIL_DONE',
                until_field: 'done',
                max_iterations: 3,
                interactive: true,
                gate_message: 'Review the judgment.',
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('loop-field-gate'),
      })
    );

    expectLoopGateEvidence(
      mockDeps.store,
      platform,
      '✅ Completion condition met via `until_field` (`done`).',
      true
    );
    const pausedMessage = mockDeps.store.pauseWorkflowRun.mock.calls[0][1].message;
    expect(pausedMessage).not.toContain('`until` signal (`UNTIL_DONE`)');
  });

  it('interactive loop gate names every declared condition when none completes', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        sessionId: 'loop-unmet-gate',
        structuredOutput: { done: false, note: 'not ready' },
      };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'interactive-loop-unmet-gate',
          nodes: [
            {
              id: 'refine',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Judge completion.',
                until: 'UNTIL_DONE',
                until_bash: 'exit 1',
                until_field: 'done',
                max_iterations: 3,
                interactive: true,
                gate_message: 'Keep working.',
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('loop-unmet-gate'),
      })
    );

    expectLoopGateEvidence(
      mockDeps.store,
      platform,
      '⚠️ No completion condition met in this iteration (`until_field` (`done`), `until` signal (`UNTIL_DONE`), `until_bash`).',
      false
    );
  });

  it('interactive loop first iteration always gates even if AI emits signal', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'agent_message_chunk',
        text: 'Plan approved. Proceeding. <promise>APPROVED</promise>',
      };
      yield { type: 'result', sessionId: 'loop-session-2', tokens: { input: 40, output: 4 } };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'interactive-loop-signal',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // On first iteration (fresh start, no user input), the loop MUST pause
    // at the gate even if the AI emits the completion signal. The user hasn't
    // seen anything yet — they must review before the loop can exit.
    const pauseCalls = (mockDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>)
      .mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'interactive_loop',
      nodeId: 'refine',
      iteration: 1,
      // The gate persists the signal state (#2074) so a bare approve can
      // finalize at resume instead of re-running the iteration.
      completionSignaled: true,
      // ...and the usage consumed up to the gate (#2333), so the finalize path
      // does not report a silent zero for iterations that really ran.
      signaledTokens: { input: 40, output: 4 },
    });
    const signaledOutput = (pauseCalls[0][1] as { signaledOutput: string }).signaledOutput;
    expect(signaledOutput).toContain('Plan approved');
    const gateMessage = (pauseCalls[0][1] as { message: string }).message;
    expect(gateMessage).toContain('Completion condition met via `until` signal (`APPROVED`)');
    expect(gateMessage).toContain('Review and provide feedback.');
  });

  it('interactive loop exits on resume when AI emits completion signal (user approved)', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'agent_message_chunk',
        text: 'Plan approved. Proceeding. <promise>APPROVED</promise>',
      };
      yield { type: 'result', sessionId: 'loop-session-3' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    // Simulate a resumed run where the user said "approved"
    const workflowRun = makeWorkflowRun('resume-signal-run', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'loop-session-2',
          message: 'Review and provide feedback.',
        },
        loop_user_input: 'approved',
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'interactive-loop-resume-signal',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'User said: $LOOP_USER_INPUT. Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // On resume with user input, the AI processes the approval and emits the
    // completion signal. The loop exits immediately without pausing at the gate.
    const pauseCalls = (mockDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>)
      .mock.calls;
    expect(pauseCalls.length).toBe(0);
  });

  // Spawns real `bash -c`: LOOP_PREV_OUTPUT only exists in until_bash's environment.
  it.each(['loop', 'loop_group'] as const)(
    'a resumed interactive %s gives its first iteration the paused iteration output',
    async kind => {
      const prevFile = join(testDir, `${kind}-prev-output`);
      const untilBash = `printf %s "$LOOP_PREV_OUTPUT" > "${prevFile.replace(/\\/g, '/')}"; exit 1`;
      const gate = { interactive: true, gate_message: 'Review.', max_iterations: 5 };
      const node: DagNode =
        kind === 'loop'
          ? {
              id: 'refine',
              kind: 'loop',
              loop: { ...gate, fresh_context: false, prompt: 'Draft.', until_bash: untilBash },
            }
          : {
              id: 'refine',
              kind: 'loop_group',
              loop_group: {
                ...gate,
                fresh_context: false,
                until_bash: untilBash,
                nodes: [
                  { id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'Draft.' } },
                ],
              },
            };
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'draft one' };
        yield { type: 'result', sessionId: 'prev-output-session' };
      });

      const firstDeps = createMockDeps();
      await executeDagWorkflow(
        dagOptions({
          deps: firstDeps,
          cwd: testDir,
          workflow: { name: 'resume-prev-output', nodes: [node] },
          workflowRun: makeWorkflowRun('resume-prev-output-run'),
        })
      );
      expect(await readFile(prevFile, 'utf8')).toBe('');
      const approval = firstDeps.store.pauseWorkflowRun.mock.calls[0]?.[1];
      expect(approval).toBeDefined();

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          cwd: testDir,
          workflow: { name: 'resume-prev-output', nodes: [node] },
          workflowRun: makeWorkflowRun('resume-prev-output-run', {
            metadata: { approval, loop_user_input: 'tighten it', loop_feedback_given: true },
          }),
          // The body row a loop_group iteration persisted, as a real resume reads it back.
          priorCompletedNodes: new Map([['refine.work', { output: 'draft one' }]]),
        })
      );
      expect(await readFile(prevFile, 'utf8')).toBe('draft one');
    }
  );

  it('interactive loop resumes from stored iteration with user input', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      yield { type: 'agent_message_chunk', text: 'Updated plan. <promise>APPROVED</promise>' };
      yield { type: 'result', sessionId: `resumed-session-${String(callCount)}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    // Simulate a resumed run: metadata has loop gate state and user input
    const workflowRun = makeWorkflowRun('resumed-run-id', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'loop-session-1',
          message: 'Review the plan.',
        },
        loop_user_input: 'Add error handling',
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'interactive-loop-resume',
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
                gate_message: 'Review the plan.',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Should have called sendQuery once (starting from iteration 2, completed immediately)
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // Verify the prompt contains the user input
    const promptArg = mockSendQueryDag.mock.calls[0][0] as string;
    expect(promptArg).toContain('Add error handling');
    // Should have resumed with stored session ID
    const sessionArg = mockSendQueryDag.mock.calls[0][2] as string | undefined;
    expect(sessionArg).toBe('loop-session-1');
  });

  it('signal_completes: true completes the loop on a first-iteration signal without gating (#2074 B)', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'agent_message_chunk',
        text: 'Validation PASS. <promise>VALIDATED</promise>',
      };
      yield { type: 'result', sessionId: 'sc-session-1' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('signal-completes-run');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'signal-completes-test',
          nodes: [
            {
              id: 'validate',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Validate. Emit VALIDATED on pass.',
                until: 'VALIDATED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review the validation result.',
                signal_completes: true,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // No gate: the node completed autonomously on the signal.
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
      c => c[0].event_type === 'node_completed' && c[0].step_name === 'validate'
    );
    expect(completed.length).toBe(1);
    expect(String(completed[0][0].data.node_output)).toContain('Validation PASS');
  });

  it('finalizes at resume from persisted signaledOutput on a bare approve — no re-run (#2074 C)', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should never run' };
      yield { type: 'result', sessionId: 'never' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('finalize-run', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'sig-session-1',
          message: 'gate',
          completionSignaled: true,
          signaledOutput: 'REPORT',
          signaledCostUsd: 0.02,
          signaledTokens: { input: 40, output: 4, cacheRead: 20, cacheWrite: 0 },
        },
        loop_user_input: 'Approved',
        loop_feedback_given: false,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'finalize-on-approve',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review.',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // No new iteration ran — the node finalized from the persisted output.
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
    expect(completed[0][0].data.node_output).toBe('REPORT');
    // The finalize row reports the usage the pausing invocation consumed (#2333).
    // Without this it persists duration_ms: 0 and no tokens for iterations that
    // really ran — a silent zero, not an absence.
    expect(completed[0][0].data.cost_usd).toBe(0.02);
    expect(completed[0][0].data.tokens).toEqual({
      input: 40,
      output: 4,
      cacheRead: 20,
      cacheWrite: 0,
    });
    expect(runUsageWrites(mockDeps.store)).toEqual([
      {
        total_cost_usd: 0.02,
        total_tokens_in: 40,
        total_tokens_out: 4,
        total_cache_read_tokens: 20,
        total_cache_write_tokens: 0,
      },
    ]);
  });

  it('carries the structured payload across the gate: pause persists it, bare-approve finalize re-emits it (#2637)', async () => {
    // Round trip, writer to reader. Without `signaledStructuredOutput` the finalize
    // row loses the payload a natural completion would persist, so a resume AFTER
    // the finalize rehydrates text-only and the node's completion route changes
    // its downstream field-access tier.
    const payload = { summary: 'draft one <promise>APPROVED</promise>' };
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'prose' };
      yield {
        type: 'result',
        sessionId: 'sig-struct-1',
        structuredOutput: payload,
        resolvedModel: { id: 'observed-model', provider: 'claude' },
        stopReason: 'end_turn',
        numTurns: 2,
        cost: 0,
        tokens: { input: 0, output: 0 },
      };
    });
    const loopNodes: DagNode[] = [
      {
        id: 'refine',
        kind: 'loop',
        loop: {
          fresh_context: false,
          prompt: 'Refine.',
          until: 'APPROVED',
          max_iterations: 10,
          interactive: true,
          gate_message: 'Review.',
        },
        output_format: { type: 'object', properties: { summary: { type: 'string' } } },
      },
    ];
    const pausingDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: pausingDeps,
        cwd: testDir,
        workflow: { name: 'finalize-struct-pause', nodes: loopNodes },
        workflowRun: makeWorkflowRun('finalize-struct-pause-run'),
      })
    );
    const pauseCalls = (
      pausingDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    const approval = pauseCalls[0][1] as {
      signaledOutput?: string | null;
      signaledStructuredOutput?: unknown;
    };
    expect(approval.signaledStructuredOutput).toEqual(payload);

    // Bare approve → finalize. The row must carry the payload like any other
    // completion row so a later resume rehydrates it (#2637 AC1).
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should never run' };
      yield { type: 'result', sessionId: 'never' };
    });
    const resumingDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: resumingDeps,
        cwd: testDir,
        workflow: { name: 'finalize-struct-resume', nodes: loopNodes },
        workflowRun: makeWorkflowRun('finalize-struct-pause-run', {
          metadata: {
            approval: { ...approval },
            loop_user_input: 'Approved',
            loop_feedback_given: false,
          },
        }),
      })
    );
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    const completed = (
      resumingDeps.store.createWorkflowEvent as Mock<
        (e: {
          event_type: string;
          step_name: string;
          data: Record<string, unknown>;
        }) => Promise<void>
      >
    ).mock.calls.filter(c => c[0].event_type === 'node_completed' && c[0].step_name === 'refine');
    expect(completed.length).toBe(1);
    expect(completed[0][0].data.structured_output).toEqual(payload);
    expect(completed[0][0].data.model_usage).toMatchObject({ resolved: 'observed-model' });
    expect(completed[0][0].data.stop_reason).toBe('end_turn');
    expect(completed[0][0].data.num_turns).toBe(2);
    expect(completed[0][0].data.tokens).toEqual({ input: 0, output: 0 });
    const pausedExecution = pauseCalls[0][1].execution;
    expect(pausedExecution).toBeDefined();
    expect(completed[0][0].data.invocation).toEqual(pausedExecution?.invocation);
    expect(completed[0][0].data.attempt).toEqual(pausedExecution?.attempt);
    expect(completed[0][0].data.timing).toEqual(pausedExecution?.timing);
    // The finalized record names the loop's session in its own key and nowhere else.
    const { session_id: sessionId, ...rest } = completed[0][0].data;
    expect(sessionId).toBe('sig-struct-1');
    expect(JSON.stringify(rest)).not.toContain('sig-struct-1');
  });

  it('finalize omits tokens when the gate persisted none (legacy pause / no usage) (#2333)', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should never run' };
      yield { type: 'result', sessionId: 'never' };
    });

    const mockDeps = createMockDeps();
    const workflowRun = makeWorkflowRun('finalize-no-tokens-run', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'sig-session-1',
          message: 'gate',
          completionSignaled: true,
          signaledOutput: 'REPORT',
          // No signaledTokens key at all — a run paused by a build predating #2333.
        },
        loop_user_input: 'Approved',
        loop_feedback_given: false,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: testDir,
        workflow: {
          name: 'finalize-on-approve',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review.',
              },
            },
          ],
        },
        workflowRun,
      })
    );

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
    expect(completed[0][0].data).not.toHaveProperty('tokens');
  });

  it('warns and omits malformed persisted gate token usage on bare approval', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should never run' };
      yield { type: 'result', sessionId: 'never' };
    });

    const mockDeps = createMockDeps();
    const workflowRun = makeWorkflowRun('finalize-invalid-tokens-run', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'sig-session-1',
          message: 'gate',
          completionSignaled: true,
          signaledOutput: 'REPORT',
          signaledTokens: { input: Number.NaN, output: 4 },
        },
        loop_user_input: 'Approved',
        loop_feedback_given: false,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: testDir,
        workflow: {
          name: 'finalize-invalid-tokens',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review.',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    const warnCalls = mockLogFn.mock.calls.filter(
      (call: unknown[]) => call[1] === 'dag_loop.signaled_tokens_invalid_ignored'
    );
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[0]).toEqual(
      expect.objectContaining({ workflowRunId: workflowRun.id, nodeId: 'refine' })
    );
    const completed = mockDeps.store.createWorkflowEvent.mock.calls.filter(
      ([event]) => event.event_type === 'node_completed' && event.step_name === 'refine'
    );
    expect(completed.length).toBe(1);
    expect(completed[0][0].data).not.toHaveProperty('tokens');
  });

  it('a finalize from a metadata-less paused loop gate persists the path contract and its legacy root fields', async () => {
    const mockDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'finalize-contract',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review.',
              },
              output_format: {
                type: 'object',
                properties: {
                  verdict: { type: 'object', properties: { ok: { type: 'boolean' } } },
                },
              },
            },
          ],
        },
        // No `execution` in the cursor: the raw-event write path.
        workflowRun: makeWorkflowRun('finalize-contract', {
          metadata: {
            approval: {
              type: 'interactive_loop',
              nodeId: 'refine',
              iteration: 1,
              message: 'gate',
              completionSignaled: true,
              signaledOutput: '{"verdict":{"ok":true}}',
            },
            loop_user_input: 'Approved',
            loop_feedback_given: false,
          },
        }),
      })
    );
    const completed = persistedEvents(mockDeps.store).find(
      e => e.event_type === 'node_completed' && e.step_name === 'refine'
    );
    // Older binaries read only declared_fields, so this path must write it too.
    expect(completed?.data).toMatchObject({
      declared_fields: ['verdict'],
      declared_output_paths: [['verdict'], ['verdict', 'ok']],
    });
  });

  it('iterates at resume when feedback was given, even on a signal-bearing gate (#2074 C)', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Re-checked X. <promise>APPROVED</promise>' };
      yield {
        type: 'result',
        sessionId: 'iter-session-2',
        cost: 0.03,
        tokens: { input: 60, output: 6, cacheRead: 30, cacheWrite: 0 },
      };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('feedback-iterates-run', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'sig-session-1',
          message: 'gate',
          completionSignaled: true,
          signaledOutput: 'REPORT',
          signaledCostUsd: 0.02,
          // Paused on a floor: the gate's cumulative cache was already incomplete.
          signaledTokens: {
            input: 40,
            output: 4,
            cacheRead: 20,
            cacheWrite: 0,
            cachePartial: true,
          },
        },
        loop_user_input: 'actually re-check X',
        loop_feedback_given: true,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'feedback-iterates',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'User said: $LOOP_USER_INPUT. Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review.',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Feedback ⇒ a fresh iteration ran with $LOOP_USER_INPUT substituted.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const promptArg = mockSendQueryDag.mock.calls[0][0] as string;
    expect(promptArg).toContain('actually re-check X');
    const completed = mockDeps.store.createWorkflowEvent.mock.calls.find(
      ([event]) => event.event_type === 'node_completed' && event.step_name === 'refine'
    );
    expect(completed?.[0].data?.cost_usd).toBeCloseTo(0.05, 5);
    // A gate without execution metadata cannot prove the cost it carried in.
    expect(completed?.[0].data).toMatchObject({ spend: { costUsd: { partial: true } } });
    // The gate paused on a floor, so the resumed node and run totals stay a floor.
    // Decoding the persisted usage without the flag let a resumed loop claim an exact
    // total it never had.
    expect(completed?.[0].data?.tokens).toEqual({
      input: 100,
      output: 10,
      cacheRead: 50,
      cacheWrite: 0,
      cachePartial: true,
    });
    expect(runUsageWrites(mockDeps.store)).toEqual([
      {
        total_cost_usd: 0.05,
        total_tokens_in: 100,
        total_tokens_out: 10,
        total_cache_read_tokens: 50,
        total_cache_write_tokens: 0,
        total_cache_partial: true,
      },
    ]);
  });

  describe('cost carried in from a gate', () => {
    const refine: DagNode = {
      id: 'refine',
      kind: 'loop',
      loop: {
        fresh_context: false,
        prompt: 'Refine.',
        until: 'APPROVED',
        max_iterations: 10,
        interactive: true,
        gate_message: 'Review.',
      },
    };
    const gate = (overrides: Record<string, unknown>) => ({
      type: 'interactive_loop',
      nodeId: 'refine',
      iteration: 1,
      sessionId: 'sig-session-1',
      message: 'gate',
      completionSignaled: true,
      signaledOutput: 'REPORT',
      ...overrides,
    });
    const resumeAt = async (
      runId: string,
      approval: Record<string, unknown>,
      feedbackGiven: boolean,
      nodes: DagNode[] = [refine]
    ) => {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Done. <promise>APPROVED</promise>' };
        yield { type: 'result', sessionId: 'iter-session-2', cost: 0.03 };
      });
      const mockDeps = createMockDeps();
      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: { name: 'gate-cost', nodes },
          workflowRun: makeWorkflowRun(runId, {
            metadata: {
              approval,
              loop_user_input: feedbackGiven ? 'again' : 'Approved',
              loop_feedback_given: feedbackGiven,
            },
          }),
        })
      );
      const events = persistedEvents(mockDeps.store);
      return {
        store: mockDeps.store,
        completed: events.find(e => e.event_type === 'node_completed' && e.step_name === 'refine'),
        snapshot: await foldDagResumeSnapshot(events, runId),
      };
    };

    it('feedback on a legacy gate with null cost keeps the priced floor partial', async () => {
      const { store, completed, snapshot } = await resumeAt(
        'legacy-feedback',
        gate({ signaledCostUsd: null }),
        true
      );
      expect(completed?.data?.cost_usd).toBeCloseTo(0.03, 5);
      expect(completed?.data).toMatchObject({
        spend: { costUsd: { source: 'provider', value: 0.03, partial: true } },
      });
      expect(runUsageWrites(store)).toEqual([expect.objectContaining({ total_cost_usd: 0.03 })]);
      expect(snapshot.costUsd).toBeCloseTo(0.03, 5);
    });

    it('bare approval of a legacy gate with null cost keeps later priced work as the floor', async () => {
      const { store, completed, snapshot } = await resumeAt(
        'legacy-approve',
        gate({ signaledCostUsd: null }),
        false,
        [
          refine,
          {
            id: 'after',
            kind: 'agent',
            source: { kind: 'inline', prompt: 'Next.' },
            depends_on: ['refine'],
          },
        ]
      );
      // Only the downstream node ran: approval still finalizes without an iteration.
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      expect(completed?.data).not.toHaveProperty('cost_usd');
      expect(completed?.data).not.toHaveProperty('spend');
      expect(runUsageWrites(store)).toEqual([expect.objectContaining({ total_cost_usd: 0.03 })]);
      expect(snapshot.costUsd).toBeCloseTo(0.03, 5);
    });

    it('feedback on a gate whose recorded cost is known keeps the cost complete', async () => {
      const start = startNodeExecution({
        runId: 'known-feedback',
        path: 'refine',
        node: refine,
        invocation: newNodeInvocation(),
        provider: 'claude',
      });
      const execution = executionMetadata(
        finishNodeExecution(
          start,
          { status: 'suspended', point: 'interactive_loop' },
          { costUsd: 0.02 }
        )
      );
      const { completed } = await resumeAt(
        'known-feedback',
        gate({ execution, signaledCostUsd: 0.02 }),
        true
      );
      expect(completed?.data?.cost_usd).toBeCloseTo(0.05, 5);
      expect(completed?.data).toMatchObject({ spend: { costUsd: { source: 'provider' } } });
      expect(completed?.data).not.toHaveProperty('spend.costUsd.partial');
    });

    it('bare approval of a gate whose recorded cost is a floor keeps the finalized cost partial', async () => {
      const start = startNodeExecution({
        runId: 'floor-approve',
        path: 'refine',
        node: refine,
        invocation: newNodeInvocation(),
        provider: 'claude',
      });
      const execution = executionMetadata(
        finishNodeExecution(
          start,
          { status: 'suspended', point: 'interactive_loop' },
          { costUsd: 0.02, costPartial: true }
        )
      );
      const { completed } = await resumeAt(
        'floor-approve',
        gate({ execution, signaledCostUsd: 0.02 }),
        false
      );
      expect(mockSendQueryDag.mock.calls.length).toBe(0);
      expect(completed?.data?.cost_usd).toBeCloseTo(0.02, 5);
      expect(completed?.data).toMatchObject({
        spend: { costUsd: { source: 'provider', value: 0.02, partial: true } },
      });
    });
  });

  it('iterates at resume on a non-signaled gate even without feedback (#2074 C)', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Another pass. <promise>APPROVED</promise>' };
      yield { type: 'result', sessionId: 'iter-session-3' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('nonsignaled-iterates-run', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'sig-session-1',
          message: 'gate',
          completionSignaled: false,
          signaledOutput: null,
        },
        loop_user_input: 'Approved',
        loop_feedback_given: false,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'nonsignaled-iterates',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review.',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Nothing to finalize — a normal resumed iteration ran.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
  });

  describe('at max_iterations (#4290)', () => {
    const runAtCap = async (loopUserInput: string, feedbackGiven: boolean, iteration = 1) => {
      const mockDeps = createMockDeps();
      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: {
            name: 'feedback-at-cap',
            nodes: [
              {
                id: 'refine',
                kind: 'loop',
                loop: {
                  fresh_context: false,
                  prompt: 'User said: $LOOP_USER_INPUT. Refine.',
                  until: 'APPROVED',
                  max_iterations: 1,
                  interactive: true,
                  gate_message: 'Review.',
                },
              },
            ],
          },
          workflowRun: makeWorkflowRun('feedback-at-cap-run', {
            metadata: {
              approval: {
                type: 'interactive_loop',
                nodeId: 'refine',
                iteration,
                sessionId: 'sig-session-1',
                message: 'gate',
                completionSignaled: false,
                signaledOutput: null,
              },
              loop_user_input: loopUserInput,
              loop_feedback_given: feedbackGiven,
            },
          }),
        })
      );
      return {
        completed: persistedEvents(mockDeps.store).find(
          e => e.event_type === 'node_completed' && e.step_name === 'refine'
        ),
        failed: mockDeps.store.persistWorkflowEvent.mock.calls.find(
          ([e]) => e.event_type === 'node_failed' && e.step_name === 'refine'
        )?.[0],
        store: mockDeps.store,
      };
    };

    beforeEach(() => {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Fixed. <promise>APPROVED</promise>' };
        yield { type: 'result', sessionId: 'iter-session-2' };
      });
    });

    it('runs one iteration past max_iterations when the final gate is answered with feedback', async () => {
      const { completed, failed } = await runAtCap('fix indentation', true);

      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      expect(mockSendQueryDag.mock.calls[0][0] as string).toContain('fix indentation');
      expect(completed).toBeDefined();
      expect(failed).toBeUndefined();
    });

    it('fails at max_iterations when the final non-completing gate is approved without feedback', async () => {
      const { completed, failed } = await runAtCap('Approved', false);

      expect(mockSendQueryDag.mock.calls.length).toBe(0);
      expect(completed).toBeUndefined();
      expect(failed?.data).toMatchObject({ failure_kind: 'max_iterations' });
    });

    it('runs exactly one iteration past max_iterations per feedback answer when it does not complete', async () => {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Still working on it.' };
        yield { type: 'result', sessionId: 'iter-session-2' };
      });

      const extra = await runAtCap('fix indentation', true);
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      expect(extra.completed).toBeUndefined();
      expect(extra.failed).toBeUndefined();
      expect(extra.store.pauseWorkflowRun.mock.calls[0]?.[1]).toMatchObject({
        type: 'interactive_loop',
        nodeId: 'refine',
        iteration: 2,
      });
      expect(
        extra.store.createWorkflowEvent.mock.calls
          .map(([e]) => e)
          .find(e => e.event_type === 'loop_iteration_started')?.data
      ).toMatchObject({ iteration: 2, maxIterations: 2 });

      mockSendQueryDag.mockClear();
      let approved: Awaited<ReturnType<typeof runAtCap>> | undefined;
      const loopIterations = await failedLoopIterations('refine', async () => {
        approved = await runAtCap('Approved', false, 2);
      });
      expect(mockSendQueryDag.mock.calls.length).toBe(0);
      expect(approved?.completed).toBeUndefined();
      expect(approved?.failed?.data).toMatchObject({
        failure_kind: 'max_iterations',
        maxIterations: 1,
      });
      expect(loopIterations).toBe(2);
    });
  });

  it('LEGACY: resume with pre-#2074 approval metadata (no completionSignaled/signaledOutput keys) iterates', async () => {
    // Rows paused before #2074 have neither key in metadata.approval and no
    // loop_feedback_given — the finalize path must NOT trigger; the loop runs
    // a normal resumed iteration exactly as before.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Legacy pass. <promise>APPROVED</promise>' };
      yield { type: 'result', sessionId: 'legacy-session-2' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('legacy-resume-run', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          iteration: 1,
          sessionId: 'legacy-session-1',
          message: 'Review and provide feedback.',
        },
        loop_user_input: 'approved',
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'legacy-loop-resume',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'User said: $LOOP_USER_INPUT. Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // A real iteration ran (no zero-duration finalize short-circuit).
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const promptArg = mockSendQueryDag.mock.calls[0][0] as string;
    expect(promptArg).toContain('approved');
  });

  it('non-interactive loop is unaffected (no pause)', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Still working...' };
      yield { type: 'result', sessionId: 'loop-session' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'non-interactive-loop',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do task.',
                until: 'COMPLETE',
                max_iterations: 2,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // pauseWorkflowRun should never be called for non-interactive loops
    const pauseCalls = (mockDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>)
      .mock.calls;
    expect(pauseCalls.length).toBe(0);
  });
});
