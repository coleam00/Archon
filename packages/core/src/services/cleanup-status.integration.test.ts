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
import { getLog } from './cleanup/log';
import { statusDiagnostic } from './cleanup/status-diagnostic';
import { InvalidConfigError } from '../config/config-validation';

const omitted = 'Operation failed (unstructured diagnostic omitted to protect credentials)';

const trackRoot = trackTempRoots();

const unsafeRemoteFailures = [
  "fatal: unable to access 'http://127.0.0.1:1/repo?token=prefix topsecret-5209/': URL rejected: Malformed input to a URL function",
  'fatal: remote git@example.test:org/repo.git?access_token=scp-secret-789 is unavailable',
];

const quotedGitFailure =
  "fatal: unable to access 'http://127.0.0.1:1234/repo?token='topsecret/': The requested URL returned error: 403";

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
    expect(diagnostic).toBe(`Patch equivalence: ${omitted}`);
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

test.each(
  ['config', 'default branch'].flatMap(source =>
    [quotedGitFailure, ...unsafeRemoteFailures].map(failure => [source, failure])
  )
)(
  'status retains the total when %s resolution rejects, without exposing secrets',
  async (source, failure) => {
    setPlatformPolicies([{ id: 'test', workspaceRetention: 'age-based' }]);
    const codebase = makeCodebase({
      repository_url: 'https://user:secret@gitlab.example/org/repo.git?token=secret#secret',
    });
    spyOn(codebases, 'listCodebases').mockResolvedValue([codebase]);
    spyOn(codebases, 'getCodebase').mockResolvedValue(codebase);
    spyOn(sessions, 'getActiveSession').mockResolvedValue(null);
    spyOn(workflows, 'getActiveWorkflowRun').mockResolvedValue(null);
    spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'main', stderr: '' });
    spyOn(environments, 'listByCodebaseWithAge').mockResolvedValue([
      statusEnvironment(codebase.default_cwd),
    ]);
    const warn = spyOn(getLog(), 'warn');
    const reason =
      source === 'config'
        ? 'Invalid repository configuration'
        : 'Remote default branch is unavailable';
    const error =
      source === 'config'
        ? new InvalidConfigError('Invalid setting', '/repo/.archon/config.yaml', failure)
        : new git.GitFailure('default_branch_missing', failure);
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
    expect(result.message).toContain(reason);
    expect(warn).toHaveBeenCalledWith(
      {
        codebaseId: codebase.id,
        reason,
      },
      'worktree_status_base_ref_resolution_failed'
    );
    expect(result.message).toContain('(gitlab.example)');
    expect(result.message).not.toContain('topsecret');
    expect(result.message).not.toContain('scp-secret');
    expect(result.message).not.toContain('patch-secret');
    expect(result.message).not.toContain('fragment-secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('topsecret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('scp-secret');
    expect(result.message).not.toContain('user:');
    expect(result.message).not.toContain('example.com');
    expect(result.message).not.toContain('0 active');
    expect(result.message).not.toContain('stale (');
    if (source === 'config') expect(defaultBranch).not.toHaveBeenCalled();
  }
);

test.each([
  quotedGitFailure,
  'ssh://patch-secret@example.com/repo#fragment-secret',
  ...unsafeRemoteFailures,
])('status keeps both inspection failure categories and omits %s', async failure => {
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
  spyOn(config, 'loadRepoConfig').mockResolvedValue({ worktree: { baseBranch: 'main' } });
  const warn = spyOn(getLog(), 'warn');
  spyOn(git, 'isBranchMerged').mockRejectedValueOnce(new Error(`ancestry unavailable: ${failure}`));
  spyOn(git, 'isPatchEquivalent').mockRejectedValueOnce(new Error(`patch unavailable: ${failure}`));

  const result = await handleStatusCommand(makeConversation({ codebase_id: codebase.id }), {
    formatWorkflowCommand: command => command,
  });

  expect(result.success).toBe(true);
  expect(result.message).toContain('Worktrees: 1 total');
  expect(warn).toHaveBeenCalledWith(
    {
      branchName: 'task-1',
      reason: omitted,
    },
    'merge_check_error_in_breakdown'
  );
  expect(warn).toHaveBeenCalledWith(
    { branchName: 'task-1', reason: omitted },
    'patch_check_error_in_breakdown'
  );
  expect(result.message).toContain('task-1: merge inspection failed');
  expect(result.message).toContain(`Ancestry: ${omitted}`);
  expect(result.message).toContain(`Patch equivalence: ${omitted}`);
  expect(result.message).not.toContain('topsecret');
  expect(result.message).not.toContain('scp-secret');
  expect(result.message).not.toContain('patch-secret');
  expect(result.message).not.toContain('fragment-secret');
  expect(result.message).not.toContain('example.com');
  expect(JSON.stringify(warn.mock.calls)).not.toContain('topsecret');
  expect(JSON.stringify(warn.mock.calls)).not.toContain('scp-secret');
});

