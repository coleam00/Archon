/**
 * Tests for the control commands: resume, abandon, cancel, answer, approve, reject, respond.
 */
import {
  mockLogger,
  mockDetachedTargetStop,
  mockDetachedTargetRelease,
  mockReclaimContainerEnv,
  mockRequestDetachedRunStop,
  noOwnerAnswers,
  mockIsRunOwnerAnswering,
  mockDiscoverWorkflowsWithConfig,
  mockLookupWorkflowRun,
  mockCancelWorkflowRunCommand,
  spyOnJsonStdout,
  firstJsonPayload,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import {
  workflowResumeCommand,
  workflowAbandonCommand,
  workflowCancelCommand,
  workflowApproveCommand,
  workflowRejectCommand,
  workflowRespondCommand,
} from './workflow-control';

describe('write command --json output', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    mockCancelWorkflowRunCommand.mockReset();
    mockCancelWorkflowRunCommand.mockResolvedValue({ cancelled: true });
    mockRequestDetachedRunStop.mockReset();
    mockRequestDetachedRunStop.mockImplementation(noOwnerAnswers);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('JSON reports failure when abandonment loses cancellation', async () => {
    mockLookupWorkflowRun.mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'test',
      conversation_id: 'conv',
      parent_conversation_id: null,
      codebase_id: null,
      status: 'running',
      outcome: null,
      user_message: '',
      metadata: {},
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      working_path: null,
      user_id: null,
      parent_run_id: null,
      adopted_from_run_id: null,
      output_root: null,
      checkout_baseline: null,
      origin: null,
    });
    mockCancelWorkflowRunCommand.mockResolvedValueOnce({ cancelled: false });
    await workflowAbandonCommand(createTestWorkflowHost(), 'run-1', true);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      error: expect.stringContaining('changed before abandonment'),
    });
  });

  it('abandon --json emits a structured cancelled result', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-ab',
      workflow_name: 'implement',
      status: 'running',
      last_activity_at: new Date('2026-09-20T10:00:00.000Z'),
      metadata: { execution_owner: { host: 'build-box', pid: 4242 } },
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });

    await workflowAbandonCommand(createTestWorkflowHost(), 'run-ab', true);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      ok: true,
      runId: 'run-ab',
      action: 'abandon',
      status: 'cancelled',
      workflowName: 'implement',
      owner: {
        outcome: 'no_owner_answered',
        thisHost: hostname(),
        recordedHost: 'build-box',
        recordedPid: 4242,
        recordedUid: null,
        lastActivityAt: '2026-09-20T10:00:00.000Z',
      },
    });
  });

  it('abandon --json reports the stopped live owner and cancelled status', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-ab',
      workflow_name: 'implement',
      status: 'running',
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });
    mockRequestDetachedRunStop.mockImplementationOnce(async () => ({
      pid: 42,
      stop: mockDetachedTargetStop,
      release: mockDetachedTargetRelease,
    }));

    expect(await workflowAbandonCommand(createTestWorkflowHost(), 'run-ab', true)).toBe(0);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      ok: true,
      runId: 'run-ab',
      action: 'abandon',
      status: 'cancelled',
      workflowName: 'implement',
      owner: { outcome: 'stopped', pid: 42 },
    });
  });

  it('abandon --json emits {ok:false} on a not-found run (never throws)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const exitCode = await workflowAbandonCommand(createTestWorkflowHost(), 'missing', true);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Workflow run not found');
  });

  it('approve --json records the decision and does NOT auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const discovery = await import('@archon/workflows/workflow-discovery');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      origin: { conversationId: 'conv' },
      id: 'run-ap',
      workflow_name: 'implement',
      status: 'paused',
      working_path: '/tmp/wt',
      codebase_id: 'cb',
      conversation_id: 'conv',
      user_message: 'go',
      metadata: { approval: { nodeId: 'gate', message: 'ok?' } },
    });
    const discoverSpy = discovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await workflowApproveCommand(createTestWorkflowHost(), 'run-ap', 'lgtm', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-ap',
      action: 'approve',
      type: 'approval_gate',
      resumable: true,
    });
    // No inline resume → workflowRunCommand (whose first step is discovery) never ran
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('reject --json reports cancelled + resumable correctly without auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const discovery = await import('@archon/workflows/workflow-discovery');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      origin: { conversationId: 'conv' },
      id: 'run-rj',
      workflow_name: 'implement',
      status: 'paused',
      working_path: '/tmp/wt',
      codebase_id: 'cb',
      conversation_id: 'conv',
      user_message: 'go',
      metadata: { approval: { nodeId: 'gate', message: 'ok?' } },
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });
    const discoverSpy = discovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await workflowRejectCommand(createTestWorkflowHost(), 'run-rj', 'nope', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    // No onRejectPrompt in approval metadata → run is cancelled, not resumable
    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-rj',
      action: 'reject',
      cancelled: true,
      resumable: false,
    });
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('resume --json validates resumability without executing (executed:false)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const discovery = await import('@archon/workflows/workflow-discovery');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-rs',
      workflow_name: 'implement',
      status: 'failed',
      working_path: '/tmp/wt',
    });
    const discoverSpy = discovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    const exitCode = await workflowResumeCommand(createTestWorkflowHost(), 'run-rs', true);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-rs',
      action: 'resume',
      executed: false,
      status: 'failed',
    });
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('resume --json exits nonzero with {ok:false} on a not-found run', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const exitCode = await workflowResumeCommand(createTestWorkflowHost(), 'missing', true);

    expect(exitCode).toBe(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'resume',
    });
  });
});

