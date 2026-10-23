// @archon-test-isolated
import { describe, test, expect, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { getArchonWorkspacesPath } from '@archon/paths/archon-paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { enterRunExecution } from '@archon/workflows/run-scratch';
import {
  operator,
  mockGetWorkflowRun,
  mockCancelWorkflowRun,
  mockResolveApprovalGate,
  mockResolveAndCancelApprovalGate,
  mockCaptureApprovalResolved,
  mockReclaimContainerEnv,
  isolationStore,
  makePausedRun,
  makeRunWithScratch,
  rejectWorkflow,
} from './test-harness';

const trackTempRoot = trackTempRoots();

describe('rejectWorkflow', () => {
  beforeEach(() => {
    mockCaptureApprovalResolved.mockClear();
    mockGetWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockClear();
    mockResolveApprovalGate.mockClear();
    mockResolveAndCancelApprovalGate.mockClear();
    mockReclaimContainerEnv.mockClear();
  });

  test('rejects with onRejectPrompt under max attempts — stays paused with staged rework', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'needs more tests', operator, { via: 'cli' });

    expect(result.cancelled).toBe(false);
    expect(result.workflowName).toBe('test-workflow');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
    // Stays 'paused' (no status write) — rejection staged atomically via the CAS
    // on the approval context (#2075/#2113), with the audit event in the same
    // transaction (#2146)
    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: 'review',
          message: 'Review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
          resolved: 'rejected',
          answeredVia: 'cli',
          answeredAt: expect.any(String),
        },
        rejection_reason: 'needs more tests',
        rejection_count: 1,
      },
      [
        {
          event_type: 'approval_received',
          step_name: 'review',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            reason: 'needs more tests',
          },
        },
      ],
      undefined
    );

    expect(mockCaptureApprovalResolved).toHaveBeenCalledTimes(1);
    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'rejected' });
  });

  test('throws on already-resolved gate (double-reject guard)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          resolved: 'rejected',
        },
        rejection_count: 1,
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await expect(rejectWorkflow('run-1', 'again', operator, { via: 'cli' })).rejects.toThrow(
      'already rejected and is awaiting resume'
    );
    // Fast-path: the in-memory read blocks before any CAS / events / cancel
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('concurrent loser (CAS miss) writes NO events, telemetry, or cancel (#2113)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
        },
        rejection_count: 0,
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);
    // Fast-path passes (gate reads unresolved) but the atomic CAS is lost.
    mockResolveApprovalGate.mockResolvedValueOnce({ resolved: false });

    await expect(rejectWorkflow('run-1', 'needs work', operator, { via: 'cli' })).rejects.toThrow(
      'already resolved or is no longer paused at the expected gate'
    );

    expect(mockResolveApprovalGate).toHaveBeenCalledTimes(1);
    expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('rejects at max attempts — cancels run', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 2,
        },
        rejection_count: 1,
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'still broken', operator, { via: 'cli' });

    expect(result.cancelled).toBe(true);
    expect(result.maxAttemptsReached).toBe(true);
    // Terminal reject resolves + cancels in ONE atomic CAS (#2113) — never a
    // separate cancelWorkflowRun that could fail and strand the run. The audit
    // event rides the same transaction (#2146), as does the workflow_cancelled
    // terminal event the CAS writes from these details (#2906).
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-1',
      [
        {
          event_type: 'approval_received',
          step_name: 'review',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            reason: 'still broken',
          },
        },
      ],
      { step_name: 'review', reason: 'approval_rejected' },
      undefined
    );
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('rejects without onRejectPrompt and no declared reject decision — cancels immediately (legacy default)', async () => {
    // makePausedRun()'s approval context has no `decisions` at all (predates
    // #2707) — absence, not an empty array, so this preserves the exact
    // pre-#2707 cancel-on-reject-without-on_reject behavior.
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());

    const result = await rejectWorkflow('run-1', 'no good', operator, { via: 'cli' });

    expect(result.cancelled).toBe(true);
    expect(result.maxAttemptsReached).toBe(false);
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-1',
      [
        {
          event_type: 'approval_received',
          step_name: 'review',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            reason: 'no good',
          },
        },
      ],
      { step_name: 'review', reason: 'approval_rejected' },
      undefined
    );
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('a gate with the synthesized default decisions but decisionsAuthored NOT set still cancels on reject (R1 fix — #2707)', async () => {
    // Reviewed regression (R1): before the fix, having ANY `decisions` array
    // populated (including the engine's own synthesized default pair) was
    // enough to trigger the new resolve-and-continue path. Only an explicit
    // author opt-in (`decisionsAuthored: true`) may do that — every gate
    // paused by a pre-#2707 build has `decisions` absent or unauthored, and
    // must keep cancelling on reject exactly as before.
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          type: 'approval',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          // decisionsAuthored intentionally omitted
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'needs changes', operator, { via: 'cli' });

    expect(result.cancelled).toBe(true);
    expect(result.newMode).toBe(false);
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledTimes(1);
  });

  test('new-mode gate (decisionsAuthored) rejects — writes node_completed with structured {decision,text} output, stays resumable (#2707)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          type: 'approval',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'needs changes', operator, { via: 'cli' });

    // Unlike the legacy on_reject path, there is no staging or attempt cap —
    // this is an ordinary node completion, so the run stays paused/resumable
    // exactly like an approve, and no separate cancel path is taken.
    expect(result.cancelled).toBe(false);
    expect(result.newMode).toBe(true);
    expect(result.maxAttemptsReached).toBe(false);
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          type: 'approval',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
          resolved: 'rejected',
          answeredVia: 'cli',
          answeredAt: expect.any(String),
        },
      },
      [
        {
          event_type: 'node_completed',
          step_name: 'review',
          data: {
            node_output: JSON.stringify({ decision: 'reject', text: 'needs changes' }),
            approval_decision: 'rejected',
            structured_output: { decision: 'reject', text: 'needs changes' },
          },
        },
        {
          event_type: 'approval_received',
          step_name: 'review',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            reason: 'needs changes',
          },
        },
      ],
      undefined
    );
    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'rejected' });
  });

  test('explicit empty-string reason defaults to "Rejected" in structured_output and audit event', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          type: 'approval',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', '', operator, { via: 'cli' });

    expect(result.newMode).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(mockResolveApprovalGate).toHaveBeenCalled();
    const events = mockResolveApprovalGate.mock.calls[0][2] as unknown[] as Array<
      Record<string, unknown>
    >;
    const nodeCompleted = events.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted?.data).toMatchObject({
      structured_output: { decision: 'reject', text: 'Rejected' },
    });
    const approvalReceived = events.find(e => e.event_type === 'approval_received');
    expect(approvalReceived?.data).toMatchObject({ reason: 'Rejected' });
  });

  test('rejects an escalated body-terminal-gate pause — node_completed lands under the namespaced <nodeId>.<bodyGateId> step_name (#2707 step 3)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'grp',
          message: 'Continue?',
          type: 'approval',
          bodyGateId: 'check',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await rejectWorkflow('run-1', 'needs changes', operator, { via: 'cli' });

    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({ step_name: 'grp.check' });
    const approvalReceived = casEvents.find(e => e.event_type === 'approval_received');
    expect(approvalReceived).toMatchObject({ step_name: 'grp' });
  });

  // A paused run may still be executing a gate's sibling nodes, and a parent resumed in
  // its child's process publishes no owner endpoint. The reject tears down its container
  // and scratch only once its recorded owner process cannot be executing it.
  const containerApproval = {
    approval: { nodeId: 'review', message: 'Please review', type: 'approval' as const },
    isolation: 'container',
    isolation_env_id: 'env-9',
    execution_owner: { host: hostname(), pid: process.pid, uid: process.getuid?.() },
  };

  test('a cancelling reject with no executor left reclaims a container run’s env', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ metadata: containerApproval }));

    const result = await rejectWorkflow('run-1', 'no good', operator, { via: 'cli' });

    expect(result.cancelled).toBe(true);
    expect(result.cleanupWarnings).toBeUndefined();
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledTimes(1);
    expect(mockReclaimContainerEnv).toHaveBeenCalledWith('env-9', isolationStore);
  });

  test('a cancelling reject whose container reclaim fails stays cancelled and reports it', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ metadata: containerApproval }));
    mockReclaimContainerEnv.mockImplementationOnce(() => Promise.reject(new Error('docker down')));

    const result = await rejectWorkflow('run-1', 'no good', operator, { via: 'cli' });

    expect(result.cancelled).toBe(true);
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledTimes(1);
    expect(result.cleanupWarnings).toHaveLength(1);
    expect(result.cleanupWarnings?.[0]).toContain('env-9');
    expect(result.cleanupWarnings?.[0]).toContain('resources may remain allocated');
  });

  test('a cancelling reject leaves a live owner’s container to its executor', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          ...containerApproval,
          execution_owner: { ...containerApproval.execution_owner, pid: process.ppid },
        },
      })
    );

    await rejectWorkflow('run-1', 'no good', operator, { via: 'cli' });

    expect(mockReclaimContainerEnv).not.toHaveBeenCalled();
  });

  test.each([
    ['is this process, not executing it', process.pid, false, false],
    ['is a live process', process.ppid, false, true],
    ['is this process, still executing it', process.pid, true, true],
  ] as const)(
    'a cancelling reject of a run whose owner %s keeps its scratch: %p',
    async (_case, pid, executing, kept) => {
      const { run, checkout } = makeRunWithScratch(
        trackTempRoot(join(getArchonWorkspacesPath(), '_cwd', `reject-${randomUUID()}`)),
        {
          id: `reject-${randomUUID()}`,
          metadata: { execution_owner: { host: hostname(), pid, uid: process.getuid?.() } },
        }
      );
      mockGetWorkflowRun.mockResolvedValueOnce(run);
      const leave = executing ? enterRunExecution(run.id) : undefined;
      try {
        await rejectWorkflow(run.id, 'no good', operator, { via: 'cli' });
      } finally {
        leave?.();
      }

      expect(existsSync(checkout)).toBe(kept);
    }
  );

  test('a reject that stages rework keeps the container run’s env', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          ...containerApproval,
          approval: { ...containerApproval.approval, onRejectPrompt: 'Fix it' },
        },
      })
    );

    const result = await rejectWorkflow('run-1', 'no good', operator, { via: 'cli' });

    expect(result.cancelled).toBe(false);
    expect(mockReclaimContainerEnv).not.toHaveBeenCalled();
  });

  test('a reject that loses the cancel CAS does not reclaim the container', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ metadata: containerApproval }));
    mockResolveAndCancelApprovalGate.mockResolvedValueOnce({ resolved: false });

    await expect(rejectWorkflow('run-1', 'no good', operator, { via: 'cli' })).rejects.toThrow(
      'already resolved'
    );
    expect(mockReclaimContainerEnv).not.toHaveBeenCalled();
  });

  test('terminal reject concurrent loser (CAS miss) writes NO event or telemetry (#2113)', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());
    // No onRejectPrompt ⇒ the atomic resolve-and-cancel CAS is the guard.
    mockResolveAndCancelApprovalGate.mockResolvedValueOnce({ resolved: false });

    await expect(rejectWorkflow('run-1', 'no good', operator, { via: 'cli' })).rejects.toThrow(
      'already resolved or is no longer paused at the expected gate'
    );

    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledTimes(1);
    expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
  });

  test('rejects container write-back gate — stays resumable (never cancels), writeBack flag set', async () => {
    const run = makePausedRun({
      metadata: {
        approval: { nodeId: '__writeback__', message: '3 files changed', type: 'writeback' },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', undefined, operator, { via: 'cli' });

    // The run stays resumable so the resume DISCARDS the overlay + completes.
    expect(result.cancelled).toBe(false);
    expect(result.writeBack).toBe(true);
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: '__writeback__',
          message: '3 files changed',
          type: 'writeback',
          resolved: 'rejected',
          answeredVia: 'cli',
          answeredAt: expect.any(String),
        },
        approval_response: 'rejected',
      },
      [
        {
          event_type: 'approval_received',
          step_name: '__writeback__',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            gate: 'writeback',
          },
        },
      ],
      undefined
    );
  });

  test('throws on non-paused run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(rejectWorkflow('run-1', undefined, operator, { via: 'cli' })).rejects.toThrow(
      "Cannot reject run with status 'completed'"
    );
  });

  test('refuses a child_workflow-blocked parent — redirects to the child run, cancels nothing', async () => {
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

    await expect(rejectWorkflow('run-1', undefined, operator, { via: 'cli' })).rejects.toThrow(
      /waiting on sub-run child-run-9.*reject the child run instead/i
    );
    // A fall-through would cancel the parent and silently orphan the paused child.
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('an unrecognized gate type fails loudly instead of resolving as a plain rework/cancel (#2489)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          // Simulates a future/corrupted reason value assertRejectable's shared
          // precondition gate must reject rather than silently letting the generic
          // rework/cancel branch resolve it — the SAME check the CLI --detach
          // precheck runs, so a passing precheck can never diverge from the real
          // resolution.
          type: 'bogus-reason',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await expect(rejectWorkflow('run-1', undefined, operator, { via: 'cli' })).rejects.toThrow(
      /unrecognized gate type 'bogus-reason'/
    );
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });
});
