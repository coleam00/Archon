import {
  MOCK_PAUSED_RUN,
  MOCK_RUNNING_RUN,
  makeApp,
  mockAnswerAttentionWait,
  mockCreateWorkflowEvent,
  mockGetWorkflowRun,
  mockHandleMessage,
  mockResolveAndCancelApprovalGate,
  mockResolveApprovalGate,
  mockUpdateWorkflowRun,
  type MockWorkflowRun,
} from '../../test/api-workflow-runs-harness';
import { beforeEach, describe, expect, test } from 'bun:test';

export function registerLegacyAttentionTests() {
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
}

export function registerAnswerTests() {
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
      mockGetWorkflowRun.mockImplementation(
        async id => children.find(run => run.id === id) ?? null
      );
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
}

export function registerExpectedGateTests() {
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

    function lostWriteRun(mode: string, expectedGate: { nodeId: string; pauseId: string }) {
      return mode.startsWith('attention')
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
    }

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
      const run = lostWriteRun(mode, expectedGate);
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
        const expectedGate = {
          nodeId: attention ? 'ask' : 'review-gate',
          pauseId: 'pause-current',
        };
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
}
