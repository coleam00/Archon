// @archon-test-isolated
import { RunActionForbiddenError } from '../../operations/run-authorization';
import { describe, test, expect, beforeEach, afterAll, spyOn } from 'bun:test';
import { handleCommand } from '../command-handler';
import {
  operator,
  makeSession,
  makeWorkflowRun,
  mockUpdateConversation,
  mockGetActiveSession,
  mockDeactivateSession,
  mockCancelWorkflowRun,
  mockCancelResumableRunsForConversation,
  mockGetWorkflowRun,
  mockFindChildRuns,
  mockReclaimContainerEnv,
  restoreSpies,
  baseConversation,
  resetCommandHandlerMocks,
} from './test-harness';

describe('CommandHandler', () => {
  beforeEach(resetCommandHandlerMocks);

  // Clean up spies after all tests in this file to prevent contamination
  afterAll(() => {
    restoreSpies();
  });

  describe('handleCommand', () => {
    describe('/reset', () => {
      beforeEach(() => {
        mockCancelResumableRunsForConversation.mockClear();
        mockCancelResumableRunsForConversation.mockImplementation(() => Promise.resolve([]));
        mockUpdateConversation.mockClear();
        mockUpdateConversation.mockImplementation(() => Promise.resolve());
        mockGetWorkflowRun.mockClear();
        mockFindChildRuns.mockClear();
        mockFindChildRuns.mockImplementation(() => Promise.resolve([]));
      });

      test('clears the execution binding but preserves the project attachment', async () => {
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(baseConversation, '/reset', operator);

        expect(result.success).toBe(true);
        // cwd + isolation env go; codebase_id is deliberately absent from the
        // payload — detaching the project is /detach-project's job.
        expect(mockUpdateConversation).toHaveBeenCalledWith(baseConversation.id, {
          cwd: null,
          isolation_env_id: null,
        });
        const [, payload] = mockUpdateConversation.mock.calls[0] as [string, object];
        expect(payload).not.toHaveProperty('codebase_id');
        expect(result.message).toContain('Project attachment preserved');
      });

      test('abandons resumable runs and names the count', async () => {
        mockGetActiveSession.mockResolvedValue(null);
        mockCancelResumableRunsForConversation.mockImplementation(() =>
          Promise.resolve([
            makeWorkflowRun({ id: 'run-a', status: 'paused' }),
            makeWorkflowRun({ id: 'run-b', status: 'failed' }),
          ])
        );

        const result = await handleCommand(baseConversation, '/reset', operator);

        expect(mockCancelResumableRunsForConversation).toHaveBeenCalledWith(
          baseConversation.id,
          expect.any(Function)
        );
        // "resumable", not "pending": pending is itself a status name and reads
        // as "waiting" to a user.
        expect(result.message).toContain('Abandoned 2 resumable run(s).');
      });

      test('reset reports failed container cleanup after cancelling its runs', async () => {
        mockGetActiveSession.mockResolvedValue(null);
        mockCancelResumableRunsForConversation.mockResolvedValueOnce([
          makeWorkflowRun({
            id: 'run-a',
            status: 'paused',
            metadata: { isolation: 'container', isolation_env_id: 'env-a' },
          }),
        ]);
        mockReclaimContainerEnv.mockRejectedValueOnce(new Error('docker down'));
        const result = await handleCommand(baseConversation, '/reset', operator);
        expect(result.message).toContain('Abandoned 1 resumable run(s).');
        expect(result.message).toContain('Could not reclaim container environment env-a');
        expect(result.message).toContain('resources may remain allocated');
      });

      test('still reports the abandoned count when clearing the binding fails', async () => {
        // The two effects live in separate try blocks precisely so a failure in
        // the second cannot swallow what the first already did.
        mockGetActiveSession.mockResolvedValue(null);
        mockCancelResumableRunsForConversation.mockImplementation(() =>
          Promise.resolve([makeWorkflowRun({ id: 'run-a', status: 'paused' })])
        );
        mockUpdateConversation.mockImplementation(() =>
          Promise.reject(new Error('Conversation not found: conv-123'))
        );

        const result = await handleCommand(baseConversation, '/reset', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Abandoned 1 resumable run(s).');
        expect(result.message).toContain('Could not clear the workspace binding');
        // And it must NOT claim the binding was cleared.
        expect(result.message).not.toContain('Cleared workspace binding');
      });

      for (const failure of ['role lookup', 'transactional snapshot'] as const) {
        test(`reset preserves session and binding when ${failure} fails`, async () => {
          const users = await import('../../db/users');
          const roleLookup = spyOn(users, 'getUserById');
          if (failure === 'role lookup')
            roleLookup.mockRejectedValueOnce(new Error('role lookup unavailable'));
          else {
            roleLookup.mockResolvedValueOnce({
              id: 'member-b',
              role: 'member',
              display_name: null,
              email: null,
              created_at: new Date(),
              updated_at: new Date(),
            });
            mockCancelResumableRunsForConversation.mockRejectedValueOnce(
              new Error('snapshot unavailable')
            );
          }
          try {
            const result = await handleCommand(baseConversation, '/reset', {
              kind: 'user',
              userId: 'member-b',
            });
            expect(result.success).toBe(false);
            expect(result.message).toContain('Could not reset conversation');
            expect(mockDeactivateSession).not.toHaveBeenCalled();
            expect(mockUpdateConversation).not.toHaveBeenCalled();
          } finally {
            roleLookup.mockRestore();
          }
        });
      }

      test('reset refusal preserves session and workspace binding', async () => {
        mockCancelResumableRunsForConversation.mockImplementation(async (_id, authorize) => {
          authorize?.([makeWorkflowRun({ user_id: 'starter', status: 'paused' })]);
          return [];
        });
        const result = await handleCommand(baseConversation, '/reset', { kind: 'unidentified' });
        expect(result.success).toBe(false);
        expect(result.message).toContain(new RunActionForbiddenError('abandon', 'starter').message);
        expect(mockDeactivateSession).not.toHaveBeenCalled();
        expect(mockUpdateConversation).not.toHaveBeenCalled();
      });

      for (const action of ['approve', 'reject', 'respond', 'cancel', 'abandon', 'resume']) {
        test(`chat ${action} refuses another member without writes`, async () => {
          const users = await import('../../db/users');
          const roleLookup = spyOn(users, 'getUserById').mockResolvedValue({
            id: 'other',
            display_name: null,
            email: null,
            role: 'member',
            created_at: new Date(),
            updated_at: new Date(),
          });
          mockGetWorkflowRun.mockResolvedValue(
            makeWorkflowRun({ id: 'run-auth', user_id: 'starter', status: 'paused' })
          );
          try {
            const result = await handleCommand(
              baseConversation,
              `/workflow ${action} run-auth custom`,
              { kind: 'user', userId: 'other' }
            );
            expect(result.success).toBe(false);
            expect(result.message).toContain('Only the user who started this run or an admin');
            expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
          } finally {
            roleLookup.mockRestore();
          }
        });
      }
      test('should deactivate active session', async () => {
        mockGetActiveSession.mockResolvedValue(
          makeSession({
            id: 'session-123',
            codebase_id: 'cb-123',
            assistant_session_id: 'sdk-123',
            active: true,
          })
        );
        mockDeactivateSession.mockResolvedValue(undefined);

        const result = await handleCommand(baseConversation, '/reset', operator);
        expect(result.success).toBe(true);
        expect(result.message).toContain('cleared');
        expect(mockDeactivateSession).toHaveBeenCalledWith('session-123', 'reset-requested');
      });

      test('should handle no active session gracefully', async () => {
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(baseConversation, '/reset', operator);
        expect(result.success).toBe(true);
        expect(result.message).toContain('No active session');
      });

      test('continues run and binding cleanup when the session lookup fails (#2731 R3)', async () => {
        mockGetActiveSession.mockRejectedValueOnce(new Error('session DB unavailable'));
        mockCancelResumableRunsForConversation.mockResolvedValueOnce([
          makeWorkflowRun({ id: 'run-a', status: 'paused' }),
        ]);

        const result = await handleCommand(baseConversation, '/reset', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Could not clear the AI session: session DB unavailable');
        expect(result.message).toContain('Reset is incomplete — retry /reset');
        expect(result.message).not.toContain('next message starts fresh');
        expect(mockCancelResumableRunsForConversation).toHaveBeenCalledWith(
          baseConversation.id,
          expect.any(Function)
        );
        expect(mockUpdateConversation).toHaveBeenCalledWith(baseConversation.id, {
          cwd: null,
          isolation_env_id: null,
        });
      });

      test('continues run and binding cleanup when session deactivation fails (#2731 R3)', async () => {
        mockGetActiveSession.mockResolvedValueOnce(
          makeSession({
            id: 'session-123',
            codebase_id: 'cb-123',
            assistant_session_id: 'sdk-123',
            active: true,
          })
        );
        mockDeactivateSession.mockRejectedValueOnce(new Error('deactivation failed'));

        const result = await handleCommand(baseConversation, '/reset', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Could not clear the AI session: deactivation failed');
        expect(result.message).toContain('Reset is incomplete — retry /reset');
        expect(mockCancelResumableRunsForConversation).toHaveBeenCalledWith(
          baseConversation.id,
          expect.any(Function)
        );
        expect(mockUpdateConversation).toHaveBeenCalledWith(baseConversation.id, {
          cwd: null,
          isolation_env_id: null,
        });
      });

      test('does not claim a fresh start when a selected run cannot be abandoned (#2731 R2)', async () => {
        mockGetActiveSession.mockResolvedValue(null);
        mockCancelResumableRunsForConversation.mockRejectedValueOnce(new Error('database busy'));

        const result = await handleCommand(baseConversation, '/reset', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Could not reset conversation: database busy');
        expect(mockDeactivateSession).not.toHaveBeenCalled();
        expect(mockUpdateConversation).not.toHaveBeenCalled();
        expect(result.message).not.toContain('next message starts fresh');
      });

      test('surfaces a blocked-parent warning when abandoning a child strands its parent (#2731 R1)', async () => {
        // The parent is paused blocked-on-child; abandoning the child leaves
        // the parent stuck. /reset must name the stranded parent so the user
        // knows to resume or abandon it.
        mockGetActiveSession.mockResolvedValue(null);
        mockCancelResumableRunsForConversation.mockImplementation(() =>
          Promise.resolve([
            makeWorkflowRun({ id: 'child', parent_run_id: 'parent-stuck', status: 'paused' }),
          ])
        );
        mockGetWorkflowRun.mockImplementation(id => {
          if (id === 'parent-stuck') {
            return Promise.resolve(
              makeWorkflowRun({
                id: 'parent-stuck',
                status: 'paused',
                metadata: {
                  approval: {
                    nodeId: 'workflow',
                    message: 'waiting on sub-run',
                    type: 'child_workflow',
                    childRunId: 'child',
                  },
                },
              })
            );
          }
          return Promise.resolve(null);
        });

        const result = await handleCommand(baseConversation, '/reset', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Parent run parent-stuck was blocked');
        expect(result.message).toContain('stays paused');
        expect(result.message).not.toContain('next message starts fresh');
      });

      test('reports only the final state across a running status gap (#2731 R4)', async () => {
        mockGetActiveSession.mockResolvedValue(null);
        mockCancelResumableRunsForConversation.mockImplementation(() =>
          Promise.resolve([
            makeWorkflowRun({ id: 'run-a', status: 'paused' }),
            makeWorkflowRun({ id: 'run-c', parent_run_id: 'run-b', status: 'paused' }),
          ])
        );
        mockGetWorkflowRun.mockResolvedValue(makeWorkflowRun({ id: 'run-b', status: 'running' }));

        const result = await handleCommand(baseConversation, '/reset', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('Abandoned 2 resumable run(s).');
        expect(result.message).not.toContain('Parent run run-b was blocked');
        expect(result.message).not.toContain('sub-run(s) could not be cancelled');
        expect(result.message).toContain('next message starts fresh');
      });
    });
  });
});
