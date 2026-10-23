// @archon-test-isolated
import { describe, test, expect, beforeEach, afterAll, spyOn } from 'bun:test';
import * as gitUtils from '@archon/git';
import { handleCommand } from '../command-handler';
import {
  operator,
  makeCodebase,
  makeWorkflowRun,
  makeIsolationEnvironment,
  mockGetCodebase,
  mockGetWorktreeStatusBreakdown,
  mockFindCodebaseByDefaultCwd,
  mockGetActiveSession,
  mockGetActiveWorkflowRun,
  spyExecFileAsync,
  mockIsolationEnvDbGet,
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
    describe('/status', () => {
      test('should show platform and assistant info', async () => {
        const result = await handleCommand(baseConversation, '/status', operator);
        expect(result.success).toBe(true);
        expect(result.message).toContain('telegram');
        expect(result.message).toContain('claude');
      });

      test('should show codebase info when set', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-123',
            name: 'my-repo',
            repository_url: 'https://github.com/user/my-repo',
            default_cwd: '/workspace/my-repo',
          })
        );
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(conversation, '/status', operator);
        expect(result.success).toBe(true);
        expect(result.message).toContain('my-repo');
        // cwd is null → the working directory falls back to the project root
        // (issue #1993: web-created project conversations have null cwd).
        expect(result.message).toContain('Working Directory: /workspace/my-repo');
      });

      test('shows merge inspection failures and their causes separately from stale worktrees', async () => {
        mockGetCodebase.mockResolvedValue(makeCodebase());
        mockGetWorktreeStatusBreakdown.mockResolvedValueOnce({
          total: 1,
          merged: 0,
          stale: 0,
          active: 0,
          mergedEnvs: [],
          staleEnvs: [],
          activeEnvs: [],
          inspectionFailedEnvs: [
            {
              id: 'env-1',
              branchName: 'unknown-branch',
              errors: [
                'Ancestry: ancestry unavailable',
                'Patch equivalence: patch comparison unavailable',
              ],
            },
          ],
        });

        const result = await handleCommand(
          { ...baseConversation, codebase_id: 'cb-123' },
          '/status',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('unknown-branch: merge inspection failed');
        expect(result.message).toContain('Ancestry: ancestry unavailable');
        expect(result.message).toContain('Patch equivalence: patch comparison unavailable');
        expect(result.message).not.toContain('stale (');
      });

      test('explicit conversation.cwd wins over the codebase default in the working-directory line', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-123',
          cwd: '/explicit/worktree',
        };
        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-123',
            name: 'my-repo',
            repository_url: 'https://github.com/user/my-repo',
            default_cwd: '/workspace/my-repo',
          })
        );
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(conversation, '/status', operator);
        expect(result.success).toBe(true);
        expect(result.message).toContain('Working Directory: /explicit/worktree');
        expect(result.message).not.toContain('Working Directory: /workspace/my-repo');
      });

      test('folder project: shows "(folder — runs in place)", lists child repos, skips worktrees', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-folder' };
        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-folder',
            name: 'platform',
            repository_url: null,
            default_cwd: '/tmp/platform',
            kind: 'folder',
          })
        );
        mockGetActiveSession.mockResolvedValue(null);
        const childReposSpy = spyOn(gitUtils, 'listChildRepos').mockResolvedValue([
          'auth-service',
          'billing-service',
        ]);

        try {
          const result = await handleCommand(conversation, '/status', operator);
          expect(result.success).toBe(true);
          expect(result.message).toContain('platform (folder — runs in place)');
          // Folder projects get the same cwd fallback as repos.
          expect(result.message).toContain('Working Directory: /tmp/platform');
          expect(result.message).toContain('Contains 2 git repos: auth-service, billing-service');
          // Worktree breakdown is skipped for folder projects.
          expect(result.message).not.toContain('Worktrees:');
        } finally {
          childReposSpy.mockRestore();
        }
      });

      test('should show project-less status when no codebase attached', async () => {
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(baseConversation, '/status', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('Orchestrator Status');
        expect(result.message).toContain('None — orchestrator will route as needed');
      });

      test('should show no codebase when cwd does not match any codebase', async () => {
        const conversation = { ...baseConversation, cwd: '/workspace/unknown-repo' };

        mockFindCodebaseByDefaultCwd.mockResolvedValue(null);
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(conversation, '/status', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('None — orchestrator will route as needed');
      });

      test('should display worktree from isolation_env_id when set', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-worktree',
          isolation_env_id: 'env-123',
        };

        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-worktree',
            name: 'owner/repo',
            repository_url: 'https://github.com/owner/repo',
            default_cwd: '/workspace/repo',
          })
        );
        mockGetActiveSession.mockResolvedValue(null);
        // Mock isolation environment lookup to return worktree branch
        mockIsolationEnvDbGet.mockResolvedValue(
          makeIsolationEnvironment({
            id: 'env-123',
            codebase_id: 'cb-worktree',
            workflow_type: 'issue',
            workflow_id: 'issue-42',
            working_path: '/workspace/repo/worktrees/issue-42',
            branch_name: 'issue-42',
          })
        );

        const result = await handleCommand(conversation, '/status', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('owner/repo @ issue-42 (worktree)');
      });

      test('should warn and fallback when isolation_env_id record not found', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-orphaned',
          isolation_env_id: 'env-orphaned', // Points to deleted record
        };

        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-orphaned',
            name: 'owner/orphaned-repo',
            repository_url: 'https://github.com/owner/orphaned-repo',
            default_cwd: '/workspace/orphaned-repo',
          })
        );
        mockGetActiveSession.mockResolvedValue(null);
        // Mock isolation environment lookup returning null (orphaned reference)
        mockIsolationEnvDbGet.mockResolvedValue(null);
        // Mock git branch detection fallback
        spyExecFileAsync.mockResolvedValue({ stdout: 'main\n', stderr: '' });

        const result = await handleCommand(conversation, '/status', operator);

        expect(result.success).toBe(true);
        // Should fallback to git branch detection (no worktree marker)
        expect(result.message).toContain('owner/orphaned-repo @ main');
        expect(result.message).not.toContain('(worktree)');
      });
    });

    describe('/status with active workflow', () => {
      test.each(['cb-123', null])('shows the active workflow in scope %s', async codebaseId => {
        const startedAt = new Date(Date.now() - 3 * 60 * 1000); // 3 minutes ago
        const lastActivity = new Date(Date.now() - 10 * 1000); // 10 seconds ago
        mockGetActiveWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'wf-active-123',
            codebase_id: 'cb-123',
            workflow_name: 'investigate-issue',
            started_at: startedAt,
            user_message: 'test',
            last_activity_at: lastActivity,
          })
        );

        const result = await handleCommand(
          { ...baseConversation, codebase_id: codebaseId },
          '/status',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Active Workflow: `investigate-issue`');
        expect(result.message).toContain('Cancel: `/workflow cancel`');
      });

      test('should not show workflow section when no workflow running', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(baseConversation, '/status', operator);

        expect(result.success).toBe(true);
        expect(result.message).not.toContain('Active Workflow');
      });

      test('should show active workflow info in status without stale warnings', async () => {
        const startedAt = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
        const lastActivity = new Date(Date.now() - 7 * 60 * 1000); // 7 minutes ago
        mockGetActiveWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'wf-active',
            workflow_name: 'long-workflow',
            started_at: startedAt,
            user_message: 'test',
            last_activity_at: lastActivity,
          })
        );

        const result = await handleCommand(baseConversation, '/status', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('Active Workflow');
        expect(result.message).toContain('long-workflow');
        expect(result.message).not.toContain('possibly stale');
      });

      test('should gracefully handle workflow database errors in status', async () => {
        mockGetActiveWorkflowRun.mockRejectedValueOnce(new Error('Database connection error'));

        const result = await handleCommand(baseConversation, '/status', operator);

        // Status should still succeed, just without workflow info
        expect(result.success).toBe(true);
        expect(result.message).toContain('telegram'); // Basic info still present
        expect(result.message).not.toContain('Active Workflow');
      });

      test('should handle invalid workflow date data gracefully in status', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'wf-invalid-dates',
            workflow_name: 'corrupted-workflow',
            started_at: new Date(Number.NaN),
            user_message: 'test',
          })
        );

        const result = await handleCommand(baseConversation, '/status', operator);

        expect(result.success).toBe(true);
        // Should still show workflow name
        expect(result.message).toContain('corrupted-workflow');
      });
    });
  });
});
