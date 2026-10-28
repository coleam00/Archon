import * as chatScope from '../workflow-scope';
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
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowEventEmitCommand } from './workflow';
import {
  workflowAbandonCommand,
  workflowCancelCommand,
  workflowRespondCommand,
  workflowAnswerCommand,
  workflowApproveCommand,
  workflowRejectCommand,
  workflowResumeCommand,
} from './workflow-control';
import { workflowGetCommand, workflowLogsCommand, workflowWaitCommand } from './workflow-query';
import { resolveRunIdArg } from './workflow-shared';
import { workflowArtifactsCommand } from './workflow-artifacts';
import { resolveAttentionRunId } from './workflow-attention';
import { resolveContinuationDeclaration } from './workflow-run-preflight';
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

  it('requires a project match for full and short IDs in scoped chat CLI commands', async () => {
    const scopeSpy = spyOn(chatScope, 'readChatProjectScope').mockReturnValue('cb-1');
    const host = createTestWorkflowHost();
    const find = spyOn(host.deps.store, 'findWorkflowRunsByIdPrefix');
    const run: WorkflowRun = {
      id: FULL_ID,
      origin: null,
      workflow_name: 'implement',
      conversation_id: null,
      parent_conversation_id: null,
      codebase_id: 'cb-1',
      status: 'completed',
      outcome: null,
      user_message: 'task',
      metadata: {},
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      working_path: '/repo',
      user_id: null,
      parent_run_id: null,
      adopted_from_run_id: null,
      output_root: null,
      checkout_baseline: null,
    };
    try {
      const undashedId = FULL_ID.replaceAll('-', '');
      for (const [id, storedId] of [
        [FULL_ID, FULL_ID],
        [FULL_ID.toUpperCase(), FULL_ID],
        [undashedId, undashedId],
        [undashedId.toUpperCase(), undashedId],
        [undashedId, FULL_ID],
        [undashedId.toUpperCase(), FULL_ID],
        ['0b1ee8da', FULL_ID],
      ]) {
        find.mockClear();
        find.mockImplementation(async (prefix, projectId) =>
          projectId === run.codebase_id && storedId.startsWith(prefix.toLowerCase())
            ? [{ ...run, id: storedId }]
            : []
        );
        expect(await resolveRunIdArg(host, id, '/repo')).toBe(storedId);
        expect(find).toHaveBeenNthCalledWith(1, id, 'cb-1');
        expect(find.mock.calls).toEqual(
          id.length === 32 && storedId === FULL_ID
            ? [
                [id, 'cb-1'],
                [FULL_ID, 'cb-1'],
              ]
            : [[id, 'cb-1']]
        );
      }
      for (const matches of [
        [],
        [{ ...run, id: FULL_ID + '-other' }],
        [run, { ...run, id: FULL_ID + '-other' }],
      ]) {
        find.mockClear();
        find.mockResolvedValueOnce([]).mockResolvedValueOnce(matches);
        await expect(resolveRunIdArg(host, undashedId, '/repo')).rejects.toThrow(
          'selected project'
        );
        expect(find.mock.calls).toEqual([
          [undashedId, 'cb-1'],
          [FULL_ID, 'cb-1'],
        ]);
      }
      find.mockResolvedValue([]);
      const refused = [
        ...[false, true].flatMap(json => [
          () => workflowGetCommand(host, FULL_ID, json, undefined, '/repo'),
          () => workflowWaitCommand(host, FULL_ID, json, '/repo'),
          () => workflowArtifactsCommand(host, [FULL_ID], { json, cwd: '/repo' }),
          () => workflowAnswerCommand(host, FULL_ID, 'occurrence', [], 'answer', json, '/repo'),
          () => workflowAbandonCommand(host, FULL_ID, json, '/repo'),
          () => workflowCancelCommand(host, FULL_ID, json, '/repo'),
          ...[false, true].flatMap(detach => [
            () => workflowResumeCommand(host, FULL_ID, json, '/repo', detach),
            () => workflowApproveCommand(host, FULL_ID, undefined, json, '/repo', detach),
            () => workflowRejectCommand(host, FULL_ID, undefined, json, '/repo', detach),
            () => workflowRespondCommand(host, FULL_ID, 'revise', undefined, json, '/repo', detach),
          ]),
        ]),
        ...[false, true].flatMap(follow => [
          () => workflowLogsCommand(host, FULL_ID, follow, '/repo', 'jsonl'),
          () => workflowLogsCommand(host, FULL_ID, follow, '/repo', 'text'),
        ]),
      ];
      for (const command of refused) {
        const before = find.mock.calls.length;
        const result = await command().catch((error: unknown) => {
          if (!(error instanceof Error)) throw error;
          expect(error.message).toContain('selected project');
          return 1;
        });
        expect(result).toBe(1);
        expect(find.mock.calls.length).toBe(before + 1);
        expect(find).toHaveBeenLastCalledWith(FULL_ID, 'cb-1');
      }
      await expect(
        workflowEventEmitCommand(host, FULL_ID, 'workflow_completed', {}, '/repo')
      ).rejects.toThrow('selected project');
      await expect(resolveAttentionRunId(host, FULL_ID, '/repo')).rejects.toThrow(
        'selected project'
      );
      for (const options of [{ adoptRunId: FULL_ID }, { supersedesRunId: FULL_ID }]) {
        await expect(
          resolveContinuationDeclaration(host, '/repo', options, {
            ...CODEBASE,
            kind: 'repo',
            repository_url: null,
            default_branch: null,
            commands: {},
            ai_assistant_type: 'claude',
            created_at: new Date(),
            updated_at: new Date(),
          })
        ).rejects.toThrow('selected project');
      }
      expect(host.deps.store.getWorkflowRun).not.toHaveBeenCalled();
      find.mockResolvedValueOnce([run, { ...run, id: FULL_ID + '-other' }]);
      await expect(resolveRunIdArg(host, '0b1ee8da', '/repo')).rejects.toThrow('selected project');
      scopeSpy.mockReturnValue('');
      await expect(resolveRunIdArg(host, FULL_ID, '/repo')).rejects.toThrow(
        'must name a registered project'
      );
      expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
      expect(mockPersistWorkflowEvent).not.toHaveBeenCalled();
    } finally {
      find.mockRestore();
      scopeSpy.mockRestore();
    }
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
