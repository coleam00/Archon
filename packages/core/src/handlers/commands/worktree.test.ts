// @archon-test-isolated
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  MissingProjectDirectoryError,
  WorktreeRegistrationChangedError,
  WorktreeUncommittedChangesError,
} from '@archon/isolation';
import { handleCommand } from '../command-handler';
import {
  operator,
  makeCodebase,
  makeConversation,
  makeSession,
  makeIsolationEnvironment,
  mockUpdateConversation,
  mockGetCodebase,
  mockGetActiveSession,
  mockDeactivateSession,
  spyExecFileAsync,
  spyListWorktrees,
  mockIsolationEnvDbCreate,
  mockIsolationEnvDbGet,
  mockMarkWorktreeDestroyed,
  mockWithWorktreeRegistration,
  mockCountActiveByCodebase,
  mockIsolationCreate,
  mockIsolationDestroy,
  emptyCleanup,
  mockCleanupMergedWorktrees,
  mockCleanupStaleWorktrees,
  mockGetLiveRunBlocker,
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
    describe('/worktree', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
        cwd: '/workspace/my-repo',
      });

      beforeEach(() => {
        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'codebase-123',
            name: 'my-repo',
            repository_url: 'https://github.com/user/my-repo',
            default_cwd: '/workspace/my-repo',
            kind: 'repo',
          })
        );
      });

      test('rejects /worktree on a folder project as not applicable', async () => {
        mockGetCodebase.mockResolvedValueOnce(
          makeCodebase({
            id: 'codebase-123',
            name: 'platform',
            repository_url: null,
            default_cwd: '/tmp/platform',
            kind: 'folder',
          })
        );

        const result = await handleCommand(
          conversationWithCodebase,
          '/worktree create feat-x',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('not applicable to folder projects');
      });

      describe('create', () => {
        test('should require codebase', async () => {
          const result = await handleCommand(baseConversation, '/worktree create feat-x', operator);
          expect(result.success).toBe(false);
          expect(result.message).toContain('No codebase');
        });

        test('should require branch name', async () => {
          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree create',
            operator
          );
          expect(result.success).toBe(false);
          expect(result.message).toContain('Usage');
        });

        test('should validate branch name format', async () => {
          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree create "bad name"',
            operator
          );
          expect(result.success).toBe(false);
          expect(result.message).toContain('letters, numbers');
        });

        test('should create worktree with valid name', async () => {
          spyExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
          mockGetActiveSession.mockResolvedValue(null);

          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree create feat-auth',
            operator
          );

          expect(result.success).toBe(true);
          expect(result.message).toContain('Worktree created');
          expect(result.message).toContain('task-feat-auth');
          expect(result.message).toMatch(/worktrees[\\\/]task-feat-auth/);
          expect(mockUpdateConversation).toHaveBeenCalled();
          expect(mockIsolationCreate).toHaveBeenCalled();
          expect(mockIsolationEnvDbCreate).toHaveBeenCalledWith(
            expect.objectContaining({
              metadata: {
                adopted: false,
                worktree_creation_id: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
                worktree_branch_created: true,
              },
            })
          );
        });

        test('fails before registration when safe.directory configuration fails', async () => {
          mockIsolationCreate.mockRejectedValueOnce(new Error('config locked'));

          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree create feat-auth',
            operator
          );

          expect(result.success).toBe(false);
          expect(mockIsolationCreate).toHaveBeenCalled();
          expect(mockIsolationEnvDbCreate).not.toHaveBeenCalled();
          expect(mockUpdateConversation).not.toHaveBeenCalled();
        });

        test.each([
          'Submodule initialization failed: no network',
          'post-checkout hook: already exists',
        ])('reports the classified creation failure: %s', async message => {
          spyExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
          mockGetActiveSession.mockResolvedValue(null);
          // A submodule failure whose rollback left a directory behind carries the
          // leftover note beside its message; only the classifier reads it.
          const failure = Object.assign(new Error(message), {
            cleanupFailure: 'The incomplete workspace at /workspace/wt was left behind',
          });
          mockIsolationCreate.mockRejectedValueOnce(failure);

          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree create feat-auth',
            operator
          );

          expect(result.success).toBe(false);
          expect(result.message).toContain('classified:');
        });

        test('names the registered project when its directory is missing', async () => {
          mockIsolationCreate.mockImplementationOnce(async request => {
            throw new MissingProjectDirectoryError(
              request.canonicalRepoPath,
              request.codebaseName ?? request.codebaseId
            );
          });

          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree create feat-auth',
            operator
          );

          expect(result.success).toBe(false);
          expect(result.message).toContain("Project 'my-repo'");
          expect(result.message).toContain('/workspace/my-repo');
          expect(result.message).toContain('Restore');
          expect(result.message).toContain('re-register');
          expect(result.message).not.toContain('codebase-123');
          expect(mockIsolationEnvDbCreate).not.toHaveBeenCalled();
          expect(mockUpdateConversation).not.toHaveBeenCalled();
        });

        test('should reject if already using a worktree (shows working path, not UUID)', async () => {
          const convWithWorktree = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-existing',
          });

          // Mock DB lookup to return the working path for this UUID
          mockIsolationEnvDbGet.mockResolvedValueOnce(
            makeIsolationEnvironment({
              id: 'env-uuid-existing',
              codebase_id: 'codebase-123',
              working_path: '/workspace/my-repo/worktrees/existing-branch',
              branch_name: 'existing-branch',
            })
          );

          const result = await handleCommand(
            convWithWorktree,
            '/worktree create new-branch',
            operator
          );

          expect(result.success).toBe(false);
          expect(result.message).toContain('Already using worktree');
          expect(result.message).toMatch(/worktrees[\\\/]existing-branch/);
          expect(result.message).not.toContain('env-uuid-existing');
          expect(result.message).toContain('/worktree remove first');
        });

        test('should fallback to UUID when isolation env not found in DB', async () => {
          const convWithWorktree = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-orphaned',
          });

          // DB lookup returns null (orphaned reference)
          mockIsolationEnvDbGet.mockResolvedValueOnce(null);

          const result = await handleCommand(
            convWithWorktree,
            '/worktree create new-branch',
            operator
          );

          expect(result.success).toBe(false);
          expect(result.message).toContain('Already using worktree');
          expect(result.message).toContain('env-uuid-orphaned');
        });
      });

      describe('list', () => {
        test('should list worktrees', async () => {
          spyExecFileAsync.mockResolvedValue({
            stdout:
              '/workspace/my-repo  abc1234 [main]\n/workspace/my-repo/worktrees/feat-x  def5678 [feat-x]\n',
            stderr: '',
          });
          spyListWorktrees.mockResolvedValue([
            { path: '/workspace/my-repo', branch: 'main' },
            { path: '/workspace/my-repo/worktrees/feat-x', branch: 'feat-x' },
          ]);

          const result = await handleCommand(conversationWithCodebase, '/worktree list', operator);

          expect(result.success).toBe(true);
          expect(result.message).toContain('Worktrees:');
          expect(result.message).toContain('main');
          expect(result.message).toContain('abc1234 [main]');
          expect(result.message).toMatch(/worktrees[\\\/]feat-x/);
        });
      });

      describe('remove', () => {
        const featXEnv = makeIsolationEnvironment({
          id: 'env-uuid-feat-x',
          codebase_id: 'codebase-123',
          workflow_id: 'task-feat-x',
          working_path: '/workspace/my-repo/worktrees/feat-x',
          branch_name: 'feat-x',
          metadata: { worktree_creation_id: 'checkout-proof' },
        });

        test('suggests force only for a typed dirty-worktree refusal and retains state', async () => {
          const conv = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: featXEnv.id,
          });
          mockIsolationEnvDbGet.mockResolvedValue(featXEnv);
          mockIsolationDestroy.mockRejectedValueOnce(
            new WorktreeUncommittedChangesError(featXEnv.working_path)
          );
          const result = await handleCommand(conv, '/worktree remove', operator);
          expect(result.success).toBe(false);
          expect(result.message).toBe(
            'Worktree has uncommitted changes.\n\nCommit your work first, or use `/worktree remove --force` to discard.'
          );
          expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
          expect(mockUpdateConversation).not.toHaveBeenCalled();
          expect(mockDeactivateSession).not.toHaveBeenCalled();
        });

        test('does not suggest force for an unrelated removal failure containing modified', async () => {
          const conv = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: featXEnv.id,
          });
          mockIsolationEnvDbGet.mockResolvedValue(featXEnv);
          mockIsolationDestroy.mockRejectedValueOnce(
            new Error('worktree metadata could not be modified')
          );
          const result = await handleCommand(conv, '/worktree remove', operator);
          expect(result.success).toBe(false);
          expect(result.message).toBe(
            'Failed to remove worktree: worktree metadata could not be modified'
          );
          expect(result.message).not.toContain('--force');
          expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
          expect(mockUpdateConversation).not.toHaveBeenCalled();
          expect(mockDeactivateSession).not.toHaveBeenCalled();
        });

        test('should require active worktree', async () => {
          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree remove',
            operator
          );
          expect(result.success).toBe(false);
          expect(result.message).toContain('not using a worktree');
        });

        test('refuses forced container removal without clearing tracking', async () => {
          const conv = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: featXEnv.id,
          });
          mockIsolationEnvDbGet.mockResolvedValueOnce({ ...featXEnv, provider: 'container' });
          const result = await handleCommand(conv, '/worktree remove --force', operator);
          expect(result.success).toBe(false);
          expect(result.message).toContain('archon isolation cleanup 0');
          expect(mockIsolationDestroy).not.toHaveBeenCalled();
          expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
          expect(mockUpdateConversation).not.toHaveBeenCalled();
        });

        test('should remove worktree and switch to main', async () => {
          const convWithWorktree = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-feat-x', // Use UUID-like ID
          });

          mockIsolationEnvDbGet.mockResolvedValue(featXEnv);

          spyExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
          mockGetActiveSession.mockResolvedValue(null);

          const result = await handleCommand(convWithWorktree, '/worktree remove', operator);

          expect(result.success).toBe(true);
          expect(result.message).toContain('removed');
          expect(mockIsolationDestroy).toHaveBeenCalledWith(featXEnv.working_path, {
            force: false,
            canonicalRepoPath: '/workspace/my-repo',
            creationId: 'checkout-proof',
          });
          expect(result.message).toMatch(/worktrees[\\\/]feat-x/);
          expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(featXEnv);
          expect(mockUpdateConversation).toHaveBeenCalled();
        });

        test('detaches the conversation when its worktree registration was already destroyed', async () => {
          const destroyed = { ...featXEnv, status: 'destroyed' as const };
          mockIsolationEnvDbGet.mockResolvedValue(destroyed);
          mockGetActiveSession.mockResolvedValue(null);
          const conversation = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: destroyed.id,
          });
          const result = await handleCommand(conversation, '/worktree remove', operator);
          expect(result.success).toBe(true);
          expect(mockIsolationDestroy).not.toHaveBeenCalled();
          expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
          expect(mockUpdateConversation).toHaveBeenCalledWith(conversation.id, {
            isolation_env_id: null,
            cwd: '/workspace/my-repo',
          });
        });

        test.each([false, true])(
          'refuses a changed registration before destruction (force=%s)',
          async force => {
            mockIsolationEnvDbGet.mockResolvedValue(featXEnv);
            mockWithWorktreeRegistration.mockRejectedValueOnce(
              new WorktreeRegistrationChangedError(featXEnv.id)
            );
            const result = await handleCommand(
              makeConversation({ ...conversationWithCodebase, isolation_env_id: featXEnv.id }),
              `/worktree remove${force ? ' --force' : ''}`,
              operator
            );
            expect(mockWithWorktreeRegistration).toHaveBeenLastCalledWith(
              featXEnv,
              expect.any(Function)
            );
            expect(result.success).toBe(false);
            expect(result.message).toContain('changed during cleanup');
            expect(mockIsolationDestroy).not.toHaveBeenCalled();
            expect(mockUpdateConversation).not.toHaveBeenCalled();
          }
        );

        test('should deactivate session with worktree-removed reason', async () => {
          const convWithWorktree = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-feat-x',
          });

          mockIsolationEnvDbGet.mockResolvedValue(featXEnv);

          spyExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
          mockGetActiveSession.mockResolvedValue(makeSession({ id: 'session-789', active: true }));
          mockDeactivateSession.mockResolvedValue(undefined);

          const result = await handleCommand(convWithWorktree, '/worktree remove', operator);

          expect(result.success).toBe(true);
          expect(mockDeactivateSession).toHaveBeenCalledWith('session-789', 'worktree-removed');
        });

        test.each(['refusal', 'partial'])(
          'retains conversation and environment on %s',
          async mode => {
            const conv = makeConversation({
              ...conversationWithCodebase,
              isolation_env_id: featXEnv.id,
            });
            mockIsolationEnvDbGet.mockResolvedValueOnce(featXEnv);
            if (mode === 'refusal')
              mockIsolationDestroy.mockRejectedValueOnce(new Error('ownership changed'));
            else
              mockIsolationDestroy.mockResolvedValueOnce({
                worktreeRemoved: true,
                directoryClean: false,
                branchDeleted: null,
                remoteBranchDeleted: null,
                warnings: ['Retained directory'],
              });
            const result = await handleCommand(conv, '/worktree remove --force', operator);
            expect(result.success).toBe(false);
            expect(result.message).toContain(
              mode === 'refusal' ? 'ownership changed' : 'Retained directory'
            );
            expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
            expect(mockUpdateConversation).not.toHaveBeenCalled();
            expect(mockDeactivateSession).not.toHaveBeenCalled();
          }
        );

        test('refuses to remove a worktree owned by a live workflow run', async () => {
          const convWithWorktree = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-feat-x',
          });
          mockIsolationEnvDbGet.mockResolvedValue(featXEnv);
          mockGetLiveRunBlocker.mockResolvedValue({
            reason: 'live_run',
            display: 'run run-live is paused',
            runId: 'run-live-1234',
            runStatus: 'paused',
          });

          const result = await handleCommand(convWithWorktree, '/worktree remove', operator);

          expect(result.success).toBe(false);
          expect(result.message).toContain('Worktree kept: run run-live is paused.');
          expect(mockGetLiveRunBlocker).toHaveBeenCalledWith('env-uuid-feat-x');
          expect(mockIsolationDestroy).not.toHaveBeenCalled();
          expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
          expect(mockUpdateConversation).not.toHaveBeenCalled();
        });

        test('refuses forced removal of a worktree owned by a live workflow run', async () => {
          const convWithWorktree = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-feat-x',
          });
          mockIsolationEnvDbGet.mockResolvedValue(featXEnv);
          mockGetLiveRunBlocker.mockResolvedValue({
            reason: 'live_run',
            display: 'run run-live is paused',
            runId: 'run-live-1234',
            runStatus: 'paused',
          });

          const result = await handleCommand(
            convWithWorktree,
            '/worktree remove --force',
            operator
          );

          expect(result.success).toBe(false);
          expect(result.message).toContain('Worktree kept: run run-live is paused.');
          expect(mockGetLiveRunBlocker).toHaveBeenCalledWith('env-uuid-feat-x');
          expect(mockIsolationDestroy).not.toHaveBeenCalled();
          expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
          expect(mockUpdateConversation).not.toHaveBeenCalled();
        });
      });

      describe('default', () => {
        test('should show usage for unknown subcommand', async () => {
          const result = await handleCommand(conversationWithCodebase, '/worktree foo', operator);
          expect(result.success).toBe(false);
          expect(result.message).toContain('Usage');
        });
      });

      describe('cleanup', () => {
        test('should return usage for missing cleanup type', async () => {
          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree cleanup',
            operator
          );
          expect(result.success).toBe(false);
          expect(result.message).toContain('Usage');
          expect(result.message).toContain('merged');
          expect(result.message).toContain('stale');
        });

        test('should return usage for invalid cleanup type', async () => {
          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree cleanup foo',
            operator
          );
          expect(result.success).toBe(false);
          expect(result.message).toContain('Usage');
        });

        test.each(['merged', 'stale'] as const)('reports %s removal failures', async type => {
          const cleanup =
            type === 'merged' ? mockCleanupMergedWorktrees : mockCleanupStaleWorktrees;
          cleanup.mockResolvedValueOnce({
            ...emptyCleanup(),
            removed: ['done'],
            errors: [{ branchName: 'kept', error: 'registration changed' }],
          });
          const result = await handleCommand(
            conversationWithCodebase,
            `/worktree cleanup ${type}`,
            operator
          );
          expect(result.success).toBe(false);
          expect(result.message).toContain('done');
          expect(result.message).toContain('Failed: kept (registration changed)');
        });

        test('should report merged worktree cleanup results', async () => {
          mockCleanupMergedWorktrees.mockResolvedValueOnce({
            errors: [],
            removed: ['feat-old', 'feat-done'],
            warnings: [{ branchName: 'feat-done', message: "Remote branch retained 'feat-done'" }],
            skipped: [{ branchName: 'feat-protected', reason: 'has uncommitted changes' }],
            releasedFailedRuns: [
              { branchName: 'feat-done', runId: 'run-failed-1', reason: 'merged' },
            ],
          });
          mockCountActiveByCodebase.mockResolvedValueOnce(3);

          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree cleanup merged',
            operator
          );

          expect(result.success).toBe(true);
          expect(result.message).toContain('Cleaned up 2 merged worktree(s)');
          expect(result.message).toContain(
            "Warning: feat-done: Remote branch retained 'feat-done'"
          );
          expect(result.message).toContain('feat-old');
          expect(result.message).toContain('feat-done');
          expect(result.message).toContain('Released failed run run-fail (merged): feat-done');
          expect(result.message).toContain('Skipped 1 (protected)');
          expect(result.message).toContain('feat-protected');
          expect(result.message).toContain('Active worktrees: 3');
        });

        test.each(['merged', 'stale'] as const)(
          'preserves completed %s cleanup warnings when the count query fails',
          async cleanupType => {
            const cleanup =
              cleanupType === 'merged' ? mockCleanupMergedWorktrees : mockCleanupStaleWorktrees;
            cleanup.mockResolvedValueOnce({
              ...emptyCleanup(),
              removed: ['feat-done'],
              warnings: [
                { branchName: 'feat-done', message: "Remote branch retained 'feat-done'" },
              ],
            });
            mockCountActiveByCodebase.mockRejectedValueOnce(new Error('count query failed'));
            const result = await handleCommand(
              conversationWithCodebase,
              `/worktree cleanup ${cleanupType}`,
              operator
            );
            expect(result.success).toBe(true);
            expect(result.message).toContain(`Cleaned up 1 ${cleanupType} worktree(s)`);
            expect(result.message).toContain(
              "Warning: feat-done: Remote branch retained 'feat-done'"
            );
            expect(result.message).toContain('Active worktrees: unavailable');
            expect(result.message).toContain('count query failed');
          }
        );

        test('should report when no stale worktrees to clean up', async () => {
          mockCleanupStaleWorktrees.mockResolvedValueOnce(emptyCleanup());
          mockCountActiveByCodebase.mockResolvedValueOnce(1);

          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree cleanup stale',
            operator
          );

          expect(result.success).toBe(true);
          expect(result.message).toContain('No stale worktrees to clean up');
        });
      });
    });
  });
});
