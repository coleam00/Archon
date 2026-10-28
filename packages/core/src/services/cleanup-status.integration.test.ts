// @archon-test-isolated
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import * as git from '@archon/git';
import * as codebases from '../db/codebases';
import * as sessions from '../db/sessions';
import * as workflows from '../db/workflows';
import { handleStatusCommand } from '../handlers/commands/status';
import { makeCodebase, makeConversation } from '../test/orchestrator-agent-fixtures';
import * as config from '../config/config-loader';
import * as environments from '../db/isolation-environments';
import { clearPlatformPolicies, setPlatformPolicies } from '../platforms/registry';
import { getWorktreeStatusBreakdown } from './cleanup-service';

const trackRoot = trackTempRoots();

afterEach(() => {
  mock.restore();
  clearPlatformPolicies();
});

test.each(['directory', 'missing path'])(
  'reports unavailable merge inspection for a non-repository %s',
  async shape => {
    const root = trackRoot(await mkdtemp(join(tmpdir(), 'archon-status-no-repo-')));
    const repoPath = shape === 'directory' ? root : join(root, 'missing');
    setPlatformPolicies([{ id: 'test', workspaceRetention: 'age-based' }]);
    spyOn(config, 'loadRepoConfig').mockResolvedValue({ worktree: { baseBranch: 'main' } });
    spyOn(environments, 'listByCodebaseWithAge').mockResolvedValue([statusEnvironment(root)]);

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', repoPath);

    const diagnostic = breakdown.inspectionFailedEnvs[0]?.errors[0];
    expect(diagnostic).toContain(
      'Patch equivalence: Failed to check if task-1 is patch-equivalent to origin/main:'
    );
    expect(diagnostic).toContain(repoPath);
    expect(breakdown).toEqual({
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
          branchName: 'task-1',
          errors: [diagnostic],
        },
      ],
    });
  }
);

function statusEnvironment(
  root: string
): Awaited<ReturnType<typeof environments.listByCodebaseWithAge>>[number] {
  return {
    id: 'env-1',
    codebase_id: 'codebase-1',
    workflow_type: 'task',
    workflow_id: 'task-1',
    provider: 'worktree',
    working_path: join(root, 'worktree'),
    branch_name: 'task-1',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'test',
    created_by_user_id: null,
    metadata: {},
    days_since_activity: 30,
  };
}

test.each(['config', 'default branch'])(
  'status retains the total when %s resolution rejects, without exposing secrets',
  async source => {
    setPlatformPolicies([{ id: 'test', workspaceRetention: 'age-based' }]);
    const codebase = makeCodebase();
    spyOn(codebases, 'listCodebases').mockResolvedValue([codebase]);
    spyOn(codebases, 'getCodebase').mockResolvedValue(codebase);
    spyOn(sessions, 'getActiveSession').mockResolvedValue(null);
    spyOn(workflows, 'getActiveWorkflowRun').mockResolvedValue(null);
    spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'main', stderr: '' });
    spyOn(environments, 'listByCodebaseWithAge').mockResolvedValue([
      statusEnvironment(codebase.default_cwd),
    ]);
    const error = new Error('failed with https://user:secret@example.com/repo?token=secret');
    const loadConfig = spyOn(config, 'loadRepoConfig').mockResolvedValue({});
    const defaultBranch = spyOn(git, 'getDefaultBranch');
    if (source === 'config') loadConfig.mockRejectedValueOnce(error);
    else defaultBranch.mockRejectedValueOnce(error);

    const result = await handleStatusCommand(makeConversation({ codebase_id: codebase.id }), {
      formatWorkflowCommand: command => command,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('Worktrees: 1 total');
    expect(result.message).toContain(
      'Merge/stale classification unavailable (base ref resolution failed'
    );
    expect(result.message).not.toContain('secret');
    expect(result.message).not.toContain('example.com');
    expect(result.message).not.toContain('0 active');
    expect(result.message).not.toContain('stale (');
    if (source === 'config') expect(defaultBranch).not.toHaveBeenCalled();
  }
);