describe('workflowResumeCommand', () => {
  const trackTempRoot = trackTempRoots();
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when run not found', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowResumeCommand(createTestWorkflowHost(), 'missing-id')).rejects.toThrow(
      'Workflow run not found: missing-id'
    );
  });

  it('should throw when run is not resumable', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'test',
      status: 'completed',
    });

    await expect(workflowResumeCommand(createTestWorkflowHost(), 'run-1')).rejects.toThrow(
      "Cannot resume run with status 'completed'"
    );
  });

  it('should print resume info and delegate to workflowRunCommand', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
    });

    // workflowResumeCommand calls workflowRunCommand internally which needs many
    // mocks. The --resume execution flow is tested separately in workflowRunCommand tests.
    // Here we only verify the initial output by catching the downstream error.
    try {
      await workflowResumeCommand(createTestWorkflowHost(), 'run-1');
    } catch {
      // workflowRunCommand will fail due to missing mocks — that's fine
    }

    // Printed resume message before delegating to workflowRunCommand
    expect(consoleSpy).toHaveBeenCalledWith('Resuming workflow: implement');
    expect(consoleSpy).toHaveBeenCalledWith('Path: /tmp/test-worktree');
  });

  it('should throw when run has no working path', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-no-path',
      workflow_name: 'implement',
      status: 'failed',
      working_path: null,
    });

    await expect(workflowResumeCommand(createTestWorkflowHost(), 'run-no-path')).rejects.toThrow(
      'has no working path recorded'
    );
  });

  it('should pass codebase_id from run record to workflowRunCommand', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'add auth',
      working_path: trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-resume-codebase-'))),
      codebase_id: 'cb-existing',
    });

    // Return a matching workflow so workflowRunCommand doesn't throw before codebase lookup
    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'implement' })],
      errors: [],
    });

    // Simulate getCodebase returning the codebase found by ID
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-existing',
      name: 'owner/repo',
      default_cwd: '/path/to/main-checkout', // different from working_path
    });

    try {
      await workflowResumeCommand(createTestWorkflowHost(), 'run-1');
    } catch {
      // workflowRunCommand may fail on other mocks — that's fine
    }

    // getCodebase SHOULD have been called with the stored codebase_id
    expect(codebaseDb.getCodebase).toHaveBeenCalledWith('cb-existing');
  });

  it('fails loudly when getCodebase throws during resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-err',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-bad',
    });

    // getCodebase throws — simulates DB hiccup
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('connection refused')
    );

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(workflowResumeCommand(createTestWorkflowHost(), 'run-err')).rejects.toThrow(
      "Failed to load codebase 'cb-bad' for workflow run 'run-err'"
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-bad' }),
      'cli.workflow_resume_codebase_lookup_failed'
    );
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/test-worktree',
      expect.any(Function),
      providerRegistry
    );
  });

  it('fails loudly when codebase row is missing during resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-missing-codebase',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-missing',
    });
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(
      workflowResumeCommand(createTestWorkflowHost(), 'run-missing-codebase')
    ).rejects.toThrow("references codebase 'cb-missing', but that codebase no longer exists");
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/test-worktree',
      expect.any(Function),
      providerRegistry
    );
  });

  it('should discover workflows from codebase.default_cwd, not working_path', async () => {
    // Regression test for #1663: when working_path is a worktree or workspace
    // clone that lacks the user's local workflow YAML, discovery must fall back
    // to codebase.default_cwd so the file is still found.
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1663',
      workflow_name: 'my-approval-workflow',
      status: 'failed',
      user_message: 'go',
      working_path: trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-worktree-without-yaml-'))),
      codebase_id: 'cb-with-yaml',
    });

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-with-yaml',
      name: 'owner/repo',
      default_cwd: '/users/me/source-repo-with-yaml',
    });

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowResumeCommand(createTestWorkflowHost(), 'run-1663');
    } catch {
      // downstream failure is acceptable — we only need to assert the discovery cwd
    }

    // A continuation takes no new capture, so discovery still reads the codebase source
    // path directly — #1663's guarantee, unchanged.
    expect(discoverSpy).toHaveBeenCalledWith(
      '/users/me/source-repo-with-yaml',
      expect.any(Function),
      providerRegistry
    );
  });

  it('should fall back to working_path for discovery when codebase_id is missing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const worktree = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-old-worktree-')));
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-no-codebase',
      workflow_name: 'legacy',
      status: 'failed',
      user_message: 'go',
      working_path: worktree,
      codebase_id: null,
    });

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowResumeCommand(createTestWorkflowHost(), 'run-no-codebase');
    } catch {
      // downstream failure is acceptable
    }

    // No codebase → falls back to working_path (preserves existing behavior)
    expect(discoverSpy).toHaveBeenCalledWith(worktree, expect.any(Function), providerRegistry);
  });

  it('resolves a resumed worktree through its Git-proven source checkout (#2127)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const git = await import('@archon/git');
    const { registerRepository } = await import('@archon/core');
    const worktree = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-resume-2127-')));
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-2127',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'go',
      working_path: worktree,
      codebase_id: null,
    });
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'implement' })],
      errors: [],
    });
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce(worktree);
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockResolvedValueOnce('/registered/root');
    const exact = codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>;
    exact.mockImplementation(async (path: string) =>
      path === '/registered/root'
        ? { id: 'cb-registered', name: 'coleam00/Archon', default_cwd: path, kind: 'repo' }
        : null
    );
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockClear();
    (registerRepository as ReturnType<typeof mock>).mockClear();
    try {
      await workflowResumeCommand(createTestWorkflowHost(), 'run-2127').catch(() => {
        // Only the codebase resolution is under test; what runs after it is not.
      });
      expect(exact).toHaveBeenCalledWith('/registered/root');
      expect(codebaseDb.findCodebaseByPathPrefix).toHaveBeenCalledWith(worktree);
      expect(registerRepository).not.toHaveBeenCalled();
    } finally {
      exact.mockReset().mockResolvedValue(null);
    }
  });

  // Cleanup removes a failed run's worktree once its outcome is settled (#4090). Codebase
  // resolution on the missing path used to fail first, as "Database lookup failed".
  it('refuses a run whose worktree is gone before resolving its codebase (#4090)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const git = await import('@archon/git');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-4090',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'go',
      working_path: join(tmpdir(), 'archon-removed-worktree-4090'),
      codebase_id: null,
    });
    const findRepoRoot = git.findRepoRoot as ReturnType<typeof mock>;
    findRepoRoot.mockClear();

    await expect(workflowResumeCommand(createTestWorkflowHost(), 'run-4090')).rejects.toThrow(
      'the working path from the run no longer exists'
    );
    expect(findRepoRoot).not.toHaveBeenCalled();
  });
});

