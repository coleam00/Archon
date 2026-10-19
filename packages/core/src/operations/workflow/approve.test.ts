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
import {
  operator,
  mockGetWorkflowRun,
  mockCancelWorkflowRun,
  mockFindChildRuns,
  mockResolveApprovalGate,
  mockLogger,
  mockCaptureApprovalResolved,
  makePausedRun,
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
