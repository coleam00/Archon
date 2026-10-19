// @archon-test-isolated
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { handleCommand } from '../command-handler';
import {
  operator,
  makeWorkflowRun,
  mockCancelWorkflowRun,
  mockGetWorkflowRun,
  mockResolveApprovalGate,
  mockResolveAndCancelApprovalGate,
  mockCreateWorkflowEvent,
  restoreSpies,
  approveConversation,
  resetCommandHandlerMocks,
} from './test-harness';

describe('CommandHandler', () => {
  beforeEach(resetCommandHandlerMocks);

  // Clean up spies after all tests in this file to prevent contamination
  afterAll(() => {
    restoreSpies();
  });

  describe('handleCommand', () => {
    describe('/workflow approve — interactive_loop branch', () => {
      test('routes to interactive_loop branch and stores loop_user_input', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-123',
            workflow_name: 'my-loop-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'build it',
            metadata: {
              approval: {
                type: 'interactive_loop',
                nodeId: 'refine',
                iteration: 2,
                message: 'Review the output',
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        const result = await handleCommand(
          approveConversation,
          '/workflow approve run-123 Add error handling',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('loop input received');
        expect(result.message).toContain('my-loop-wf');
        // Stays 'paused' (no status write) — resolution rides the approval context,
        // stamped atomically via the CAS (#2075/#2113), with the audit event in the
        // same transaction (#2146)
        expect(mockResolveApprovalGate).toHaveBeenCalledWith(
          'run-123',
          {
            approval: {
              type: 'interactive_loop',
              nodeId: 'refine',
              iteration: 2,
              message: 'Review the output',
              resolved: 'approved',
              answeredVia: 'telegram',
              answeredAt: expect.any(String),
            },
            loop_user_input: 'Add error handling',
            // A real comment counts as feedback ⇒ the resumed loop iterates (#2074)
            loop_feedback_given: true,
          },
          [
            {
              event_type: 'approval_received',
              step_name: 'refine',
              data: {
                via: 'telegram',
                occurrence: expect.any(String),
                decision: 'approved',
                comment: 'Add error handling',
                iteration: 2,
              },
            },
          ],
          undefined
        );
      });

      test('creates approval_received event (not node_completed) for interactive_loop', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-456',
            workflow_name: 'loop-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'interactive_loop',
                nodeId: 'implement',
                iteration: 1,
                message: 'Review iteration output',
              },
            },
            last_activity_at: new Date(),
          })
        );

        await handleCommand(approveConversation, '/workflow approve run-456 LGTM', operator);

        // The audit events ride the CAS transaction now (#2146), not a separate
        // createWorkflowEvent write. node_completed should NOT be written by the
        // approve command — only the executor writes it when the AI emits the
        // completion signal (actual loop exit).
        expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        expect(casEvents.filter(e => e.event_type === 'node_completed')).toHaveLength(0);
        expect(casEvents).toContainEqual(
          expect.objectContaining({ event_type: 'approval_received' })
        );
      });

      test('bare approve (no comment) passes undefined through — finalize-eligible (#2074)', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-bare',
            workflow_name: 'loop-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'interactive_loop',
                nodeId: 'validate',
                iteration: 1,
                message: 'gate',
                completionSignaled: true,
                signaledOutput: 'REPORT',
              },
            },
            last_activity_at: new Date(),
          })
        );

        const result = await handleCommand(
          approveConversation,
          '/workflow approve run-bare',
          operator
        );

        expect(result.success).toBe(true);
        // The chat handler must NOT pre-default the comment to 'Approved' —
        // loop_feedback_given derives from the raw comment, and a masked
        // no-feedback would make every chat approve iterate instead of finalize.
        expect(mockResolveApprovalGate).toHaveBeenCalledWith(
          'run-bare',
          expect.objectContaining({
            loop_feedback_given: false,
            loop_user_input: 'Approved',
          }),
          // Audit events ride the CAS transaction (#2146); metadata is the focus here.
          expect.any(Array),
          undefined
        );
      });

      test('returns error when run is not paused', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-789',
            workflow_name: 'loop-wf',
            conversation_id: 'conv-approve',
            status: 'running',
            user_message: 'start',
            last_activity_at: new Date(),
          })
        );

        const result = await handleCommand(
          approveConversation,
          '/workflow approve run-789 feedback',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('paused');
      });

      test('returns error when run not found', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(
          approveConversation,
          '/workflow approve missing-run feedback',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('not found');
      });
    });

    describe('/workflow approve — standard approval node with captureResponse', () => {
      test('bare gate with captureResponse but no decisionsAuthored keeps plain-text output (R2 fix — #2707)', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-cap',
            workflow_name: 'capture-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                captureResponse: true,
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        await handleCommand(
          approveConversation,
          '/workflow approve run-cap LGTM looks good',
          operator
        );

        // node_completed rides the CAS transaction now (#2146), not a direct write.
        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
        expect(nodeCompleted).toMatchObject({
          data: { node_output: 'LGTM looks good', approval_decision: 'approved' },
        });
        expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
      });

      test('bare gate with no captureResponse set — empty output, unaffected by #2707', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-nocap',
            workflow_name: 'nocapture-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        await handleCommand(approveConversation, '/workflow approve run-nocap a comment', operator);

        // node_completed rides the CAS transaction now (#2146), not a direct write.
        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
        expect(nodeCompleted).toMatchObject({
          data: { node_output: '', approval_decision: 'approved' },
        });
        expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
      });

      test('new-mode gate (decisionsAuthored) produces structured output (#2707)', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-new-mode',
            workflow_name: 'new-mode-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                decisions: [{ id: 'approve' }, { id: 'reject' }],
                decisionsAuthored: true,
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        await handleCommand(
          approveConversation,
          '/workflow approve run-new-mode a comment',
          operator
        );

        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
        expect(nodeCompleted).toMatchObject({
          data: {
            node_output: JSON.stringify({ decision: 'approve', text: 'a comment' }),
            approval_decision: 'approved',
            structured_output: { decision: 'approve', text: 'a comment' },
          },
        });
      });

      test('/workflow respond resolves a declared non-default decision (#2707 step 2)', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-respond',
            workflow_name: 'respond-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                decisions: [{ id: 'approve' }, { id: 'revise' }, { id: 'escalate' }],
                decisionsAuthored: true,
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        await handleCommand(
          approveConversation,
          '/workflow respond run-respond revise needs work',
          operator
        );

        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
        expect(nodeCompleted).toMatchObject({
          data: {
            node_output: JSON.stringify({ decision: 'revise', text: 'needs work' }),
            approval_decision: 'revise',
            structured_output: { decision: 'revise', text: 'needs work' },
          },
        });
      });

      test('/workflow respond approve delegates to the exact approve resolution', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-respond-approve',
            workflow_name: 'respond-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                decisions: [{ id: 'approve' }, { id: 'revise' }],
                decisionsAuthored: true,
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        await handleCommand(
          approveConversation,
          '/workflow respond run-respond-approve approve lgtm',
          operator
        );

        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
        expect(nodeCompleted).toMatchObject({
          data: { structured_output: { decision: 'approve', text: 'lgtm' } },
        });
      });

      test('/workflow respond rejects a decision the gate does not declare', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-respond-invalid',
            workflow_name: 'respond-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                decisions: [{ id: 'approve' }, { id: 'revise' }],
                decisionsAuthored: true,
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );
        mockResolveApprovalGate.mockClear();

        const result = await handleCommand(
          approveConversation,
          '/workflow respond run-respond-invalid nonexistent',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("does not declare decision 'nonexistent'");
        expect(mockResolveApprovalGate).not.toHaveBeenCalled();
      });

      test('legacy on_reject-configured gate keeps plain text output, unaffected by #2707', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-legacy-cap',
            workflow_name: 'legacy-capture-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                captureResponse: true,
                onRejectPrompt: 'Fix: $REJECTION_REASON',
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        await handleCommand(
          approveConversation,
          '/workflow approve run-legacy-cap LGTM looks good',
          operator
        );

        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
        expect(nodeCompleted).toMatchObject({
          data: { node_output: 'LGTM looks good', approval_decision: 'approved' },
        });
        expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
      });
    });

    describe('/workflow reject — on_reject branch', () => {
      test('records rejection and increments count when on_reject configured', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-reject-1',
            workflow_name: 'review-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'review this',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve the plan?',
                onRejectPrompt: 'Fix: $REJECTION_REASON',
                onRejectMaxAttempts: 3,
              },
              rejection_count: 0,
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        const result = await handleCommand(
          approveConversation,
          '/workflow reject run-reject-1 needs work',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Feedback recorded');
        // Stays 'paused' (no status write) — rework staged on the approval context,
        // stamped atomically via the CAS (#2075/#2113), with the audit event in the
        // same transaction (#2146)
        expect(mockResolveApprovalGate).toHaveBeenCalledWith(
          'run-reject-1',
          {
            approval: {
              type: 'approval',
              nodeId: 'review',
              message: 'Approve the plan?',
              onRejectPrompt: 'Fix: $REJECTION_REASON',
              onRejectMaxAttempts: 3,
              resolved: 'rejected',
              answeredVia: 'telegram',
              answeredAt: expect.any(String),
            },
            rejection_reason: 'needs work',
            rejection_count: 1,
          },
          [
            {
              event_type: 'approval_received',
              step_name: 'review',
              data: {
                via: 'telegram',
                occurrence: expect.any(String),
                decision: 'rejected',
                reason: 'needs work',
              },
            },
          ],
          undefined
        );
      });

      test('cancels when max attempts reached', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-reject-max',
            workflow_name: 'review-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'review this',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                onRejectPrompt: 'Fix: $REJECTION_REASON',
                onRejectMaxAttempts: 3,
              },
              rejection_count: 2,
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        const result = await handleCommand(
          approveConversation,
          '/workflow reject run-reject-max bad',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('max attempts reached');
        // Terminal reject resolves + cancels atomically (#2113); the audit event
        // rides the same transaction (#2146).
        expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
          'run-reject-max',
          [
            {
              event_type: 'approval_received',
              step_name: 'review',
              data: {
                via: 'telegram',
                occurrence: expect.any(String),
                decision: 'rejected',
                reason: 'bad',
              },
            },
          ],
          { step_name: 'review', reason: 'approval_rejected' },
          undefined
        );
        expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      });

      test('cancels immediately without on_reject', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-approve' },
            id: 'run-reject-plain',
            workflow_name: 'plain-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'gate',
                message: 'Approve?',
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        const result = await handleCommand(
          approveConversation,
          '/workflow reject run-reject-plain reason',
          operator
        );

        expect(result.success).toBe(true);
        // Terminal reject resolves + cancels atomically (#2113); the audit event
        // rides the same transaction (#2146).
        expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
          'run-reject-plain',
          [
            {
              event_type: 'approval_received',
              step_name: 'gate',
              data: {
                via: 'telegram',
                occurrence: expect.any(String),
                decision: 'rejected',
                reason: 'reason',
              },
            },
          ],
          { step_name: 'gate', reason: 'approval_rejected' },
          undefined
        );
        expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      });
    });
  });
});