test('status omits a bare credential from an unstructured failure and warning', async () => {
  const credential = 'unique-bare-status-credential-5209';
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
  spyOn(config, 'loadRepoConfig').mockRejectedValueOnce(
    new Error(`Invalid worktree config: rejected credential ${credential}`)
  );
  const warn = spyOn(getLog(), 'warn');

  const result = await handleStatusCommand(makeConversation({ codebase_id: codebase.id }), {
    formatWorkflowCommand: command => command,
  });

  expect(result.success).toBe(true);
  expect(result.message).toContain('Worktrees: 1 total');
  expect(result.message).toContain(omitted);
  expect(result.message).not.toContain(credential);
  expect(warn).toHaveBeenCalledWith(
    {
      codebaseId: codebase.id,
      reason: omitted,
    },
    'worktree_status_base_ref_resolution_failed'
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain(credential);
});

test.each(unsafeRemoteFailures)('does not publish unstructured remote errors: %s', failure => {
  for (const error of [failure, new Error(failure), { message: failure }]) {
    expect(statusDiagnostic(error)).toBe(omitted);
  }
  const cause = Object.assign(new Error(failure), { code: 128, stderr: failure });
  expect(statusDiagnostic(new git.GitFailure('unclassified', failure, cause))).toBe(
    'Git operation failed (exit code 128)'
  );
  expect(statusDiagnostic(new git.GitFailure('timeout', failure))).toBe('Git operation timed out');
});

test('real malformed remote cannot expose a credential in status or its warning', async () => {
  const root = trackRoot(await mkdtemp(join(tmpdir(), 'archon-status-malformed-remote-')));
  await git.execFileAsync('git', ['init', root]);
  await git.execFileAsync('git', [
    '-C',
    root,
    'remote',
    'add',
    'origin',
    'http://127.0.0.1:1/repo?token=prefix topsecret-5209',
  ]);
  setPlatformPolicies([{ id: 'test', workspaceRetention: 'age-based' }]);
  const codebase = makeCodebase({ default_cwd: root });
  spyOn(codebases, 'listCodebases').mockResolvedValue([codebase]);
  spyOn(codebases, 'getCodebase').mockResolvedValue(codebase);
  spyOn(sessions, 'getActiveSession').mockResolvedValue(null);
  spyOn(workflows, 'getActiveWorkflowRun').mockResolvedValue(null);
  spyOn(environments, 'listByCodebaseWithAge').mockResolvedValue([statusEnvironment(root)]);
  spyOn(config, 'loadRepoConfig').mockResolvedValue({});
  const warn = spyOn(getLog(), 'warn');

  const result = await handleStatusCommand(makeConversation({ codebase_id: codebase.id }), {
    formatWorkflowCommand: command => command,
  });

  expect(result.success).toBe(true);
  expect(result.message).toContain('Worktrees: 1 total');
  expect(result.message).toContain(
    'Merge/stale classification unavailable (base ref resolution failed: Git operation failed (exit code 128))'
  );
  expect(result.message).not.toContain('topsecret-5209');
  expect(JSON.stringify(warn.mock.calls)).not.toContain('topsecret-5209');
});