describe('workflowApproveCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.error.mockClear();
    // Earlier suites can leave queued run lookups behind; each test queues its own.
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when run not found', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowApproveCommand(createTestWorkflowHost(), 'missing-id')).rejects.toThrow(
      'Workflow run not found: missing-id'
    );
  });

  // #3488: the refusal core throws names no command, so the CLI adds its own spelling
  // on both of its error surfaces — propagation (human) and the --json envelope.
  it('spells the child-run redirect for the CLI on both error surfaces', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const blockedParent = {
      id: 'run-blocked',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-existing',
      metadata: {
        approval: {
          nodeId: 'sub',
          message: 'blocked',
          type: 'child_workflow',
          childRunId: 'child-42',
        },
      },
    };

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(blockedParent);
    await expect(workflowApproveCommand(createTestWorkflowHost(), 'run-blocked')).rejects.toThrow(
      'Approve it by run id: `archon workflow approve child-42`'
    );

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(blockedParent);
    const stdoutSpy = spyOnJsonStdout();
    try {
      await workflowApproveCommand(createTestWorkflowHost(), 'run-blocked', undefined, true);
      const payload = JSON.parse(firstJsonPayload(stdoutSpy)) as { ok: boolean; error: string };
      expect(payload.ok).toBe(false);
      expect(payload.error).toContain('archon workflow approve child-42');
      expect(payload.error).not.toContain('/workflow ');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('should pass codebase_id from run record to workflowRunCommand', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-1',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-existing',
      metadata: { approval: { nodeId: 'review-node' } },
    });

    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });

    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'implement' })],
      errors: [],
    });

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-existing',
      name: 'owner/repo',
      default_cwd: '/path/to/main-checkout',
    });

    try {
      await workflowApproveCommand(createTestWorkflowHost(), 'run-approve-1');
    } catch {
      // downstream failure is acceptable
    }

    expect(codebaseDb.getCodebase).toHaveBeenCalledWith('cb-existing');
  });

  it('fails loudly when codebase row is missing during approve auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-missing-codebase',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-missing',
      metadata: { approval: { type: 'approval', nodeId: 'review-node', message: 'Approve?' } },
    });
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });
    const getCodebaseMock = codebaseDb.getCodebase as ReturnType<typeof mock>;
    getCodebaseMock.mockReset();
    getCodebaseMock.mockResolvedValueOnce(null);

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(
      workflowApproveCommand(createTestWorkflowHost(), 'run-approve-missing-codebase')
    ).rejects.toThrow(
      "Approved but failed to resume workflow 'implement': Workflow run 'run-approve-missing-codebase' references codebase 'cb-missing', but that codebase no longer exists"
    );
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/test-worktree',
      expect.any(Function),
      providerRegistry
    );
  });

  it('fails with recorded-approval recovery when getCodebase throws during approve auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-codebase-error',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-bad',
      metadata: { approval: { type: 'approval', nodeId: 'review-node', message: 'Approve?' } },
    });
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });
    const getCodebaseMock = codebaseDb.getCodebase as ReturnType<typeof mock>;
    getCodebaseMock.mockReset();
    getCodebaseMock.mockRejectedValueOnce(new Error('database offline'));

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(
      workflowApproveCommand(createTestWorkflowHost(), 'run-approve-codebase-error')
    ).rejects.toThrow(
      "Approved but failed to resume workflow 'implement': Failed to load codebase 'cb-bad' for workflow run 'run-approve-codebase-error': database offline\n" +
        'Cannot safely discover workflows from the run worktree because project workflow files may be missing.\n' +
        'Fix the codebase lookup problem, then retry.\n' +
        "The approval was recorded. Run 'bun run cli workflow resume run-approve-codebase-error' to retry."
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-bad' }),
      'cli.workflow_approve_codebase_lookup_failed'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-approve-codebase-error' }),
      'cli.workflow_approve_resume_failed'
    );
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/test-worktree',
      expect.any(Function),
      providerRegistry
    );
  });

  it('should pass original platform conversation ID through to workflowRunCommand', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const conversationsDb = await import('@archon/core/db/conversations');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      origin: { conversationId: 'db-uuid-original' },
      id: 'run-approve-conv',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-existing',
      conversation_id: 'db-uuid-original',
      metadata: { approval: { nodeId: 'review-node', message: 'Approve?' } },
    });

    // Return a conversation with the original platform ID
    (conversationsDb.getConversationById as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'db-uuid-original',
      platform_type: 'cli',
      platform_conversation_id: 'cli-original-123',
    });

    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'implement' })],
      errors: [],
    });

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-existing',
      name: 'owner/repo',
      default_cwd: '/path/to/main-checkout',
    });

    // Clear call history before our test so we can assert precisely
    (conversationsDb.getOrCreateConversation as ReturnType<typeof mock>).mockClear();

    try {
      await workflowApproveCommand(createTestWorkflowHost(), 'run-approve-conv');
    } catch {
      // downstream failure is acceptable — we only need to reach getOrCreateConversation
    }

    // Verify the original platform conversation ID was passed through
    expect(conversationsDb.getConversationById).toHaveBeenCalledWith('db-uuid-original');
    expect(conversationsDb.getOrCreateConversation).not.toHaveBeenCalled();
  });

  it('should discover workflows from codebase.default_cwd, not working_path', async () => {
    // Regression test for #1663: auto-resume after approve must look up the
    // workflow YAML in the source repo (codebase.default_cwd), not the
    // worktree/workspace working_path that may lack the file.
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-1663',
      workflow_name: 'my-approval-workflow',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-with-yaml',
      metadata: { approval: { nodeId: 'gate', message: 'Approve?' } },
    });

    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-with-yaml',
      name: 'owner/repo',
      default_cwd: '/users/me/source-repo-with-yaml',
    });

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowApproveCommand(createTestWorkflowHost(), 'run-approve-1663');
    } catch {
      // downstream failure is acceptable
    }

    expect(discoverSpy).toHaveBeenCalledWith(
      '/users/me/source-repo-with-yaml',
      expect.any(Function),
      providerRegistry
    );
  });
});

