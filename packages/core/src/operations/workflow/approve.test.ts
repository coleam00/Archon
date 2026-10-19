// @archon-test-isolated
import {
  startNodeExecution,
  finishNodeExecution,
  newNodeInvocation,
  executionMetadata,
} from '@archon/workflows/node-execution';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import { describe, test, expect, beforeEach } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  operator,
  mockGetWorkflowRun,
  mockCancelWorkflowRun,
  mockFindChildRuns,
  mockResolveApprovalGate,
  mockLogger,
  mockCaptureApprovalResolved,
  makePausedRun,
  assertAnswerable,
  assertApprovable,
  assertRejectable,
  ChildRunRedirectError,
  approveWorkflow,
} from './test-harness';

describe('approveWorkflow', () => {
  beforeEach(() => {
    mockCaptureApprovalResolved.mockClear();
    mockGetWorkflowRun.mockClear();
    mockResolveApprovalGate.mockClear();
    mockCancelWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockResolvedValue({ cancelled: true });
    mockFindChildRuns.mockClear();
    mockFindChildRuns.mockResolvedValue([]);
  });

  test('approves a bare (pre-#2707) approval gate — empty output, unaffected by this PR', async () => {
    // makePausedRun()'s default approval context has neither `onRejectPrompt`
    // NOR `decisionsAuthored` — the omitted-everything shape every workflow
    // authored before #2707 step 1 necessarily has, since `decisions:` did
    // not exist to author. This MUST behave byte-for-byte as before this PR
    // (R1 review finding): empty output, no structured_output field.
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());

    const result = await approveWorkflow('run-1', 'Looks good', operator, { via: 'cli' });

    expect(result.type).toBe('approval_gate');
    expect(result.workflowName).toBe('test-workflow');
    expect(result.workingPath).toBe('/workspace/worktree');

    // Operations no longer writes events directly — node_completed + approval_received
    // ride the CAS transaction as its 3rd argument (#2146).

    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          type: 'approval',
          resolved: 'approved',
          answeredVia: 'cli',
          answeredAt: expect.any(String),
        },
        approval_response: 'approved',
        rejection_reason: '',
        rejection_count: 0,
      },
      [
        {
          event_type: 'node_completed',
          step_name: 'review',
          data: { node_output: '', approval_decision: 'approved' },
        },
        {
          event_type: 'approval_received',
          step_name: 'review',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'approved',
            comment: 'Looks good',
          },
        },
      ],
      undefined
    );

    // Anonymous telemetry: binary resolution captured exactly once
    expect(mockCaptureApprovalResolved).toHaveBeenCalledTimes(1);
    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'approved' });
  });

  test('a gate completion keeps its paused identity and only publishes after the CAS wins', async () => {
    const execution = executionMetadata(
      finishNodeExecution(
        startNodeExecution({
          runId: 'run-1',
          path: 'outer.review',
          invocation: newNodeInvocation(),
          node: {
            id: 'review',
            kind: 'gate',
            message: 'Review',
            decisions: [{ id: 'approve' }],
            decisionsAuthored: true,
            captureResponse: true,
          },
        }),
        { status: 'suspended', point: 'approval' }
      )
    );
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          type: 'approval',
          execution,
        },
      },
    });
    const observed: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => observed.push(event));
    try {
      mockGetWorkflowRun.mockResolvedValueOnce(run);
      mockResolveApprovalGate.mockResolvedValueOnce({ resolved: false });
      await expect(approveWorkflow('run-1', undefined, operator, { via: 'cli' })).rejects.toThrow(
        'already resolved'
      );
      expect(observed).toHaveLength(0);
      mockGetWorkflowRun.mockResolvedValueOnce(run);
      // A completion carrying execution metadata must not take the metadata-less
      // path, so clear the file-wide logger and prove the warning stays off it.
      mockLogger.warn.mockClear();
      await approveWorkflow('run-1', undefined, operator, { via: 'cli' });
      const row = mockResolveApprovalGate.mock.calls.at(-1)?.[2][0];
      expect(row).toMatchObject({
        step_name: 'outer.review',
        data: {
          invocation: execution.invocation,
          attempt: execution.attempt,
          binding: execution.binding,
        },
      });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        type: 'node_completed',
        execution: {
          invocation: execution.invocation,
          attempt: execution.attempt,
          path: 'outer.review',
        },
      });
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'workflow.gate_transcript_metadata_missing'
      );
    } finally {
      unsubscribe();
    }
  });

  test('approves a new-mode gate (decisionsAuthored) — writes node_completed with structured {decision,text} output (#2707)', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          approval: {
            nodeId: 'review',
            message: 'Please review',
            type: 'approval',
            decisions: [{ id: 'approve' }, { id: 'reject' }],
            decisionsAuthored: true,
          },
        },
      })
    );

    await approveWorkflow('run-1', 'Looks good', operator, { via: 'cli' });

    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({
      data: {
        node_output: JSON.stringify({ decision: 'approve', text: 'Looks good' }),
        approval_decision: 'approved',
        structured_output: { decision: 'approve', text: 'Looks good' },
      },
    });
  });

  test('approves an escalated body-terminal-gate pause — node_completed lands under the namespaced <nodeId>.<bodyGateId> step_name (#2707 step 3)', async () => {
    // nodeId is the enclosing loop_group's own id (so top-level resume routing
    // finds it); bodyGateId carries the gate's own id — the namespaced write is
    // what #2748's outerNodeOutputs pre-population keys on to find this decision
    // again after a resume.
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          approval: {
            nodeId: 'grp',
            message: 'Continue?',
            type: 'approval',
            bodyGateId: 'check',
            decisions: [{ id: 'approve' }, { id: 'revise' }],
            decisionsAuthored: true,
          },
        },
      })
    );

    await approveWorkflow('run-1', 'looks good', operator, { via: 'cli' });

    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({ step_name: 'grp.check' });
    // The OTHER audit event (approval_received) is untouched — only node_completed,
    // the one #2748's pre-population reads, needs the namespaced form.
    const approvalReceived = casEvents.find(e => e.event_type === 'approval_received');
    expect(approvalReceived).toMatchObject({ step_name: 'grp' });
  });

  test('approves legacy on_reject-configured gate — plain text output, unaffected by #2707', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          approval: {
            nodeId: 'review',
            message: 'Please review',
            type: 'approval',
            onRejectPrompt: 'Please address: $REJECTION_REASON',
          },
        },
      })
    );

    await approveWorkflow('run-1', 'Looks good', operator, { via: 'cli' });

    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    // No captureResponse set → empty output, exactly as before this PR. No
    // structured_output field at all on the legacy path.
    expect((nodeCompleted?.data as Record<string, unknown>).node_output).toBe('');
    expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
  });

  test('approves interactive_loop — writes only approval_received, stores loop_user_input', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'iterate',
          message: 'Provide feedback',
          type: 'interactive_loop',
          iteration: 2,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await approveWorkflow('run-1', 'fix the tests', operator, { via: 'cli' });

    expect(result.type).toBe('interactive_loop');

    // Operations no longer writes events directly.
    // Only approval_received rides the CAS — NOT node_completed (the executor
    // writes that on the real completion signal / at resume).
    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
    expect(casEvents).toHaveLength(1);
    expect(casEvents[0].event_type).toBe('approval_received');

    // Stays 'paused' (no status write) — stores loop_user_input and marks the
    // approval context resolved, preserving iteration for startIteration detection
    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: 'iterate',
          message: 'Provide feedback',
          type: 'interactive_loop',
          iteration: 2,
          resolved: 'approved',
          answeredVia: 'cli',
          answeredAt: expect.any(String),
        },
        loop_user_input: 'fix the tests',
        // Real feedback ⇒ the resumed loop iterates (#2074)
        loop_feedback_given: true,
      },
      [
        {
          event_type: 'approval_received',
          step_name: 'iterate',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'approved',
            comment: 'fix the tests',
            iteration: 2,
          },
        },
      ],
      undefined
    );
  });

  test('interactive_loop bare approve — loop_feedback_given false, loop_user_input defaults (#2074)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'iterate',
          message: 'Provide feedback',
          type: 'interactive_loop',
          iteration: 1,
          completionSignaled: true,
          signaledOutput: 'REPORT',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await approveWorkflow('run-1', undefined, operator, { via: 'cli' });

    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: 'iterate',
          message: 'Provide feedback',
          type: 'interactive_loop',
          iteration: 1,
          completionSignaled: true,
          signaledOutput: 'REPORT',
          resolved: 'approved',
          answeredVia: 'cli',
          answeredAt: expect.any(String),
        },
        // The recorded comment still defaults to 'Approved' (events/$LOOP_USER_INPUT
        // for non-signaled iterate paths) — only the boolean sees the raw undefined.
        loop_user_input: 'Approved',
        loop_feedback_given: false,
      },
      [
        {
          event_type: 'approval_received',
          step_name: 'iterate',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'approved',
            comment: 'Approved',
            iteration: 1,
          },
        },
      ],
      undefined
    );
  });

  test('interactive_loop whitespace-only comment counts as no feedback (#2074)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'iterate',
          message: 'Provide feedback',
          type: 'interactive_loop',
          iteration: 1,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await approveWorkflow('run-1', '   ', operator, { via: 'cli' });

    const casMetadata = mockResolveApprovalGate.mock.calls[0][1] as Record<string, unknown>;
    expect(casMetadata.loop_feedback_given).toBe(false);
    // Whitespace-only also gets the documented recorded-comment default —
    // '   ' must never be stored verbatim as $LOOP_USER_INPUT.
    expect(casMetadata.loop_user_input).toBe('Approved');
  });

  test('throws on already-resolved gate (double-approve guard)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          type: 'approval',
          resolved: 'approved',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await expect(approveWorkflow('run-1', undefined, operator, { via: 'cli' })).rejects.toThrow(
      'already approved and is awaiting resume'
    );
    // Fast-path: the in-memory read blocks before any CAS / events / telemetry
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
  });

  test('concurrent loser (CAS miss) writes NO events or telemetry (#2113)', async () => {
    // Both callers read an UNRESOLVED gate (fast-path passes), but only one wins
    // the atomic CAS. The loser must not duplicate events/telemetry.
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());
    mockResolveApprovalGate.mockResolvedValueOnce({ resolved: false });

    await expect(approveWorkflow('run-1', 'ship it', operator, { via: 'cli' })).rejects.toThrow(
      'already resolved or is no longer paused at the expected gate'
    );

    // The CAS was attempted (unlike the fast-path guard) but lost — no side effects.
    expect(mockResolveApprovalGate).toHaveBeenCalledTimes(1);
    expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
  });

  test('bare gate with captureResponse but no decisionsAuthored keeps plain-text output (R2 fix — #2707)', async () => {
    // captureResponse with no `decisionsAuthored` (the shape every gate using
    // capture_response before #2707 step 1 has) must keep functioning exactly as
    // before this PR: it is NOT a new-mode gate just because on_reject is
    // also absent. Reviewed regression (R2): this used to wrongly emit JSON.
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          type: 'approval',
          captureResponse: true,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await approveWorkflow('run-1', 'My review notes', operator, { via: 'cli' });

    // The node_output rides the CAS events (#2146), not a separate event write.
    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect((nodeCompleted?.data as Record<string, unknown>).node_output).toBe('My review notes');
    expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
  });

  test('new-mode gate (decisionsAuthored) ignores a stray captureResponse — output is still structured (#2707)', async () => {
    // captureResponse is meaningless once a gate has explicitly opted into
    // decisionsAuthored — output is always structured regardless.
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          type: 'approval',
          captureResponse: true,
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await approveWorkflow('run-1', 'My review notes', operator, { via: 'cli' });

    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect((nodeCompleted?.data as Record<string, unknown>).node_output).toBe(
      JSON.stringify({ decision: 'approve', text: 'My review notes' })
    );
  });

  test('legacy gate (onRejectPrompt set) with captureResponse — stores comment as plain node output, unchanged', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          type: 'approval',
          captureResponse: true,
          onRejectPrompt: 'Please address: $REJECTION_REASON',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await approveWorkflow('run-1', 'My review notes', operator, { via: 'cli' });

    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect((nodeCompleted?.data as Record<string, unknown>).node_output).toBe('My review notes');
    expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
  });

  test('throws on non-paused run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));

    await expect(approveWorkflow('run-1', undefined, operator, { via: 'cli' })).rejects.toThrow(
      "Cannot approve run with status 'running'"
    );
  });

  test('throws on missing approval context', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ metadata: {} }));

    await expect(approveWorkflow('run-1', undefined, operator, { via: 'cli' })).rejects.toThrow(
      'missing approval context'
    );
  });

  test('throws on run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);

    await expect(approveWorkflow('run-1', undefined, operator, { via: 'cli' })).rejects.toThrow(
      'Workflow run not found: run-1'
    );
  });

  test('approves container write-back gate — records approval_response, NO node_completed', async () => {
    const run = makePausedRun({
      metadata: {
        approval: { nodeId: '__writeback__', message: '7 files changed', type: 'writeback' },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await approveWorkflow('run-1', undefined, operator, { via: 'cli' });

    expect(result.type).toBe('approval_gate');
    // The resumed executor's write-back gate reads approval_response to APPLY.
    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: '__writeback__',
          message: '7 files changed',
          type: 'writeback',
          resolved: 'approved',
          answeredVia: 'cli',
          answeredAt: expect.any(String),
        },
        approval_response: 'approved',
      },
      [
        {
          event_type: 'approval_received',
          step_name: '__writeback__',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'approved',
            comment: 'Approved',
            gate: 'writeback',
          },
        },
      ],
      undefined
    );
    // No node_completed — there is no DAG node behind the write-back gate.
    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
    expect(casEvents.every(e => e.event_type !== 'node_completed')).toBe(true);
  });

  test('refuses a child_workflow-blocked parent — redirects to the child run, writes nothing', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'implement-qa',
          message: 'Blocked on sub-run',
          type: 'child_workflow',
          childRunId: 'child-run-9',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await expect(approveWorkflow('run-1', undefined, operator, { via: 'cli' })).rejects.toThrow(
      /waiting on sub-run child-run-9.*approve or reject the child run instead/i
    );
    // Nothing resolved, nothing stamped — a fall-through here would write a bogus
    // node_completed for the workflow node and orphan the paused child.
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });

  test('an unrecognized gate type fails loudly instead of resolving as a plain approval (#2489)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          // Simulates a future/corrupted reason value assertApprovable's shared
          // precondition gate must reject rather than silently letting the generic
          // approval branch resolve it — the SAME check the CLI --detach precheck
          // runs, so a passing precheck can never diverge from the real resolution.
          type: 'bogus-reason',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await expect(approveWorkflow('run-1', undefined, operator, { via: 'cli' })).rejects.toThrow(
      /unrecognized gate type 'bogus-reason'/
    );
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });
});

