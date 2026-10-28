// @archon-test-isolated
import { describe, test, expect, beforeEach } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  operator,
  mockGetWorkflowRun,
  mockResolveApprovalGate,
  mockResolveAndCancelApprovalGate,
  mockCaptureApprovalResolved,
  makePausedRun,
  expectedGateForOccurrence,
  StaleGateAnswerError,
  approveWorkflow,
  rejectWorkflow,
  respondToWorkflow,
} from './test-harness';

describe('respondToWorkflow', () => {
  beforeEach(() => {
    mockCaptureApprovalResolved.mockClear();
    mockGetWorkflowRun.mockClear();
    mockResolveApprovalGate.mockClear();
    mockResolveApprovalGate.mockResolvedValue({ resolved: true });
  });

  test.each(['approve', 'reject'])(
    'refuses undeclared %s through both response and dedicated operations without writes',
    async decision => {
      const run = makePausedRun({
        metadata: {
          approval: {
            nodeId: 'review',
            message: 'Choose',
            type: 'approval',
            decisionsAuthored: true,
            decisions: [{ id: 'accept' }, { id: 'revise' }],
          },
        },
      });
      mockGetWorkflowRun.mockResolvedValue(run);
      mockResolveAndCancelApprovalGate.mockClear();
      const before = structuredClone(run);
      const dedicated = decision === 'approve' ? approveWorkflow : rejectWorkflow;
      for (const respond of [
        () => dedicated(run.id, 'feedback', operator, { via: 'cli' }),
        () => respondToWorkflow(run.id, decision, 'feedback', operator, { via: 'cli' }),
      ]) {
        await expect(respond()).rejects.toThrow(
          `does not declare decision '${decision}'. Declared decisions: accept, revise.`
        );
        expect(run).toEqual(before);
        expect(mockResolveApprovalGate).not.toHaveBeenCalled();
        expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
        expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
      }
    }
  );

  test.each([{ decisions: undefined }, { decisions: [] }])(
    'malformed authored vocabularies cannot fall through to legacy cancellation (%j)',
    async ({ decisions }) => {
      mockGetWorkflowRun.mockResolvedValue(
        makePausedRun({
          metadata: {
            approval: {
              nodeId: 'review',
              message: 'Choose',
              type: 'approval',
              decisionsAuthored: true,
              decisions,
            },
          },
        })
      );
      mockResolveAndCancelApprovalGate.mockClear();
      await expect(rejectWorkflow('run-1', 'Stop', operator, { via: 'cli' })).rejects.toThrow(
        'malformed authored decisions'
      );
      await expect(
        respondToWorkflow('run-1', 'reject', 'Stop', operator, { via: 'cli' })
      ).rejects.toThrow('malformed authored decisions');
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
      expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
      expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
    }
  );

  test('resolves a declared custom decision without approve in the vocabulary', async () => {
    mockResolveAndCancelApprovalGate.mockClear();
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          approval: {
            nodeId: 'review',
            message: 'Choose',
            type: 'approval',
            decisionsAuthored: true,
            decisions: [{ id: 'accept' }, { id: 'revise' }],
          },
        },
      })
    );
    await respondToWorkflow('run-1', 'accept', 'Use this plan', operator, { via: 'cli' });
    expect(mockResolveApprovalGate).toHaveBeenCalledTimes(1);
    const call = mockResolveApprovalGate.mock.calls[0];
    if (!call) throw new Error('Expected gate resolution');
    expect(call[2]).toContainEqual(
      expect.objectContaining({
        event_type: 'node_completed',
        step_name: 'review',
        data: expect.objectContaining({
          structured_output: { decision: 'accept', text: 'Use this plan' },
          node_output: JSON.stringify({ decision: 'accept', text: 'Use this plan' }),
        }),
      })
    );
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
  });

  test('resolves a custom decision on an escalated body-terminal-gate pause — node_completed lands under the namespaced <nodeId>.<bodyGateId> step_name (#2707 step 3)', async () => {
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

    await respondToWorkflow('run-1', 'revise', 'please improve X', operator, { via: 'cli' });

    const call = mockResolveApprovalGate.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('Expected resolveApprovalGate to be called');
    const [, metadataPayload, events] = call;
    expect(metadataPayload).toMatchObject({
      approval: { nodeId: 'grp', bodyGateId: 'check', resolved: 'approved' },
    });
    const nodeCompleted = events.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({
      step_name: 'grp.check',
      data: {
        node_output: JSON.stringify({ decision: 'revise', text: 'please improve X' }),
        structured_output: { decision: 'revise', text: 'please improve X' },
      },
    });
    const approvalReceived = events.find(e => e.event_type === 'approval_received');
    expect(approvalReceived).toMatchObject({ step_name: 'grp' });
  });

  const declaredGate = (pauseId: string): WorkflowRun =>
    makePausedRun({
      user_id: 'user-who-answered',
      metadata: {
        approval: {
          nodeId: 'review',
          pauseId,
          message: 'Choose',
          type: 'approval',
          decisionsAuthored: true,
          decisions: [{ id: 'approve' }, { id: 'reject' }, { id: 'revise' }],
        },
      },
    });

  test.each(['approve', 'reject', 'revise'])(
    'a %s answer records the surface it came through and when, never who answered',
    async decision => {
      mockGetWorkflowRun.mockResolvedValue(declaredGate('pause-one'));
      await respondToWorkflow(
        'run-1',
        decision,
        'because',
        { kind: 'user', userId: 'user-who-answered' },
        { via: 'slack' }
      );
      const [, metadata, events] = mockResolveApprovalGate.mock.calls[0] ?? [];
      const approval = (metadata as { approval: Record<string, unknown> }).approval;
      expect(approval).toMatchObject({ answeredVia: 'slack' });
      expect(Date.parse(String(approval.answeredAt))).not.toBeNaN();
      expect(events?.find(e => e.event_type === 'approval_received')?.data).toMatchObject({
        via: 'slack',
        occurrence: 'pause-one',
      });
      expect(JSON.stringify([metadata, events])).not.toContain('user-who-answered');
    }
  );

  test('a malformed surface id is refused before anything is written', async () => {
    mockGetWorkflowRun.mockResolvedValue(declaredGate('pause-one'));
    await expect(
      respondToWorkflow('run-1', 'revise', undefined, operator, { via: 'Not A Surface' })
    ).rejects.toThrow();
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });

  test('a race lost after the occurrence check still names the occurrence the run is at now', async () => {
    const stale = declaredGate('pause-one');
    // The operation reads the run at pause-one; by the time the CAS runs it has moved on.
    mockGetWorkflowRun.mockResolvedValueOnce(stale);
    mockGetWorkflowRun.mockResolvedValue(declaredGate('pause-two'));
    mockResolveApprovalGate.mockResolvedValueOnce({ resolved: false });
    const expectedGate = expectedGateForOccurrence(stale, 'pause-one');
    expect(expectedGate).toEqual({ nodeId: 'review', pauseId: 'pause-one' });
    await expect(
      respondToWorkflow('run-1', 'revise', undefined, operator, { via: 'cli', expectedGate })
    ).rejects.toThrow("It is now awaiting occurrence 'pause-two'.");
    expect(mockResolveApprovalGate.mock.calls[0]?.[3]).toEqual(expectedGate);
  });

  test('a stale occurrence is reported before the current gate validates the decision', async () => {
    // The run moved on from a gate declaring 'revise' to one that does not. The answer
    // was meant for the old pause, so the caller must hear that, not "undeclared decision".
    const current = makePausedRun({
      user_id: 'user-who-answered',
      metadata: {
        approval: {
          nodeId: 'later',
          pauseId: 'pause-two',
          message: 'Choose',
          type: 'approval',
          decisionsAuthored: true,
          decisions: [{ id: 'approve' }, { id: 'accept' }],
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValue(current);
    const expectedGate = { nodeId: 'review', pauseId: 'pause-one' };
    for (const decision of ['revise', 'approve', 'reject']) {
      await expect(
        respondToWorkflow('run-1', decision, undefined, operator, { via: 'cli', expectedGate })
      ).rejects.toThrow("It is now awaiting occurrence 'pause-two'.");
    }
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
  });

  test('a malformed surface is refused before a terminal reject cancels the run', async () => {
    mockGetWorkflowRun.mockResolvedValue(makePausedRun());
    await expect(
      rejectWorkflow('run-1', 'no', operator, { via: 'Not A Surface' })
    ).rejects.toThrow();
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
  });

  test('a legacy occurrence names the gate by node, as run-attention reports it', () => {
    expect(expectedGateForOccurrence(makePausedRun(), 'legacy:review')).toBe('review');
  });

  test.each(['approve', 'reject', 'revise'])(
    'passes the expected node to the atomic resolver for a %s button',
    async decision => {
      mockGetWorkflowRun.mockResolvedValue(
        makePausedRun({
          metadata: {
            approval: {
              // Matches the expected gate when read, so the CAS is what loses the race.
              nodeId: 'earlier',
              message: 'Choose',
              type: 'approval',
              decisionsAuthored: true,
              decisions: [{ id: 'approve' }, { id: 'reject' }, { id: 'revise' }],
            },
          },
        })
      );
      mockResolveApprovalGate.mockResolvedValueOnce({ resolved: false });
      await expect(
        respondToWorkflow('run-1', decision, undefined, operator, {
          via: 'cli',
          expectedGate: 'earlier',
        })
      ).rejects.toThrow('no longer paused at the expected gate');
      expect(mockResolveApprovalGate.mock.calls[0]?.[3]).toBe('earlier');
    }
  );

  test('a lost race stays a stale answer when the run cannot be re-read', async () => {
    mockGetWorkflowRun
      .mockResolvedValueOnce(makePausedRun())
      .mockRejectedValueOnce(new Error('connection reset'));
    mockResolveApprovalGate.mockResolvedValueOnce({ resolved: false });
    await expect(
      approveWorkflow('run-1', undefined, operator, { via: 'cli', expectedGate: 'review' })
    ).rejects.toBeInstanceOf(StaleGateAnswerError);
  });

  test('delegates approve/reject to the dedicated functions unchanged', async () => {
    mockGetWorkflowRun.mockResolvedValue(makePausedRun());
    await respondToWorkflow('run-1', 'approve', 'looks good', operator, { via: 'cli' });
    expect(mockResolveApprovalGate).toHaveBeenCalledTimes(1);
    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'approved' });
  });
});