describe('workflowAbandonCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockRequestDetachedRunStop.mockReset();
    mockRequestDetachedRunStop.mockImplementation(noOwnerAnswers);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when run not found', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowAbandonCommand(createTestWorkflowHost(), 'missing-id')).rejects.toThrow(
      'Workflow run not found: missing-id'
    );
  });

  it('should throw when run is not abandonable', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'test',
      status: 'completed',
    });

    await expect(workflowAbandonCommand(createTestWorkflowHost(), 'run-1')).rejects.toThrow(
      "Cannot abandon run with status 'completed'"
    );
  });

  it('should abandon a running workflow', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'running',
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });

    await workflowAbandonCommand(createTestWorkflowHost(), 'run-1');

    expect(workflowDb.cancelWorkflowRun).toHaveBeenCalledWith('run-1', {
      cancel_reason: 'operator',
    });
    expect(consoleSpy).toHaveBeenCalledWith('Abandoned workflow run: run-1');
  });

  for (const json of [false, true]) {
    it(`reports container reclaim failure in ${json ? 'JSON' : 'text'} output`, async () => {
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-1',
        workflow_name: 'implement',
        status: 'paused',
        metadata: { isolation: 'container', isolation_env_id: 'env-a' },
      });
      (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        cancelled: true,
      });
      mockReclaimContainerEnv.mockRejectedValueOnce(new Error('docker down'));
      const stdout = spyOnJsonStdout();
      try {
        await workflowAbandonCommand(createTestWorkflowHost(), 'run-1', json);
        const output = json
          ? stdout.mock.calls.map((call: unknown[]) => String(call[0])).join('')
          : consoleSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
        expect(output).toContain('Could not reclaim container environment env-a');
        expect(output).toContain('resources may remain allocated');
        if (json) expect(JSON.parse(output).cleanupWarnings).toHaveLength(1);
      } finally {
        stdout.mockRestore();
      }
    });
  }

  it('stops a live owner before recording cancelled and says so', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const order: string[] = [];
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'running',
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockImplementation(async () => {
      order.push('cancel-state');
      return { cancelled: true };
    });
    mockRequestDetachedRunStop.mockImplementationOnce(async () => ({
      pid: 42,
      stop: async () => {
        order.push('terminate');
        return { warnings: [] };
      },
      release: mockDetachedTargetRelease,
    }));

    await workflowAbandonCommand(createTestWorkflowHost(), 'run-1');

    expect(order).toEqual(['terminate', 'cancel-state']);
    expect(consoleSpy).toHaveBeenCalledWith("Stopped the run's live owner process (pid 42) first.");
    expect(consoleSpy).toHaveBeenCalledWith('Abandoned workflow run: run-1');
  });

  it('prints the recorded owner facts when no owner answers', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'running',
      last_activity_at: new Date('2026-09-20T10:00:00.000Z'),
      metadata: { execution_owner: { host: 'build-box', pid: 4242 } },
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });

    await workflowAbandonCommand(createTestWorkflowHost(), 'run-1');

    const printed = (consoleSpy.mock.calls as unknown[][]).map(call => String(call[0]));
    expect(printed).toContain('Recorded owner: host build-box, pid 4242.');
    expect(printed).toContain('Last activity: 2026-09-20T10:00:00.000Z.');
    expect(printed.some(line => line.startsWith('The recorded owner is on another host'))).toBe(
      true
    );
    // The facts come before the cancellation line.
    expect(printed.indexOf('Recorded owner: host build-box, pid 4242.')).toBeLessThan(
      printed.indexOf('Abandoned workflow run: run-1')
    );
  });

  it('fails with the reason and leaves the run when the owner cannot be stopped', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'running',
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockClear();
    mockRequestDetachedRunStop.mockImplementationOnce(async () => ({
      pid: 42,
      stop: () => Promise.reject(new Error('process still exists')),
      release: mockDetachedTargetRelease,
    }));

    await expect(workflowAbandonCommand(createTestWorkflowHost(), 'run-1')).rejects.toThrow(
      'Could not stop the live owner of run run-1 (pid 42): process still exists. The run was not changed.'
    );
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('workflowCancelCommand', () => {
  const runId = '12345678-1234-1234-1234-123456789abc';
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    mockRequestDetachedRunStop.mockReset();
    mockRequestDetachedRunStop.mockResolvedValue({
      pid: 4242,
      stop: mockDetachedTargetStop,
      release: mockDetachedTargetRelease,
    });
    mockDetachedTargetStop.mockReset();
    mockDetachedTargetStop.mockResolvedValue({ warnings: [] });
    mockDetachedTargetRelease.mockClear();
    mockReclaimContainerEnv.mockReset();
    mockReclaimContainerEnv.mockResolvedValue();

    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      cancelled: true,
    });
    (workflowDb.findChildRuns as ReturnType<typeof mock>).mockReset();
    (workflowDb.findChildRuns as ReturnType<typeof mock>).mockResolvedValue([]);
    (isolationDb.getById as ReturnType<typeof mock>).mockReset();
    (isolationDb.getById as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('stops the live process tree before recording cancellation', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const order: string[] = [];
    const row = { id: runId, workflow_name: 'implement', status: 'running' };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue(row);
    mockRequestDetachedRunStop.mockImplementation(async () => {
      order.push('owner');
      return {
        pid: 4242,
        stop: async () => {
          order.push('terminate');
          return { warnings: [] };
        },
        release: mockDetachedTargetRelease,
      };
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockImplementation(async () => {
      order.push('cancel-state');
      return { cancelled: true };
    });

    await workflowCancelCommand(createTestWorkflowHost(), runId);

    expect(order).toEqual(['owner', 'terminate', 'cancel-state']);
    expect(mockRequestDetachedRunStop).toHaveBeenCalledWith(runId);
    expect(consoleSpy).toHaveBeenCalledWith('Run owner stopped before run state was changed.');
  });

  it('leaves run state unchanged when no live detached owner answers', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
    });
    mockRequestDetachedRunStop.mockRejectedValue(
      new Error('No live detached owner; run unchanged')
    );

    const exitCode = await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(exitCode).toBe(1);
    expect(mockDetachedTargetStop).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      runId,
      action: 'cancel',
      error: 'No live detached owner; run unchanged',
    });
  });

  it('leaves run state unchanged when process-tree termination fails', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
    });
    mockDetachedTargetStop.mockRejectedValue(new Error('process still exists'));

    const exitCode = await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(exitCode).toBe(1);

    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining('(pid 4242): process still exists. The run was not changed.'),
    });
  });

  it('confirms container teardown before recording cancellation', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    const order: string[] = [];
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      metadata: { isolation: 'container', isolation_env_id: 'container-env-1' },
    });
    (isolationDb.getById as ReturnType<typeof mock>).mockResolvedValue({
      id: 'container-env-1',
      provider: 'container',
    });
    mockDetachedTargetStop.mockImplementation(async () => {
      order.push('terminate-owner');
      return { warnings: [] };
    });
    mockReclaimContainerEnv.mockImplementation(async (): Promise<void> => {
      order.push('reclaim-container');
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockImplementation(
      async (): Promise<{ cancelled: boolean }> => {
        order.push('cancel-state');
        return { cancelled: true };
      }
    );

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(order).toEqual([
      'terminate-owner',
      'reclaim-container',
      'cancel-state',
      'reclaim-container',
    ]);
    expect(mockReclaimContainerEnv).toHaveBeenCalledTimes(2);
    expect(mockReclaimContainerEnv).toHaveBeenCalledWith(
      'container-env-1',
      expect.objectContaining({ getById: expect.any(Function) })
    );
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: true,
      processStopped: true,
      status: 'cancelled',
    });
  });

  it('leaves state unchanged when container teardown cannot be confirmed', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      metadata: { isolation: 'container', isolation_env_id: 'container-env-1' },
    });
    (isolationDb.getById as ReturnType<typeof mock>).mockResolvedValue({
      id: 'container-env-1',
      provider: 'container',
    });
    mockReclaimContainerEnv.mockRejectedValue(new Error('docker daemon unavailable'));

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining(
        'isolation container could not be confirmed stopped. Run state was not changed'
      ),
    });
  });

  it('does not stop the owner when container tracking is unavailable', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      metadata: { isolation: 'container', isolation_env_id: 'missing-env' },
    });
    (isolationDb.getById as ReturnType<typeof mock>).mockResolvedValue(null);

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining('Cannot confirm the isolation container'),
    });
  });

  it('does not stop the owner when a container run has no tracking ID', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      metadata: { isolation: 'container' },
    });

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(isolationDb.getById).not.toHaveBeenCalled();
    expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining('container tracking ID is missing'),
    });
  });

  it('does not report cancellation when the state transition loses a race', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
      .mockResolvedValueOnce({
        id: runId,
        workflow_name: 'implement',
        status: 'running',
      })
      .mockResolvedValueOnce({
        id: runId,
        workflow_name: 'implement',
        status: 'completed',
      });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      cancelled: false,
    });

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(mockDetachedTargetStop).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining(
        'The run status is completed; it was not reported as cancelled'
      ),
    });
  });

  it('refuses a non-running run without contacting a process owner', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'cancelled',
    });

    await expect(workflowCancelCommand(createTestWorkflowHost(), runId)).rejects.toThrow(
      "Cannot cancel run with status 'cancelled'"
    );
    expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
  });

  it('points at abandon, with the recorded owner facts, when no owner answers', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      last_activity_at: null,
      metadata: { execution_owner: { host: 'build-box', pid: 4242 } },
    });
    mockRequestDetachedRunStop.mockImplementation(noOwnerAnswers);

    await workflowCancelCommand(createTestWorkflowHost(), runId, true);

    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    const { error } = JSON.parse(firstJsonPayload(stdoutSpy)) as { error: string };
    expect(error).toContain('Recorded owner: host build-box, pid 4242.');
    expect(error).toContain(`Abandon it: archon workflow abandon ${runId}`);
  });

  it.each([true, false])(
    'cooperative sub-run cancellation preserves warnings (json=%s)',
    async json => {
      const workflowDb = require('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
        id: runId,
        workflow_name: 'implement',
        status: 'running',
        parent_run_id: 'root-run',
      });
      (workflowDb.getRunAncestry as ReturnType<typeof mock>).mockResolvedValueOnce([
        { id: 'root-run', status: 'running', parent_run_id: null },
      ]);
      mockRequestDetachedRunStop.mockImplementation(noOwnerAnswers);
      mockIsRunOwnerAnswering.mockResolvedValueOnce(true);

      await workflowCancelCommand(createTestWorkflowHost(), runId, json);

      expect(mockRequestDetachedRunStop).toHaveBeenCalledWith(runId);
      expect(mockIsRunOwnerAnswering).toHaveBeenCalledWith('root-run');
      // Cooperative cancellation reports possible host-command leftovers only on POSIX hosts.
      const posixHost = process.platform !== 'win32';
      if (json) {
        const payload = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
        expect(payload).toMatchObject({ ok: true, status: 'cancelled', processStopped: false });
        expect(payload.cleanupWarnings).toEqual(
          posixHost ? [expect.stringContaining('untracked background work')] : undefined
        );
      } else {
        expect(consoleSpy.mock.calls.flat().join(' ').includes('untracked background work')).toBe(
          posixHost
        );
      }
    }
  );
});

