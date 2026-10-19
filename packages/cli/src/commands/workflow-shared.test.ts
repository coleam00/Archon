import {
  mockCreateWorkflowEvent,
  mockPersistWorkflowEvent,
  mockRequestDetachedRunStop,
  noOwnerAnswers,
  spyOnJsonStdout,
  firstJsonPayload,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import {
  workflowGetCommand,
  workflowResumeCommand,
  workflowAbandonCommand,
  workflowApproveCommand,
  workflowRejectCommand,
  workflowEventEmitCommand,
} from './workflow';
import { workflowRunCommand } from './workflow-run-owned';

describe('run-id prefix resolution (short ids from `workflow runs`)', () => {
  const FULL_ID = '0b1ee8da-1111-2222-3333-444455556666';
  const CODEBASE = { id: 'cb-1', name: 'proj', default_cwd: '/repo', kind: 'repo' };
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockClear();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockClear();
    mockCreateWorkflowEvent.mockClear();
    mockPersistWorkflowEvent.mockClear();
    mockRequestDetachedRunStop.mockReset();
    mockRequestDetachedRunStop.mockImplementation(noOwnerAnswers);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('resolves a unique short prefix to the full run id (get)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: FULL_ID,
      workflow_name: 'implement',
      status: 'completed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });

    const code = await workflowGetCommand(
      createTestWorkflowHost(),
      '0b1ee8da',
      true,
      undefined,
      '/repo'
    );

    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-1');
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(FULL_ID);
    expect(code).toBe(0);
  });

  it('skips codebase and prefix lookups entirely for a full UUID', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: FULL_ID,
      workflow_name: 'implement',
      status: 'completed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });

    const code = await workflowGetCommand(
      createTestWorkflowHost(),
      FULL_ID,
      true,
      undefined,
      '/repo'
    );

    expect(codebaseDb.findCodebaseByDefaultCwd).not.toHaveBeenCalled();
    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(FULL_ID);
    expect(code).toBe(0);
  });

  it('skips lookups for a 32-char undashed full id (SQLite id shape)', async () => {
    const undashedId = 'e1f890f05e5bab0d906921593bf500c4';
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: undashedId,
      workflow_name: 'implement',
      status: 'completed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });

    const code = await workflowGetCommand(
      createTestWorkflowHost(),
      undashedId,
      true,
      undefined,
      '/repo'
    );

    expect(codebaseDb.findCodebaseByDefaultCwd).not.toHaveBeenCalled();
    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(undashedId);
    expect(code).toBe(0);
  });

  it('throws on an ambiguous prefix (human mode)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await expect(
      workflowResumeCommand(createTestWorkflowHost(), '0b1ee8da', undefined, '/repo')
    ).rejects.toThrow(
      '0b1ee8da-1111-2222-3333-444455556666\n  0b1ee8da-9999-8888-7777-666655554444'
    );
  });

  it('emits {ok:false} JSON on an ambiguous prefix (never throws in --json)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await workflowAbandonCommand(createTestWorkflowHost(), '0b1ee8da', true, '/repo');

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      runId: string;
      action: string;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.runId).toBe('0b1ee8da');
    expect(parsed.action).toBe('abandon');
    expect(parsed.error).toContain('matches more than one run');
  });

  it('passes the id through unchanged when cwd is not a registered project', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const code = await workflowGetCommand(
      createTestWorkflowHost(),
      'deadbeef',
      true,
      undefined,
      '/somewhere'
    );

    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith('deadbeef');
    expect(code).toBe(1);
  });

  it('passes the id through when the prefix matches nothing in this project', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const code = await workflowGetCommand(
      createTestWorkflowHost(),
      'deadbeef',
      true,
      undefined,
      '/repo'
    );

    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith('deadbeef');
    expect(code).toBe(1);
  });

  it('abandons by short prefix and reports the resolved full id', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: FULL_ID,
      workflow_name: 'implement',
      status: 'running',
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });

    await workflowAbandonCommand(createTestWorkflowHost(), '0b1ee8da', true, '/repo');

    expect(workflowDb.cancelWorkflowRun).toHaveBeenCalledWith(FULL_ID, {
      cancel_reason: 'operator',
    });
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      runId: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.runId).toBe(FULL_ID);
  });

  it('approves by short prefix and reports the resolved full id', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      origin: { conversationId: 'conv' },
      id: FULL_ID,
      workflow_name: 'implement',
      status: 'paused',
      working_path: '/tmp/wt',
      codebase_id: 'cb',
      conversation_id: 'conv',
      user_message: 'go',
      metadata: { approval: { nodeId: 'gate', message: 'ok?' } },
    });

    await workflowApproveCommand(createTestWorkflowHost(), '0b1ee8da', 'lgtm', true, '/repo');

    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(FULL_ID);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, runId: FULL_ID, action: 'approve' });
  });

  it('rejects by short prefix and reports the resolved full id', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      origin: { conversationId: 'conv' },
      id: FULL_ID,
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

    await workflowRejectCommand(createTestWorkflowHost(), '0b1ee8da', 'nope', true, '/repo');

    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(FULL_ID);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      runId: FULL_ID,
      action: 'reject',
      cancelled: true,
    });
  });

  it('emits an event using the resolved full run id', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);

    await workflowEventEmitCommand(
      createTestWorkflowHost(),
      '0b1ee8da',
      'workflow_started',
      undefined,
      '/repo'
    );

    expect(mockCreateWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: FULL_ID,
      event_type: 'workflow_started',
      data: undefined,
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      `Event submitted (best-effort): workflow_started for run ${FULL_ID}`
    );
  });

  it('validates and persists checkout-sharing events before reporting success', async () => {
    const data = {
      parent_run_id: 'parent',
      parent_node_id: 'work',
      working_path: '/repo',
      sibling_run_id: 'peer',
    };
    await workflowEventEmitCommand(
      createTestWorkflowHost(),
      FULL_ID,
      'workflow.checkout_shared',
      data
    );
    expect(mockPersistWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: FULL_ID,
      event_type: 'workflow.checkout_shared',
      data,
    });
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      `Event persisted: workflow.checkout_shared for run ${FULL_ID}`
    );
  });

  it('rejects incomplete checkout-sharing data before any write', async () => {
    await expect(
      workflowEventEmitCommand(createTestWorkflowHost(), FULL_ID, 'workflow.checkout_shared', {})
    ).rejects.toThrow();
    expect(mockPersistWorkflowEvent).not.toHaveBeenCalled();
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('propagates checkout-sharing persistence failure without reporting success', async () => {
    mockPersistWorkflowEvent.mockRejectedValueOnce(new Error('sharing INSERT rejected'));
    await expect(
      workflowEventEmitCommand(createTestWorkflowHost(), FULL_ID, 'workflow.checkout_shared', {
        parent_run_id: 'parent',
        parent_node_id: 'work',
        working_path: '/repo',
        sibling_run_id: 'peer',
      })
    ).rejects.toThrow('sharing INSERT rejected');
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it.each(['node_completed', 'node_deferred_usage'] as const)(
    'persists %s before reporting success',
    async eventType => {
      const data = { node_output: 'done' };
      await workflowEventEmitCommand(createTestWorkflowHost(), FULL_ID, eventType, data);
      expect(mockPersistWorkflowEvent).toHaveBeenCalledWith({
        workflow_run_id: FULL_ID,
        event_type: eventType,
        data,
      });
      expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(`Event persisted: ${eventType} for run ${FULL_ID}`);
    }
  );

  it.each(['node_failed', 'node_deferred_usage'] as const)(
    'propagates %s persistence failure without reporting success',
    async eventType => {
      mockPersistWorkflowEvent.mockRejectedValueOnce(new Error('database unavailable'));
      await expect(
        workflowEventEmitCommand(createTestWorkflowHost(), FULL_ID, eventType, {
          error: 'producer failed',
        })
      ).rejects.toThrow('database unavailable');
      expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
      expect(consoleSpy).not.toHaveBeenCalled();
    }
  );

  it('resolves an event prefix from a workspace-scoped worktree', async () => {
    const git = await import('@archon/git');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockResolvedValueOnce('/canonical/repo');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(CODEBASE);
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);

    await workflowEventEmitCommand(
      createTestWorkflowHost(),
      '0b1ee8da',
      'workflow_started',
      undefined,
      '/home/test/.archon/workspaces/owner/proj/worktrees/archon/task-2611'
    );

    expect(codebaseDb.findCodebaseByDefaultCwd).toHaveBeenCalledWith('/canonical/repo');
    expect(mockCreateWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: FULL_ID,
      event_type: 'workflow_started',
      data: undefined,
    });
  });

  it('resolves an event prefix from an exact registered linked worktree', async () => {
    const git = await import('@archon/git');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const canonicalSpy = git.getCanonicalRepoPath as ReturnType<typeof mock>;
    canonicalSpy.mockClear();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);

    await workflowEventEmitCommand(
      createTestWorkflowHost(),
      '0b1ee8da',
      'workflow_started',
      undefined,
      '/workspace/registered-worktree'
    );

    expect(canonicalSpy).not.toHaveBeenCalled();
    expect(mockCreateWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: FULL_ID,
      event_type: 'workflow_started',
      data: undefined,
    });
  });

  it('rejects an unmatched event prefix before creating an event', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([]);

    await expect(
      workflowEventEmitCommand(
        createTestWorkflowHost(),
        'deadbeef',
        'workflow_started',
        undefined,
        '/repo'
      )
    ).rejects.toThrow("No workflow run matches prefix 'deadbeef' in this project.");
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  });

  it('rejects an event prefix outside a registered project before creating an event', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowEventEmitCommand(
        createTestWorkflowHost(),
        'deadbeef',
        'workflow_started',
        undefined,
        '/unregistered'
      )
    ).rejects.toThrow("Cannot resolve run id prefix 'deadbeef' outside a registered project.");
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous event prefix before creating an event', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await expect(
      workflowEventEmitCommand(
        createTestWorkflowHost(),
        '0b1ee8da',
        'workflow_started',
        undefined,
        '/repo'
      )
    ).rejects.toThrow('matches more than one run');
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  });

  it('skips resolution when no cwd is provided (exact lookup only)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const code = await workflowGetCommand(createTestWorkflowHost(), 'deadbeef', true);

    expect(codebaseDb.findCodebaseByDefaultCwd).not.toHaveBeenCalled();
    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(code).toBe(1);
  });
});

describe('workflowRunCommand — continuation conversation lookup', () => {
  it('refuses before opening a new conversation when the lookup fails', async () => {
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'resume-thread' })],
      errors: [],
    });
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-prior',
      working_path: null,
      workflow_name: 'resume-thread',
      conversation_id: 'conv-prior',
    });
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      preCreatedRun: { id: 'run-prior', workflow_name: 'resume-thread' },
      priorCompletedNodes: new Map([['node-a', 'done']]),
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-resume',
      default_cwd: '/repo/root',
      default_branch: 'develop',
    });
    (conversationDb.getConversationById as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('database busy')
    );
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'resume-thread', 'go', {
        resume: true,
      })
    ).rejects.toThrow(
      "Failed to load conversation 'conv-prior' for workflow run 'run-prior': database busy"
    );
    expect(conversationDb.getOrCreateConversation).not.toHaveBeenCalled();
  });
});
