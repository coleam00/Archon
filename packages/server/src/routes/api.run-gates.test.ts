import {
  mockGetWorkflowRun,
  mockListDueWorkflowContinuations,
  mockCancelWorkflowRun,
  mockGetConversationById,
  mockHandleMessage,
  type MockWorkflowRun,
  mockCaptureApprovalResolved,
  mockUpdateWorkflowRun,
  mockResolveApprovalGate,
  mockResolveAndCancelApprovalGate,
  mockAnswerAttentionWait,
  mockCreateWorkflowEvent,
  mockResolveRunWorkflow,
  mockHydrateResumableRun,
  mockExecuteWorkflow,
  mockReclaimContainerEnv,
  MOCK_RUNNING_RUN,
  makeApp,
  MOCK_PAUSED_RUN,
} from '../test/api-workflow-runs-harness';
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { hostname } from 'node:os';
import * as sqlHost from '@archon/core/workflows/sql-host';
import { answeredPauseContinuation } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  startWorkflowContinuationScheduler,
  stopWorkflowContinuationScheduler,
  workflowResumeTargetForRun,
} from '../services/workflow-resume-service';

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/approve
// ---------------------------------------------------------------------------

describe('gate routes at an attention wait from before answers', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockResolveApprovalGate.mockClear();
    mockResolveAndCancelApprovalGate.mockClear();
  });

  for (const [verb, body] of [
    ['approve', {}],
    ['reject', { reason: 'no' }],
    ['respond', { decision: 'approve' }],
  ] as const) {
    test(`${verb} directs the operator to resume or abandon instead`, async () => {
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        id: 'run-action-required',
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 'rerun-ci',
            kind: 'attention',
            waitingSince: '2026-08-24T10:00:00.000Z',
            message: 'Re-run CI, then resume.',
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request(`/api/workflows/runs/run-action-required/${verb}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(400);
      const result = (await response.json()) as { error?: string };
      expect(result.error).toContain('resume');
      expect(result.error).toContain('abandon');
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
      expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    });
  }
});

describe('POST /api/workflows/runs/:runId/answer', () => {
  const askRun = (answered = false): MockWorkflowRun => ({
    ...MOCK_PAUSED_RUN,
    id: 'run-ask',
    metadata: {
      wait: {
        owner: 'node',
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: '2026-10-14T10:00:00.000Z',
        message: 'Which base?',
        pauseId: 'pause-1',
        form: 'select',
        options: [{ id: 'use-main' }, { id: 'use-dev' }],
        ...(answered
          ? {
              answer: { decision: 'use-main', text: '' },
              answeredVia: 'cli',
              answeredAt: '2026-10-14T10:01:00.000Z',
            }
          : {}),
      },
    },
  });
  const post = async (path: string, body: unknown): Promise<Response> =>
    makeApp().app.request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockAnswerAttentionWait.mockClear();
    mockResolveApprovalGate.mockClear();
  });

  test('records a declared option with the api surface', async () => {
    mockGetWorkflowRun.mockResolvedValue(askRun());
    const response = await post('/api/workflows/runs/run-ask/answer', {
      occurrence: 'pause-1',
      choose: ['use-dev'],
      text: 'dev is ahead',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe(
      `Workflow answered: ${MOCK_PAUSED_RUN.workflow_name}. The run continues on its own.`
    );
    expect(mockAnswerAttentionWait).toHaveBeenCalledTimes(1);
    expect(mockAnswerAttentionWait.mock.calls[0]?.[1]).toMatchObject({
      pauseId: 'pause-1',
      answer: { decision: 'use-dev', text: 'dev is ahead' },
      answeredVia: 'api',
    });
  });

  test('answers only the named fan-out child and validates its own choices', async () => {
    const children = [0, 1].map(index => ({
      ...askRun(),
      id: `child-${index}`,
      parent_run_id: 'questions-parent',
      metadata: {
        parent_node_id: 'answers',
        child_index: index,
        wait: {
          owner: 'node' as const,
          nodeId: 'ask',
          kind: 'attention' as const,
          waitingSince: '2026-10-14T10:00:00.000Z',
          message: `Question ${index}`,
          pauseId: `pause-${index}`,
          form: 'select' as const,
          options: [{ id: `choice-${index}` }],
        },
      },
    }));
    mockGetWorkflowRun.mockImplementation(async id => children.find(run => run.id === id) ?? null);
    const firstBefore = structuredClone(children[0]);
    const wrongChoice = await post('/api/workflows/runs/child-1/answer', {
      occurrence: 'pause-1',
      choose: ['choice-0'],
    });
    expect(wrongChoice.status).toBe(400);
    expect(mockAnswerAttentionWait).not.toHaveBeenCalled();
    const wrongOccurrence = await post('/api/workflows/runs/child-1/answer', {
      occurrence: 'pause-0',
      choose: ['choice-1'],
    });
    expect(wrongOccurrence.status).toBe(409);
    expect(mockAnswerAttentionWait).not.toHaveBeenCalled();
    const answered = await post('/api/workflows/runs/child-1/answer', {
      occurrence: 'pause-1',
      choose: ['choice-1'],
    });
    expect(answered.status).toBe(200);
    expect(mockAnswerAttentionWait).toHaveBeenCalledTimes(1);
    expect(mockAnswerAttentionWait).toHaveBeenCalledWith('child-1', {
      pauseId: 'pause-1',
      answer: { decision: 'choice-1', text: '' },
      answeredVia: 'api',
      answeredAt: expect.any(String),
    });
    expect(children[0]).toEqual(firstBefore);
  });

  test('refuses an undeclared option with 400 and a stale occurrence with 409', async () => {
    mockGetWorkflowRun.mockResolvedValue(askRun());
    const undeclared = await post('/api/workflows/runs/run-ask/answer', {
      occurrence: 'pause-1',
      choose: ['use-prod'],
    });
    expect(undeclared.status).toBe(400);
    expect(((await undeclared.json()) as { error: string }).error).toContain(
      "does not declare option 'use-prod'"
    );
    const stale = await post('/api/workflows/runs/run-ask/answer', {
      occurrence: 'pause-0',
      choose: ['use-dev'],
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toContain(
      "It is now awaiting occurrence 'pause-1'"
    );
    mockGetWorkflowRun.mockResolvedValue(askRun(true));
    const again = await post('/api/workflows/runs/run-ask/answer', {
      occurrence: 'pause-1',
      choose: ['use-dev'],
    });
    expect(again.status).toBe(409);
    expect(mockAnswerAttentionWait).not.toHaveBeenCalled();
  });

  test('respond answers an attention wait as sugar and refuses an undeclared option', async () => {
    mockGetWorkflowRun.mockResolvedValue(askRun());
    expect(
      (await post('/api/workflows/runs/run-ask/respond', { decision: 'use-prod' })).status
    ).toBe(400);
    expect(mockAnswerAttentionWait).not.toHaveBeenCalled();
    const response = await post('/api/workflows/runs/run-ask/respond', { decision: 'use-main' });
    expect(response.status).toBe(200);
    expect(mockAnswerAttentionWait.mock.calls[0]?.[1]).toMatchObject({
      answer: { decision: 'use-main', text: '' },
    });
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });
});

describe('dedicated gate answers with expectedGate', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockResolveApprovalGate.mockClear();
    mockResolveAndCancelApprovalGate.mockClear();
    mockUpdateWorkflowRun.mockReset();
    mockCreateWorkflowEvent.mockReset();
    mockHandleMessage.mockClear();
  });

  test.each(['approve', 'reject', 'respond'])(
    '/%s can guard a legacy gate and refuses its identity at a later pause',
    async route => {
      const post = () =>
        makeApp().app.request(`/api/workflows/runs/run-paused-1/${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedGate: 'review-gate', decision: 'approve' }),
        });
      mockGetWorkflowRun.mockResolvedValue(MOCK_PAUSED_RUN);
      expect((await post()).status).toBe(200);
      const resolver =
        route === 'reject' ? mockResolveAndCancelApprovalGate : mockResolveApprovalGate;
      expect(resolver.mock.calls[0]?.[3]).toBe('review-gate');
      mockResolveApprovalGate.mockClear();
      mockResolveAndCancelApprovalGate.mockClear();
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        metadata: {
          approval: {
            type: 'approval',
            message: 'Review again',
            nodeId: 'review-gate',
            pauseId: 'new-pause',
          },
        },
      });
      expect((await post()).status).toBe(409);
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
      expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    }
  );

  const attentionRun = (pauseId: string): MockWorkflowRun => ({
    ...MOCK_PAUSED_RUN,
    metadata: {
      wait: {
        owner: 'node',
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: '2026-10-14T10:00:00.000Z',
        message: 'Review?',
        pauseId,
        form: 'select',
        options: [{ id: 'approve' }, { id: 'reject' }],
      },
    },
  });

  test.each(['approve', 'reject'])(
    '/%s refuses an attention wait that changes between route and operation reads',
    async route => {
      const earlier = attentionRun('attention-before');
      const later = attentionRun('attention-after');
      mockAnswerAttentionWait.mockClear();
      mockGetWorkflowRun.mockResolvedValueOnce(earlier).mockResolvedValue(later);
      const response = await makeApp().app.request(`/api/workflows/runs/run-paused-1/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedGate: { nodeId: 'ask', pauseId: 'attention-before' } }),
      });
      expect(response.status).toBe(409);
      expect(mockAnswerAttentionWait).not.toHaveBeenCalled();
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
      expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
      expect(mockHandleMessage).not.toHaveBeenCalled();
      expect(later.status).toBe('paused');
      expect(later.metadata.wait).not.toHaveProperty('answer');
    }
  );

  test.each([
    'approve',
    'terminal reject',
    'writeback reject',
    'rework reject',
    'declared reject',
    'custom response',
    'attention approve',
    'attention reject',
  ])('%s preserves conflict after a lost write even if the diagnostic read fails', async mode => {
    const attention = mode.startsWith('attention');
    const route =
      mode === 'custom response' ? 'respond' : mode.endsWith('reject') ? 'reject' : 'approve';
    const expectedGate = { nodeId: attention ? 'ask' : 'review-gate', pauseId: 'pause-current' };
    const run = attention
      ? attentionRun(expectedGate.pauseId)
      : {
          ...MOCK_PAUSED_RUN,
          metadata: {
            approval: {
              type: mode === 'writeback reject' ? 'writeback' : 'approval',
              message: 'Review',
              ...expectedGate,
              ...(mode === 'rework reject' ? { onRejectPrompt: 'Try again' } : {}),
              ...(['declared reject', 'custom response'].includes(mode)
                ? {
                    decisionsAuthored: true,
                    decisions: [{ id: 'approve' }, { id: 'reject' }, { id: 'revise' }],
                  }
                : {}),
            },
          },
        };
    mockAnswerAttentionWait.mockClear();
    mockGetWorkflowRun
      .mockResolvedValueOnce(run)
      .mockResolvedValueOnce(run)
      .mockRejectedValueOnce(new Error('diagnostic lookup unavailable'));
    const resolver =
      mode === 'terminal reject' ? mockResolveAndCancelApprovalGate : mockResolveApprovalGate;
    if (attention) mockAnswerAttentionWait.mockResolvedValueOnce({ answered: false });
    else resolver.mockResolvedValueOnce({ resolved: false });
    const response = await makeApp().app.request(`/api/workflows/runs/run-paused-1/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedGate, decision: 'revise' }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      'no longer paused at the expected gate'
    );
    if (attention) expect(mockAnswerAttentionWait).toHaveBeenCalledTimes(1);
    else expect(resolver).toHaveBeenCalledTimes(1);
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  });

  test.each(['approve', 'reject', 'attention approve', 'attention reject'])(
    '%s still reports an actual write failure as 500',
    async mode => {
      const attention = mode.startsWith('attention');
      const route = mode.endsWith('reject') ? 'reject' : 'approve';
      const expectedGate = { nodeId: attention ? 'ask' : 'review-gate', pauseId: 'pause-current' };
      mockGetWorkflowRun.mockResolvedValue(
        attention
          ? attentionRun(expectedGate.pauseId)
          : {
              ...MOCK_PAUSED_RUN,
              metadata: { approval: { type: 'approval', message: 'Review', ...expectedGate } },
            }
      );
      const failure = new Error('answer write failed');
      if (attention) mockAnswerAttentionWait.mockRejectedValueOnce(failure);
      else if (route === 'approve') mockResolveApprovalGate.mockRejectedValueOnce(failure);
      else mockResolveAndCancelApprovalGate.mockRejectedValueOnce(failure);
      const response = await makeApp().app.request(`/api/workflows/runs/run-paused-1/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedGate }),
      });
      expect(response.status).toBe(500);
      expect(mockGetWorkflowRun).toHaveBeenCalledTimes(2);
      expect(mockHandleMessage).not.toHaveBeenCalled();
    }
  );

  test.each(['approve', 'reject'])(
    '/%s refuses an answer prepared before the run pauses again',
    async route => {
      const earlier = {
        ...MOCK_PAUSED_RUN,
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'review-gate',
            pauseId: 'pause-before',
            message: 'Review',
            decisionsAuthored: true,
            decisions: [{ id: 'approve' }, { id: 'reject' }],
          },
        },
      };
      const expectedGate = {
        nodeId: earlier.metadata.approval.nodeId,
        pauseId: earlier.metadata.approval.pauseId,
      };
      const later = {
        ...earlier,
        metadata: { approval: { ...earlier.metadata.approval, pauseId: 'pause-after' } },
      };
      mockGetWorkflowRun.mockResolvedValue(later);
      const response = await makeApp().app.request(`/api/workflows/runs/${later.id}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedGate }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toContain(
        "It is now awaiting occurrence 'pause-after'."
      );
      expect(later.status).toBe('paused');
      expect(later.metadata.approval).not.toHaveProperty('resolved');
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
      expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
      expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
      expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
      expect(mockHandleMessage).not.toHaveBeenCalled();
    }
  );

  test.each(['approve', 'reject'])(
    '/%s passes the matching identity to the atomic write',
    async route => {
      const expectedGate = { nodeId: 'review-gate', pauseId: 'pause-current' };
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        metadata: { approval: { type: 'approval', message: 'Review', ...expectedGate } },
      });
      const response = await makeApp().app.request(`/api/workflows/runs/run-paused-1/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedGate }),
      });
      expect(response.status).toBe(200);
      const resolver =
        route === 'approve' ? mockResolveApprovalGate : mockResolveAndCancelApprovalGate;
      expect(resolver.mock.calls[0]?.[3]).toEqual(expectedGate);
    }
  );

  test.each(['approve', 'reject'])(
    '/%s reads JSON sent without a JSON content type',
    async route => {
      const expectedGate = { nodeId: 'review-gate', pauseId: 'pause-current' };
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        metadata: { approval: { type: 'approval', message: 'Review', ...expectedGate } },
      });
      const response = await makeApp().app.request(`/api/workflows/runs/run-paused-1/${route}`, {
        method: 'POST',
        body: JSON.stringify({ comment: 'feedback', reason: 'feedback', expectedGate }),
      });
      expect(response.status).toBe(200);
      const resolver =
        route === 'approve' ? mockResolveApprovalGate : mockResolveAndCancelApprovalGate;
      expect(resolver.mock.calls[0]?.[3]).toEqual(expectedGate);
      const events =
        route === 'approve'
          ? mockResolveApprovalGate.mock.calls[0]?.[2]
          : mockResolveAndCancelApprovalGate.mock.calls[0]?.[1];
      expect(events).toContainEqual(
        expect.objectContaining({
          event_type: 'approval_received',
          data: expect.objectContaining(
            route === 'approve' ? { comment: 'feedback' } : { reason: 'feedback' }
          ),
        })
      );
    }
  );

  test.each(['approve', 'reject'])(
    '/%s maps an atomic write lost after the read to 409',
    async route => {
      const expectedGate = { nodeId: 'review-gate', pauseId: 'pause-current' };
      mockGetWorkflowRun.mockResolvedValue({
        ...MOCK_PAUSED_RUN,
        metadata: { approval: { type: 'approval', message: 'Review', ...expectedGate } },
      });
      if (route === 'approve') mockResolveApprovalGate.mockResolvedValueOnce({ resolved: false });
      else mockResolveAndCancelApprovalGate.mockResolvedValueOnce({ resolved: false });
      const response = await makeApp().app.request(`/api/workflows/runs/run-paused-1/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedGate }),
      });
      expect(response.status).toBe(409);
      const resolver =
        route === 'approve' ? mockResolveApprovalGate : mockResolveAndCancelApprovalGate;
      expect(resolver.mock.calls[0]?.[3]).toEqual(expectedGate);
      expect(mockHandleMessage).not.toHaveBeenCalled();
      expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
      expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    }
  );

  test.each(
    ['approve', 'reject'].flatMap(route => [
      { route, expectedGate: { nodeId: 'review-gate' } },
      { route, expectedGate: { nodeId: '', pauseId: 'pause-1' } },
      { route, expectedGate: { nodeId: 'review-gate', pauseId: '' } },
    ])
  )(
    '/$route refuses an incomplete gate identity $expectedGate without writes',
    async ({ route, expectedGate }) => {
      mockGetWorkflowRun.mockResolvedValue(MOCK_PAUSED_RUN);
      const response = await makeApp().app.request(`/api/workflows/runs/run-paused-1/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedGate }),
      });
      expect(response.status).toBe(400);
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
      expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    }
  );

  test.each(['approve', 'reject'])(
    '/%s reports stale identity before status or decision refusal',
    async route => {
      for (const run of [
        MOCK_RUNNING_RUN,
        {
          ...MOCK_PAUSED_RUN,
          metadata: {
            approval: {
              type: 'approval',
              nodeId: 'next-gate',
              pauseId: 'pause-next',
              message: 'Choose',
              decisionsAuthored: true,
              decisions: [{ id: 'accept' }],
            },
          },
        },
      ]) {
        mockGetWorkflowRun.mockResolvedValue(run);
        const response = await makeApp().app.request(`/api/workflows/runs/${run.id}/${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedGate: { nodeId: 'review-gate', pauseId: 'pause-old' } }),
        });
        expect(response.status).toBe(409);
        expect(mockResolveApprovalGate).not.toHaveBeenCalled();
        expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
      }
    }
  );

  test.each(['approve', 'reject'])('/%s still accepts a request without a body', async route => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_PAUSED_RUN);
    const response = await makeApp().app.request(`/api/workflows/runs/run-paused-1/${route}`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const resolver =
      route === 'approve' ? mockResolveApprovalGate : mockResolveAndCancelApprovalGate;
    expect(resolver.mock.calls[0]?.[3]).toBeUndefined();
  });
});

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
    mockReclaimContainerEnv.mockImplementationOnce(() => Promise.reject(new Error('docker down')));
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

    const response = await post('/api/workflows/runs/run-slack-gate/approve', { comment: 'LGTM' });

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
          data: { via: 'api', occurrence: expect.any(String), decision: 'rejected', reason: 'no' },
        },
      ],
      { step_name: 'review-gate', reason: 'approval_rejected' },
      undefined
    );
  });
});
