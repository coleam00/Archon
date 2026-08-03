/**
 * Approval-variant fixture. Exercises message, capture_response, and the
 * on_reject sub-object (prompt + max_attempts). Authored already-sparse.
 */
import type { WireWorkflowDefinition } from '../types';

export const approvalFixture: WireWorkflowDefinition = {
  name: 'approval-fixture',
  description: 'Pauses for human review before proceeding.',
  nodes: [
    {
      id: 'gate',
      approval: {
        message: 'Approve the plan to continue?',
        capture_response: true,
        on_reject: {
          prompt: 'Revise the plan based on the reviewer feedback in $REJECTION_REASON.',
          max_attempts: 3,
        },
      },
    },
  ],
};
