import {
  MOCK_PAUSED_RUN,
  makeApp,
  mockCreateWorkflowEvent,
  mockExecuteWorkflow,
  mockGetConversationById,
  mockGetWorkflowRun,
  mockHandleMessage,
  mockHydrateResumableRun,
  mockListDueWorkflowContinuations,
  mockResolveAndCancelApprovalGate,
  mockResolveApprovalGate,
  mockResolveRunWorkflow,
  mockUpdateWorkflowRun,
} from '../../test/api-workflow-runs-harness';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as sqlHost from '@archon/core/workflows/sql-host';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { answeredPauseContinuation } from '@archon/workflows/schemas/workflow-run';
import {
  startWorkflowContinuationScheduler,
  stopWorkflowContinuationScheduler,
  workflowResumeTargetForRun,
} from '../../services/workflow-resume-service';

export function registerRespondTests() {
  // #2707 step 2 — the general drive verb. 'approve'/'reject' produce the exact same
  // resolution as the dedicated routes above; any other decision resolves through the
  // new declared-decision path.
  describe('POST /api/workflows/runs/:runId/respond', () => {
    beforeEach(() => {
      mockGetWorkflowRun.mockReset();
      mockUpdateWorkflowRun.mockReset();
      mockResolveApprovalGate.mockClear();
      mockResolveAndCancelApprovalGate.mockClear();
      mockCreateWorkflowEvent.mockReset();
    });

    test.each([
      ['approve', 'approve'],
      ['reject', 'reject'],
      ['respond', 'approve'],
      ['respond', 'reject'],
    ])(
      'refuses an undeclared decision at /%s (%s) without writes or resume',
      async (route, decision) => {
        mockHandleMessage.mockClear();
        const run = {
          ...MOCK_PAUSED_RUN,
          metadata: {
            approval: {
              type: 'approval',
              nodeId: 'review-gate',
              message: 'Choose',
              decisionsAuthored: true,
              decisions: [{ id: 'accept' }, { id: 'revise' }],
            },
          },
        };
        mockGetWorkflowRun.mockResolvedValue(run);
        const { app } = makeApp();
        const response = await app.request(`/api/workflows/runs/${run.id}/${route}`, {
          method: 'POST',
          body: JSON.stringify({ decision }),
          headers: { 'Content-Type': 'application/json' },
        });
        expect(response.status).toBe(400);
        const body = (await response.json()) as { error: string };
        expect(body.error).toContain(`does not declare decision '${decision}'`);
        expect(body.error).toContain('accept, revise');
        expect(mockHandleMessage).not.toHaveBeenCalled();
        expect(run.status).toBe('paused');
        expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
        expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
        expect(mockResolveApprovalGate).not.toHaveBeenCalled();
        expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
      }
    );

    test('returns 404 when run not found', async () => {
      mockGetWorkflowRun.mockResolvedValue(null);
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/missing/respond', {
        method: 'POST',
        body: JSON.stringify({ decision: 'revise' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(404);
    });

    test('returns 400 when the body has no decision', async () => {
      mockGetWorkflowRun.mockResolvedValue(MOCK_PAUSED_RUN);
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-paused-1/respond', {
        method: 'POST',
        body: JSON.stringify({ text: 'no decision here' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(400);
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    });

    // respond shares `pausedGateBlocker` with approve/reject but passes its own advice
    // string, so the machine-usable redirect is asserted on this route too.
    test('returns 400 redirecting to the child when the parent is blocked on a sub-run', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'parent-blocked-3',
        metadata: {
          approval: {
            type: 'child_workflow',
            nodeId: 'sub',
            message: 'Blocked on sub-run',
            childRunId: 'child-def',
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/parent-blocked-3/respond', {
        method: 'POST',
        body: JSON.stringify({ decision: 'revise' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string; childRunId?: string };
      expect(body.error).toContain('child-def');
      expect(body.childRunId).toBe('child-def');
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    });

    test('returns 400 naming the actual options when the decision is not declared', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-respond-invalid',
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'review-gate',
            message: 'Review the plan',
            decisions: [{ id: 'approve' }, { id: 'revise' }],
            decisionsAuthored: true,
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-respond-invalid/respond', {
        method: 'POST',
        body: JSON.stringify({ decision: 'escalate' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("does not declare decision 'escalate'");
      expect(body.error).toContain('approve, revise');
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    });

    test('resolves a declared non-default decision with the caller-supplied id', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-respond-revise',
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'review-gate',
            message: 'Review the plan',
            decisions: [{ id: 'approve' }, { id: 'revise' }],
            decisionsAuthored: true,
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-respond-revise/respond', {
        method: 'POST',
        body: JSON.stringify({ decision: 'revise', text: 'needs more detail' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      const casEvents = (mockResolveApprovalGate.mock.calls[0] as unknown[])[2] as Array<
        Record<string, unknown>
      >;
      const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
      expect(nodeCompleted).toMatchObject({
        data: {
          structured_output: { decision: 'revise', text: 'needs more detail' },
        },
      });
    });

    test('forwards the current occurrence when the decision succeeds', async () => {
      const expectedGate = { nodeId: 'review-gate', pauseId: 'pause-current' };
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        metadata: {
          approval: {
            ...expectedGate,
            type: 'approval',
            message: 'Review',
            decisions: [{ id: 'approve' }, { id: 'revise' }],
            decisionsAuthored: true,
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-paused-1/respond', {
        method: 'POST',
        body: JSON.stringify({ decision: 'revise', expectedGate }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      expect(mockResolveApprovalGate.mock.calls[0]?.[3]).toEqual(expectedGate);
    });

    test('rejects a partial expected gate instead of silently discarding its identity', async () => {
      mockGetWorkflowRun.mockResolvedValue(MOCK_PAUSED_RUN);
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-paused-1/respond', {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve', expectedGate: { nodeId: 'review-gate' } }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(400);
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    });

    test.each(['approve', 'reject', 'revise'])(
      'forwards the displayed occurrence for %s after the same node re-pauses',
      async decision => {
        const expectedGate = { nodeId: 'review-gate', pauseId: 'pause-before' };
        mockGetWorkflowRun.mockResolvedValue({
          ...MOCK_PAUSED_RUN,
          metadata: {
            approval: {
              type: 'approval',
              nodeId: expectedGate.nodeId,
              pauseId: 'pause-after',
              message: 'Review again',
              decisions: [{ id: 'approve' }, { id: 'reject' }, { id: 'revise' }],
              decisionsAuthored: true,
            },
          },
        });
        const { app } = makeApp();
        const response = await app.request('/api/workflows/runs/run-paused-1/respond', {
          method: 'POST',
          body: JSON.stringify({ decision, text: 'feedback', expectedGate }),
          headers: { 'Content-Type': 'application/json' },
        });
        // Refused before any write, as a conflict naming the occurrence the run is at now.
        expect(response.status).toBe(409);
        expect(((await response.json()) as { error: string }).error).toContain(
          "It is now awaiting occurrence 'pause-after'."
        );
        expect(mockResolveApprovalGate).not.toHaveBeenCalled();
        expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
        expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
      }
    );

    test('a stale occurrence is a 409, not an undeclared-decision 400, when the new gate lacks the decision', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'next-gate',
            pauseId: 'pause-after',
            message: 'Something else',
            decisions: [{ id: 'approve' }, { id: 'accept' }],
            decisionsAuthored: true,
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-paused-1/respond', {
        method: 'POST',
        body: JSON.stringify({
          decision: 'revise',
          text: 'feedback',
          expectedGate: { nodeId: 'review-gate', pauseId: 'pause-before' },
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toContain(
        "It is now awaiting occurrence 'pause-after'."
      );
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    });

    test("'approve' produces the exact same resolution as POST .../approve", async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-respond-approve',
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'review-gate',
            message: 'Review the plan',
            decisions: [{ id: 'approve' }, { id: 'revise' }],
            decisionsAuthored: true,
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs/run-respond-approve/respond', {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve', text: 'lgtm' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status).toBe(200);
      const casEvents = (mockResolveApprovalGate.mock.calls[0] as unknown[])[2] as Array<
        Record<string, unknown>
      >;
      const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
      expect(nodeCompleted).toMatchObject({
        data: { structured_output: { decision: 'approve', text: 'lgtm' } },
      });
    });
  });
}

export function registerContinuationTests() {
  // ---------------------------------------------------------------------------
  // Continuation after a gate answer: the routes only record it. The server's
  // continuation scheduler continues the run on whichever platform started it.
  // ---------------------------------------------------------------------------

  describe('gate answers continue through the continuation host', () => {
    const GATE = {
      type: 'approval' as const,
      nodeId: 'review-gate',
      message: 'Review the plan',
      pauseId: 'pause-1',
    };

    beforeEach(() => {
      mockGetWorkflowRun.mockReset();
      mockUpdateWorkflowRun.mockReset();
      mockResolveApprovalGate.mockReset();
      mockResolveApprovalGate.mockResolvedValue({ resolved: true });
      mockResolveAndCancelApprovalGate.mockClear();
      mockCreateWorkflowEvent.mockReset();
      mockGetConversationById.mockReset();
      mockHandleMessage.mockReset();
      mockResolveRunWorkflow.mockClear();
      mockHydrateResumableRun.mockClear();
      mockExecuteWorkflow.mockClear();
      mockListDueWorkflowContinuations.mockReset();
      mockListDueWorkflowContinuations.mockResolvedValue([]);
    });
    afterEach(() => {
      stopWorkflowContinuationScheduler();
    });

    const post = async (path: string, body: unknown): Promise<Response> =>
      makeApp().app.request(path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });

    test('approving a Slack-started run over HTTP needs no manual resume: the scheduler continues it in Slack', async () => {
      let stored: WorkflowRun = {
        ...MOCK_PAUSED_RUN,
        id: 'run-slack-gate',
        conversation_id: null,
        last_activity_at: null,
        parent_conversation_id: 'slack-parent',
        metadata: { approval: GATE },
      };
      mockGetWorkflowRun.mockImplementation(async () => stored);
      mockResolveApprovalGate.mockImplementation(async (_id, metadata) => {
        stored = { ...stored, metadata: { ...stored.metadata, ...metadata } };
        return { resolved: true };
      });
      mockListDueWorkflowContinuations.mockImplementation(async () =>
        answeredPauseContinuation(stored) ? [stored] : []
      );
      mockGetConversationById.mockImplementation(async id => ({
        id,
        platform_conversation_id: 'C123:1234567890.123456',
        platform_type: 'slack',
      }));

      const response = await post('/api/workflows/runs/run-slack-gate/approve', {
        comment: 'LGTM',
      });

      expect(response.status).toBe(200);
      const { message } = (await response.json()) as { message: string };
      expect(message).toBe('Workflow approved: deploy. The run continues on its own.');
      expect(mockHandleMessage).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();

      let executed!: () => void;
      const execution = new Promise<void>(resolve => {
        executed = resolve;
      });
      mockExecuteWorkflow.mockImplementationOnce(async () => {
        executed();
        return { success: true, workflowRunId: stored.id };
      });
      const slack: IWorkflowPlatform = {
        sendMessage: mock(async () => {}),
        getStreamingMode: () => 'batch',
        getPlatformType: () => 'slack',
      };
      startWorkflowContinuationScheduler(sqlHost.createSqlWorkflowHost(), run =>
        workflowResumeTargetForRun(run, new Map([['slack', slack]]))
      );
      await execution;
      const [, platform, conversationId] = mockExecuteWorkflow.mock.calls[0] ?? [];
      expect(platform).toBe(slack);
      expect(conversationId).toBe('C123:1234567890.123456');
    });

    test.each([
      {
        route: 'reject',
        body: { reason: 'tests missing' },
        approval: { ...GATE, onRejectPrompt: 'Fix: $REJECTION_REASON', onRejectMaxAttempts: 3 },
        message:
          'Workflow rejected: deploy. The on-reject prompt runs when the run continues. The run continues on its own.',
      },
      {
        route: 'respond',
        body: { decision: 'approve' },
        approval: GATE,
        message: "Workflow responded 'approve': deploy. The run continues on its own.",
      },
    ])('/$route records the answer and says the run continues on its own', async c => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        parent_conversation_id: 'web-parent',
        metadata: { approval: c.approval, rejection_count: 0 },
      });

      const response = await post(`/api/workflows/runs/run-paused-1/${c.route}`, c.body);

      expect(response.status).toBe(200);
      expect(((await response.json()) as { message: string }).message).toBe(c.message);
      expect(mockResolveApprovalGate).toHaveBeenCalledTimes(1);
      expect(mockHandleMessage).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });

    test('a container run is told to resume from the CLI, since no host continues it', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        metadata: { approval: GATE, isolation: 'container' },
      });

      const response = await post('/api/workflows/runs/run-paused-1/approve', {});

      expect(response.status).toBe(200);
      expect(((await response.json()) as { message: string }).message).toBe(
        'Workflow approved: deploy. Run `archon workflow resume run-paused-1` from the CLI to continue it.'
      );
    });

    test('reject: does NOT dispatch when the run is being cancelled (no on_reject configured)', async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        parent_conversation_id: 'parent-conv-uuid', // set, but doesn't matter — reject cancels
      });

      const response = await post('/api/workflows/runs/run-paused-1/reject', { reason: 'no' });

      expect(response.status).toBe(200);
      expect(mockHandleMessage).not.toHaveBeenCalled();
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
              reason: 'no',
            },
          },
        ],
        { step_name: 'review-gate', reason: 'approval_rejected' },
        undefined
      );
    });
  });
}