describe('workflowRejectCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when run not found', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowRejectCommand(createTestWorkflowHost(), 'missing-id')).rejects.toThrow();
  });

  it('should throw when run is not paused', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'my-wf',
      status: 'running',
      metadata: {},
    });

    await expect(workflowRejectCommand(createTestWorkflowHost(), 'run-1')).rejects.toThrow(
      'Cannot reject run'
    );
  });

  it('cancels immediately when no on_reject configured', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-plain',
      workflow_name: 'plain-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: { approval: { type: 'approval', nodeId: 'gate', message: 'Approve?' } },
    });
    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });

    await workflowRejectCommand(createTestWorkflowHost(), 'run-plain', 'not good');

    // Terminal reject resolves + cancels atomically (#2113); the audit event
    // rides the same transaction (#2146).
    expect(workflowDb.resolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-plain',
      [
        {
          event_type: 'approval_received',
          step_name: 'gate',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            reason: 'not good',
          },
        },
      ],
      { step_name: 'gate', reason: 'approval_rejected' },
      undefined
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rejected and cancelled'));
  });

  for (const json of [false, true]) {
    it(`reports a failed container reclaim after a cancelling reject in ${json ? 'JSON' : 'text'} output`, async () => {
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-plain',
        workflow_name: 'plain-wf',
        status: 'paused',
        working_path: '/repo',
        metadata: {
          approval: { type: 'approval', nodeId: 'gate', message: 'Approve?' },
          isolation: 'container',
          isolation_env_id: 'env-a',
          execution_owner: { host: hostname(), pid: process.pid, uid: process.getuid?.() },
        },
      });
      mockReclaimContainerEnv.mockRejectedValueOnce(new Error('docker down'));
      const stdout = spyOnJsonStdout();
      try {
        await workflowRejectCommand(createTestWorkflowHost(), 'run-plain', 'not good', json);
        const output = json
          ? stdout.mock.calls.map((call: unknown[]) => String(call[0])).join('')
          : consoleSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
        expect(output).toContain('Could not reclaim container environment env-a');
        if (json) {
          expect(JSON.parse(output)).toMatchObject({ ok: true, cancelled: true });
          expect(JSON.parse(output).cleanupWarnings).toHaveLength(1);
        } else {
          expect(output).toContain('Rejected and cancelled: plain-wf');
        }
      } finally {
        stdout.mockRestore();
      }
    });
  }

  it('plain mode: rejecting with no reason defaults structured output text to "Rejected" (#2740)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-new-mode',
      workflow_name: 'new-mode-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });

    try {
      await workflowRejectCommand(createTestWorkflowHost(), 'run-new-mode');
    } catch {
      // A new-mode reject stays resumable and auto-resumes inline; the
      // downstream workflowRunCommand failure (no workflow discovered in this
      // unit test's fake cwd) is acceptable here — this test only cares about
      // what was recorded before that point.
    }

    // No `reason` argument at all — rejectWorkflow records the 'Rejected'
    // default on the new-mode structured output (#2740).
    const structuredOutput = { decision: 'reject', text: 'Rejected' };
    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-new-mode',
      {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
          resolved: 'rejected',
          answeredVia: 'cli',
          answeredAt: expect.any(String),
        },
      },
      [
        {
          event_type: 'node_completed',
          step_name: 'gate',
          data: {
            node_output: JSON.stringify(structuredOutput),
            approval_decision: 'rejected',
            structured_output: structuredOutput,
          },
        },
        {
          event_type: 'approval_received',
          step_name: 'gate',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            reason: 'Rejected',
          },
        },
      ],
      undefined
    );
  });

  it('--json mode: rejecting with no reason defaults structured output text to "Rejected" (#2740)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const jsonStdoutSpy = spyOnJsonStdout();

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-new-mode-json',
      workflow_name: 'new-mode-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });

    await workflowRejectCommand(createTestWorkflowHost(), 'run-new-mode-json', undefined, true);

    const structuredOutput = { decision: 'reject', text: 'Rejected' };
    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-new-mode-json',
      expect.objectContaining({
        approval: expect.objectContaining({ resolved: 'rejected' }),
      }),
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'node_completed',
          step_name: 'gate',
          data: expect.objectContaining({ structured_output: structuredOutput }),
        }),
      ]),
      undefined
    );
    const parsed = JSON.parse(firstJsonPayload(jsonStdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, runId: 'run-new-mode-json', action: 'reject' });
    jsonStdoutSpy.mockRestore();
  });

  it('updates metadata and auto-resumes when on_reject configured and under limit', async () => {
    const workflowDb = await import('@archon/core/db/workflows');

    const runData = {
      id: 'run-on-reject',
      workflow_name: 'my-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);

    try {
      await workflowRejectCommand(createTestWorkflowHost(), 'run-on-reject', 'needs work');
    } catch {
      // downstream workflowRunCommand failure is acceptable in this unit test
    }

    // Stays 'paused' (no status write) — rework staged atomically via the CAS on
    // the approval context (#2075/#2113), with the audit event in the same
    // transaction (#2146)
    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-on-reject',
      {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
          resolved: 'rejected',
          answeredVia: 'cli',
          answeredAt: expect.any(String),
        },
        rejection_reason: 'needs work',
        rejection_count: 1,
      },
      [
        {
          event_type: 'approval_received',
          step_name: 'gate',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            reason: 'needs work',
          },
        },
      ],
      undefined
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rejected workflow'));
  });

  it('should pass original platform conversation ID through on reject-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const conversationsDb = await import('@archon/core/db/conversations');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      origin: { conversationId: 'db-uuid-reject' },
      id: 'run-reject-conv',
      workflow_name: 'my-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      conversation_id: 'db-uuid-reject',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    // rejectWorkflow reads the run twice internally (getRunOrThrow + updateWorkflowRun check)
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);

    // Return a conversation with the original platform ID
    (conversationsDb.getConversationById as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'db-uuid-reject',
      platform_type: 'cli',
      platform_conversation_id: 'cli-reject-456',
    });

    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'my-wf' })],
      errors: [],
    });

    // Clear call history before our test so we can assert precisely
    (conversationsDb.getOrCreateConversation as ReturnType<typeof mock>).mockClear();

    try {
      await workflowRejectCommand(createTestWorkflowHost(), 'run-reject-conv', 'needs work');
    } catch {
      // downstream workflowRunCommand failure is acceptable — we only need to reach getOrCreateConversation
    }

    // Verify the original platform conversation ID was passed through
    expect(conversationsDb.getConversationById).toHaveBeenCalledWith('db-uuid-reject');
    expect(conversationsDb.getOrCreateConversation).not.toHaveBeenCalled();
  });

  it('cancels when max attempts reached', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-max',
      workflow_name: 'my-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 2,
      },
    });
    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });

    await workflowRejectCommand(createTestWorkflowHost(), 'run-max', 'still bad');

    // Terminal reject resolves + cancels atomically (#2113); the audit event
    // rides the same transaction (#2146).
    expect(workflowDb.resolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-max',
      [
        {
          event_type: 'approval_received',
          step_name: 'gate',
          data: {
            via: 'cli',
            occurrence: expect.any(String),
            decision: 'rejected',
            reason: 'still bad',
          },
        },
      ],
      { step_name: 'gate', reason: 'approval_rejected' },
      undefined
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('max attempts reached'));
  });

  it('throws when on_reject configured but working_path is null', async () => {
    const workflowDb = await import('@archon/core/db/workflows');

    const runData = {
      id: 'run-no-path',
      workflow_name: 'my-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: null,
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

    await expect(
      workflowRejectCommand(createTestWorkflowHost(), 'run-no-path', 'bad')
    ).rejects.toThrow('no working path');
  });

  it('should discover workflows from codebase.default_cwd on reject-resume, not working_path', async () => {
    // Regression for #1663: reject with on_reject configured re-invokes
    // workflowRunCommand. Discovery must use the source repo, not the worktree.
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-1663',
      workflow_name: 'my-approval-workflow',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-with-yaml',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-with-yaml',
      name: 'owner/repo',
      default_cwd: '/users/me/source-repo-with-yaml',
    });

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowRejectCommand(createTestWorkflowHost(), 'run-reject-1663', 'needs work');
    } catch {
      // downstream failure is acceptable
    }

    // A continuation takes no new capture, so discovery still reads the codebase source
    // path directly — #1663's guarantee, unchanged.
    expect(discoverSpy).toHaveBeenCalledWith(
      '/users/me/source-repo-with-yaml',
      expect.any(Function),
      providerRegistry
    );
  });

  it('fails loudly when getCodebase throws during reject auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-codebase-error',
      workflow_name: 'my-approval-workflow',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-bad',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    const getCodebaseMock = codebaseDb.getCodebase as ReturnType<typeof mock>;
    getCodebaseMock.mockReset();
    getCodebaseMock.mockRejectedValueOnce(new Error('database offline'));

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(
      workflowRejectCommand(createTestWorkflowHost(), 'run-reject-codebase-error', 'needs work')
    ).rejects.toThrow(
      "Rejected but failed to resume workflow 'my-approval-workflow': Failed to load codebase 'cb-bad' for workflow run 'run-reject-codebase-error'"
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-bad' }),
      'cli.workflow_reject_codebase_lookup_failed'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-reject-codebase-error' }),
      'cli.workflow_reject_resume_failed'
    );
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/worktree-without-yaml',
      expect.any(Function),
      providerRegistry
    );
  });

  it('fails with recorded-rejection recovery when codebase row is missing during reject auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-missing-codebase',
      workflow_name: 'my-approval-workflow',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-missing',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    const getCodebaseMock = codebaseDb.getCodebase as ReturnType<typeof mock>;
    getCodebaseMock.mockReset();
    getCodebaseMock.mockResolvedValueOnce(null);

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(
      workflowRejectCommand(createTestWorkflowHost(), 'run-reject-missing-codebase', 'needs work')
    ).rejects.toThrow(
      "Rejected but failed to resume workflow 'my-approval-workflow': Workflow run 'run-reject-missing-codebase' references codebase 'cb-missing', but that codebase no longer exists.\n" +
        'Cannot safely discover workflows from the run worktree because project workflow files may be missing.\n' +
        'Re-register the project or restore the codebase row, then retry.\n' +
        "The rejection was recorded. Run 'bun run cli workflow resume run-reject-missing-codebase' to retry."
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-reject-missing-codebase' }),
      'cli.workflow_reject_resume_failed'
    );
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/worktree-without-yaml',
      expect.any(Function),
      providerRegistry
    );
  });

  it('should fall back to working_path for discovery on reject when codebase_id is missing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-no-codebase',
      workflow_name: 'legacy',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/old-worktree',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowRejectCommand(createTestWorkflowHost(), 'run-reject-no-codebase', 'bad');
    } catch {
      // downstream failure is acceptable
    }

    // No codebase → falls back to working_path (preserves existing behavior)
    expect(discoverSpy).toHaveBeenCalledWith(
      '/tmp/old-worktree',
      expect.any(Function),
      providerRegistry
    );
  });
});

