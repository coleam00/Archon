import {
  RealDetachedRunOwnerUnavailableError,
  setSessionUserId,
  setRequireRunIdentity,
  makeUser,
  mockFindOrCreateUser,
  realGetUserById,
  mockGetUserById,
  mockGetWorkflowRun,
  mockCancelWorkflowRun,
  mockGetConversationById,
  mockHandleMessage,
  type MockWorkflowRun,
  mockDeleteWorkflowRun,
  mockResolveApprovalGate,
  mockResolveAndCancelApprovalGate,
  mockFindChildRuns,
  mockSignalWorkflowWait,
  mockResolveRunWorkflow,
  mockReclaimContainerEnv,
  mockRequestDetachedRunStop,
  mockHydrateResumableRun,
  mockExecuteWorkflow,
  NOW_DATE,
  MOCK_RUNNING_RUN,
  MOCK_COMPLETED_RUN,
  MOCK_FAILED_RUN,
  MOCK_PENDING_RUN,
  makeApp,
  MOCK_PAUSED_RUN,
} from '../test/api-workflow-runs-harness';
import { RUN_ACTIONS } from '@archon/core/operations/run-authorization';
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { RunActor } from '@archon/core';
import * as sqlHost from '@archon/core/workflows/sql-host';
import { startRunLiveOwner } from '@archon/core/services/run-live-owner';

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/cancel
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/cancel', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockCancelWorkflowRun.mockReset();
    mockCancelWorkflowRun.mockResolvedValue({ cancelled: true });
    mockFindChildRuns.mockReset();
    mockFindChildRuns.mockResolvedValue([]);
    mockRequestDetachedRunStop.mockReset();
    mockRequestDetachedRunStop.mockImplementation(() =>
      Promise.reject(new RealDetachedRunOwnerUnavailableError('run', 'ENOENT', 'unreachable'))
    );
  });

  /** A running run this server process executes: it holds the run's real endpoint. */
  async function withRunInThisProcess(body: (runId: string) => Promise<void>): Promise<void> {
    const runId = `api-cancel-${crypto.randomUUID()}`;
    const owner = await startRunLiveOwner(runId);
    try {
      mockGetWorkflowRun.mockResolvedValue({ ...MOCK_RUNNING_RUN, id: runId });
      await body(runId);
    } finally {
      await owner.close();
    }
  }

  test('cancels cooperatively a run this server executes', async () => {
    await withRunInThisProcess(async runId => {
      const { app } = makeApp();
      const response = await app.request(`/api/workflows/runs/${runId}/cancel`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as { success: boolean; message: string };
      expect(body.success).toBe(true);
      // Cooperative cancellation reports possible host-command leftovers only on POSIX hosts.
      if (process.platform === 'win32') {
        expect(body.message).toBe('Cancelled workflow: deploy');
        expect(mockCancelWorkflowRun).toHaveBeenCalledWith(runId, { cancel_reason: 'operator' });
      } else {
        expect(body.message).toStartWith('Cancelled workflow: deploy — warning: ');
        expect(body.message).toContain('untracked background work');
        expect(mockCancelWorkflowRun).toHaveBeenCalledWith(runId, {
          cancel_reason: 'operator',
          reason: expect.stringContaining('untracked background work'),
          warnings: [expect.stringContaining('untracked background work')],
        });
      }
      expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
    });
  });

  test('reports "nothing to cancel" when the run finished in the cancel TOCTOU window', async () => {
    // The run passes the status check (running), but cancelWorkflowRun no-ops
    // because the run reached a terminal state first — the route must not claim
    // a false "Cancelled" (#1830 I1).
    await withRunInThisProcess(async runId => {
      mockCancelWorkflowRun.mockResolvedValue({ cancelled: false });
      const { app } = makeApp();
      const response = await app.request(`/api/workflows/runs/${runId}/cancel`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toContain('nothing to cancel');
    });
  });

  test('stops an owner in another process before recording cancelled', async () => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_RUNNING_RUN);
    const order: string[] = [];
    mockRequestDetachedRunStop.mockImplementationOnce(async () => ({
      pid: 4242,
      stop: async () => {
        order.push('stop');
        return {
          warnings: [
            'Some process still holds node output; it was not signalled. Use lsof on the checkout.',
          ],
        };
      },
      release: () => undefined,
    }));
    mockCancelWorkflowRun.mockImplementationOnce(async () => {
      order.push('cancel');
      return { cancelled: true };
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(order).toEqual(['stop', 'cancel']);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain(
      'Some process still holds node output; it was not signalled. Use lsof on the checkout.'
    );
    expect(body.message).toContain("Stopped the run's live owner process (pid 4242)");
  });

  test('returns 409 with the recorded owner facts when no owner answers, run unchanged', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_RUNNING_RUN,
      metadata: { execution_owner: { host: 'build-box', pid: 4242 } },
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Recorded owner: host build-box, pid 4242.');
    expect(body.error).toContain('abandon the run');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('returns 409 when an owner answers but cannot be stopped, run unchanged', async () => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_RUNNING_RUN);
    mockRequestDetachedRunStop.mockImplementationOnce(async () => ({
      pid: 4242,
      stop: () => Promise.reject(new Error('process still exists')),
      release: () => undefined,
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Could not stop the live owner of run run-uuid-1 (pid 4242)');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('returns 400 for a pending run: nothing executes it yet, so abandon is the action', async () => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_PENDING_RUN);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-3/cancel', {
      method: 'POST',
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("status 'pending'");
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/unknown-run/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 400 when trying to cancel a completed run', async () => {
    mockGetWorkflowRun.mockImplementation(async () => MOCK_COMPLETED_RUN);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-2/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('completed');
  });

  test('returns 400 when trying to cancel an already-cancelled run', async () => {
    mockGetWorkflowRun.mockImplementation(async () => ({
      ...MOCK_RUNNING_RUN,
      status: 'cancelled' as const,
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('cancelled');
  });

  test('returns 400 when trying to cancel a failed run', async () => {
    mockGetWorkflowRun.mockImplementation(async () => ({
      ...MOCK_RUNNING_RUN,
      status: 'failed' as const,
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
  });

  test('returns 500 when DB throws during cancel', async () => {
    await withRunInThisProcess(async runId => {
      mockCancelWorkflowRun.mockImplementationOnce(async () => {
        throw new Error('DB locked');
      });

      const { app } = makeApp();
      const response = await app.request(`/api/workflows/runs/${runId}/cancel`, {
        method: 'POST',
      });
      expect(response.status).toBe(500);

      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Failed to cancel');
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/resume
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/resume', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockGetConversationById.mockReset();
    mockHandleMessage.mockReset();
    mockResolveRunWorkflow.mockClear();
    mockHydrateResumableRun.mockClear();
    mockExecuteWorkflow.mockClear();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-missing/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is not in failed status', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cannot resume');
  });

  test('resumes headlessly (no dispatch) when run has no parent_conversation_id (#2008)', async () => {
    mockGetConversationById.mockResolvedValueOnce({
      id: 'conv-uuid-1',
      platform_type: 'cli',
      platform_conversation_id: 'cli-thread',
    });
    // A CLI-launched run has no parent conversation to dispatch a chat
    // message through — it now resumes directly, in-process, instead of
    // being stranded until someone runs the CLI.
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_FAILED_RUN,
      parent_conversation_id: null,
      working_path: '/tmp/worktrees/run-uuid-4',
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Resuming workflow');
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockGetConversationById).toHaveBeenCalledWith('conv-uuid-1');
    expect(mockHydrateResumableRun).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    const cwd = mockExecuteWorkflow.mock.calls[0]?.[3];
    expect(cwd).toBe('/tmp/worktrees/run-uuid-4');
  });

  test('returns 409 with the refusal when the run resource is busy', async () => {
    const { WorkflowResourceBusyError } = await import('@archon/workflows/store');
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_FAILED_RUN,
      origin: null,
      conversation_id: null,
      parent_conversation_id: null,
      working_path: '/tmp/worktrees/run-busy',
    });
    mockHydrateResumableRun.mockRejectedValueOnce(
      new WorkflowResourceBusyError('run-busy', { kind: 'run', id: 'holder' })
    );
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-busy/resume', { method: 'POST' });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "Workflow run 'run-busy' cannot resume while resource owner 'holder' has priority."
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('resumes an origin-free run without looking up a conversation', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_FAILED_RUN,
      origin: null,
      conversation_id: null,
      parent_conversation_id: null,
      working_path: '/tmp/worktrees/run-local',
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-local/resume', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(mockGetConversationById).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow.mock.calls[0]?.[6]).toBeUndefined();
  });

  test('returns 400 with CLI hint when the run has no parent conversation and cannot be resolved headlessly', async () => {
    mockGetConversationById.mockResolvedValueOnce({
      id: 'conv-uuid-1',
      platform_type: 'cli',
      platform_conversation_id: 'cli-thread',
    });
    // Safe degrade: the workflow source is unresolvable (e.g. deleted) —
    // falls back to the existing CLI-hint response instead of a silent 500.
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_FAILED_RUN,
      parent_conversation_id: null,
      working_path: '/tmp/worktrees/run-uuid-4',
    });
    mockResolveRunWorkflow.mockResolvedValueOnce({
      ok: false,
      message: 'workflow deleted',
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('archon workflow resume run-uuid-4');
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockResolveRunWorkflow).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('returns 400 when parent conversation no longer exists', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_FAILED_RUN,
      parent_conversation_id: 'deleted-conv-uuid',
    });
    mockGetConversationById.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('returns 400 when parent conversation is non-web', async () => {
    // Slack/Telegram/GitHub-sourced runs cannot route through the web
    // adapter — the dispatcher is wired to webAdapter + lockManager.
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_FAILED_RUN,
      parent_conversation_id: 'slack-parent-uuid',
    });
    mockGetConversationById.mockResolvedValueOnce({
      id: 'slack-parent-uuid',
      platform_conversation_id: '1234567890.123456',
      platform_type: 'slack',
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('archon workflow resume run-uuid-4');
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('returns 200 and dispatches resume when parent is a web conversation', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_FAILED_RUN,
      parent_conversation_id: 'parent-conv-uuid',
      user_message: 'Run the deploy',
    });
    mockGetConversationById.mockResolvedValueOnce({
      id: 'parent-conv-uuid',
      platform_conversation_id: 'web-plat-abc',
      platform_type: 'web',
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/resume', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Resuming workflow');

    // dispatchToOrchestrator → lockManager → handleMessage
    expect(mockHandleMessage).toHaveBeenCalled();
    const [, platformConvId, dispatchedMessage] = mockHandleMessage.mock.calls[0] ?? [];
    expect(platformConvId).toBe('web-plat-abc');
    expect(dispatchedMessage).toBe('/workflow resume run-uuid-4');
    expect(mockHandleMessage.mock.calls[0]?.[3]).toMatchObject({ actor: { kind: 'operator' } });
  });
});

describe('POST /api/workflows/runs/:runId/signal', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockGetConversationById.mockReset();
    mockHandleMessage.mockReset();
    mockSignalWorkflowWait.mockReset();
    mockSignalWorkflowWait.mockResolvedValue({ signaled: true });
    mockHydrateResumableRun.mockClear();
    mockExecuteWorkflow.mockClear();
  });

  test('atomically signals the matching event wait and leaves continuation to the scheduler', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_RUNNING_RUN,
      id: 'run-wait-1',
      status: 'paused',
      working_path: '/tmp/worktrees/run-wait-1',
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'checks',
          kind: 'event',
          pauseId: 'first',
          event: 'checks.complete',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-25T10:00:00.000Z',
        },
      },
    });
    const { app } = makeApp();

    const response = await app.request('/api/workflows/runs/run-wait-1/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'checks.complete',
        occurrence: 'first',
        payload: { conclusion: 'success' },
      }),
    });

    expect(response.status).toBe(200);
    expect(mockSignalWorkflowWait).toHaveBeenCalledWith(
      'run-wait-1',
      {
        owner: 'node',
        nodeId: 'checks',
        kind: 'event',
        pauseId: 'first',
        event: 'checks.complete',
        waitingSince: '2026-08-24T10:00:00.000Z',
        resumeAt: '2026-08-25T10:00:00.000Z',
      },
      { conclusion: 'success' }
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockHandleMessage).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      message: "Signaled 'checks.complete'. The workflow will resume shortly.",
    });
  });

  test('acknowledges a web-parented signal without inline routing after commit', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_RUNNING_RUN,
      id: 'run-wait-web',
      status: 'paused',
      parent_conversation_id: 'parent-conv-uuid',
      working_path: '/tmp/worktrees/run-wait-web',
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'checks',
          kind: 'event',
          pauseId: 'web-occurrence',
          event: 'checks.complete',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-25T10:00:00.000Z',
        },
      },
    });
    const { app } = makeApp();

    const response = await app.request('/api/workflows/runs/run-wait-web/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'checks.complete',
        resumeAt: '2026-08-25T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(mockSignalWorkflowWait).toHaveBeenCalledWith(
      'run-wait-web',
      expect.objectContaining({ pauseId: 'web-occurrence' }),
      undefined
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockGetConversationById).not.toHaveBeenCalled();
  });

  test('forwards the exact loop-owned wait occurrence to the signal CAS', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_RUNNING_RUN,
      id: 'run-loop-wait',
      status: 'paused',
      metadata: {
        wait: {
          owner: 'loop_group',
          nodeId: 'release',
          bodyWaitId: 'checks',
          iteration: 2,
          sessionId: null,
          sessionProvider: null,
          kind: 'event',
          pauseId: 'loop-occurrence',
          event: 'checks.complete',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-25T10:00:00.000Z',
        },
      },
    });
    const { app } = makeApp();

    const response = await app.request('/api/workflows/runs/run-loop-wait/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'checks.complete',
        occurrence: 'loop-occurrence',
        resumeAt: '2026-08-25T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(mockSignalWorkflowWait).toHaveBeenCalledWith(
      'run-loop-wait',
      expect.objectContaining({
        owner: 'loop_group',
        nodeId: 'release',
        bodyWaitId: 'checks',
        iteration: 2,
        pauseId: 'loop-occurrence',
        event: 'checks.complete',
        resumeAt: '2026-08-25T10:00:00.000Z',
      }),
      undefined
    );
  });

  test('rejects a signal that does not match the run wait', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_RUNNING_RUN,
      id: 'run-wait-2',
      status: 'paused',
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'checks',
          kind: 'event',
          event: 'checks.complete',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-25T10:00:00.000Z',
        },
      },
    });
    const { app } = makeApp();

    const response = await app.request('/api/workflows/runs/run-wait-2/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'deploy.complete',
        resumeAt: '2026-08-25T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(400);
    expect(mockSignalWorkflowWait).not.toHaveBeenCalled();
  });

  test('rejects a delayed signal for an earlier occurrence of the same event', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_RUNNING_RUN,
      id: 'run-wait-2',
      status: 'paused',
      metadata: {
        wait: {
          owner: 'loop_group',
          nodeId: 'release',
          bodyWaitId: 'checks',
          iteration: 2,
          sessionId: null,
          sessionProvider: null,
          kind: 'event',
          pauseId: 'second',
          event: 'checks.complete',
          waitingSince: '2026-08-24T10:01:00.000Z',
          resumeAt: '2026-08-25T10:00:00.000Z',
        },
      },
    });
    const { app } = makeApp();

    const response = await app.request('/api/workflows/runs/run-wait-2/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'checks.complete',
        resumeAt: '2026-08-25T10:00:00.000Z',
        occurrence: 'first',
        payload: { conclusion: 'stale' },
      }),
    });

    expect(response.status).toBe(400);
    expect(mockSignalWorkflowWait).not.toHaveBeenCalled();
  });

  test.each([
    { event: 'checks.complete' },
    { event: 'checks.complete', occurrence: '' },
    { event: 'checks.complete', occurrence: 'first', resumeAt: 'today' },
  ])('rejects invalid signal selectors before reading the run: %j', async body => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-wait-2/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(mockGetWorkflowRun).not.toHaveBeenCalled();
    expect(mockSignalWorkflowWait).not.toHaveBeenCalled();
  });

  test('rejects a missing JSON body before reading the run', async () => {
    const { app } = makeApp();

    const response = await app.request('/api/workflows/runs/run-wait-2/signal', {
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(mockGetWorkflowRun).not.toHaveBeenCalled();
    expect(mockSignalWorkflowWait).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/abandon
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/abandon', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockCancelWorkflowRun.mockReset();
    // The shared abandonWorkflow op destructures { cancelled } from this call —
    // a bare mockReset() would make it return undefined and 500 the route.
    mockCancelWorkflowRun.mockImplementation(async (_id: string) => ({ cancelled: true }));
    mockFindChildRuns.mockReset();
    mockFindChildRuns.mockImplementation(async (_parentRunId: string): Promise<unknown[]> => []);
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValue(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-missing/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  test('returns 409 when run is completed (non-resumable terminal)', async () => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_COMPLETED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-2/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cannot abandon');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('returns 409 when run is cancelled (non-resumable terminal)', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_RUNNING_RUN,
      status: 'cancelled' as const,
      completed_at: NOW_DATE,
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cannot abandon');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('reports container cleanup failure after successful abandonment', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_RUNNING_RUN,
      metadata: { isolation: 'container', isolation_env_id: 'env-a' },
    });
    mockReclaimContainerEnv.mockRejectedValueOnce(new Error('docker down'));
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('Could not reclaim container environment env-a');
    expect(body.message).toContain('resources may remain allocated');
  });

  test('returns 200 and calls cancelWorkflowRun for running run', async () => {
    // Two lookups now: the route's pre-check + the shared abandonWorkflow op's own.
    mockGetWorkflowRun.mockResolvedValue(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Abandoned');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-uuid-1', { cancel_reason: 'operator' });
  });

  test('returns 409 instead of success when cancellation loses its CAS', async () => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_RUNNING_RUN);
    mockCancelWorkflowRun.mockResolvedValueOnce({ cancelled: false });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('changed before abandonment'),
    });
  });

  test('returns 409 with the reason and leaves the run when a live owner cannot be stopped', async () => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_RUNNING_RUN);
    mockRequestDetachedRunStop.mockImplementationOnce(async () => ({
      pid: 4242,
      stop: () => Promise.reject(new Error('process still exists')),
      release: () => undefined,
    }));
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Could not stop the live owner of run run-uuid-1 (pid 4242)');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('reports the stopped owner in the success message', async () => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_RUNNING_RUN);
    mockRequestDetachedRunStop.mockImplementationOnce(async () => ({
      pid: 4242,
      stop: () => Promise.resolve({ warnings: [] }),
      release: () => undefined,
    }));
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("Stopped the run's live owner process (pid 4242) first.");
  });

  // #1887: a failed run is terminal but resumable, so it must remain
  // abandonable — the HTTP route previously rejected it, contradicting CLI/chat.
  test('returns 200 and calls cancelWorkflowRun for failed run', async () => {
    // Two lookups now: the route's pre-check + the shared abandonWorkflow op's own.
    mockGetWorkflowRun.mockResolvedValue(MOCK_FAILED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Abandoned');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-uuid-4', { cancel_reason: 'operator' });
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/workflows/runs/:runId
// ---------------------------------------------------------------------------

describe('DELETE /api/workflows/runs/:runId', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockDeleteWorkflowRun.mockReset();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValue(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-missing', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is not terminal', async () => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1', {
      method: 'DELETE',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cannot delete');
  });

  test('returns 200 and deletes a completed run', async () => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_COMPLETED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-2', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Deleted');
    expect(mockDeleteWorkflowRun).toHaveBeenCalledWith('run-uuid-2');
  });

  test('returns 200 and deletes a failed run', async () => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_FAILED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(mockDeleteWorkflowRun).toHaveBeenCalledWith('run-uuid-4');
  });
});

