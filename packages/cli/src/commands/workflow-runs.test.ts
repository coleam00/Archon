import {
  spyOnJsonStdout,
  firstJsonPayload,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock, type Mock } from 'bun:test';
import { workflowRunsCommand } from './workflow-query';
import { NODE_SUMMARY_EVENT_TYPES } from './workflow-node-summaries';

const EMPTY_COUNTS = {
  all: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  pending: 0,
  paused: 0,
};

describe('workflowRunsCommand', () => {
  let consoleSpy: Mock<(...args: unknown[]) => void>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('scopes to the cwd-resolved codebase id', async () => {
    const git = await import('@archon/git');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const canonicalSpy = git.getCanonicalRepoPath as ReturnType<typeof mock>;
    canonicalSpy.mockClear();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-proj',
      name: 'owner/repo',
      default_cwd: '/test/path',
    });
    const listSpy = workflowDb.listDashboardRuns as ReturnType<typeof mock>;
    listSpy.mockClear();
    listSpy.mockResolvedValueOnce({ runs: [], total: 0, counts: EMPTY_COUNTS });

    await workflowRunsCommand(createTestWorkflowHost(), '/test/path', {});

    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-proj', limit: 20 })
    );
    expect(canonicalSpy).not.toHaveBeenCalled();
  });

  it('scopes a linked worktree to its registered primary checkout', async () => {
    const git = await import('@archon/git');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockResolvedValueOnce(
      '/registered/primary'
    );
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'cb-primary',
        name: 'owner/repo',
        default_cwd: '/registered/primary',
        kind: 'repo',
      });
    const listSpy = workflowDb.listDashboardRuns as ReturnType<typeof mock>;
    listSpy.mockClear();
    listSpy.mockResolvedValueOnce({ runs: [], total: 0, counts: EMPTY_COUNTS });

    await workflowRunsCommand(createTestWorkflowHost(), '/workspace/sibling-worktree', {});

    expect(git.getCanonicalRepoPath).toHaveBeenCalledWith('/workspace/sibling-worktree');
    expect(codebaseDb.findCodebaseByDefaultCwd).toHaveBeenCalledWith('/registered/primary');
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-primary', limit: 20 })
    );
    expect(consoleSpy).not.toHaveBeenCalledWith('(not a registered project — showing all runs)');
  });

  it('preserves a codebase registered at the exact linked-worktree path', async () => {
    const git = await import('@archon/git');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const canonicalSpy = git.getCanonicalRepoPath as ReturnType<typeof mock>;
    canonicalSpy.mockClear();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-worktree',
      name: 'owner/repo-worktree',
      default_cwd: '/workspace/registered-worktree',
    });
    const listSpy = workflowDb.listDashboardRuns as ReturnType<typeof mock>;
    listSpy.mockClear();
    listSpy.mockResolvedValueOnce({ runs: [], total: 0, counts: EMPTY_COUNTS });

    await workflowRunsCommand(createTestWorkflowHost(), '/workspace/registered-worktree', {});

    expect(canonicalSpy).not.toHaveBeenCalled();
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-worktree', limit: 20 })
    );
  });

  it('scopes an external-git-dir worktree through its registered Git identity', async () => {
    const git = await import('@archon/git');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const cwd = '/workspace/external-linked';
    const commonGitDir = '/metadata/repository';
    const registered = {
      id: 'cb-external',
      name: 'owner/repo',
      default_cwd: '/workspace/primary',
      kind: 'repo',
    };
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockRejectedValueOnce(
      new git.CanonicalRepoPathUnavailableError(cwd, commonGitDir)
    );
    (git.getGitCheckoutIdentity as ReturnType<typeof mock>)
      .mockResolvedValueOnce({
        gitDir: `${commonGitDir}/worktrees/linked`,
        commonGitDir,
        linkedWorktree: true,
      })
      .mockResolvedValueOnce({
        gitDir: commonGitDir,
        commonGitDir,
        linkedWorktree: false,
      });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.listCodebaseClaims as ReturnType<typeof mock>).mockResolvedValueOnce([registered]);
    const listSpy = workflowDb.listDashboardRuns as ReturnType<typeof mock>;
    listSpy.mockClear();
    listSpy.mockResolvedValueOnce({ runs: [], total: 0, counts: EMPTY_COUNTS });

    await workflowRunsCommand(createTestWorkflowHost(), cwd, {});

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-external', limit: 20 })
    );
  });

  it.each([
    { open: false, json: false },
    { open: false, json: true },
    { open: true, json: false },
    { open: true, json: true },
  ])('refuses to widen scope after a claims lookup failure (%j)', async opts => {
    const git = await import('@archon/git');
    const codebaseDb = await import('@archon/core/db/codebases');
    const host = createTestWorkflowHost();
    const listRuns = spyOn(host.deps.store, 'listWorkflowRuns');
    const listOpen = spyOn(host.deps.store, 'findOpenWorkRuns');
    listRuns.mockClear();
    listOpen.mockClear();
    const failure = new Error('registration storage unavailable');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockRejectedValueOnce(
      new git.CanonicalRepoPathUnavailableError('/workspace/linked', '/metadata/repository')
    );
    (codebaseDb.listCodebaseClaims as ReturnType<typeof mock>).mockRejectedValueOnce(failure);

    try {
      const result = workflowRunsCommand(host, '/workspace/linked', opts);
      if (opts.json) {
        expect(await result).toBe(1);
        expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
          ok: false,
          error: 'Failed to resolve workflow runs project: registration storage unavailable',
        });
      } else {
        await expect(result).rejects.toThrow('Failed to resolve workflow runs project');
        expect(stdoutSpy).not.toHaveBeenCalled();
      }
      expect(listRuns).not.toHaveBeenCalled();
      expect(listOpen).not.toHaveBeenCalled();
    } finally {
      listRuns.mockRestore();
      listOpen.mockRestore();
    }
  });

  it('prints the unregistered-cwd note and lists globally when no codebase resolves', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (workflowDb.listDashboardRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      runs: [],
      total: 0,
      counts: EMPTY_COUNTS,
    });

    await workflowRunsCommand(createTestWorkflowHost(), '/unregistered', {});

    expect(consoleSpy).toHaveBeenCalledWith('(not a registered project — showing all runs)');
  });

  it('emits the full dashboard result as JSON', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (workflowDb.listDashboardRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      runs: [
        {
          id: 'r1',
          workflow_name: 'assist',
          status: 'completed',
          outcome: 'failed',
          active_nodes: ['parallel-a', 'parallel-b'],
          current_step_name: null,
          total_steps: null,
          started_at: new Date(),
        },
      ],
      total: 1,
      counts: { ...EMPTY_COUNTS, all: 1, completed: 1 },
    });

    await workflowRunsCommand(createTestWorkflowHost(), '/test/path', { json: true });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      runs: Array<{ status: string; outcome: string | null; active_nodes: string[] }>;
      total: number;
      scopeFallback: boolean;
    };
    expect(parsed.total).toBe(1);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]).toMatchObject({ status: 'completed', outcome: 'failed' });
    expect(parsed.runs[0]?.active_nodes).toEqual(['parallel-a', 'parallel-b']);
    // codebase did not resolve → result is a global fallback, flagged for agents
    expect(parsed.scopeFallback).toBe(true);
  });

  it('shows authored outcome separately in the human run list', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-proj',
      name: 'owner/repo',
      default_cwd: '/test/path',
    });
    (workflowDb.listDashboardRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      runs: [
        {
          id: 'r1-contradictory',
          workflow_name: 'review',
          status: 'completed',
          outcome: 'failed',
          active_nodes: ['parallel-a', 'parallel-b'],
          current_step_name: null,
          total_steps: null,
          started_at: new Date(),
        },
      ],
      total: 1,
      counts: { ...EMPTY_COUNTS, all: 1, completed: 1 },
    });

    await workflowRunsCommand(createTestWorkflowHost(), '/test/path');

    const output = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(output).toContain('completed');
    expect(output).toContain('authored outcome: failed');
    expect(output).toContain('active node(s): parallel-a, parallel-b');
  });

  it('marks scopeFallback false in --json when the project scope resolves', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-proj',
      name: 'owner/repo',
      default_cwd: '/test/path',
    });
    (workflowDb.listDashboardRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      runs: [],
      total: 0,
      counts: EMPTY_COUNTS,
    });

    await workflowRunsCommand(createTestWorkflowHost(), '/test/path', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as { scopeFallback: boolean };
    expect(parsed.scopeFallback).toBe(false);
  });

  it('passes --all (no codebase scope) plus --status/--limit through to listDashboardRuns', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const findSpy = codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>;
    findSpy.mockClear();
    const listSpy = workflowDb.listDashboardRuns as ReturnType<typeof mock>;
    listSpy.mockClear();
    listSpy.mockResolvedValueOnce({ runs: [], total: 0, counts: EMPTY_COUNTS });

    await workflowRunsCommand(createTestWorkflowHost(), '/test/path', {
      all: true,
      status: 'running',
      limit: 5,
    });

    // --all skips the codebase lookup entirely
    expect(findSpy).not.toHaveBeenCalled();
    const arg = listSpy.mock.calls[0][0] as { codebaseId?: string; status?: string; limit: number };
    expect(arg.codebaseId).toBeUndefined();
    expect(arg.status).toBe('running');
    expect(arg.limit).toBe(5);
  });

  it('throws on an invalid --status', async () => {
    await expect(
      workflowRunsCommand(createTestWorkflowHost(), '/test/path', { status: 'bogus' })
    ).rejects.toThrow(/Invalid --status 'bogus'/);
  });

  describe('--json --verbose', () => {
    const graph = { terminal_graph: { node_ids: ['plan', 'approve', 'ship'] } };
    const listed = {
      runs: [
        {
          id: 'run-gate',
          workflow_name: 'ship',
          status: 'paused',
          metadata: { ...graph, approval: { nodeId: 'approve', message: 'Ship it?' } },
          completed_at: null,
          active_nodes: [],
          started_at: '2026-09-27T10:00:00.000Z',
        },
        {
          id: 'run-wait',
          workflow_name: 'ship',
          status: 'paused',
          metadata: {
            wait: {
              owner: 'node',
              nodeId: 'plan',
              kind: 'attention',
              waitingSince: '2026-09-27T09:00:01.000Z',
              message: 'Check the plan',
            },
          },
          completed_at: null,
          active_nodes: [],
          started_at: '2026-09-27T09:00:00.000Z',
        },
      ],
      total: 2,
      counts: { ...EMPTY_COUNTS, all: 2, paused: 2 },
    };
    const planCompleted = {
      id: 'e1',
      workflow_run_id: 'run-gate',
      event_type: 'node_completed',
      step_name: 'plan',
      step_index: 0,
      data: {},
      created_at: '2026-09-27T10:00:01.000Z',
    };

    async function listOnce(): Promise<
      Mock<(ids: readonly string[], types: readonly string[]) => Promise<unknown>>
    > {
      const workflowDb = await import('@archon/core/db/workflows');
      const eventsDb = await import('@archon/core/db/workflow-events');
      (workflowDb.listDashboardRuns as ReturnType<typeof mock>).mockResolvedValueOnce(
        structuredClone(listed)
      );
      const eventsSpy = eventsDb.listEventsForRuns as unknown as Mock<
        (ids: readonly string[], types: readonly string[]) => Promise<unknown>
      >;
      eventsSpy.mockClear();
      return eventsSpy;
    }

    it('lists every declared node in order, unreached ones pending, from one events query', async () => {
      const eventsSpy = await listOnce();
      eventsSpy.mockResolvedValueOnce(
        new Map([
          ['run-gate', [planCompleted]],
          ['run-wait', []],
        ])
      );

      await workflowRunsCommand(createTestWorkflowHost(), '/test/path', {
        json: true,
        verbose: true,
      });

      expect(eventsSpy).toHaveBeenCalledTimes(1);
      expect(eventsSpy).toHaveBeenCalledWith(['run-gate', 'run-wait'], NODE_SUMMARY_EVENT_TYPES);
      const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
        runs: Array<{ id: string; nodes: Array<{ nodeId: string; state: string }> }>;
        total: number;
      };
      expect(parsed.total).toBe(2);
      expect(parsed.runs[0]?.nodes.map(node => [node.nodeId, node.state])).toEqual([
        ['plan', 'completed'],
        ['approve', 'pending'],
        ['ship', 'pending'],
      ]);
      // No terminal_graph recorded: only what the events reached, no seeding.
      expect(parsed.runs[1]?.nodes).toEqual([]);
    });

    it("carries each run's attention: a gate awaits a response, an attention wait its answer", async () => {
      const eventsSpy = await listOnce();
      eventsSpy.mockResolvedValueOnce(new Map());

      await workflowRunsCommand(createTestWorkflowHost(), '/test/path', {
        json: true,
        verbose: true,
      });

      const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
        runs: Array<{ attention: Record<string, unknown> | null }>;
      };
      expect(parsed.runs[0]?.attention).toEqual({
        kind: 'awaiting_response',
        runId: 'run-gate',
        respondTo: { runId: 'run-gate', nodeId: 'approve' },
        occurrence: 'legacy:approve',
        message: 'Ship it?',
      });
      expect(parsed.runs[1]?.attention).toEqual({
        kind: 'attention',
        runId: 'run-wait',
        nodeId: 'plan',
        occurrence: 'legacy:plan',
        message: 'Check the plan',
        form: 'message',
        options: [],
      });
    });

    it('fails rather than emit runs without nodes when the events query fails', async () => {
      const eventsSpy = await listOnce();
      eventsSpy.mockRejectedValueOnce(new Error('database is locked'));

      await expect(
        workflowRunsCommand(createTestWorkflowHost(), '/test/path', { json: true, verbose: true })
      ).rejects.toThrow('database is locked');
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it('fails the --open inbox the same way when the events query fails', async () => {
      const workflowDb = await import('@archon/core/db/workflows');
      const eventsDb = await import('@archon/core/db/workflow-events');
      (workflowDb.findOpenWorkRuns as ReturnType<typeof mock>).mockResolvedValueOnce([
        { id: 'run-open', status: 'failed', metadata: {}, completed_at: null },
      ]);
      (eventsDb.listEventsForRuns as ReturnType<typeof mock>).mockRejectedValueOnce(
        new Error('database is locked')
      );

      await expect(
        workflowRunsCommand(createTestWorkflowHost(), '/test/path', {
          json: true,
          verbose: true,
          open: true,
        })
      ).rejects.toThrow('database is locked');
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it('leaves --json without --verbose byte-identical and reads no events', async () => {
      const eventsSpy = await listOnce();

      await workflowRunsCommand(createTestWorkflowHost(), '/test/path', { json: true });

      expect(eventsSpy).not.toHaveBeenCalled();
      expect(firstJsonPayload(stdoutSpy).trimEnd()).toBe(
        JSON.stringify({ ...listed, scopeFallback: true }, null, 2)
      );
    });
  });

  it('reports a run-listing failure as the raw error in --json and a prefixed error otherwise', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const listSpy = workflowDb.listDashboardRuns as ReturnType<typeof mock>;
    listSpy.mockRejectedValueOnce(new Error('db down'));
    listSpy.mockRejectedValueOnce(new Error('db down'));

    const exitCode = await workflowRunsCommand(createTestWorkflowHost(), '/test/path', {
      all: true,
      json: true,
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({ ok: false, error: 'db down' });

    await expect(
      workflowRunsCommand(createTestWorkflowHost(), '/test/path', { all: true })
    ).rejects.toThrow('Failed to list workflow runs: db down');
  });

  it('emits {ok:false} JSON (never throws) on an invalid --status in --json mode', async () => {
    const exitCode = await workflowRunsCommand(createTestWorkflowHost(), '/test/path', {
      status: 'bogus',
      json: true,
    });

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid --status 'bogus'");
  });
});