describe('assertApprovable / assertRejectable — shared precondition gate', () => {
  const baseRun = {
    origin: { conversationId: 'conv-1' },
    id: 'run-1',
    status: 'paused',
    workflow_name: 'assist',
    working_path: '/tmp/x',
    conversation_id: 'conv-1',
    user_message: 'hi',
    metadata: { approval: { nodeId: 'gate', message: 'Approve?' } },
  } as unknown as WorkflowRun;

  const withMeta = (metadata: Record<string, unknown>, status = 'paused') =>
    ({ ...baseRun, status, metadata }) as unknown as WorkflowRun;

  test('assertApprovable returns the approval context on a well-formed paused run', () => {
    expect(assertApprovable(baseRun).nodeId).toBe('gate');
  });

  test('assertApprovable rejects a non-paused run', () => {
    expect(() => assertApprovable(withMeta(baseRun.metadata, 'running'))).toThrow(
      "Cannot approve run with status 'running'"
    );
  });

  test('assertApprovable rejects a missing approval context', () => {
    expect(() => assertApprovable(withMeta({}))).toThrow(
      'Workflow run is paused but missing approval context.'
    );
  });

  test('assertApprovable redirects a child_workflow-blocked parent to the child run', () => {
    expect(() =>
      assertApprovable(
        withMeta({
          approval: {
            nodeId: 'sub',
            message: 'blocked',
            type: 'child_workflow',
            childRunId: 'child-9',
          },
        })
      )
    ).toThrow('Approve or reject the child run instead.');
  });

  test('assertApprovable rejects an already-resolved gate', () => {
    expect(() =>
      assertApprovable(withMeta({ approval: { nodeId: 'g', message: 'm', resolved: 'approved' } }))
    ).toThrow('was already approved and is awaiting resume');
  });

  test('assertRejectable TOLERATES a missing approval context (unlike approve)', () => {
    expect(assertRejectable(withMeta({}))).toBeUndefined();
  });

  test('assertRejectable redirects a child_workflow-blocked parent', () => {
    expect(() =>
      assertRejectable(
        withMeta({
          approval: {
            nodeId: 'sub',
            message: 'blocked',
            type: 'child_workflow',
            childRunId: 'child-9',
          },
        })
      )
    ).toThrow('Reject the child run instead, or abandon this run to discard the whole tree.');
  });

  test('assertRejectable rejects an already-resolved gate', () => {
    expect(() =>
      assertRejectable(withMeta({ approval: { nodeId: 'g', message: 'm', resolved: 'rejected' } }))
    ).toThrow('was already rejected and is awaiting resume');
  });

  // Both functions now read ONE derivation (`runAttention`). These pin the exact
  // messages that derivation has to keep producing at this entry point.
  const childGate = (over: Record<string, unknown> = {}) => ({
    approval: { nodeId: 'sub', message: 'blocked', type: 'child_workflow', ...over },
  });

  test('the child redirect names the child run verbatim, for both verbs', () => {
    expect(() => assertApprovable(withMeta(childGate({ childRunId: 'child-9' })))).toThrow(
      "Run run-1 is paused waiting on sub-run child-9 ('workflow:' node 'sub'). " +
        'Approve or reject the child run instead.'
    );
    expect(() => assertRejectable(withMeta(childGate({ childRunId: 'child-9' })))).toThrow(
      "Run run-1 is paused waiting on sub-run child-9 ('workflow:' node 'sub'). " +
        'Reject the child run instead, or abandon this run to discard the whole tree.'
    );
  });

  // The redirect names a command, and every surface spells it differently, so the
  // error carries the decision as data and never bakes one spelling into `message`.
  test('the child redirect is typed, command-free, and spells per surface', () => {
    const slack = { formatWorkflowCommand: (c: string) => `/archon-workflow ${c}` };
    const thrown = (verb: 'approve' | 'reject'): InstanceType<typeof ChildRunRedirectError> => {
      try {
        if (verb === 'approve') assertApprovable(withMeta(childGate({ childRunId: 'child-9' })));
        else assertRejectable(withMeta(childGate({ childRunId: 'child-9' })));
      } catch (error) {
        if (error instanceof ChildRunRedirectError) return error;
        throw error;
      }
      throw new Error(`assert${verb} did not refuse a blocked parent`);
    };

    for (const verb of ['approve', 'reject'] as const) {
      const error = thrown(verb);
      expect({
        parentRunId: error.parentRunId,
        childRunIds: error.childRunIds,
        nodeId: error.nodeId,
        action: error.action,
      }).toEqual({
        parentRunId: 'run-1',
        childRunIds: ['child-9'],
        nodeId: 'sub',
        action: verb,
      });
      expect(error.message).toContain('child-9');
      expect(error.message).not.toContain('/workflow ');
      expect(error.message).not.toContain('archon workflow ');

      const onSlack = error.messageFor(slack);
      expect(onSlack).toContain(`/archon-workflow ${verb} child-9`);
      expect(onSlack.replaceAll('/archon-workflow ', '')).not.toContain('/workflow ');
      expect(onSlack).not.toContain('archon workflow ');
      // A surface with no spelling of its own still goes through the one mechanism.
      expect(error.messageFor({})).toContain(`/workflow ${verb} child-9`);
    }
  });

  test('a fan-out parent redirects approve, reject and answer to every child it waits on', () => {
    const fanOut = withMeta({
      approval: {
        nodeId: 'work',
        message: 'waiting',
        type: 'fan_out',
        childRunIds: ['kid-0', 'kid-2'],
        unspawnedItems: 0,
      },
    });
    for (const assertFn of [assertApprovable, assertRejectable, assertAnswerable]) {
      let error: unknown;
      try {
        assertFn(fanOut);
      } catch (thrown) {
        error = thrown;
      }
      if (!(error instanceof ChildRunRedirectError)) throw new Error('expected a redirect');
      expect(error.childRunIds).toEqual(['kid-0', 'kid-2']);
      expect(error.message).toContain("waiting on sub-runs kid-0, kid-2 ('fan_out' node 'work')");
      const spelled = error.messageFor({});
      expect(spelled).toContain(`/workflow ${error.action} kid-0`);
      expect(spelled).toContain(`/workflow ${error.action} kid-2`);
    }
  });

  test('a block pointer with no child id says so instead of naming <unknown>', () => {
    // The old message interpolated '<unknown>' into a command the operator could
    // not run. A corrupt pointer is now its own state with its own explanation.
    for (const assertFn of [assertApprovable, assertRejectable]) {
      expect(() => assertFn(withMeta(childGate()))).toThrow(
        'Run run-1 cannot be resolved: blocked on a sub-run at node ' +
          "'sub' but the child run id is missing."
      );
      expect(() => assertFn(withMeta(childGate()))).not.toThrow('<unknown>');
    }
  });

  test('an unrecognized gate type is refused by both verbs', () => {
    const unknownType = { approval: { nodeId: 'g', message: 'm', type: 'from_the_future' } };
    for (const assertFn of [assertApprovable, assertRejectable]) {
      expect(() => assertFn(withMeta(unknownType))).toThrow(
        "Run run-1 has an unrecognized gate type 'from_the_future'. " +
          'This Archon build cannot resolve it.'
      );
    }
  });

  test('a `wait:` pause is not approvable and is silently rejectable', () => {
    // A durable wait resumes itself; there is no gate to approve, but rejecting a
    // parked run to cancel it stays legitimate (it never had an approval context).
    const waiting = {
      wait: {
        owner: 'node',
        nodeId: 'hold',
        kind: 'time',
        waitingSince: '2026-08-28T10:00:00.000Z',
        resumeAt: '2026-08-28T11:00:00.000Z',
      },
    };
    expect(() => assertApprovable(withMeta(waiting))).toThrow(
      'Workflow run is paused but missing approval context.'
    );
    expect(assertRejectable(withMeta(waiting))).toBeUndefined();
  });

  test('a usage-limit wait is refused by both verbs', () => {
    // Rejecting it would cancel the run under an approval audit trail for a gate
    // that never existed; cancel and abandon are the ways to stop it.
    const waiting = {
      wait: {
        owner: 'node',
        nodeId: 'implement',
        kind: 'quota',
        pauseId: 'limit-1',
        waitingSince: '2026-08-28T10:00:00.000Z',
        resumeAt: '2026-08-28T15:00:00.000Z',
      },
    };
    for (const assertFn of [assertApprovable, assertRejectable]) {
      expect(() => assertFn(withMeta(waiting))).toThrow(
        'Run run-1 is not at a gate: it hit a provider usage or rate limit and tries again by itself at 2026-08-28T15:00:00.000Z'
      );
    }
  });

  test('an attention wait is not a gate decision', () => {
    const waiting = {
      wait: {
        owner: 'node',
        nodeId: 'rerun-ci',
        kind: 'attention',
        waitingSince: '2026-08-28T10:00:00.000Z',
        message: 'Re-run CI, then resume.',
      },
    };
    for (const assertFn of [assertApprovable, assertRejectable]) {
      expect(() => assertFn(withMeta(waiting))).toThrow('paused at an attention wait');
    }
  });
});