describe('authenticated web run-action actor forwarding', () => {
  const originalHeader = process.env.ARCHON_WEB_AUTH_HEADER;

  beforeEach(() => {
    delete process.env.ARCHON_WEB_AUTH_HEADER;
    mockGetWorkflowRun.mockReset();
    mockGetConversationById.mockReset();
    mockHandleMessage.mockReset();
    mockFindOrCreateUser.mockClear();
    mockCancelWorkflowRun.mockResolvedValue({ cancelled: true });
  });

  afterEach(() => {
    setSessionUserId(undefined);
    if (originalHeader === undefined) delete process.env.ARCHON_WEB_AUTH_HEADER;
    else process.env.ARCHON_WEB_AUTH_HEADER = originalHeader;
  });

  const actions = [
    ['cancel', 'cancelWorkflow'],
    ['resume', 'resumeWorkflow'],
    ['abandon', 'abandonWorkflow'],
    ['approve', 'approveWorkflow'],
    ['reject', 'rejectWorkflow'],
    ['respond', 'respondToWorkflow'],
  ] as const;

  for (const identity of ['session', 'proxy'] as const) {
    for (const [action, operation] of actions) {
      test(`${action}: forwards the ${identity} user to operations and the resume dispatch`, async () => {
        setSessionUserId(identity === 'session' ? 'session-clicker' : undefined);
        const expectedActor: RunActor = { kind: 'user', userId: `user-from-${identity}-clicker` };
        const run = {
          ...MOCK_PAUSED_RUN,
          user_id: `user-from-${identity}-clicker`,
          status: action === 'cancel' ? 'running' : action === 'resume' ? 'failed' : 'paused',
          parent_conversation_id: 'parent-conv-uuid',
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
        } satisfies MockWorkflowRun;
        mockGetWorkflowRun.mockResolvedValue(run);
        mockGetConversationById.mockResolvedValue({
          id: 'parent-conv-uuid',
          platform_conversation_id: 'web-parent',
          platform_type: 'web',
        });
        const operations = sqlHost.createSqlWorkflowOperations();
        const operationSpy = spyOn(operations, operation);
        if (action === 'cancel') {
          operationSpy.mockResolvedValue({
            kind: 'cooperative',
            run: { ...MOCK_RUNNING_RUN, id: run.id },
            cancelled: true,
            cleanupWarnings: ['Possible untracked background work.'],
          });
        }
        const factorySpy = spyOn(sqlHost, 'createSqlWorkflowOperations').mockReturnValue(
          operations
        );
        try {
          const { app } = makeApp();
          const response = await app.request(`/api/workflows/runs/${run.id}/${action}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Archon-User': `${identity === 'session' ? 'ignored' : 'proxy'}-clicker`,
            },
            body: JSON.stringify({ comment: 'LGTM', reason: 'Fix tests', decision: 'approve' }),
          });
          expect(response.status).toBe(200);
          if (action === 'cancel')
            expect(await response.text()).toContain('Possible untracked background work.');
          expect(operationSpy).toHaveBeenCalledTimes(1);
          expect(operationSpy.mock.calls[0]).toContainEqual(expectedActor);
          expect(mockFindOrCreateUser).toHaveBeenCalledWith(
            'web',
            `${identity}-clicker`,
            identity === 'proxy' ? 'proxy-clicker' : undefined
          );
          if (action === 'resume') {
            expect(mockHandleMessage).toHaveBeenCalledTimes(1);
            expect(mockHandleMessage.mock.calls[0]?.[2]).toBe(`/workflow resume ${run.id}`);
            expect(mockHandleMessage.mock.calls[0]?.[3]).toMatchObject({ actor: expectedActor });
          }
        } finally {
          factorySpy.mockRestore();
          operationSpy.mockRestore();
        }
      });
    }
  }
});

describe('starter or admin authorization on every HTTP run action', () => {
  afterEach(() => {
    setSessionUserId(undefined);
  });

  test("a persisted admin can delete another user's terminal run through the SQL host", async () => {
    const { SqliteAdapter } = await import('@archon/core/db/adapters/sqlite');
    const { pool } = await import('@archon/core/db/connection');
    const database = new SqliteAdapter(':memory:');
    await database.query("INSERT INTO remote_agent_users (id, role) VALUES ($1, 'admin')", [
      'admin-b',
    ]);
    const querySpy = spyOn(pool, 'query').mockImplementation(database.query.bind(database));
    mockGetUserById.mockImplementation(realGetUserById);
    mockFindOrCreateUser.mockResolvedValueOnce({ ...makeUser('admin-b'), role: 'member' });
    setSessionUserId('admin-session');
    const run = { ...MOCK_COMPLETED_RUN, user_id: 'starter-a' };
    mockGetWorkflowRun.mockResolvedValue(run);
    mockDeleteWorkflowRun.mockClear();
    try {
      const { app } = makeApp();
      const response = await app.request(`/api/workflows/runs/${run.id}`, { method: 'DELETE' });
      expect(response.status).toBe(200);
      expect(querySpy).toHaveBeenCalledWith('SELECT * FROM remote_agent_users WHERE id = $1', [
        'admin-b',
      ]);
      expect(mockDeleteWorkflowRun).toHaveBeenCalledWith(run.id);
    } finally {
      mockGetUserById.mockImplementation(async id => makeUser(id));
      querySpy.mockRestore();
      await database.close();
    }
  });

  test('auth enabled without a resolved identity refuses a run action', async () => {
    setRequireRunIdentity(true);
    setSessionUserId(undefined);
    mockGetWorkflowRun.mockResolvedValue({ ...MOCK_PAUSED_RUN, user_id: 'starter-a' });
    mockRequestDetachedRunStop.mockClear();
    try {
      const { app } = makeApp();
      const response = await app.request(`/api/workflows/runs/${MOCK_PAUSED_RUN.id}/abandon`, {
        method: 'POST',
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('Only the user who started this run or an admin');
      expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
    } finally {
      setRequireRunIdentity(false);
    }
  });
  for (const identity of ['another member', 'failed proxy identity'] as const) {
    for (const action of RUN_ACTIONS) {
      test(`${action} returns 403 and performs no mutation for ${identity}`, async () => {
        setSessionUserId(identity === 'another member' ? 'member-b' : undefined);
        if (identity === 'failed proxy identity')
          mockFindOrCreateUser.mockRejectedValueOnce(new Error('identity lookup unavailable'));
        const run = { ...MOCK_COMPLETED_RUN, user_id: 'starter-a' };
        mockGetWorkflowRun.mockResolvedValue(run);
        mockCancelWorkflowRun.mockClear();
        mockDeleteWorkflowRun.mockClear();
        mockSignalWorkflowWait.mockClear();
        mockResolveApprovalGate.mockClear();
        mockResolveAndCancelApprovalGate.mockClear();
        mockRequestDetachedRunStop.mockClear();
        const { app } = makeApp();
        const body =
          action === 'signal'
            ? {
                event: 'ready',
                resumeAt: new Date().toISOString(),
                payload: { secret: 'contents' },
              }
            : action === 'respond'
              ? { decision: 'custom', text: 'contents' }
              : {};
        const response = await app.request(
          `/api/workflows/runs/${run.id}${action === 'delete' ? '' : `/${action}`}`,
          {
            method: action === 'delete' ? 'DELETE' : 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(identity === 'failed proxy identity' ? { 'X-Archon-User': 'proxy-member' } : {}),
            },
            ...(action === 'delete' ? {} : { body: JSON.stringify(body) }),
          }
        );
        expect(response.status).toBe(403);
        expect(await response.text()).toContain('Only the user who started this run or an admin');
        expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
        expect(mockDeleteWorkflowRun).not.toHaveBeenCalled();
        expect(mockSignalWorkflowWait).not.toHaveBeenCalled();
        expect(mockResolveApprovalGate).not.toHaveBeenCalled();
        expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
        expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
        expect(run).toEqual({ ...MOCK_COMPLETED_RUN, user_id: 'starter-a' });
      });
    }
  }
});