// #2707 step 2 — the general drive verb. `approve`/`reject` are sugar (delegated
// directly to the existing commands); any other decision resolves through the new
// declared-decision path.
describe('workflowRespondCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it.each([
    ['approve', false],
    ['reject', false],
    ['approve', true],
    ['reject', true],
  ] as const)('refuses undeclared %s through commands (detach=%s)', async (decision, detach) => {
    const workflowDb = await import('@archon/core/db/workflows');
    const run = {
      id: 'run-undeclared',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Choose',
          decisions: [{ id: 'accept' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue(run);
    const resolve = workflowDb.resolveApprovalGate as ReturnType<typeof mock>;
    const cancel = workflowDb.resolveAndCancelApprovalGate as ReturnType<typeof mock>;
    resolve.mockClear();
    cancel.mockClear();
    const host = createTestWorkflowHost();
    const dedicated = decision === 'approve' ? workflowApproveCommand : workflowRejectCommand;
    for (const respond of [
      () => dedicated(host, run.id, 'feedback', false, undefined, detach),
      () => workflowRespondCommand(host, run.id, decision, 'feedback', false, undefined, detach),
    ]) {
      await expect(respond()).rejects.toThrow(
        `does not declare decision '${decision}'. Declared decisions: accept, revise.`
      );
      expect(run.status).toBe('paused');
      expect(resolve).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['approve', false],
    ['reject', false],
    ['revise', false],
    ['approve', true],
    ['reject', true],
    ['revise', true],
  ] as const)(
    'refuses a stale --occurrence for %s before acknowledging anything (detach=%s)',
    async (decision, detach) => {
      const workflowDb = await import('@archon/core/db/workflows');
      const run = {
        id: 'run-stale-occurrence',
        workflow_name: 'guided',
        status: 'paused',
        user_message: 'go',
        working_path: '/repo',
        codebase_id: null,
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'gate',
            pauseId: 'pause-two',
            message: 'Choose',
            decisions: [{ id: 'approve' }, { id: 'reject' }, { id: 'revise' }],
            decisionsAuthored: true,
          },
        },
      };
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue(run);
      const resolve = workflowDb.resolveApprovalGate as ReturnType<typeof mock>;
      const cancel = workflowDb.resolveAndCancelApprovalGate as ReturnType<typeof mock>;
      resolve.mockClear();
      cancel.mockClear();
      await expect(
        workflowRespondCommand(
          createTestWorkflowHost(),
          run.id,
          decision,
          'feedback',
          false,
          undefined,
          detach,
          'pause-one'
        )
      ).rejects.toThrow("It is now awaiting occurrence 'pause-two'.");
      expect(resolve).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    }
  );

  it("delegates 'approve' to the exact same resolution as workflowApproveCommand", async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-approve',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });

    try {
      await workflowRespondCommand(
        createTestWorkflowHost(),
        'run-respond-approve',
        'approve',
        'looks good'
      );
    } catch {
      // downstream workflowRunCommand failure is acceptable in this unit test
    }

    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-respond-approve',
      expect.objectContaining({
        approval: expect.objectContaining({ resolved: 'approved' }),
      }),
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'node_completed',
          data: expect.objectContaining({
            structured_output: { decision: 'approve', text: 'looks good' },
          }),
        }),
      ]),
      undefined
    );
  });

  it('resolves a declared non-default decision with the caller-supplied id', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-revise',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });

    try {
      await workflowRespondCommand(
        createTestWorkflowHost(),
        'run-respond-revise',
        'revise',
        'needs more detail'
      );
    } catch {
      // downstream workflowRunCommand failure is acceptable in this unit test
    }

    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-respond-revise',
      expect.objectContaining({ approval_response: 'revise' }),
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'node_completed',
          data: expect.objectContaining({
            structured_output: { decision: 'revise', text: 'needs more detail' },
          }),
        }),
      ]),
      undefined
    );
  });

  it('rejects a decision the gate does not declare, naming the actual options', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-invalid',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });
    const resolveGateSpy = workflowDb.resolveApprovalGate as ReturnType<typeof mock>;
    resolveGateSpy.mockClear();

    await expect(
      workflowRespondCommand(
        createTestWorkflowHost(),
        'run-respond-invalid',
        'escalate',
        'not sure'
      )
    ).rejects.toThrow(/does not declare decision 'escalate'.*approve, revise/s);

    expect(resolveGateSpy).not.toHaveBeenCalled();
  });

  it('spells the child-run redirect for the CLI', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-blocked',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'child_workflow',
          nodeId: 'sub',
          message: 'blocked',
          childRunId: 'child-55',
        },
      },
    });

    await expect(
      workflowRespondCommand(
        createTestWorkflowHost(),
        'run-respond-blocked',
        'revise',
        'needs more detail'
      )
    ).rejects.toThrow('Approve it by run id: `archon workflow approve child-55`');
  });

  it('--detach validates read-only via assertRespondable before forking', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-detach',
      workflow_name: 'guided',
      status: 'completed',
      working_path: '/repo',
      metadata: {},
    });
    const spawnSpy = spyOn(Bun, 'spawn');

    try {
      await expect(
        workflowRespondCommand(
          createTestWorkflowHost(),
          'run-respond-detach',
          'revise',
          undefined,
          false,
          undefined,
          true
        )
      ).rejects.toThrow(/Only paused runs can be approved/);
    } finally {
      spawnSpy.mockRestore();
    }
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Signal cleanup guard (#1123) — SIGTERM/SIGINT handlers must be run-scoped,
// status-guarded, and removed once executeWorkflow settles.
// ---------------------------------------------------------------------------
