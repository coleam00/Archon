import {
  MOCK_PAUSED_RUN,
  MOCK_RUNNING_RUN,
  makeApp,
  mockCancelWorkflowRun,
  mockCaptureApprovalResolved,
  mockCreateWorkflowEvent,
  mockGetWorkflowRun,
  mockReclaimContainerEnv,
  mockResolveAndCancelApprovalGate,
  mockResolveApprovalGate,
  mockUpdateWorkflowRun,
} from '../../test/api-workflow-runs-harness';
import { beforeEach, describe, expect, test } from 'bun:test';
import { hostname } from 'node:os';

export function registerApproveTests() {
  describe('POST /api/workflows/runs/:runId/approve', () => {
    beforeEach(() => {
      mockGetWorkflowRun.mockReset();
      mockUpdateWorkflowRun.mockReset();
      mockResolveApprovalGate.mockClear();
      mockResolveAndCancelApprovalGate.mockClear();
      mockCreateWorkflowEvent.mockReset();
    });

    test('returns 404 when run not found', async () => {
      mockGetWorkflowRun.mockResolvedValue(null);
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/missing/approve', {
        method: 'POST',
        body: JSON.stringify({ comment: 'LGTM' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(404);
    });

    test('returns 400 when run is not paused', async () => {
      mockGetWorkflowRun.mockResolvedValue(MOCK_RUNNING_RUN);
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-uuid-1/approve', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(400);
    });

    // #2121 Phase 2: a parent paused blocked on a `workflow:` child has no approvable
    // gate of its own — approving the PARENT must 400 with a redirect to the child id,
    // never stamp a spurious node_completed for the parent's sub-run node.
    test('returns 400 redirecting to the child when the parent is blocked on a sub-run', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'parent-blocked-1',
        metadata: {
          approval: {
            type: 'child_workflow',
            nodeId: 'sub',
            message: 'Blocked on sub-run',
            childRunId: 'child-xyz',
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/parent-blocked-1/approve', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string; childRunId?: string };
      expect(body.error).toContain('child-xyz');
      // The run to act on is data, not something a client has to read out of the prose.
      expect(body.childRunId).toBe('child-xyz');
      // No gate mutation happened.
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    });

    // One derivation (`runAttention`) now answers the precondition for all three
    // gate routes, so a corrupt block pointer and a gate type this build cannot
    // resolve reach the console as 400s with the reason, not an opaque 500.
    test('returns 400 explaining a block pointer with no child id, never naming <unknown>', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'parent-blocked-2',
        metadata: {
          approval: { type: 'child_workflow', nodeId: 'sub', message: 'Blocked on sub-run' },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/parent-blocked-2/approve', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('the child run id is missing');
      expect(body.error).not.toContain('<unknown>');
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    });

    test('returns 400 for a gate type this build cannot resolve', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-future-gate',
        metadata: {
          approval: { type: 'from_the_future', nodeId: 'gate', message: 'Decide' },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-future-gate/approve', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain("unrecognized gate type 'from_the_future'");
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    });

    test('returns 400 when the gate is already resolved (double-approve guard)', async () => {
      // Post-#2075 an approved run stays 'paused' with approval.resolved set —
      // the status check alone no longer blocks a second approve.
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'review-gate',
            message: 'Review the plan',
            resolved: 'approved',
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
        method: 'POST',
        body: JSON.stringify({ comment: 'again' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('already approved');
      expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
      expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
    });

    test('bare gate with captureResponse but no decisionsAuthored keeps plain-text output (R2 fix — #2707)', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-capture',
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'review-gate',
            message: 'Review the plan',
            captureResponse: true,
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-capture/approve', {
        method: 'POST',
        body: JSON.stringify({ comment: 'Looks great, proceed' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      // Audit events ride the CAS transaction now (#2146), not a separate write.
      const casEvents = (mockResolveApprovalGate.mock.calls[0] as unknown[])[2] as Array<
        Record<string, unknown>
      >;
      const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
      expect(nodeCompleted).toMatchObject({
        data: { node_output: 'Looks great, proceed', approval_decision: 'approved' },
      });
      expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
    });

    test('bare gate with no captureResponse set — empty output, unaffected by #2707', async () => {
      mockGetWorkflowRun.mockResolvedValue(MOCK_PAUSED_RUN);
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
        method: 'POST',
        body: JSON.stringify({ comment: 'a comment' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      // Audit events ride the CAS transaction now (#2146), not a separate write.
      const casEvents = (mockResolveApprovalGate.mock.calls[0] as unknown[])[2] as Array<
        Record<string, unknown>
      >;
      const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
      expect(nodeCompleted).toMatchObject({
        data: { node_output: '', approval_decision: 'approved' },
      });
      expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
      expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'approved' });
    });

    test('new-mode gate (decisionsAuthored) produces structured output (#2707)', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-new-mode',
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'review-gate',
            message: 'Review the plan',
            decisions: [{ id: 'approve' }, { id: 'reject' }],
            decisionsAuthored: true,
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-new-mode/approve', {
        method: 'POST',
        body: JSON.stringify({ comment: 'a comment' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      const casEvents = (mockResolveApprovalGate.mock.calls[0] as unknown[])[2] as Array<
        Record<string, unknown>
      >;
      const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
      expect(nodeCompleted).toMatchObject({
        data: {
          node_output: JSON.stringify({ decision: 'approve', text: 'a comment' }),
          approval_decision: 'approved',
          structured_output: { decision: 'approve', text: 'a comment' },
        },
      });
    });

    test('legacy on_reject-configured gate keeps plain text output, unaffected by #2707', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-legacy-capture',
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'review-gate',
            message: 'Review the plan',
            captureResponse: true,
            onRejectPrompt: 'Fix: $REJECTION_REASON',
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-legacy-capture/approve', {
        method: 'POST',
        body: JSON.stringify({ comment: 'Looks great, proceed' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      const casEvents = (mockResolveApprovalGate.mock.calls[0] as unknown[])[2] as Array<
        Record<string, unknown>
      >;
      const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
      expect(nodeCompleted).toMatchObject({
        data: { node_output: 'Looks great, proceed', approval_decision: 'approved' },
      });
      expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
    });

    test('passes an absent comment through as no-feedback on an interactive_loop gate (#2074)', async () => {
      // The route must NOT default the comment to 'Approved' — approveWorkflow derives
      // loop_feedback_given from the RAW comment, and a masked no-feedback would make
      // every web approve iterate instead of finalize.
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-loop-bare',
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            message: 'gate',
            iteration: 1,
            completionSignaled: true,
            signaledOutput: 'REPORT',
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-loop-bare/approve', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      const casCall = mockResolveApprovalGate.mock.calls[0] as unknown[];
      expect(casCall[1]).toMatchObject({
        loop_feedback_given: false,
        loop_user_input: 'Approved',
      });
    });

    test('returns 400 (not a silent bare approve) when the body is sent but malformed (#2074)', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-bad-body',
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            message: 'gate',
            iteration: 1,
            completionSignaled: true,
            signaledOutput: 'REPORT',
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-bad-body/approve', {
        method: 'POST',
        body: '{"comment": "intended feedback', // truncated JSON — client bug
        headers: { 'Content-Type': 'application/json' },
      });
      // A malformed body must never be coerced into a bare approve — that would
      // FINALIZE a signal-bearing gate while silently discarding the feedback.
      expect(response.status).toBe(400);
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    });

    test('passes a provided comment through as feedback on an interactive_loop gate (#2074)', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-loop-feedback',
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            message: 'gate',
            iteration: 1,
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-loop-feedback/approve', {
        method: 'POST',
        body: JSON.stringify({ comment: 'actually re-check X' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      const casCall = mockResolveApprovalGate.mock.calls[0] as unknown[];
      expect(casCall[1]).toMatchObject({
        loop_feedback_given: true,
        loop_user_input: 'actually re-check X',
      });
    });
  });
}

export function registerRejectTests() {
  // ---------------------------------------------------------------------------
  // Tests: POST /api/workflows/runs/:runId/reject
  // ---------------------------------------------------------------------------

  describe('POST /api/workflows/runs/:runId/reject', () => {
    beforeEach(() => {
      mockGetWorkflowRun.mockReset();
      mockUpdateWorkflowRun.mockReset();
      mockResolveApprovalGate.mockClear();
      mockResolveAndCancelApprovalGate.mockClear();
      mockCancelWorkflowRun.mockReset();
      mockCreateWorkflowEvent.mockReset();
    });

    test('returns 404 when run not found', async () => {
      mockGetWorkflowRun.mockResolvedValue(null);
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/missing/reject', {
        method: 'POST',
        body: JSON.stringify({ reason: 'bad' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(404);
    });

    test('returns 400 when run is not paused', async () => {
      mockGetWorkflowRun.mockResolvedValue(MOCK_RUNNING_RUN);
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-uuid-1/reject', {
        method: 'POST',
        body: JSON.stringify({ reason: 'bad' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(400);
    });

    // #2121 Phase 2: rejecting a parent blocked on a `workflow:` child must 400 with a
    // redirect to the child id, not cancel the parent or stamp its sub-run node.
    test('returns 400 redirecting to the child when the parent is blocked on a sub-run', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'parent-blocked-2',
        metadata: {
          approval: {
            type: 'child_workflow',
            nodeId: 'sub',
            message: 'Blocked on sub-run',
            childRunId: 'child-abc',
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/parent-blocked-2/reject', {
        method: 'POST',
        body: JSON.stringify({ reason: 'no' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string; childRunId?: string };
      expect(body.error).toContain('child-abc');
      expect(body.childRunId).toBe('child-abc');
      expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    });

    test('cancels immediately when no on_reject configured', async () => {
      mockGetWorkflowRun.mockResolvedValue(MOCK_PAUSED_RUN);
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-paused-1/reject', {
        method: 'POST',
        body: JSON.stringify({ reason: 'needs work' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean; message: string };
      expect(body.success).toBe(true);
      // Terminal reject resolves + cancels atomically (#2113); the audit event rides
      // the same transaction (#2146).
      expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
        'run-paused-1',
        [
          {
            event_type: 'approval_received',
            step_name: 'review-gate',
            data: {
              via: 'api',
              occurrence: expect.any(String),
              decision: 'rejected',
              reason: 'needs work',
            },
          },
        ],
        { step_name: 'review-gate', reason: 'approval_rejected' },
        undefined
      );
      expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'rejected' });
    });

    test('a cancelling reject reports a failed container reclaim', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        metadata: {
          ...MOCK_PAUSED_RUN.metadata,
          isolation: 'container',
          isolation_env_id: 'env-a',
          execution_owner: { host: hostname(), pid: process.pid, uid: process.getuid?.() },
        },
      });
      mockReclaimContainerEnv.mockImplementationOnce(() =>
        Promise.reject(new Error('docker down'))
      );
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-paused-1/reject', {
        method: 'POST',
        body: JSON.stringify({ reason: 'needs work' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toContain('Workflow rejected');
      expect(body.message).toContain('Could not reclaim container environment env-a');
      expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledTimes(1);
    });

    test('records rejection and increments count when on_reject configured and under limit', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-on-reject',
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'review-gate',
            message: 'Approve?',
            onRejectPrompt: 'Fix: $REJECTION_REASON',
            onRejectMaxAttempts: 3,
          },
          rejection_count: 0,
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-on-reject/reject', {
        method: 'POST',
        body: JSON.stringify({ reason: 'needs more tests' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toContain('The on-reject prompt runs when the run continues.');
      expect(mockResolveApprovalGate).toHaveBeenCalledWith(
        'run-on-reject',
        {
          approval: {
            type: 'approval',
            nodeId: 'review-gate',
            message: 'Approve?',
            onRejectPrompt: 'Fix: $REJECTION_REASON',
            onRejectMaxAttempts: 3,
            resolved: 'rejected',
            answeredVia: 'api',
            answeredAt: expect.any(String),
          },
          rejection_reason: 'needs more tests',
          rejection_count: 1,
        },
        [
          {
            event_type: 'approval_received',
            step_name: 'review-gate',
            data: {
              via: 'api',
              occurrence: expect.any(String),
              decision: 'rejected',
              reason: 'needs more tests',
            },
          },
        ],
        undefined
      );
      expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
    });

    test('cancels when max attempts reached', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-max-attempts',
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'review-gate',
            message: 'Approve?',
            onRejectPrompt: 'Fix: $REJECTION_REASON',
            onRejectMaxAttempts: 3,
          },
          rejection_count: 2,
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-max-attempts/reject', {
        method: 'POST',
        body: JSON.stringify({ reason: 'still bad' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toContain('max attempts reached');
      // Terminal reject resolves + cancels atomically (#2113); the audit event rides
      // the same transaction (#2146).
      expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
        'run-max-attempts',
        [
          {
            event_type: 'approval_received',
            step_name: 'review-gate',
            data: {
              via: 'api',
              occurrence: expect.any(String),
              decision: 'rejected',
              reason: 'still bad',
            },
          },
        ],
        { step_name: 'review-gate', reason: 'approval_rejected' },
        undefined
      );
      expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
    });
  });
}
