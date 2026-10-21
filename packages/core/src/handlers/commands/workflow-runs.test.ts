// @archon-test-isolated
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { DetachedRunOwnerUnavailableError as RealDetachedRunOwnerUnavailableError } from '../../services/run-owner-stop';
import { handleCommand } from '../command-handler';
import { resolveChatRunId } from './workflow-runs';
import { startRunLiveOwner } from '../../services/run-live-owner';
import {
  operator,
  makeConversation,
  makeWorkflowRun,
  resumeRequest,
  EMPTY_DASHBOARD_COUNTS,
  makeDashboardRun,
  mockGetActiveWorkflowRun,
  mockCancelWorkflowRun,
  mockListDashboardRuns,
  mockGetWorkflowRun,
  mockFindWorkflowRunsByIdPrefix,
  mockResumeWorkflowRun,
  mockFailWorkflowRun,
  mockFindChildRuns,
  spyDiscoverWorkflows,
  mockDeleteWorkflowNodeSessions,
  mockRequestDetachedRunStop,
  restoreSpies,
  stubWorkflowCodebase,
  baseConversation,
  resetCommandHandlerMocks,
} from './test-harness';

describe('CommandHandler', () => {
  beforeEach(resetCommandHandlerMocks);

  // Clean up spies after all tests in this file to prevent contamination
  afterAll(() => {
    restoreSpies();
  });

  test('resolves an undashed full UUID within the conversation project', async () => {
    const id = 'abcdef00-1111-2222-3333-444455556666';
    mockFindWorkflowRunsByIdPrefix.mockResolvedValueOnce([]);
    mockFindWorkflowRunsByIdPrefix.mockResolvedValueOnce([makeWorkflowRun({ id })]);
    expect(
      await resolveChatRunId(id.replaceAll('-', ''), makeConversation({ codebase_id: 'cb-1' }))
    ).toBe(id);
    expect(mockFindWorkflowRunsByIdPrefix).toHaveBeenLastCalledWith(id, 'cb-1');
  });

  test.each([
    ['/workflow cancel', 'cb-old'],
    ['/workflow cancel', null],
    ['/status', 'cb-old'],
    ['/status', null],
  ])(
    '%s ignores an active run from %s after the conversation changes project',
    async (command, runCodebaseId) => {
      const oldConversation = makeConversation({ codebase_id: runCodebaseId });
      const reboundConversation = { ...oldConversation, codebase_id: 'cb-new' };
      const oldRun = makeWorkflowRun({
        id: 'old-project-run',
        workflow_name: 'old-project-workflow',
        conversation_id: oldConversation.id,
        codebase_id: oldConversation.codebase_id,
      });
      mockGetActiveWorkflowRun.mockImplementationOnce(async (_conversationId, codebaseId) =>
        !codebaseId || oldRun.codebase_id === codebaseId ? oldRun : null
      );

      const result = await handleCommand(reboundConversation, command, operator);

      expect(result.success).toBe(true);
      expect(mockGetActiveWorkflowRun).toHaveBeenCalledWith(oldConversation.id, 'cb-new');
      expect(result.message).not.toContain(oldRun.workflow_name);
      expect(result.message).not.toContain(oldRun.id);
      expect(result.message).not.toContain('Cancel:');
      expect(mockGetWorkflowRun).not.toHaveBeenCalled();
      expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      if (command === '/workflow cancel') {
        expect(result.message).toBe('No active workflow to cancel.');
      }
    }
  );

  test.each([
    ['/workflow cancel', 'cb-current'],
    ['/workflow cancel', null],
    ['/status', 'cb-current'],
    ['/status', null],
  ])('%s selects the newest run within scope %s', async (command, codebaseId) => {
    const current = makeWorkflowRun({
      id: `current-${crypto.randomUUID()}`,
      workflow_name: 'current-project-workflow',
      codebase_id: 'cb-current',
      started_at: new Date('2026-10-21T10:00:00Z'),
    });
    const foreign = makeWorkflowRun({
      id: 'foreign-run',
      workflow_name: 'foreign-project-workflow',
      codebase_id: 'cb-foreign',
      started_at: new Date('2026-10-21T11:00:00Z'),
    });
    mockGetActiveWorkflowRun.mockImplementationOnce(
      async (_conversationId, codebaseId) =>
        [foreign, current].find(run => !codebaseId || run.codebase_id === codebaseId) ?? null
    );
    const selected = codebaseId ? current : foreign;
    if (command === '/workflow cancel') mockGetWorkflowRun.mockResolvedValueOnce(selected);
    const owner = await startRunLiveOwner(selected.id);
    try {
      const result = await handleCommand(
        makeConversation({ codebase_id: codebaseId }),
        command,
        operator
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain(selected.workflow_name);
      expect(result.message).not.toContain(
        codebaseId ? foreign.workflow_name : current.workflow_name
      );
      if (command === '/workflow cancel') {
        expect(mockCancelWorkflowRun).toHaveBeenCalledWith(selected.id, {
          cancel_reason: 'operator',
        });
      } else {
        expect(result.message).toContain('Cancel: `/workflow cancel`');
        expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      }
    } finally {
      await owner.close();
    }
  });

  test.each(['cancel', 'resume', 'abandon', 'approve', 'reject', 'respond', 'get'])(
    'refuses a foreign full run ID for /workflow %s before any global lookup',
    async command => {
      const id = 'abcdef00-1111-2222-3333-444455556666';
      mockFindWorkflowRunsByIdPrefix.mockResolvedValueOnce([]);

      const result = await handleCommand(
        makeConversation({ codebase_id: 'cb-1' }),
        `/workflow ${command} ${id} approve`,
        operator
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Workflow run not found');
      expect(mockFindWorkflowRunsByIdPrefix).toHaveBeenLastCalledWith(id, 'cb-1');
      expect(mockGetWorkflowRun).not.toHaveBeenCalled();
      expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
    }
  );

  describe('handleCommand', () => {
    describe('/workflow reset-sessions', () => {
      test('auto-scopes the reset to the current conversation', async () => {
        mockDeleteWorkflowNodeSessions.mockResolvedValueOnce({ deleted: 2 });

        const result = await handleCommand(
          baseConversation,
          '/workflow reset-sessions feature-dev',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Cleared 2');
        expect(mockDeleteWorkflowNodeSessions).toHaveBeenCalledWith({
          workflow_name: 'feature-dev',
          scope_key: 'conv-123',
          node_id: undefined,
        });
      });

      test('narrows to a single node when a node id is given', async () => {
        mockDeleteWorkflowNodeSessions.mockResolvedValueOnce({ deleted: 1 });

        await handleCommand(
          baseConversation,
          '/workflow reset-sessions feature-dev planner',
          operator
        );

        expect(mockDeleteWorkflowNodeSessions).toHaveBeenCalledWith({
          workflow_name: 'feature-dev',
          scope_key: 'conv-123',
          node_id: 'planner',
        });
      });

      test('returns a usage error when the workflow name is missing', async () => {
        const result = await handleCommand(baseConversation, '/workflow reset-sessions', operator);
        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage');
        expect(mockDeleteWorkflowNodeSessions).not.toHaveBeenCalled();
      });

      test('returns a failure message (does not throw) on DB error', async () => {
        mockDeleteWorkflowNodeSessions.mockRejectedValueOnce(new Error('connection refused'));

        const result = await handleCommand(
          baseConversation,
          '/workflow reset-sessions feature-dev',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to reset workflow sessions');
      });
    });

    describe('/workflow cancel', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      function runningRun(id: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
        return makeWorkflowRun({
          id,
          workflow_name: 'test-workflow',
          codebase_id: conversationWithCodebase.codebase_id,
          status: 'running' as const,
          user_message: 'test',
          last_activity_at: new Date(),
          ...overrides,
        });
      }

      test.each(['codebase-123', null])(
        'cancels cooperatively the active run in scope %s',
        async codebaseId => {
          // A real endpoint published by this process, as the server's own runs have.
          const runId = `chat-cancel-${crypto.randomUUID()}`;
          const owner = await startRunLiveOwner(runId);
          try {
            mockGetActiveWorkflowRun.mockResolvedValueOnce(runningRun(runId));
            mockGetWorkflowRun.mockResolvedValueOnce(runningRun(runId));
            mockRequestDetachedRunStop.mockClear();
            const result = await handleCommand(
              { ...conversationWithCodebase, codebase_id: codebaseId },
              '/workflow cancel',
              operator
            );

            expect(result.success).toBe(true);
            expect(result.message).toContain('Cancelled workflow: `test-workflow`');
            expect(result.message).toContain('untracked background work');
            expect(mockCancelWorkflowRun.mock.calls.at(-1)?.[1]?.warnings).toEqual([
              expect.stringContaining('untracked background work'),
            ]);
            expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
          } finally {
            await owner.close();
          }
        }
      );

      test('cancels the run the id names, not the active one (and resolves a short id)', async () => {
        const target = runningRun(`abcd1234-${crypto.randomUUID()}`);
        // Executed by this process, so cancel is cooperative and needs no stop request.
        const owner = await startRunLiveOwner(target.id);
        try {
          mockFindWorkflowRunsByIdPrefix.mockResolvedValueOnce([target]);
          mockGetWorkflowRun.mockResolvedValueOnce(target);
          mockGetActiveWorkflowRun.mockClear();

          const result = await handleCommand(
            conversationWithCodebase,
            '/workflow cancel abcd1234',
            operator
          );

          expect(result.success).toBe(true);
          expect(mockFindWorkflowRunsByIdPrefix).toHaveBeenCalledWith('abcd1234', 'codebase-123');
          expect(mockCancelWorkflowRun).toHaveBeenCalledWith(target.id, {
            cancel_reason: 'operator',
          });
          expect(mockGetActiveWorkflowRun).not.toHaveBeenCalled();
        } finally {
          await owner.close();
        }
      });

      test('refuses a short id that matches more than one run instead of picking one', async () => {
        mockFindWorkflowRunsByIdPrefix.mockResolvedValueOnce([
          runningRun('abcd1234-0000-4000-8000-000000000001'),
          runningRun('abcd1234-0000-4000-8000-000000000002'),
        ]);
        mockGetActiveWorkflowRun.mockClear();
        mockGetWorkflowRun.mockClear();
        mockCancelWorkflowRun.mockClear();

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow cancel abcd1234',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("Run id 'abcd1234' matches more than one run");
        expect(mockGetWorkflowRun).not.toHaveBeenCalled();
        expect(mockGetActiveWorkflowRun).not.toHaveBeenCalled();
        expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      });

      test('stops an owner in another process, then cancels', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce(runningRun('wf-detached'));
        mockGetWorkflowRun.mockResolvedValueOnce(runningRun('wf-detached'));
        mockRequestDetachedRunStop.mockImplementationOnce(() =>
          Promise.resolve({
            pid: 4242,
            stop: () =>
              Promise.resolve({
                warnings: [
                  'Some process still holds node output; it was not signalled. Use lsof on the checkout.',
                ],
              }),
            release: () => undefined,
          })
        );

        const result = await handleCommand(conversationWithCodebase, '/workflow cancel', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain(
          'Some process still holds node output; it was not signalled. Use lsof on the checkout.'
        );
        expect(result.message).toContain("Stopped the run's live owner process (pid 4242)");
        expect(mockCancelWorkflowRun).toHaveBeenCalledWith('wf-detached', {
          cancel_reason: 'operator',
          reason:
            'Some process still holds node output; it was not signalled. Use lsof on the checkout.',
          warnings: [
            'Some process still holds node output; it was not signalled. Use lsof on the checkout.',
          ],
        });
      });

      test('refuses when no owner answers and points at abandon with the recorded facts', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce(runningRun('wf-orphan'));
        mockGetWorkflowRun.mockResolvedValueOnce(
          runningRun('wf-orphan', {
            metadata: { execution_owner: { host: 'build-box', pid: 4242 } },
          })
        );
        mockCancelWorkflowRun.mockClear();

        const result = await handleCommand(conversationWithCodebase, '/workflow cancel', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Recorded owner: host build-box, pid 4242.');
        expect(result.message).toContain('Abandon it: `/workflow abandon wf-orphan`');
        expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      });

      test('should return message when no active workflow exists', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(conversationWithCodebase, '/workflow cancel', operator);

        expect(result.success).toBe(true);
        expect(result.message).toBe('No active workflow to cancel.');
        expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      });

      test('should return no-active-workflow when no codebase is configured', async () => {
        const result = await handleCommand(baseConversation, '/workflow cancel', operator);

        expect(result.success).toBe(true);
        expect(result.message).toBe('No active workflow to cancel.');
      });
    });

    describe('/workflow get', () => {
      test('shows the one run named by the id, whatever its status', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-failed',
            workflow_name: 'implement',
            status: 'failed',
            metadata: { error: 'node exploded' },
          })
        );

        const result = await handleCommand(baseConversation, '/workflow get run-failed', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('implement');
        expect(result.message).toContain('run-failed');
        expect(result.message).toContain('failed');
        expect(result.message).toContain('node exploded');
      });

      test('shows the gate and its answer commands for a paused run', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-approval',
            status: 'paused',
            metadata: { approval: { nodeId: 'gate', message: 'Approve?' } },
          })
        );

        const result = await handleCommand(
          baseConversation,
          '/workflow get run-approval',
          operator
        );

        expect(result.message).toContain('/workflow approve run-approval');
        expect(result.message).toContain('/workflow reject run-approval');
      });

      test('does not show a run that belongs to another project', async () => {
        mockFindWorkflowRunsByIdPrefix.mockResolvedValueOnce([]);
        const conversation = makeConversation({ ...baseConversation, codebase_id: 'codebase-123' });

        const result = await handleCommand(conversation, '/workflow get run-other', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Workflow run not found');
        expect(mockGetWorkflowRun).not.toHaveBeenCalled();
      });

      test('reports a missing run', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(baseConversation, '/workflow get nope', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Workflow run not found');
      });
    });

    describe('/workflow status', () => {
      test.each(['cb-1', null])('lists only the selected scope (%s)', async codebaseId => {
        const runs = [
          makeDashboardRun({ id: 'own-run', codebase_id: 'cb-1' }),
          makeDashboardRun({ id: 'foreign-run', codebase_id: 'cb-2' }),
        ];
        mockListDashboardRuns.mockImplementationOnce(async options => {
          const visible = runs.filter(
            run => !options?.codebaseId || run.codebase_id === options.codebaseId
          );
          return { runs: visible, total: visible.length, counts: EMPTY_DASHBOARD_COUNTS };
        });

        const result = await handleCommand(
          makeConversation({ codebase_id: codebaseId }),
          '/workflow status',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('own-run');
        if (codebaseId) {
          expect(result.message).not.toContain('foreign-run');
        } else {
          expect(result.message).toContain('foreign-run');
        }
        expect(mockListDashboardRuns).toHaveBeenLastCalledWith({
          status: ['running', 'paused'],
          limit: 50,
          ...(codebaseId ? { codebaseId } : {}),
        });
      });

      test('should show all running workflows', async () => {
        const startedAt = new Date(Date.now() - 2 * 60 * 1000);
        mockListDashboardRuns.mockResolvedValueOnce({
          runs: [
            makeDashboardRun({
              origin: { conversationId: 'conv-1' },
              id: 'run-abc123',
              workflow_name: 'implement',
              conversation_id: 'conv-1',
              user_message: 'add feature',
              started_at: startedAt,
              last_activity_at: startedAt,
              working_path: '/workspace/worktrees/feat-auth',
              active_nodes: ['parallel-a', 'parallel-b'],
            }),
          ],
          total: 1,
          counts: { ...EMPTY_DASHBOARD_COUNTS, all: 1, running: 1 },
        });

        const result = await handleCommand(baseConversation, '/workflow status', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('implement');
        expect(result.message).toContain('run-abc123');
        expect(result.message).toContain('/workspace/worktrees/feat-auth');
        expect(result.message).toContain('Active nodes: parallel-a, parallel-b');
      });

      test('should show authored outcome independently for an active workflow', async () => {
        mockListDashboardRuns.mockResolvedValueOnce({
          runs: [
            makeDashboardRun({
              id: 'run-paused',
              workflow_name: 'review',
              status: 'paused',
              outcome: 'succeeded',
            }),
          ],
          total: 1,
          counts: { ...EMPTY_DASHBOARD_COUNTS, all: 1, paused: 1 },
        });

        const result = await handleCommand(baseConversation, '/workflow status', operator);

        expect(result.message).toContain('review');
        expect(result.message).toContain('(paused)');
        expect(result.message).toContain('Authored outcome: succeeded');
      });

      test('should direct an attention wait from before answers to resume', async () => {
        mockListDashboardRuns.mockResolvedValueOnce({
          runs: [
            makeDashboardRun({
              id: 'run-attention',
              workflow_name: 'deliver',
              status: 'paused',
              metadata: {
                wait: {
                  owner: 'node',
                  nodeId: 'rerun-ci',
                  kind: 'attention',
                  waitingSince: '2026-08-31T10:00:00.000Z',
                  message: 'Re-run the failing check, then resume this run.',
                },
              },
            }),
          ],
          total: 1,
          counts: { ...EMPTY_DASHBOARD_COUNTS, all: 1, paused: 1 },
        });

        const result = await handleCommand(baseConversation, '/workflow status', operator);

        expect(result.message).toContain('Re-run the failing check, then resume this run.');
        expect(result.message).toContain('/workflow resume run-attention');
        expect(result.message).toContain('/workflow abandon run-attention');
        expect(result.message).not.toContain('/workflow approve run-attention');
        expect(result.message).not.toContain('/workflow reject run-attention');
      });

      test('should list how to answer an attention wait in its form', async () => {
        mockListDashboardRuns.mockResolvedValueOnce({
          runs: [
            makeDashboardRun({
              id: 'run-ask',
              workflow_name: 'deliver',
              status: 'paused',
              metadata: {
                wait: {
                  owner: 'node',
                  nodeId: 'ask',
                  kind: 'attention',
                  waitingSince: '2026-08-31T10:00:00.000Z',
                  message: 'Which base?',
                  pauseId: 'pause-1',
                  form: 'select',
                  options: [{ id: 'use-main', label: 'Main' }, { id: 'use-dev' }],
                },
              },
            }),
          ],
          total: 1,
          counts: { ...EMPTY_DASHBOARD_COUNTS, all: 1, paused: 1 },
        });

        const result = await handleCommand(baseConversation, '/workflow status', operator);

        expect(result.message).toContain('Needs attention: Which base?');
        expect(result.message).toContain(
          'Main (use-main): `/workflow respond run-ask use-main [text]`'
        );
        expect(result.message).toContain('use-dev: `/workflow respond run-ask use-dev [text]`');
        expect(result.message).not.toContain('/workflow resume run-ask');
      });

      test('should direct an approval pause to approve or reject', async () => {
        mockListDashboardRuns.mockResolvedValueOnce({
          runs: [
            makeDashboardRun({
              id: 'run-approval',
              workflow_name: 'review',
              status: 'paused',
              metadata: { approval: { nodeId: 'gate', message: 'Approve delivery?' } },
            }),
          ],
          total: 1,
          counts: { ...EMPTY_DASHBOARD_COUNTS, all: 1, paused: 1 },
        });

        const result = await handleCommand(baseConversation, '/workflow status', operator);

        expect(result.message).toContain('/workflow approve run-approval');
        expect(result.message).toContain('/workflow reject run-approval <reason>');
        expect(result.message).not.toContain('/workflow resume run-approval');
      });

      test('should show no-active message when no workflows running', async () => {
        mockListDashboardRuns.mockResolvedValueOnce({
          runs: [],
          total: 0,
          counts: EMPTY_DASHBOARD_COUNTS,
        });

        const result = await handleCommand(baseConversation, '/workflow status', operator);

        expect(result.success).toBe(true);
        expect(result.message).toBe('No active workflows.');
      });

      test('should handle database errors gracefully', async () => {
        mockListDashboardRuns.mockRejectedValueOnce(new Error('Database connection error'));

        const result = await handleCommand(baseConversation, '/workflow status', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to retrieve workflow status');
      });

      test('should show working_path as (unknown) when null', async () => {
        const startedAt = new Date();
        mockListDashboardRuns.mockResolvedValueOnce({
          runs: [
            makeDashboardRun({
              origin: { conversationId: 'conv-1' },
              id: 'run-xyz',
              workflow_name: 'assist',
              conversation_id: 'conv-1',
              user_message: 'help',
              started_at: startedAt,
              working_path: null,
            }),
          ],
          total: 1,
          counts: { ...EMPTY_DASHBOARD_COUNTS, all: 1, running: 1 },
        });

        const result = await handleCommand(baseConversation, '/workflow status', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('(unknown)');
      });
    });

    describe('/workflow resume', () => {
      test('should return workflow dispatch data for failed run resume', async () => {
        const run = makeWorkflowRun({
          origin: { conversationId: 'conv-1' },
          id: 'run-123',
          workflow_name: 'implement',
          conversation_id: 'conv-1',
          status: 'failed' as const,
          user_message: 'test',
          working_path: '/workspace/wt',
        });
        mockGetWorkflowRun.mockResolvedValueOnce(run);
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'implement', description: 'Implement changes' }),
          ],
          errors: [],
        });

        const result = await handleCommand(baseConversation, '/workflow resume run-123', operator);

        expect(result.success).toBe(true);
        expect(result.message).toBe('Resume requested');
        expect(resumeRequest(result.workflow).run).toBe(run);
      });

      test('should accept already-failed run without status change', async () => {
        const run = makeWorkflowRun({
          origin: { conversationId: 'conv-1' },
          id: 'run-456',
          workflow_name: 'plan',
          conversation_id: 'conv-1',
          status: 'failed' as const,
          user_message: 'test',
        });
        mockGetWorkflowRun.mockResolvedValueOnce(run);
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan changes' })],
          errors: [],
        });

        const result = await handleCommand(baseConversation, '/workflow resume run-456', operator);

        expect(result.success).toBe(true);
        expect(resumeRequest(result.workflow).run.id).toBe('run-456');
        // Already failed — no status change needed
        expect(mockFailWorkflowRun).not.toHaveBeenCalled();
      });

      test('defers workflow source preparation to the host', async () => {
        const run = makeWorkflowRun({
          origin: { conversationId: 'conv-1' },
          id: 'run-missing-workflow',
          workflow_name: 'missing-workflow',
          conversation_id: 'conv-1',
          status: 'failed' as const,
          user_message: 'test',
        });
        mockGetWorkflowRun.mockResolvedValueOnce(run);
        spyDiscoverWorkflows.mockResolvedValueOnce({ workflows: [], errors: [] });

        const result = await handleCommand(
          baseConversation,
          '/workflow resume run-missing-workflow',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toBe('Resume requested');
        expect(resumeRequest(result.workflow).run).toBe(run);
        expect(spyDiscoverWorkflows).not.toHaveBeenCalled();
      });

      test('does not inspect live load errors before acknowledging resume', async () => {
        const run = makeWorkflowRun({
          origin: { conversationId: 'conv-1' },
          id: 'run-bad-workflow',
          workflow_name: 'bad-workflow',
          conversation_id: 'conv-1',
          status: 'failed' as const,
          user_message: 'test',
          working_path: '/workspace/wt',
        });
        mockGetWorkflowRun.mockResolvedValueOnce(run);
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [],
          errors: [
            {
              filename: 'bad-workflow.yaml',
              error: 'Invalid workflow YAML',
              errorType: 'parse_error',
            },
          ],
        });

        const result = await handleCommand(
          baseConversation,
          '/workflow resume run-bad-workflow',
          operator
        );

        expect(result.success).toBe(true);
        expect(resumeRequest(result.workflow).run).toBe(run);
        expect(spyDiscoverWorkflows).not.toHaveBeenCalled();
      });

      test('should reject resume of non-resumable run', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-1' },
            id: 'run-789',
            workflow_name: 'assist',
            conversation_id: 'conv-1',
            status: 'running' as const,
            user_message: 'test',
          })
        );

        const result = await handleCommand(baseConversation, '/workflow resume run-789', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Cannot resume');
        expect(mockResumeWorkflowRun).not.toHaveBeenCalled();
      });

      test('should return error when run not found', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(
          baseConversation,
          '/workflow resume nonexistent',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('not found');
      });

      test('should return usage when no id provided', async () => {
        const result = await handleCommand(baseConversation, '/workflow resume', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage: /workflow resume <id>');
        expect(result.message).toContain('failed or paused workflow');
      });

      test('should handle DB error on resume gracefully', async () => {
        mockGetWorkflowRun.mockRejectedValueOnce(new Error('DB down'));

        const result = await handleCommand(baseConversation, '/workflow resume run-err', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to resume');
      });
    });

    describe('/workflow abandon', () => {
      test('should abandon a running run', async () => {
        const run = makeWorkflowRun({
          origin: { conversationId: 'conv-1' },
          id: 'run-123',
          workflow_name: 'implement',
          conversation_id: 'conv-1',
          status: 'running' as const,
          user_message: 'test',
        });
        mockGetWorkflowRun.mockResolvedValueOnce(run);

        const result = await handleCommand(baseConversation, '/workflow abandon run-123', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('Abandoned');
        expect(result.message).toContain('implement');
        expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-123', {
          cancel_reason: 'operator',
        });
        // The cascade walk must actually run against the mock, not merely be
        // survived. cascadeCancelChildren swallows its own errors into a failure
        // count, so a cascade that is broken — or one silently talking to a real
        // database — still reports "Abandoned"; the only visible tell is this
        // warning suffix. Assert both halves so the stub cannot regress unnoticed.
        expect(result.message).not.toContain('could not be cancelled');
        expect(mockFindChildRuns).toHaveBeenCalledWith('run-123');
      });

      test('should reject abandon of already-terminal run', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-1' },
            id: 'run-done',
            workflow_name: 'assist',
            conversation_id: 'conv-1',
            status: 'completed' as const,
            user_message: 'test',
            completed_at: new Date(),
          })
        );

        const result = await handleCommand(
          baseConversation,
          '/workflow abandon run-done',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Cannot abandon');
        expect(mockFailWorkflowRun).not.toHaveBeenCalled();
      });

      test('should return error when run not found', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(
          baseConversation,
          '/workflow abandon nonexistent',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('not found');
      });

      test('shows the recorded owner facts when no owner answers (#2325)', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-1' },
            id: 'run-123',
            workflow_name: 'implement',
            conversation_id: 'conv-1',
            status: 'running' as const,
            user_message: 'test',
            metadata: { execution_owner: { host: 'build-box', pid: 4242 } },
          })
        );

        const result = await handleCommand(baseConversation, '/workflow abandon run-123', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('Recorded owner: host build-box, pid 4242.');
        expect(result.message).toContain('The recorded owner is on another host (build-box).');
      });

      test('fails with the reason and leaves the run when a live owner cannot be stopped', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-1' },
            id: 'run-live',
            workflow_name: 'implement',
            conversation_id: 'conv-1',
            status: 'running' as const,
            user_message: 'test',
          })
        );
        mockRequestDetachedRunStop.mockImplementationOnce(() =>
          Promise.reject(
            new RealDetachedRunOwnerUnavailableError(
              'run-live',
              'the live owner is not a detached CLI',
              'not_detached'
            )
          )
        );
        mockCancelWorkflowRun.mockClear();

        const result = await handleCommand(
          baseConversation,
          '/workflow abandon run-live',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('cannot be stopped from here');
        expect(result.message).toContain('The run was not changed.');
        expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      });

      test('should return usage when no id provided', async () => {
        const result = await handleCommand(baseConversation, '/workflow abandon', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage: /workflow abandon <id>');
      });

      test('should handle DB error on abandon gracefully', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            origin: { conversationId: 'conv-1' },
            id: 'run-err',
            workflow_name: 'implement',
            conversation_id: 'conv-1',
            status: 'running' as const,
            user_message: 'test',
          })
        );
        mockCancelWorkflowRun.mockRejectedValueOnce(new Error('DB down'));

        const result = await handleCommand(baseConversation, '/workflow abandon run-err', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to abandon');
      });
    });
  });
});
