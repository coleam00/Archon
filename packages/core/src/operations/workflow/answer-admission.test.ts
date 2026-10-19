// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  operator,
  mockGetWorkflowRun,
  mockResolveApprovalGate,
  makePausedRun,
  respondToWorkflow,
} from './test-harness';

describe('answer text defaults', () => {
  const newModeGate = (): WorkflowRun =>
    makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Choose',
          type: 'approval',
          decisions: [{ id: 'approve' }, { id: 'reject' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });

  async function answerWith(
    decision: 'approve' | 'reject' | 'revise',
    text = '   '
  ): Promise<Array<Record<string, unknown>>> {
    mockGetWorkflowRun.mockResolvedValueOnce(newModeGate());
    await respondToWorkflow('run-1', decision, text, operator, { via: 'cli' });
    const call = mockResolveApprovalGate.mock.calls.at(-1);
    if (!call) throw new Error('Expected resolveApprovalGate to be called');
    return call[2] as unknown[] as Array<Record<string, unknown>>;
  }

  const recorded = (events: Array<Record<string, unknown>>, type: string) =>
    events.find(e => e.event_type === type)?.data as Record<string, unknown> | undefined;

  test('counts as no text on approve, reject and respond alike', async () => {
    const approve = await answerWith('approve');
    expect(recorded(approve, 'node_completed')?.structured_output).toEqual({
      decision: 'approve',
      text: '',
    });
    expect(recorded(approve, 'approval_received')?.comment).toBe('Approved');

    const reject = await answerWith('reject');
    expect(recorded(reject, 'node_completed')?.structured_output).toEqual({
      decision: 'reject',
      text: 'Rejected',
    });
    expect(recorded(reject, 'approval_received')?.reason).toBe('Rejected');

    const revise = await answerWith('revise');
    expect(recorded(revise, 'node_completed')?.structured_output).toEqual({
      decision: 'revise',
      text: '',
    });
    expect(recorded(revise, 'approval_received')?.comment).toBe('revise');
  });

  test('keeps explicit text verbatim on approve, reject and respond', async () => {
    const text = '  too risky\n';

    const approve = await answerWith('approve', text);
    expect(recorded(approve, 'node_completed')?.structured_output).toEqual({
      decision: 'approve',
      text,
    });
    expect(recorded(approve, 'approval_received')?.comment).toBe(text);

    const reject = await answerWith('reject', text);
    expect(recorded(reject, 'node_completed')?.structured_output).toEqual({
      decision: 'reject',
      text,
    });
    expect(recorded(reject, 'approval_received')?.reason).toBe(text);

    const revise = await answerWith('revise', text);
    expect(recorded(revise, 'node_completed')?.structured_output).toEqual({
      decision: 'revise',
      text,
    });
    expect(recorded(revise, 'approval_received')?.comment).toBe(text);
  });
});
